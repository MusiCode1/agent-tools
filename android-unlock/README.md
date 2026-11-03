# android-unlock

הזנת **תבנית / PIN / סיסמה** למכשיר אנדרואיד מרוחק, כדי לבטל את ה-keyguard
בלי מגע פיזי ובלי לראות מסך. הקרדנציאל נשלף מביטוורדן ולעולם לא מודפס, לא
נכתב לקובץ, ו-`logcat` מנוקה אחרי כל שלב שהעמיד אותו בשורת-פקודה על המכשיר.

## למה זה עובד

מסך הזנת-הנעילה (keyguard bouncer) מסומן `FLAG_SECURE`, ולכן `screencap`/
scrcpy מחזירים שחור — אבל `FLAG_SECURE` חוסם לכידת-**פיקסלים**, לא את עץ
ה-**AccessibilityNodeInfo**. לכן:

- **תבנית:** `uiautomator dump` חושף את node רשת-התבנית עם ה-`bounds`;
  מהם נגזרות 9 הנקודות אריתמטית, והתבנית מוזרקת כמחווה רציפה
  (`input motionevent DOWN/MOVE…/UP`). עובד **גם בלי root**.
- **PIN / סיסמה:** `input text` + Enter על ה-bouncer.

`input` מזריק ב-InputDispatcher (מעל שכבת-החומרה), ולכן גם digitizer מת אינו
חוסם. אומת על חומרה אמיתית (CUBOT TAB KINGKONG 2, Android 14) שסינון-מגע-
obscured אינו חוסם את המסלול.

root נדרש **רק** ל-`verify` המקדים ול-`--remove-lock` — לא להזרקה עצמה.

## שימוש

```bash
# מכשיר רשום (קוד מביטוורדן, שום סוד בשורת-הפקודה):
android-unlock liam-tablet
# קוד ישיר — בלי ערך ⇒ הקלדה מוסתרת (לא נכנס ל-ps/היסטוריה):
android-unlock liam-tablet --pattern
# קוד ישיר עם ערך — לסקריפטים (⚠️ נראה ב-ps/היסטוריה):
android-unlock my-new-phone --ssh some-alias --pin 4721
android-unlock liam-tablet --dry-run        # recon בלבד
android-unlock liam-tablet --remove-lock    # 🛑 הסרת הנעילה לגמרי (דורש root)
```

**מקור הקרדנציאל, לפי סדר-עדיפות:** דגל ישיר עם ערך → דגל ישיר בלי ערך (הקלדה
מוסתרת) → ביטוורדן. כלומר ביטוורדן הוא רק נוחות למכשיר רשום; תמיד אפשר פשוט
להעביר את הקוד.

דגלים: `--pattern [VAL]` · `--pin [VAL]` · `--password [VAL]` · `--type {pattern,pin,password}`
· `--ssh ALIAS` · `--via {auto,root,rish,none}` · `--bw-item NAME` · `--no-verify`
· `--force` (גם בשיחה) · `--dry-run` · `--remove-lock`.

## רישום מכשירים — `devices.json`

לא-סודי: רק `ssh` alias, עטיפת-ההרצה (`via`), ושם-פריט-ביטוורדן. ברירות-מחדל:
‏`ssh`/`bw_item` = שם המכשיר, `via=auto` (מנסה `su -c id`, אחרת `$HOME/rish`,
אחרת shell רגיל).

## קרדנציאל — ישיר או מביטוורדן

פריט לכל מכשיר, עם אחד או יותר מהשדות המוסתרים:

| שדה | סוג |
|---|---|
| `screen-lock-pattern` | רצף ספרות 1–9 לפי מספור לוח-מקשים (`1`=שמאל-עליון) |
| `screen-lock-pin` | ספרות |
| `screen-lock-password` | טקסט |

הכלי דורש כספת **פתוחה** (`bw-mcp-cli status` = unlocked). אם נעולה — להריץ
`bw-mcp-unlock` בטרמינל (כלל 120), ואז שוב.

## בטיחות

- 🛑 **ניסיונות שגויים נספרים לעבר נעילת-ה-5.** לכן כשיש root הכלי מריץ
  `locksettings verify` מקדים ועוצר אם הקוד השמור שגוי. `--no-verify` מדלג.
- לא מזריק קלט כשיש **שיחה פעילה** (אלא עם `--force`).
- מאמת הצלחה ב-`isKeyguardShowing=false`, לא בהנחה.
- הקרדנציאל נשאר רק בזיכרון-התהליך ובביטוורדן.
