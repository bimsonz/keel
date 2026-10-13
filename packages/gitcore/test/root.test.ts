// A root commit GitCore writes, read by git itself: one commit with no
// parent and one file, pushed into an empty repository, verified against the
// signers file when signed, and the same commit every time for the same spec.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ZERO_OID } from "../src/bytes.ts";
import { writePack } from "../src/pack-write.ts";
import { receivePack } from "../src/push.ts";
import { rootCommit, type RootSpec } from "../src/root.ts";
import { allowedSigners, importSshSigningKey, sshSignature } from "../src/sshsig.ts";
import { git, gitSync, smartHttp, sshKeyPair, tempRepo } from "./git-harness.ts";

const PRINCIPAL = "keel@keel.test";
const AT = 1_760_000_000;
const MAIN = "refs/heads/main";

const scratch = mkdtempSync(join(tmpdir(), "keel-root-"));
const keel = sshKeyPair(scratch, "keel");
const stranger = sshKeyPair(scratch, "stranger");
const repos: { readonly dir: string; readonly cleanup: () => void }[] = [];

afterAll(() => {
  for (const repo of repos) repo.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const spec = (over: Partial<RootSpec> = {}): RootSpec => ({
  path: "README.md",
  content: "# forge\n",
  message: "Start forge",
  author: { name: "Keel", email: PRINCIPAL, time: AT },
  committer: { name: "Keel", email: PRINCIPAL, time: AT },
  ...over,
});

const signedBy = async (pkcs8Pem: string): Promise<NonNullable<RootSpec["sign"]>> => {
  const key = await importSshSigningKey(pkcs8Pem);
  return (unsigned) => sshSignature(key, unsigned);
};

/** Pushes the root commit into a fresh, empty repository as its main, as a new ref. */
async function pushed(root: Awaited<ReturnType<typeof rootCommit>>) {
  const repo = tempRepo();
  repos.push(repo);
  const outcome = await receivePack(
    {
      url: "https://git.invalid/repo",
      token: "unused",
      fetch: smartHttp({ repo: repo.dir }).fetch,
    },
    [{ ref: MAIN, old: ZERO_OID, new: root.oid }],
    await writePack(root.objects),
  );
  return { dir: repo.dir, outcome };
}

let files = 0;
/** Whether stock git verifies `commit` against a signers file naming `publicKey` for Keel. */
function verified(dir: string, commit: string, publicKey: string) {
  const signersFile = join(scratch, `signers-${++files}`);
  writeFileSync(signersFile, allowedSigners(PRINCIPAL, [{ publicKey }]));
  const run = gitSync(
    ["-c", `gpg.ssh.allowedSignersFile=${signersFile}`, "verify-commit", commit],
    {
      cwd: dir,
      env: { TZ: "UTC" },
    },
  );
  return run.status === 0;
}

describe("rootCommit", () => {
  it("[gitcore.root-commit] is one commit with no parent and one file, which git takes into an empty repository and verifies", async () => {
    const root = await rootCommit(spec({ sign: await signedBy(keel.pkcs8Pem) }));
    const { dir, outcome } = await pushed(root);
    expect(outcome.kind).toBe("applied");
    expect(git(dir, ["rev-parse", MAIN]).trim()).toBe(root.oid);
    expect(git(dir, ["rev-list", "--all"]).trim().split("\n")).toEqual([root.oid]);
    expect(git(dir, ["rev-list", "--max-parents=0", MAIN]).trim()).toBe(root.oid);
    expect(git(dir, ["ls-tree", "-r", MAIN]).trim()).toMatch(
      /^100644 blob [0-9a-f]{40}\tREADME\.md$/,
    );
    expect(git(dir, ["rev-parse", `${MAIN}^{tree}`]).trim()).toBe(root.tree);
    expect(git(dir, ["show", `${MAIN}:README.md`])).toBe("# forge\n");
    expect(git(dir, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%at %ct|%B", MAIN]).trim()).toBe(
      `Keel <${PRINCIPAL}>|Keel <${PRINCIPAL}>|${AT} ${AT}|Start forge`,
    );
    expect(gitSync(["fsck", "--strict", "--no-dangling"], { cwd: dir }).status).toBe(0);
    expect(verified(dir, root.oid, keel.publicKey)).toBe(true);
    // The controls: another key's signers file refuses it, and an unsigned root verifies against nothing.
    expect(verified(dir, root.oid, stranger.publicKey)).toBe(false);
    const unsigned = await rootCommit(spec());
    const bare = await pushed(unsigned);
    expect(bare.outcome.kind).toBe("applied");
    expect(verified(bare.dir, unsigned.oid, keel.publicKey)).toBe(false);
    expect(unsigned.oid).not.toBe(root.oid);
  });

  it("[gitcore.root-commit] is the same commit for the same spec, and another for another name, time or key", async () => {
    const sign = await signedBy(keel.pkcs8Pem);
    const root = await rootCommit(spec({ sign }));
    expect((await rootCommit(spec({ sign }))).oid).toBe(root.oid);
    const others = await Promise.all([
      rootCommit(spec({ sign, content: "# forge-2\n" })),
      rootCommit(spec({ sign, message: "Start forge-2" })),
      rootCommit(spec({ sign, committer: { name: "Keel", email: PRINCIPAL, time: AT + 1 } })),
      rootCommit(spec({ sign, author: { name: "Keel", email: PRINCIPAL, time: AT + 1 } })),
      rootCommit(spec({ sign: await signedBy(stranger.pkcs8Pem) })),
    ]);
    expect(new Set([root.oid, ...others.map((o) => o.oid)]).size).toBe(6);
  });

  it("[gitcore.root-commit] refuses a file that is not at the top of its tree", async () => {
    await expect(rootCommit(spec({ path: "docs/README.md" }))).rejects.toThrow("top of its tree");
    await expect(rootCommit(spec({ path: "" }))).rejects.toThrow("top of its tree");
  });
});
