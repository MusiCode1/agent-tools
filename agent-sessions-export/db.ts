/**
 * db.ts — שכבת DB נגזרת לסשני הסוכנים.
 *
 * מקבילה ל-.md/.json, לא מחליפה אותם: הקבצים נשארים מקור-האמת העמיד
 * (README §"פורמט פתוח"), וה-DB בר-בנייה-מחדש מהם. לכן הוא יושב מחוץ לגיט.
 *
 * סכמה היברידית — ליבה רלציונית + `extra` כ-JSON לייחודי-ל-CLI. הנימוקים
 * (למה id מסונתז ולא נייטיבי, למה חותמת אחת, למה trigram) נמדדו לאורך
 * חקירת שחזור-השעות ב-agents-config/personal-assistant/data.
 *
 *   - id מסונתז מ-hash(machine|cli|session|seq|content) — המזהה הנייטיבי
 *     חסר ב-0% מהודעות assistant וב-94% מהודעות user ב-Claude.
 *   - content_hash מזהה כפילות בין מקורות (אותה הודעה משני CLIs).
 *   - FTS5 tokenize=trigram — פותר תחיליות עברית (ב/ה/ו/ל/מ/ש): נמדד
 *     ש-'שעות' מוצא 'בשעות', מה ש-unicode61 מפספס.
 *   - מאנדקסים רק user+assistant. פלט-כלי הוא 34% מהטקסט ורעש-חיפוש;
 *     הוא נשמר בטבלה אך לא נכנס ל-FTS.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DbMsg = {
  role: string;
  author?: string | null;
  created_at?: string | null; // ISO
  content: string;
  model?: string | null;
};

export type DbSession = {
  external_id?: string | null;
  machine: string;
  agent: string; // ה-CLI (claude/codex/cursor/...)
  project: string;
  workspace?: string | null; // cwd
  title?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  primary_model?: string | null;
  meta?: Record<string, unknown>; // טוקנים/ספירות/וכו' → JSON
};

const INDEXED_ROLES = new Set(["user", "assistant"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  machine     TEXT,
  cli         TEXT,
  project     TEXT,
  cwd         TEXT,
  title       TEXT,
  started_at  INTEGER,
  ended_at    INTEGER,
  meta        TEXT
);
-- שדות ברמת-סשן (cli, machine, project, cwd) חיים ב-sessions בלבד, לא כאן.
-- נמדד: join ל-sessions = 5.4ms (הטבלה זעירה + session_id מאונדקס) מול 248ms
-- לסריקת עמודה משוכפלת לא-מאונדקסת. ⇒ שכפול היה גם איטי וגם 39MB מבוזבזים.
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  session_id   TEXT,
  seq          INTEGER,
  role         TEXT,
  ts           INTEGER,
  text         TEXT NOT NULL,
  extra        TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_chash   ON messages(content_hash);
-- external-content FTS: לא משכפל טקסט; מאוכלס ידנית רק ל-user+assistant.
-- ⚠️ count(*) וסריקת rowid משקפים את טבלת-התוכן, אבל MATCH מוצא רק שורות
--    שהוכנסו (נמדד: מונחי-כלי לא נמצאים). append-only ⇒ בלי טריגרים.
--    rebuild חייב לאכלס סלקטיבית — לא להריץ 'rebuild' המובנה של FTS5.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='rowid', tokenize='trigram'
);
`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tsMs = (iso?: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export class SessionsDb {
  private db: Database;
  private insMsg;
  private insFts;
  private insSess;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");
    this.db.exec(SCHEMA);
    this.insMsg = this.db.query(
      `INSERT OR IGNORE INTO messages
       (id, content_hash, session_id, seq, role, ts, text, extra)
       VALUES ($id,$ch,$session,$seq,$role,$ts,$text,$extra)`,
    );
    // external-content FTS מאוכלס לפי rowid של השורה שזה-עתה נכתבה
    this.insFts = this.db.query(
      `INSERT INTO messages_fts(rowid, text) VALUES ($rowid, $text)`,
    );
    this.insSess = this.db.query(
      `INSERT OR REPLACE INTO sessions
       (session_id, machine, cli, project, cwd, title, started_at, ended_at, meta)
       VALUES ($session,$machine,$cli,$project,$cwd,$title,$started,$ended,$meta)`,
    );
  }

  /** כותב סשן אחד (שורת sessions + שורות messages). אידמפוטנטי: הרצה חוזרת
   *  לא כותבת שוב (INSERT OR IGNORE לפי id מסונתז). מחזיר כמה הודעות חדשות. */
  upsertSession(s: DbSession, msgs: DbMsg[]): number {
    const sid = String(s.external_id ?? `${s.machine}:${s.agent}:${s.title ?? ""}`);
    this.insSess.run({
      $session: sid, $machine: s.machine, $cli: s.agent, $project: s.project,
      $cwd: s.workspace ?? null, $title: s.title ?? null,
      $started: tsMs(s.started_at), $ended: tsMs(s.ended_at),
      $meta: s.meta ? JSON.stringify(s.meta) : null,
    });
    let added = 0;
    const tx = this.db.transaction((rows: DbMsg[]) => {
      rows.forEach((m, seq) => {
        const text = m.content ?? "";
        if (!text) return;
        const ch = sha(text);
        const id = sha(`${s.machine}\0${s.agent}\0${sid}\0${seq}\0${ch}`).slice(0, 32);
        const extra: Record<string, unknown> = {};
        if (m.author) extra.author = m.author;
        if (m.created_at) extra.created_at_raw = m.created_at;
        if (m.model) extra.model = m.model;
        const res = this.insMsg.run({
          $id: id, $ch: ch, $session: sid, $seq: seq, $role: m.role,
          $ts: tsMs(m.created_at), $text: text,
          $extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
        });
        if (res.changes > 0) {
          added++;
          if (INDEXED_ROLES.has(m.role)) {
            this.insFts.run({ $rowid: res.lastInsertRowid, $text: text });
          }
        }
      });
    });
    tx(msgs);
    return added;
  }

  close() {
    try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
    this.db.close();
  }
}
