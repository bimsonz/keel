// What runs inside MergeBox, the container that composes what GitCore will
// not: stock git's `merge-tree` per member, chained by unsigned commits and
// pushed to a scratch ref of staging. Keel then writes the signed commits over
// the trees it reports (`restackOnTrees`). The box never holds a credential:
// every remote is plain HTTPS, and keel's egress adds a token on the way out.
//
// Its answers are lines on stdout, read by `readBoxCompose`; the check of what
// the box holds after a compose is read by `scanBoxCheck`.

/** Where the plant script marks the box's start; the check reads every file written after it. */
export const BOX_BOOT_MARK = "/root/.keel-boot";

/** The file the canary is planted in, beside the environment it is started with. */
export const BOX_CANARY_FILE = "/root/.keel-canary";

/** The most the check streams back; past it the check is refused as a defect, never passed. */
export const BOX_CHECK_CAP_BYTES = 8 * 1024 * 1024;

/** The exit of a compose script that could not fetch or push: the box's transport, not the batch. */
export const BOX_TRANSPORT_EXIT = 3;

/**
 * $1 the canary. Marks the start, then plants the canary in a file, so the
 * check can show it reads both the environment and the files it searches.
 */
export const BOX_PLANT_SCRIPT = `set -eu
: > ${BOX_BOOT_MARK}
sleep 0.01
printf '%s\\n' "$1" > ${BOX_CANARY_FILE}`;

/**
 * $1 staging's remote, $2 the candidate's base, $3 the scratch ref, then for
 * each member its workspace's remote, its base and its head. Sweeps staging's
 * leftover scratch refs, fetches what it needs by id, merges each member onto
 * the fold so far on the member's own base, and chains each tree by an
 * unsigned commit only so the next merge has a parent. Prints `tree <i>
 * <oid>` per member and `pushed <tip>` once the chain is on the scratch ref;
 * on a conflict `refused <i>` and a `path <p>` line per conflicted path, and
 * exits 1. A git that dies by a signal exits with its own status (over 128);
 * a fetch or a push that fails exits ${BOX_TRANSPORT_EXIT}.
 */
export const BOX_COMPOSE_SCRIPT = `set -u
staging=$1; base=$2; scratch=$3; shift 3
fail() { rc=$1; shift; printf '%s\\n' "$*" >&2; [ "$rc" -gt 128 ] && exit "$rc"; exit ${BOX_TRANSPORT_EXIT}; }
dir=$(mktemp -d "$HOME/box.XXXXXX") || exit ${BOX_TRANSPORT_EXIT}
git init -q --bare "$dir" || exit ${BOX_TRANSPORT_EXIT}
cd "$dir" || exit ${BOX_TRANSPORT_EXIT}
left=$(git ls-remote --refs "$staging" 'refs/keel/box/*' | cut -f2) || fail $? "staging's refs were not listed"
if [ -n "$left" ]; then
  # A leftover is a compose before this one: the box composes one batch of a project at a time.
  git push -q "$staging" $(printf ':%s ' $left) 2>/dev/null || true
  printf 'swept %s\\n' "$(printf '%s\\n' "$left" | grep -c .)"
fi
git fetch -q --no-tags --no-write-fetch-head "$staging" "$base" || fail $? "staging's base was not fetched"
tip=$base; i=0
while [ $# -ge 3 ]; do
  remote=$1; mbase=$2; head=$3; shift 3
  git fetch -q --no-tags --no-write-fetch-head "$remote" "$mbase" "$head" || fail $? "member $i was not fetched"
  out=$(git merge-tree --write-tree --name-only --no-messages --merge-base="$mbase" "$tip" "$head"); rc=$?
  if [ $rc -eq 1 ]; then
    printf 'refused %s\\n' "$i"
    printf '%s\\n' "$out" | tail -n +2 | sed -n 's/^\\(..*\\)$/path \\1/p'
    exit 1
  fi
  [ $rc -eq 0 ] || fail $rc "merge-tree of member $i exited $rc"
  tree=$(printf '%s\\n' "$out" | head -n 1)
  tip=$(git commit-tree "$tree" -p "$tip" -m "mergebox $i") || fail $? "member $i was not chained"
  printf 'tree %s %s\\n' "$i" "$tree"
  i=$((i + 1))
done
git push -q "$staging" "$tip:$scratch" || fail $? "the chain was not pushed"
printf 'pushed %s\\n' "$tip"`;

/**
 * Streams back everything a token could sit in: the start environment
 * (\`/proc/1/environ\`), the exec's own (\`env\`), and every regular file
 * written since the box started, but for git's object storage (compressed and
 * addressed by content, and the bulk of it). Capped one byte past
 * ${BOX_CHECK_CAP_BYTES}, so an answer over the cap is seen as one.
 */
export const BOX_CHECK_SCRIPT = `{
  printf '=== environ\\n'; tr '\\0' '\\n' < /proc/1/environ
  printf '\\n=== env\\n'; env
  printf '\\n=== files\\n'
  find / -xdev -type f -newer ${BOX_BOOT_MARK} ! -path '*/objects/*' -print0 2>/dev/null |
    while IFS= read -r -d '' f; do printf '\\n--- %s\\n' "$f"; cat -- "$f" 2>/dev/null; done
} | head -c ${BOX_CHECK_CAP_BYTES + 1}`;

/** One member of a box compose: where its objects are, its own base and its head. */
export interface BoxMember {
  readonly remote: string;
  readonly base: string;
  readonly head: string;
}

/** The compose script's arguments, in its order. */
export const boxComposeArgs = (
  staging: string,
  base: string,
  scratch: string,
  members: readonly BoxMember[],
): string[] => [staging, base, scratch, ...members.flatMap((m) => [m.remote, m.base, m.head])];

/** What a compose script's run came to. */
export type BoxCompose =
  | { readonly kind: "composed"; readonly trees: readonly string[]; readonly tip: string }
  | { readonly kind: "refused"; readonly member: number; readonly paths: readonly string[] }
  /** git died by a signal: asked once, never again, since the same inputs kill it the same way. */
  | { readonly kind: "crashed"; readonly exitCode: number }
  /** The box could not fetch, push, or say what it did: nothing about the batch. */
  | { readonly kind: "failed"; readonly exitCode: number; readonly reason: string };

const OID = /^[0-9a-f]{40}$/;

/** Reads a compose script's run from its exit code and stdout, given how many members it was asked. */
export function readBoxCompose(exitCode: number, stdout: string, members: number): BoxCompose {
  const lines = stdout.split("\n").filter((line) => line !== "");
  if (exitCode > 128) return { kind: "crashed", exitCode };
  if (exitCode === 1) {
    const refused = lines.find((line) => line.startsWith("refused "));
    const member = Number(refused?.slice("refused ".length));
    if (refused === undefined || !Number.isInteger(member))
      return { kind: "failed", exitCode, reason: "the box exited 1 and named no member" };
    const paths = lines.flatMap((line) => (line.startsWith("path ") ? [line.slice(5)] : []));
    return { kind: "refused", member, paths };
  }
  if (exitCode !== 0) return { kind: "failed", exitCode, reason: `the box exited ${exitCode}` };
  const trees: string[] = [];
  for (const line of lines) {
    const [word, at, oid] = line.split(" ");
    if (word === "tree" && Number(at) === trees.length && oid !== undefined && OID.test(oid))
      trees.push(oid);
  }
  const tip = lines.find((line) => line.startsWith("pushed "))?.slice("pushed ".length) ?? "";
  if (trees.length !== members || !OID.test(tip))
    return {
      kind: "failed",
      exitCode,
      reason: `the box reported ${trees.length} of ${members} trees${OID.test(tip) ? "" : " and no pushed chain"}`,
    };
  return { kind: "composed", trees, tip };
}

/** What the check found: what MergeBox records on the candidate. */
export interface BoxCheck {
  readonly canary: "found";
  readonly tokens: "none";
}

/** Why a check does not pass: each is a defect, and the candidate is refused. */
export type BoxCheckFailure =
  /** The canary was not seen where it was planted: the check could not see what it searched. */
  | { readonly kind: "blind"; readonly missing: readonly ("environ" | "file")[] }
  | { readonly kind: "token-found"; readonly sections: readonly string[] }
  | { readonly kind: "over-cap"; readonly bytes: number };

/** A token's shape on Artifacts, whoever minted it. */
const TOKEN_SHAPE = /art_v\d+_[A-Za-z0-9_]+/g;

/**
 * Reads the check's stream: the canary must be in the start environment and
 * in its file, and no token minted for the compose, nor anything shaped as an
 * Artifacts token but the canary, may be anywhere in it.
 */
export function scanBoxCheck(
  stream: string,
  canary: string,
  minted: readonly string[],
): BoxCheck | BoxCheckFailure {
  const bytes = new TextEncoder().encode(stream).length;
  if (bytes > BOX_CHECK_CAP_BYTES) return { kind: "over-cap", bytes };
  const sections = new Map<string, string>();
  for (const part of stream.split(/^=== /m).slice(1)) {
    const end = part.indexOf("\n");
    sections.set(part.slice(0, end), part.slice(end + 1));
  }
  const environ = sections.get("environ") ?? "";
  const files = sections.get("files") ?? "";
  const canaryFile = files.split(/^--- /m).find((file) => file.startsWith(`${BOX_CANARY_FILE}\n`));
  const missing = [
    ...(environ.includes(canary) ? [] : (["environ"] as const)),
    ...(canaryFile?.includes(canary) === true ? [] : (["file"] as const)),
  ];
  if (missing.length > 0) return { kind: "blind", missing };
  const holding = [...sections].flatMap(([name, text]) =>
    minted.some((token) => token !== "" && text.includes(token)) ||
    [...text.matchAll(TOKEN_SHAPE)].some(([seen]) => seen !== canary)
      ? [name]
      : [],
  );
  if (holding.length > 0) return { kind: "token-found", sections: holding };
  return { canary: "found", tokens: "none" };
}
