// 借展存储层：借展单、档期锁定、旧稿留档、事件履历与修复联动。

const db = require('../lib/db');
const rules = require('./loanRules');
const { STATUS, HttpError } = rules;

function insertEvent(tx, { recordId, collection, action, status, actor, note, data }) {
  tx.run(
    'INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      db.uuid(),
      recordId,
      collection,
      action || '记录',
      status || '',
      actor || '',
      note || '',
      JSON.stringify(data || {}),
      db.now()
    ]
  );
}

function initStore() {
  db.execute(`
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  puppet_head_id TEXT NOT NULL,
  venue TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL,
  seal_no TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  snapshot TEXT NOT NULL,
  clearance_reasons TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_head ON loans(puppet_head_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE TABLE IF NOT EXISTS loan_revisions (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  clearance_reasons TEXT NOT NULL,
  reason TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loan_revisions_loan ON loan_revisions(loan_id);
`);
}

function rowToLoan(row) {
  const snapshot = JSON.parse(row.snapshot || '{}');
  return {
    id: row.id,
    puppetHeadId: row.puppet_head_id,
    venue: row.venue,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    sealNo: row.seal_no,
    version: row.version,
    clearanceReasons: JSON.parse(row.clearance_reasons || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...snapshot
  };
}

function getLoanRow(tx, id) {
  return tx.get('SELECT * FROM loans WHERE id = ?', [id]);
}

function getHeadRecord(tx, headId) {
  return tx.get("SELECT * FROM records WHERE collection = 'puppetHeads' AND id = ?", [headId]);
}

// 同一偶头、重叠档期的未归还（占档期）单
function findConflicts(tx, puppetHeadId, startDate, endDate, excludeLoanId) {
  const rows = tx.all(
    "SELECT * FROM loans WHERE puppet_head_id = ? AND status = ? AND id != ?",
    [puppetHeadId, STATUS.RELEASED, excludeLoanId || '']
  );
  return rows.filter((row) =>
    rules.rangesOverlap(
      rules.parseDate(row.start_date, 'startDate'),
      rules.parseDate(row.end_date, 'endDate'),
      rules.parseDate(startDate, 'startDate'),
      rules.parseDate(endDate, 'endDate')
    )
  );
}

function sealUsedByOther(tx, sealNo, excludeLoanId) {
  return !!tx.get(
    'SELECT id FROM loans WHERE seal_no = ? AND id != ? LIMIT 1',
    [sealNo, excludeLoanId || '']
  );
}

// 登记借展单：冲突 409 整单不写；环境不合格只转待检，不占档期。
function createLoan(body, actor) {
  const { temperature, humidity } = rules.validateBase(body);

  const snapshot = {
    puppetHeadId: body.puppetHeadId,
    venue: body.venue,
    startDate: body.startDate,
    endDate: body.endDate,
    temperature,
    humidity,
    cushionBatch: body.cushionBatch,
    insurancePolicyNo: body.insurancePolicyNo,
    insuranceExpireAt: body.insuranceExpireAt,
    sealNo: body.sealNo,
    handler: body.handler,
    boxNo: body.boxNo || '',
    note: body.note || ''
  };

  return db.transaction((tx) => {
    const headRow = getHeadRecord(tx, snapshot.puppetHeadId);
    if (!headRow) throw new HttpError(404, '偶头档案不存在: ' + snapshot.puppetHeadId);
    const head = JSON.parse(headRow.data || '{}');
    head.id = headRow.id;

    // 档期冲突优先判定：有冲突时整单不写
    const conflicts = findConflicts(tx, snapshot.puppetHeadId, snapshot.startDate, snapshot.endDate);
    if (conflicts.length) {
      throw new HttpError(409, '同一偶头重叠档期已有未归还借展单', {
        conflicts: conflicts.map((row) => ({
          id: row.id,
          venue: row.venue,
          startDate: row.start_date,
          endDate: row.end_date,
          status: row.status
        }))
      });
    }

    const sealDuplicated = sealUsedByOther(tx, snapshot.sealNo);
    const evaluation = rules.evaluateClearance(snapshot, { head, sealDuplicated });
    const status = evaluation.passed ? STATUS.RELEASED : STATUS.PENDING;

    const id = db.uuid();
    const timestamp = db.now();
    tx.run(
      `INSERT INTO loans
        (id, puppet_head_id, venue, start_date, end_date, status, seal_no, version, snapshot, clearance_reasons, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        snapshot.puppetHeadId,
        snapshot.venue,
        snapshot.startDate,
        snapshot.endDate,
        status,
        snapshot.sealNo,
        JSON.stringify(snapshot),
        JSON.stringify(evaluation.reasons),
        timestamp,
        timestamp
      ]
    );

    insertEvent(tx, {
      recordId: id,
      collection: 'loans',
      action: evaluation.passed ? '借展登记·放行' : '借展登记·待检',
      status,
      actor: actor || snapshot.handler,
      note: evaluation.passed ? '运输环境与保险核验通过，档期锁定' : evaluation.reasons.join('；'),
      data: { ...snapshot, clearanceReasons: evaluation.reasons }
    });

    return rowToLoan(getLoanRow(tx, id));
  });
}

function listLoans(query) {
  const conditions = [];
  const params = [];
  if (query.status) {
    conditions.push('status = ?');
    params.push(query.status);
  }
  if (query.puppetHeadId) {
    conditions.push('puppet_head_id = ?');
    params.push(query.puppetHeadId);
  }
  if (query.venue) {
    conditions.push('venue LIKE ?');
    params.push('%' + query.venue + '%');
  }
  const sql = 'SELECT * FROM loans' +
    (conditions.length ? ' WHERE ' + conditions.join(' AND ') : '') +
    ' ORDER BY updated_at DESC';
  let rows = db.all(sql, params).map(rowToLoan);
  if (query.search) {
    const keyword = String(query.search).toLowerCase();
    rows = rows.filter((loan) => JSON.stringify(loan).toLowerCase().includes(keyword));
  }
  const limit = Number(query.limit || 0);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function getLoan(id) {
  const row = db.get('SELECT * FROM loans WHERE id = ?', [id]);
  return row ? rowToLoan(row) : null;
}

function archiveRevision(tx, row, reason, actor) {
  tx.run(
    `INSERT INTO loan_revisions (id, loan_id, version, status, snapshot, clearance_reasons, reason, actor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      db.uuid(),
      row.id,
      row.version,
      row.status,
      row.snapshot,
      row.clearance_reasons,
      reason || '',
      actor || '',
      db.now()
    ]
  );
}

// 更正：档期、箱体或保险等放行要素变更会让放行失效并整单重算；旧稿留档。
function correctLoan(id, body, actor) {
  const keys = Object.keys(body).filter((key) => key !== 'actor' && key !== 'note');
  const unknown = keys.filter((key) => !rules.CORRECTABLE_FIELDS.includes(key));
  if (unknown.length) {
    throw new HttpError(400, '不可更正的字段: ' + unknown.join(', '));
  }

  const patch = {};
  for (const key of rules.CORRECTABLE_FIELDS) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (!Object.keys(patch).length) {
    throw new HttpError(400, '没有可更正的内容');
  }

  const invalidating = rules.INVALIDATING_FIELDS.filter((key) => patch[key] !== undefined);

  return db.transaction((tx) => {
    const row = getLoanRow(tx, id);
    if (!row) throw new HttpError(404, '借展单不存在');
    if (rules.isClosed(row.status)) {
      throw new HttpError(400, '已闭环借展单（' + row.status + '）不可更正');
    }

    const oldSnapshot = JSON.parse(row.snapshot);
    const merged = { ...oldSnapshot, ...patch };

    let status = row.status;
    let reasons = JSON.parse(row.clearance_reasons || '[]');

    if (invalidating.length) {
      // 放行失效：按新稿重算运输环境与档期
      const { temperature, humidity } = rules.validateBase(merged);
      merged.temperature = temperature;
      merged.humidity = humidity;

      const conflicts = findConflicts(tx, merged.puppetHeadId, merged.startDate, merged.endDate, id);
      if (conflicts.length) {
        // 整单不写，旧稿保留
        throw new HttpError(409, '更正后档期与未归还借展单冲突，更正被驳回', {
          conflicts: conflicts.map((candidate) => ({
            id: candidate.id,
            venue: candidate.venue,
            startDate: candidate.start_date,
            endDate: candidate.end_date
          }))
        });
      }

      const headRow = getHeadRecord(tx, merged.puppetHeadId);
      const head = headRow ? { ...JSON.parse(headRow.data || '{}'), id: headRow.id } : null;
      const sealDuplicated = sealUsedByOther(tx, merged.sealNo, id);
      const evaluation = rules.evaluateClearance(merged, { head, sealDuplicated });
      status = evaluation.passed ? STATUS.RELEASED : STATUS.PENDING;
      reasons = evaluation.reasons;
    }

    archiveRevision(tx, row, '更正字段: ' + Object.keys(patch).join(', '), actor);

    const nextVersion = row.version + 1;
    tx.run(
      `UPDATE loans SET
         venue = ?, start_date = ?, end_date = ?, status = ?, seal_no = ?,
         version = ?, snapshot = ?, clearance_reasons = ?, updated_at = ?
       WHERE id = ?`,
      [
        merged.venue,
        merged.startDate,
        merged.endDate,
        status,
        merged.sealNo,
        nextVersion,
        JSON.stringify(merged),
        JSON.stringify(reasons),
        db.now(),
        id
      ]
    );

    insertEvent(tx, {
      recordId: id,
      collection: 'loans',
      action: invalidating.length ? '更正重算·放行失效' : '更正登记',
      status,
      actor: actor || '',
      note: invalidating.length
        ? '放行要素变更（' + invalidating.join(', ') + '），重新判定：' +
          (reasons.length ? reasons.join('；') : '通过')
        : '更正字段: ' + Object.keys(patch).join(', '),
      data: { changedFields: Object.keys(patch), patch, clearanceReasons: reasons }
    });

    return rowToLoan(getLoanRow(tx, id));
  });
}

function createRepairRecord(tx, loan, appearanceOk, mechanismOk, reviewer, note) {
  const repairId = db.uuid();
  const timestamp = db.now();
  const problemParts = [];
  if (!appearanceOk) problemParts.push('外观异常');
  if (!mechanismOk) problemParts.push('机关异常');
  const repairData = {
    puppetHeadId: loan.puppetHeadId,
    repairType: '借展归还异常',
    handler: loan.handler,
    reviewer,
    sourceLoanId: loan.id,
    venue: loan.venue,
    appearanceOk,
    mechanismOk,
    problem: problemParts.join('、'),
    note: note || '',
    status: '待处理'
  };
  const title = [repairData.repairType, repairData.handler].filter(Boolean).join(' / ');
  tx.run(
    `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
     VALUES (?, 'repairRecords', '待处理', ?, ?, ?, ?)`,
    [repairId, title, JSON.stringify(repairData), timestamp, timestamp]
  );
  insertEvent(tx, {
    recordId: repairId,
    collection: 'repairRecords',
    action: '借展归还异常转修',
    status: '待处理',
    actor: reviewer,
    note: problemParts.join('、') + '；来源借展单 ' + loan.id,
    data: repairData
  });
  return repairId;
}

function markHeadForRepair(tx, headId, problem, actor) {
  const headRow = getHeadRecord(tx, headId);
  if (!headRow) return;
  const data = JSON.parse(headRow.data || '{}');
  data.currentUsable = false;
  data.status = '修补中';
  const title = [data.role, data.play].filter(Boolean).join(' / ');
  tx.run(
    "UPDATE records SET status = '修补中', title = ?, data = ?, updated_at = ? WHERE id = ?",
    [title, JSON.stringify(data), db.now(), headId]
  );
  insertEvent(tx, {
    recordId: headId,
    collection: 'puppetHeads',
    action: '借展归还异常·转修补中',
    status: '修补中',
    actor: actor || '',
    note: problem,
    data: { currentUsable: false }
  });
}

// 归还：另一人复核外观与机关；异常只进修复，不回可借。
function returnLoan(id, body, actor) {
  rules.validateReturnBody(body);
  const { reviewer, appearanceOk, mechanismOk } = body;

  return db.transaction((tx) => {
    const row = getLoanRow(tx, id);
    if (!row) throw new HttpError(404, '借展单不存在');
    if (row.status !== STATUS.RELEASED) {
      throw new HttpError(400, '只有已放行（占档期）的借展单可办理归还，当前状态: ' + row.status);
    }

    const loan = rowToLoan(row);
    if (String(reviewer).trim() === String(loan.handler).trim()) {
      throw new HttpError(400, '归还复核必须由交接人之外的另一人执行');
    }

    const normal = appearanceOk === true && mechanismOk === true;
    const status = normal ? STATUS.RETURNED : STATUS.REPAIR;
    let repairId = null;

    if (!normal) {
      repairId = createRepairRecord(tx, loan, appearanceOk, mechanismOk, reviewer, body.note);
      const problems = [];
      if (!appearanceOk) problems.push('外观异常');
      if (!mechanismOk) problems.push('机关异常');
      markHeadForRepair(tx, loan.puppetHeadId, problems.join('、'), reviewer);
    }

    tx.run('UPDATE loans SET status = ?, version = version + 1, updated_at = ? WHERE id = ?', [
      status,
      db.now(),
      id
    ]);

    insertEvent(tx, {
      recordId: id,
      collection: 'loans',
      action: normal ? '归还复核通过' : '归还复核异常·转修复',
      status,
      actor: actor || reviewer,
      note: normal
        ? '复核人 ' + reviewer + ' 确认外观与机关正常，档期释放'
        : '复核人 ' + reviewer + ' 发现异常，转修复单 ' + repairId,
      data: { reviewer, appearanceOk, mechanismOk, repairId, note: body.note || '' }
    });

    return rowToLoan(getLoanRow(tx, id));
  });
}

// 可借状态：与判定层同一口径，列表/履历看到的占档期单即这里的阻挡单
function getAvailability(headId, startDate, endDate) {
  const start = rules.parseDate(startDate, 'startDate');
  const end = rules.parseDate(endDate, 'endDate');
  if (end.getTime() <= start.getTime()) {
    throw new HttpError(400, '结束日期必须晚于开始日期');
  }

  return db.transaction((tx) => {
    const headRow = getHeadRecord(tx, headId);
    if (!headRow) throw new HttpError(404, '偶头档案不存在: ' + headId);
    const head = { ...JSON.parse(headRow.data || '{}'), id: headRow.id, status: headRow.status };

    const blocking = tx
      .all("SELECT * FROM loans WHERE puppet_head_id = ? AND status = ?", [headId, STATUS.RELEASED])
      .map(rowToLoan);

    const availability = rules.headAvailability(head, blocking, { start, end });
    availability.range = { startDate, endDate };
    return availability;
  });
}

function getTimeline(id) {
  const loan = getLoan(id);
  if (!loan) return null;
  const events = db
    .all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC', [id])
    .map((event) => ({
      id: event.id,
      action: event.action,
      status: event.status,
      actor: event.actor,
      note: event.note,
      data: JSON.parse(event.data || '{}'),
      createdAt: event.created_at
    }));
  const revisions = db
    .all('SELECT * FROM loan_revisions WHERE loan_id = ? ORDER BY version ASC', [id])
    .map((revision) => ({
      id: revision.id,
      version: revision.version,
      status: revision.status,
      reason: revision.reason,
      actor: revision.actor,
      snapshot: JSON.parse(revision.snapshot || '{}'),
      clearanceReasons: JSON.parse(revision.clearance_reasons || '[]'),
      createdAt: revision.created_at
    }));
  return { loan, events, revisions };
}

module.exports = {
  initStore,
  createLoan,
  listLoans,
  getLoan,
  correctLoan,
  returnLoan,
  getAvailability,
  getTimeline
};
