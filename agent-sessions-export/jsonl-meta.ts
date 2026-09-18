/**
 * מחלץ מטא-דאטה שקיימת ב-.jsonl הגולמי של Claude Code ו-cass לא שימרה.
 *
 * נמדד: cass מחזיקה extra_json רק ל-2.6% מההודעות ו-metadata_json ל-102
 * שיחות מתוך 2,876. השדות שלמטה פשוט אינם בארכיון שלה.
 *
 * העלות זניחה — 2.5 שניות ל-261MB / 206 קבצים, וכיסוי 100%.
 * מתוך 507KB בקובץ טיפוסי, כל המטא-דאטה הזאת היא פחות מ-1%
 * (השיחה עצמה 92%, attachments 6%).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type JsonlMsg = { role: string; content: string; created_at?: string; model?: string };

export type JsonlMeta = {
  agent_setting?: string;   // הפרסונה שרצה (planner / verifier / …) — לא קיים בשום מקום אחר
  cwd?: string;
  git_branch?: string;
  is_sidechain?: boolean;   // סשן של תת-סוכן
  cli_version?: string;
  attachments?: number;     // כמה קבצים צורפו (לא הבייטים)
  record_types?: Record<string, number>;
  primary_model?: string;
  started_at?: string;
  ended_at?: string;
};

/** מחלץ טקסט מ-message.content — מחרוזת או מערך חלקים. חלקי tool_use/
 *  tool_result נשמרים מקוצרים; thinking נזרק (רעש לחיפוש). */
function partsText(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const out: string[] = [];
  for (const p of c) {
    if (typeof p === "string") { out.push(p); continue; }
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out.push(o.text);
    else if (o.type === "tool_use") {
      const j = JSON.stringify(o.input ?? "");
      out.push(`[Tool: ${String(o.name ?? "?")}] ${j.slice(0, 1500)}`);
    } else if (o.type === "tool_result") {
      const c2 = typeof o.content === "string" ? o.content : JSON.stringify(o.content ?? "");
      out.push(c2.slice(0, 2000));
    }
    // thinking / redacted_thinking — נזרקים
  }
  return out.join("\n").trim();
}

/** קורא סשן Claude Code שלם מה-.jsonl — תוכן ומטא-דאטה, בלי cass. */
export function readJsonlSession(path: string): { meta: JsonlMeta; messages: JsonlMsg[] } | null {
  const meta = readJsonlMeta(path);
  if (!meta) return null;
  let text: string;
  try { text = require("node:fs").readFileSync(path, "utf8"); } catch { return null; }
  const messages: JsonlMsg[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(s); } catch { continue; }   // שורה חתוכה — תקין בקובץ פעיל
    const t = o.type;
    if (t !== "user" && t !== "assistant") continue;
    const m = (o.message ?? {}) as Record<string, unknown>;
    const content = partsText(m.content);
    if (!content) continue;
    const ts = typeof o.timestamp === "string" ? o.timestamp : undefined;
    const model = typeof m.model === "string" ? m.model : undefined;
    if (model && !meta.primary_model) meta.primary_model = model;
    if (ts) { if (!meta.started_at) meta.started_at = ts; meta.ended_at = ts; }
    messages.push({ role: String(t), content, created_at: ts, model });
  }
  return messages.length ? { meta, messages } : null;
}

/** קורא רק את השדות שחסרים; לא טוען את התוכן לזיכרון. */
export function readJsonlMeta(path: string): JsonlMeta | null {
  if (!existsSync(path)) return null;
  const meta: JsonlMeta = {};
  const types: Record<string, number> = {};
  let text: string;
  try { text = require("node:fs").readFileSync(path, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(s); } catch { continue; }   // שורה חתוכה בסוף קובץ פעיל — תקין
    const t = String(o.type ?? "?");
    types[t] = (types[t] ?? 0) + 1;
    if (t === "agent-setting" && typeof o.agentSetting === "string") meta.agent_setting = o.agentSetting;
    else if (t === "attachment") meta.attachments = (meta.attachments ?? 0) + 1;
    else if (t === "user" || t === "assistant") {
      if (meta.cwd === undefined && typeof o.cwd === "string") meta.cwd = o.cwd;
      if (meta.git_branch === undefined && typeof o.gitBranch === "string") meta.git_branch = o.gitBranch;
      if (meta.is_sidechain === undefined && typeof o.isSidechain === "boolean") meta.is_sidechain = o.isSidechain;
      if (meta.cli_version === undefined && typeof o.version === "string") meta.cli_version = o.version;
    }
  }
  if (Object.keys(types).length) meta.record_types = types;
  return Object.keys(meta).length ? meta : null;
}

/** אינדקס session-id → נתיב, לחיפוש מהיר בזמן ייצוא. */
export function indexClaudeJsonl(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(home, ".claude", "projects");
  if (!existsSync(root)) return out;
  const walk = (dir: string, depth = 0) => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else if (e.endsWith(".jsonl")) out.set(e.slice(0, -6), p);
    }
  };
  walk(root);
  return out;
}
