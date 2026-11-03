// core/transport — בניית חוזה-התעבורה (SSH/ADB). טהור: אין spawn, אין IO.

export type Transport = "ssh" | "adb";
export type Via = "auto" | "root" | "rish" | "none";

export interface AdbRoute {
  serial?: string;   // <ip>:<port> או serial
  sshHost?: string;  // אם ADB מגיע דרך מארח-ביניים (proxmox)
  ct?: number;       // קונטיינר pct על אותו מארח
}

export interface DeviceProfile {
  transport?: Transport;
  ssh?: string;        // ssh alias
  adb?: AdbRoute;
  via?: Via;
  bw_item?: string;
}

export interface Detect {
  root: boolean;
  rish: boolean;
}

/** עטיפת-ההרצה על המכשיר, מתוך זיהוי + העדפת-משתמש. */
export function chooseWrap(d: Detect, via: Via): string {
  switch (via) {
    case "root": return "su -c";
    case "rish": return "$HOME/rish -c";
    case "none": return "";
    default:     return d.root ? "su -c" : d.rish ? "$HOME/rish -c" : "";
  }
}

/** הפקודה שמריצה shell שקורא את הסקריפט מ-stdin. */
export function remoteShell(wrap: string): string {
  return wrap ? `${wrap} sh` : "sh";
}

/** argv כך ש-`argv + stdin=script` מריץ shell על המכשיר. טהור. */
export function buildInvocation(
  name: string,
  profile: DeviceProfile,
  wrap: string,
  transportOverride?: Transport,
): string[] {
  const transport = transportOverride ?? profile.transport ?? "ssh";
  const remote = remoteShell(wrap);
  if (transport === "adb") {
    const serial = profile.adb?.serial;
    if (!serial) throw new Error(`device '${name}': transport=adb אך אין adb.serial`);
    if (profile.adb?.sshHost) {
      const pct = profile.adb.ct ? `pct exec ${profile.adb.ct} -- ` : "";
      return ["ssh", "-o", "ConnectTimeout=12", profile.adb.sshHost,
              `${pct}adb -s ${serial} shell ${remote}`];
    }
    return ["adb", "-s", serial, "shell", remote];
  }
  const alias = profile.ssh ?? name;
  return ["ssh", "-o", "ConnectTimeout=12", alias, remote];
}

/** argv ל-`adb connect` כשצריך (transport=adb, serial עם IP). null אחרת. טהור. */
export function buildAdbConnect(profile: DeviceProfile, transportOverride?: Transport): string[] | null {
  const transport = transportOverride ?? profile.transport ?? "ssh";
  if (transport !== "adb") return null;
  const serial = profile.adb?.serial;
  if (!serial || !serial.includes(":")) return null; // serial-USB ⇒ אין connect
  if (profile.adb?.sshHost) {
    const pct = profile.adb.ct ? `pct exec ${profile.adb.ct} -- ` : "";
    return ["ssh", "-o", "ConnectTimeout=12", profile.adb.sshHost, `${pct}adb connect ${serial}`];
  }
  return ["adb", "connect", serial];
}
