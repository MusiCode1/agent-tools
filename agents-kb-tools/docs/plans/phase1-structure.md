# Brief — Phase 1: מבנה, אינדקס-מיוצר, ו-git

**סוג מסמך:** בריף ביצועי לסלייס
**אימות אביגיל:** READY (סבב #2, 2026-07-24 — כל הטענות אומתו, שני התיקונים אושרו, אין blockers)

**slice:** `phase1-structure`
**depends_on:** [] (שלב ראשון, אין תלויות)
**base:** greenfield — המאגר עדיין לא ב-git; C1 מאתחל git, C2–C5 על ענף `slice/phase1-structure`
**סטטוס:** הושלם — כל 5 ה-commits (C1–C5) בוצעו על `slice/phase1-structure` (בסיס: `main`@`2626b60`). ראה `docs/walkthrough.md`. ממתין ל-calev (light) ואז למרדכי למיזוג.

---

## 1. מטרה

להפוך את `agents-config` ממאגר לא-מנוהל ומפוזר למאגר מסודר תחת git, עם:
- הפרדת workflows לתת-תיקיות לפי ז'אנר (runbooks / diagnostics)
- תיוג כפול (תיקייה = ז'אנר גס; frontmatter tags = חיתוך עדין מבוקר)
- סקריפט שמ**ייצר קובץ אינדקס** (במקום להדפיס למסך)
- git pre-commit hook ששומר שהאינדקס לעולם לא מתיישן
- README שמתאר את המבנה הממומש

**מפורש מחוץ להיקף (Phase 2, דחוי):** חיווט האינדקס לתוך הקונטקסט של סוכנים; הגירת/סנכרון קונפיגורציות מ-CLI-ים (`.claude`, `.codex`, `.qoder`, `.config/opencode`, `.gemini`); גרסת JSON של האינדקס היא nice-to-have, לא חובה.

---

## 2. מצב קיים (עובדות מאומתות)

- המאגר `/home/user/Projects/agents-config` **אינו** git repo (`git rev-parse` מחזיר NO-GIT-YET).
- תוכן: `README.md`, `list-workflows.py` (בר-הרצה), `workflows/` עם **7** קבצי `.md`.
- כל 7 הקבצים כוללים frontmatter YAML תקין עם `name`, `description`, `tags`. אין קובץ ללא frontmatter.
- `list-workflows.py` היום קורא **רק** את ה-frontmatter (עוצר ב-`---` השני), תומך ב-`--json` ו-`--names`, ומדפיס ל-stdout. אינו יוצר קובץ.

### סיווג 7 הקבצים לז'אנר
**runbooks** (מדריך-ביצוע לינארי):
- `renew-cloudflare-access-token`
- `ssh-to-hypervisor-via-cloudflared`
- `drive-linux-gui-browser`
- `bitwarden-secret-via-mcp-session`
- `run-claude-and-project-a-on-termux`

**diagnostics** (עץ-החלטה / בידוד-תקלה):
- `diagnose-cloudflare-endpoint-health`
- `diagnose-raw-disk-readonly`

---

## 3. אוצר-מילים מבוקר לתגיות (צירים)

כל קובץ נשאר עם `tags:`, אך מנורמל לצירים. מוסיפים שדה `kind:` נפרד ל-frontmatter.

- `kind:` — `runbook` | `diagnostic` (חובה, יחיד; תואם לתת-תיקייה)
- `domain:` — `cloudflare` | `hypervisor` | `disk` | `bitwarden` | `browser` | `mobile` (התחום העסקי)
- `env:` — `linux-gui` | `termux` | `vm` | `hypervisor-host` (איפה זה רץ)
- `tool:` — כלים קונקרטיים (`cloudflared`, `playwright`, `bw-mcp-cli`, `lsblk`, `blkid`, `ssh`, `bun`)

הערה: `tags` הקיים נשמר לתאימות-לאחור של הסקריפט; הצירים החדשים הם שדות frontmatter נוספים. אין למחוק מידע קיים.

---

## 4. Commits (עם testing strategy לכל אחד)

### C1 — git init + baseline
- `git init`, הוספת `.gitignore` בסיסי (Python `__pycache__`, וכו').
- commit של המצב הקיים **כפי שהוא**, לפני כל שינוי מבני. זה קו-הבסיס לגיבוי.
  הקומיט כולל את כל הקבצים הקיימים במאגר כרגע: `README.md`, `list-workflows.py`,
  7 קבצי `workflows/*.md`, ה-brief תחת `docs/plans/`, וה-`.gitignore` החדש.
- **testing:** manual — `git ls-files` מראה שכל הקבצים לעיל tracked; `git status` נקי (אין untracked).
  לא לקבע מספר קבוע — לוודא נוכחות של 7 ה-workflows + הסקריפט + README, לא ספירה מדויקת.

### C2 — restructure workflows
- יצירת `workflows/runbooks/` ו-`workflows/diagnostics/`.
- `git mv` של 5 קבצי runbook ו-2 קבצי diagnostic לתיקיות המתאימות (להשתמש ב-`git mv` כדי לשמר היסטוריה).
- הוספת `kind:`, `domain:`, `env:`, `tool:` ל-frontmatter של כל קובץ לפי §3. לא למחוק `tags` קיים.
- **testing:** manual — `find workflows -name '*.md'` מראה 5+2 במקומות הנכונים.

### C3 — index generator
- שכתוב `list-workflows.py` כך ש:
  - סורק **רקורסיבית** את `workflows/**/*.md` (כולל תת-תיקיות).
  - **מחריג את קובץ האינדקס עצמו** מהסריקה: לדלג במפורש על כל קובץ בשם `INDEX.md`
    (הגנה חזקה ללא תלות במיקום). **בנוסף**, קובץ ללא frontmatter תקין → לדלג עליו
    עם אזהרה ל-stderr, ולא ליצור רשומת-זבל מ-`md.stem`. שתי ההגנות יחד.
  - קורא **רק** frontmatter (כמו היום — עוצר ב-`---` השני).
  - **כותב קובץ** `workflows/INDEX.md` (markdown; שם + description + kind + tags + נתיב יחסי לכל קובץ), במקום להדפיס ל-stdout.
  - שומר על `--json`/`--names` כאופציות (json יכול להישאר stdout).
  - idempotent: הרצה חוזרת ללא שינוי בקבצים → אין diff ב-INDEX.md, וה-INDEX **אינו** מכיל רשומה לעצמו.
- **testing:** manual — הרצת הסקריפט פעמיים ברצף; ה-diff השני ריק; **מספר הרשומות = 7** (לא 8),
  ואף רשומה אינה מצביעה על `INDEX.md` (בדיקה לפי רשימת הנתיבים היחסיים, לא לפי `grep INDEX` שברירי).

### C4 — pre-commit hook
- `.git/hooks/pre-commit` (וגם עותק בר-מעקב, למשל `hooks/pre-commit`, כי `.git/hooks` לא נכנס ל-git) שמריץ את מחולל האינדקס ו-`git add workflows/INDEX.md`.
- הוראת התקנה קצרה ב-README (symlink/copy מ-`hooks/` ל-`.git/hooks/`).
- **testing:** manual — שינוי description בקובץ, `git commit`, ואז לוודא ש-INDEX.md התעדכן ונכלל ב-commit.

### C5 — README
- שכתוב שמתאר את המבנה הממומש: תת-תיקיות, ה-INDEX המיוצר, ה-hook, אוצר-המילים.
- סעיף "Phase 2 (deferred)": הזרקת-קונטקסט + הגירת CLI configs.
- **testing:** none (docs).

---

## 5. Complexity score

**4 / 10** — reorg + סקריפט פשוט + hook. אין לוגיקה מורכבת, אין תלויות חיצוניות חדשות (Python stdlib + yaml שכבר בשימוש). → verifier: `calev` (light), לא heavy.

---

## 6. Symbols/claims שאביגיל צריכה לאמת מול המציאות

- המאגר אינו git repo כרגע.
- קיימים בדיוק 7 קבצי `.md` ב-`workflows/`, כולם עם frontmatter (`name`/`description`/`tags`).
- `list-workflows.py` קורא רק frontmatter ותומך ב-`--json`/`--names`.
- הסיווג ל-runbook (5) מול diagnostic (2) נכון לפי תוכן הקבצים.
- אין תלות ב-CLI כלשהו בהיקף הזה (מפורש מחוץ להיקף).

## 7. היסטוריית אימות אביגיל

### סבב #1 — USABLE-AFTER-FIX (תוקן)
- **F1 (idempotency):** C3 עודכן — מחולל האינדקס מחריג `INDEX.md` מהסריקה ומדלג על
  קבצים ללא frontmatter; ה-testing מוודא 7 רשומות ואי-הכללה עצמית.
- **F2 (ספירת קבצים):** C1 עודכן — הבדיקה בודקת נוכחות (`git ls-files`) במקום מספר קבוע.

### סבב #2 — **READY** ✅
- שני התיקונים אושרו כשלמים, ללא regression חדש.
- הערה ירוקה יחידה (בדיקת `grep INDEX` שברירית) תוקנה: הבדיקה עכשיו לפי מספר רשומות = 7
  ורשימת נתיבים יחסיים, לא grep.
- **verdict סופי: READY** — מוכן ל-dispatch.
