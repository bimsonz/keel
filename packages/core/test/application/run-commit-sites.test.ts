import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APPLICATION = join(import.meta.dirname, "../../src/application");

/** Every TypeScript file under `dir`, with its text. */
function sources(dir: string): readonly { readonly path: string; readonly text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

describe("who a use-case's commit names", () => {
  it("[run.commit-sites] no use-case names an agent as a commit's actor itself: each takes the actor and the run together from byAgent", () => {
    const files = sources(APPLICATION);
    expect(files.length).toBeGreaterThan(50);
    const relative = (path: string) => path.slice(APPLICATION.length + 1);
    // Neither the helper that names an agent alone, nor the same thing spelled out.
    const alone = /actor:\s*(agentActor\(|`agent:)/;
    expect(
      files.filter((file) => alone.test(file.text)).map((file) => relative(file.path)),
    ).toEqual([]);
    expect(
      files.filter((file) => file.text.includes("agentActor(")).map((file) => relative(file.path)),
    ).toEqual([]);
    // Every commit an agent causes, counted: one that stops passing its run is one fewer here.
    const sites = Object.fromEntries(
      files
        .map((file) => [relative(file.path), file.text.split("byAgent(").length - 1] as const)
        .filter(([, count]) => count > 0),
    );
    expect(sites).toEqual({
      "coordination/change.ts": 7,
      "coordination/conflict-moves.ts": 1,
      "identity/invitations.ts": 1,
      "identity/session.ts": 1,
      "identity/sign-up.ts": 1,
    });
  });
});
