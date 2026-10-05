// The D1 stand-in every endpoint suite runs on: a prepared statement over a
// node:sqlite database with D1's call shape (bind → first / all / run).
//
// One copy, where there used to be one per suite (29 of them, in eight
// slightly different versions). It is the strictest of those versions:
//
//   - D1 refuses a query with more than 100 bound parameters. node:sqlite
//     takes 32k+, which is how an IN (...) built over a whole library could
//     pass every test and still 500 in production — so the limit is enforced
//     here, for every suite, not only the few that remembered to.
//   - run() reports `changes` and `last_row_id`, the two meta fields the
//     endpoints read.
//   - undefined binds as NULL, as D1 does.
//
//   import { Stmt } from './lib/d1.mjs';
//   const DB = { prepare: (sql) => new Stmt(db, sql) };

export const D1_MAX_BOUND_PARAMS = 100;

export class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a)));
  }
  guard() {
    if (this.args.length > D1_MAX_BOUND_PARAMS) {
      throw new Error(`D1_ERROR: too many bound parameters (${this.args.length} > ${D1_MAX_BOUND_PARAMS})`);
    }
  }
  async first() {
    this.guard();
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() {
    this.guard();
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) };
  }
  async run() {
    this.guard();
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}
