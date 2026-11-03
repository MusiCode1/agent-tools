import { test, expect } from "bun:test";
import {
  patternGridFromDump, patternPoints, buildPatternGesture,
  buildTextEntry, parsePatternDigits,
} from "./bouncer";
import { parseRecon } from "./recon";
import { resolveCredentialType } from "./credential";
import { buildAdbConnect, buildInvocation, chooseWrap } from "./transport";

test("patternGridFromDump — lockPatternView (סטוק)", () => {
  const xml = '<node resource-id="com.android.systemui:id/lockPatternView" content-desc="" bounds="[273,992][926,1645]" />';
  expect(patternGridFromDump(xml)).toEqual([273, 992, 926, 1645]);
});

test("patternGridFromDump — colorLockPatternView (OxygenOS/OneUI)", () => {
  const xml = '<node resource-id="com.android.systemui:id/colorLockPatternView" bounds="[9,10][100,200]" />';
  expect(patternGridFromDump(xml)).toEqual([9, 10, 100, 200]);
});

test("patternGridFromDump — לפי content-desc כשה-id לא מוכר", () => {
  const xml = '<node resource-id="x" content-desc="אזור תבנית" bounds="[1,2][3,4]" />';
  expect(patternGridFromDump(xml)).toEqual([1, 2, 3, 4]);
});

test("patternGridFromDump — null כשאין רשת", () => {
  expect(patternGridFromDump('<node resource-id="x" bounds="[0,0][1,1]"/>')).toBeNull();
});

test("patternPoints — פינות ומרכז נכונים", () => {
  const p = patternPoints([273, 992, 926, 1645]); // תא ≈ 217.67
  expect(p[1]).toEqual([381, 1100]); // שמאל-עליון
  expect(p[5]).toEqual([599, 1318]); // מרכז
  expect(p[9]).toEqual([817, 1536]); // ימין-תחתון
});

test("parsePatternDigits — מסנן לא-ספרות", () => {
  expect(parsePatternDigits("1-2-3-6")).toEqual([1, 2, 3, 6]);
});

test("buildPatternGesture — DOWN, MOVE…, UP", () => {
  const pts = patternPoints([0, 0, 300, 300]);
  const g = buildPatternGesture(pts, [1, 2, 3]);
  expect(g[0]).toMatch(/^input motionevent DOWN /);
  expect(g.filter((l) => l.startsWith("input motionevent MOVE")).length).toBe(2);
  expect(g.at(-1)).toMatch(/^input motionevent UP /);
});

test("buildTextEntry — רווח → %s + Enter", () => {
  expect(buildTextEntry("a b")).toEqual([
    "input text 'a%sb'", "sleep 0.3", "input keyevent KEYCODE_ENTER",
  ]);
});

test("parseRecon — keyguard/call/size/top", () => {
  const out = "KG=isKeyguardShowing=true\nCALL=mCallState=0\nSIZE=1200x1920\nTOP=topResumedActivity=foo\n";
  expect(parseRecon(out)).toEqual({ keyguard: true, call: false, size: "1200x1920", top: "topResumedActivity=foo" });
});

test("parseRecon — שיחה פעילה", () => {
  expect(parseRecon("CALL=mCallState=2\n").call).toBe(true);
});

test("resolveCredentialType — זיהוי אוטומטי לפי עדיפות", () => {
  expect(resolveCredentialType({ "screen-lock-pattern": "1236" })).toEqual({ type: "pattern", value: "1236" });
  expect(resolveCredentialType({ "screen-lock-pin": "4721" })).toEqual({ type: "pin", value: "4721" });
});

test("resolveCredentialType — סוג מפורש חסר ⇒ שגיאה", () => {
  expect(() => resolveCredentialType({ "screen-lock-pin": "1" }, "pattern")).toThrow();
});

test("chooseWrap — auto/root/rish/none", () => {
  expect(chooseWrap({ root: true, rish: false }, "auto")).toBe("su -c");
  expect(chooseWrap({ root: false, rish: true }, "auto")).toBe("$HOME/rish -c");
  expect(chooseWrap({ root: false, rish: false }, "auto")).toBe("");
  expect(chooseWrap({ root: false, rish: false }, "rish")).toBe("$HOME/rish -c");
});

test("buildInvocation — ssh", () => {
  expect(buildInvocation("liam-tablet", { ssh: "liam-tablet" }, "su -c")).toEqual([
    "ssh", "-o", "ConnectTimeout=12", "liam-tablet", "su -c sh",
  ]);
});

test("buildInvocation — adb ישיר", () => {
  expect(buildInvocation("d", { adb: { serial: "1.2.3.4:5555" } }, "", "adb")).toEqual([
    "adb", "-s", "1.2.3.4:5555", "shell", "sh",
  ]);
});

test("buildInvocation — adb דרך proxmox pct", () => {
  expect(buildInvocation("d", { adb: { serial: "1.2.3.4:5555", sshHost: "proxmox-remote", ct: 115 } }, "su -c", "adb")).toEqual([
    "ssh", "-o", "ConnectTimeout=12", "proxmox-remote", "pct exec 115 -- adb -s 1.2.3.4:5555 shell su -c sh",
  ]);
});

test("buildAdbConnect — adb עם IP ⇒ adb connect", () => {
  expect(buildAdbConnect({ adb: { serial: "10.32.0.11:5555" } }, "adb")).toEqual(["adb", "connect", "10.32.0.11:5555"]);
});

test("buildAdbConnect — ssh ⇒ null", () => {
  expect(buildAdbConnect({ ssh: "x" }, "ssh")).toBeNull();
});

test("buildAdbConnect — דרך מארח", () => {
  expect(buildAdbConnect({ adb: { serial: "1.2.3.4:5555", sshHost: "proxmox-remote" } }, "adb"))
    .toEqual(["ssh", "-o", "ConnectTimeout=12", "proxmox-remote", "adb connect 1.2.3.4:5555"]);
});
