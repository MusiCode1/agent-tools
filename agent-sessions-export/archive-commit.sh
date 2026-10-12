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

git add -- data dumps 2>/dev/null || git add -- data
if git diff --cached --quiet; then
  echo "אין שינוי בארכיון — לא קומט."
  exit 0
fi
N=$(git diff --cached --name-only | wc -l)
git -c user.name="agent-sessions" -c user.email="noreply@local" \
    commit -q -m "(ארכיון) ייצוא אוטומטי — $N קבצים · $(date -u +%Y-%m-%d)"
echo "קומט: $N קבצים"

if [ "$PUSH" = "--push" ]; then
  AHEAD=$(git log --oneline @{u}..HEAD 2>/dev/null | wc -l)
  git push -q origin HEAD
  echo "נדחף: $AHEAD קומיטים"
fi
