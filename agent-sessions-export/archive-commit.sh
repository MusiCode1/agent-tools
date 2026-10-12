#!/usr/bin/env bash
# archive-commit.sh — מקמט ודוחף את ארכיון-הסשנים של הריפו הייעודי.
#
# למה זה קיים: הייצוא כותב קבצים, אבל **שום דבר לא קימט אותם**. נמדד
# 30/09/2026 שהארכיון קומט 6 פעמים בלבד, והאחרון 5 שבועות קודם — כלומר
# 258 קבצים ישבו לא-מגובים. הטיימר כותב; הסקריפט הזה סוגר את המעגל.
#
#   archive-commit.sh <repo-root> [--push]
#
# 🛑 בלי `git add -A`/`git add .` — רק שני הנתיבים המפורשים (כלל 170).
set -euo pipefail
ROOT="${1:?שימוש: archive-commit.sh <repo-root> [--push]}"
PUSH="${2:-}"
cd "$ROOT"

# 🛑 זהות: לא רק ל-commit. ‏`git pull --rebase` **חייב** אותה גם כשהקומיטים
#    הקיימים נוצרו עם `-c` בשורת-הפקודה, ובלעדיה הוא נופל ב-"empty ident
#    name" **אחרי** שהקומיט כבר נוצר — כלומר קומיט מקומי בלי דחיפה.
#    נמדד 12/10/2026 בקונטיינר של mission13.
ID='-c user.name=agent-sessions -c user.email=noreply@local'

# 🛑 שארית rebase מריצה קודמת שנכשלה חוסמת **כל** ריצה הבאה, לנצח:
#    `git pull --rebase` מסרב להתחיל ומחזיר "already a rebase-merge
#    directory". ⇒ הגיבוי נתקע בשקט עד שאדם יסתכל. נמדד 12/10/2026.
#    לא ל-`--abort` — הוא היה מוחק קומיט תקין שכבר נוצר. רק להסיר את
#    התיקייה, בדיוק כמו שגיט עצמו מציע.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  # 🛑 ומה שעלה ביוקר: הסרת התיקייה לבדה משאירה **HEAD מנותק**, כי
  #    רק היא זוכרת לאיזה ענף לחזור. ‏`git status -sb` אומר
  #    "## HEAD (no branch)", ו-`rev-parse --abbrev-ref HEAD` מחזיר
  #    "HEAD" ⇒ `git pull origin HEAD` נופל ב-128. הענף נקרא מ-head-name.
  BR=$(cat .git/rebase-merge/head-name 2>/dev/null || cat .git/rebase-apply/head-name 2>/dev/null || true)
  BR=${BR#refs/heads/}
  echo "⚠️  שארית rebase מריצה קודמת — מנקה ומחזיר ל-${BR:-?} (HEAD $(git rev-parse --short HEAD))"
  rm -rf .git/rebase-merge .git/rebase-apply
  [ -n "$BR" ] && git checkout -q -B "$BR" HEAD
fi

# ‏HEAD מנותק מכל סיבה אחרת — **עוצרים בקול**. דחיפה מ-HEAD מנותק או
# מקמטת לשום ענף, או דוחפת ענף שלא התכוונו אליו.
if ! git symbolic-ref -q HEAD >/dev/null; then
  echo "✗ HEAD מנותק ב-$(git rev-parse --short HEAD) — לא נוגע. לטפל ידנית."
  exit 1
fi

git add -- data dumps 2>/dev/null || git add -- data
if git diff --cached --quiet; then
  echo "אין שינוי בארכיון — לא קומט."
else
  N=$(git diff --cached --name-only | wc -l)
  git $ID commit -q -m "(ארכיון) ייצוא אוטומטי — $N קבצים · $(date -u +%Y-%m-%d)"
  echo "קומט: $N קבצים"
fi

# 🛑 "אין מה לקמט" **אינו** "אין מה לדחוף". ריצה שקומטה ונכשלה בדחיפה
#    משאירה קומיט מקומי; אם היציאה כאן מוקדמת, הוא לא יידחף **לעולם** —
#    הריצות הבאות לא יראו שינוי לקמט ויצאו באפס. נמדד 12/10/2026: קומיט
#    810cadc נשאר כך שלוש ריצות. לכן הדחיפה נשענת על `@{u}..HEAD`, לא על
#    "האם קומטתי עכשיו".
if [ "$PUSH" = "--push" ]; then
  # 🛑 שני כותבים לאותו ענף: ‏violate9 כותב `data/srv1812097/**` ו-mission13
  #    כותב `data/netcup-tzlev/**` + `dumps/`. הם לא נוגעים באותם קבצים,
  #    ולכן rebase כאן בטוח — אבל **בלעדיו הדחיפה נדחית ב-non-fast-forward**
  #    וכל הגיבוי נתקע בשקט עד שמישהו יסתכל ביומן.
  git $ID pull --rebase -q origin "$(git rev-parse --abbrev-ref HEAD)" || {
    echo "✗ rebase נכשל — לא נדחף. לטפל ידנית."; exit 1; }
  AHEAD=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l)
  if [ "$AHEAD" -eq 0 ]; then echo "עדכני מול origin — אין מה לדחוף."; exit 0; fi
  git push -q origin HEAD
  echo "נדחף: $AHEAD קומיטים"
fi
