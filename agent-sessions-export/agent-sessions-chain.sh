#!/bin/sh
# agent-sessions-chain.sh — שרשרת הגיבוי המלאה, בתוך הקונטיינר.
# ‏1. ייצוא (קבצים + DB) → ‏2. דלתא SQL → ‏3. קימוט ודחיפה.
# 🛑 בלי `set -e`: כשל בחוליה אחת לא אמור לבטל את מה שכבר הצליח.
R=/home/user/projects/tzlev-agent-sessions
cd /home/user/projects/agent-sessions-export || exit 1
echo "=== [1/3] ייצוא"
bun export.ts --apply
echo "=== [2/3] דלתא SQL"
bun dump.ts --dir "$R/dumps"
echo "=== [3/3] קימוט ודחיפה"
./archive-commit.sh "$R" --push
