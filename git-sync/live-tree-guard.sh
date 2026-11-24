#!/bin/sh
# live-tree-guard — a commit hook for a working tree that is a read-only mirror.
#
# Call it from pre-commit and pre-merge-commit. It is active only when the
# repository sets `git config gitsync.liveTree true`, and only in the main working tree:
# linked worktrees, where the work is supposed to happen, pass through.
# `git pull --ff-only` creates no commit and does not run these hooks.
#
# An optional repository-specific hint (a rule or a runbook path) is printed
# from `git config gitsync.liveTreeHelp`.
live=$(git config --bool gitsync.liveTree 2>/dev/null)
[ "$live" = "true" ] || exit 0
top=$(git rev-parse --show-toplevel)
common=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
[ "$(cd "$top" && pwd -P)/.git" = "$common" ] || exit 0
cat >&2 <<'MSG'
🛑 זה העץ החי — מראה של main לקריאה בלבד. אין קומיט או מיזוג כאן,
   ואין לעקוף עם --no-verify.
   לעבוד ב־worktree משלך:
     git worktree add .worktrees/<משימה> -b <ענף> origin/main
   ולדחוף משם: git push origin HEAD:main
   עדכון העץ החי: git pull --ff-only בלבד.
MSG
help=$(git config gitsync.liveTreeHelp 2>/dev/null)
[ -n "$help" ] && printf '   פירוט: %s\n' "$help" >&2
exit 1
