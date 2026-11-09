# agents-kb-tools

כלי ניהול ידע והפצת סקילים משותפים למופעים שונים. כלי המוצר ב־TypeScript;
הנתיבים, התוכן, תחולת הכללים וההרשאות נשארים אצל המופע. ask הוא רכיב נפרד ונשאר Python.

```text
src/tools/<tool>/   מימוש ומשאבים של כלי אחד
src/shared/         קוד משותף לפי שימוש בפועל
src/method/         השיטה וחוזי המוצר
src/skills/         מקורות kb-use ו־kb-install
bin/                נקודות כניסה תאימות
tests/              בדיקות כלים ושילוב על נתונים סינתטיים
examples/           דוגמאות לחוזה החדש ולתאימות
docs/               ארכיטקטורה, החלטות ויומן פיתוח
dist/               JavaScript וחבילות סקילים מופקים, מחוץ ל־Git
```

Node.js 22 ומעלה נדרש. הכנה מתוך תיקיית הרכיב:

```sh
npm ci
npm run check
npm run build
npm test
```

הפקודות נבנות מראש ומסרבות לתוצר חסר או מיושן. הפקה אינה משנה הגדרות משתמש,
PATH, קישורי סקילים, hooks או פרופיל חי. להפצה מריצים `npm pack`; החבילה כוללת
JavaScript ותלויות מאוגדות, מקורות לאימות חתימות ושתי חבילות סקילים ניידות.

| פקודה | שימוש |
|---|---|
| kb-rules | validate, render, build, list ו־trigger-registry לפי פרופיל |
| kb-build-agents | build בפרופיל מפורש; ללא --profile נשמר מסלול התאימות |
| kb-hygiene | שערי תוכן של knowledge.conf |
| kb-wiki-index | אינדקס ישויות ובחירת כללים במסלול התאימות |
| kb-workflows-index | אינדקס נהלים מתוך frontmatter |
| kb-md-fields | חילוץ שדות Markdown ל־Recoll |
| kb-installation | JSON לתכנון, בדיקה, החלה ושחזור התקנה מפורשת |
| kb-package-skills | ייצוא סקילים עם הפניות וקובצי עזר |

```sh
bin/kb-rules validate --root /path/to/instance --profile config/rules.json
bin/kb-rules build --root /path/to/instance --profile config/rules.json --output generated/rules
bin/kb-package-skills --source /path/to/agents-kb-tools --output /path/to/export
```

[שיטת הידע](src/method/knowledge-method.md) · [חוזה הכללים](src/method/rule-contract.md) ·
[הפעלת הכלים](src/method/rule-injection.md) · [התקנה וחיבור](src/method/installation.md).
סקילים: [kb-use](src/skills/kb-use/SKILL.md) ו־[kb-install](src/skills/kb-install/SKILL.md).
דוגמאות: [פרופיל](examples/rules/profile.json) ו־[תאימות](examples/legacy/knowledge.conf).

כלי knowledge.conf בוחרים מופע ב־KB_ROOT או בחיפוש מה־cwd כלפי מעלה.
kb-build-agents שומר גם את MACHINE והקשר נקודת הכניסה. kb-rules דורש
--root מפורש ואינו גוזר אותו ממשתני הסביבה האלה.

[ארכיטקטורה](docs/architecture.md) · [החלטות](docs/decisions.md) · [יומן](docs/walkthrough.md).
