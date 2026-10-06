// SQLite storage (node:sqlite). Deliberately boring: one table per entity kind, each row is
// `id` + the entity as a JSON string. Insertion order (rowid) is the list order, like the mock source.
import { DatabaseSync, type StatementSync } from 'node:sqlite'

export type Table = 'projects' | 'members' | 'tasks' | 'activity'
const TABLES: Table[] = ['projects', 'members', 'tasks', 'activity']

export interface Db {
  /** Runs `fn` in one transaction (BEGIN IMMEDIATE .. COMMIT, ROLLBACK when it throws). */
  tx<T>(fn: () => T): T
  all<T>(table: Table): T[]
  get<T>(table: Table, id: string): T | undefined
  /** Insert or update by id; an update keeps the row's position in the list. */
  put(table: Table, id: string, value: unknown): void
  del(table: Table, id: string): void
  clear(table: Table): void
  /** Keeps only the newest `keep` rows of a table. */
  trim(table: Table, keep: number): void
  meta(key: string): string | undefined
  setMeta(key: string, value: string): void
  close(): void
}

export function openDb(path: string): Db {
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;')
  for (const t of TABLES) raw.exec(`CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
  raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  const cache = new Map<string, StatementSync>()
  const stmt = (sql: string) => {
    let s = cache.get(sql)
    if (!s) cache.set(sql, (s = raw.prepare(sql)))
    return s
  }

  return {
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE')
      try {
        const result = fn()
        raw.exec('COMMIT')
        return result
      } catch (e) {
        raw.exec('ROLLBACK')
        throw e
      }
    },
    all<T>(table: Table) {
      return stmt(`SELECT data FROM ${table} ORDER BY rowid`).all().map((r) => JSON.parse(r.data as string) as T)
    },
    get<T>(table: Table, id: string) {
      const row = stmt(`SELECT data FROM ${table} WHERE id = ?`).get(id)
      return row ? (JSON.parse(row.data as string) as T) : undefined
    },
    put(table, id, value) {
      stmt(`INSERT INTO ${table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(value))
    },
    del(table, id) {
      stmt(`DELETE FROM ${table} WHERE id = ?`).run(id)
    },
    clear(table) {
      stmt(`DELETE FROM ${table}`).run()
    },
    trim(table, keep) {
      stmt(`DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT ?)`).run(keep)
    },
    meta(key) {
      const row = stmt('SELECT value FROM meta WHERE key = ?').get(key)
      return row ? (row.value as string) : undefined
    },
    setMeta(key, value) {
      stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
    },
    close() {
      cache.clear()
      raw.close()
    },
  }
}
