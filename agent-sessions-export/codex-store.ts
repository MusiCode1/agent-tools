/**
 * codex-store — קריאת סשני Codex ישירות מקובצי ה-rollout.
 *
 * עד 06/09/2026 סשני codex נכנסו לארכיון **דרך cass בלבד**; כשהיא פרשה
 * הקליטה מתה בשקט (נמדד 01/11: אפס סשני codex מאז 01/09 ב-violate9,
 * ואפס אי-פעם ב-mission13 — שם cass ריקה). הסכמה של codex כבר הייתה
 * כתובה ב-`schemas.ts`, אבל איש לא כתב קורא. זה הקורא.
 *
 * מקור: `~/.codex/sessions/<שנה>/<חודש>/<יום>/rollout-<ISO>-<sessionId>.jsonl`
 * כל שורה: `{timestamp, ordinal, type, payload}` — ‏`ordinal` דטרמיניסטי.
 *
 * 🔑 המפתח הוא `session_meta.payload.session_id` — המזהה הילידי של codex,
 *    ולא נתיב. אומת 01/11: הוא זהה ל-UUID בשם-הקובץ ול-`acpSessionId`
 *    של drive-coding (3/3). ראו `drive-coding-docs/investigations/
 *    2026-10-01-codex-rollout-and-cli-message-mapping.md`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { JsonlMeta, JsonlMsg } from "./jsonl-meta";

/** מטא של codex: שדות ש-JsonlMeta (שמשותף עם Claude) אינו מכיר. */
export type CodexMeta = JsonlMeta & {
  duration_ms?: number;
  time_to_first_token_ms?: number;
  rate_limits?: unknown;
};

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** אינדקס sessionId → נתיב. המפתח נגזר משם-הקובץ כדי לא לפתוח 150+ קבצים. */
export function indexCodexSessions(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(home, ".codex", "sessions");
  if (!existsSync(root)) return out;
  const walk = (dir: string, depth = 0) => {
    if (depth > 4) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else {
        const m = UUID_RE.exec(e);
        if (m) out.set(m[1], p);
      }
    }
  };
  walk(root);
  return out;
}

/** כותרות שה-CLI כבר גזר: `~/.codex/session_index.jsonl` → id → thread_name. */
export function codexTitles(home: string): Map<string, string> {
  const out = new Map<string, string>();
  const p = join(home, ".codex", "session_index.jsonl");
  if (!existsSync(p)) return out;
  let raw: string;
  try { raw = readFileSync(p, "utf8"); } catch { return out; }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof o.id === "string" && typeof o.thread_name === "string" && o.thread_name)
        out.set(o.id, o.thread_name);
    } catch { /* שורה פגומה — מדלגים, לא מפילים */ }
  }
  return out;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    if (typeof c === "string") { parts.push(c); continue; }
    const o = c as Record<string, unknown> | null;
    if (o && typeof o.text === "string") parts.push(o.text);
  }
  return parts.join("\n");
};

/**
 * קריאת rollout יחיד. כל `response_item` הופך לרשומה משלו — בשונה מ-Claude,
 * שבו בלוקים יושבים בתוך הודעה אחת. כך נשמרים `ordinal` והחותמת לכל פריט.
 * מוסכמת `text`/`lean`/`heavy` זהה ל-`jsonl-meta.partsText`.
 */
export function readCodexSession(path: string): { meta: CodexMeta; messages: JsonlMsg[] } | null {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return null; }

  type Rec = { timestamp?: string; ordinal?: number; type?: string; payload?: Record<string, unknown> };
  const recs: Rec[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { recs.push(JSON.parse(line) as Rec); } catch { /* שורה פגומה */ }
  }
  if (!recs.length) return null;

  // סדר דטרמיניסטי לפי ordinal כשקיים; אחרת סדר-הקובץ.
  recs.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));

  const meta: CodexMeta = {};
  const record_types: Record<string, number> = {};
  const messages: JsonlMsg[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
  let sawUsage = false;

  for (const r of recs) {
    const t = String(r.type ?? "?");
    record_types[t] = (record_types[t] ?? 0) + 1;
    const pl = (r.payload ?? {}) as Record<string, unknown>;

    if (t === "session_meta") {
      if (typeof pl.cwd === "string") meta.cwd = pl.cwd;
      if (typeof pl.cli_version === "string") meta.cli_version = pl.cli_version;
      if (typeof pl.model_provider === "string") meta.primary_model = pl.model_provider;
      meta.started_at = r.timestamp ?? (typeof pl.timestamp === "string" ? pl.timestamp : undefined);
      continue;
    }
    if (t === "turn_context") {
      if (!meta.cwd && typeof pl.cwd === "string") meta.cwd = pl.cwd;
      continue;
    }
    if (t === "token_usage_record") {
      const u = (pl.usage ?? pl) as Record<string, unknown>;
      const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
      usage.input_tokens += num("input_tokens");
      usage.output_tokens += num("output_tokens");
      usage.cache_read_input_tokens += num("cached_input_tokens") + num("cache_read_input_tokens");
      usage.thinking_tokens += num("reasoning_output_tokens");
      sawUsage = true;
      continue;
    }
    if (t !== "response_item") {
      // 🔑 רשומות-בקרה נשמרות במלואן ולא נזרקות: הן מחזיקות duration_ms,
      //    time_to_first_token_ms, rate_limits, תזמון פר-פריט ו-mcp_attribution.
      //    הטקסט הוא סמן בלבד — ה-payload המלא יושב ב-heavy, שנדחס ואינו ב-FTS.
      const sub = typeof pl.type === "string" ? pl.type : t;
      if (t === "event_msg" && sub === "task_complete") {
        if (typeof pl.duration_ms === "number") meta.duration_ms = pl.duration_ms;
        if (typeof pl.time_to_first_token_ms === "number") meta.time_to_first_token_ms = pl.time_to_first_token_ms;
      }
      if (t === "event_msg" && sub === "token_count" && pl.rate_limits) meta.rate_limits = pl.rate_limits;
      const marker = `[${t}: ${sub}]`;
      messages.push({ role: "control", content: marker, lean: marker, created_at: r.timestamp, heavy: [{ kind: t, sub, payload: pl }] });
      continue;
    }

    const kind = String(pl.type ?? "?");
    const ts = r.timestamp;
    if (kind === "message") {
      const text = textOf(pl.content);
      if (!text) continue;
      messages.push({ role: String(pl.role ?? "assistant"), content: text, lean: text, created_at: ts });
    } else if (kind === "reasoning") {
      const text = textOf(pl.summary ?? pl.content);
      const marker = `[reasoning: ${text.length}]`;
      messages.push({ role: "assistant", content: marker, lean: marker, created_at: ts, heavy: [{ kind: "reasoning", payload: pl }] });
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const name = String(pl.name ?? "?");
      const args = JSON.stringify(pl.arguments ?? pl.input ?? "");
      messages.push({
        role: "assistant", content: `[Tool: ${name}] ${args.slice(0, 1500)}`,
        lean: `[Tool: ${name}]`, created_at: ts, heavy: [{ kind, name, payload: pl }],
      });
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const body = typeof pl.output === "string" ? pl.output : JSON.stringify(pl.output ?? "");
      messages.push({
        role: "tool", content: body.slice(0, 2000),
        lean: `[tool_result: ${body.length}]`, created_at: ts, heavy: [{ kind, payload: pl }],
      });
    }
  }

  meta.record_types = record_types;
  meta.ended_at = recs[recs.length - 1]?.timestamp;
  if (sawUsage) meta.usage = usage;
  if (!messages.length) return null;
  return { meta, messages };
}
