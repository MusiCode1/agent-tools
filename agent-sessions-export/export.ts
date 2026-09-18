#!/usr/bin/env bun
/**
 * agent-sessions-export — מייצא סשני סוכנים מארכיון cass לריפו דאטה.
 *
 * קורא מ-agent_search.db בקריאה-בלבד. לא מריץ cass, לא נועל, לא כותב אליה.
 * append-only: סשן שכבר יוצא לא נכתב מחדש.
 *
 * dry-run כברירת מחדל. --apply כדי לכתוב.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { findStores, readStore, storeSignature } from "./cursor-store";
import { redact, type RedactStats } from "./redact";
import { readOpencode, opencodeDbPath, opencodeSignature } from "./opencode-store";
import { indexClaudeJsonl, readJsonlMeta, readJsonlSession } from "./jsonl-meta";

type Route = { match?: string; match_source?: string; repo: string | null; label?: string };
type Config = {
  machine: string;
  project_roots: string[];
  resolve_symlinks: boolean;
  repos: Record<string, string>;
  default: string;
  routes: Route[];
  cass_db?: string;
};

const HOME = homedir();
const CONFIG_PATH = join(HOME, ".config", "agent-sessions", "config.json");
const APPLY = process.argv.includes("--apply");

/** גרסת סכימת הייצוא. העלאה גורמת לכתיבה מחדש של קבצים ישנים בריצה הבאה,
 *  כך ששינוי פורמט לא מותיר חצי ארכיון בגרסה ישנה.
 *  2 = נוספה jsonl_meta (agent_setting, git_branch, is_sidechain, …) */
const EXPORT_VERSION = 3;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---------- config ----------
if (!existsSync(CONFIG_PATH)) die(`אין קונפיג ב-${CONFIG_PATH}`);
const cfg: Config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
for (const k of ["machine", "project_roots", "repos", "default"] as const) {
  if (!cfg[k]) die(`חסר שדה '${k}' ב-${CONFIG_PATH}`);
}
// שורש שהוגדר ולא קיים = השערה שגויה על המכונה. נכשלים בקול.
for (const r of cfg.project_roots) {
  if (!existsSync(r)) die(`project_root לא קיים: ${r}\nהקונפיג לא מתאים למכונה הזאת. לא ממשיך.`);
}
if (!cfg.repos[cfg.default]) die(`default '${cfg.default}' אינו ברשימת repos`);

const DB_PATH = cfg.cass_db ?? join(HOME, ".local/share/coding-agent-search/agent_search.db");
if (!existsSync(DB_PATH)) die(`ארכיון cass לא נמצא: ${DB_PATH}`);

// ---------- helpers ----------
const globToRe = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

function resolvePath(p: string): string {
  if (!cfg.resolve_symlinks) return p;
  try { return realpathSync(p); } catch { return p; }
}

/** מנתב לריפו לפי workspace, ובהיעדרו לפי source_path. null = דילוג. */
function routeOf(ws: string | null, src: string | null): { repo: string | null; label?: string } {
  const hit = (pat: string, v: string) => globToRe(pat).test(v) || globToRe(pat + "/*").test(v);
  const gate = (r: { repo: string | null; label?: string }) =>
    r.repo && offlineRepos.has(r.repo) ? { repo: null } : r;
  for (const r of cfg.routes ?? []) {
    if (ws && r.match && hit(r.match, ws)) return gate({ repo: r.repo, label: r.label });
    if (!ws && src && r.match_source && hit(r.match_source, src)) return gate({ repo: r.repo, label: r.label });
  }
  return gate({ repo: cfg.default });
}

/** סולם גזירת התווית. מחזיר גם איזה נתיב לרשום בטבלה (null = לא לרשום). */
function labelOf(ws: string | null, paths: Record<string, string>): { label: string; registerPath: string | null } {
  if (!ws) return { label: "unknown", registerPath: null };
  // 1. טבלת הניתוב — תחילית ארוכה ביותר
  let best = "", bestLabel = "";
  for (const [p, label] of Object.entries(paths)) {
    if ((ws === p || ws.startsWith(p + "/")) && p.length > best.length) { best = p; bestLabel = label; }
  }
  if (bestLabel) return { label: bestLabel, registerPath: null };
  // 2. שורש פרויקטים — הסגמנט הראשון תחתיו. רק כאן רושמים.
  const roots = [...cfg.project_roots].sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (ws.startsWith(root + "/")) {
      const seg = ws.slice(root.length + 1).split("/")[0];
      if (seg) return { label: seg, registerPath: root + "/" + seg };
    }
  }
  // 3-4. דליים גנריים — לעולם לא נרשמים כתחילית, אחרת הם בולעים הכול
  if (ws === HOME || ws.startsWith(HOME + "/")) return { label: "home", registerPath: null };
  const seg = ws.split("/").filter(Boolean)[0];
  return { label: seg || "unknown", registerPath: null };
}

/** קובץ קיים נחשב עדכני רק אם הוא בגרסת הסכימה הנוכחית *וגם* לא איבד הודעות. */
function isCurrent(p: string, msgCount: number): boolean {
  try {
    const prev = JSON.parse(readFileSync(p, "utf8"));
    const v = prev?.session?.export_version ?? 1;
    return v >= EXPORT_VERSION && (prev?.session?.message_count ?? 0) >= msgCount;
  } catch { return false; }   // קובץ פגום — נכתוב מחדש
}

const safeName = (id: string) => (id.split("/").pop() || id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
const iso = (ms: number | null) => (ms == null ? null : new Date(ms > 1e11 ? ms : ms * 1000).toISOString());

// ---------- repo configs ----------
type RepoState = { root: string; paths: Record<string, string>; dirty: boolean; indexLines: string[] };
const repoState: Record<string, RepoState> = {};
/** ריפו ששורשו אינו קיים — מדלגים עליו, לא כותבים.
 *
 * 🛑 למה זה קיים: ריפו `vault` יושב על **mount של rclone**
 * (`/path/to/private-vault`). כשה-mount נופל, הנתיב עדיין "קיים"
 * כתיקיית-עגינה ריקה — ו-`mkdirSync` היה כותב סשנים לדיסק המקומי,
 * מתחת לנקודת העגינה. הם נעלמים מהעין ברגע שה-mount חוזר, ואף אחד
 * לא מקבל שגיאה.
 *
 * הסימן הוא תת-התיקייה: `sessions/` קיימת **רק** כשה-mount מחובר.
 * ריפו לא-זמין → `routeOf` מחזיר `null` → דילוג. הסשן לא אובד: הוא
 * לא נרשם ב-`index.jsonl`, ולכן ייוצא בריצה הבאה אחרי שה-mount חוזר.
 */
const offlineRepos = new Set<string>();
for (const [name, root] of Object.entries(cfg.repos)) {
  if (!existsSync(root)) {
    offlineRepos.add(name);
    console.error(`⚠️  ריפו '${name}' לא זמין (${root}) — מדלג. ייוצא בריצה הבאה.`);
  }
  const cp = join(root, "data", cfg.machine, "config.json");
  let paths: Record<string, string> = {};
  if (existsSync(cp)) paths = JSON.parse(readFileSync(cp, "utf8")).paths ?? {};
  repoState[name] = { root, paths, dirty: false, indexLines: [] };
}

// ---------- read archive ----------
const db = new Database(DB_PATH, { readonly: true });
const convs = db.query(`
  SELECT c.*, a.name AS agent_name, w.path AS workspace_path
  FROM conversations c
  LEFT JOIN agents a ON a.id = c.agent_id
  LEFT JOIN workspaces w ON w.id = c.workspace_id
  ORDER BY c.started_at
`).all() as any[];
const msgStmt = db.query(`SELECT role, author, created_at, content FROM messages WHERE conversation_id = ? ORDER BY idx`);

// אינדקס .jsonl של Claude — מטא-דאטה שקיימת במקור ו-cass לא שימרה
// (agent_setting, git_branch, is_sidechain, cli_version, ספירת attachments).
// נמדד: cass מחזיקה extra_json ל-2.6% מההודעות בלבד. העלות: 3.5s ל-536 קבצים.
const jsonlIdx = indexClaudeJsonl(HOME);

// ---------- plan ----------
type Stat = { convs: number; bytes: number };
const stats: Record<string, Record<string, Stat>> = {};
let skippedRoute = 0, alreadyDone = 0, written = 0, totalBytes = 0;
const redactStats: RedactStats = {};

for (const c of convs) {
  const wsRaw: string | null = c.workspace_path ?? null;
  const ws = wsRaw ? resolvePath(wsRaw) : null;

  const routed = routeOf(ws, c.source_path ?? null);
  const repoName = routed.repo;
  if (repoName === null) { skippedRoute++; continue; }
  const st = repoState[repoName];
  if (!st) die(`route מצביע לריפו '${repoName}' שאינו ב-repos`);

  const derived = labelOf(ws, st.paths);
  const project = routed.label ?? derived.label;
  const registerPath = routed.label ? null : derived.registerPath;
  const agent = c.agent_name ?? "unknown";
  const base = safeName(String(c.external_id ?? c.id));
  const mdDir = join(st.root, "data", cfg.machine, "sessions", project, agent);
  const jsonDir = join(st.root, "data", cfg.machine, "meta", project, agent);
  const jsonPath = join(jsonDir, base + ".json");
  const mdPath = join(mdDir, base + ".md");

  const msgs = msgStmt.all(c.id) as any[];
  if (existsSync(jsonPath) && isCurrent(jsonPath, msgs.length)) { alreadyDone++; continue; }
  const session = {
    export_version: EXPORT_VERSION,
    external_id: c.external_id, title: c.title, agent, machine: cfg.machine, project,
    workspace: wsRaw, workspace_resolved: ws !== wsRaw ? ws : undefined,
    source_path: c.source_path, origin_host: c.origin_host,
    started_at: iso(c.started_at), ended_at: iso(c.ended_at),
    primary_model: c.primary_model, estimated_cost_usd: c.estimated_cost_usd,
    total_input_tokens: c.total_input_tokens, total_output_tokens: c.total_output_tokens,
    total_cache_read_tokens: c.total_cache_read_tokens,
    total_cache_creation_tokens: c.total_cache_creation_tokens,
    grand_total_tokens: c.grand_total_tokens, approx_tokens: c.approx_tokens,
    api_call_count: c.api_call_count, tool_call_count: c.tool_call_count,
    user_message_count: c.user_message_count, assistant_message_count: c.assistant_message_count,
    message_count: msgs.length,
    ...(() => {
      const ext = c.external_id ? String(c.external_id).split("/").pop()!.replace(/\.jsonl$/, "") : null;
      const p = ext ? jsonlIdx.get(ext) : undefined;
      const m = p ? readJsonlMeta(p) : null;
      return m ? { jsonl_meta: m } : {};
    })(),
  };
  const safeMsgs = msgs.map(m => ({
    role: m.role, author: m.author, created_at: iso(m.created_at),
    content: redact(m.content ?? "", redactStats) }));
  const jsonBody = JSON.stringify({ session, messages: safeMsgs }, null, 2);

  const md = [
    `# ${c.title ?? "(ללא כותרת)"}`, "",
    `*${agent} · ${project} · ${iso(c.started_at) ?? "?"}*`, "",
    wsRaw ? `*${wsRaw}*` : "", "", "---", "",
    ...safeMsgs.flatMap(m => [`## ${m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role}`, "", m.content, "", "---", ""]),
  ].join("\n");

  const bytes = Buffer.byteLength(jsonBody) + Buffer.byteLength(md);
  (stats[repoName] ??= {});
  const s = (stats[repoName][project] ??= { convs: 0, bytes: 0 });
  s.convs++; s.bytes += bytes;
  written++; totalBytes += bytes;

  // רישום נתיב חדש בטבלת הניתוב של הריפו
  if (registerPath && !(registerPath in st.paths)) {
    st.paths[registerPath] = project; st.dirty = true;
  }
  st.indexLines.push(JSON.stringify({
    external_id: c.external_id, agent, project, workspace: wsRaw, title: c.title,
    started_at: iso(c.started_at), messages: msgs.length,
    md:   `data/${cfg.machine}/sessions/${project}/${agent}/${base}.md`,
    json: `data/${cfg.machine}/meta/${project}/${agent}/${base}.json`,
  }));

  if (APPLY) {
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(jsonPath, jsonBody);
    writeFileSync(mdPath, md);
  }
}

// ---------- מקור שני: מאגרי store.db של Cursor ש-cass לא נוגעת בהם ----------
// קריאת כל 342 המאגרים עולה ~67 שניות גם כשאין שינוי, ולכן יש דילוג
// לפי חתימת גודל+mtime של ה-DB וה-WAL. מצב נשמר ב-.export-state.json
// שיושב מחוץ לגיט (הוא מקומי למכונה ומשתנה בכל ריצה).
const statePath = join(HOME, ".config", "agent-sessions", "export-state.json");
let state: Record<string, string> = {};
if (existsSync(statePath)) { try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; } }
const nextState: Record<string, string> = {};

const stores = findStores(HOME);
let cursorRead = 0, cursorSkipped = 0, cursorUnchanged = 0;
for (const st of stores) {
  const sig = storeSignature(st.path);
  nextState[st.path] = sig;
  if (state[st.path] === sig) { cursorUnchanged++; continue; }
  const s = readStore(st.path, st.kind);
  if (!s || !s.messages.length) { cursorSkipped++; continue; }
  cursorRead++;
  const wsRaw = s.cwd ?? null;
  const ws = wsRaw ? resolvePath(wsRaw) : null;
  const routed = routeOf(ws, st.path);
  const repoName = routed.repo;
  if (repoName === null) { skippedRoute++; continue; }
  const rs = repoState[repoName];
  if (!rs) continue;
  const derived = labelOf(ws, rs.paths);
  const project = routed.label ?? derived.label;
  const registerPath = routed.label ? null : derived.registerPath;
  const agent = st.kind === "chats" ? "cursor-chats" : "cursor-acp";
  const base = safeName(s.agentId ?? st.path.split("/").slice(-2)[0]!);
  const mdDir = join(rs.root, "data", cfg.machine, "sessions", project, agent);
  const jsonDir = join(rs.root, "data", cfg.machine, "meta", project, agent);
  const jsonPath = join(jsonDir, base + ".json");
  const mdPath = join(mdDir, base + ".md");
  if (existsSync(jsonPath) && isCurrent(jsonPath, s.messages.length)) { alreadyDone++; continue; }

  const session = {
    export_version: EXPORT_VERSION,
    external_id: s.agentId, title: s.title, agent, machine: cfg.machine, project,
    workspace: wsRaw, source_path: st.path, store_kind: st.kind,
    started_at: iso(s.createdAt ?? null), message_count: s.messages.length,
    blob_stats: s.blobStats,
  };
  const safeCursor = s.messages.map((m) => ({ ...m, content: redact(m.content, redactStats) }));
  const jsonBody = JSON.stringify({ session, messages: safeCursor }, null, 2);
  const md = [
    `# ${s.title ?? "(ללא כותרת)"}`, "",
    `*${agent} · ${project} · ${iso(s.createdAt ?? null) ?? "?"}*`, "",
    wsRaw ? `*${wsRaw}*` : "", "", "---", "",
    ...safeCursor.flatMap((m) => [`## ${m.role}`, "", m.content, "", "---", ""]),
  ].join("\n");

  const bytes = Buffer.byteLength(jsonBody) + Buffer.byteLength(md);
  (stats[repoName] ??= {});
  const stt = (stats[repoName][project] ??= { convs: 0, bytes: 0 });
  stt.convs++; stt.bytes += bytes;
  written++; totalBytes += bytes;
  if (registerPath && !(registerPath in rs.paths)) { rs.paths[registerPath] = project; rs.dirty = true; }
  rs.indexLines.push(JSON.stringify({
    external_id: s.agentId, agent, project, workspace: wsRaw, title: s.title,
    started_at: iso(s.createdAt ?? null), messages: s.messages.length,
    md: `data/${cfg.machine}/sessions/${project}/${agent}/${base}.md`,
    json: `data/${cfg.machine}/meta/${project}/${agent}/${base}.json`,
  }));
  if (APPLY) {
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(jsonPath, jsonBody);
    writeFileSync(mdPath, md);
  }
}


// ---------- מקור שלישי: opencode.db ----------
// מאגר SQLite יחיד לכל הסשנים. cass קוראת אותו, אבל רק לילית — וכמו
// Cursor, אין לו קבצים שה-recoll יכול לאנדקס חי. חתימה אחת לכל ה-DB:
// אם ה-WAL או ה-DB לא זזו, אין מה לבדוק.
const ocDb = opencodeDbPath(HOME);
let ocRead = 0, ocUnchanged = 0;
const ocSig = opencodeSignature(ocDb);
nextState[ocDb] = ocSig;
if (state[ocDb] === ocSig) { ocUnchanged = 1; }
else for (const s of readOpencode(ocDb)) {
  const wsRaw = s.directory ?? null;
  const ws = wsRaw ? resolvePath(wsRaw) : null;
  const routed = routeOf(ws, ocDb);
  const repoName = routed.repo;
  if (repoName === null) { skippedRoute++; continue; }
  const rs = repoState[repoName];
  if (!rs) continue;
  const derived = labelOf(ws, rs.paths);
  const project = routed.label ?? derived.label;
  const registerPath = routed.label ? null : derived.registerPath;
  const agent = "opencode";
  const base = safeName(s.id);
  const mdDir = join(rs.root, "data", cfg.machine, "sessions", project, agent);
  const jsonDir = join(rs.root, "data", cfg.machine, "meta", project, agent);
  const jsonPath = join(jsonDir, base + ".json");
  const mdPath = join(mdDir, base + ".md");
  if (existsSync(jsonPath) && isCurrent(jsonPath, s.messages.length)) { alreadyDone++; continue; }
  ocRead++;
  const session = {
    export_version: EXPORT_VERSION,
    external_id: s.id, title: s.title, agent, machine: cfg.machine, project,
    workspace: wsRaw, source_path: ocDb, opencode_agent: s.agent,
    started_at: iso(s.createdAt ?? null), ended_at: iso(s.updatedAt ?? null),
    estimated_cost_usd: s.cost, total_input_tokens: s.tokensIn, total_output_tokens: s.tokensOut,
    message_count: s.messages.length,
  };
  const safe = s.messages.map((m) => ({ ...m, content: redact(m.content, redactStats) }));
  const jsonBody = JSON.stringify({ session, messages: safe }, null, 2);
  const md = [
    `# ${s.title ?? "(ללא כותרת)"}`, "",
    `*${agent} · ${project} · ${iso(s.createdAt ?? null) ?? "?"}*`, "",
    wsRaw ? `*${wsRaw}*` : "", "", "---", "",
    ...safe.flatMap((m) => [`## ${m.role}`, "", m.content, "", "---", ""]),
  ].join("\n");
  const bytes = Buffer.byteLength(jsonBody) + Buffer.byteLength(md);
  (stats[repoName] ??= {});
  const stt = (stats[repoName][project] ??= { convs: 0, bytes: 0 });
  stt.convs++; stt.bytes += bytes;
  written++; totalBytes += bytes;
  if (registerPath && !(registerPath in rs.paths)) { rs.paths[registerPath] = project; rs.dirty = true; }
  rs.indexLines.push(JSON.stringify({
    external_id: s.id, agent, project, workspace: wsRaw, title: s.title,
    started_at: iso(s.createdAt ?? null), messages: s.messages.length,
    md: `data/${cfg.machine}/sessions/${project}/${agent}/${base}.md`,
    json: `data/${cfg.machine}/meta/${project}/${agent}/${base}.json`,
  }));
  if (APPLY) {
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(jsonPath, jsonBody);
    writeFileSync(mdPath, md);
  }
}


// ---------- מקור רביעי: Claude Code ישירות מה-.jsonl ----------
// מחליף את cass כמקור ל-claude_code. cass נתנה 1,686 שיחות בלי מודל ובלי
// ענף; כאן 536 קבצים חיים עם מודל, ענף, פרסונה וחותמות זמן — 5.7 שניות.
// (הפער במספרים הוא בכוונה: cass מחזיקה גם ~1,151 שנמחקו מהדיסק, והן
// כבר יוצאו. המקור הזה מכסה את מה שקיים עכשיו, לפני המחיקה הבאה.)
let claudeRead = 0;
for (const [sid, jsonlPath] of jsonlIdx) {
  const sigKey = `jsonl:${jsonlPath}`;
  const sig = storeSignature(jsonlPath);
  nextState[sigKey] = sig;
  if (state[sigKey] === sig) continue;
  const r = readJsonlSession(jsonlPath);
  if (!r) continue;
  const wsRaw = r.meta.cwd ?? null;
  const ws = wsRaw ? resolvePath(wsRaw) : null;
  const routed = routeOf(ws, jsonlPath);
  const repoName = routed.repo;
  if (repoName === null) { skippedRoute++; continue; }
  const rs = repoState[repoName];
  if (!rs) continue;
  const derived = labelOf(ws, rs.paths);
  const project = routed.label ?? derived.label;
  const registerPath = routed.label ? null : derived.registerPath;
  const agent = "claude_code";
  const base = safeName(sid);
  const mdDir = join(rs.root, "data", cfg.machine, "sessions", project, agent);
  const jsonDir = join(rs.root, "data", cfg.machine, "meta", project, agent);
  const jsonPath = join(jsonDir, base + ".json");
  const mdPath = join(mdDir, base + ".md");
  if (existsSync(jsonPath) && isCurrent(jsonPath, r.messages.length)) { alreadyDone++; continue; }
  claudeRead++;
  const session = {
    export_version: EXPORT_VERSION,
    external_id: sid, title: r.messages[0]?.content.slice(0, 80), agent,
    machine: cfg.machine, project, workspace: wsRaw, source_path: jsonlPath,
    started_at: r.meta.started_at, ended_at: r.meta.ended_at,
    primary_model: r.meta.primary_model, message_count: r.messages.length,
    jsonl_meta: r.meta,
  };
  const safe = r.messages.map((m) => ({ ...m, content: redact(m.content, redactStats) }));
  const jsonBody = JSON.stringify({ session, messages: safe }, null, 2);
  const md = [
    `# ${session.title ?? "(ללא כותרת)"}`, "",
    `*${agent} · ${project} · ${r.meta.started_at?.slice(0, 19) ?? "?"}*`, "",
    wsRaw ? `*${wsRaw}*` : "", "", "---", "",
    ...safe.flatMap((m) => [`## ${m.role}`, "", m.content, "", "---", ""]),
  ].join("\n");
  const bytes = Buffer.byteLength(jsonBody) + Buffer.byteLength(md);
  (stats[repoName] ??= {});
  const stt = (stats[repoName][project] ??= { convs: 0, bytes: 0 });
  stt.convs++; stt.bytes += bytes;
  written++; totalBytes += bytes;
  if (registerPath && !(registerPath in rs.paths)) { rs.paths[registerPath] = project; rs.dirty = true; }
  rs.indexLines.push(JSON.stringify({
    external_id: sid, agent, project, workspace: wsRaw, title: session.title,
    started_at: r.meta.started_at, messages: r.messages.length,
    md: `data/${cfg.machine}/sessions/${project}/${agent}/${base}.md`,
    json: `data/${cfg.machine}/meta/${project}/${agent}/${base}.json`,
  }));
  if (APPLY) {
    mkdirSync(mdDir, { recursive: true });
    mkdirSync(jsonDir, { recursive: true });
    writeFileSync(jsonPath, jsonBody);
    writeFileSync(mdPath, md);
  }
}

// ---------- persist ----------
if (APPLY) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(nextState, null, 2));
  for (const [name, st] of Object.entries(repoState)) {
    if (!st.indexLines.length && !st.dirty) continue;
    const base = join(st.root, "data", cfg.machine);
    mkdirSync(base, { recursive: true });
    if (st.dirty) writeFileSync(join(base, "config.json"), JSON.stringify({ paths: st.paths }, null, 2));
    if (st.indexLines.length) appendFileSync(join(base, "index.jsonl"), st.indexLines.join("\n") + "\n");
  }
}

// ---------- report ----------
const mb = (b: number) => (b / 1024 / 1024).toFixed(1) + "MB";
console.log(`\n${APPLY ? "כתיבה" : "ריצה יבשה"} — מכונה ${cfg.machine}\n`);
for (const [repo, projects] of Object.entries(stats)) {
  const tc = Object.values(projects).reduce((a, s) => a + s.convs, 0);
  const tb = Object.values(projects).reduce((a, s) => a + s.bytes, 0);
  console.log(`■ ${repo}  →  ${repoState[repo]!.root}`);
  console.log(`  ${tc} שיחות · ${mb(tb)}`);
  for (const [p, s] of Object.entries(projects).sort((a, b) => b[1].convs - a[1].convs))
    console.log(`      ${String(s.convs).padStart(5)}  ${p.padEnd(34)} ${mb(s.bytes).padStart(8)}`);
  console.log();
}
console.log(`סה"כ לכתיבה: ${written} שיחות · ${mb(totalBytes)}`);
console.log(`כבר קיימים (דילוג): ${alreadyDone}`);
console.log(`דולגו ע"י routing (repo:null): ${skippedRoute}`);
console.log(`Claude .jsonl ישיר: ${claudeRead} סשנים`);
console.log(`opencode.db: ${ocRead} סשנים${ocUnchanged ? " · ללא שינוי" : ""}`);
console.log(`מאגרי Cursor store.db: ${cursorRead} נקראו · ${cursorUnchanged} ללא שינוי · ${cursorSkipped} ריקים/כשלו`);
const rTot = Object.values(redactStats).reduce((a, b) => a + b, 0);
if (rTot) console.log(`\n🔒 סודות שהוסתרו: ${rTot} — ${JSON.stringify(redactStats)}`);
if (!APPLY) console.log(`\nלא נכתב כלום. להרצה אמיתית: bun export.ts --apply`);
