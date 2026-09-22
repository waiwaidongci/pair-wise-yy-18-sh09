const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { randomUUID } = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

let db;

function persist() {
  const bytes = Buffer.from(db.export());
  const tmp = DB_FILE + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, DB_FILE);
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

function run(sql, params) {
  if (params && params.length) db.run(sql, params);
  else db.run(sql);
}

function execute(sql, params) {
  run(sql, params);
  persist();
}

function transaction(work) {
  run('BEGIN');
  try {
    const result = work({ all, get, run });
    run('COMMIT');
    persist();
    return result;
  } catch (error) {
    run('ROLLBACK');
    throw error;
  }
}

async function initDatabase() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file)
  });
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
}

function now() {
  return new Date().toISOString();
}

function uuid() {
  return randomUUID();
}

module.exports = {
  initDatabase,
  all: (...args) => all(...args),
  get: (...args) => get(...args),
  run: (...args) => run(...args),
  execute: (...args) => execute(...args),
  transaction: (work) => transaction(work),
  now,
  uuid,
  DB_FILE
};
