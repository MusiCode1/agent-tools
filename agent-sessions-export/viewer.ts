#!/usr/bin/env bun
/**
 * viewer.ts — מגיש את תצוגת "עמודה ליום" מעל sessions.db.
 *
 * מזין את אותה תבנית HTML שנבנתה לשחזור-השעות, אבל מה-DB במקום
 * מקורפוס מוטבע — ולכן כל לוגיקת הלקוח (מחוונים, בלוקים, פאנל
 * ההודעות) עובדת בלי שינוי.
 *
 * 🛑 הבחנה שחשוב לא לטשטש: זו תצוגת **פעילות**, לא כלי-חיוב.
 *    קורפוס-השעות עבר סינון-אוטומציה, הפרדת-מפעיל ודה-דופ ידניים;
 *    ה-DB לא. המספרים כאן אינם מספרי-הדיווח.
 *
 *   bun viewer.ts                 # 127.0.0.1:4178
 *   bun viewer.ts --port 4200 --days 30
 */
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();
const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ??
  (process.argv.includes(`--${k}`)
    ? process.argv[process.argv.indexOf(`--${k}`) + 1]
    : undefined) ?? d;

const DB_PATH = arg("db", join(HOME, ".cache", "agent-sessions", "sessions.db"))!;
const PORT = Number(arg("port", "4178"));
const DEFAULT_DAYS = Number(arg("days", "7"));
/** קיצוץ הטקסט בתשדורת. הפאנל צריך הקשר, לא מסמך שלם —
 *  נמדד: 600 תווים ל-14 יום = 25MB לא-דחוס. */
const SNIPPET = Number(arg("snippet", "300"));
/** אסימון-גישה. ריק = ללא שער (מקומי בלבד). עם אסימון: הנתיב הוא /<token>/ */
const TOKEN = arg("token", "") ?? "";
/** התבנית נמסרת ב---template, או יושבת ליד הסקריפט. אין נתיב מקובע. */
const TEMPLATE = arg("template", join(dirname(Bun.main), "day-columns.template.html"))!;

/** ברירת-מחדל לסיווג עבודה: פרויקטים ארגוניים. ניתן לעקיפה ב-?work=a,b,c */
const DEFAULT_WORK = ["tzlev-docs-repo", "portal", "aac-board", "aac-board-app",
  "students-and-school-manager", "daily-schedule", "fully-kiosk-admin", "shaon"];

const TZ_OFFSET_MS = 3 * 3600 * 1000;   // שעון ישראל — התבנית קוראת ב-getUTC*

function buildPayload(db: Database, fromMs: number, toMs: number, work: string[]) {
  const rows = db.query(
    `SELECT m.ts, m.role, m.text, s.project, s.cwd, s.cli, s.machine
       FROM messages m JOIN sessions s ON s.session_id = m.session_id
      WHERE m.ts BETWEEN $from AND $to AND m.role IN ('user','assistant')
      ORDER BY m.ts`,
  ).all({ $from: fromMs, $to: toMs }) as Record<string, any>[];

  const projects: string[] = [], machines: string[] = [], kinds: string[] = [];
  const idx = (arr: string[], v: string) => {
    const i = arr.indexOf(v);
    return i >= 0 ? i : arr.push(v) - 1;
  };
  const isWork = (p: string, cwd: string) =>
    work.some((w) => (p ?? "").includes(w) || (cwd ?? "").includes(w));

  const events = rows.map((r) => [
    Number(r.ts) + TZ_OFFSET_MS,                     // חותמת מוזזת לשעון המקום
    idx(projects, r.project || "(ללא פרויקט)"),
    isWork(r.project, r.cwd) ? 1 : 0,
    idx(machines, r.machine || "?"),
    idx(kinds, r.cli || "?"),
    // בלוק-כלי מכווץ לסימון: ב-Claude ה-tool_use יושב בתוך assistant
    // וה-tool_result בתוך user, ולכן 74% מהטקסט כאן הוא פלט-כלי.
    String(r.text ?? "").replace(/\[Tool: ([^\]]{1,40})\][\s\S]*/, "[Tool: $1 …]")
      .slice(0, SNIPPET),
  ]);
  return {
    generated: new Date().toISOString(),
    projects, machines, kinds, events,
    fixed: [], rate: 70, already_in_sheet_seconds: 0,
  };
}

if (!existsSync(TEMPLATE)) {
  console.error(`✗ תבנית לא נמצאה: ${TEMPLATE}\n  העבר --template=<נתיב>`);
  process.exit(1);
}
const tpl = TEMPLATE;
if (!existsSync(DB_PATH)) { console.error(`✗ DB לא נמצא: ${DB_PATH}`); process.exit(1); }
const html = readFileSync(tpl, "utf8");
const db = new Database(DB_PATH, { readonly: true });

/**
 * 🛑 הודעות בלי `ts` **אינן נראות בתצוגה** — הסינון הוא
 *    `WHERE m.ts BETWEEN …`, ו-NULL נופל ממנו בשקט.
 *
 * נמדד 12/10/2026: **כל** 116,281 הודעות ה-`cursor-acp` נושאות NULL,
 * ובהן 19,126 מ-14 הימים האחרונים. ⇒ עמודת-יום שבה עבדתי ב-Cursor
 * נראית **ריקה**, ולא "חסרת-נתון".
 *
 * ולמה: בבלובי ה-JSON של Cursor אין חותמת-זמן ברמת-הודעה כלל — נמדד על
 * מאגר אמיתי, 114 בלובי JSON, אפס מפתחות דמויי-זמן. יש `createdAt`
 * ברמת-הסשן בלבד. ⚠️ ‏244 הבלובים הנותרים הם protobuf, ושם חילוץ
 * המחרוזות לא היה חושף שדה מספרי — כלומר **לא נשלל** שיש שם חותמת.
 *
 * לכן המספר מופיע בבאנר ולא מוסתר: תצוגה שמדלגת בשקט גרועה מתצוגה
 * שאומרת על מה היא מדלגת.
 */
const noTs = db.query(
  `SELECT s.cli, count(*) n FROM messages m JOIN sessions s ON s.session_id = m.session_id
    WHERE m.ts IS NULL GROUP BY s.cli ORDER BY n DESC`,
).all() as { cli: string; n: number }[];
const noTsTotal = noTs.reduce((a, r) => a + r.n, 0);
if (noTsTotal) {
  console.log(`⚠️  ${noTsTotal.toLocaleString("he-IL")} הודעות בלי ts — אינן בתצוגה: ` +
    noTs.map((r) => `${r.cli}=${r.n}`).join(" · "));
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    const want = TOKEN ? `/${TOKEN}/` : "/";
    if (url.pathname !== want && url.pathname !== want + "index.html") {
      return new Response("not found", { status: 404 });
    }
    const days = Number(url.searchParams.get("days") ?? DEFAULT_DAYS);
    const toMs = url.searchParams.get("to")
      ? Date.parse(url.searchParams.get("to")! + "T23:59:59+03:00") : Date.now();
    const fromMs = url.searchParams.get("from")
      ? Date.parse(url.searchParams.get("from")! + "T00:00:00+03:00")
      : toMs - days * 86400_000;
    const work = (url.searchParams.get("work") ?? "").trim()
      ? url.searchParams.get("work")!.split(",") : DEFAULT_WORK;

    const t0 = performance.now();
    const payload = buildPayload(db, fromMs, toMs, work);
    const ms = (performance.now() - t0).toFixed(0);

    // 🛑 שני טווחי-תאריכים בלתי-תלויים, וזה מה ששבר את התצוגה:
    //    השרת בוחר לפי `?days=`, אבל **התבנית מסננת שוב בצד-הלקוח** לפי
    //    שני שדות `<input type=date>` שברירות-המחדל שלהן היו קשיחות —
    //    `2026-09-10` ו-`2026-10-05`, שאריות מתקופת-החיוב שלשמה נבנתה.
    //
    //    ⇒ הדף צייר עמודות מ-10/09, בעוד השרת שלח מ-28/09 בלבד, וכל
    //    העמודות שביניהן נראו **ריקות** — לא "חסרות-נתון". וגם הכיוון
    //    ההפוך: כל מה שאחרי 05/10 נחתך בשקט.
    //    נצרב 12/10/2026 — המשתמש שאל "למה עד ה-27/9 הכל ריק".
    //
    //    התיקון: השדות מאוכלסים מטווח המטען בפועל, כך שיש **טווח אחד**.
    // 🛑 בלי spread: ‏`Math.min(...arr)` על 233 אלף אירועים חורג ממגבלת
    //    הארגומנטים ומפיל את המחסנית. לולאה אחת, מעבר יחיד.
    const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    let tMin = Infinity, tMax = -Infinity;
    for (const e of payload.events) {
      const t = e[0] as number;
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
    }
    const lo = payload.events.length ? dayOf(tMin) : dayOf(fromMs + TZ_OFFSET_MS);
    const hi = payload.events.length ? dayOf(tMax) : dayOf(toMs + TZ_OFFSET_MS);
    const banner = `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;
      padding:8px 12px;margin:12px 18px;font-size:12.5px">
      תצוגת <b>פעילות</b> מתוך <code>sessions.db</code> — ${payload.events.length.toLocaleString("he-IL")}
      הודעות (user+assistant) · <b>${lo} → ${hi}</b> · נבנה ב-${ms}ms.
      🛑 <b>אלה אינם מספרי-חיוב</b>: קורפוס-השעות עבר סינון-אוטומציה והפרדת-מפעיל, וה-DB לא.${
      noTsTotal ? `<br>🛑 <b>${noTsTotal.toLocaleString("he-IL")} הודעות אינן כאן כלל</b> — אין להן חותמת-זמן
      (${noTs.map((r) => `${r.cli} ${r.n.toLocaleString("he-IL")}`).join(" · ")}).
      ‏Cursor אינו שומר חותמת ברמת-הודעה. <b>יום שעבדת בו ב-Cursor ייראה ריק, לא חסר.</b>` : ""}
      </div>`;

    // 🛑 טקסט-הודעה שמכיל "</script>" סוגר את בלוק הסקריפט מוקדם ושובר
    //    את העמוד. נמדד: 214 מופעים כאלה ב-30 יום. בורחים מכל '<'.
    const dataJson = JSON.stringify(payload).replace(/</g, "\\u003c");
    // 🛑 replace עם מחרוזת מפרש $& ו-$' — טקסט-הודעה עם $' שכפל את כל
    //    זנב-התבנית 16 פעמים. replacer כפונקציה אינו מפרש כלום.
    const body = html
      .replace("/*__DATA__*/null", () => dataJson)
      .replace('id="from" value="2026-09-10"', () => `id="from" value="${lo}"`)
      .replace('id="to" value="2026-10-05"', () => `id="to" value="${hi}"`)
      .replace('<div class="panel summary"', () => banner + '<div class="panel summary"');
    // gzip חוסך פי-כמה בלי שום שינוי בלקוח
    if (!(req.headers.get("accept-encoding") ?? "").includes("gzip")) {
      return new Response(body, {
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return new Response(Bun.gzipSync(Buffer.from(body, "utf8")), {
      headers: { "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip", "Cache-Control": "no-store" },
    });
  },
});
console.log(`▶ תצוגה מעל ${DB_PATH}\n  http://127.0.0.1:${PORT}/${TOKEN ? TOKEN + "/" : ""}  (ברירת-מחדל: ${DEFAULT_DAYS} ימים)`);
console.log(`  פרמטרים: ?days=30 · ?from=2026-09-10&to=2026-10-05 · ?work=tzlev,aac`);
