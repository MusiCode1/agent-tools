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
import { deflateSync } from "node:zlib";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DbMsg = {
  role: string;
  author?: string | null;
  created_at?: string | null; // ISO
  content: string;
  model?: string | null;
  extra?: Record<string, unknown>;  // מטא שלם — נשמר גלוי
  heavy?: unknown[];                // I/O מלא של כלים — נדחס
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
  [k: string]: unknown;           // שדות נוספים מה-handler (jsonl_meta, total_*_tokens…)
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
  model       TEXT,       -- opencode 100% · Claude primary · codex דליל · cursor אין
  model_provider TEXT,
  parent_session_id TEXT, -- DAG: opencode parent_id · codex parent_thread_id
  usage       TEXT,       -- JSON: tokens מצטברים (Claude) או cost/tokens (cass/opencode)
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
  model        TEXT,
  ts           INTEGER,
  parent_id    TEXT,      -- עץ-השיחה: parentUuid (Claude) / thread-parent (codex)
  text         TEXT NOT NULL,   -- חילוץ לחיפוש (פלט-כלי מקוצר)
  extra        TEXT,      -- JSON גלוי — כל המטא, ניתן ל-json_extract
  heavy        BLOB       -- JSON דחוס (zlib) — I/O מלא של כלים + thinking
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_msg_ts      ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_chash   ON messages(content_hash);
CREATE INDEX IF NOT EXISTS idx_msg_parent  ON messages(parent_id);
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

/** usage כ-JSON מכמה מקורות: Claude מצבר ב-jsonl_meta.usage; cass/opencode
 *  נותנים שדות-טוקנים top-level. מחזיר null אם אין נתוני-usage. */
function extractUsage(s: DbSession): string | null {
  const jm = s.jsonl_meta as { usage?: unknown } | undefined;
  if (jm?.usage) return JSON.stringify(jm.usage);
  const keys = [
    "total_input_tokens", "total_output_tokens", "total_cache_read_tokens",
    "total_cache_creation_tokens", "grand_total_tokens", "approx_tokens",
    "estimated_cost_usd", "api_call_count", "tool_call_count",
  ];
  const u: Record<string, unknown> = {};
  for (const k of keys) if (s[k] != null) u[k] = s[k];
  return Object.keys(u).length ? JSON.stringify(u) : null;
}

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
       (id, content_hash, session_id, seq, role, model, ts, parent_id, text, extra, heavy)
       VALUES ($id,$ch,$session,$seq,$role,$model,$ts,$parent,$text,$extra,$heavy)`,
    );
    // external-content FTS מאוכלס לפי rowid של השורה שזה-עתה נכתבה
    this.insFts = this.db.query(
      `INSERT INTO messages_fts(rowid, text) VALUES ($rowid, $text)`,
    );
    this.insSess = this.db.query(
      `INSERT OR REPLACE INTO sessions
       (session_id, machine, cli, project, cwd, title, started_at, ended_at,
        model, model_provider, parent_session_id, usage, meta)
       VALUES ($session,$machine,$cli,$project,$cwd,$title,$started,$ended,
               $model,$provider,$parent,$usage,$meta)`,
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
      $model: (s.primary_model ?? s.model ?? null) as string | null,
      $provider: (s.model_provider ?? null) as string | null,
      $parent: (s.parent_session_id ?? s.parent_id ?? null) as string | null,
      $usage: extractUsage(s), $meta: s.meta ? JSON.stringify(s.meta) : null,
    });
    let added = 0;
    const tx = this.db.transaction((rows: DbMsg[]) => {
      rows.forEach((m, seq) => {
        const text = m.content ?? "";
        if (!text) return;
        const ch = sha(text);
        const id = sha(`${s.machine}\0${s.agent}\0${sid}\0${seq}\0${ch}`).slice(0, 32);
        const extra: Record<string, unknown> = { ...(m.extra ?? {}) };
        if (m.author) extra.author = m.author;
        if (m.created_at) extra.created_at_raw = m.created_at;
        // parent_id נייטיבי (parentUuid) — נשמר כפי שהוא, לא ממופה למזהה שלנו
        const parent = (extra.parentUuid ?? extra.parent_thread_id ?? null) as string | null;
        const res = this.insMsg.run({
          $id: id, $ch: ch, $session: sid, $seq: seq, $role: m.role,
          $model: m.model ?? null, $ts: tsMs(m.created_at), $parent: parent, $text: text,
          $extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
          $heavy: m.heavy?.length
            ? deflateSync(Buffer.from(JSON.stringify(m.heavy), "utf8"))
            : null,
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
