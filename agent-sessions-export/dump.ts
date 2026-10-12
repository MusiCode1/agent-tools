#!/usr/bin/env bun
/**
 * dump.ts — ייצוא **דלתא** של ה-DB כ-SQL דחוס.
 *
 * למה דלתא ולא dump מלא: ‏dump מונוליטי נכתב מחדש בכל ריצה, ולכן git
 * שומר blob חדש בכל קומיט. קובץ-דלתא נכתב **פעם אחת ולעולם לא שוב**,
 * ולכן אפשר לקמט ולדחוף בתדירות אמיתית בלי לנפח כלום.
 *
 * 🔑 וזה מה שסוגר את חור-הגיבוי: נמדד שהארכיון קומט 6 פעמים בלבד על
 *    6,448 קבצים, והאחרון לפני 5 שבועות — כלומר ה-churn הנמוך שלו היה
 *    תוצר של אי-גיבוי, לא של עיצוב.
 *
 * הדלתא נשענת על `messages.updated_at`, שנקבע גם בהוספה וגם בהעשרה —
 * ולכן היא תופסת גם שורות שהועשרו מאוחר יותר, לא רק חדשות.
 * היא גם נושאת את `heavy`, שכלל אינו קיים בארכיון ה-.json.
 *
 *   bun dump.ts --dir ~/Projects/agent-sessions/dumps
 *   bun dump.ts --dir X --since 0        # מאפס — דלתא מלאה
 *   bun dump.ts --dir X --dry            # כמה היה יוצא, בלי לכתוב
 *
 * שחזור: ‏zcat dumps/*.sql.gz | sqlite3 new.db
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gzipSync } from "node:zlib";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
  const i = argv.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (i < 0) return d;
  const a = argv[i]!;
  return a.includes("=") ? a.split("=").slice(1).join("=") : argv[i + 1] ?? d;
};
const has = (k: string) => argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));

function cfgDbPath(): string | undefined {
  try {
    const c = JSON.parse(readFileSync(join(HOME, ".config", "agent-sessions", "config.json"), "utf8"));
    return typeof c.db_path === "string" ? c.db_path : undefined;
  } catch { return undefined; }
}
const DB = flag("db") ?? process.env.AGENT_SESSIONS_DB ?? cfgDbPath()
  ?? join(HOME, ".cache", "agent-sessions", "sessions.db");
const DIR = flag("dir");
const DRY = has("dry");
if (!DIR && !DRY) { console.error("✗ חסר --dir <תיקיית dumps>  (או --dry)"); process.exit(2); }
if (!existsSync(DB)) { console.error(`✗ אין DB ב-${DB}`); process.exit(1); }

const db = new Database(DB);
db.exec("CREATE TABLE IF NOT EXISTS export_state (key TEXT PRIMARY KEY, value TEXT)");
const WM_KEY = "dump_watermark";
const since = flag("since") !== undefined
  ? Number(flag("since"))
  : Number((db.query("select value from export_state where key=$k").get({ $k: WM_KEY }) as any)?.value ?? 0);

/** ציטוט ערך ל-SQL. ‏BLOB → X'..' ‏(hex), ‏NULL, מספר, או מחרוזת עם '' מוכפל. */
function q(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const MSG_COLS = ["id", "content_hash", "session_id", "seq", "role", "model", "ts",
  "parent_id", "text", "extra", "heavy", "updated_at"];
const SESS_COLS = ["session_id", "machine", "cli", "project", "cwd", "title",
  "started_at", "ended_at", "model", "model_provider", "parent_session_id", "usage", "meta"];

const msgs = db.query(
  `SELECT ${MSG_COLS.join(",")} FROM messages
    WHERE COALESCE(updated_at, 0) > $s ORDER BY COALESCE(updated_at,0), rowid`,
).all({ $s: since }) as Record<string, unknown>[];
// סשנים של אותן הודעות — כדי שהדלתא תהיה בת-החלה בפני עצמה
const sessIds = [...new Set(msgs.map((m) => String(m.session_id)))];
const sess: Record<string, unknown>[] = [];
for (let i = 0; i < sessIds.length; i += 400) {
  const chunk = sessIds.slice(i, i + 400);
  sess.push(...db.query(
    `SELECT ${SESS_COLS.join(",")} FROM sessions WHERE session_id IN (${chunk.map(() => "?").join(",")})`,
  ).all(...chunk) as Record<string, unknown>[]);
}

const maxWm = msgs.reduce((a, m) => Math.max(a, Number(m.updated_at ?? 0)), since);
const lines: string[] = [
  `-- agent-sessions delta · ${new Date().toISOString()}`,
  `-- since=${since} → ${maxWm} · ${sess.length} סשנים · ${msgs.length} הודעות`,
  "PRAGMA foreign_keys=OFF;",
  "BEGIN;",
];
for (const s of sess) {
  lines.push(`INSERT OR REPLACE INTO sessions(${SESS_COLS.join(",")}) VALUES(${SESS_COLS.map((c) => q(s[c])).join(",")});`);
}
for (const m of msgs) {
  lines.push(`INSERT OR REPLACE INTO messages(${MSG_COLS.join(",")}) VALUES(${MSG_COLS.map((c) => q(m[c])).join(",")});`);
}
lines.push("COMMIT;");
const body = Buffer.from(lines.join("\n") + "\n", "utf8");
const gz = gzipSync(body, { level: 9 });

if (DRY || !msgs.length) {
  console.log(`${msgs.length} הודעות · ${sess.length} סשנים · ${(body.length / 1e6).toFixed(2)}MB → ${(gz.length / 1e6).toFixed(2)}MB ארוז`);
  if (!msgs.length) console.log("אין שינוי מאז הדלתא הקודמת — לא נכתב קובץ.");
  process.exit(0);
}

mkdirSync(DIR!, { recursive: true });
// שם לפי חותמת — ‏append-only: קובץ קיים לעולם לא נדרס
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const out = join(DIR!, `${stamp}.sql.gz`);
writeFileSync(out, gz);
db.query("INSERT OR REPLACE INTO export_state(key,value) VALUES($k,$v)")
  .run({ $k: WM_KEY, $v: String(maxWm) });
db.close();
console.log(`${out}\n  ${msgs.length} הודעות · ${sess.length} סשנים · ${(gz.length / 1e6).toFixed(2)}MB ארוז · watermark → ${maxWm}`);
