// mainOnly against real git, which is both the host and the oracle: a repo
// whose HEAD is on `master`, with `main` ahead of it and a tag, is served
// through the rewrite, and what comes out must be what git itself answers for
// a twin repo that holds main alone. Then stock git clones through it.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { concat, dec, enc, ZERO_OID } from "../src/bytes.ts";
import { FLUSH, pkt } from "../src/push.ts";
import { LS_REFS_MAIN, mainOnly, type ServedRequest } from "../src/serve-main.ts";
import { fastImport, git, gitBeside, gitSync, tempRepo } from "./git-harness.ts";
import { PROPERTY_TIMEOUT } from "./support/fast-check.ts";

const MAIN = "refs/heads/main";
const MASTER = "refs/heads/master";
const DELIM = enc.encode("0001");
const SERVICE = concat([pkt("# service=git-upload-pack\n"), FLUSH]);

/** The host: master, main one commit ahead of it, a tag on master, and HEAD on master. */
const host = tempRepo();
/** What the host must look like to a client: main alone, HEAD on it. */
const twin = tempRepo();
/** A host with no main: master alone, HEAD on it. */
const mainless = tempRepo();
/** What a host with no main must look like: an empty repo whose HEAD names main. */
const empty = tempRepo();
const scratch = mkdtempSync(join(tmpdir(), "gitcore-clone-"));

const file = (data: string) => new Map([["README.md", { mode: "100644" as const, data }]]);
const marks = fastImport(host.dir, [
  { mark: 1, ref: MASTER, parents: [], tree: file("upstream\n"), message: "upstream" },
  { mark: 2, ref: MAIN, parents: [1], tree: file("landed\n"), message: "landed" },
]);
const master = marks.get(1) ?? "";
const main = marks.get(2) ?? "";
git(host.dir, ["tag", "-a", "-m", "v1", "v1", master]);
git(host.dir, ["symbolic-ref", "HEAD", MASTER]);
git(twin.dir, ["fetch", "-q", "--no-tags", host.dir, `${MAIN}:${MAIN}`]);
git(mainless.dir, ["fetch", "-q", "--no-tags", host.dir, `${MASTER}:${MASTER}`]);
git(mainless.dir, ["symbolic-ref", "HEAD", MASTER]);

/** One upload-pack request answered by git itself, as `git http-backend` runs it. */
function upload(dir: string, request: ServedRequest): Uint8Array {
  const advertise = request.service === "advertise";
  const run = gitSync(
    ["upload-pack", "--stateless-rpc", ...(advertise ? ["--http-backend-info-refs"] : []), dir],
    {
      input: request.body ?? new Uint8Array(),
      ...(request.protocol === null ? {} : { env: { GIT_PROTOCOL: request.protocol } }),
    },
  );
  if (run.status !== 0) throw new Error(`upload-pack failed: ${run.stderr.toString()}`);
  const answer = new Uint8Array(run.stdout);
  // Over HTTP the advertisement is announced by its service, except in protocol 2.
  return advertise && request.protocol !== "version=2" ? concat([SERVICE, answer]) : answer;
}

const advertise = (protocol: string | null): ServedRequest => ({
  service: "advertise",
  protocol,
  body: null,
});

/** A protocol 2 `ls-refs` as stock git sends one. */
const lsRefs = (args: readonly string[]): ServedRequest => ({
  service: "negotiate",
  protocol: "version=2",
  body: concat([
    pkt("command=ls-refs\n"),
    pkt("agent=git/test\n"),
    pkt("object-format=sha1\n"),
    DELIM,
    ...args.map((arg) => pkt(`${arg}\n`)),
    FLUSH,
  ]),
});

/** What a client gets for `request` when `dir` is served with main alone. */
function served(dir: string, request: ServedRequest): Uint8Array | null {
  const { request: asked, rewrite } = mainOnly(request);
  const answer = upload(dir, asked);
  return rewrite === null ? answer : rewrite(answer);
}

/** Every way of taking some of `items`, in order. */
const subsets = <A>(items: readonly A[]): A[][] =>
  items.reduce<A[][]>((sets, item) => [...sets, ...sets.map((set) => [...set, item])], [[]]);

const text = (bytes: Uint8Array | null) => (bytes === null ? null : dec.decode(bytes));

afterAll(() => {
  for (const repo of [host, twin, mainless, empty]) repo.cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

describe("mainOnly", { timeout: PROPERTY_TIMEOUT }, () => {
  it("[serve.main.advertisement] a repo whose HEAD is on another branch is advertised as git advertises a repo holding main alone", () => {
    for (const protocol of [null, "version=1"]) {
      const raw = text(upload(host.dir, advertise(protocol))) ?? "";
      expect(raw).toContain(`${master} HEAD`);
      expect(raw).toContain(`symref=HEAD:${MASTER}`);
      expect(raw).toContain("refs/tags/v1^{}");
      expect(text(served(host.dir, advertise(protocol)))).toBe(
        text(upload(twin.dir, advertise(protocol))),
      );
    }
    // Protocol 2 advertises capabilities and no ref: it stands as the host said it.
    const capabilities = upload(host.dir, advertise("version=2"));
    expect(text(capabilities)).toContain("version 2\n");
    expect(served(host.dir, advertise("version=2"))).toEqual(capabilities);
  });

  it("[serve.main.detached] a host that names no symbolic HEAD is still advertised with HEAD on main, and one that advertises no ref stands", () => {
    const shown = mainOnly(advertise(null)).rewrite?.(
      concat([
        SERVICE,
        pkt(`${master} HEAD\0multi_ack side-band-64k agent=host\n`),
        pkt(`${main} ${MAIN}\n`),
        pkt(`${master} ${MASTER}\n`),
        FLUSH,
      ]),
    );
    expect(text(shown ?? null)).toBe(
      text(
        concat([
          SERVICE,
          pkt(`${main} HEAD\0multi_ack side-band-64k agent=host symref=HEAD:${MAIN}\n`),
          pkt(`${main} ${MAIN}\n`),
          FLUSH,
        ]),
      ),
    );
    const bare = concat([SERVICE, FLUSH]);
    expect(mainOnly(advertise(null)).rewrite?.(bare)).toEqual(bare);
  });

  it("[serve.main.ls-refs] every ls-refs a client can ask is answered as git answers it for a repo holding main alone, from one fixed question to the host", () => {
    const flags = subsets(["symrefs", "peel", "unborn"]);
    const prefixes = subsets(["HEAD", "refs/heads/", MAIN, MASTER, "refs/heads/ma"]);
    const hosted = text(upload(host.dir, lsRefs(["symrefs", "peel"]))) ?? "";
    expect(hosted).toContain(`${master} HEAD symref-target:${MASTER}`);
    expect(hosted).toContain("refs/tags/v1 peeled:");
    // The host is asked the same thing every time, so once is every time.
    const told = upload(host.dir, {
      service: "negotiate",
      protocol: "version=2",
      body: LS_REFS_MAIN,
    });
    let listed = 0;
    for (const flag of flags)
      for (const prefix of prefixes) {
        const request = lsRefs([...flag, ...prefix.map((p) => `ref-prefix ${p}`)]);
        const { request: asked, rewrite } = mainOnly(request);
        expect(asked.body).toEqual(LS_REFS_MAIN);
        expect(asked).toMatchObject({ service: "negotiate", protocol: "version=2" });
        const answer = text(rewrite?.(told) ?? null);
        expect(answer).toBe(text(upload(twin.dir, request)));
        if (answer?.includes(MAIN) === true) listed += 1;
      }
    expect(listed).toBeGreaterThan(flags.length);
  });

  it("[serve.main.unborn] a repo with no main is shown as git shows an empty repo whose HEAD names main", () => {
    for (const protocol of [null, "version=1"]) {
      const shown = text(served(mainless.dir, advertise(protocol)));
      expect(shown).toContain(`${ZERO_OID} capabilities^{}`);
      expect(shown).toBe(text(upload(empty.dir, advertise(protocol))));
    }
    let unborn = 0;
    for (const flag of subsets(["symrefs", "peel", "unborn"]))
      for (const prefix of subsets(["HEAD", "refs/heads/", MASTER])) {
        const request = lsRefs([...flag, ...prefix.map((p) => `ref-prefix ${p}`)]);
        const answer = text(served(mainless.dir, request));
        expect(answer).toBe(text(upload(empty.dir, request)));
        if (answer?.includes(`unborn HEAD symref-target:${MAIN}`) === true) unborn += 1;
      }
    expect(unborn).toBeGreaterThan(0);
  });

  it("[serve.main.passes] a negotiation in any protocol, and any protocol 2 command but ls-refs, goes to the host as it came and is not held", () => {
    const want = concat([pkt(`want ${main} side-band-64k\n`), FLUSH, pkt("done\n")]);
    const command = (name: string) =>
      concat([pkt(`command=${name}\n`), DELIM, pkt(`want ${main}\n`), pkt("done\n"), FLUSH]);
    const passed: ServedRequest[] = [
      { service: "negotiate", protocol: null, body: want },
      { service: "negotiate", protocol: "version=1", body: want },
      { service: "negotiate", protocol: "version=2", body: command("fetch") },
      { service: "negotiate", protocol: "version=2", body: command("object-info") },
      { service: "negotiate", protocol: "version=2", body: enc.encode("not pkt-lines") },
      // Without the header the host reads protocol 0, whatever the body says.
      { service: "negotiate", protocol: null, body: lsRefs([]).body },
    ];
    for (const request of passed) {
      const step = mainOnly(request);
      expect(step.request).toBe(request);
      expect(step.rewrite).toBeNull();
    }
  });

  it("[serve.main.not-git] an answer that is not pkt-lines to its end, or is the host's error, is passed on as nothing", () => {
    const refused = [
      enc.encode("<html>no</html>"),
      concat([SERVICE, enc.encode("00ff")]),
      concat([SERVICE, pkt("ERR access denied\n")]),
    ];
    for (const answer of refused) {
      expect(mainOnly(advertise(null)).rewrite?.(answer)).toBeNull();
      expect(mainOnly(lsRefs(["symrefs"])).rewrite?.(answer)).toBeNull();
    }
  });

  describe("through a local smart-HTTP server", () => {
    /** git's smart HTTP over the host, every request served with main alone. */
    const server = createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on("data", (part: Buffer) => parts.push(part));
      req.on("end", () => {
        const sent = Buffer.concat(parts);
        const header = req.headers["git-protocol"];
        const advertised = req.method === "GET";
        const shown = served(host.dir, {
          service: advertised ? "advertise" : "negotiate",
          protocol: typeof header === "string" ? header : null,
          body: advertised
            ? null
            : new Uint8Array(req.headers["content-encoding"] === "gzip" ? gunzipSync(sent) : sent),
        });
        res.writeHead(shown === null ? 502 : 200, {
          "Content-Type": `application/x-git-upload-pack-${advertised ? "advertisement" : "result"}`,
          "Cache-Control": "no-cache",
        });
        res.end(shown ?? undefined);
      });
    });
    let url = "";
    beforeAll(async () => {
      await new Promise<void>((listening) => {
        server.listen(0, "127.0.0.1", listening);
      });
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("the server is not listening on a port");
      url = `http://127.0.0.1:${address.port}/repo.git`;
    });
    afterAll(async () => {
      await new Promise((closed) => {
        server.close(closed);
      });
    });

    it.each(["0", "1", "2"])(
      "[serve.main.stock-git] stock git, protocol %s, clones main and sees no other ref",
      async (version) => {
        const protocol = ["-c", `protocol.version=${version}`];
        const dir = join(scratch, `v${version}`);
        await gitBeside([...protocol, "clone", "-q", url, dir]);
        expect(git(dir, ["rev-parse", "HEAD"]).trim()).toBe(main);
        expect(git(dir, ["symbolic-ref", "HEAD"]).trim()).toBe(MAIN);
        expect(git(dir, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim()).toBe(
          [
            `${MAIN} ${main}`,
            `refs/remotes/origin/HEAD ${main}`,
            `refs/remotes/origin/main ${main}`,
          ].join("\n"),
        );
        expect(gitSync(["fsck", "--full"], { cwd: dir }).status).toBe(0);
        expect(await gitBeside([...protocol, "ls-remote", url])).toBe(
          `${main}\tHEAD\n${main}\t${MAIN}\n`,
        );
        expect(await gitBeside([...protocol, "ls-remote", url, "HEAD"])).toBe(`${main}\tHEAD\n`);
        expect(await gitBeside([...protocol, "ls-remote", url, "master", "v1"])).toBe("");
        // A fetch of HEAD by name asks protocol 2 for prefixes that leave main out: it still gets main's commit.
        await gitBeside([...protocol, "-C", dir, "fetch", "-q", url, "HEAD"]);
        expect(git(dir, ["rev-parse", "FETCH_HEAD"]).trim()).toBe(main);
      },
    );
  });
});
