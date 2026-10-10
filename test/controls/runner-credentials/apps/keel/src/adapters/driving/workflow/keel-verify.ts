// Control for runner-credentials: pipeline steps that ask @cloudflare/ci for
// credentials, leave an option to its default, or hide their options.
declare const ci: { runner(options: Record<string, unknown>): Promise<void> };
declare const shared: Record<string, unknown>;

await ci.runner({
  label: "suite",
  command: "pnpm test",
  cloudflareCredentials: true,
  sourceControlCredentials: false,
});
await ci.runner({
  label: "fetch",
  command: "git fetch",
  cloudflareCredentials: false,
  sourceControlCredentials: process.env["ASK"] === "1",
});
await ci.runner({ label: "default", command: "pnpm build", cloudflareCredentials: false });
await ci.runner(shared);
await ci.runner({
  label: "fine",
  command: "pnpm lint",
  cloudflareCredentials: false,
  sourceControlCredentials: false,
});
