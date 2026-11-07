# agents-kb-tools

כלים משותפים למופעי ידע: בחירת כללים לפי תחולה, תמציות לשני יעדי הזרקה,
אינדקסים ובדיקות חוזה. התוכן, הפרופילים וההרשאות נשארים בריפו של כל מופע.

```text
src/kb_tools/       מנוע בחירה ויצירת תמציות
src/method/         חוזי המוצר ושיטת ניהול הידע
src/skills/kb-use/  סקיל שימוש
src/skills/kb-install/ סקיל התקנה וחיבור
bin/               נקודות כניסה וכלי תאימות
tests/            בדיקות מבודדות
docs/             תיעוד הפרויקט, החלטות ויומן פיתוח
```

[חוזה הכללים](src/method/rule-contract.md) הוא מקור האמת לפרופיל התמציות.
[שיטת הידע](src/method/knowledge-method.md) מסבירה כתיבה ושליפה.
להתקנה קרא את [kb-install](src/skills/kb-install/SKILL.md).
Python 3.11 ו־PyYAML 6 נדרשים; build אינו מתקין תלויות.

```bash
python3 bin/kb-rules validate --root /path/to/instance --profile config/rules.json
python3 bin/kb-build-agents --root /path/to/instance --profile config/rules.json --output generated/rules
python3 -m unittest discover -s tests -v
```

התוצרים מיועדים לסקירה: AGENTS.md, auto-review.md, מקטע תצורת Codex,
קובצי טעינה טבעית ל־Claude ול־Cursor, ומרשם מקורות ובחירה. אין חיבור חי אוטומטי.
[פרטי ההרצה](docs/rule-injection.md).

כלי knowledge.conf הוותיקים ממשיכים במסלולם הקודם. הוספת --profile ל־kb-build-agents
בוחרת במפורש במנוע החדש ודורשת root ו־output. ללא הדגל, התנהגות התאימות נשמרת.
[ארכיטקטורת הפרויקט](docs/architecture.md) · [החלטות](docs/decisions.md) · [יומן](docs/walkthrough.md).
