const express = require('express');
const { randomUUID } = require('crypto');
const config = require('./project.config');
const { createDb } = require('./db');
const { createLoanStore } = require('./loanStore');
const { createLoanRouter } = require('./loanRoutes');

const app = express();
const PORT = process.env.PORT || config.port;

app.use(express.json({ limit: '2mb' }));

function now() {
  return new Date().toISOString();
}

function toRecord(row) {
  const data = JSON.parse(row.data || '{}');
  return {
    id: row.id,
    collection: row.collection,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...data
  };
}

function findCollection(name) {
  const collection = config.collections[name];
  if (!collection) {
    const error = new Error('unknown collection: ' + name);
    error.status = 404;
    throw error;
  }
  return collection;
}

function titleFor(collectionConfig, data) {
  return (collectionConfig.titleFields || [])
    .map((field) => data[field])
    .filter(Boolean)
    .join(' / ') || data.name || data.title || data.code || '';
}

function validate(collectionConfig, data) {
  const missing = (collectionConfig.required || []).filter((field) => data[field] === undefined || data[field] === '');
  if (missing.length) {
    const error = new Error('missing required fields: ' + missing.join(', '));
    error.status = 400;
    throw error;
  }
}

async function main() {
  const db = await createDb();

  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT,
  actor TEXT,
  note TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id);
`);

  function insertEvent({ recordId, collection, action, status, actor, note, data }) {
    db.run(
      `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomUUID(),
        recordId,
        collection,
        action || '记录',
        status || '',
        actor || '',
        note || '',
        JSON.stringify(data || {}),
        now()
      ]
    );
  }

  function loadRecord(collection, id) {
    const row = db.get('SELECT * FROM records WHERE collection = ? AND id = ? LIMIT 1;', [collection, id]);
    return row ? toRecord(row) : null;
  }

  function saveRecord(collection, id, data, status) {
    const collectionConfig = findCollection(collection);
    db.run(
      `UPDATE records SET status = ?, title = ?, data = ?, updated_at = ?
       WHERE collection = ? AND id = ?;`,
      [status, titleFor(collectionConfig, data), JSON.stringify(data), now(), collection, id]
    );
  }

  function seedRecords() {
    const count = db.get('SELECT COUNT(*) AS count FROM records;').count;
    if (count > 0) return;
    for (const seed of config.seed || []) {
      const collectionConfig = findCollection(seed.collection);
      const id = seed.id || randomUUID();
      const createdAt = seed.createdAt || now();
      const status = seed.status || collectionConfig.defaultStatus || '';
      const data = { ...seed.data, status };
      db.run(
        `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          seed.collection,
          status,
          titleFor(collectionConfig, data),
          JSON.stringify(data),
          createdAt,
          seed.updatedAt || createdAt
        ]
      );
      insertEvent({
        recordId: id,
        collection: seed.collection,
        action: seed.eventAction || '创建',
        status,
        actor: seed.actor || 'system',
        note: seed.note || '',
        data
      });
    }
  }

  seedRecords();

  // ---- 借展放行台组装：存储 / 判定 / 入口 ----
  const loanStore = createLoanStore({ db, uuid: randomUUID, now });

  // 偶头档案网关：借展域通过它读偶头、写修复单与修复状态
  const headGateway = {
    getHead(id) {
      const row = db.get("SELECT * FROM records WHERE collection = 'puppetHeads' AND id = ?;", [id]);
      if (!row) return null;
      const record = toRecord(row);
      return {
        id: record.id,
        title: row.title,
        status: record.status,
        loanable: record.status === '可演出' && record.currentUsable !== false
      };
    },
    listHeadIds() {
      return db
        .all("SELECT id FROM records WHERE collection = 'puppetHeads' ORDER BY updated_at DESC;", [])
        .map((row) => row.id);
    },
    writeRepairRecord(tx, headId, loan) {
      const id = randomUUID();
      const at = now();
      const data = {
        puppetHeadId: headId,
        repairType: '归还异常检修',
        handler: loan.returnReview ? loan.returnReview.reviewer : '',
        source: 'loanReturn',
        loanId: loan.id,
        note: '借展 ' + loan.venue + ' 归还复核发现外观或机关异常',
        status: '待处理'
      };
      tx.run(
        `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
         VALUES (?, 'repairRecords', '待处理', ?, ?, ?, ?)`,
        [id, '归还异常检修 / ' + headId, JSON.stringify(data), at, at]
      );
      tx.run(
        `INSERT INTO events (id, record_id, collection, action, status, actor, note, data, created_at)
         VALUES (?, ?, 'repairRecords', '借展归还异常', '待处理', ?, ?, ?, ?)`,
        [randomUUID(), id, data.handler, data.note, JSON.stringify(data), at]
      );
    },
    markHeadRepairing(tx, headId, loan) {
      const row = tx.get("SELECT * FROM records WHERE collection = 'puppetHeads' AND id = ?;", [headId]);
      if (!row) return;
      const record = toRecord(row);
      const nextData = {
        ...record,
        status: '待修补',
        currentUsable: false,
        lastLoanId: loan.id
      };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      tx.run(
        "UPDATE records SET status = '待修补', title = ?, data = ?, updated_at = ? WHERE id = ?;",
        [row.title, JSON.stringify(nextData), now(), headId]
      );
    }
  };

  const loanRouter = createLoanRouter({
    store: loanStore,
    gateway: headGateway,
    uuid: randomUUID,
    now
  });

  function seedLoans() {
    if (loanStore.countLoans() > 0) return;
    for (const seed of config.loanSeed || []) {
      const at = now();
      const loan = {
        ...seed,
        status: '已放行',
        note: seed.note || '初始示范借展单',
        gateReasons: [],
        returnReview: null,
        dispatchedAt: null,
        returnedAt: null,
        createdAt: at,
        updatedAt: at
      };
      loanStore.seedLoan(loan, {
        action: '登记放行',
        actor: seed.handler || 'system',
        note: seed.note || '初始示范借展单',
        data: { seed: true }
      });
    }
  }

  seedLoans();

  app.get('/health', (req, res) => {
    res.json({ ok: true, service: config.title, port: PORT });
  });

  app.get('/api/meta', (req, res) => {
    res.json({
      title: config.title,
      description: config.description,
      collections: config.collections,
      examples: config.examples || []
    });
  });

  // 借展放行台路由（须挂在通用 /api/:collection 之前）
  app.use('/api', loanRouter);

  function applyQuery(records, query) {
    return records.filter((record) => {
      if (query.status && record.status !== query.status) return false;
      if (query.search) {
        const haystack = JSON.stringify(record).toLowerCase();
        if (!haystack.includes(String(query.search).toLowerCase())) return false;
      }
      for (const [key, value] of Object.entries(query)) {
        if (['status', 'search', 'limit'].includes(key)) continue;
        if (record[key] === undefined) return false;
        if (!String(record[key]).toLowerCase().includes(String(value).toLowerCase())) return false;
      }
      return true;
    });
  }

  // 偶头列表附带与放行台一致的在借/可借状态
  function withLoanState(records) {
    return records.map((record) => {
      const loans = loanStore
        .listLoans()
        .filter((loan) => loan.headIds.includes(record.id));
      const occupying = loans.filter((loan) => ['已放行', '出借中'].includes(loan.status));
      const headLoanable = record.status === '可演出' && record.currentUsable !== false;
      return {
        ...record,
        loanState: {
          activeLoans: occupying.map((loan) => ({
            loanId: loan.id,
            venue: loan.venue,
            status: loan.status,
            loanStart: loan.loanStart,
            loanEnd: loan.loanEnd
          })),
          pendingLoans: loans
            .filter((loan) => loan.status === '待检')
            .map((loan) => ({
              loanId: loan.id,
              venue: loan.venue,
              loanStart: loan.loanStart,
              loanEnd: loan.loanEnd,
              gateReasons: loan.gateReasons
            })),
          headLoanable,
          availableForLoan: headLoanable && occupying.length === 0
        }
      };
    });
  }

  app.get('/api/:collection', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const rows = db
        .all('SELECT * FROM records WHERE collection = ? ORDER BY updated_at DESC;', [req.params.collection])
        .map(toRecord);
      let filtered = applyQuery(rows, req.query);
      if (req.params.collection === 'puppetHeads') filtered = withLoanState(filtered);
      const limit = Number(req.query.limit || 0);
      res.json(limit > 0 ? filtered.slice(0, limit) : filtered);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection', (req, res, next) => {
    try {
      const collectionConfig = findCollection(req.params.collection);
      const data = { ...collectionConfig.defaults, ...req.body };
      const status = data.status || collectionConfig.defaultStatus || '';
      data.status = status;
      validate(collectionConfig, data);
      const id = randomUUID();
      const createdAt = now();
      db.run(
        `INSERT INTO records (id, collection, status, title, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.params.collection, status, titleFor(collectionConfig, data), JSON.stringify(data), createdAt, createdAt]
      );
      insertEvent({
        recordId: id,
        collection: req.params.collection,
        action: req.body.action || '创建',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data
      });
      res.status(201).json(loadRecord(req.params.collection, id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const nextData = { ...record, ...req.body };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      const status = nextData.status || record.status;
      nextData.status = status;
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || '更新',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      res.json(loadRecord(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/:collection/:id/events', (req, res, next) => {
    try {
      const collectionConfig = findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const status = req.body.status || record.status;
      if (collectionConfig.statuses && !collectionConfig.statuses.includes(status)) {
        return res.status(400).json({ error: 'invalid status: ' + status });
      }
      const nextData = { ...record, ...(req.body.fields || {}), status };
      delete nextData.id;
      delete nextData.collection;
      delete nextData.createdAt;
      delete nextData.updatedAt;
      saveRecord(req.params.collection, req.params.id, nextData, status);
      insertEvent({
        recordId: req.params.id,
        collection: req.params.collection,
        action: req.body.action || status || '记录',
        status,
        actor: req.body.actor || '',
        note: req.body.note || '',
        data: req.body
      });
      res.json(loadRecord(req.params.collection, req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/:collection/:id/timeline', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      const record = loadRecord(req.params.collection, req.params.id);
      if (!record) return res.status(404).json({ error: 'not found' });
      const events = db
        .all('SELECT * FROM events WHERE record_id = ? ORDER BY created_at ASC;', [req.params.id])
        .map((event) => ({
          id: event.id,
          action: event.action,
          status: event.status,
          actor: event.actor,
          note: event.note,
          data: JSON.parse(event.data || '{}'),
          createdAt: event.created_at
        }));
      res.json({ record, events });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/:collection/:id', (req, res, next) => {
    try {
      findCollection(req.params.collection);
      db.transaction(() => {
        db.run('DELETE FROM records WHERE collection = ? AND id = ?;', [req.params.collection, req.params.id]);
        db.run('DELETE FROM events WHERE record_id = ?;', [req.params.id]);
      });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.use((error, req, res, next) => {
    const body = { error: error.message || 'server error' };
    for (const key of ['conflicts', 'blockedHeads', 'missing']) {
      if (error[key] !== undefined) body[key] = error[key];
    }
    res.status(error.status || 500).json(body);
  });

  app.listen(PORT, () => {
    console.log(config.title + ' API running at http://localhost:' + PORT);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
