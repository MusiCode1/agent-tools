// core/bouncer — מתמטיקת רשת-התבנית ובניית סקריפטי-הזרקה. טהור.

export type Bounds = [number, number, number, number];

// resource-id של רשת-התבנית משתנה בין יצרנים — מתאימים לפי סיומת, לא שם קשיח.
const PATTERN_IDS = ["lockPatternView", "colorLockPatternView", "oplusos_kgd_security_pattern_view"];

/** מחלץ את גבולות רשת-התבנית מתוך פלט uiautomator dump. */
export function patternGridFromDump(xml: string): Bounds | null {
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const s = m[0];
    const rid = /resource-id="([^"]*)"/.exec(s)?.[1] ?? "";
    const desc = /content-desc="([^"]*)"/.exec(s)?.[1] ?? "";
    const hit = PATTERN_IDS.some((p) => rid.endsWith(p))
      || desc.toLowerCase().includes("pattern") || desc.includes("תבנית");
    if (hit) {
      const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(s);
      if (b) return [Number(b[1]), Number(b[2]), Number(b[3]), Number(b[4])];
    }
  }
  return null;
}

/** 9 מרכזי-התאים לפי מספור לוח-מקשים (1=שמאל-עליון). truncation כמו int() בפייתון. */
export function patternPoints(b: Bounds): Record<number, [number, number]> {
  const [L, T, R, B] = b;
  const w = (R - L) / 3, h = (B - T) / 3;
  const pts: Record<number, [number, number]> = {};
  for (let d = 1; d <= 9; d++) {
    const i = d - 1, c = i % 3, r = Math.floor(i / 3);
    pts[d] = [Math.trunc(L + (c + 0.5) * w), Math.trunc(T + (r + 0.5) * h)];
  }
  return pts;
}

export function parsePatternDigits(cred: string): number[] {
  return [...cred].filter((c) => c >= "1" && c <= "9").map(Number);
}

/** מחווה רציפה DOWN → MOVE… → UP דרך מרכזי-הנקודות. */
export function buildPatternGesture(points: Record<number, [number, number]>, digits: number[]): string[] {
  const lines: string[] = [];
  digits.forEach((d, k) => {
    const [x, y] = points[d];
    lines.push(`input motionevent ${k === 0 ? "DOWN" : "MOVE"} ${x} ${y}`);
    lines.push("sleep 0.08");
  });
  const [lx, ly] = points[digits[digits.length - 1]];
  lines.push(`input motionevent UP ${lx} ${ly}`);
  return lines;
}

/** הזנת PIN/סיסמה. input text מצריך %s לרווח. */
export function buildTextEntry(text: string): string[] {
  const esc = text.replace(/ /g, "%s");
  return [`input text '${esc}'`, "sleep 0.3", "input keyevent KEYCODE_ENTER"];
}

export function raiseBouncerScript(): string {
  return "input keyevent KEYCODE_WAKEUP\nsleep 0.5\ninput swipe 600 1600 600 500 150\nsleep 0.9\n";
}
