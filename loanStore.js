// 借展放行存储层：拥有借展单、履历事件、旧稿归档三张表与全部读写 SQL。
// 判定规则不在这里，HTTP 也不在这里。

const { STATUS } = require('./loanRules');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  venue TEXT NOT NULL,
  loan_start TEXT NOT NULL,
  loan_end TEXT NOT NULL,
  box_no TEXT NOT NULL,
  temperature REAL NOT NULL,
  humidity REAL NOT NULL,
  buffer_batch TEXT NOT NULL,
  insurance_no TEXT NOT NULL,
  insurance_expiry TEXT NOT NULL,
  seal_no TEXT NOT NULL,
  handler TEXT NOT NULL,
  status TEXT NOT NULL,
  head_ids TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  gate_reasons TEXT NOT NULL DEFAULT '[]',
  return_review TEXT,
  dispatched_at TEXT,
  returned_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
CREATE INDEX IF NOT EXISTS idx_loans_seal ON loans(seal_no);
CREATE TABLE IF NOT EXISTS loan_events (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loan_events_loan ON loan_events(loan_id);
CREATE TABLE IF NOT EXISTS loan_revisions (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  reason TEXT,
  actor TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loan_revisions_loan ON loan_revisions(loan_id);
`;

function createLoanStore({ db, uuid, now }) {
  db.exec(SCHEMA);

  function rowToLoan(row) {
    if (!row) return null;
    const extra = JSON.parse(row.data || '{}');
    return {
      id: row.id,
      venue: row.venue,
      loanStart: row.loan_start,
      loanEnd: row.loan_end,
      boxNo: row.box_no,
      temperature: row.temperature,
      humidity: row.humidity,
      bufferBatch: row.buffer_batch,
      insuranceNo: row.insurance_no,
      insuranceExpiry: row.insurance_expiry,
      sealNo: row.seal_no,
      handler: row.handler,
      status: row.status,
      headIds: JSON.parse(row.head_ids || '[]'),
      note: row.note,
      gateReasons: JSON.parse(row.gate_reasons || '[]'),
      returnReview: row.return_review ? JSON.parse(row.return_review) : null,
      dispatchedAt: row.dispatched_at,
      returnedAt: row.returned_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...extra
    };
  }

  function insertEvent(tx, { loanId, action, status, actor, note, data, at }) {
    tx.run(
      `INSERT INTO loan_events (id, loan_id, action, status, actor, note, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), loanId, action, status || '', actor || '', note || '', JSON.stringify(data || {}), at || now()]
    );
  }

  function archiveRevision(tx, loanId, snapshot, reason, actor) {
    const row = tx.get('SELECT COUNT(*) AS c FROM loan_revisions WHERE loan_id = ?;', [loanId]);
    const version = (row.c || 0) + 1;
    tx.run(
      `INSERT INTO loan_revisions (id, loan_id, version, snapshot, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuid(), loanId, version, JSON.stringify(snapshot), reason || '', actor || '', now()]
    );
  }

  const INSERT_COLUMNS = `(id, venue, loan_start, loan_end, box_no, temperature, humidity, buffer_batch,
    insurance_no, insurance_expiry, seal_no, handler, status, head_ids, note, gate_reasons,
    return_review, dispatched_at, returned_at, data, created_at, updated_at)`;

  const INSERT_PLACEHOLDERS = `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  function persistLoanParams(loan) {
    return [
      loan.id,
      loan.venue,
      loan.loanStart,
      loan.loanEnd,
      loan.boxNo,
      loan.temperature,
      loan.humidity,
      loan.bufferBatch,
      loan.insuranceNo,
      loan.insuranceExpiry,
      loan.sealNo,
      loan.handler,
      loan.status,
      JSON.stringify(loan.headIds),
      loan.note || '',
      JSON.stringify(loan.gateReasons || []),
      loan.returnReview ? JSON.stringify(loan.returnReview) : null,
      loan.dispatchedAt || null,
      loan.returnedAt || null,
      JSON.stringify(loan._extra || {}),
      loan.createdAt,
      loan.updatedAt
    ];
  }

  function createLoan(loan, event) {
    return db.transaction((tx) => {
      tx.run(
        `INSERT INTO loans ${INSERT_COLUMNS} VALUES ${INSERT_PLACEHOLDERS};`,
        persistLoanParams(loan)
      );
      if (event) insertEvent(tx, { ...event, loanId: loan.id, status: loan.status });
      return getLoan(loan.id);
    });
  }

  function saveLoan(loan, event, revision) {
    return db.transaction((tx) => {
      if (revision) archiveRevision(tx, loan.id, revision.snapshot, revision.reason, revision.actor);
      tx.run(
        `UPDATE loans SET venue = ?, loan_start = ?, loan_end = ?, box_no = ?, temperature = ?,
          humidity = ?, buffer_batch = ?, insurance_no = ?, insurance_expiry = ?, seal_no = ?,
          handler = ?, status = ?, head_ids = ?, note = ?, gate_reasons = ?, return_review = ?,
          dispatched_at = ?, returned_at = ?, data = ?, updated_at = ? WHERE id = ?;`,
        [
          loan.venue,
          loan.loanStart,
          loan.loanEnd,
          loan.boxNo,
          loan.temperature,
          loan.humidity,
          loan.bufferBatch,
          loan.insuranceNo,
          loan.insuranceExpiry,
          loan.sealNo,
          loan.handler,
          loan.status,
          JSON.stringify(loan.headIds),
          loan.note || '',
          JSON.stringify(loan.gateReasons || []),
          loan.returnReview ? JSON.stringify(loan.returnReview) : null,
          loan.dispatchedAt || null,
          loan.returnedAt || null,
          JSON.stringify(loan._extra || {}),
          loan.updatedAt,
          loan.id
        ]
      );
      if (event) insertEvent(tx, { ...event, loanId: loan.id, status: loan.status });
      return getLoan(loan.id);
    });
  }

  function completeReturn(loan, event, repairs, writeRepairRecord, markHeadRepairing) {
    return db.transaction((tx) => {
      if (loan.status === STATUS.RETURNED_ABNORMAL) {
        for (const headId of repairs) {
          if (markHeadRepairing) markHeadRepairing(tx, headId, loan);
          if (writeRepairRecord) writeRepairRecord(tx, headId, loan);
        }
      }
      tx.run(
        `UPDATE loans SET status = ?, return_review = ?, returned_at = ?, updated_at = ? WHERE id = ?;`,
        [
          loan.status,
          JSON.stringify(loan.returnReview),
          loan.returnedAt,
          loan.updatedAt,
          loan.id
        ]
      );
      insertEvent(tx, { ...event, loanId: loan.id, status: loan.status });
      return getLoan(loan.id);
    });
  }

  function getLoan(id) {
    return rowToLoan(db.get('SELECT * FROM loans WHERE id = ?;', [id]));
  }

  function listLoans(filters = {}) {
    const where = [];
    const params = [];
    if (filters.status) {
      where.push('status = ?');
      params.push(filters.status);
    }
    if (filters.venue) {
      where.push('venue LIKE ?');
      params.push('%' + filters.venue + '%');
    }
    if (filters.headId) {
      where.push('head_ids LIKE ?');
      params.push('%"' + filters.headId + '"%');
    }
    const sql = 'SELECT * FROM loans' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY updated_at DESC;';
    return db.all(sql, params).map(rowToLoan);
  }

  function isSealUsed(sealNo, excludeId) {
    const row = db.get(
      'SELECT COUNT(*) AS c FROM loans WHERE seal_no = ? AND id IS NOT ?;',
      [sealNo, excludeId || '__none__']
    );
    return row.c > 0;
  }

  function getEvents(loanId) {
    return db
      .all('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at ASC, rowid ASC;', [loanId])
      .map((event) => ({
        id: event.id,
        action: event.action,
        status: event.status,
        actor: event.actor,
        note: event.note,
        data: JSON.parse(event.data || '{}'),
        createdAt: event.created_at
      }));
  }

  function getRevisions(loanId) {
    return db
      .all('SELECT * FROM loan_revisions WHERE loan_id = ? ORDER BY version ASC;', [loanId])
      .map((revision) => ({
        id: revision.id,
        version: revision.version,
        snapshot: JSON.parse(revision.snapshot),
        reason: revision.reason,
        actor: revision.actor,
        createdAt: revision.created_at
      }));
  }

  function countLoans() {
    return db.get('SELECT COUNT(*) AS c FROM loans;').c;
  }

  function seedLoan(loan, event) {
    db.run(
      `INSERT INTO loans ${INSERT_COLUMNS} VALUES ${INSERT_PLACEHOLDERS};`,
      persistLoanParams(loan)
    );
    insertEvent(db, { ...event, loanId: loan.id, status: loan.status });
  }

  return {
    createLoan,
    saveLoan,
    completeReturn,
    getLoan,
    listLoans,
    isSealUsed,
    getEvents,
    getRevisions,
    countLoans,
    seedLoan,
    insertEvent
  };
}

module.exports = { createLoanStore };
