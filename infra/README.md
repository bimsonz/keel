# Infrastructure

Keel's stores and queues are Terraform (`infra/<environment>`). Workers, Durable Objects, Workflows and containers are created by `wrangler deploy` from each app's `wrangler.jsonc`, whose ids are sentinels that `scripts/deploy.ts` fills from this module's outputs.

Every resource name starts with `keel-`: the account is shared with other workloads.

## Running it

```sh
export CLOUDFLARE_ACCOUNT_ID=<the account Keel deploys to>   # never committed
node scripts/tf.ts staging init
node scripts/tf.ts staging plan
node scripts/tf.ts staging apply
node scripts/provision.ts staging    # the resources the provider cannot create yet
```

`scripts/tf.ts` authenticates Terraform with a short-lived token from your wrangler login (`wrangler auth token`); no credential is written to a file.

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
| Vectorize index `keel-<env>-recall` | No provider resource; REST `POST /vectorize/v2/indexes` |
