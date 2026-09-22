// 借展放行入口层：HTTP 路由，只做参数搬运与状态码映射，规则在 business/loanRules，落库在 business/loanStore。

const express = require('express');
const store = require('../business/loanStore');
const { HttpError } = require('../business/loanRules');

const router = express.Router();

function wrap(handler) {
  return (req, res, next) => {
    try {
      handler(req, res);
    } catch (error) {
      next(error instanceof HttpError ? error : new HttpError(error.status || 500, error.message || 'server error'));
    }
  };
}

// 列表与履历、可借状态共用同一套占档期口径
router.get('/loans', wrap((req, res) => {
  res.json(store.listLoans(req.query));
}));

// 查询某只偶头在指定档期内是否可借：GET /api/loans/availability?puppetHeadId=..&startDate=..&endDate=..
router.get('/loans/availability', wrap((req, res) => {
  const { puppetHeadId, startDate, endDate } = req.query;
  if (!puppetHeadId || !startDate || !endDate) {
    throw new HttpError(400, '需要 puppetHeadId、startDate、endDate 查询参数');
  }
  res.json(store.getAvailability(puppetHeadId, startDate, endDate));
}));

router.post('/loans', wrap((req, res) => {
  // 冲突返回 409 且整单不写；环境不合格仅转待检
  const loan = store.createLoan(req.body || {}, req.body && req.body.actor);
  res.status(201).json(loan);
}));

router.get('/loans/:id', wrap((req, res) => {
  const loan = store.getLoan(req.params.id);
  if (!loan) throw new HttpError(404, '借展单不存在');
  res.json(loan);
}));

// 更正：档期、箱体或保险等放行要素变更会让放行失效重算，旧稿留档
router.patch('/loans/:id', wrap((req, res) => {
  const loan = store.correctLoan(req.params.id, req.body || {}, req.body && req.body.actor);
  res.json(loan);
}));

// 归还：另一人复核外观与机关，异常只进修复
router.post('/loans/:id/return', wrap((req, res) => {
  const loan = store.returnLoan(req.params.id, req.body || {}, req.body && req.body.actor);
  res.json(loan);
}));

router.get('/loans/:id/timeline', wrap((req, res) => {
  const timeline = store.getTimeline(req.params.id);
  if (!timeline) throw new HttpError(404, '借展单不存在');
  res.json(timeline);
}));

module.exports = router;
