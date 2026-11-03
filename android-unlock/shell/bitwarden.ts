// shell/bitwarden — שליפת קרדנציאל דרך bw-mcp-cli (subprocess). IO.

export function bwUnlocked(): boolean {
  try {
    const p = Bun.spawnSync(["bw-mcp-cli", "status"], { stdout: "pipe", stderr: "pipe" });
    return JSON.parse(p.stdout?.toString() ?? "{}").status === "unlocked";
  } catch {
    return false;
  }
}

export function bwItemFields(name: string): Record<string, string | undefined> {
  const p = Bun.spawnSync(["bw-mcp-cli", "get", "item", name], { stdout: "pipe", stderr: "pipe" });
  if ((p.exitCode ?? 1) !== 0 || !(p.stdout?.length)) {
    throw new Error(`פריט ביטוורדן '${name}' לא נמצא`);
  }
  const item = JSON.parse(p.stdout.toString());
  const fields: Record<string, string | undefined> = {};
  for (const f of item.fields ?? []) fields[f.name] = f.value;
  return fields;
}
