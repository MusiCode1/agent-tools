---
name: agent-sessions
description: Search local coding-agent session history in Hebrew or English via ask, across Claude Code, Codex, Cursor, opencode, grok, Gemini/Antigravity, pi, omp and more. Use when an agent needs to find what was done in a previous session, recover a conversation whose source file was deleted, read per-session metadata, or make the current conversation searchable right now.
---

# agent-sessions

ארכיון מקומי של סשני סוכנים, ניתן לחיפוש **בעברית ובאנגלית**.

מקורות: Claude Code · Codex · Cursor (‏acp-sessions + chats) · opencode ·
grok · Gemini/Antigravity · pi · omp · hermes · openclaw · cline.

## 🛑 שני כללים קשיחים

> 🔴 **`~/.recoll-sessions` נמחק ב-2026-10-24. אין יותר אינדקס recoll לסשנים.**
> הוא לא התעדכן מאז 09/09 — נמדד שאין לו שום מעדכן: `nightly-search-index`
> מאנדקס את `~/.recoll` ואת `~/.recoll-diary`, ואותו לא. ⇒ הוא החזיר
> תוצאות בנות שישה שבועות בשקט.
>
> **לסשנים — `ask` (קורא את ה־DB).** הכרעת-משתמש: recoll אינו מאנדקס סשנים.
> ‏`~/.recoll` הוא **ידע בלבד** (זו הסיבה המקורית לפיצול ב-08/09: 25,917
> קבצי סשנים מול ~794 מסמכי ידע דחקו את הרנבוקים ל-2.5% מהתוצאות).
>
> 🛑 **ומה שנשאר פתוח:** `skippedPaths` ב-`~/.recoll` מחריג את ריפואי
> הסשנים — **חוץ מ-`tzlev-agent-sessions`** (נוצר 12/10, ההחרגה נשארה
> על הנתיב הישן). נמדד: 2,101 קבצי-סשנים משם עדיין מאונדקסים.

1. **לחיפוש סשנים בעברית — `ask`.** ‏`cass search` מחזירה אפס תוצאות בעברית,
   ו־`recollq` כבר אינו מחפש באינדקס סשנים פעיל.
2. **לחיפוש ידע — `recollq -c ~/.recoll`.** ב־Recoll אין stemming עברי;
   כשמחפשים שם, נסה כמה נטיות. `ask` מחפש גם בו כברירת מחדל.


## חיפוש סשנים ב־`ask`

ה־DB מתעדכן ע"י `agent-sessions-export.timer` כל 20 דקות. `ask` מחפש בו
ובאינדקס הידע; `--sessions` מצמצם לסשנים בלבד. הוא מציג קטע הקשר ומזהה
קצר שאפשר להעביר ל־`ask session`.

```bash
ask 'שיבוץ' --sessions
ask 'שיבוץ' --sessions --role user --project tzlev --since 2026-09-01 -n 5
ask session <short>          # השיחה המלאה; קיצור מפלט החיפוש
ask 'שיבוץ' --sessions --json # פלט למכונה
```

### המסד

`ask` הוא נקודת הכניסה לחיפוש ולקריאת סשן. `ask session --json`
מחזיר גם את כל שדות רשומת הסשן מה־DB. מזהה מלא שמתחיל במקף מעבירים
אחרי `--`: ‏`ask session --json -- "$SID"`.

🛑 **אל תניח נתיב-מסד קבוע.** `ask` קורא את `db_path` מתוך
`~/.config/agent-sessions/config.json`, ואם הקובץ חסר — משתמש ב־
`~/.local/state/agent-sessions/sessions.db`. שרשרת הקדימות של **היצואן**
ושל כלי התחזוקה הישן היא:

```
--db <path>  →  $AGENT_SESSIONS_DB  →  db_path ב-~/.config/agent-sessions/config.json
             →  ברירת-מחדל: ~/.cache/agent-sessions/sessions.db
```

לראות את הנתיב בפועל: `grep db_path ~/.config/agent-sessions/config.json`.

**על violate9 (נמדד 01/11/2026):** הקונפיג מצביע על —
`~/.local/state/agent-sessions/sessions.db` (2.9GB). התיקייה `~/.cache/agent-sessions/`
**אינה קיימת** כאן; מי שיחפש אותה יסיק בטעות שאין מסד.

⚠️ **ואל תתבלבל עם** `~/.local/share/coding-agent-search/agent_search.db` —
זה המסד של **`cass`**, כלי אחר. תוכנו קפוא מ-06/09/2026, אבל `export.ts`
פותח אותו readonly ו**מת בלעדיו** ⇒ **אין למחוק אותו**: זה יעצור את
עדכון ה־DB כל 20 דקות.

**הדפוס הישן:** `recollq` → נתיב → פתיחת ה-`.md` → `grep` בתוכו.
**עם `ask`:** התוצאה כוללת קטע הקשר, CLI, פרויקט ופקודת קריאה לסשן.

🛑 **בקונטיינר של mission13 אין להשאיר אותו ב-`~/.cache`** — שם זה **אינו
bind**, וה-DB נמחק בכל restart (ובנייה מחדש היא ~28 דקות). שם `db_path`
מצביע ל-`~/projects/.agent-sessions/`, שהוא כן bind. אותו שיקול חל על
העטיפה: היא חיה **בתוך הריפו** ולא ב-`~/.local/bin`, שגם הוא אינו bind.

ה־DB משתמש ב־`trigram`, ולכן הוא עשוי למצוא גם תת־מחרוזות. `ask` מסנן
כברירת מחדל התאמות שאינן מילה שלמה; `--no-word` מבטל את הסינון כשצריך.

### מתי `ask` או `recollq`

| | |
|---|---|
| **`ask`** | חיפוש בידע ובסשנים; `--sessions` לסשנים בלבד; `ask session <short>` לשיחה מלאה |
| **`recollq -c ~/.recoll`** | חיפוש ישיר בידע כשנחוצים דגלים או פלט גולמי שאינם ב־`ask` |
| ~~`recollq -c ~/.recoll-sessions`~~ | 🔴 **בוטל 24/10/2026.** האינדקס נמחק; הפקודה תחזיר אפס תוצאות |

🛑 **מה שאין ב-DB:** פלט-כלי מלא יושב ב-`heavy` (דחוס, לא מאונדקס);
ב-`text` יש רק סימון `[Tool: name]`. חיפוש אחרי תוכן של פלט-כלי לא
יימצא ב־`ask`. ⚠️ **וגם לא ב-recoll יותר** — האינדקס של הסשנים נמחק.
לחיפוש בתוך פלט-כלי: `rg` ישירות על ריפו-הארכיון.

## חיפוש

```bash
ask 'מונח'                            # ידע וסשנים
ask 'מונח' --sessions                 # סשנים בלבד
ask 'מונח' --sessions --json          # לעיבוד
```

🛑 **הפקודות הישנות `recollq -c ~/.recoll-sessions` אינן עובדות יותר** —
האינדקס נמחק 24/10/2026 (ראו למעלה). לסשן מלא משתמשים ב־`ask session <short>`;
הוא מציג את השיחה מתוך ה־DB, ואינו מחזיר נתיב לקובץ הארכיון.

צמצום לפרויקט או ל־CLI נעשה בדגלים של `ask`:

```bash
ask 'ArkType' --sessions --project project-a
ask 'משימה' --sessions --cli cursor-acp
```

`--project` מסנן לפי שם הפרויקט; ‏`--cli` דורש את שם ה־CLI המדויק
שמופיע בתוצאות החיפוש.

## מטא-דאטה מלאה

מזהה הסשן מתקבל מתוצאת החיפוש. `ask session` מחזיר את השיחה גם כ־JSON.
לשדות מלאים של רשומת ה־DB, כגון `usage` ו־`meta`, משתמשים ב־`ask`
עם המזהה המלא שנמצא בפלט החיפוש. `--` נדרש כשהמזהה מתחיל במקף:

```bash
SID=$(ask 'מונח' --sessions --json | jq -r '.results[0].hits[0].session // empty')
ask session --json -- "$SID" | jq -r '.messages[] | "\(.role): \(.text)"'
ask session --json -- "$SID" | jq '.session'              # מטא-דאטה מלאה
```

אם `SID` ריק, לא נמצאה תוצאה; משנים את השאילתה לפני קריאת הסשן.

## לרענן עכשיו

```bash
agent-sessions-refresh --quiet    # ~3 שניות
```

**מתי זה נחוץ:** כשהשיחה הנוכחית עוד לא מופיעה ב־`ask`, בלי קשר לפורמט
המקור. הרענון מעדכן את ה־DB; הוא אינו מחכה לקליטה ב־Recoll.
בלי טריגר, הטיימר רץ ממילא כל 20 דקות.

## מה יש בארכיון שאין במקור

**‏~1,150 שיחות Claude Code שקבצי המקור שלהן נמחקו.** ‏Claude מוחק תמלילים
לפי `cleanupPeriodDays` (ברירת מחדל 30 יום). הארכיון הוא העותק היחיד שלהן —
`grep` על `~/.claude/projects` לא ימצא אותן.

## שלושה ריפואים — לפי רגישות

```
~/Projects/agent-sessions            technical (ברירת מחדל)
~/Projects/agent-sessions-work       team · project-d
~/Projects/agent-sessions-personal   project-b · project-c · project-e
```

הניתוב הוא **לפי נתיב ה-workspace, לא לפי תוכן**. סוד שנשפך לסשן ב-
`project-a` יגיע ל-technical. יש `redact.ts` שמסתיר 12 סוגי מפתחות
לפני הכתיבה — אבל **אל תדפיס סודות לתמליל** מלכתחילה; הוא נסרק ומיוצא.

## תפעול

| יחידה | מתי |
|---|---|
| `agent-sessions-export.timer` | כל 20 דק׳ |
| `nightly-search-index.timer` | 04:00 — אינדקסי Recoll של הידע והיומן, ועדכון DB הסשנים |
| `recoll-full-rebuild.timer` | 1 לחודש — `recollindex -z` |

```bash
systemctl --user list-timers | grep -E 'agent-sessions|recoll|nightly'
journalctl --user -u agent-sessions-export.service -n 20
```

**רנבוקים:** `agents-config/wiki/software/basic-memory/runbooks/agent-sessions-archive.md`
ו־`agents-config/wiki/vendors/cursor/runbooks/cursor-store-db-format.md`.
