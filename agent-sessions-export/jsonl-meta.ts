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

export type JsonlMsg = {
  role: string; content: string; created_at?: string; model?: string;
  /** כל המטא שאינו עמודה — נשמר שלם, ניתן לשאילתה (לא דחוס). */
  extra?: Record<string, unknown>;
  /** ה-I/O המלא של הכלים — נדחס ב-DB, לא נכנס ל-FTS ולא ל-text. */
  heavy?: unknown[];
};

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
  usage?: {               // מצטבר מ-message.usage (רק ב-raw — נמחק אחרי 30 יום)
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    thinking_tokens: number;
    assistant_turns: number;
  };
};

/** שדות ברמת-הרשומה שנשמרים ב-extra. ‏uuid/parentUuid הם עץ-השיחה;
 *  sourceTool* מקשרים סשן תת-סוכן לקריאת-הכלי של ההורה. */
const RECORD_META = [
  "uuid", "parentUuid", "isSidechain", "userType", "entrypoint", "requestId",
  "effort", "perTurnEffort", "promptId", "attributionSkill", "attributionMcpServer",
  "attributionMcpTool", "permissionMode", "promptSource", "sourceToolAssistantUUID",
  "sourceToolUseID", "apiBlockIndex", "origin", "turnOrigin", "toolDenialKind",
  "advisorModel", "isMeta", "turnCompanion",
] as const;

/** שדות מתוך message שנשמרים ב-extra (בקידומת message_). */
const MESSAGE_META = [
  "id", "stop_reason", "stop_sequence", "stop_details", "usage",
  "container", "type", "context_management",
] as const;

/** מחלץ טקסט מ-message.content — מחרוזת או מערך חלקים. חלקי tool_use/
 *  tool_result נשמרים מקוצרים; thinking נזרק (רעש לחיפוש). */
function partsText(c: unknown): { text: string; heavy: unknown[] } {
  if (typeof c === "string") return { text: c, heavy: [] };
  if (!Array.isArray(c)) return { text: "", heavy: [] };
  const out: string[] = [];
  const heavy: unknown[] = [];
  for (const p of c) {
    if (typeof p === "string") { out.push(p); continue; }
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") out.push(o.text);
    else if (o.type === "tool_use") {
      const j = JSON.stringify(o.input ?? "");
      // text מקוצר לחיפוש; המלא נשמר ב-heavy ולא נזרק
      out.push(`[Tool: ${String(o.name ?? "?")}] ${j.slice(0, 1500)}`);
      if (j.length > 1500) heavy.push({ kind: "tool_use", name: o.name ?? null, id: o.id ?? null, input: o.input });
    } else if (o.type === "tool_result") {
      const c2 = typeof o.content === "string" ? o.content : JSON.stringify(o.content ?? "");
      out.push(c2.slice(0, 2000));
      if (c2.length > 2000) heavy.push({ kind: "tool_result", id: o.tool_use_id ?? null, content: o.content });
    } else if (o.type === "thinking" || o.type === "redacted_thinking") {
      heavy.push({ kind: String(o.type), thinking: o.thinking ?? o.data ?? null });
    }
  }
  return { text: out.join("\n").trim(), heavy };
}

/** קורא סשן Claude Code שלם מה-.jsonl — תוכן ומטא-דאטה, בלי cass. */
export function readJsonlSession(path: string): { meta: JsonlMeta; messages: JsonlMsg[] } | null {
  const meta = readJsonlMeta(path);
  if (!meta) return null;
  let text: string;
  try { text = require("node:fs").readFileSync(path, "utf8"); } catch { return null; }
  const messages: JsonlMsg[] = [];
  const u = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0, thinking_tokens: 0, assistant_turns: 0 };
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(s); } catch { continue; }   // שורה חתוכה — תקין בקובץ פעיל
    const t = o.type;
    if (t !== "user" && t !== "assistant") continue;
    const m = (o.message ?? {}) as Record<string, unknown>;
    // צבירת usage — חינם, מעל ה-parse שממילא קורה (נמדד: תוספת בתוך רעש-המדידה)
    const usage = m.usage as Record<string, any> | undefined;
    if (usage) {
      u.input_tokens += usage.input_tokens ?? 0;
      u.output_tokens += usage.output_tokens ?? 0;
      u.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
      u.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
      u.thinking_tokens += usage.output_tokens_details?.thinking_tokens ?? 0;
      u.assistant_turns++;
    }
    const { text: content, heavy } = partsText(m.content);
    if (!content) continue;
    const ts = typeof o.timestamp === "string" ? o.timestamp : undefined;
    const model = typeof m.model === "string" ? m.model : undefined;
    if (model && !meta.primary_model) meta.primary_model = model;
    if (ts) { if (!meta.started_at) meta.started_at = ts; meta.ended_at = ts; }
    // כל מטא שאינו עמודה — נשמר שלם. אין רשימת-היתר צרה: מה שקיים, נלקח.
    const extra: Record<string, unknown> = {};
    for (const k of RECORD_META) if (o[k] !== undefined) extra[k] = o[k];
    for (const k of MESSAGE_META) if (m[k] !== undefined) extra["message_" + k] = m[k];
    messages.push({ role: String(t), content, created_at: ts, model,
      extra: Object.keys(extra).length ? extra : undefined,
      heavy: heavy.length ? heavy : undefined });
  }
  if (u.assistant_turns > 0) meta.usage = u;
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
