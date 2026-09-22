const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'app.db');

async function createDb() {
  const SQL = await initSqlJs();
  let db;
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new SQL.Database();
  }

  function persist() {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
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

  // 事务对象：写操作只执行不落盘，由 transaction() 在 COMMIT 后统一持久化
  function txHandle() {
    return {
      all,
      get,
      run: (sql, params = []) => db.run(sql, params),
      exec: (sql) => db.exec(sql),
      raw: db
    };
  }

  function run(sql, params = []) {
    db.run(sql, params);
    persist();
  }

  function exec(sql) {
    db.exec(sql);
    persist();
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn(txHandle());
      db.exec('COMMIT');
      persist();
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { all, get, run, exec, transaction, raw: db };
}

module.exports = { createDb, DB_FILE };
