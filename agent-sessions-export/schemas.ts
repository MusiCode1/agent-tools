/**
 * schemas.ts — סכמות-ארכיטייפ לפורמטי הסשנים של כל CLI.
 *
 * המטרה אינה ולידציה בזמן-ריצה אלא **גילוי**: מריצים על כל הקורפוס,
 * וכל שדה שאינו מוכר או טיפוס שאינו תואם מדווח כחריגה. חריגה פירושה
 * אחד משניים — הסכמה שלנו חסרה, או שהפורמט השתנה. בשני המקרים רוצים
 * לדעת, במקום לגלות בשקט שחילצנו חלקית.
 *
 * 🛑 הסכמות נגזרו ממדידה על הקורפוס, לא מתיעוד. מה שלא נמדד אינו כאן.
 */

export type FieldType = "string" | "number" | "boolean" | "object" | "array" | "null" | "any";

export type RecordSchema = {
  /** שם מזהה לתת-הסוג (ערך השדה המבחין) */
  name: string;
  /** שדות חובה — היעדרם הוא חריגה */
  required: Record<string, FieldType | FieldType[]>;
  /** שדות מוכרים ואופציונליים — קיומם תקין, היעדרם תקין */
  optional: Record<string, FieldType | FieldType[]>;
};

export type CliSchema = {
  cli: string;
  /** השדה שלפיו בוחרים תת-סכמה (למשל "type") */
  discriminator: string;
  records: RecordSchema[];
  /** סוגים מוכרים שאיננו מפרטים — לא נחשבים חריגה, אך נספרים */
  knownUnmodeled?: string[];
};

/** ─────────── Claude Code — ‏~/.claude/projects/**\/*.jsonl ─────────── */
const CLAUDE: CliSchema = {
  cli: "claude",
  discriminator: "type",
  records: [
    {
      name: "user",
      required: { type: "string", uuid: "string", timestamp: "string", sessionId: "string" },
      optional: {
        parentUuid: ["string", "null"], isSidechain: "boolean", userType: "string",
        entrypoint: "string", cwd: "string", version: "string", gitBranch: "string",
        message: "object", promptId: "string",
        // נמדד: toolUseResult הוא גם array (310 מופעים), לא רק object/string
        toolUseResult: ["object", "string", "array"],
        sourceToolAssistantUUID: "string", sourceToolUseID: "string",
        isMeta: "boolean", promptSource: "string",
        // נמדד: origin הוא object ב-600 מופעים, לא string
        origin: ["string", "object"], turnOrigin: ["string", "object"],
        permissionMode: "string", toolDenialKind: "string", queueSkipAttachments: "any",
        turnCompanion: "any", classifierMetaLines: "any", advisorModel: "any",
        apiBlockIndex: "number", requestId: "string", effort: "string",
        perTurnEffort: "any", wireToolInputs: ["object", "array", "null"],
        slug: "string", agentId: "string", attributionAgent: ["string", "object"],
        wireIngestContext: "object", attributionSkill: "string",
        attributionMcpServer: "string", attributionMcpTool: "string",
        mcpMeta: "object", isVisibleInTranscriptOnly: "boolean",
        isCompactSummary: "boolean", isApiErrorMessage: "boolean",
        error: ["string", "object"], isAbortedMidStream: "boolean",
        supersedesUuids: "array",
        // נמדדו 23/10/2026 על כל הקורפוס:
        permissionDecision: "object",        // ×16  {decision,source,reasonType}
        imagePasteIds: "array",              // ×6   [1]
        // נמדד: session_id זהה לחלוטין ל-sessionId באותה רשומה — שדה כפול
        // באותה גרסה (2.1.285), ולא כותב אחר. ההשערה הראשונה הייתה שגויה.
        session_id: "string", serverClassifierRequest: ["object", "string"],
        serverClassifierContext: ["object", "string"], turnPosition: ["number", "string", "object"],
      },
    },
    {
      name: "assistant",
      required: { type: "string", uuid: "string", timestamp: "string", sessionId: "string", message: "object" },
      optional: {
        parentUuid: ["string", "null"], isSidechain: "boolean", userType: "string",
        entrypoint: "string", cwd: "string", version: "string", gitBranch: "string",
        apiBlockIndex: "number", requestId: "string", effort: "string",
        perTurnEffort: "any", wireToolInputs: ["object", "array", "null"],
        isMeta: "boolean", sourceToolUseID: "string", advisorModel: "any",
        sourceToolAssistantUUID: "string", promptId: "string",
        origin: ["string", "object"], turnOrigin: ["string", "object"],
        slug: "string", agentId: "string", attributionAgent: ["string", "object"],
        wireIngestContext: "object", attributionSkill: "string",
        attributionMcpServer: "string", attributionMcpTool: "string",
        mcpMeta: "object", isVisibleInTranscriptOnly: "boolean",
        isCompactSummary: "boolean", isApiErrorMessage: "boolean",
        error: ["string", "object"], isAbortedMidStream: "boolean",
        supersedesUuids: "array", apiErrorStatus: ["string", "number", "object"],
        quotaLimits: "object",
        // נמדדו 23/10/2026 על כל הקורפוס — טיפוס יחיד לכל אחד:
        requestedModel: "string",            // ×89  claude-opus-5-5 · claude-haiku-4-5
        thinkingDurationMs: "number",        // ×41  7278
        thinkingDisplay: "string",           // ×41  summarized
        requestRef: "string",                // ×1   uuid
        // נמדד: session_id זהה לחלוטין ל-sessionId באותה רשומה — שדה כפול
        // באותה גרסה (2.1.285), ולא כותב אחר. ההשערה הראשונה הייתה שגויה.
        session_id: "string", serverClassifierRequest: ["object", "string"],
        serverClassifierContext: ["object", "string"], turnPosition: ["number", "string", "object"],
      },
    },
    // ─── רשומות תשתית-API. נמדדו 23/10/2026; איננו מחלצים מהן תוכן,
    //     אך הן ממודלות כדי שסטייה עתידית בהן תדווח ולא תיבלע.
    {
      name: "api-request",
      required: { type: "string", sessionId: "string", id: "string", timestamp: "string" },
      optional: { version: "string", querySource: "string", shapeHash: "string",
        params: "object", keep: "number", tail: "array", cacheControl: "array",
        requestDigest: "string" },
    },
    {
      name: "api-request-shape",
      required: { type: "string", sessionId: "string", shapeHash: "string" },
      optional: { timestamp: "string", version: "string", shape: "object" },
    },
    {
      name: "api-request-blob",
      required: { type: "string", sessionId: "string", hash: "string" },
      optional: { message: "object" },
    },
  ],
  // נמדדו בקורפוס — קיימים ואיננו מחלצים מהם, אך אינם חריגה
  knownUnmodeled: ["summary", "system", "attachment", "agent-setting",
    "file-history-snapshot", "atis-latch", "last-prompt", "ai-title",
    "queue-operation", "mode", "custom-title", "agent-name",
    "cost-state", "permission-mode"],
};

/** בלוקים בתוך message.content של Claude */
export const CLAUDE_BLOCKS: CliSchema = {
  cli: "claude.block",
  discriminator: "type",
  records: [
    { name: "text", required: { type: "string", text: "string" }, optional: {} },
    {
      name: "tool_use",
      required: { type: "string", id: "string", name: "string", input: ["object", "array", "string"] },
      optional: { caller: "object" },
    },
    {
      name: "tool_result",
      required: { type: "string", tool_use_id: "string" },
      optional: { content: ["string", "array", "object", "null"], is_error: "boolean" },
    },
    { name: "thinking", required: { type: "string" }, optional: { thinking: "string", signature: "string" } },
    { name: "redacted_thinking", required: { type: "string" }, optional: { data: "string" } },
    { name: "image", required: { type: "string" }, optional: { source: "object" } },
    // ×3, נמדד 23/10/2026
    { name: "tool_addition", required: { type: "string", tool: "object" }, optional: {} },
  ],
  knownUnmodeled: ["document", "server_tool_use", "web_search_tool_result"],
};

/** ─────────── Codex — ‏~/.codex/sessions/**\/*.jsonl ─────────── */
const CODEX: CliSchema = {
  cli: "codex",
  discriminator: "type",
  records: [
    {
      name: "session_meta",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "response_item",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "turn_context",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "event_msg",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "compacted",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "token_usage_record",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "inter_agent_communication_metadata",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
    {
      name: "world_state",
      required: { type: "string", timestamp: "string", payload: "object" },
      optional: { ordinal: "number", metadata: "object" },
    },
  ],
  // 🔑 token_usage_record הוא ה-usage של codex — 24,227 רשומות. התגלה ע"י
  //    בדיקת-הסכמות עצמה, ולא ידענו עליו קודם.
  knownUnmodeled: [],
};

/** ─────────── Cursor — בלובי JSON ב-store.db ─────────── */
const CURSOR_BLOB: CliSchema = {
  cli: "cursor.blob",
  discriminator: "role",
  records: [
    {
      name: "user",
      required: { role: "string", content: ["string", "array"] },
      optional: { id: "string", providerOptions: "object", version: ["string", "number"], hooks: ["array", "object"] },
    },
    {
      name: "assistant",
      required: { role: "string", content: ["string", "array"] },
      optional: { id: "string", providerOptions: "object", version: ["string", "number"], hooks: ["array", "object"] },
    },
    {
      name: "tool",
      required: { role: "string", content: ["string", "array"] },
      optional: { id: "string", providerOptions: "object", version: ["string", "number"], hooks: ["array", "object"] },
    },
    {
      name: "system",
      required: { role: "string", content: ["string", "array"] },
      optional: { id: "string", providerOptions: "object", version: ["string", "number"], hooks: ["array", "object"] },
    },
  ],
  knownUnmodeled: [],
};

/** טבלת meta של Cursor — ערך HEX של JSON */
const CURSOR_META: CliSchema = {
  cli: "cursor.meta",
  discriminator: "",
  records: [
    {
      name: "*",
      required: {},
      optional: {
        agentId: "string", latestRootBlobId: "string", name: "string", mode: "string",
        isRunEverything: "boolean", createdAt: "number", blobEncryptionKey: ["string", "object"],
        subagentInfo: "object", approvalMode: "string", lastUsedModel: "string",
      },
    },
  ],
};

/** ─────────── opencode — עמודות session ב-opencode.db ─────────── */
const OPENCODE_SESSION: CliSchema = {
  cli: "opencode.session",
  discriminator: "",
  records: [
    {
      name: "*",
      required: { id: "string" },
      optional: {
        project_id: "string", workspace_id: ["string", "null"], parent_id: ["string", "null"],
        fork_session_id: ["string", "null"], slug: "string", directory: "string",
        path: "string", title: "string", version: "string", share_url: ["string", "null"],
        summary_additions: ["number", "null"], summary_deletions: ["number", "null"], summary_files: ["number", "null"],
        summary_diffs: ["string", "null"], metadata: ["string", "null"], cost: "number",
        tokens_input: "number", tokens_output: "number", tokens_reasoning: "number",
        tokens_cache_read: "number", tokens_cache_write: "number",
        revert: ["string", "null"], permission: ["string", "null"], agent: "string",
        model: "string", time_created: "number", time_updated: "number",
        time_compacting: ["number", "null"], time_archived: ["number", "null"],
      },
    },
  ],
};

export const SCHEMAS: CliSchema[] = [
  CLAUDE, CODEX, CURSOR_BLOB, CURSOR_META, OPENCODE_SESSION,
];

const typeOf = (v: unknown): FieldType => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t;
  return "any";
};

export type Violation = { cli: string; record: string; field: string; kind: string; got?: string };

/** בודק רשומה בודדת מול סכמת ה-CLI. מחזיר רשימת חריגות (ריק = תקין). */
export function validate(schema: CliSchema, obj: Record<string, unknown>): Violation[] {
  const out: Violation[] = [];
  const disc = schema.discriminator ? String(obj[schema.discriminator] ?? "") : "*";
  const rec = schema.records.find((r) => r.name === disc) ??
    (schema.records.length === 1 && schema.records[0]!.name === "*" ? schema.records[0] : undefined);
  if (!rec) {
    if (!schema.knownUnmodeled?.includes(disc)) {
      out.push({ cli: schema.cli, record: disc || "(ריק)", field: schema.discriminator, kind: "סוג-רשומה לא מוכר" });
    }
    return out;
  }
  const known = { ...rec.required, ...rec.optional };
  for (const [f, want] of Object.entries(rec.required)) {
    if (!(f in obj)) { out.push({ cli: schema.cli, record: rec.name, field: f, kind: "שדה-חובה חסר" }); continue; }
    const types = Array.isArray(want) ? want : [want];
    const got = typeOf(obj[f]);
    if (!types.includes("any") && !types.includes(got)) {
      out.push({ cli: schema.cli, record: rec.name, field: f, kind: "טיפוס שגוי", got });
    }
  }
  for (const [f, v] of Object.entries(obj)) {
    if (!(f in known)) { out.push({ cli: schema.cli, record: rec.name, field: f, kind: "שדה לא מוכר" }); continue; }
    const want = known[f]!;
    const types = Array.isArray(want) ? want : [want];
    const got = typeOf(v);
    if (!types.includes("any") && !types.includes(got)) {
      out.push({ cli: schema.cli, record: rec.name, field: f, kind: "טיפוס שגוי", got });
    }
  }
  return out;
}
