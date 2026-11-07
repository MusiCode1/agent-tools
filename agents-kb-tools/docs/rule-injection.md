# תמציות ויעדי הזרקה

היכולת החדשה מופעלת במפורש באמצעות bin/kb-rules ואינה משנה את חמשת כלי התאימות הקיימים.
מקור החוזה הוא [src/method/rule-contract.md](../src/method/rule-contract.md).
סקילי המוצר נמצאים תחת [src/skills](../src/skills/).

```bash
python3 bin/kb-rules validate --root /path/to/instance --profile config/rules.json
python3 bin/kb-rules build --root /path/to/instance --profile config/rules.json --output generated/rules
python3 bin/kb-rules build --root /path/to/instance --profile config/rules.json --output generated/rules --check
python3 -m unittest discover -s tests -v
```

אין fallback לגופים מלאים כשחסרה תמצית. פרופילי מופעים ומידע מקומי אינם חלק מהחבילה.
המתקין/המפעיל מחבר את התוצרים רק אחרי סקירה ואישור מתאים; אין התקנה אוטומטית.
הארכיטקטורה ב־architecture.md היא תיאור של חוזה התאימות הקודם. לא משתמשים בה
להכרעה על בחירת תמציות בפרופיל החדש. תאריך ההוספה: 2026-11-07.
