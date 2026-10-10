#!/usr/bin/env bun
/**
 * schema-check.ts — מריץ את סכמות-הארכיטייפ על כל הקורפוס.
 *
 * כל שדה שאינו בסכמה, טיפוס שאינו תואם, או שדה-חובה חסר — מדווח.
 * חריגה אינה בהכרח באג בנתונים: היא אומרת שהסכמה שלנו אינה מדויקת,
 * וזו בדיוק המטרה. יציאה != 0 כשיש חריגות, כדי שאפשר יהיה לתלות בזה
 * בדיקה אוטומטית.
 *
 *   bun schema-check.ts                 # הכול
 *   bun schema-check.ts --cli claude --limit 200
 *   bun schema-check.ts --examples 3    # דוגמה לכל סוג חריגה
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { SCHEMAS, CLAUDE_BLOCKS, validate, type Violation, type CliSchema } from "./schemas";

const HOME = homedir();
const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ??
  (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : undefined) ?? d;
const ONLY = arg("cli");
const LIMIT = Number(arg("limit", "0"));          // 0 = בלי הגבלה
const EXAMPLES = Number(arg("examples", "2"));

const byCli = (c: string) => SCHEMAS.find((s) => s.cli === c)!;
const counts = new Map<string, number>();          // חריגות
const examples = new Map<string, string[]>();      // דוגמאות
const seen = new Map<string, number>();            // רשומות שנבדקו
let totalRecords = 0;

function note(v: Violation, sample?: string) {
  const key = `${v.cli} · ${v.record} · ${v.field} · ${v.kind}${v.got ? ` (${v.got})` : ""}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
  if (sample) {
    const arr = examples.get(key) ?? [];
    if (arr.length < EXAMPLES) { arr.push(sample); examples.set(key, arr); }
  }
}
const bump = (cli: string) => { seen.set(cli, (seen.get(cli) ?? 0) + 1); totalRecords++; };

function checkObj(schema: CliSchema, o: Record<string, unknown>, where: string) {
  bump(schema.cli);
  for (const v of validate(schema, o)) note(v, where);
}

/** ───── Claude + בלוקי התוכן ───── */
function walkJsonl(root: string, cb: (o: Record<string, unknown>, where: string) => void) {
  if (!existsSync(root)) return;
  const stack = [root];
  let files = 0;
  while (stack.length) {
    const d = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!e.endsWith(".jsonl")) continue;
      if (LIMIT && ++files > LIMIT) return;
      let text: string; try { text = readFileSync(p, "utf8"); } catch { continue; }
      for (const line of text.split("\n")) {
        const s = line.trim(); if (!s) continue;
        let o: Record<string, unknown>;
        try { o = JSON.parse(s); } catch { continue; }   // שורה חתוכה — תקין
        cb(o, p);
      }
    }
  }
}

if (!ONLY || ONLY === "claude") {
  walkJsonl(join(HOME, ".claude", "projects"), (o, where) => {
    checkObj(byCli("claude"), o, where);
    const m = o.message as Record<string, unknown> | undefined;
    const c = m?.content;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === "object") checkObj(CLAUDE_BLOCKS, b as Record<string, unknown>, where);
      }
    }
  });
}

if (!ONLY || ONLY === "codex") {
  walkJsonl(join(HOME, ".codex", "sessions"), (o, where) => checkObj(byCli("codex"), o, where));
}

if (!ONLY || ONLY === "cursor") {
  const roots = [join(HOME, ".cursor", "acp-sessions"), join(HOME, ".cursor", "chats")];
  const stores: string[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const stack = [r];
    while (stack.length) {
      const d = stack.pop()!;
      let entries: string[]; try { entries = readdirSync(d); } catch { continue; }
      for (const e of entries) {
        const p = join(d, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) stack.push(p);
        else if (e === "store.db") stores.push(p);
      }
    }
  }
  for (const [i, sp] of stores.entries()) {
    if (LIMIT && i >= LIMIT) break;
    let db: Database; try { db = new Database(sp, { readonly: true }); } catch { continue; }
    try {
      db.exec("pragma busy_timeout=3000");
      for (const row of db.query("select value from meta").all() as { value: unknown }[]) {
        try {
          const b = typeof row.value === "string" ? Buffer.from(row.value, "hex") : Buffer.from(row.value as Uint8Array);
          const o = JSON.parse(b.toString("utf8"));
          if (o && typeof o === "object") checkObj(byCli("cursor.meta"), o, sp);
        } catch { /* ערך שאינו JSON — לא חריגת-סכמה */ }
      }
      for (const row of db.query("select data from blobs").all() as { data: Uint8Array }[]) {
        const buf = Buffer.from(row.data);
        if (buf[0] !== 0x7b) continue;              // רק בלובי JSON; protobuf אינו בסכמה
        try {
          const o = JSON.parse(buf.toString("utf8"));
          if (o && typeof o === "object" && !Array.isArray(o)) checkObj(byCli("cursor.blob"), o, sp);
        } catch { /* לא JSON תקין */ }
      }
    } catch { /* מאגר נעול/פגום */ }
    finally { try { db.close(); } catch { /* ignore */ } }
  }
}

if (!ONLY || ONLY === "opencode") {
  const p = join(HOME, ".local", "share", "opencode", "opencode.db");
  if (existsSync(p)) {
    const db = new Database(p, { readonly: true });
    try {
      db.exec("pragma busy_timeout=3000");
      for (const row of db.query("select * from session").all() as Record<string, unknown>[]) {
        checkObj(byCli("opencode.session"), row, p);
      }
    } catch { /* ignore */ }
    finally { try { db.close(); } catch { /* ignore */ } }
  }
}

// ───── דיווח ─────
console.log(`נבדקו ${totalRecords.toLocaleString("he-IL")} רשומות`);
for (const [cli, n] of [...seen].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cli.padEnd(20)} ${n.toLocaleString("he-IL")}`);
}
if (!counts.size) { console.log("\n✅ אין חריגות — הסכמות תואמות את כל הקורפוס."); process.exit(0); }

console.log(`\n🔴 ${counts.size} סוגי חריגה:\n`);
for (const [k, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(8)}  ${k}`);
  for (const ex of examples.get(k) ?? []) console.log(`            ↳ ${ex}`);
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
console.log(`\nסה"כ ${total.toLocaleString("he-IL")} חריגות. כל אחת = הסכמה שלנו אינה מדויקת, או שהפורמט זז.`);
process.exit(1);
