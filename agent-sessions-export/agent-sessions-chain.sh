#!/bin/sh
# agent-sessions-chain.sh — שרשרת הגיבוי המלאה.
# ‏1. ייצוא (קבצים + DB) → ‏2. דלתא SQL → ‏3. קימוט ודחיפה לכל ריפו.
# 🛑 בלי `set -e`: כשל בחוליה אחת לא אמור לבטל את מה שכבר הצליח.
#
# 🔑 נמדד 23/10/2026: הסקריפט היה נעול ל-/home/user/projects (p קטנה) —
#    הנתיב בקונטיינר של mission13 — ולריפו אחד. ⇒ על violate9, שבו הנתיב
#    הוא ~/Projects (P גדולה), שלב 2 (הדלתא) **מעולם לא רץ**, ושלב 3 כיסה
#    ריפו אחד משלושה. התוצאה: agent-sessions עם 1,560 פריטים לא-מקומטים
#    והקומיט האחרון מ-06/09, ו-agent-sessions-personal דומה.

# שורש-הפרויקטים נגזר מהמכונה ואינו קשיח.
for P in "$HOME/projects" "$HOME/Projects"; do
  [ -d "$P/agent-sessions-export" ] && ROOTS="$P" && break
done
[ -z "$ROOTS" ] && { echo "✗ לא נמצא agent-sessions-export תחת \$HOME/projects או \$HOME/Projects"; exit 1; }
cd "$ROOTS/agent-sessions-export" || exit 1
echo "שורש: $ROOTS"

echo "=== [1/3] ייצוא"
bun export.ts --apply

# 🛑 הדלתא נכתבת לריפו **אחד** — היא של ה-DB כולו, לא פר-ריפו. היעד הוא
#    הריפו הראשון שקיים מהרשימה, כדי שלא ייווצרו עותקים כפולים.
echo "=== [2/3] דלתא SQL"
for R in "$ROOTS/agent-sessions" "$ROOTS/tzlev-agent-sessions"; do
  if [ -d "$R/.git" ]; then bun dump.ts --dir "$R/dumps"; echo "  דלתא → $R/dumps"; break; fi
done

echo "=== [3/3] קימוט ודחיפה"
for R in "$ROOTS/agent-sessions" "$ROOTS/tzlev-agent-sessions" "$ROOTS/agent-sessions-personal"; do
  [ -d "$R/.git" ] || { echo "  ⏭ אינו ריפו: $R"; continue; }
  # 🛑 בלי origin — מקמטים בלבד. דחיפה הייתה נכשלת ומחזירה 1, ומסתירה
  #    את העובדה שהקימוט כן הצליח.
  if git -C "$R" remote get-url origin >/dev/null 2>&1; then
    echo "── $(basename "$R") (עם דחיפה)"; ./archive-commit.sh "$R" --push
  else
    echo "── $(basename "$R") 🔴 אין origin — קימוט מקומי בלבד"; ./archive-commit.sh "$R"
  fi
done
