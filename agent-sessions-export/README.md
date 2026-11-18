# agent-sessions-export

מייצא סשני סוכנים מארכיון [cass](https://github.com/Dicklesworthstone/coding_agent_session_search)
לריפו דאטה, בפורמט שניתן לאינדוקס ולקריאה בלי cass.

## למה

1. **עמידות** — קלוד קוד מוחק תמלילי סשנים אחרי `cleanupPeriodDays` (ברירת מחדל 30 יום).
   נמדד ב-myhost: 1,151 מתוך 1,680 שיחות כבר לא קיימות כקבצים.
2. **חיפוש בעברית** — `cass search` מחזירה אפס תוצאות על שאילתה בעברית
   (הטוקנייזר הוא `porter`, סטמר אנגלי). recoll מאנדקס את ה-`.md` המיוצא ומוצא.
3. **פורמט פתוח** — markdown + JSON, לא DB בינארי שעלול להישבר.

## הרצה

```bash
bun export.ts            # ריצה יבשה — מדפיסה פירוט, לא כותבת
bun export.ts --apply    # כותב
```

append-only: סשן שכבר יוצא לא נכתב מחדש.

## קונפיג

`~/.config/agent-sessions/config.json` — ראה `config.example.json`.
עובדות המכונה (`project_roots`, `resolve_symlinks`) והניתוב בין ריפואים יושבים שם,
כי הם חוצים ריפואים. `paths` (אליאסים של פרויקטים) יושב בכל ריפו דאטה בנפרד,
תחת `data/<machine>/config.json`.

## מבנה היעד

```
<repo>/data/<machine>/
├── config.json
├── index.jsonl
├── sessions/<project>/<agent>/<id>.md     ← recoll מאנדקס
└── meta/<project>/<agent>/<id>.json       ← מטא-דאטה מלאה, מחוץ לאינדקס
```

## Redaction

`redact.ts` מסתיר סודות **לפני** הכתיבה, בשני המקורות. הרקע: הניתוב לריפואים
הוא לפי **נתיב**, לא לפי תוכן — סוד שנשפך לסשן ב-`project-a` יגיע ל-`technical`
בלי עצירה, וגיט לא שוכח.

12 כללים: `crsr_` · `sk-` / `sk-ant-` · `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` ·
`AIza` · `xox[baprs]-` · `AKIA` · `hf_` · `Bearer <token>` · בלוקי PEM ·
ושדות JSON (`apiKey`, `access_token`, `secret`, `password`, `passphrase`).

הפלט שומר את **סוג** הסוד ולא את הערך: `[REDACTED:github]`.

## סולם גזירת התווית

1. `paths` בקונפיג הריפו — תחילית ארוכה ביותר
2. שורש מ-`project_roots` — הסגמנט הראשון תחתיו
3. תחת `$HOME` → `home`
4. סגמנט הנתיב הראשון

נתיב חדש נרשם אוטומטית ב-`paths` (רק בשלב 2 — דליים גנריים לא נרשמים,
אחרת `/home/user` בולע כתחילית את כל מה שתחתיו).

## סנכרון בין מכונות — `sessions_sync.py`

לכל מכונה יש מסד חיפוש משלה. ‏`sessions_sync.py` מעביר ביניהן שורות באופן מצטבר.
כל מכונה שולחת רק שורות של עצמה (`sessions.machine`), שחדשות מהסמן על
`messages.updated_at` של המקור. כך שורות לא חוזרות למכונה ששלחה אותן.

```bash
python3 sessions_sync.py export --since <ms>     # ‏-1: הכל, כולל שורות בלי updated_at
python3 sessions_sync.py import < stream         # מסכם ב־JSON
python3 sessions_sync.py run [--peer NAME]       # לפי ~/.config/agent-sessions/sync.json
python3 sessions_sync.py serve                   # ל־command= ב־authorized_keys
```

`sync.json`:

```json
{"peers": [
  {"name": "other", "machine": "<machine name there>", "direction": "both",
   "ssh": ["ssh", "-i", "<key>", "-o", "BatchMode=yes", "-C", "<user>@<host>"]}
]}
```

- **`direction`:** הערך `both`, `pull` (מושך בלבד, ולא שולח) או `push`. לצד
  שאסור לקבל ממנו את המסד המעורב, מושכים ב־`pull` בלבד.
- **`ssh`:** הפקודה שמגיעה לצד השני. אם שם יש `command=` שמפנה ל־`serve`, מספיקה
  כתובת. בלי `command=`, הרכיב האחרון ברשימה הוא נתיב ההרצה, למשל
  `"python3 ~/path/sessions_sync.py"`. ‏`export --since …` או `import` מתווספים אחריו.
- **הסמנים** נשמרים ב־`export_state` של המסד המקומי (`sync:pulled:<machine>`,
  `sync:pushed:<machine>`), עם מרווח של שתי דקות לשורות של טרנזקציה שעוד פתוחה.
- **ההחלה:** שורה חדשה נכנסת עם המפתחות המקוריים, וטקסט של `user`/`assistant`
  נכנס גם ל־`messages_fts`. בשורה קיימת מתמלאים רק NULL ומפתחות JSON חסרים,
  ושום ערך לא נדרס. ערכים שונים נשמרים כראיה תחת
  `~/.local/state/agent-sessions/sync/evidence/`. התנגשות זהות או תוכן עוצרת.
- **זרם קטוע** נכשל בבדיקת ה־footer (sha256 וספירות). מנות שכבר נכנסו תקינות,
  והרצה חוזרת לא מכפילה אותן.
- **עתודת דיסק:** ההחלה עוצרת לפני שבמערכת הקבצים של המסד נשארים פחות מ־768MiB.

`export.ts` רץ גם בלי מסד cass. הוא מדפיס אזהרה, וממשיך עם הקוראים הישירים.
⚠️ **`machine` בקונפיג חייב להיות שם המכונה הזו.** קונפיג שהועתק ממכונה אחרת
יכתוב את הסשנים תחת הזהות שלה.

## סקיל

`skill/SKILL.md` — סקיל תקני שמסביר לסוכנים איך לחפש בארכיון.

לחיבור (סימלינק, כך שעריכה בריפו מתעדכנת בכל הסוכנים):

```bash
for d in ~/.claude/skills ~/.agents/skills ~/.cursor/skills; do
  ln -sfn ~/Projects/agent-sessions-export/skill "$d/agent-sessions"
done
```
