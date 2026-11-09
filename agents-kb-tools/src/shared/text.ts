/** Match Python's Unicode code-point lengths and locale-independent ordering. */
export function charLength(text: string): number { return [...text].length; }

export function compareCodePoints(a: string, b: string): number {
  const aa = [...a], bb = [...b];
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    const difference = aa[i].codePointAt(0)! - bb[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return aa.length - bb.length;
}
