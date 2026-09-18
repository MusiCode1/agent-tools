/**
 * קורא את ~/.local/share/opencode/opencode.db — מאגר SQLite יחיד לכל
 * הסשנים של opencode. cass קוראת אותו, אבל רק בג'וב הלילי; כאן זה
 * ישיר, כדי שהשיחות יהיו ניתנות לחיפוש תוך 20 דקות.
 *
 * מבנה: session (title, directory, tokens) → message (role) → part (תוכן).
 * התוכן נמצא **רק** ב-part; ל-message יש מטא-דאטה בלבד.
 *
 * אותם כללי בטיחות כמו ב-cursor-store: mode=ro, busy_timeout=5000,
 * בלי immutable (הוא מתעלם מה-WAL).
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type OcMsg = { role: string; content: string };
export type OcSession = {
  id: string; title?: string; directory?: string; agent?: string;
  createdAt?: number; updatedAt?: number;
  cost?: number; tokensIn?: number; tokensOut?: number;
  messages: OcMsg[];
};

export function opencodeDbPath(home: string): string {
  return join(home, ".local", "share", "opencode", "opencode.db");
}

/** חתימת שינוי — כולל ה-WAL, שהוא מה שזז בשיחה פעילה. */
export function opencodeSignature(db: string): string {
  const part = (p: string) => {
    try { const s = statSync(p); return `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return "-"; }
  };
  return `${part(db)}|${part(db + "-wal")}`;
}

/** מחלץ טקסט קריא מ-part.data. reasoning ו-step-* אינם תוכן שיחה. */
function partText(raw: string): string | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(raw); } catch { return null; }
  const t = o.type;
  if (t === "text" && typeof o.text === "string") return o.text;
  if (t === "tool") {
    const st = o.state as Record<string, unknown> | undefined;
    const bits = [o.tool, st?.title, typeof st?.output === "string" ? (st.output as string).slice(0, 2000) : ""]
      .filter((x) => typeof x === "string" && x) as string[];
    return bits.length ? bits.join(" · ") : null;
  }
  return null;   // reasoning / step-start / step-finish — רעש לחיפוש
}

export function readOpencode(dbPath: string): OcSession[] {
  if (!existsSync(dbPath)) return [];
  let db: Database;
  try { db = new Database(dbPath, { readonly: true }); } catch { return []; }
  try {
    db.exec("pragma busy_timeout=5000");
    const sessions = db.query(
      "select id, title, directory, agent, time_created, time_updated, cost, tokens_input, tokens_output from session"
    ).all() as Record<string, unknown>[];

    // כל ה-parts בשאילתה אחת, ממוינים — זול יותר מ-N שאילתות
    const parts = db.query(
      "select p.session_id, p.message_id, p.data, m.data as mdata from part p " +
      "left join message m on m.id = p.message_id order by p.session_id, p.time_created"
    ).all() as Record<string, unknown>[];

    const bySession = new Map<string, OcMsg[]>();
    let lastMsg = "", buf: string[] = [], role = "unknown", sid = "";
    const flush = () => {
      if (buf.length && sid) {
        const arr = bySession.get(sid) ?? [];
        arr.push({ role, content: buf.join("\n") });
        bySession.set(sid, arr);
      }
      buf = [];
    };
    for (const p of parts) {
      const mid = String(p.message_id ?? "");
      if (mid !== lastMsg) {
        flush();
        lastMsg = mid; sid = String(p.session_id ?? "");
        try { role = String(JSON.parse(String(p.mdata ?? "{}")).role ?? "unknown"); } catch { role = "unknown"; }
      }
      const t = partText(String(p.data ?? ""));
      if (t) buf.push(t);
    }
    flush();

    const out: OcSession[] = [];
    for (const s of sessions) {
      const msgs = bySession.get(String(s.id)) ?? [];
      if (!msgs.length) continue;
      out.push({
        id: String(s.id), title: s.title as string | undefined,
        directory: s.directory as string | undefined, agent: s.agent as string | undefined,
        createdAt: Number(s.time_created) || undefined, updatedAt: Number(s.time_updated) || undefined,
        cost: Number(s.cost) || undefined,
        tokensIn: Number(s.tokens_input) || undefined, tokensOut: Number(s.tokens_output) || undefined,
        messages: msgs,
      });
    }
    return out;
  } catch { return []; }
  finally { try { db.close(); } catch { /* ignore */ } }
}
