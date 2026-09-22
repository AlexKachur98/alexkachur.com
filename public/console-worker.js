// The site's own worker: sql.js from the versioned vendor folder, one database
// opened from the bytes the page posts, every statement prepared and stepped here up to a row
// limit. A classic worker, so importScripts and the initSqlJs global it defines load sql.js;
// the page thread never runs SQL. The stock worker.sql-wasm.js has no prepare, step or row
// limit and is not shipped.
const VENDOR = '/vendor/sql.js-1.14.2/';

importScripts(VENDOR + 'sql-wasm.js');

// Without locateFile the wasm would be looked for next to this script, not in the vendor folder.
const sqlJs = initSqlJs({ locateFile: (file) => VENDOR + file });
let db = null;

// sql.js throws plain strings on some paths ("Nothing to prepare") and Errors on others.
function text(error) {
  return error instanceof Error ? error.message : String(error);
}

const READ_ONLY = 'PRAGMA query_only = 1';

async function open(buffer) {
  const SQL = await sqlJs;
  if (db) db.close();
  db = new SQL.Database(new Uint8Array(buffer));
  // Opening reads nothing, so touch the schema: bytes that are not a database fail here, not
  // on the visitor's first query. Read-only is the engine's job, enforced when a statement
  // steps; the page's prefix guard only produces the friendly message.
  db.exec('SELECT 1 FROM sqlite_schema LIMIT 1');
  db.exec(READ_ONLY);
  self.postMessage({ type: 'ready' });
}

function exec(sql, limit) {
  // Sent just before prepare, so the page's timer covers the statement and never the wasm load.
  self.postMessage({ type: 'started' });
  let statement = null;
  try {
    // A flag pragma changes the connection when it is prepared, even inside EXPLAIN, which the
    // prefix guard lets through; so the flag is set again before every statement.
    db.exec(READ_ONLY);
    // prepare compiles the first statement only: sql.js passes a null tail pointer, so anything
    // after a semicolon is dropped rather than run.
    statement = db.prepare(sql);
    const rows = [];
    while (rows.length < limit && statement.step()) rows.push(statement.get());
    self.postMessage({
      type: 'result',
      columns: statement.getColumnNames(),
      rows,
      truncated: rows.length === limit,
    });
  } catch (error) {
    self.postMessage({ type: 'error', error: text(error) });
  } finally {
    if (statement) statement.free();
  }
}

self.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'open') {
    open(message.buffer).catch((error) => self.postMessage({ type: 'error', error: text(error) }));
  } else if (message.type === 'exec') {
    exec(message.sql, message.limit);
  }
};
