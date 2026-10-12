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
import { SCHEMA, INDEXES } from "./db.ts";
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
/** תקרת-קטע ב-MB **לא-דחוסים**. ‏🛑 GitHub דוחה קובץ מעל 100MB, ומזהיר מעל 50.
 *  נמדד 12/10/2026 על 6 קטעים: היחס **אינו אחיד** — ‏2.63:1 בממוצע, אבל
 *  ‏1.875:1 בקטע שרוב-רובו `heavy` (‏zlib שכבר דחוס אינו נדחס שוב), ושם
 *  ‏120MB גולמי הפיקו **64MB ארוז**. ⇒ התקרה נגזרת מהמקרה הגרוע:
 *  ‏90MB × 1.875 ≈ 48MB ארוז. */
const MAX_MB = Number(flag("max-mb", "90"));
if (!DIR && !DRY) { console.error("✗ חסר --dir <תיקיית dumps>  (או --dry)"); process.exit(2); }
if (!existsSync(DB)) { console.error(`✗ אין DB ב-${DB}`); process.exit(1); }

const db = new Database(DB);
db.exec("CREATE TABLE IF NOT EXISTS export_state (key TEXT PRIMARY KEY, value TEXT)");
const WM_KEY = "dump_watermark";
const since = flag("since") !== undefined
  ? Number(flag("since"))
  : Number((db.query("select value from export_state where key=$k").get({ $k: WM_KEY }) as any)?.value ?? -1);
// 🛑 ‏-1 ולא 0: שורות שקדמו לעמודת `updated_at` נושאות NULL, ו-COALESCE מחזיר
//    עבורן 0. סף 0 היה **משמיט את כל הארכיון ההיסטורי בשקט** — הדלתא הראשונה
//    הייתה יוצאת ריקה ונראית כמו "אין שינוי". נמדד 12/10/2026 על mission13.

/** ציטוט ערך ל-SQL. ‏BLOB → X'..' ‏(hex), ‏NULL, מספר, או מחרוזת עם '' מוכפל. */
function q(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (v instanceof Uint8Array) return `X'${Buffer.from(v).toString("hex")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * 🛑 ה-FTS הוא external-content ו**מאוכלס סלקטיבית** — רק `user`+`assistant`
 *    (‏`INDEXED_ROLES` ב-db.ts). ‏`VALUES('rebuild')` המובנה של FTS5 היה
 *    מאנדקס **גם** שורות-כלים, כלומר DB משוחזר שמתנהג אחרת מהמקור.
 *    לכן השחזור מאכלס במפורש, ולכן הקובץ הזה נכתב ליד הקטעים.
 */
const RESTORE_DOC = `# שחזור ה-DB מקטעי הדלתא

\`\`\`bash
# 1. להחיל את הקטעים **לפי הסדר**. כל קטע נושא את הסכמה (IF NOT EXISTS),
#    ולכן אין צורך ליצור DB מראש.
for f in $(ls dumps/*.sql.gz | sort); do zcat "$f" | sqlite3 restored.db; done

# 2. לאכלס את ה-FTS. 🛑 **לא** 'rebuild' המובנה — הוא מאנדקס גם שורות-כלים.
#    🛑 וגם לא \`DELETE FROM messages_fts\` — על external-content הוא מחזיר
#       SQLITE_CORRUPT_VTAB (\"database disk image is malformed\"). נמדד 12/10/2026.
sqlite3 restored.db "
  INSERT INTO messages_fts(messages_fts) VALUES('delete-all');
  INSERT INTO messages_fts(rowid, text)
    SELECT rowid, text FROM messages WHERE role IN ('user','assistant');"

# 3. אימות
sqlite3 restored.db "select count(*) from messages; select count(*) from sessions;"
sqlite3 restored.db "select count(*) from messages_fts where messages_fts match 'שיבוץ';"
\`\`\`

הקטעים הם append-only: קובץ שנכתב לעולם אינו נדרס, ולכן אפשר להחיל
תוספת חדשה על DB שכבר שוחזר בלי להתחיל מחדש.
`;

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
const sessById = new Map(sess.map((s) => [String(s.session_id), s]));
const sessLine = (s: Record<string, unknown>) =>
  `INSERT OR REPLACE INTO sessions(${SESS_COLS.join(",")}) VALUES(${SESS_COLS.map((c) => q(s[c])).join(",")});`;
const msgLine = (m: Record<string, unknown>) =>
  `INSERT OR REPLACE INTO messages(${MSG_COLS.join(",")}) VALUES(${MSG_COLS.map((c) => q(m[c])).join(",")});`;

/**
 * חיתוך לקטעים. ‏🛑 כל קטע הוא טרנזקציה שלמה ובת-החלה בפני עצמה: הסשן של
 * הודעה נכתב בקטע שבו ההודעה מופיעה, ולכן אין תלות בין קטעים חוץ מסדר.
 * ‏`INSERT OR REPLACE` הופך כתיבה-כפולה של סשן לחסרת-נזק.
 */
const BUDGET = MAX_MB * 1e6;
type Chunk = { lines: string[]; bytes: number; sess: Set<string>; msgs: number };
// 🛑 הסכמה נכנסת לכל קטע. בלעדיה `zcat … | sqlite3 new.db` נופל על
//    "no such table" — הקטע מכיל INSERT בלבד. ‏IF NOT EXISTS ⇒ אידמפוטנטי.
const mkChunk = (): Chunk => ({
  lines: [SCHEMA.trim(), INDEXES.trim(), "PRAGMA foreign_keys=OFF;", "BEGIN;"],
  bytes: 0, sess: new Set(), msgs: 0,
});
const chunks: Chunk[] = [];
let cur = mkChunk();
for (const m of msgs) {
  const sid = String(m.session_id);
  const add: string[] = [];
  if (!cur.sess.has(sid)) { const sr = sessById.get(sid); if (sr) add.push(sessLine(sr)); }
  add.push(msgLine(m));
  const addBytes = add.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
  if (cur.msgs && cur.bytes + addBytes > BUDGET) { chunks.push(cur); cur = mkChunk(); }
  if (!cur.sess.has(sid)) { const sr = sessById.get(sid); if (sr) { cur.lines.push(sessLine(sr)); cur.bytes += Buffer.byteLength(sessLine(sr)) + 1; } cur.sess.add(sid); }
  const ml = msgLine(m);
  cur.lines.push(ml); cur.bytes += Buffer.byteLength(ml) + 1; cur.msgs++;
}
if (cur.msgs) chunks.push(cur);

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const built = chunks.map((c, i) => {
  const head = [
    `-- agent-sessions delta ${i + 1}/${chunks.length} · ${new Date().toISOString()}`,
    `-- since=${since} → ${maxWm} · ${c.sess.size} סשנים · ${c.msgs} הודעות`,
  ];
  const body = Buffer.from([...head, ...c.lines, "COMMIT;"].join("\n") + "\n", "utf8");
  return { body, gz: gzipSync(body, { level: 9 }), n: c.msgs, s: c.sess.size };
});
const rawTot = built.reduce((a, b) => a + b.body.length, 0);
const gzTot = built.reduce((a, b) => a + b.gz.length, 0);

if (DRY || !msgs.length) {
  console.log(`${msgs.length} הודעות · ${sess.length} סשנים · ${(rawTot / 1e6).toFixed(2)}MB → ${(gzTot / 1e6).toFixed(2)}MB ארוז · ${built.length} קטעים`);
  for (const [i, b] of built.entries())
    console.log(`  ${String(i + 1).padStart(2)}/${built.length}  ${(b.gz.length / 1e6).toFixed(1)}MB ארוז · ${b.n} הודעות`);
  if (!msgs.length) console.log("אין שינוי מאז הדלתא הקודמת — לא נכתב קובץ.");
  process.exit(0);
}

mkdirSync(DIR!, { recursive: true });
// שם לפי חותמת — ‏append-only: קובץ קיים לעולם לא נדרס
writeFileSync(join(DIR!, "RESTORE.md"), RESTORE_DOC);
const outs: string[] = [];
for (const [i, b] of built.entries()) {
  const suffix = built.length > 1 ? `-part${String(i + 1).padStart(2, "0")}` : "";
  const out = join(DIR!, `${stamp}${suffix}.sql.gz`);
  writeFileSync(out, b.gz);
  outs.push(`${out}  (${(b.gz.length / 1e6).toFixed(1)}MB · ${b.n} הודעות)`);
}
db.query("INSERT OR REPLACE INTO export_state(key,value) VALUES($k,$v)")
  .run({ $k: WM_KEY, $v: String(maxWm) });
db.close();
console.log(outs.join("\n"));
console.log(`  ${msgs.length} הודעות · ${sess.length} סשנים · ${(gzTot / 1e6).toFixed(2)}MB ארוז · watermark → ${maxWm}`);
