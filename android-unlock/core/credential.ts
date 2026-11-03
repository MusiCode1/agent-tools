// core/credential — בחירת סוג-הקרדנציאל מהשדות. טהור.

export type CredType = "pattern" | "pin" | "password";

export const CRED_FIELDS: Record<CredType, string> = {
  pattern: "screen-lock-pattern",
  pin: "screen-lock-pin",
  password: "screen-lock-password",
};

export function resolveCredentialType(
  fields: Record<string, string | undefined>,
  requested?: CredType,
): { type: CredType; value: string } {
  if (requested) {
    const v = fields[CRED_FIELDS[requested]];
    if (!v) throw new Error(`לפריט אין שדה '${CRED_FIELDS[requested]}'`);
    return { type: requested, value: v };
  }
  for (const t of ["pattern", "pin", "password"] as CredType[]) {
    const v = fields[CRED_FIELDS[t]];
    if (v) return { type: t, value: v };
  }
  throw new Error("לא נמצא אף שדה-נעילה (screen-lock-pattern/-pin/-password) בפריט");
}
