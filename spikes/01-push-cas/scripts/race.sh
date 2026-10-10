#!/usr/bin/env bash
# S1 race harness: N trials of two concurrent pushes to refs/heads/main from the
# same base. Writes one TSV row per trial to stdout (header first).
#
#   REMOTE=... TOKEN=... scripts/race.sh <mode> <trials> <workdir>
#
# Modes
#   race      A and B each make a different commit on the same parent and push
#             together (plain push). Exactly one should win.
#   force     same commits, both push with --force. Shows whether the server
#             checks the old-oid in the update command or the last writer wins.
#   ffchain   B's commit sits on top of A's, so B is a fast-forward of A. Both
#             push together from the same advertised base. If both succeed the
#             server checks fast-forward only, not the old-oid.
#   lease     same commits, both push with --force-with-lease=main:<base>. The
#             lease is the end-to-end CAS a single writer would use.
#   seqforce  CONTROL. A pushes, then B pushes with --force after A finished.
#             Both succeed and A's commit is lost: the classifier must flag it.
#
# Each push records the update command it actually sent (GIT_TRACE_PACKET), so
# a success can be checked against the old-oid the client claimed.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
source "$here/lib.sh"
mode="${1:?mode}" trials="${2:?trials}" work="${3:?workdir}"
: "${REMOTE:?}" "${TOKEN:?}"

rm -rf "$work" && mkdir -p "$work" && cd "$work"
git init -q -b main A && git init -q -b main B

oneline() { tr '\t\n' '  ' | sed -E 's/ +/ /g; s/^ //; s/ $//'; }

# Keep only the meaningful stderr lines: rejections, errors, remote messages.
errtext() {
  grep -E '^( ! |fatal:|remote: (error|fatal))' "$1" | head -3 | redact | oneline
}

# The "<old> <new> <ref>" update command git sent, from the packet trace.
sent_cmd() {
  grep -Eo '> [0-9a-f]{40} [0-9a-f]{40} refs/heads/main' "$1" | head -1 | sed 's/^> //' | awk '{print substr($1,1,12)"->"substr($2,1,12)}'
}

push_one() { # <dir> <flags> <tag>
  local dir="$1" flags="$2" tag="$3" t0 t1 rc
  touch "../ready.$tag"
  if [ "$mode" != seqforce ]; then until [ -e ../go ]; do :; done; fi
  t0=$(now_ms)
  # shellcheck disable=SC2086
  (cd "$dir" && GIT_TRACE_PACKET="$PWD/../trace.$tag" agit push $flags "$REMOTE" HEAD:refs/heads/main >"../out.$tag" 2>"../err.$tag")
  rc=$?
  t1=$(now_ms)
  printf '%s\t%s\t%s\n' "$rc" "$t0" "$t1" >"../res.$tag"
}

printf 'trial\tmode\tbase\tcA\tcB\trcA\trcB\tsentA\tsentB\tdecided\thead\tskew_ms\tmsA\tmsB\toutcome\terrA\terrB\n'
for i in $(seq 1 "$trials"); do
  rm -f ready.* go res.* err.* out.* trace.*
  # Same base for both: A fetches main, B takes it from A locally.
  (cd A && agit fetch -q "$REMOTE" main && git reset -q --hard FETCH_HEAD) || { echo "fetch failed" >&2; exit 1; }
  base=$(git -C A rev-parse HEAD)
  (cd B && git fetch -q ../A "$base" && git reset -q --hard "$base")
  (cd A && echo "A $i $RANDOM" >"t$i.txt" && git add -A && git commit -q -m "A trial $i")
  cA=$(git -C A rev-parse HEAD)
  if [ "$mode" = ffchain ]; then
    (cd B && git fetch -q ../A "$cA" && git reset -q --hard "$cA" && echo "B $i" >"u$i.txt" && git add -A && git commit -q -m "B trial $i on A")
  else
    (cd B && echo "B $i $RANDOM" >"t$i.txt" && git add -A && git commit -q -m "B trial $i")
  fi
  cB=$(git -C B rev-parse HEAD)

  flagsA="" flagsB=""
  [ "$mode" = force ] && flagsA="--force" flagsB="--force"
  [ "$mode" = seqforce ] && flagsB="--force"
  [ "$mode" = lease ] && flagsA="--force-with-lease=main:$base" flagsB="--force-with-lease=main:$base"
  cd A
  if [ "$mode" = seqforce ]; then
    push_one . "$flagsA" A
    cd ../B && push_one . "$flagsB" B && cd ..
  else
    push_one . "$flagsA" A &
    (cd ../B && push_one . "$flagsB" B) &
    until [ -e ../ready.A ] && [ -e ../ready.B ]; do :; done
    touch ../go
    wait
    cd ..
  fi

  IFS=$'\t' read -r rcA sA eA <res.A
  IFS=$'\t' read -r rcB sB eB <res.B
  head=$(remote_ref refs/heads/main)
  skew=$(( sA > sB ? sA - sB : sB - sA ))
  # "server" when both update commands reached the server with the same
  # old-oid (a real server-side race); "client" when one push saw the other's
  # result in its ref advertisement and git refused it locally.
  sentA=$(sent_cmd trace.A) sentB=$(sent_cmd trace.B)
  if [ -n "$sentA" ] && [ -n "$sentB" ] && [ "${sentA%%->*}" = "${sentB%%->*}" ]; then decided=server; else decided=client; fi

  # Classify. A success is a push whose exit code is 0.
  if [ "$rcA" = 0 ] && [ "$rcB" = 0 ]; then outcome=BOTH_OK
  elif [ "$rcA" = 0 ]; then outcome=A_WON
  elif [ "$rcB" = 0 ]; then outcome=B_WON
  else outcome=NONE_WON; fi
  case "$outcome" in
    A_WON) [ "$head" = "$cA" ] || outcome="VIOLATION_HEAD_NOT_WINNER";;
    B_WON) [ "$head" = "$cB" ] || outcome="VIOLATION_HEAD_NOT_WINNER";;
    BOTH_OK)
      if [ "$mode" = ffchain ] && [ "$head" = "$cB" ]; then outcome=BOTH_OK_FF
      else outcome=VIOLATION_BOTH_OK; fi;;
  esac
  if [ "$head" != "$cA" ] && [ "$head" != "$cB" ]; then outcome="VIOLATION_HEAD_FOREIGN"; fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$i" "$mode" "${base:0:12}" "${cA:0:12}" "${cB:0:12}" "$rcA" "$rcB" \
    "$sentA" "$sentB" "$decided" "${head:0:12}" "$skew" \
    "$((eA - sA))" "$((eB - sB))" "$outcome" "$(errtext err.A)" "$(errtext err.B)"
done
