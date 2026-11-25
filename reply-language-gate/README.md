# reply-language-gate

הוק `Stop` ל-Claude Code שבודק את שפת התשובה בסיום התור. הוא מודד את חלקן של אותיות כתב היעד מתוך אותיות כתב היעד והאותיות הלטיניות, אחרי הסרת קוד מסומן, כתובות URL ונתיבים נפוצים. כברירת מחדל הוא מבקש שכתוב לעברית כשיש לפחות 40 אותיות נספרות ופחות מ-60% מהן בעברית.

`Stop` פועל בסיום התשובה. בממשק שמציג אותה תוך כדי כתיבה, המשתמש רואה את התשובה המקורית והשכתוב מגיע אחריה. ההוק קורא את `last_assistant_message` ומנסה לקרוא מהתמליל אם השדה חסר. התשובה הסופית עשויה עדיין להיעדר מהתמליל בגרסאות מסוימות. `decision: "block"` עם `reason` מבקש מ-Claude להמשיך בתור. אם `stop_hook_active` מסומן והתשובה עדיין מתחת לסף, ההוק מחזיר רק אזהרת `systemMessage`. בשגיאת קריאה או עיבוד ההוק מאפשר לסיים את התור. [חוזה ההוקים של Claude Code](https://code.claude.com/docs/en/hooks#stop)

## התקנה

נדרש Python 3.8 ומעלה בסביבת Unix. הדוגמה מניחה שהריפו נמצא ב-`$HOME/agent-tools`. התאימו את הנתיב למיקום הריפו.

מזגו את הרשומה הבאה לרשימת `hooks.Stop` ב-`~/.claude/settings.json` לצד ההוקים הקיימים.

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 \"$HOME/agent-tools/reply-language-gate/gate.py\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

הוסיפו את ה-CLI לספרייה שנמצאת ב-`PATH` של Claude Code.

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/agent-tools/reply-language-gate/reply-language-gate" "$HOME/.local/bin/reply-language-gate"
```

## הגדרות

קובץ JSON אופציונלי ב-`${XDG_CONFIG_HOME:-~/.config}/reply-language-gate/config.json`. משתני הסביבה גוברים על הערכים המקבילים בקובץ.

| מפתח | משתנה סביבה | ברירת מחדל |
|---|---|---|
| `language` | `REPLY_LANG` | `hebrew`. ערכים נוספים הם `arabic`, `cyrillic`, `greek` |
| `min_ratio` | `REPLY_LANG_MIN_RATIO` | `0.6`, מספר בין 0 ל-1 |
| `min_letters` | `REPLY_LANG_MIN_LETTERS` | `40`, מספר שלם אי-שלילי |
| `message` | `REPLY_LANG_MESSAGE` | הוראת שכתוב בעברית עם פקודת חריגה למקרה של בקשת משתמש מפורשת |

דוגמה לתבנית מותאמת. `{language}` הוא שם התצוגה, `{ratio}` הוא היחס באחוזים, `{session_id}` הוא מזהה הסשן ו-`{allow_cmd}` היא פקודת החריגה לסשן. תבנית שגויה גורמת לרישום `error` ולשימוש בתבנית ברירת המחדל.

```json
{
  "language": "hebrew",
  "message": "כתוב את כל התשובה ב-{language} (כעת {ratio}, סשן {session_id}). אם המשתמש ביקש במפורש שפה אחרת, הרץ {allow_cmd} עם ציטוט הבקשה במקום מציין המקום."
}
```

## חריגים לפי סשן

```sh
reply-language-gate allow --session example --reason 'נא לענות באנגלית'
reply-language-gate check --session example
reply-language-gate list
reply-language-gate revoke --session example
```

אפשר להשמיט את `--session` כש-`CLAUDE_CODE_SESSION_ID` זמין. `check` מחזיר 0 לסשן מורשה ו-1 לסשן ללא חריגה תקפה. `list` מציג רשומות פעילות כ-JSONL. החריגים נשמרים ב-`${XDG_STATE_HOME:-~/.local/state}/reply-language-gate/allow.jsonl` עם מזהה סשן, חותמת זמן וציטוט הבקשה. תוקפם 30 יום והכתיבה הבאה מסירה רשומות שפג תוקפן. [משתני הסביבה של Claude Code](https://code.claude.com/docs/en/env-vars)

## יומן ומגבלות

היומן המקומי `${XDG_CACHE_HOME:-~/.cache}/reply-language-gate.jsonl` מתעד `block`, `skip-allowed`, `loop-warn` ו-`error` עם `ts` (שניות Unix), `session_id` ו-`ratio` (שבר בין 0 ל-1 או `null` אם טרם נמדד). גוף התשובה אינו נשמר ביומן.

המדידה מבוססת על כתב, ולכן שפות שחולקות כתב מקבלות אותו ניקוד. אותיות מכתבים אחרים אינן נכנסות למכנה. ההוק מיועד ל-Claude Code בלבד. Cursor ו-Codex אינם נתמכים. תת-סוכנים מפעילים `SubagentStop` ומחוץ לתחולת ההוק. [SubagentStop בתיעוד Claude Code](https://code.claude.com/docs/en/hooks#subagentstop)

## בדיקות

מתיקיית הרכיב הריצו `python3 -m unittest`. הבדיקות משתמשות בספריות HOME ו-XDG זמניות ובקלט מדומה להוק.
