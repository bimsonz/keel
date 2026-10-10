// Shell scripts the Durable Object runs inside the container with exec().
// Each runs as `bash -c <script> box <args...>`, so $1.. are the arguments.

const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
const BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
const SYSTEM = '/etc/ssl/certs/ca-certificates.system.crt';

/**
 * Trust the per-container intercept CA: keep a pristine copy of the system
 * bundle, wait up to 10 s for the CA, and rebuild the bundle from the copy plus
 * this container's CA (a snapshot carries the previous container's bundle).
 */
export const TRUST_SCRIPT = `set -e
[ -e ${SYSTEM} ] || { cp ${BUNDLE} ${SYSTEM}.tmp && mv ${SYSTEM}.tmp ${SYSTEM}; }
timeout 10 sh -c 'until [ -s ${CA} ]; do sleep 0.1; done'
cat ${SYSTEM} ${CA} > ${BUNDLE}.tmp && mv ${BUNDLE}.tmp ${BUNDLE}`;

/** $1 remote (no credentials), $2 run name. Prints one JSON line last. */
export const VERIFY_SCRIPT = `set -uo pipefail
ms() { date +%s%3N; }
emit() {
  node -e 'const o={};for(const a of process.argv.slice(1)){const i=a.indexOf("=");const v=a.slice(i+1);o[a.slice(0,i)]=/^-?[0-9]+$/.test(v)?Number(v):v}console.log(JSON.stringify(o))' "$@"
}
remote="$1"; dir="/work/$2"
rm -rf "$dir" "$dir.report.json" "$dir.test.log"
t0=$(ms)
timeout 120 git clone -q "$remote" "$dir" 2>/tmp/clone.err; clone=$?
t1=$(ms)
if [ $clone -ne 0 ]; then cat /tmp/clone.err >&2; emit phase=clone clone=$clone cloneMs=$((t1-t0)); exit 1; fi
cd "$dir"
tree=$(git merge-tree --write-tree origin/agent-a origin/agent-b); mt=$?
t2=$(ms)
if [ $mt -ne 0 ]; then emit phase=merge-tree mergeTreeExit=$mt out="$tree" cloneMs=$((t1-t0)); exit 1; fi
commit=$(git commit-tree "$tree" -p origin/agent-a -p origin/agent-b -m "keel: merge agent-a + agent-b")
git checkout -q --detach "$commit"; co=$?
headTree=$(git rev-parse 'HEAD^{tree}')
t3=$(ms)
if [ "$(sha256sum pnpm-lock.yaml | cut -c1-64)" = "$(cat /opt/forge-deps/.lock-sha)" ]; then
  ln -s /opt/forge-deps/node_modules node_modules; deps=prebaked
else
  deps=lockfile-mismatch
fi
t4=$(ms)
timeout 300 pnpm test --reporter=json --outputFile="$dir.report.json" >"$dir.test.log" 2>&1; test=$?
t5=$(ms)
counts=$(node -e 'try{const r=require(process.argv[1]);console.log(r.numPassedTests,r.numFailedTests,r.numTotalTests,r.success)}catch{console.log("0 0 0 false")}' "$dir.report.json")
set -- $counts
[ $test -eq 0 ] || tail -c 1200 "$dir.test.log" >&2
emit phase=done clone=$clone mergeTreeExit=$mt tree=$tree headTree=$headTree commit=$commit checkout=$co deps=$deps \\
  testExit=$test passed=$1 failed=$2 total=$3 success=$4 \\
  cloneMs=$((t1-t0)) mergeTreeMs=$((t2-t1)) checkoutMs=$((t3-t2)) depsMs=$((t4-t3)) testMs=$((t5-t4)) totalMs=$((t5-t0))`;

/** $1 remote. What git in the container sends and gets back, header lines only. */
export const TRACE_SCRIPT = `GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 git ls-remote "$1" >/tmp/ls-remote.out 2>/tmp/ls-remote.trace
rc=$?
grep -iE '(=> Send header|<= Recv header): ((GET|POST) |Host:|authorization|HTTP/|x-keel-egress|www-authenticate)' /tmp/ls-remote.trace
echo "ls-remote exit=$rc refs=$(wc -l < /tmp/ls-remote.out)"
cat /tmp/ls-remote.out`;

/**
 * Every place a token could sit. Sections start with "=== name"; every other
 * non-empty line that does not start with "# " is a hit.
 */
export const CHECK_SCRIPT = `P='art_v[0-9]+_'
echo "=== env"; env | grep -E "$P"
echo "=== proc-environ"
for f in /proc/[0-9]*/environ; do
  hits=$(tr '\\0' '\\n' < "$f" 2>/dev/null | grep -E "$P")
  [ -n "$hits" ] && printf '%s: %s\\n' "$f" "$hits"
done
echo "=== git-config"
for d in /work/*/.git; do
  [ -d "$d" ] || continue
  echo "# $d/config"
  grep -inE "$P|extraheader|authorization|bearer" "$d/config"
done
echo "=== git-credentials"
for f in /root/.git-credentials /root/.gitconfig /etc/gitconfig /root/.config/git/credentials /root/.config/git/config; do
  [ -e "$f" ] || continue
  echo "# $f"
  grep -inE "$P|extraheader|authorization|bearer|https://" "$f"
done
echo "=== tmp"; grep -r -a -o -E "\${P}[A-Za-z0-9_]*" /tmp 2>/dev/null
echo "=== fs"; grep -r -a -o -E -s "\${P}[A-Za-z0-9_]*" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null | head -50
echo "=== end"
true`;

/** $1 canary. Plant a fake token everywhere the checks look. */
export const PLANT_CANARY_SCRIPT = `set -u
c="$1"
printf '%s\\n' "$c" > /tmp/canary-token
printf 'https://x:%s@example.invalid\\n' "$c" > /root/.git-credentials
for d in /work/*/.git; do [ -d "$d" ] && git -C "\${d%/.git}" config http.extraHeader "Authorization: Bearer $c"; done
mkdir -p /opt/planted && printf 'TOKEN=%s\\n' "$c" > /opt/planted/app.env
echo planted`;

/** $1 Artifacts host, $2 repo path. */
export const EGRESS_SCRIPT = `probe() {
  local name=$1; shift
  local s; s=$(date +%s%3N)
  local out; out=$("$@" 2>&1); local rc=$?
  printf '%-24s rc=%-3s ms=%-6s %s\\n' "$name" "$rc" "$(( $(date +%s%3N) - s ))" "$(printf '%s' "$out" | tr '\\n' ' ' | tail -c 160)"
}
C='curl -sS -m 10 -o /dev/null -w %{http_code}'
probe https://example.com $C https://example.com/
probe http://example.com $C http://example.com/
probe https://registry.npmjs.org $C https://registry.npmjs.org/
probe https://1.1.1.1 $C https://1.1.1.1/
probe dns:example.com timeout 10 getent hosts example.com
probe artifacts:this-repo $C "https://$1$2/info/refs?service=git-upload-pack"
probe artifacts:other-repo $C "https://$1/git/keel-spike-04/other.git/info/refs?service=git-upload-pack"
true`;

/** $1 run name (an existing checkout from VERIFY_SCRIPT). Plain `vitest run`, default reporter. */
export const VITEST_SCRIPT = `cd "/work/$1" && ./node_modules/.bin/vitest run 2>&1 | grep -E 'Tests|Test Files|Duration'`;
