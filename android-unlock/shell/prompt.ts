// shell/prompt — הקלדה מוסתרת מ-TTY. IO.

export async function promptHidden(label: string): Promise<string> {
  process.stderr.write(label);
  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (b: boolean) => void };
  stdin.setRawMode?.(true);
  stdin.resume();
  let buf = "";
  for await (const chunk of stdin) {
    for (const ch of chunk.toString("utf8")) {
      if (ch === "\n" || ch === "\r") {
        stdin.setRawMode?.(false);
        stdin.pause();
        process.stderr.write("\n");
        return buf;
      } else if (ch === "\x7f" || ch === "\b") {
        buf = buf.slice(0, -1);
      } else if (ch === "\x03") {
        process.exit(130); // Ctrl-C
      } else {
        buf += ch;
      }
    }
  }
  stdin.setRawMode?.(false);
  return buf;
}
