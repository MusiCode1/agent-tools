#!/usr/bin/env bun
// android-unlock — הזנת תבנית/PIN/סיסמה למכשיר אנדרואיד מרוחק (SSH או ADB).
// Functional core (core/) / imperative shell (shell/): ה-entry מתזמר — ה-shell
// קורא ל-core לבניית סקריפטים ולפרסור פלט, ומריץ אותם על המכשיר.
import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildPatternGesture, buildTextEntry, parsePatternDigits,
  patternGridFromDump, patternPoints, raiseBouncerScript,
} from "./core/bouncer";
import { parseRecon, reconScript } from "./core/recon";
import { resolveCredentialType, type CredType } from "./core/credential";
import { parseRegistry, type Registry } from "./core/schema";
import type { DeviceProfile, Transport, Via } from "./core/transport";
import { Device } from "./shell/exec";
import { bwItemFields, bwUnlocked } from "./shell/bitwarden";
import { promptHidden } from "./shell/prompt";

const ASK = "\0ASK"; // דגל-סוג ללא ערך ⇒ הקלדה מוסתרת
const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, "devices.json");

function log(msg: string) { process.stderr.write(msg + "\n"); }
function die(msg: string): never { log("✗ " + msg); process.exit(1); }

/** דגל-קרדנציאל יכול לבוא עם ערך או לבד (⇒ הקלדה מוסתרת). parseArgs אינו
 *  תומך ב-optional-value, לכן מזריקים סַמָּן לפני הפרסור. */
function preprocess(argv: string[]): string[] {
  const creds = new Set(["--pattern", "--pin", "--password"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (creds.has(a)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) out.push(`${a}=${ASK}`);
      else out.push(a);
    } else {
      out.push(a);
    }
  }
  return out;
}

function loadRegistry(): Registry {
  return existsSync(REGISTRY_PATH) ? parseRegistry(readFileSync(REGISTRY_PATH, "utf8")) : {};
}

async function resolveCredential(
  values: Record<string, unknown>, name: string, profile: DeviceProfile,
): Promise<{ type: CredType; value: string; source: string }> {
  for (const t of ["pattern", "pin", "password"] as CredType[]) {
    const v = values[t] as string | undefined;
    if (v !== undefined) {
      const val = v === ASK ? await promptHidden(`${t} ל-${name} (מוסתר): `) : v;
      if (!val) die("לא הוזן קרדנציאל");
      return { type: t, value: val, source: "direct" };
    }
  }
  if (!bwUnlocked()) {
    die("כספת ביטוורדן נעולה. הרץ בטרמינל שלך: bw-mcp-unlock (כלל 120), " +
        "או העבר קוד ישיר עם --pattern/--pin/--password.");
  }
  const fields = bwItemFields(profile.bw_item ?? name);
  const r = resolveCredentialType(fields, values.type as CredType | undefined);
  return { ...r, source: "bitwarden" };
}

function verifyCredential(dev: Device, cred: string): boolean {
  const out = dev.sh(`locksettings verify --old '${cred}'\n`, { asRoot: true });
  dev.cleanLogcat();
  return out.includes("verified successfully");
}

function removeLock(dev: Device, cred: string): boolean {
  const out = dev.sh(`locksettings clear --old '${cred}'\n`, { asRoot: true });
  dev.cleanLogcat();
  const chk = dev.sh(
    "locksettings get-disabled 2>/dev/null; dumpsys lock_settings 2>/dev/null | grep -m1 CredentialType\n",
    { asRoot: true },
  );
  return chk.includes("NONE") || /success/i.test(out);
}

async function injectPattern(dev: Device, cred: string, dry: boolean): Promise<boolean> {
  dev.sh(raiseBouncerScript());
  const xml = dev.sh(
    "uiautomator dump /sdcard/.au.xml >/dev/null 2>&1; cat /sdcard/.au.xml; rm -f /sdcard/.au.xml\n",
  );
  const bounds = patternGridFromDump(xml);
  if (!bounds) die("לא נמצאה רשת-תבנית בעץ-הנגישות (האם ה-bouncer עלה? אולי הנעילה אינה תבנית)");
  const digits = parsePatternDigits(cred);
  if (digits.length < 4) die("תבנית קצרה מ-4 נקודות — כנראה ערך שגוי");
  log(`  רשת: bounds=[${bounds.join(",")}]  נקודות-תבנית=${digits.length}`);
  if (dry) return false;
  dev.sh(buildPatternGesture(patternPoints(bounds), digits).join("\n") + "\n");
  await Bun.sleep(1000);
  return true;
}

async function injectText(dev: Device, cred: string, dry: boolean): Promise<boolean> {
  dev.sh(raiseBouncerScript());
  if (dry) { log("  (dry-run: לא הוזן טקסט)"); return false; }
  dev.sh(buildTextEntry(cred).join("\n") + "\n");
  await Bun.sleep(1000);
  return true;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: preprocess(process.argv.slice(2)),
    allowPositionals: true,
    options: {
      type: { type: "string" },
      ssh: { type: "string" },
      via: { type: "string" },
      "bw-item": { type: "string" },
      transport: { type: "string" },
      pattern: { type: "string" },
      pin: { type: "string" },
      password: { type: "string" },
      "no-verify": { type: "boolean" },
      "remove-lock": { type: "boolean" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help || positionals.length === 0) {
    log("שימוש: android-unlock <device> [--type pattern|pin|password] [--pattern [VAL]] "
      + "[--pin [VAL]] [--password [VAL]] [--ssh ALIAS] [--via auto|root|rish|none] "
      + "[--transport ssh|adb] [--bw-item NAME] [--no-verify] [--force] [--dry-run] [--remove-lock]");
    process.exit(positionals.length === 0 ? 1 : 0);
  }

  const name = positionals[0];
  const registry = loadRegistry();
  const profile: DeviceProfile = { ...(registry[name] ?? {}) };
  if (values.ssh) profile.ssh = values.ssh as string;
  if (values.via) profile.via = values.via as Via;
  if (values["bw-item"]) profile.bw_item = values["bw-item"] as string;
  const transportOverride = values.transport as Transport | undefined;

  const { type, value: cred, source } = await resolveCredential(values, name, profile);
  log(`מכשיר: ${name}  ·  transport=${transportOverride ?? profile.transport ?? "ssh"}  ·  סוג=${type}  ·  מקור=${source}`);

  const dev = new Device(name, profile, transportOverride);
  dev.detect();
  log(`  root=${dev.root ? "כן" : "לא"}  wrap=${dev.wrap || "ללא"}`);

  const st = parseRecon(dev.sh(reconScript()));
  log(`  keyguard=${st.keyguard ? "מוצג" : "מבוטל"}  call=${st.call ? "פעילה" : "אין"}  size=${st.size}  top=${st.top}`);

  if (st.call && !values.force) die("שיחה פעילה על המכשיר — לא מזריק קלט עיוור. סיים שיחה או --force.");
  if (!st.keyguard && !values["remove-lock"]) { log("✓ המכשיר כבר פתוח (keyguard מבוטל)."); return; }

  if (dev.root && !values["no-verify"]) {
    if (verifyCredential(dev, cred)) log("  ✓ הקרדנציאל אומת מול locksettings");
    else die(`הקרדנציאל (${source}) לא עבר verify על המכשיר — עצירה לפני הזרקה (סכנת נעילת-השהיה).`);
  }
  if (values["remove-lock"] && !dev.root) die("--remove-lock דורש root ואין גישת root.");

  if (st.keyguard) {
    const injected = type === "pattern"
      ? await injectPattern(dev, cred, !!values["dry-run"])
      : await injectText(dev, cred, !!values["dry-run"]);
    dev.cleanLogcat();
    if (values["dry-run"]) { log("✓ dry-run הושלם (לא הוזרק דבר)."); return; }
    void injected;
    const st2 = parseRecon(dev.sh(reconScript()));
    if (st2.keyguard) die("ההזרקה לא ביטלה את ה-keyguard. בדוק את סוג-הנעילה ואת הערך.");
    log(`✓ נפתח — keyguard מבוטל, top=${st2.top}`);
  }

  if (values["remove-lock"]) {
    if (removeLock(dev, cred)) log("✓ הנעילה הוסרה (locksettings clear).");
    else die("ניסיון remove-lock לא אומת כהצלחה — בדוק ידנית.");
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
