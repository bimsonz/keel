// The resources the Cloudflare Terraform provider (5.26) cannot create yet.
// Each is a documented exception to "infrastructure goes through Terraform";
// move it into infra/ when the provider gains the resource. Idempotent.
//   node scripts/provision.ts staging
import { cloudflare, namesIn } from "./env.ts";
import { ensure, everyPage, queueIdIn, verifyEnded } from "./lib/event-subscription.ts";

const environment = process.argv[2] ?? "staging";

// Exception 1: Artifacts namespaces (no provider resource; REST POST /artifacts/namespaces).
for (const namespace of ["keel-core", "keel-ws-00"]) {
  const existing = namesIn(
    await cloudflare("GET", "/artifacts/namespaces?limit=100"),
    "namespace",
    "name",
  );
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
  await cloudflare("POST", "/vectorize/v2/indexes", {
    name: index,
    config: { dimensions: 768, metric: "cosine" },
  });
  console.log(`vectorize index ${index}: created`);
}

// Exception 3: the Queues event subscription that tells the jobs queue a
// keel-verify-batch instance errored or was terminated (no provider resource;
// REST POST /event_subscriptions/subscriptions). It is created when the
// Workflow has none. One that exists and differs is named and left as it is:
// nothing here updates or replaces a subscription.
const wanted = verifyEnded(environment);
const subscription = `event subscription ${wanted.workflow} to ${wanted.queue}`;
const queueId = queueIdIn(await cloudflare("GET", `/queues?name=${wanted.queue}`), wanted.queue);
if (queueId === undefined)
  throw new Error(
    `${subscription}: no queue ${wanted.queue}; run \`node scripts/tf.ts ${environment} apply\``,
  );
// The list covers the whole account, 100 a page at most.
const subscriptions = await everyPage(
  (page) => cloudflare("GET", `/event_subscriptions/subscriptions?page=${page}&per_page=100`),
  100,
);
const step = ensure(wanted, queueId, subscriptions);
if (step.action === "keep") {
  console.log(`${subscription}: exists`);
} else if (step.action === "create") {
  await cloudflare("POST", "/event_subscriptions/subscriptions", step.request);
  console.log(`${subscription}: created`);
} else {
  throw new Error(
    `${subscription}: wanted ${wanted.events.join(", ")}, enabled, to queue ${queueId}, and found\n` +
      `${step.differing.map((line) => `  ${line}`).join("\n")}\n` +
      "Nothing was changed. Put it right or delete it by hand, then run this again.",
  );
}
