# android-unlock — פרויקטים אחרים עם אותו רעיון (prior art)

נבדק 2026-11-03. מטרת המסמך: למפות כלים קיימים שפותחים מכשיר אנדרואיד עם
קרדנציאל **ידוע** (תבנית/PIN/סיסמה), כדי להחליט אם שווה לפרסם חבילה ציבורית
או שזו כפילות. המסקנה הקצרה: **הרעיון המרכזי כבר פורסם** — ראו "הערכה" למטה.

## מקבילות ישירות — פתיחה עם סוד ידוע דרך ADB

| פרויקט | צורה | מכסה | שיטה | הערות |
|---|---|---|---|---|
| [@wilsonbeam/openclaw-adb-mcp](https://glama.ai/mcp/servers/wilsonbeam/openclaw-adb-mcp/tools/adb_unlock) | שרת MCP (TS), ב-npm | תבנית + PIN + סיסמה + swipe | ADB; תבנית כמחרוזת 0–8; בחירת device-id | **הכי קרוב פונקציונלית.** צורת MCP לסוכני-AI, לא CLI |
| [mattwilson1024/android-pattern-unlock](https://github.com/mattwilson1024/android-pattern-unlock) | סקריפט bash | תבנית בלבד | ADB; `input`/`sendevent`; **קואורדינטות קשיחות** (ידני לפי רזולוציה); בלי root | הבסיס הקלאסי שכולם מצטטים |
| [ferrarimarco/android-pattern-unlock](https://github.com/ferrarimarco/android-pattern-unlock) | סקריפט bash | תבנית בלבד | כנ"ל | וריאנט/פורק של mattwilson |
| [DouglasFreshHabian/UnlockAndroid](https://github.com/DouglasFreshHabian/UnlockAndroid) | מתודולוגיה/סקריפטים | תבנית/PIN | ADB | אוסף שיטות, לא כלי ארוז |
| [gist vrunoa](https://gist.github.com/vrunoa/97808a8e2dcf55d1efaa38fd6344f45f) | gist | תבנית | ADB input | דוגמה קצרה |
| [android-unlock (xudafeng)](https://www.npmjs.com/package/android-unlock) | npm 0.1.2 | — | — | הריפו 404 (נטוש), תיאור סתמי. **תופס את השם ב-npm** |

## רמת-framework — פתיחה כחלק מאוטומציית-בדיקות

| פרויקט | מכסה | שיטה |
|---|---|---|
| [Appium UiAutomator2 / Espresso — Unlock](https://appium.github.io/appium-espresso-driver/latest/guides/unlock/) | PIN/password/pattern/fingerprint | שתי אסטרטגיות: `locksettings` (ברירת-מחדל מאז A8, `adb shell locksettings`) או `uiautomator` (legacy) |
| [WebdriverIO — unlock](https://webdriver.io/docs/api/mobile/unlock) | PIN/password/pattern | אותן אסטרטגיות (`locksettings`/`uiautomator`) |

## לא רלוונטי (רעיון אחר)

- [maxwroc/vanilla-pattern-lock](https://github.com/maxwroc/vanilla-pattern-lock) — ווידג'ט UI לציור תבנית בדפדפן (כמו ה-`PatternLock` שלנו ב-secret-drill), **לא** פתיחת מכשיר.
- ערכות מסחריות (DroidKit, iMyFone, iToolab) — **מסירות/מאפסות** נעילה (לרוב עם מחיקת-נתונים), לא מזריקות סוד ידוע.
- `gesture.key`/מחיקת-קובץ — מיושן, לא עובד מ-Android 9+.

## הערכה — מה ייחודי אצלנו, ומה לא

🛑 **הרעיון המרכזי (פתיחת מכשיר עם תבנית/PIN/סיסמה ידועים דרך ADB) אינו חדש.**
‏`openclaw-adb-mcp` מכסה את כל סוגי-הנעילה; mattwilson/ferrarimarco מכסים תבנית;
ו-Appium/WebdriverIO מכסים את זה ברמת-framework עם `locksettings`.

**מה שלא ראיתי אצל אף אחד מהם** (היתרון האינקרמנטלי שלנו):

1. **קואורדינטות דינמיות מ-`uiautomator dump`** — נגזרות מ-`bounds` של node רשת-התבנית
   בזמן-ריצה, ולכן עובד בכל רזולוציה ובכל OEM (ה-resource-id משתנה: `lockPatternView`
   סטוק מול `colorLockPatternView` ב-OneUI/OxygenOS). mattwilson קשיח-קואורדינטות;
   openclaw אינו מתעד גזירה דינמית.
2. **תעבורת SSH** (Termux/WireGuard) לצד ADB — כל האחרים ADB-only. אצלנו מכשיר מרוחק
   בלי LAN משותף עדיין נגיש.
3. **שער-בטיחות `locksettings verify` לפני הזרקה** (מניעת ספירה לעבר נעילת-ה-5),
   ואי-הזרקה בשיחה פעילה.
4. צורת **npx CLI** עצמאית (מול MCP / bash), עם מקור-קרדנציאל (ביטוורדן/הקלדה-מוסתרת).

⚠️ **אבל אלה שיפורים הדרגתיים, לא רעיון חדש.**

## החלטה (פתוחה)

- פרסום חבילה ציבורית = **ברובו כפילות** ⇒ ברירת-המחדל: להשאיר ככלי פנימי ב-`agent-tools`.
- אם בכל זאת מפרסמים — למצב סביב הייחוד (קואורדינטות דינמיות + SSH), לא כ"עוד adb-unlock".
- שם ב-npm: `android-unlock` תפוס; `adb-unlock` פנוי (מועמד). טרם הוכרע.
- חלופה: לתרום את הייחוד upstream (PR ל-openclaw-adb-mcp / mattwilson) במקום חבילה מתחרה.

## שיטת החיפוש

‏npm view · ‏GitHub · WebSearch (2026-11-03). חיפושים: "adb unlock pattern CLI",
"android unlock known pattern no root", "locksettings pattern pin uiautomator npm".
ייתכנו כלים נוספים שלא עלו; זהו מיפוי סביר, לא ממצה.
