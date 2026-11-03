// core/schema — טעינת רישום-המכשירים ואימות enums. טהור.
import type { DeviceProfile, Transport, Via } from "./transport";

export type Registry = Record<string, DeviceProfile>;

const TRANSPORTS: Transport[] = ["ssh", "adb"];
const VIAS: Via[] = ["auto", "root", "rish", "none"];

export function parseRegistry(raw: string): Registry {
  const data = JSON.parse(raw);
  if (typeof data !== "object" || data === null) throw new Error("devices.json אינו אובייקט");
  for (const [k, v] of Object.entries<any>(data)) {
    if (v.transport && !TRANSPORTS.includes(v.transport)) throw new Error(`${k}: transport לא חוקי`);
    if (v.via && !VIAS.includes(v.via)) throw new Error(`${k}: via לא חוקי`);
  }
  return data as Registry;
}
