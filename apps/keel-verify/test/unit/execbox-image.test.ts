import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEPS_TOOLCHAIN } from "@keeltown/core/application/verification";
import { describe, expect, it } from "vitest";

const IMAGE = join(import.meta.dirname, "../../containers/sandbox");
const ROOT = join(import.meta.dirname, "../../../..");
const dockerfile = readFileSync(join(IMAGE, "Dockerfile"), "utf8");
// The stage the boxes run: everything after the last FROM.
const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const workspace = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
const versionOf = (packageDir: string): unknown =>
  JSON.parse(readFileSync(join(realpathSync(packageDir), "package.json"), "utf8")).version;
const arg = (name: string): string | undefined =>
  new RegExp(`^ARG ${name}=(\\S+)$`, "m").exec(dockerfile)?.[1];
const wrangler = readFileSync(join(import.meta.dirname, "../../wrangler.jsonc"), "utf8");
/** A container's instance type, as wrangler.jsonc names it beside its class. */
const instanceOf = (className: string): string | undefined =>
  new RegExp(
    `"class_name": "${className}",\\s*"image": "[^"]+",\\s*"instance_type": "([^"]+)"`,
  ).exec(wrangler)?.[1];
/** The RUN that fetches a tarball, with its continuation lines. */
const fetching = (tarball: string): string =>
  new RegExp(`^RUN curl .*${tarball}.*(?:\\n .*)*`, "m").exec(dockerfile)?.[0] ?? "";

describe("the sandbox image", () => {
  it("[image.runtime] runs the sandbox server of the SDK the Worker and @cloudflare/ci run, on CI's base", () => {
    // The server and the SDK talking to it are one release: the catalog's, which
    // @cloudflare/ci is held to by an override, as installed.
    const sdk = /^ {2}"@cloudflare\/sandbox": (\S+)$/m.exec(workspace)?.[1];
    expect(workspace).toMatch(/^ {2}"@cloudflare\/ci>@cloudflare\/sandbox": "catalog:"$/m);
    expect(versionOf(join(import.meta.dirname, "../../node_modules/@cloudflare/sandbox"))).toBe(
      sdk,
    );
    const ci = realpathSync(join(ROOT, "apps/keel/node_modules/@cloudflare/ci"));
    expect(versionOf(join(ci, "../sandbox"))).toBe(sdk);
    const copied = [...runtime.matchAll(/^COPY --from=docker\.io\/cloudflare\/sandbox:(\S+) /gm)];
    expect(copied.map(([, version]) => version)).toEqual([sdk, sdk]);
    expect(runtime).toMatch(/^COPY --from=\S+ \/container-server \/container-server$/m);
    expect(/^ENV SANDBOX_VERSION=(\S+) /m.exec(runtime)?.[1]).toBe(sdk);
    expect(runtime).toMatch(/^ENTRYPOINT \["\/container-server\/sandbox"\]$/m);
    // CI's runner is Ubuntu 24.04: the boxes run Keel's suite on the base it passes on.
    expect(runtime).toMatch(/^\nFROM docker\.io\/library\/ubuntu:24\.04\n/);
  });

  it("[image.git] builds CI's git from kernel.org's tarball checked by its sha256, and ships it alone with ssh-keygen", () => {
    // GitCore's oracle tests refuse a git outside 2.50 to 2.55, and CI runs 2.55.0:
    // the box's git is that one, or Keel's own suite cannot pass in a box.
    expect(arg("GIT_VERSION")).toBe("2.55.0");
    expect(arg("GIT_SHA256")).toMatch(/^[0-9a-f]{64}$/);
    // Built on the runtime's own base, so it links the libraries the runtime has.
    expect(dockerfile).toMatch(/^FROM docker\.io\/library\/ubuntu:24\.04 AS git$/m);
    const fetch = fetching("git-\\$\\{GIT_VERSION\\}\\.tar\\.xz");
    const check = fetch.indexOf('echo "${GIT_SHA256}  /tmp/git.tar.xz" | sha256sum -c -');
    expect(check).toBeGreaterThan(0);
    expect(fetch.indexOf("tar -xJf /tmp/git.tar.xz")).toBeGreaterThan(check);
    // One git (the built one, and no distribution package beside it) and ssh-keygen,
    // which GitCore's SSH signatures are checked with.
    expect(runtime).toMatch(/^COPY --from=git \/out\/usr\/local\/ \/usr\/local\/$/m);
    const installed = /apt-get install -y --no-install-recommends (.*) \\$/m.exec(runtime)?.[1];
    expect(installed?.split(" ")).toContain("openssh-client");
    expect(installed?.split(" ")).not.toContain("git");
  });

  it("[image.node] installs CI's node from nodejs.org's tarball checked by its sha256, and the pnpm the repository names", () => {
    const pinned = readFileSync(join(ROOT, ".node-version"), "utf8").trim();
    expect(arg("NODE_VERSION")).toBe(pinned);
    expect(arg("NODE_SHA256")).toMatch(/^[0-9a-f]{64}$/);
    const fetch = fetching("node-v\\$\\{NODE_VERSION\\}-linux-x64\\.tar\\.xz");
    const check = fetch.indexOf('echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c -');
    expect(check).toBeGreaterThan(0);
    expect(fetch.indexOf("tar -xJf /tmp/node.tar.xz")).toBeGreaterThan(check);
    const manager = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager;
    expect(`pnpm@${/^RUN npm install -g pnpm@(\S+) /m.exec(runtime)?.[1]}`).toBe(manager);
  });

  it("[image.fetch-retries] tries every download again on any failure: one mirror's reset must not fail a build", () => {
    const fetches = dockerfile.match(/^RUN curl .*$/gm) ?? [];
    expect(fetches).toHaveLength(2);
    for (const fetch of fetches) expect(fetch).toMatch(/ --retry [1-9]\d* --retry-all-errors /);
  });

  it("[image.toolchain] states its toolchain in DEPS_TOOLCHAIN's own form: the node, pnpm and base it installs", () => {
    // A deps box prints /etc/keel-toolchain, and its object keeps a build only when
    // that is DEPS_TOOLCHAIN: an image that drifts from the constant builds nothing.
    const [, written, ...more] = /^RUN echo "(.*)" > \/etc\/keel-toolchain$/m.exec(runtime) ?? [];
    expect(more).toEqual([]);
    // The line, with each command replaced by what it prints in this image.
    const base = /^\nFROM docker\.io\/library\/ubuntu:(\S+)\n/.exec(runtime)?.[1];
    expect(
      written
        ?.replace("$(node --version)", `v${arg("NODE_VERSION")}`)
        .replace("$(pnpm --version)", /^RUN npm install -g pnpm@(\S+) /m.exec(runtime)?.[1] ?? "")
        .replace('$(. /etc/os-release && echo "$VERSION_ID")', base ?? ""),
    ).toBe(DEPS_TOOLCHAIN);
  });

  it("[image.box-size] gives the suite box and the deps box CI's four vCPUs: Keel's own suite takes 20 minutes on one, its step's whole timeout", () => {
    expect(instanceOf("KeelSandbox")).toBe("standard-4");
    expect(instanceOf("KeelDepsBox")).toBe("standard-4");
  });

  it("[image.no-deps] bakes no project's dependencies: a deps box builds them, and a suite box fetches them", () => {
    expect(existsSync(join(IMAGE, "forge-deps"))).toBe(false);
    expect(dockerfile).not.toMatch(/pnpm install/);
    // What is copied in is the git the build stage made and the sandbox runtime.
    const copies = [...dockerfile.matchAll(/^COPY (\S+)/gm)].map(([, from]) => from);
    expect(new Set(copies)).toEqual(
      new Set(["--from=git", "--from=docker.io/cloudflare/sandbox:0.12.10"]),
    );
  });
});
