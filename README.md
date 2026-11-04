# agent-tools

מונוריפו של **תשתית-הכלים לסוכני-קוד** (קוד/קונפיג בלבד — בלי דאטה).

## רכיבים
| תיקייה | מה |
|---|---|
| `agent-sessions-export/` | כלי שמירת/ייצוא סשני-סוכן (Cursor/opencode → Markdown+meta) |
| `agents-kb-tools/` | כלי בסיס-הידע (`kb-build-agents`, `kb-wiki-index`, `kb-hygiene`…) |
| `linux-gui/` | קונטיינר דפדפן (webtop+Chrome+playwright-cli) |
| `android-unlock/` | הזנת תבנית/PIN/סיסמה למכשיר אנדרואיד מרוחק — TS/Bun, SSH או ADB, מסלול עץ-נגישות (קרדנציאל מביטוורדן או ישיר) |
| `ask/` | חיפוש מאוחד בכל מאגרי הידע, עם הקשר סביב המילה (`ask "מונח"`) |
| `recoll/` | קונפיג recoll (‏`recoll.conf` + `fields`/`backends`/`mimemap` למופעים) — **לא** האינדקסים |

## איך הם מתחברים
`agent-sessions-export` מייצר קובצי-סשן → **recoll** מאנדקס אותם (לפי הקונפיג כאן)
→ `agents-kb-tools`/הסקיל `agent-sessions` מחפשים בהם. `linux-gui` הוא הדפדפן
לאוטומציה/אימות.

**בלי דאטה:** אינדקסי recoll (`xapiandb`), קובצי-סשן שיוצאו, ומאגרי-זיכרון —
חיים במקומם (ריפו-דאטה / מקומי), לא כאן.

## תחזוקה
כל רכיב עצמאי בתת-התיקייה שלו.
