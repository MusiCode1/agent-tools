# git-sync — סנכרון Git מפורש, בשלושה מצבים

כלי אחד לשלושה מקרים שבהם `git pull` ו־`git push` רגילים מסוכנים: עץ שעורכים בו
פתקים, עץ שמשמש מראה לקריאה, ויומן append-only שנכתב מחוץ לגיט. כל ריצה מפורשת;
אין טיימר בכלי עצמו. הפלט הוא שורת JSON אחת ב־stdout, וההתקדמות ב־stderr.

| מצב | מה הוא עושה | מה הוא **לא** עושה |
|---|---|---|
| `notes` | מקמט פתקים מקומיים מתיקיות מוגדרות, ממזג ב־worktree פרטי עם עותקי התנגשות ניתנים לשחזור, ובודק שלא אבדה אף שורה, מעדכן ב־fast-forward ודוחף | לא נוגע בקבצים מחוץ ל־`note_roots`. דורש עץ בבעלות בלעדית ו־`--editor-paused` |
| `mirror` | מראה של הענף המרוחק: אם העץ נקי — fast-forward בלבד | לא מקמט אף פעם. עץ מלוכלך או מפוצל עוצר עם דוח לכל קובץ: האם הוא כבר ב־remote ואילו שורות יש רק מקומית |
| `append` | לוקח קובץ ממתין מחוץ לריפו, מוסיף את השורות לקובץ יעד ב־worktree פרטי (בלי כפילויות), מקמט עם ההוקים של הריפו ודוחף; מנסה שוב כשה־remote התקדם | לא נוגע בעץ העבודה. קובץ הממתין נמחק רק אחרי דחיפה מוצלחת; ריצה שנכשלה ממשיכה מאותה אצווה |

## הרצה

```bash
git-sync plan     --config ~/.config/git-sync/<name>.json   # קריאה בלבד, בלי רשת
git-sync status   --config …                                # קריאה בלבד
git-sync sync     --config …                                # הרצת המצב שבפרופיל
git-sync install  <repo>/<profiles>/<name>.json --config ~/.config/git-sync/<name>.json
```

‏`git-sync` היא עטיפה ל־`git_sync.py`; מתקינים אותה פעם אחת כקישור לתיקייה ב־`PATH`.
‏`knowledge-sync` הוא השם הקודם, ונשמר להתקנות קיימות.

קודי יציאה: `0` הצליח · `2` דורש תשומת לב (`reason` מסביר) · `3` עסוק או ממתין לשרת — לנסות שוב.

## פרופיל

הפרופיל יושב **בריפו שהוא מתאר** (מקור ותיעוד), והכלי קורא רק את העותק המותקן מחוץ
לריפו. כך קומיט — גם של סוכן שטעה — לא יכול להרחיב תיקיות או להחליף remote בלי התקנה מפורשת.

| שדה | מצבים | מה |
|---|---|---|
| `repo` · `remote` · `remote_url` · `branch` · `device` | כולם | העץ, וזהות ה־remote שנבדקת לפני כל ריצה |
| `mode` | — | `notes` (ברירת מחדל) · `mirror` · `append` |
| `state_dir` | כולם | נעילה, יומן ריצה ו־worktrees פרטיים; חייב להיות מחוץ לעץ ול־`.git` |
| `commit_message` | notes · append | ב־append ‏`{count}` מוחלף במספר השורות |
| `merge_message` · `note_roots` · `extra_notes` · `exclusive_worktree` · `quiet_seconds` · `validator` | notes | `validator` — נתיב (יחסי לריפו או מוחלט) לכלי הבדיקה של מאגר הידע |
| `pending` · `target` · `json_lines` | append | קובץ ממתין (מחוץ לריפו), קובץ יעד (יחסי), ובדיקה שכל שורה היא JSON |
| `command_timeout` · `max_attempts` | כולם | גבולות |

## כתיבה לקובץ הממתין (append)

הכותב פותח את הקובץ **לפי נתיב** בכל כתיבה (`O_APPEND | O_CREAT`), מחזיק `flock` בזמן
הכתיבה וסוגר. הכלי מעביר את הקובץ לאצווה בהעברה אטומית ולוקח את אותה נעילה לפני הקריאה,
כך שכתיבה שהתחילה לפני ההעברה מסתיימת בתוך האצווה, וכתיבה שאחריה יוצרת קובץ ממתין חדש.

## השומר — `live-tree-guard.sh`

הוק ל־`pre-commit` ול־`pre-merge-commit` של עץ שמשמש מראה. פעיל רק כש־
`git config gitsync.liveTree true`, ורק בעץ הראשי — worktrees מקושרים עוברים.
‏`git pull --ff-only` לא מפעיל אותו. רמז ספציפי לריפו: `git config gitsync.liveTreeHelp "<נתיב לנוהל>"`.
ההוק אינפורמטיבי: `--no-verify` עוקף אותו, והאכיפה היא בהנחיות של מי שמשתמש בו.

## בדיקות

```bash
python3 -m unittest test_mirror_append test_install_profile
GIT_SYNC_KB_REPO=<checkout של מאגר ידע> python3 -m unittest test_notes   # בלעדיו — מדולג
```

מצב `notes` צריך מאגר ידע עם `agents/infra/config/knowledge-layout.json` ועם כלי הבדיקה שלו.
