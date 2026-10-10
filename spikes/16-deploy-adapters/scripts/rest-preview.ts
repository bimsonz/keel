// (b) The Previews REST adapter (src/previews-rest.ts) driven from Node with
// modules that @cloudflare/worker-bundler built inside the router Worker.
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... ROUTER_URL=... ADMIN_TOKEN_FILE=... \
//     node scripts/rest-preview.ts create <candidate-id> <preview-name> <worker>
//   ... node scripts/rest-preview.ts delete <preview-name> <worker>
//   ... node scripts/rest-preview.ts list <worker>
//
// Prints one JSON line with timings, the preview and deployment URLs. The
// token is read from the environment and never printed.
import { readFileSync } from "node:fs";
import { createPreviewDeployment, deletePreview, listPreviews, upsertPreview, type BundledModule } from "../src/previews-rest.ts";

const [cmd, ...args] = process.argv.slice(2);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!accountId || !token) {
  console.error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
  process.exit(2);
}
const client = { accountId, token };

if (cmd === "create") {
  const [candidateId, name, worker] = args;
  if (!candidateId || !name || !worker) process.exit(2);
  const routerUrl = process.env.ROUTER_URL!;
  const adminToken = readFileSync(process.env.ADMIN_TOKEN_FILE!, "utf8").trim();
  const t0 = performance.now();
  const bundleRes = await fetch(`${routerUrl}/admin/bundle/${candidateId}`, { headers: { authorization: `Bearer ${adminToken}` } });
  if (!bundleRes.ok) throw new Error(`bundle fetch: HTTP ${bundleRes.status}`);
  const bundle = (await bundleRes.json()) as { mainModule: string; modules: Record<string, BundledModule>; compatibilityDate: string };
  const t1 = performance.now();
  const { preview, created } = await upsertPreview(client, worker, name);
  const t2 = performance.now();
  const deployment = await createPreviewDeployment(client, worker, preview.id, {
    mainModule: bundle.mainModule,
    modules: bundle.modules,
    compatibilityDate: bundle.compatibilityDate,
    annotations: { "workers/message": `keel candidate ${candidateId}` },
  });
  const t3 = performance.now();
  console.log(
    JSON.stringify({
      candidateId,
      preview: { id: preview.id, name: preview.name, created, urls: preview.urls },
      deployment: { id: deployment.id, number: deployment.number, urls: deployment.urls },
      ms: { fetchBundle: Math.round(t1 - t0), upsertPreview: Math.round(t2 - t1), createDeployment: Math.round(t3 - t2), total: Math.round(t3 - t0) },
    }),
  );
} else if (cmd === "delete") {
  const [name, worker] = args;
  if (!name || !worker) process.exit(2);
  const t0 = performance.now();
  await deletePreview(client, worker, name);
  console.log(JSON.stringify({ deleted: name, ms: Math.round(performance.now() - t0) }));
} else if (cmd === "list") {
  const [worker] = args;
  if (!worker) process.exit(2);
  const previews = await listPreviews(client, worker);
  console.log(JSON.stringify({ count: previews.length, names: previews.map((p) => p.name) }));
} else {
  console.error("usage: rest-preview.ts create|delete|list ...");
  process.exit(2);
}
