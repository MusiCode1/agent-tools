#!/usr/bin/env bash
# Tests for heavy-run. Each test runs with its own lock dir.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
hr="$here/heavy-run"
fails=0
pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

newdir() { mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/heavy-run-test.XXXXXX"; }

# 1. exit code is propagated
d=$(newdir)
HEAVY_RUN_DIR=$d "$hr" -- sh -c 'exit 7' 2>/dev/null; rc=$?
[[ $rc == 7 ]] && pass "exit code propagated" || fail "exit code propagated (got $rc)"

# 2. deployment env is stripped, other env kept
out=$(HEAVY_RUN_DIR=$d DC_DEPLOYMENT=main PORT=4000 KEEP_ME=yes "$hr" -- sh -c 'echo "${DC_DEPLOYMENT:-unset} ${PORT:-unset} ${KEEP_ME:-unset}"' 2>/dev/null)
[[ "$out" == "unset unset yes" ]] && pass "env stripped" || fail "env stripped (got '$out')"

# 3. --keep-env keeps it
out=$(HEAVY_RUN_DIR=$d DC_DEPLOYMENT=main "$hr" --keep-env -- sh -c 'echo "${DC_DEPLOYMENT:-unset}"' 2>/dev/null)
[[ "$out" == "main" ]] && pass "--keep-env" || fail "--keep-env (got '$out')"

# 4. queue serializes with one slot
d=$(newdir); log="$d/log"
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" --label a -- sh -c "echo a-start >>$log; sleep 3; echo a-end >>$log" 2>/dev/null &
sleep 0.5
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" --label b -- sh -c "echo b-start >>$log; echo b-end >>$log" 2>"$d/b.err" &
wait
order=$(tr '\n' ' ' < "$log")
[[ "$order" == "a-start a-end b-start b-end " ]] && pass "queue serializes" || fail "queue serializes (got '$order')"
grep -q 'waiting in queue' "$d/b.err" && pass "waiter announces holder" || fail "waiter announces holder"
grep -q '\[a ·' "$d/b.err" && pass "waiter names the running job" || fail "waiter names the running job ($(cat "$d/b.err"))"

# 5. two slots run in parallel
d=$(newdir); log="$d/log"
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=2 "$hr" -- sh -c "echo a-start >>$log; sleep 2; echo a-end >>$log" 2>/dev/null &
sleep 0.5
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=2 "$hr" -- sh -c "echo b-start >>$log; echo b-end >>$log" 2>/dev/null &
wait
order=$(tr '\n' ' ' < "$log")
[[ "$order" == "a-start b-start b-end a-end " ]] && pass "two slots in parallel" || fail "two slots in parallel (got '$order')"

# 6. --preview does not take a slot
d=$(newdir); log="$d/log"
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" -- sh -c "sleep 2; echo held-end >>$log" 2>/dev/null &
sleep 0.5
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" --preview -- sh -c "echo preview >>$log" 2>/dev/null
wait
order=$(tr '\n' ' ' < "$log")
[[ "$order" == "preview held-end " ]] && pass "--preview skips queue" || fail "--preview skips queue (got '$order')"

# 7. a dead holder does not block (lock released with the process)
d=$(newdir)
HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" --label t7dead -- sh -c 'sleep 30' 2>/dev/null & pid=$!
sleep 0.5; kill -9 $pid 2>/dev/null
# the scope child inherited the lock fd; kill exactly this test's scope
systemctl --user kill --signal=KILL "heavy-run-t7dead-$pid.scope" 2>/dev/null
sleep 1
timeout 10 env HEAVY_RUN_DIR=$d HEAVY_RUN_SLOTS=1 "$hr" -- true 2>/dev/null; rc=$?
[[ $rc == 0 ]] && pass "dead holder releases slot" || fail "dead holder releases slot (rc $rc)"

# 8. memory cap kills an over-allocating command
d=$(newdir)
HEAVY_RUN_DIR=$d "$hr" --mem-max 80M --swap-max 0 -- python3 -c 'b = bytearray(400*1024*1024); print(len(b))' >/dev/null 2>"$d/err"; rc=$?
[[ $rc != 0 ]] && pass "memory cap enforced (rc $rc)" || fail "memory cap enforced"
grep -q 'memory cap' "$d/err" && pass "memory-cap hint printed" || fail "memory-cap hint printed ($(cat "$d/err"))"

# 9. status runs
st=$(HEAVY_RUN_DIR=$d "$hr" status)
[[ "$st" == slots:* ]] && pass "status" || fail "status (got '$st')"

echo
(( fails == 0 )) && echo "all passed" || echo "$fails failed"
exit $(( fails > 0 ))
