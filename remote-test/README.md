# remote-test

`remote-test` מעביר קומיט ל־runner ומריץ עליו פקודה בתור `heavy-run`. הכלי עומד בפני עצמו, כדי שהפעלת התור המקומי תישאר מפורשת באותה צורה בכל ריפו.

```bash
# משורש worktree נקי בריפו שמוגדר לעבודה מול ה-runner
remote-test --label backend-suite -- bun run test packages/backend
remote-test status
```

הלקוח דורש `HEAD` מקומט ו־worktree נקי, כולל קבצים לא מנוהלים שאינם ignored. הוא מדפיס את פקודות ה־`git push` וה־`ssh` לפני הביצוע, עם quoting שמתאים להדבקה ל־shell. ה־push מכוון לענף `refs/heads/rt/<worktree-id>` נפרד לכל worktree ומציין את ה־SHA שנמדד לפני ה־push. אותו SHA משמש גם ב־SSH.

ה־runner מדפיס את הנתיב ואת פעולות ה־`git fetch`, ה־`git checkout` ו־`heavy-run --local`. הוא שומר checkout לכל worktree ומתקין תלויות Bun בהכנה הראשונה, אם השתנה ה־lockfile, או כשהתלויות חסרות. הפקודה מקבלת את stdin המקומי. stdout ו־stderr חוזרים תוך כדי הריצה.

- אם ה־worktree מלוכלך, הלקוח מחזיר 2 ומציג הודעה לקמט תחילה.
- כשל ב־push, ב־SSH או בהכנת ה־checkout מחזיר 3 עם הודעת השגיאה המקורית.
- כשפקודה רצה ב־runner, הלקוח מחזיר את קוד היציאה שלה, כולל 3 או 255.

## התקנה

```bash
install -Dm755 remote-test/remote-test ~/.local/bin/remote-test
git remote add runner heavy-run-runner:drive-coding.git
```

נדרש יעד SSH בשם `heavy-run-runner` שמפעיל את `remote-test/runner` כפקודה כפויה עם Git, Bun ו־`heavy-run` ב־PATH. ה־runner דורש מראת Git bare ב־`~/.cache/heavy-run/remote-test/drive-coding.git` עם הרשאות כתיבה למשתמש ההרצה. הגדר במראה pre-receive hook שמאפשר עדכונים רק ב־`refs/heads/rt/<worktree-id>`. השתמש בחשבון runner מבודד עבור קוד בדיקות שמורשה לרוץ בו. אפשר לאמת את החיבור עם `remote-test status`.

## בדיקות

```bash
python3 -m unittest discover -s remote-test -p 'test_*.py'
```
