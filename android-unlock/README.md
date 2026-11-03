# android-unlock

הזנת **תבנית / PIN / סיסמה** למכשיר אנדרואיד מרוחק, כדי לבטל את ה-keyguard
בלי מגע פיזי ובלי לראות מסך. רץ על **Bun** (TypeScript, בלי שלב-build).

## למה זה עובד

מסך הזנת-הנעילה (keyguard bouncer) מסומן `FLAG_SECURE`, ולכן `screencap`/
scrcpy מחזירים שחור — אבל `FLAG_SECURE` חוסם לכידת-**פיקסלים**, לא את עץ
ה-**AccessibilityNodeInfo**:

- **תבנית:** `uiautomator dump` חושף את node רשת-התבנית עם ה-`bounds`;
  מהם נגזרות 9 הנקודות אריתמטית, והתבנית מוזרקת כמחווה רציפה
  (`input motionevent DOWN/MOVE…/UP`). עובד **גם בלי root**.
- **PIN / סיסמה:** `input text` + Enter על ה-bouncer.

אומת על חומרה אמיתית (CUBOT TAB KINGKONG 2, Android 14) שסינון-מגע-obscured
אינו חוסם. root נדרש **רק** ל-`verify` המקדים ול-`--remove-lock`, לא להזרקה.

## מבנה — Functional Core / Imperative Shell

לפי `learn-games-project/docs/functional-programming.md`:

```
core/    פונקציות טהורות, אפס IO — bounds→נקודות, בניית סקריפטים, פרסור פלט,
         בחירת סוג-קרדנציאל, בניית argv-תעבורה. ניתן לבדיקת-יחידה בלי מכשיר.
shell/   imperative: Bun.spawn (ssh/adb), bw-mcp-cli, הקלדה-מוסתרת.
android-unlock.ts  entry — מתזמר: ה-shell קורא ל-core ומריץ על המכשיר.
```

בדיקות: `bun test` (על `core/`, בלי מכשיר).

## שימוש

```bash
bun android-unlock.ts liam-tablet           # קוד מביטוורדן, שום סוד בשורת-הפקודה
bun android-unlock.ts liam-tablet --pattern # קוד ישיר, הקלדה מוסתרת
bun android-unlock.ts dev --ssh alias --pin 4721   # ישיר (⚠️ נראה ב-ps/היסטוריה)
bun android-unlock.ts liam-tablet --dry-run        # recon בלבד
bun android-unlock.ts liam-tablet --transport adb  # תעבורת ADB במקום SSH
bun android-unlock.ts liam-tablet --remove-lock    # 🛑 הסרת נעילה (דורש root)
```

**מקור הקרדנציאל, לפי עדיפות:** דגל ישיר עם ערך → דגל ישיר בלי ערך (הקלדה
מוסתרת) → ביטוורדן. ביטוורדן הוא נוחות למכשיר רשום; תמיד אפשר פשוט להעביר קוד.

דגלים: `--type {pattern,pin,password}` · `--pattern/--pin/--password [VAL]` ·
`--ssh` · `--via {auto,root,rish,none}` · `--transport {ssh,adb}` · `--bw-item` ·
`--no-verify` · `--force` · `--dry-run` · `--remove-lock`.

## תעבורה — SSH ו-ADB

| transport | argv |
|---|---|
| `ssh` | `ssh <alias> "<wrap> sh"` |
| `adb` ישיר | `adb -s <serial> shell "<wrap> sh"` |
| `adb` דרך מארח | `ssh <sshHost> "[pct exec <ct> --] adb -s <serial> shell <wrap> sh"` |

‏`<wrap>` = `su -c` / `$HOME/rish -c` / כלום, לפי `via` (או זיהוי-אוטומטי).

🛑 **ל-liam-tablet ברירת-המחדל SSH.** ה-ADB שלו אינו `persist.` (הפורט נעלם
בכל אתחול) וה-IP דינמי (DHCP) — מסלול ה-`adb` ב-`devices.json` הוא **תבנית**:
לרענן את `serial` ל-IP החי (`ssh liam-tablet 'su -c "ip -4 addr show wlan0"'`)
ולהפעיל adbd לפני שימוש. SSH-מעל-Termux הוא הערוץ הקבוע.

## רישום מכשירים — `devices.json`

לא-סודי: `transport`, `ssh`/`adb`, `via`, `bw_item`. ברירות-מחדל: `ssh`/`bw_item`
= שם המכשיר, `transport=ssh`, `via=auto`.

## קרדנציאל — בביטוורדן או ישיר

פריט לכל מכשיר, שדות מוסתרים: `screen-lock-pattern` (רצף ספרות 1–9 לפי
מספור לוח-מקשים) · `screen-lock-pin` · `screen-lock-password`. מסלול ביטוורדן
דורש כספת פתוחה; אם נעולה — `bw-mcp-unlock` בטרמינל (כלל 120), או קוד ישיר.

## בטיחות

- 🛑 ניסיונות שגויים נספרים לעבר נעילת-ה-5. עם root הכלי מריץ `locksettings
  verify` מקדים ועוצר אם הקוד שגוי. `--no-verify` מדלג.
- לא מזריק בשיחה פעילה (אלא `--force`).
- מאמת הצלחה ב-`isKeyguardShowing=false`, לא בהנחה.
- הקוד לא מודפס/נכתב, ו-`logcat` מנוקה אחרי כל שלב שהעמיד אותו בשורת-פקודה.
