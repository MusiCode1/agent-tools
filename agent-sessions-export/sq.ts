#!/usr/bin/env bun
/**
 * sq — חיפוש בסשני הסוכנים, קריאת-כלי אחת במקום שלוש.
 *
 * הדפוס הישן: recollq → נתיב קובץ → פתיחת ה-.md → grep בתוכו.
 * כאן תוצאה אחת כוללת כבר את הקטע המודגש **ואת הקשר-הסשן**
 * (תאריך · CLI · פרויקט · cwd · מזהה), כך שאפשר להחליט בלי קריאה נוספת.
 *
 *   sq "שיבוץ"                        חיפוש
 *   sq "שיבוץ" --role user --limit 5  סינון
 *   sq "שיבוץ" --project tzlev --since 2026-09-01
 *   sq --session <id>                 הצגת סשן שלם
 *   sq --stats                        סקירת הקורפוס
 *   sq "x" --json                     פלט למכונה
 *
 * 🔑 הטוקנייזר הוא trigram ⇒ תת-מחרוזת. 'שעות' מוצא גם 'בשעות'
 *    (מה ש-unicode61 ו-cass מפספסים). מינימום 3 תווים בשאילתה.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const argv = process.argv.slice(2);
const flag = (k: string, d?: string) => {
  const i = argv.findIndex((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (i < 0) return d;
  const a = argv[i]!;
  return a.includes("=") ? a.split("=").slice(1).join("=") : argv[i + 1] ?? d;
};
const has = (k: string) => argv.some((a) => a === `--${k}` || a.startsWith(`--${k}=`));
const query = argv.filter((a) => !a.startsWith("--")).filter((a, i, arr) => {
  // ערך שבא אחרי דגל-עם-רווח אינו חלק מהשאילתה
  const prev = argv[argv.indexOf(a) - 1];
  return !(prev && prev.startsWith("--") && !prev.includes("="));
}).join(" ").trim();

/** נתיב ה-DB: דגל → env → config.db_path → ברירת-מחדל. זהה ל-export.ts. */
function cfgDbPath(): string | undefined {
  try {
    const c = JSON.parse(readFileSync(join(HOME, ".config", "agent-sessions", "config.json"), "utf8"));
    return typeof c.db_path === "string" ? c.db_path : undefined;
  } catch { return undefined; }
}
const DB = flag("db") ?? process.env.AGENT_SESSIONS_DB ?? cfgDbPath()
  ?? join(HOME, ".cache", "agent-sessions", "sessions.db");
if (!existsSync(DB)) {
  console.error(`✗ אין DB ב-${DB}\n  לבנייה: bun export.ts --rebuild-db && bun export.ts --db-backfill --apply`);
  process.exit(1);
}
const db = new Database(DB, { readonly: true });
const JSONOUT = has("json");
const fmt = (ms: number | null) =>
  ms ? new Date(ms + 3 * 3600_000).toISOString().replace("T", " ").slice(0, 16) : "?";

// ───── stats ─────
if (has("stats")) {
  const m = db.query("select count(*) n from messages").get() as any;
  const s = db.query("select count(*) n from sessions").get() as any;
  const clis = db.query("select cli, count(*) n from sessions group by cli order by n desc").all() as any[];
  const span = db.query("select min(started_at) a, max(started_at) b from sessions").get() as any;
  if (JSONOUT) { console.log(JSON.stringify({ messages: m.n, sessions: s.n, clis, span })); process.exit(0); }
  console.log(`${m.n.toLocaleString("he-IL")} הודעות · ${s.n.toLocaleString("he-IL")} סשנים`);
  console.log(`טווח: ${fmt(span.a)} → ${fmt(span.b)}`);
  for (const c of clis) console.log(`  ${String(c.cli).padEnd(16)} ${c.n}`);
  process.exit(0);
}

// ───── הצגת סשן ─────
const sid = flag("session");
if (sid) {
  const s = db.query("select * from sessions where session_id = $i").get({ $i: sid }) as any;
  if (!s) { console.error(`✗ אין סשן ${sid}`); process.exit(1); }
  const msgs = db.query(
    "select role, model, ts, text from messages where session_id = $i order by seq",
  ).all({ $i: sid }) as any[];
  if (JSONOUT) { console.log(JSON.stringify({ session: s, messages: msgs })); process.exit(0); }
  console.log(`# ${s.title ?? "(ללא כותרת)"}`);
  console.log(`${s.cli} · ${s.project} · ${fmt(s.started_at)} · ${s.cwd ?? "?"}`);
  if (s.usage) console.log(`usage: ${s.usage}`);
  console.log("─".repeat(60));
  for (const m of msgs) {
    console.log(`\n## ${m.role}${m.model ? ` (${m.model})` : ""} · ${fmt(m.ts)}`);
    console.log(m.text);
  }
  process.exit(0);
}

// ───── חיפוש ─────
if (!query) {
  console.error('שימוש: sq "מונח" [--role user] [--project X] [--cli Y] [--since YYYY-MM-DD] [--limit N] [--json]\n       sq --session <id> · sq --stats');
  process.exit(2);
}
const where: string[] = ["messages_fts match $q"];
const params: Record<string, unknown> = { $q: query };
for (const [k, col] of [["role", "m.role"], ["cli", "s.cli"]] as const) {
  const v = flag(k); if (v) { where.push(`${col} = $${k}`); params[`$${k}`] = v; }
}
const proj = flag("project");
if (proj) { where.push("(s.project like $p or s.cwd like $p)"); params.$p = `%${proj}%`; }
const since = flag("since");
if (since) { where.push("m.ts >= $since"); params.$since = Date.parse(since + "T00:00:00+03:00"); }
const limit = Number(flag("limit", "10"));

const rows = db.query(
  `SELECT m.ts, m.role, m.model, m.session_id, s.cli, s.project, s.cwd, s.title,
          snippet(messages_fts, 0, '[', ']', '…', 18) AS snip
     FROM messages_fts f
     JOIN messages m ON m.rowid = f.rowid
     JOIN sessions s ON s.session_id = m.session_id
    WHERE ${where.join(" AND ")}
    ORDER BY m.ts DESC LIMIT ${limit}`,
).all(params) as any[];

const total = (db.query(
  `SELECT count(*) n FROM messages_fts f JOIN messages m ON m.rowid=f.rowid
     JOIN sessions s ON s.session_id=m.session_id WHERE ${where.join(" AND ")}`,
).get(params) as any).n;

if (JSONOUT) { console.log(JSON.stringify({ total, shown: rows.length, hits: rows })); process.exit(0); }
if (!rows.length) {
  console.log(`אין תוצאות ל-"${query}". ‏trigram דורש ≥3 תווים; נסה מונח ארוך יותר.`);
  process.exit(0);
}
console.log(`${total.toLocaleString("he-IL")} תוצאות · מציג ${rows.length}\n`);
for (const r of rows) {
  console.log(`${fmt(r.ts)} · ${r.role}${r.model ? `/${r.model}` : ""} · ${r.cli} · ${r.project}`);
  console.log(`   ${String(r.snip).replace(/\s+/g, " ").trim()}`);
  console.log(`   ↳ ${r.cwd ?? "?"}  ·  sq --session ${r.session_id}`);
  console.log();
}
db.close();
