/**
 * קורא מאגרי store.db של Cursor (acp-sessions ו-chats) — שני מאגרים
 * ש-cass לא נוגעת בהם כלל.
 *
 * ראה workflows/runbooks/cursor-store-db-format.md ב-agents-config.
 * הכללים כאן נמדדו, לא שוערו:
 *   - mode=ro בלבד. immutable=1 מתעלם מה-WAL ומחזיר 29% פחות, בשקט.
 *   - busy_timeout=5000 — מהדפוס של franken_agent_detection.
 *   - meta.value הוא HEX של JSON.
 *   - 30% מהבלובים JSON גלוי, 70% protobuf. לא מוצפן, למרות blobEncryptionKey.
 *   - בלוב פגום → דלג, לעולם לא קריסה.
 */
import { Database } from "bun:sqlite";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** תקרה לכל הודעת protobuf, ומקסימום הודעות במצב fallback. */
const PROTO_CAP = 2000;
const PROTO_FALLBACK_MAX = 400;

export type CursorMsg = { role: string; content: string; source: "json" | "protobuf" };
export type CursorSession = {
  storePath: string; agentId?: string; title?: string; cwd?: string;
  createdAt?: number; kind: "acp-sessions" | "chats";
  messages: CursorMsg[]; blobStats: { json: number; proto: number; skipped: number };
};

/** טיול על wire-format של protobuf. מחלץ שדות length-delimited שהם UTF-8 סביר.
 *  אין צורך בסכימה: כל שדה נושא (field<<3 | wiretype) כ-varint. */
function protoStrings(buf: Uint8Array, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let i = 0;
  while (i < buf.length) {
    // varint של המפתח
    let key = 0, shift = 0, start = i;
    while (i < buf.length && shift <= 28) {
      const b = buf[i++]!;
      key |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    if (i === start) break;
    const wire = key & 7;
    if (wire === 2) {
      let len = 0; shift = 0; const ls = i;
      while (i < buf.length && shift <= 28) {
        const b = buf[i++]!;
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (i === ls || len < 0 || i + len > buf.length) break;
      const sub = buf.subarray(i, i + len);
      i += len;
      const s = tryUtf8(sub);
      if (s !== null) out.push(s);
      else protoStrings(sub, depth + 1, out);   // מבנה מקונן
    } else if (wire === 0) {
      while (i < buf.length && (buf[i++]! & 0x80) !== 0) { /* varint */ }
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;   // wiretype לא מוכר — עוצרים במקום לנחש
  }
  return out;
}

/** מחזיר מחרוזת רק אם היא UTF-8 תקין ונראית כמו טקסט (לא בייטים אקראיים). */
function tryUtf8(b: Uint8Array): string | null {
  if (b.length < 3) return null;
  let s: string;
  try { s = new TextDecoder("utf8", { fatal: true }).decode(b); } catch { return null; }
  let printable = 0;
  for (const ch of s) { const c = ch.codePointAt(0)!; if (c === 9 || c === 10 || c === 13 || c >= 32) printable++; }
  return printable / [...s].length > 0.9 ? s : null;
}

/** content הוא מחרוזת או מערך חלקים. חלקי reasoning מוצפנים-בבסיס64 נזרקים —
 *  הם אטומים ורק מרעישים את החיפוש. */
function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const p of c) {
    if (typeof p === "string") { parts.push(p); continue; }
    if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      if (typeof o.text === "string") parts.push(o.text);
      else if (typeof o.content === "string") parts.push(o.content);
      else if (o.type === "tool-result" || o.type === "tool-call") {
        const j = JSON.stringify(o.result ?? o.args ?? o.input ?? "");
        if (j && j.length > 2) parts.push(j.slice(0, 4000));
      }
    }
  }
  return parts.join("\n").trim();
}

function readMeta(db: Database): Record<string, unknown> {
  try {
    const row = db.query("select value from meta limit 1").get() as { value: unknown } | null;
    if (!row) return {};
    const v = row.value;
    const bytes = typeof v === "string" ? Buffer.from(v, "hex") : Buffer.from(v as Uint8Array);
    return JSON.parse(bytes.toString("utf8"));
  } catch { return {}; }
}

export function readStore(storePath: string, kind: CursorSession["kind"]): CursorSession | null {
  let db: Database;
  try { db = new Database(storePath, { readonly: true }); } catch { return null; }
  try {
    db.exec("pragma busy_timeout=5000");
    const meta = readMeta(db);
    // meta.json שכן, אם קיים
    let side: Record<string, unknown> = {};
    const sidePath = join(storePath, "..", "meta.json");
    if (existsSync(sidePath)) { try { side = JSON.parse(readFileSync(sidePath, "utf8")); } catch { /* לא פטאלי */ } }

    const messages: CursorMsg[] = [];
    const proto: CursorMsg[] = [];
    let nJson = 0, nProto = 0, nSkip = 0;
    for (const row of db.query("select data from blobs").all() as { data: Uint8Array }[]) {
      const b = Buffer.from(row.data);
      const asText = tryUtf8(b);
      if (asText !== null && (asText[0] === "{" || asText[0] === "[")) {
        try {
          const o = JSON.parse(asText);
          const text = contentText(o?.content);
          if (text) {
            messages.push({ role: String(o.role ?? "unknown"), content: text, source: "json" });
            nJson++; continue;
          }
        } catch { /* לא JSON באמת */ }
      }
      // בלובי protobuf הם ברובם payload של כלים — תוכן קבצים שהסוכן קרא,
      // עשרות KB לכל אחד, שכבר מאונדקס מהריפו עצמו. נמדד: 8.3MB מתוך 8.8MB
      // בשיחה אחת. נשמרים רק כ-fallback לשיחות בלי JSON, וחתוכים.
      const strs = protoStrings(b).filter((x) => x.trim().length > 2);
      if (strs.length) {
        const joined = strs.join("\n");
        proto.push({ role: "protobuf", content: joined.slice(0, PROTO_CAP), source: "protobuf" });
        nProto++;
      } else nSkip++;
    }
    // אין JSON כלל → נופלים ל-protobuf כדי לא לאבד את השיחה לגמרי
    const final = messages.length ? messages : proto.slice(0, PROTO_FALLBACK_MAX);
    return {
      storePath, kind, messages: final,
      agentId: meta.agentId as string | undefined,
      title: (meta.name as string) ?? (side.title as string),
      cwd: side.cwd as string | undefined,
      createdAt: meta.createdAt as number | undefined,
      blobStats: { json: nJson, proto: nProto, skipped: nSkip },
    };
  } catch { return null; }
  finally { try { db.close(); } catch { /* ignore */ } }
}

/** מונה את כל מאגרי ה-store.db תחת ~/.cursor. */
export function findStores(home: string): { path: string; kind: CursorSession["kind"] }[] {
  const out: { path: string; kind: CursorSession["kind"] }[] = [];
  const acp = join(home, ".cursor", "acp-sessions");
  if (existsSync(acp)) for (const d of readdirSync(acp)) {
    const p = join(acp, d, "store.db");
    if (existsSync(p)) out.push({ path: p, kind: "acp-sessions" });
  }
  const chats = join(home, ".cursor", "chats");
  if (existsSync(chats)) for (const h of readdirSync(chats)) {
    const hd = join(chats, h);
    try { if (!statSync(hd).isDirectory()) continue; } catch { continue; }
    for (const d of readdirSync(hd)) {
      const p = join(hd, d, "store.db");
      if (existsSync(p)) out.push({ path: p, kind: "chats" });
    }
  }
  return out;
}


/** חתימת שינוי זולה: גודל ו-mtime של ה-DB ושל ה-WAL.
 *  ה-WAL הוא הקריטי — הוא זה שגדל בזמן שיחה פעילה, ולעיתים הוא
 *  היחיד שמשתנה. נמדד: WAL של 4.1MB מול DB של 3.2MB בשיחה חיה. */
export function storeSignature(storePath: string): string {
  const part = (p: string) => {
    try { const s = statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; }
    catch { return "-"; }
  };
  return `${part(storePath)}|${part(storePath + "-wal")}`;
}
