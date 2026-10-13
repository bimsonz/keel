// GitCore's SSH signatures against OpenSSH and git themselves: a signature is
// byte for byte what `ssh-keygen -Y sign` writes for the same key and payload,
// and stock `git verify-commit` accepts a restacked commit against the
// allowed-signers file GitCore writes, and refuses a tampered commit, another
// key, and a commit dated outside the key's window in any time zone.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dec, ZERO_OID } from "../src/bytes.ts";
import { type RestackMember, restack } from "../src/compose.ts";
import { encodeCommit, type Signature } from "../src/objects.ts";
import { writePack } from "../src/pack-write.ts";
import { receivePack } from "../src/push.ts";
import {
  allowedSigners,
  importSshSigningKey,
  type SignerKey,
  signsAt,
  sshPublicKey,
  sshSignature,
} from "../src/sshsig.ts";
import {
  CatFileReader,
  fastImport,
  git,
  gitSync,
  oracleGit,
  smartHttp,
  sshKeygen,
  sshKeyPair,
  tempRepo,
} from "./git-harness.ts";
import { fc, PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const PRINCIPAL = "keel@keel.test";
/** Every commit here is committed at this second, so a window is placed around it. */
const AT = 1_760_000_000;
const HOUR = 3600;
const KEEL: Signature = { name: "Keel", email: PRINCIPAL, time: AT };
/** Verifiers east of UTC and at it, neither on daylight time: each reads a window to the second. */
const EXACT_ZONES = ["Asia/Tokyo", "UTC"];
/**
 * A verifier on daylight time at AT (9 Oct 2025). git hands ssh-keygen the
 * commit's time in local digits and ssh-keygen reads them as standard time, so
 * here the commit reads an hour late: only a window that also holds the hour
 * after a commit holds for every verifier.
 */
const DAYLIGHT_ZONE = "America/Los_Angeles";

oracleGit();
const scratch = mkdtempSync(join(tmpdir(), "gitcore-sig-"));
const keel = sshKeyPair(scratch, "keel");
const stranger = sshKeyPair(scratch, "stranger");
const repo = tempRepo();
const reader = new CatFileReader(repo.dir);
afterAll(() => {
  reader.close();
  repo.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const file = (data: string) => ({ mode: "100644" as const, data });
const marks = fastImport(repo.dir, [
  {
    mark: 1,
    ref: "refs/heads/main",
    parents: [],
    tree: new Map([["a.txt", file("a\n")]]),
    message: "base\n",
  },
  {
    mark: 2,
    ref: "refs/heads/ws/2",
    parents: [1],
    tree: new Map([
      ["a.txt", file("a\n")],
      ["b.txt", file("b\n")],
    ]),
    message: "ws 2\n",
  },
  {
    mark: 3,
    ref: "refs/heads/ws/3",
    parents: [1],
    tree: new Map([
      ["a.txt", file("a\n")],
      ["c.txt", file("c\n")],
    ]),
    message: "ws 3\n",
  },
]);
const at = (mark: number) => marks.get(mark) ?? "";
const MEMBERS: readonly RestackMember[] = [2, 3].map((mark) => ({
  base: at(1),
  head: at(mark),
  message: `member ${mark}\n`,
  trailers: [["Change-Id", `chg_${mark}`]],
}));

let pushes = 0;
/** Restacks the two members, signed by `pkcs8Pem` when given, and pushes the result into the repo as a new ref. */
async function landed(pkcs8Pem: string | undefined, time = AT) {
  const key = pkcs8Pem === undefined ? undefined : await importSshSigningKey(pkcs8Pem);
  const out = await restack(
    reader,
    at(1),
    MEMBERS,
    { ...KEEL, time },
    key === undefined ? {} : { sign: (unsigned) => sshSignature(key, unsigned) },
  );
  const tip = out.commits.at(-1)?.oid ?? "";
  const pushed = await receivePack(
    {
      url: "https://git.invalid/repo",
      token: "unused",
      fetch: smartHttp({ repo: repo.dir }).fetch,
    },
    [{ ref: `refs/heads/cand/${++pushes}`, old: ZERO_OID, new: tip }],
    await writePack(out.objects),
  );
  expect(pushed.kind).toBe("applied");
  return out;
}

let files = 0;
/** git's setting that names a signers file holding `signers`. */
function trusting(signers: string): string[] {
  const signersFile = join(scratch, `signers-${++files}`);
  writeFileSync(signersFile, signers);
  return ["-c", `gpg.ssh.allowedSignersFile=${signersFile}`];
}

/** What stock git says of `commit` against a signers file holding `signers`, read in time zone `tz`. */
function verified(commit: string, signers: string, tz = "UTC") {
  const run = gitSync([...trusting(signers), "verify-commit", commit], {
    cwd: repo.dir,
    env: { TZ: tz },
  });
  return { good: run.status === 0, said: run.stderr.toString() };
}

/** One line of what a window was seen to do, so a failure names the window and the verifier. */
const row = (window: object, by: string, holds: boolean) =>
  `${JSON.stringify(window)} ${by}: ${holds ? "holds" : "refused"}`;

const signersOf = (window: Omit<SignerKey, "publicKey"> = {}, publicKey = keel.publicKey) =>
  allowedSigners(PRINCIPAL, [{ publicKey, ...window }]);

describe("sshSignature", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[sshsig.differential] signs any payload to the bytes ssh-keygen -Y sign writes for the same key", async () => {
    const key = await importSshSigningKey(keel.pkcs8Pem);
    let compared = 0;
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (payload) => {
        const theirs = sshKeygen(["-Y", "sign", "-n", "git", "-f", keel.keyFile], payload);
        expect(await sshSignature(key, payload)).toBe(theirs.toString());
        compared += 1;
      }),
      { numRuns: 100 },
    );
    console.log(`SSHSIG ${compared} payloads signed, each identical to ssh-keygen's`);
  });

  it("[sshsig.public-key] derives the public key ssh-keygen reads from the same private key", async () => {
    const key = await importSshSigningKey(keel.pkcs8Pem);
    expect(sshPublicKey(key.publicKey)).toBe(keel.publicKey);
    expect(key.privateKey.extractable).toBe(false);
  });

  it("[sshsig.key-import] refuses anything but a PKCS#8 PEM private key, without repeating it", async () => {
    const pem = keel.pkcs8Pem;
    for (const bad of ["", "not a key", pem.replaceAll("PRIVATE KEY", "OPENSSH PRIVATE KEY")]) {
      const error = await importSshSigningKey(bad).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toBe("Error: the signing key is not a PKCS#8 PEM private key");
    }
  });
});

describe("a signed restack", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[sshsig.git-verifies] git verifies each restacked commit against the signers file, and refuses a tampered commit, another key and an unsigned commit", async () => {
    const out = await landed(keel.pkcs8Pem);
    expect(out.commits).toHaveLength(2);
    for (const { oid } of out.commits) {
      const ours = verified(oid, signersOf());
      expect(ours.said).toContain(`Good "git" signature for ${PRINCIPAL} with ED25519 key`);
      expect(ours.good).toBe(true);
      // The file names another key: the signature is sound, and nobody the verifier trusts made it.
      expect(verified(oid, signersOf({}, stranger.publicKey)).good).toBe(false);
    }
    const tip = out.commits.at(-1)?.oid ?? "";
    expect(
      git(repo.dir, [...trusting(signersOf()), "log", "-2", "--format=%G? %GS", tip])
        .trim()
        .split("\n"),
    ).toEqual([`G ${PRINCIPAL}`, `G ${PRINCIPAL}`]);
    expect(gitSync(["fsck", "--strict", "--no-dangling"], { cwd: repo.dir }).status).toBe(0);

    const body = git(repo.dir, ["cat-file", "commit", tip]);
    const tampered = git(
      repo.dir,
      ["hash-object", "-t", "commit", "-w", "--stdin"],
      body.replace("member 3", "member 4"),
    ).trim();
    expect(tampered).not.toBe(tip);
    expect(verified(tampered, signersOf()).good).toBe(false);

    const signedByAnother = await landed(stranger.pkcs8Pem);
    expect(verified(signedByAnother.commits[0]?.oid ?? "", signersOf()).good).toBe(false);
    const unsigned = await landed(undefined);
    expect(verified(unsigned.commits[0]?.oid ?? "", signersOf()).good).toBe(false);
  });

  it("[signers.window] a key's window holds or refuses a commit by its committer time in UTC, both ends included, wherever it is verified", async () => {
    const out = await landed(keel.pkcs8Pem);
    const commit = out.commits[0]?.oid ?? "";
    /** A window, whether it holds AT, and whether the answer stands for a verifier that reads AT an hour late. */
    const windows: readonly (readonly [
      Omit<SignerKey, "publicKey">,
      boolean,
      "everywhere" | "exact",
    ])[] = [
      [{ validAfter: AT - 3 * HOUR }, true, "everywhere"],
      [{ validAfter: AT + 3 * HOUR }, false, "everywhere"],
      [{ validBefore: AT + 3 * HOUR }, true, "everywhere"],
      [{ validBefore: AT - 3 * HOUR }, false, "everywhere"],
      [{ validAfter: AT }, true, "everywhere"],
      [{ validAfter: AT + 1 }, false, "exact"],
      [{ validAfter: AT + HOUR + 1 }, false, "everywhere"],
      [{ validBefore: AT }, true, "exact"],
      [{ validBefore: AT + HOUR }, true, "everywhere"],
      [{ validBefore: AT - 1 }, false, "everywhere"],
      [{ validAfter: AT - HOUR, validBefore: AT + HOUR }, true, "everywhere"],
      [{ validAfter: AT - 2 * HOUR, validBefore: AT - HOUR }, false, "everywhere"],
    ];
    const expected: string[] = [];
    const seen: string[] = [];
    for (const [window, holds, where] of windows) {
      expected.push(row(window, "signsAt", holds));
      seen.push(row(window, "signsAt", signsAt({ publicKey: keel.publicKey, ...window }, AT)));
      for (const tz of where === "exact" ? EXACT_ZONES : [...EXACT_ZONES, DAYLIGHT_ZONE]) {
        expected.push(row(window, tz, holds));
        seen.push(row(window, tz, verified(commit, signersOf(window), tz).good));
      }
    }
    expect(seen).toEqual(expected);
  });

  it("[restack.signed-deterministic] signs every commit over its unsigned form, to the same commits every time", async () => {
    const key = await importSshSigningKey(keel.pkcs8Pem);
    const signedOver: Uint8Array[] = [];
    const sign = (unsigned: Uint8Array) => {
      signedOver.push(unsigned);
      return sshSignature(key, unsigned);
    };
    const plain = await restack(reader, at(1), MEMBERS, KEEL);
    const once = await restack(reader, at(1), MEMBERS, KEEL, { sign });
    const again = await restack(reader, at(1), MEMBERS, KEEL, { sign });
    expect(again).toEqual(once);
    expect(once.commits.map((c) => c.tree)).toEqual(plain.commits.map((c) => c.tree));
    expect(once.commits.map((c) => c.oid)).not.toEqual(plain.commits.map((c) => c.oid));

    const commitsOf = (r: typeof once) =>
      r.objects.filter((o) => o.type === "commit").map((o) => dec.decode(o.body));
    const signed = commitsOf(once);
    expect(signed).toHaveLength(2);
    for (const text of signed) {
      const [header = "", message = ""] = text.split("\n\n", 2);
      // A header of the commit, after the committer: git reads a signature nowhere else.
      expect(header).toMatch(
        /\ncommitter Keel <keel@keel\.test> \d+ \+0000\ngpgsig -----BEGIN SSH SIGNATURE-----\n( \S+\n)+ -----END SSH SIGNATURE-----$/,
      );
      expect(message).not.toContain("SSH SIGNATURE");
    }
    // The first commit's parent is the base either way, so what was signed is the plain restack's commit.
    expect(dec.decode(signedOver[0])).toBe(commitsOf(plain)[0]);
    expect(signedOver).toHaveLength(4);
    expect(dec.decode(signedOver[1])).toContain(`parent ${once.commits[0]?.oid}`);
  });
});

describe("allowedSigners", () => {
  it("[signers.format] writes one line per key: the principal, the git namespace, the window in UTC, the key", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPJ1n0SCfmBzYAp3tONBs3mjHWzRUvWb0aH0kYWcyTgO";
    expect(
      allowedSigners("keel@keel.town", [
        { publicKey: key, validAfter: 1_760_000_000, validBefore: 1_791_536_000 },
        { publicKey: key, validAfter: 1_791_536_000 },
        { publicKey: key },
      ]),
    ).toBe(
      [
        `keel@keel.town namespaces="git",valid-after="20251009085320Z",valid-before="20261009085320Z" ${key}\n`,
        `keel@keel.town namespaces="git",valid-after="20261009085320Z" ${key}\n`,
        `keel@keel.town namespaces="git" ${key}\n`,
      ].join(""),
    );
    expect(allowedSigners("keel@keel.town", [])).toBe("");
  });

  it("[signers.refuses] refuses a principal or a key that would read as something else in the file", () => {
    const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPJ1n0SCfmBzYAp3tONBs3mjHWzRUvWb0aH0kYWcyTgO";
    for (const principal of ["", "keel@keel.town *", "a,b", 'k"', "*", "!keel", "keel@keel.town\n"])
      expect(() => allowedSigners(principal, [{ publicKey: key }])).toThrow("bad principal");
    for (const publicKey of ["", "ssh-rsa AAAA", `${key} comment`, `${key}\nother`, "ssh-ed25519 "])
      expect(() => allowedSigners("keel@keel.town", [{ publicKey }])).toThrow("bad signer key");
    for (const validAfter of [NaN, 1.5, Infinity])
      expect(() => allowedSigners("keel@keel.town", [{ publicKey: key, validAfter }])).toThrow(
        "bad signer window",
      );
  });
});

describe("encodeCommit", () => {
  it("[commit.gpgsig] a signature is the last header, its later lines each led by a space", () => {
    const spec = {
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      parents: [],
      author: KEEL,
      committer: KEEL,
      message: "subject\n",
    };
    const text = dec.decode(
      encodeCommit({ ...spec, gpgsig: "-----BEGIN X-----\nabc\ndef\n-----END X-----\n" }),
    );
    expect(text).toBe(
      [
        "tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
        `author Keel <${PRINCIPAL}> ${AT} +0000`,
        `committer Keel <${PRINCIPAL}> ${AT} +0000`,
        "gpgsig -----BEGIN X-----",
        " abc",
        " def",
        " -----END X-----",
        "",
        "subject",
        "",
      ].join("\n"),
    );
    expect(() => encodeCommit({ ...spec, gpgsig: "a\n\nb\n" })).toThrow("bad signature");
    expect(() => encodeCommit({ ...spec, gpgsig: "" })).toThrow("bad signature");
  });
});
