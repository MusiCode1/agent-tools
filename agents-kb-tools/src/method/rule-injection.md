# הפעלת כלי הכללים

מקור המבנה והסמנטיקה הוא [חוזה הכללים](rule-contract.md). זהו מסלול פרופיל
מפורש; פקודות התאימות שומרות את חוזה knowledge.conf הקיים.

```sh
bin/kb-rules validate --root /path/to/instance --profile config/rules.json
bin/kb-rules render --root /path/to/instance --profile config/rules.json --target auto_review
bin/kb-rules build --root /path/to/instance --profile config/rules.json --output generated/rules
bin/kb-rules build --root /path/to/instance --profile config/rules.json --output generated/rules --check
```

--machine בוחר מכונה, --project פרויקט ו־--service ניתן לחזרה עבור שירותים.
`list` מציג מקורות שנבחרו ליעד; `trigger-registry` מפיק תזכורות ממקורות הכללים.
`--reference-root` משנה הפניות בלבד לבניית snapshot עם הפניות קנוניות.
`--hook` אוכף תקציב hook על render בלי חיתוך. build אינו מתקין תוצרים.

התוצרים כוללים AGENTS.md, auto-review.md, מקטע TOML, קובצי Claude ו־Cursor,
manifest ומרשם תזכורות כשהוגדר. בהקשר פרויקט נוצר גם הפרש סשן לליבת המכונה.
אין fallback לגוף המלא וחריגה מתקציב מכשילה יצירה. `--check` אינו כותב.
כל התוצרים נבדקים לפני כתיבה; החלפה אטומית נעשית לכל קובץ בנפרד.
מחברים רק הפקה ש־build ו־check שלה הסתיימו בהצלחה.

שמות הפקודות והדגלים נשמרים. פקודות bin מופעלות ישירות או באמצעות sh,
ללא prefix של Python. לחיבור, גיבוי ובדיקת טעינה קרא את
[נוהל ההתקנה](installation.md).
