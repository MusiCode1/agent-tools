// core/recon — סקריפט-ה-recon ופרסור הפלט. טהור.

export interface Recon {
  keyguard: boolean;
  call: boolean;
  size: string;
  top: string;
}

export function reconScript(): string {
  return [
    "echo KG=$(dumpsys window 2>/dev/null | grep -m1 -o 'isKeyguardShowing=[a-z]*')",
    "echo CALL=$(dumpsys telephony.registry 2>/dev/null | grep -m1 -o 'mCallState=[0-9]*')",
    "echo SIZE=$(wm size 2>/dev/null | grep -m1 -o '[0-9]*x[0-9]*' | head -1)",
    "echo TOP=$(dumpsys activity activities 2>/dev/null | grep -m1 -o 'topResumedActivity=[^ ]*')",
  ].join("\n") + "\n";
}

export function parseRecon(out: string): Recon {
  const kg = /isKeyguardShowing=([a-z]*)/.exec(out)?.[1] ?? "";
  const call = /mCallState=([0-9]*)/.exec(out)?.[1] ?? "0";
  const size = /SIZE=([0-9x]*)/.exec(out)?.[1] ?? "";
  const top = /TOP=(\S*)/.exec(out)?.[1] ?? "";
  return { keyguard: kg === "true", call: !(call === "" || call === "0"), size, top };
}
