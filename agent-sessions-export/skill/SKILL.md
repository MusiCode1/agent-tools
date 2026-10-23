---
name: agent-sessions
description: Search and archive local coding-agent session history in Hebrew or English via recoll, across Claude Code, Codex, Cursor, opencode, grok, Gemini/Antigravity, pi, omp and more. Use when an agent needs to find what was done in a previous session, recover a conversation whose source file was deleted, read full per-session metadata (model, cost, tokens), or make the current conversation searchable right now. Prefer this over `cass search` for anything Hebrew — cass returns zero results for Hebrew queries.
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
> **לסשנים — `sq` (ה-DB).** הכרעת-משתמש: recoll אינו מאנדקס סשנים.
> ‏`~/.recoll` הוא **ידע בלבד** (זו הסיבה המקורית לפיצול ב-08/09: 25,917
> קבצי סשנים מול ~794 מסמכי ידע דחקו את הרנבוקים ל-2.5% מהתוצאות).
>
> 🛑 **ומה שנשאר פתוח:** `skippedPaths` ב-`~/.recoll` מחריג את ריפואי
> הסשנים — **חוץ מ-`tzlev-agent-sessions`** (נוצר 12/10, ההחרגה נשארה
> על הנתיב הישן). נמדד: 2,101 קבצי-סשנים משם עדיין מאונדקסים.

1. **לחיפוש בעברית — `recollq`, לא `cass`.** ‏`cass search` מחזירה **אפס
   תוצאות** על כל שאילתה בעברית (הטוקנייזר שלה הוא `porter`, סטמר אנגלי).
   נמדד: `מזגן` → cass 0, ‏recoll 44.
2. **אין stemming עברי ב-Xapian.** החיפוש הוא **צורה מדויקת בלבד** —
   `רענן` לא ימצא `ורענן`, `בריא` לא ימצא `בריאה`. חפש כמה נטיות, או
   בחר מילה בלי אותיות שימוש.


## 🆕 ‏`sq` — חיפוש ב-DB, קריאת-כלי אחת במקום שלוש

מאז 11/10/2026 יש גם **DB** (`~/.cache/agent-sessions/sessions.db`),
שנבנה ע"י אותו `agent-sessions-export.timer` כל 20 דקות. הוא **אינו
מחליף** את recoll — הוא מקצר את הדפוס.

**הדפוס הישן:** `recollq` → נתיב → פתיחת ה-`.md` → `grep` בתוכו.
**עם `sq`:** תוצאה אחת כוללת כבר את הקטע המודגש **ואת הקשר-הסשן**
(תאריך · role · מודל · CLI · פרויקט · cwd · פקודת-המשך).

```bash
sq "שיבוץ"                                   # יש עטיפה ב-PATH
sq "שיבוץ" --role user --project tzlev --since 2026-09-01 --limit 5
sq --session <id>     # הסשן המלא
sq --stats            # סקירת הקורפוס
sq "x" --json         # פלט למכונה
```

**נתיב ה-DB** נקבע לפי: `--db` → ‏`$AGENT_SESSIONS_DB` → ‏`db_path`
בקונפיג (`~/.config/agent-sessions/config.json`) → ברירת-מחדל
`~/.cache/agent-sessions/sessions.db`.

🛑 **בקונטיינר של mission13 אין להשאיר אותו ב-`~/.cache`** — שם זה **אינו
bind**, וה-DB נמחק בכל restart (ובנייה מחדש היא ~28 דקות). שם `db_path`
מצביע ל-`~/projects/.agent-sessions/`, שהוא כן bind. אותו שיקול חל על
העטיפה: היא חיה **בתוך הריפו** ולא ב-`~/.local/bin`, שגם הוא אינו bind.

🔑 **הטוקנייזר הוא `trigram` — תת-מחרוזת, לא מילה שלמה.** ולכן, בניגוד
ל-recoll ול-cass, **`שעות` מוצא גם `בשעות`** — אותיות-שימוש אינן מפריעות.
המחיר: מינימום 3 תווים בשאילתה.

### מתי recoll ומתי sq

| | |
|---|---|
| **`sq`** | סשנים. מהיר (ms), מחזיר הקשר מלא, מסנן לפי role/פרויקט/תאריך, ‏`--json` |
| **`recollq -c ~/.recoll`** | **ידע** — ויקי, רנבוקים, כספת, PDF. ‏`sq` אינו מכיר אותם |
| ~~`recollq -c ~/.recoll-sessions`~~ | 🔴 **בוטל 24/10/2026.** האינדקס נמחק; הפקודה תחזיר אפס תוצאות |

🛑 **מה שאין ב-DB:** פלט-כלי מלא יושב ב-`heavy` (דחוס, לא מאונדקס);
ב-`text` יש רק סימון `[Tool: name]`. חיפוש אחרי תוכן של פלט-כלי לא
יימצא ב-`sq`. ⚠️ **וגם לא ב-recoll יותר** — האינדקס של הסשנים נמחק.
לחיפוש בתוך פלט-כלי: `rg` ישירות על ריפו-הארכיון.

## חיפוש

```bash
sq 'מונח'                             # ברירת-המחדל לסשנים
sq 'מונח' --json                       # לעיבוד
```

🛑 **הפקודות הישנות `recollq -c ~/.recoll-sessions` אינן עובדות יותר** —
האינדקס נמחק 24/10/2026 (ראו למעלה). מי שצריך את קובץ-ה-`.md` עצמו:
`sq --session <id>` מחזיר את הנתיב.

הנתיב עצמו הוא מטא-דאטה: `<repo>/data/<machine>/sessions/<project>/<agent>/<id>.md`
מספר לך ריפו · מכונה · פרויקט · סוכן, בלי לפתוח כלום.

צמצום לפרויקט או לסוכן — פשוט הוסף מילה לשאילתה:

```bash
recollq -c ~/.recoll-sessions -n 10 'project-a ArkType'
recollq -c ~/.recoll-sessions -n 10 'cursor-acp משימה'
```

⚠️ `dir:` לא עובד אמין כאן — עדיף `grep` על הפלט.

## מטא-דאטה מלאה

לכל `.md` יש `.json` תאום עם 26 שדות — מודל, עלות, טוקנים, ספירות כלים:

```bash
MD=$(recollq -c ~/.recoll-sessions -n 1 -b 'מונח' | sed 's|^file://||' | grep '\.md$')
JSON=$(echo "$MD" | sed 's|/sessions/|/meta/|; s|\.md$|.json|')

jq '.session' "$JSON"                                  # מטא-דאטה
jq -r '.messages[] | "\(.role): \(.content)"' "$JSON"  # השיחה כטקסט
```

(אימות: `claude_code · project-a · 40 הודעות`. **אל תשתמש בהחלפת-מחרוזת
של bash** על הנתיב — הסלאשים דורשים escaping שנשבר בשקט; `sed` בטוח.)

ה-`.json` **מחוץ לאינדקס** בכוונה (`skippedPaths`), כדי שכל תוצאה לא תופיע פעמיים.

## לרענן עכשיו

```bash
agent-sessions-refresh --quiet    # ~3 שניות
```

**מתי זה נחוץ:** רק למקורות מבוססי-SQLite — **Cursor ו-opencode**. שם
הייצוא הוא המסלול היחיד לחיפוש. רתמות שכותבות JSONL (‏Claude, ‏Codex,
‏grok, ‏pi, ‏omp…) כבר מאונדקסות חי ואינן צריכות את זה.

אחרי הרענון recoll קולט לבד תוך ~30 שניות — אין צורך לגעת בו.
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
| `nightly-search-index.timer` | 04:00 — recoll → cass → ייצוא |
| `recoll-full-rebuild.timer` | 1 לחודש — `recollindex -z` |

```bash
systemctl --user list-timers | grep -E 'agent-sessions|recoll|nightly'
journalctl --user -u agent-sessions-export.service -n 20
```

**רנבוקים:** `agents-config/workflows/runbooks/agent-sessions-archive.md`
ו-`cursor-store-db-format.md`.
