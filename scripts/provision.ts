// The resources the Cloudflare Terraform provider (5.26) cannot create yet.
// Each is a documented exception to "infrastructure goes through Terraform";
// move it into infra/ when the provider gains the resource. Idempotent.
//   node scripts/provision.ts staging
import { cloudflare, namesIn } from "./env.ts";

const environment = process.argv[2] ?? "staging";

// Exception 1: Artifacts namespaces (no provider resource; REST POST /artifacts/namespaces).
for (const namespace of ["keel-core", "keel-ws-00"]) {
  const existing = namesIn(await cloudflare("GET", "/artifacts/namespaces?limit=100"), "namespace", "name");
  if (existing.includes(namespace)) {
    console.log(`artifacts namespace ${namespace}: exists`);
  } else {
    await cloudflare("POST", "/artifacts/namespaces", { namespace });
    console.log(`artifacts namespace ${namespace}: created`);
  }
}

// Exception 2: the Vectorize index for decision recall (no provider resource).
const index = `keel-${environment}-recall`;
const indexes = namesIn(await cloudflare("GET", "/vectorize/v2/indexes"), "name");
if (indexes.includes(index)) {
  console.log(`vectorize index ${index}: exists`);
} else {
  // 768 dimensions: @cf/baai/bge-base-en-v1.5, the embedding model recall uses.
  await cloudflare("POST", "/vectorize/v2/indexes", { name: index, config: { dimensions: 768, metric: "cosine" } });
  console.log(`vectorize index ${index}: created`);
}
