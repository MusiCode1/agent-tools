/**
 * db-schemas.ts — סכמות ArkType לשתי השורות שנכתבות ל-DB.
 *
 * 🛑 גילוי, לא אכיפה. שום ולידציה כאן אינה מונעת כתיבה ואינה זורקת.
 *    רשומה שאינה תואמת **נכתבת במלואה** ורק נספרת בדוח. הסיבה: הייצוא
 *    הוא גם הגיבוי, וסכמה שחוסמת כתיבה הופכת שינוי-פורמט אצל ספק
 *    לאובדן-נתונים שקט — בדיוק מה שהכלי נועד למנוע.
 *
 * 🔑 `"+": "reject"` הוא מה שהופך את הגילוי לקפדני: בברירת-המחדל ArkType
 *    **מתעלם בשקט** משדה לא-מוצהר, וזו בדיוק צורת-הבאג שנמצאה ב-23/10/2026
 *    ב-`extra` (רשימה-לבנה שהעמידה פנים שהיא דלי; 201 שדות נזרקו).
 *
 * המפתחות המוצהרים נגזרו מחמשת אתרי-הבנייה ב-`export.ts` (claude · cursor ·
 * opencode · codex/cass · rebuild-db), ולא מתיעוד.
 */
import { type } from "arktype";

const s = "string | null | undefined";
const n = "number | null | undefined";

export const DbSessionSchema = type({
  "+": "reject",
  machine: "string",
  agent: "string",
  project: "string",
  "external_id?": s,
  "title?": s,
  "workspace?": s,
  "workspace_resolved?": s,
  "source_path?": s,
  "origin_host?": s,
  "started_at?": s,
  "ended_at?": s,
  "primary_model?": s,
  "model?": s,
  "model_provider?": s,
  "parent_session_id?": s,
  "parent_id?": s,
  "fork_session_id?": s,
  "store_kind?": s,
  "cursor_mode?": s,
  "opencode_agent?": s,
  "export_version?": n,
  "estimated_cost_usd?": n,
  "total_input_tokens?": n,
  "total_output_tokens?": n,
  "total_cache_read_tokens?": n,
  "total_cache_creation_tokens?": n,
  "grand_total_tokens?": n,
  "approx_tokens?": n,
  "tokens_reasoning?": n,
  "api_call_count?": n,
  "tool_call_count?": n,
  "user_message_count?": n,
  "assistant_message_count?": n,
  "message_count?": n,
  "meta?": "object | null | undefined",
  "jsonl_meta?": "object | null | undefined",
  "blob_stats?": "object | null | undefined",
});

export const DbMsgSchema = type({
  "+": "reject",
  role: "string",
  content: "string",
  "author?": s,
  "created_at?": s,
  "model?": s,
  "lean?": "string | undefined",
  "extra?": "object | null | undefined",
  "heavy?": "unknown[] | null | undefined",
  // נמצא ע"י ה-probe עצמו בהרצתו הראשונה (125,165 הודעות):
  // CursorMsg.source — "json" | "protobuf" (cursor-store.ts:21)
  "source?": "string | undefined",
});

export type ProbeStats = {
  sessions: number; messages: number;
  /** מפתח → מספר הפעמים שהוא נדחה. הכותרת היא השדה, לא הרשומה. */
  issues: Map<string, number>;
  /** דוגמה אחת לכל מפתח — כדי שלא נחקור מאפס */
  examples: Map<string, string>;
};

export function newProbeStats(): ProbeStats {
  return { sessions: 0, messages: 0, issues: new Map(), examples: new Map() };
}

function record(st: ProbeStats, scope: string, errs: unknown) {
  const list = Array.isArray(errs) ? errs : [errs];
  for (const e of list) {
    const path = (e as any)?.path?.join?.(".") || "(root)";
    const key = `${scope} · ${path} · ${(e as any)?.code ?? "?"}`;
    st.issues.set(key, (st.issues.get(key) ?? 0) + 1);
    if (!st.examples.has(key)) {
      st.examples.set(key, String((e as any)?.message ?? e).slice(0, 180));
    }
  }
}

/**
 * מריץ את שתי הסכמות על שורה אחת + הודעותיה. **לא זורק, לא חוסם.**
 * כל חריגה — כולל תקלה בתוך ArkType עצמו — נספרת ונבלעת.
 */
export function schemaProbe(session: unknown, msgs: unknown[], st: ProbeStats): void {
  try {
    st.sessions++;
    const r = DbSessionSchema(session);
    if (r instanceof type.errors) record(st, "session", r);
    for (const m of msgs) {
      st.messages++;
      const rm = DbMsgSchema(m);
      if (rm instanceof type.errors) record(st, "message", rm);
    }
  } catch (e) {
    st.issues.set("probe-threw", (st.issues.get("probe-threw") ?? 0) + 1);
    if (!st.examples.has("probe-threw")) st.examples.set("probe-threw", String(e).slice(0, 180));
  }
}

/** דוח בסגנון redactStats — שורה אחת לכל סוג-חריגה, הגדולה קודם. */
export function probeReport(st: ProbeStats): string {
  // 🛑 אפס-נבדקו אינו אפס-חריגות. ריצה יבשה אינה קוראת ל-upsertSession,
  //    ו-"ללא חריגות" על 0 רשומות נקרא כמו אישור-תקינות שלא ניתן.
  if (!st.sessions) {
    return `🔎 סכמה: לא נבדק דבר (0 רשומות הגיעו ל-DB) — אין כאן אישור תקינות.`;
  }
  if (!st.issues.size) {
    return `🔎 סכמה: ${st.sessions} סשנים · ${st.messages} הודעות — ללא חריגות.`;
  }
  const rows = [...st.issues.entries()].sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  const lines = [
    `🔎 סכמה: ${st.sessions} סשנים · ${st.messages} הודעות · ${total} חריגות ב-${rows.length} סוגים`,
    `   (גילוי בלבד — כל הרשומות נכתבו במלואן)`,
  ];
  for (const [k, v] of rows.slice(0, 15)) {
    lines.push(`   ${String(v).padStart(7)}  ${k}`);
    const ex = st.examples.get(k);
    if (ex) lines.push(`            ↳ ${ex}`);
  }
  if (rows.length > 15) lines.push(`   … ועוד ${rows.length - 15} סוגים`);
  return lines.join("\n");
}
