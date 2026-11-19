# Infrastructure

Keel's stores and queues are Terraform (`infra/<environment>`). Workers, Durable Objects, Workflows and containers are created by `wrangler deploy` from each app's `wrangler.jsonc`, whose ids are sentinels that `scripts/deploy.ts` fills from this module's outputs.

Every resource name starts with `keel-`, so Keel's resources stand apart from anything else on the account.

## keel.town is retired

The hosted instance was retired on 19 November 2026, after the competition Keel was built for.

- **`infra/staging` is destroyed**, and its state is empty. Its Workers (`keel`, `keel-verify`, `keel-console`, `keel-swarm`), their Workflows and container applications, the Artifacts namespaces `keel-core` and `keel-ws-00` and the queue's event subscription, none of which Terraform owns, were deleted with it. Its buckets were emptied, the email sending subdomain `mail.keel.town` was removed, and the state backups in `keel-tfstate` that held its keys were deleted.
- **`infra/site` serves keel.town now.** `keel-site` is a Worker of static assets (`infra/site/public`) with no script, binding or secret, at the apex through a Custom Domain, and every other path answers 404. To change the page, edit `infra/site/public` and run `npx wrangler deploy` from `infra/site`. `node scripts/tf.ts site plan` covers the domain.
- **To stand the instance up again**, run `node scripts/tf.ts site destroy` first, since both modules hold the hostname, then follow the steps under [Running it](#running-it). Terraform makes a new commit-signing key. The retired key's public half stays in `local.commit_signers`, so the commits it signed still verify.

## Running it

```sh
export CLOUDFLARE_ACCOUNT_ID=<the account Keel deploys to>   # never committed
node scripts/tf.ts staging init
node scripts/tf.ts staging plan
node scripts/tf.ts staging apply
node scripts/provision.ts staging    # the resources the provider cannot create yet
pnpm deploy:staging                  # keel-verify, D1 migrations, keel, console
pnpm smoke                           # whoami over REST and MCP, live
```

`scripts/deploy.ts` writes a gitignored `apps/<app>/wrangler.deploy.jsonc` per Worker, filling the sentinel ids from `terraform output`, and `KEEL_HOST` (and the console's `KEEL_API_HOST`) from its `keel_host` output: the one site, `keel.town`. It refuses to deploy when an output is missing, when a sentinel survives rendering, or when a bound R2 bucket or D1 database does not exist, and it passes `--no-x-provision --no-x-auto-create`, because wrangler 4.149 otherwise creates missing resources itself. `--check` renders and checks without deploying. Secrets: `CLOUDFLARE_ACCOUNT_ID` on every deploy; `KEEL_SIGNING_KEY` only when the Worker has none, since a new key invalidates every issued token. On macOS the container build runs with a `PATH` that hides `docker-credential-osxkeychain` and an empty `DOCKER_CONFIG` (spike S4).

`scripts/tf.ts` authenticates Terraform with a short-lived token from your wrangler login (`wrangler auth token`); no credential is written to a file.

## The site

`routing.tf` serves everything from one host, `var.host` (`keel.town`), so a session cookie is first-party everywhere. The console is the apex origin through a Workers Custom Domain, which keeps its DNS record and certificate; Workers routes put Keel in front of it for `/v1/*`, `/.well-known/*`, `/mcp` and `/mcp/*` (two patterns: a wildcard on the bare word would take any handle that begins with it), and for the agent front door's two exact paths, `/start` and `/llms.txt`. A route allows only a trailing wildcard, so the clone route `/<org>/<project>.git/...` reaches Keel through the console, which forwards only `info/refs` and `git-upload-pack` over its service binding. While the instance ran, there was one environment: whatever was deployed here was production.

## State

State is meant to live in the R2 bucket `keel-tfstate`, through Terraform's S3 backend.

- **Bootstrap (the one resource created by CLI):** `wrangler r2 bucket create keel-tfstate`, done on 2026-10-10. Nothing else is created outside Terraform except the exceptions below.
- **Interim, until R2 S3 credentials for that bucket exist:** state is local (`infra/staging/terraform.tfstate`, gitignored), and `scripts/tf.ts` uploads a timestamped copy to `keel-tfstate/staging/backups/` after every apply. Local state has no lock, so meanwhile apply runs from one machine only.
- **When the credentials exist** (`R2_STATE_ACCESS_KEY_ID`, `R2_STATE_SECRET_ACCESS_KEY`, passed through the environment): add the S3 backend block to `versions.tf` and run `terraform init -migrate-state`.

## Documented exceptions

`scripts/provision.ts` creates what the Cloudflare provider (5.26) has no resource for. Move each into Terraform when the provider gains it.

| Resource | Why not Terraform |
|---|---|
| Artifacts namespaces `keel-core`, `keel-ws-00` | No provider resource; REST `POST /artifacts/namespaces` |
| Queues event subscription: the Workflow `keel-verify-batch`'s `instance.errored` and `instance.terminated`, to the queue `keel-<env>-jobs` | No provider resource; REST `POST /event_subscriptions/subscriptions` |

The subscription is found by its Workflow, whatever it is called, and is only ever created. One that is there and differs (other events, another queue, not enabled, or a second one from the same Workflow) stops `provision.ts` with what it found and changes nothing: put it right by hand, then run it again. It names a Workflow that `wrangler deploy` creates, so on a new environment run `provision.ts` once more after the first deploy. `wrangler queues subscription list keel-<env>-jobs` (from `apps/keel`) shows it.
