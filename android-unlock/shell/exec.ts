// shell/exec — התעבורה החיה. קורא ל-core לבניית ה-argv, מריץ ב-Bun.spawnSync.
import { buildAdbConnect, buildInvocation, chooseWrap, type DeviceProfile, type Transport, type Via } from "../core/transport";

export class Device {
  wrap = "";
  private _root = false;

  constructor(
    public name: string,
    public profile: DeviceProfile,
    private transportOverride?: Transport,
  ) {}

  get root(): boolean {
    return this._root;
  }

  private spawn(argv: string[], script: string): string {
    const p = Bun.spawnSync(argv, {
      stdin: new TextEncoder().encode(script),
      stdout: "pipe",
      stderr: "pipe",
    });
    return (p.stdout?.toString() ?? "") + (p.stderr?.toString() ?? "");
  }

  /** מריץ סקריפט בעטיפה מפורשת. */
  runWith(wrap: string, script: string): string {
    const argv = buildInvocation(this.name, this.profile, wrap, this.transportOverride);
    return this.spawn(argv, script);
  }

  /** מריץ בעטיפה שנקבעה ב-detect (או root מפורש). */
  sh(script: string, opts?: { asRoot?: boolean }): string {
    return this.runWith(opts?.asRoot ? "su -c" : this.wrap, script);
  }

  detect(): void {
    const conn = buildAdbConnect(this.profile, this.transportOverride);
    if (conn) Bun.spawnSync(conn, { stdout: "pipe", stderr: "pipe" });
    const out = this.runWith(
      "",
      "su -c id 2>/dev/null\ntest -x $HOME/rish && echo RISH=yes || echo RISH=no\n",
    );
    this._root = /uid=0/.test(out);
    const rish = /RISH=yes/.test(out);
    const via = (this.profile.via ?? "auto") as Via;
    if (via === "root" && !this._root) throw new Error(`${this.name}: via=root אך אין גישת root`);
    this.wrap = chooseWrap({ root: this._root, rish }, via);
  }

  cleanLogcat(): void {
    try {
      this.sh("logcat -c\n", { asRoot: this.root });
    } catch {
      /* best-effort */
    }
  }
}
