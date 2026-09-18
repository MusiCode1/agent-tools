# agents-kb-tools

**המנגנון של מערכת-הידע. אין כאן תוכן.**

הכלים מופעלים על **מופע** — ריפו שמכיל `knowledge.conf` ואת ארבע שכבות הידע.
**שני מופעים חיים** (2026-09-08):

| מופע | שורש | שער | מיוחד |
|---|---|---|---|
| `agents-config` | `knowledge/` | `fail` | אישי · שער-שמות **פעיל** |
| `team-docs-repo` | `knowledge/` (שורש הריפו, לא תחת `app/`) | `fail` | צוות · שער-שמות **כבוי** — השמות הם התוכן · `kind: flow` ו-`catalog` |

המופע השני הוא מה שהוכיח את ההפרדה: הוא רץ מהריפו הזה בלי שורת קוד
ייעודית, ובהרצה הראשונה מצא 188 ממצאים. הוא גם חשף שלושה פרמטרים
שהיו קבועים בקוד ובאמת שייכים ל-`knowledge.conf` — `KB_GATE_MODE`,
`KB_KINDS`, `KB_CATALOG_KINDS`.

```
agents-kb-tools/            ← כאן
├── bin/
│   ├── kb-hygiene            השערים
│   ├── kb-wiki-index         רשימת ישויות · --rules <scope> · --always
│   ├── kb-workflows-index    INDEX.md של הרנבוקים
│   └── kb-build-agents       מאחד AGENTS.md ל-CLIs שקוראים קובץ אחד
├── knowledge.conf.example
└── docs/architecture.md      ← **מסמך ההכרעות. המקור.**
```

## התקנה במופע

```bash
cp agents-kb-tools/knowledge.conf.example <instance>/knowledge.conf   # ולערוך
ln -s ~/Projects/agents-kb-tools/bin/kb-hygiene <instance>/scripts/
```

הכלים מוצאים את שורש המופע לפי **`knowledge.conf` כלפי מעלה מה-cwd**, או
מ-`$KB_ROOT`. הם **אינם** גוזרים אותו מ-`__file__` — זה כל ההבדל שמאפשר
להם לרוץ על ריפו אחר.

```bash
cd <instance> && ./scripts/kb-hygiene          # לפי cwd
KB_ROOT=/path/to/instance kb-wiki-index        # מפורש
```

## מה `knowledge.conf` קובע

| | |
|---|---|
| `KB_WIKI` `KB_WORKFLOWS` `KB_HISTORY` `KB_RULES` | איפה התוכן |
| `KB_PAGE_MAX` `KB_SEGMENT_MAX` `KB_SEGMENT_FENCES` | תקרות השערים |
| `KB_MACHINE_SCOPE` `KB_ALWAYS_MARKER` | היקפי הזרקה |
| `KB_NAME_GATE` `KB_NAME_LIST` | **שער שמות — חובה בריפו-צוות** |

## למה השערים

**שער שנכשל הוא ממצא.** ב-2026-09-08 הוא נכשל שש פעמים ביום אחד, וכל
כישלון לימד כלל שנצרב ב-`bin/kb-hygiene`:

- `ראו גם` ו-`תת-ישויות` הם סעיפים מבניים — פטורים מדרישת תאריך
- `README.md` ב-`history/` הוא תיעוד השכבה, לא רשומה
- קובץ ב-`rules/` הוא **מסמך אחד**, לא אוסף מקטעים
- מקטע ארוך אינו בהכרח פרוצדורה — הסיגנל הוא **2+ בלוקי קוד**
- שם ישות שחוזר בשני מקומות = התנגשות

**מופע שיקבל עותק-הדבקה יגלה את חמשת אלה מחדש.** זו הסיבה שהריפו הזה
קיים בנפרד.

## שער השמות

`KB_NAME_GATE=on` חוסם שמות אנשים בריפו שנדחף.

הרקע: `git log -S'person_id'` עדיין מחזיר שלושה קומיטים ב-
`agents-config` **אחרי שהתוכן הועבר**. היסטוריית git אינה שוכחת — ולכן
זו הטעות היחידה במערכת שאין ממנה חזרה.

**כבוי במופע אישי. חובה במופע-צוות.**

---

**המודל המלא:** `docs/architecture.md`
