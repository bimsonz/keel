// Control for runner-credentials: a pipeline step asks @cloudflare/ci for credentials.
declare const ci: { runner(options: Record<string, unknown>): Promise<void> };

await ci.runner({ label: "suite", command: "pnpm test", cloudflareCredentials: true });
await ci.runner({ label: "fetch", command: "git fetch", sourceControlCredentials: process.env["ASK"] === "1" });
await ci.runner({ label: "fine", command: "pnpm lint", cloudflareCredentials: false });
