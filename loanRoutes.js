// 借展放行入口层：HTTP 路由、参数装配与状态码映射。
// 规则在 loanRules，数据在 loanStore，本文件只负责接请求、调判定、存结果。

const express = require('express');
const R = require('./loanRules');

function createLoanRouter({ store, gateway, uuid, now }) {
  const router = express.Router();

  function buildContext(loanId) {
    return {
      now: new Date(now()).toISOString().slice(0, 10),
      getHead: (id) => gateway.getHead(id),
      listLoans: () => store.listLoans(),
      isSealUsed: (sealNo, excludeId) => store.isSealUsed(sealNo, excludeId || null)
    };
  }

  function headLoanSummary(headId) {
    return store.listLoans().filter((loan) => loan.headIds.includes(headId));
  }

  // 可借状态：列表、履历与这里始终使用同一份借展单推导
  router.get('/loans/availability', (req, res, next) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const start = req.query.start || today;
      const end = req.query.end || start;
      if (!R.isDateString(start) || !R.isDateString(end)) {
        return res.status(400).json({ error: 'start/end 必须是 YYYY-MM-DD 日期' });
      }
      if (start > end) {
        return res.status(400).json({ error: 'start 不能晚于 end' });
      }

      let headIds;
      if (req.query.headIds) {
        headIds = String(req.query.headIds)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        const missing = headIds.filter((id) => !gateway.getHead(id));
        if (missing.length) return res.status(404).json({ error: '偶头不存在', missing });
      } else {
        headIds = gateway.listHeadIds();
      }

      const loans = store.listLoans();
      const availability = R.summarizeHeadAvailability(loans, headIds, start, end);
      const heads = headIds.map((headId) => {
        const head = gateway.getHead(headId);
        const slot = availability[headId];
        const reasons = [];
        if (!head) reasons.push('偶头不存在');
        else if (!head.loanable) reasons.push('偶头当前状态不可借: ' + head.status);
        if (slot.occupyingLoans.length) reasons.push('档期被未归还借展单占用');
        return {
          headId,
          title: head ? head.title : headId,
          status: head ? head.status : null,
          loanable: head ? !!head.loanable : false,
          availability: {
            ...slot,
            available: reasons.length === 0,
            reasons
          }
        };
      });
      res.json({ start, end, heads });
    } catch (error) {
      next(error);
    }
  });

  // 借展登记：登记运输环境与交接信息，门禁不过只转待检，冲突 409 整单不写
  router.post('/loans', (req, res, next) => {
    try {
      const context = buildContext();
      const plan = R.planLoanCreation(req.body || {}, context);
      const at = now();
      const id = uuid();
      const loan = R.buildLoan(plan.fields, plan.status, plan.gateReasons, at);
      loan.id = id;
      const saved = store.createLoan(loan, {
        action: plan.status === R.STATUS.PENDING ? '登记转待检' : '登记放行',
        actor: req.body.actor || plan.fields.handler,
        note: plan.gateReasons.join('；') || req.body.note || '',
        data: { gateReasons: plan.gateReasons, conflicts: plan.conflicts }
      });
      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });

  router.get('/loans', (req, res, next) => {
    try {
      res.json(store.listLoans(req.query));
    } catch (error) {
      next(error);
    }
  });

  router.get('/loans/:id', (req, res, next) => {
    try {
      const loan = store.getLoan(req.params.id);
      if (!loan) return res.status(404).json({ error: '借展单不存在' });
      res.json(loan);
    } catch (error) {
      next(error);
    }
  });

  // 借展履历：事件流 + 更正旧稿
  router.get('/loans/:id/timeline', (req, res, next) => {
    try {
      const loan = store.getLoan(req.params.id);
      if (!loan) return res.status(404).json({ error: '借展单不存在' });
      res.json({
        loan,
        events: store.getEvents(loan.id),
        revisions: store.getRevisions(loan.id)
      });
    } catch (error) {
      next(error);
    }
  });

  // 出借交接：已放行才能出库
  router.post('/loans/:id/dispatch', (req, res, next) => {
    try {
      const loan = store.getLoan(req.params.id);
      if (!loan) return res.status(404).json({ error: '借展单不存在' });
      R.planDispatch(loan);
      const updated = {
        ...loan,
        status: R.STATUS.ON_LOAN,
        dispatchedAt: now(),
        updatedAt: now()
      };
      const saved = store.saveLoan(updated, {
        action: '出借交接',
        actor: req.body.actor || loan.handler,
        note: req.body.note || '',
        data: { handler: loan.handler }
      });
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  // 归还复核：另一人复核外观与机关，异常只进修复（不自动归还为可用）
  router.post('/loans/:id/return', (req, res, next) => {
    try {
      const loan = store.getLoan(req.params.id);
      if (!loan) return res.status(404).json({ error: '借展单不存在' });
      const decision = R.planReturn(loan, req.body || {});
      const repairs = decision.abnormal
        ? Object.entries(decision.perHead)
            .filter(([, item]) => !item.appearanceOk || !item.mechanismOk)
            .map(([headId]) => headId)
        : [];

      const updated = {
        ...loan,
        status: decision.status,
        returnReview: {
          reviewer: decision.reviewer,
          appearanceOk: decision.appearanceOk,
          mechanismOk: decision.mechanismOk,
          perHead: decision.perHead,
          note: decision.note
        },
        returnedAt: now(),
        updatedAt: now()
      };
      const saved = store.completeReturn(
        updated,
        {
          action: decision.abnormal ? '归还复核异常转修复' : '归还复核通过',
          actor: decision.reviewer,
          note: decision.note || (decision.abnormal ? '外观或机关复核异常：' + repairs.join(', ') : '外观与机关复核正常'),
          data: decision
        },
        repairs,
        gateway.writeRepairRecord,
        gateway.markHeadRepairing
      );
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  // 更正：档期/箱体/保险更正让放行失效重算；旧稿留档
  router.patch('/loans/:id', (req, res, next) => {
    try {
      const loan = store.getLoan(req.params.id);
      if (!loan) return res.status(404).json({ error: '借展单不存在' });

      const correction = R.planCorrection(loan, req.body || {});
      const context = buildContext(loan.id);
      const recheck = R.planRecheck(loan, correction.fields, context);
      // 走到这里说明没有 409：先留档旧稿，再写新结果（整单事务）
      const updated = {
        ...loan,
        ...correction.fields,
        status: recheck.status,
        gateReasons: recheck.gateReasons,
        updatedAt: now()
      };
      const saved = store.saveLoan(
        updated,
        {
          action: recheck.status === R.STATUS.PENDING ? '更正后放行失效转待检' : '更正后重新放行',
          actor: req.body.actor || '',
          note: (req.body.note || '') + (recheck.gateReasons.join('；') ? '｜' + recheck.gateReasons.join('；') : ''),
          data: { changedKeys: correction.changedKeys, gateReasons: recheck.gateReasons }
        },
        {
          snapshot: loan,
          reason: '更正字段: ' + correction.changedKeys.join(', '),
          actor: req.body.actor || ''
        }
      );
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createLoanRouter };
