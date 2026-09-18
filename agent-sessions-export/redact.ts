/**
 * מסתיר סודות מתוכן לפני כתיבה לארכיון.
 *
 * הרקע: הניתוב לריפואים הוא לפי **נתיב**, לא לפי תוכן. סוד שנשפך לתוך
 * סשן ב-project-a יגיע ל-technical בלי שום עצירה. נצרב כשמפתח
 * API של Cursor מ-~/.cursor/sdk/auth.json הודפס לתמליל סשן חי.
 *
 * גיט לא שוכח — לכן הסינון קורה לפני הכתיבה, לא אחריה.
 */

type Rule = { name: string; re: RegExp };

const RULES: Rule[] = [
  { name: "cursor",     re: /\bcrsr_[A-Za-z0-9]{16,}/g },
  { name: "openai",     re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g },
  { name: "anthropic",  re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "github",     re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: "google",     re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  { name: "slack",      re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/g },
  { name: "aws",        re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "elevenlabs", re: /\b(?:sk_)[a-f0-9]{32,}/g },
  { name: "hf",         re: /\bhf_[A-Za-z0-9]{20,}/g },
  { name: "bearer",     re: /\b[Bb]earer\s+[A-Za-z0-9._-]{24,}/g },
  { name: "pem",        re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  // מפתח בתוך JSON: "apiKey": "…"  /  "token": "…"
  { name: "json-key",   re: /"(?:api_?[Kk]ey|access_?[Tt]oken|secret|password|passphrase)"\s*:\s*"[^"]{12,}"/g },
];

export type RedactStats = Record<string, number>;

export function redact(text: string, stats?: RedactStats): string {
  if (!text) return text;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (m) => {
      if (stats) stats[r.name] = (stats[r.name] ?? 0) + 1;
      // שומרים את הצורה כדי שיהיה ברור מה הוסתר, בלי הערך
      return r.name === "json-key"
        ? m.replace(/:\s*"[^"]*"/, ': "[REDACTED]"')
        : `[REDACTED:${r.name}]`;
    });
  }
  return out;
}
