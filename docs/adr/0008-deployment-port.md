# Deployment is a port; Cloudflare primitives are first-class adapters, not the limit

Deployment goes through one `Deployer` port with a fixed lifecycle: `plan → preview → verify → promote → rollback → teardown`. Every operation returns evidence. A preview is a *world*, so probes can target A, B or A+B live.

**First-class Cloudflare adapters:**
- isolate preview router (binding, no token);
- Workers Previews (REST);
- Versions + gradual rollout (REST);
- Workers for Platforms;
- R2 artefacts;
- container images;
- IaC, where the plan runs in Tier 2 and the apply is always human-class.

**Other targets** (AWS, Vercel, Fly, OTA services, webhooks) plug in behind the same port as sandboxed adapters. Their egress goes through a host allowlist, and credentials are injected at the gateway.

Why: GitHub hosts everything from firmware to infrastructure, and so must Keel. Building deploy into the Workers APIs directly would cap Keel at Cloudflare targets. A port keeps those adapters first-class without making them the only option.

## Consequences

- The port and its contract suite are frozen in L0, but most adapters are scheduled late, because the scorecard grades them low *for this problem*.
- Cloudflare's deploy APIs are REST-only, so they use account tokens scoped to specific Workers, held in Secrets Store.
