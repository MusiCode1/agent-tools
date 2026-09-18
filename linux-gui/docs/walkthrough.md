# Walkthrough

## 2026-09-03 10:42

### רשימת יישומים בתפריט קליק־ימני

`xfce4-appfinder` (וגם rofi עם אייקונים) קורסים בקונטיינר: glycin+bwrap לא טוענים PNG/SVG. במקום זה — תפריט טקסט של Openbox מקבצי `.desktop`.

#### מה בוצע?

- סקריפט `/usr/local/bin/linux-gui-apps-menu` (pipe menu).
- בתפריט קליק־ימני: **Applications**.

## 2026-09-03 10:40

### שורת משימות tint2 על Openbox

נוספה שורת משימות קלה כדי שאפשר יהיה להחזיר חלון ממוזער בלחיצה, בלי להחזיר את `xfce4-panel`.

#### מה בוצע?

- הותקן `tint2` (חבילה אחת, ~1.5MB) בתמונה ובקונטיינר החי.
- נוספה תצורת פאנל תחתונה (כפתורי חלונות + מגש + שעון) ב־`config/desktop/tint2rc`.
- `startwm.sh` מעתיק את התצורה ל־`/config` ומריץ `tint2` אחרי עליית Openbox.

#### מעקפים ופתרונות

- **לא xfce4-panel**: לולאת קריסה אחרי XRandR של Selkies (מסך שחור, 2026-07-17). tint2 לא מנהל תצוגה.

## 2026-07-18 00:25

### מעבר ל־Cloudflare Access כשכבת האימות היחידה

הוסר Basic Auth של Webtop לאחר אימות גבולות החשיפה של השירות.

#### מה בוצע?

- אומת שהקונטיינר מפרסם את Webtop רק על `127.0.0.1:6081` וש־CDP אינו מפורסם.
- אומת שבקשה ציבורית לא־מאומתת אל `desktop.example.com` מופנית ל־Cloudflare Access.
- הוסרו `CUSTOM_USER` ו־`PASSWORD` מתצורת Compose ומשתני האימות מ־`.env.example`.
- עודכנו README, מודל האבטחה וה־Skill המקומי כך שישקפו אימות יחיד דרך Cloudflare Access.

#### החלטות ארכיטקטורה

- **Cloudflare Access כאימות יחיד**: Basic Auth המובנה של Webtop הוסר כדי למנוע login כפול. ההחלטה נשענת על loopback-only, מנהרת Cloudflare, מדיניות Access מוגבלת ו־JWT validation ב־ingress.

#### מעקפים ופתרונות

- **אין שכבת סיסמה משנית**: כל שינוי עתידי ב־Access, DNS, ingress או port binding מחייב בדיקה מחדש של redirect לא־מאומת ושל ההאזנה על loopback בלבד.

## 2026-07-18 00:20

### הקשחת גבולות הקומיט הראשון

בוצע אודיט לקבצים המתוכננים לקומיט ולמצב המתמיד שנשאר מחוץ לריפו.

#### מה בוצע?

- אומת ש־`.env` אינו במעקב וש־`.env.example` מכיל ערכי דוגמה בלבד.
- אומת שפרופילי Chrome, פרויקטי דפדפן, הורדות, artifacts ו־runtime אינם חלק מקוד המקור.
- הורחב `.gitignore` עבור קובצי `.env.*`, תוצרי Playwright, לוגים, core dumps וקובצי dump.
- בוצעה סריקת דפוסי secrets לפני staging; לא נמצאו credentials בקבצי המקור.

#### החלטות ארכיטקטורה

- **מידע מתמיד מחוץ לריפו**: זהויות דפדפן ונתוני משתמש נשארים תחת `~/.local/share/linux-gui` ומוזרקים דרך `.env`; בריפו נשמרת רק תבנית `.env.example`.

## 2026-07-18 00:05

### Skill מקומי לתפעול Linux GUI

נוסף Skill ניתן לגילוי שמרכז את נוהל העבודה הבטוח עם סביבת ה־GUI המתמידה.

#### מה בוצע?

- נוספו הוראות להפעלה, בדיקת בריאות, עבודה עם פרופילי Chrome, login ידני, CDP וחיבור Playwright.
- תועדו נתיבי ההתמדה, כללי הטיפול ב־credentials וגבולות האבטחה של הקונטיינר.
- תועדה תמיכת Docker כ־runtime הנוכחי והפערים שיש לסגור לפני הכרזה על תאימות Podman.
- `AGENTS.md` וה־README מפנים כעת ל־Skill המקומי.

#### החלטות ארכיטקטורה

- **Skill פרויקטלי תחת `.agents/skills`**: ההוראות נשמרות יחד עם הפרויקט וניתנות לגילוי אוטומטי על ידי סוכנים שעובדים ממנו.
- **Podman אינו מסומן כנתמך עדיין**: קובצי Compose קרובים לתאימות, אך הסקריפטים והבדיקות תלויים ישירות בפקודות Docker ולא עברו smoke test ב־Podman.

## 2026-07-17 19:51

### תיעוד API ה־AJAX של Moodle

תועד מסלול הקריאה המאומת שבו משתמש ממשק Moodle המחובר.

#### מה בוצע?

- תועד הקשר בין `lib/ajax/service.php` לבין שכבת ה־External functions הרשמית של Moodle.
- נוספה השוואה בין AJAX מבוסס session ו־`sesskey` לבין REST מבוסס Web Service token.
- נוספה דוגמת קריאה בטוחה לפונקציה שאומתה מול אתר Moodle והנחיות שלא לשמור credentials.
- נוסף קישור למסמך מתוך README.

#### החלטות ארכיטקטורה

- **אוטומציית Moodle דרך הקשר הדפדפן**: קריאות AJAX יתבצעו בתוך הדפדפן המחובר, כך שה־`sesskey` נקרא בזמן אמת ונשאר בזיכרון; אינטגרציה עצמאית ועמידה תדרוש טוקן Web Service רשמי.

## 2026-07-17 18:34

### קיצור דרך קבוע ל־Chrome עם CDP

נוסף קיצור דרך ראשי לדפדפן שמיועד לשימוש ידני ותכנותי באותו פרופיל מתמיד.

#### מה בוצע?

- פעולת `Google Chrome (CDP)` בתפריט Openbox מפעילה את הפרופיל הקבוע `user` במצב CDP.
- תיקיית ה־user data היא `/data/browser-profiles/user`, מחוץ לנתיב ברירת המחדל של Chrome ובאחסון המתמיד.
- פורט CDP נבחר מטווח הלולאה המקומי ונרשם בקובץ runtime; החיבור התכנותי נעשה דרך `./scripts/linux-gui browser attach user`.

#### מעקפים ופתרונות

- **מניעת שימוש כפול בפרופיל**: קיצור הדרך משתמש ב־launcher הקיים, שבודק נעילות ותהליך חי לפני פתיחת Chrome נוסף על אותה תיקיית user data.

## 2026-07-17 18:31

### תיקון הפעלת מנהל הקבצים

הוחלף מנהל הקבצים שמופעל מתפריט Openbox.

#### מה בוצע?

- נוסף Xfe לתמונת הקונטיינר ופעולת `Files` מפעילה אותו ישירות בתיקיית ההורדות המתמידה.
- עודכן תיעוד הארכיטקטורה כך שישקף את מנהל הקבצים הפעיל.

#### מעקפים ופתרונות

- **Thunar קרס בזמן טעינת אייקוני GTK**: תהליך ה־sandbox של `glycin` דרך `bwrap` נכשל בתוך הקונטיינר וגרם ל־GTK לבצע abort. Xfe אינו תלוי במסלול הטעינה הזה ולכן נבחר כתחליף ממוקד בלי להחליש sandbox נוסף.

## 2026-07-17 18:30

### תפריט יישומים שימושי ל־Openbox

נוסף תפריט קליק־ימני מפורש במקום תפריט ברירת המחדל הדל של Openbox.

#### מה בוצע?

- נוספו פעולות להפעלת Google Chrome עם פרופיל `desktop` מתמיד, מנהל הקבצים Thunar וטרמינל XFCE.
- קובץ התפריט מותקן מחדש בעת עליית הקונטיינר כדי שהתצורה תהיה עקבית גם אחרי recreation.
- נוספה פעולה לרענון תצורת Openbox.

#### מעקפים ופתרונות

- **תפריט ברירת המחדל הציג xterm בלבד**: הוחלף בתפריט מצומצם ומפורש שאינו תלוי בזיהוי אוטומטי של קובצי desktop בתוך הקונטיינר.

## 2026-07-17

### תיקון המסך השחור

- אותרה לולאת קריסה של `xfce4-session`, `xfce4-panel` ו־`xfdesktop` לאחר שינויי XRandR של Selkies; הלולאה מיצתה את חיבורי X והשאירה מסך שחור.
- הוחלף מנהל הסשן ב־Openbox היציב שכבר כלול בתמונה, עם טרמינל מוגדל בעלייה ותפריט קליק ימני להפעלת יישומים.
- נשמרו Webtop, ההזרמה, מנהל הקבצים, Chrome וכל תיקיות הפרופילים והמידע המתמיד ללא שינוי.

## 2026-07-17

### גישה מרחוק דרך Cloudflare Access

- נוצרה אפליקציית Access מסוג self-hosted עבור `desktop.example.com`, עם מדיניות Allow המוגבלת לחשבון המורשה.
- נוסף CNAME מפוקסר ליעד של מנהרת `home` הקיימת.
- נוסף נתיב ingress מרוחק אל Webtop ב־`https://127.0.0.1:6081`, לפני כלל ה־404 הקיים וללא שינוי הנתיבים הקודמים.
- הופעלה בדיקת Access JWT גם ב־cloudflared, בנוסף למסך ההזדהות של Access ול־Basic Auth של Webtop.
- אומת שהכתובת הציבורית מחזירה הפניה ל־Cloudflare Access ושהמנהרה פעילה.
- פרטי ה־OAuth רחבי ההרשאה של Cloudflare CLI נותקו ונמחקו מהקונטיינר לאחר ההקמה.

## 2026-07-17 16:02

### Initial persistent GUI environment

Created the first implementation of the standalone Linux GUI project.

#### What was done?

**1. Container infrastructure**

- Added a LinuxServer Webtop-based image with Chrome, Node.js, and Playwright CLI.
- Added local-only HTTPS exposure and explicit persistent host directories.

**2. Browser profile lifecycle**

- Added named profile creation, cold cloning, manual login mode, CDP mode, and clean shutdown.
- Added runtime isolation and duplicate-open protection.

**3. Project operations**

- Added management commands, smoke verification, security documentation, and repository guidance.

**4. Runtime verification**

- Verified the image build, local HTTPS endpoint, healthcheck, Chrome 150, and Playwright CLI 0.1.17.
- Chrome's namespace sandbox was initially rejected by Docker's built-in seccomp profile.
- Verified manual and CDP profile modes, duplicate-open protection, cold cloning, Playwright attachment, screenshot capture, and persistence across container restart.

#### Workarounds and solutions

- Port 6080 was already occupied during development, so runtime verification uses an `.env` override on port 6081 without changing the documented default.
- A disposable diagnostic container confirmed that removing the Docker seccomp filter gets past the namespace failure.
- The user approved `seccomp=unconfined` for this service after reviewing its purpose and reduced Docker-level isolation. Chrome's internal sandbox remains enabled.
- Added safe cleanup of stale Chrome singleton locks after container recreation, guarded by a live-process check for the exact profile.
- Added an initialization hook so the unprivileged GUI user owns Playwright's persistent cache directories.
