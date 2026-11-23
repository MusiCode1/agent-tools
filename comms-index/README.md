# comms-index

אינדקס חיפוש מקומי להודעות אישיות, ווטסאפ ו־SMS, עבור `ask --comms`.

```
comms-index update [--source all|wa|sms] [--force-pull] [--refresh] [--no-pull] [--allow-shrink]
comms-index pull-sms [--refresh]        # משיכת ארכיון ה-SMS מהטלפון עכשיו
comms-index status [--json]
comms-index rebuild                     # בנייה מחדש מהמקורות המקומיים, בלי משיכה
comms-index sms-install [--route ssh|adb] [--no-job]
```

## איך זה בנוי

```
wacli.db (SQLite, מסונכרן חי) ────────────┐
                                          ├─► comms.db (FTS5 trigram) ─► ask --comms · ask msg <ref>
טלפון: sms.db ─► sms.snapshot.db ─(ssh/adb)┘
```

- `comms-index` הוא הכותב היחיד של `comms.db`; ‏`ask` קורא אותו בלבד.
- כל ריצה מיישרת כל מקור מול התמונה המלאה שלו, לפי חתימה של כל הודעה. כך עריכה,
  מחיקה ושינוי שם נקלטים בלי להסתמך על חותמות זמן של המקור.
- 🛑 עדכון שהיה מוחק יותר מ־10% מהאינדקס של מקור, או את כולו, נעצר. כמעט תמיד זה
  מקור תקול ולא מחיקות אמיתיות. למקרה מכוון: `--allow-shrink`.
- המזהה של הודעה (`ref`) הוא hash של המקור והמזהה שלה שם, ולכן הוא יציב גם אחרי
  בנייה מחדש.
- trigram הוא התאמת תת־מחרוזת, ולכן הוא מוצא גם מילה עם תחילית עברית
  (ו/ה/ב/ל/מ/ש/כ). מנוע שמחלק למילים, כמו FTS5 הרגיל או החיפוש של Gmail, מפספס אותן.
  ‏`ask` מסנן אחר כך לפי מילה שלמה שמכירה תחיליות.

## ווטסאפ

הכלי קורא את ה־DB של [`wacli`](https://wacli.sh) לקריאה בלבד, ולכן אינו מתנגש
בנעילה של `sync --follow`. לא משתמשים בחיפוש של `wacli`, כי הוא מחלק למילים ומפספס
תחיליות.

- **נכנסים:** טקסט, כיתוב ושם קובץ.
- **לא נכנסים:** הודעות שנמחקו (`revoked`, ‏`deleted_for_me`), תגובות, ושורות שיש בהן
  רק תבנית (`(message)`, ‏`Reacted…`). ציטוט בתשובה אינו נכנס, כי ההודעה המקורית כבר
  באינדקס.
- **שם השיחה והשולח:** שם השיחה, כינוי, שם מלא או שם עסק, ואז push name.

## SMS: ארכיון על הטלפון

`phone/sms-archive.py` רץ ב־Termux וקורא דרך Termux:API. הוא שומר כל הודעה שנראתה
אי־פעם, גם אם נמחקה אחר כך מהטלפון.

- **תזמון:** ‏`termux-job-scheduler` כל 15 דקות, המינימום של Android, עם `--persisted`
  ובלי דרישת רשת. Android מריץ את המשימה גם כש־Termux אינו פעיל, ולכן היא אינה
  תלויה בשירות שרץ ברקע.
- **מפתח:** ‏`(_id, received)`, כי Android עלול לתת `_id` של הודעה שנמחקה להודעה חדשה.
- **ריצה רגילה:** עוברת על דפים מהחדש לישן, ועוצרת בדף הראשון שיש בו הודעה מוכרת.
- **עותק להעתקה:** נכתב ב־`VACUUM INTO`. מעתיקים אותו, ולא את ה־DB החי. כשאין
  שינוי הוא נכתב פעם בשעה, כדי שהצד השני יראה שהארכיון חי.
- 🔒 **בלי תוכן הודעות** בלוג, ב־meta ובהודעות שגיאה, כי הם יוצאים מהטלפון.

מלכודות שנמדדו בצד הטלפון:

| | |
|---|---|
| הודעה בלי כתובת שולח | ‏`termux-sms-list` נופל באמצע הפלט, והדף כולו נקטע. לכן הקריאה הראשית מסננת `length(address)>0`, וההודעות האלה נקראות בנפרד דרך `rish` |
| ‏`--message-selection` | עובד רק בצורה `--message-selection=<ערך>`. עם רווח זו שגיאה |
| ‏`rish` מאבד פלט | בערך שליש מהקריאות ריקות או חלקיות. רשימת המזהים היא איחוד של כמה קריאות, והודעה נשמרת רק כשאותו פלט מלא חזר פעמיים |
| ‏`LD_LIBRARY_PATH` | אם מגדירים אותו לספריות של Termux, ‏`app_process` של המערכת נכשל, ואיתו `rish`. ‏Termux עצמו אינו מגדיר אותו |

### משיכה

הכלי מנסה את הנתיבים בסדר שבקונפיג:
- `ssh`: ה־sshd של Termux.
- `adb`: ‏`exec-out run-as com.termux cat`. עובד גם כשה־sshd כבוי.

‏ADB רץ על שרת ייעודי בפורט משלו (`server_port`), והכלי סוגר אותו בסוף. כך הוא לא
נוגע בשרת adb שמישהו אחר משתמש בו.

לפני שהעותק מחליף את הקיים, הכלי בודק אותו: `quick_check`, ושאינו קטן מהעותק הקודם.
כשל בכל הנתיבים לא מוחק את העותק הקיים, ונרשם ב־`status`.

‏`adb exec-in` אינו מעביר סוף קובץ ל־`run-as`, ולכן `sms-install` מעלה קבצים דרך
`adb shell` עם stdin.

### מה לא נכנס

- **‏RCS:** הודעות RCS (למשל ב־Google Messages) אינן נשמרות ב־`content://sms`, ולכן גם
  לא בארכיון.
- **‏MMS:** לא בשלב הזה.

## פרטיות

- 🔒 `ask` אינו קורא את `comms.db` בלי `--comms`. מה שסוכן מדפיס נכנס לארכיון
  השיחות, ו־`ask` מחפש בארכיון הזה כברירת מחדל.
- קבצים בהרשאה 0600 ותיקיות בהרשאה 0700. חשבונות, כתובות ומפתחות נשמרים רק בקונפיג
  המקומי, `~/.config/comms-index/config.json`.

## התקנה

```bash
ln -sfn ~/Projects/agent-tools/comms-index/comms-index ~/.local/bin/comms-index
install -d -m 700 ~/.config/comms-index
install -m 600 config.example.json ~/.config/comms-index/config.json   # ולמלא
comms-index update --source wa
comms-index sms-install                # העלאה לטלפון, סריקה מלאה ורישום משימה
cp systemd/comms-index.service systemd/comms-index.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now comms-index.timer
```

הטיימר רץ כל 5 דקות. ווטסאפ מתעדכן בכל ריצה, ו־SMS לפי `pull_interval_min`.
ריצה בלי שינוי לוקחת פחות משנייה.

בדיקות, על נתונים סינתטיים: `python3 -m unittest test_comms_index`.
