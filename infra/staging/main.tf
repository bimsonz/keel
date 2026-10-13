# Keel's staging resources on a shared account: every name starts with keel-.
# Workers, Durable Objects, Workflows and containers are created by wrangler
# deploy; this module owns the stores and queues they bind to.

locals {
  prefix = "keel-${var.environment}"
}

# The agent directory and catalog read model.
resource "cloudflare_d1_database" "keel" {
  account_id = var.account_id
  name       = local.prefix
  # The API reports this explicitly; left unset, every plan would try to clear it.
  read_replication = { mode = "disabled" }
}

# Background jobs: mirror sync, notes, fork cleanup, embeddings, webhooks.
resource "cloudflare_queue" "jobs" {
  account_id = var.account_id
  queue_name = "${local.prefix}-jobs"
}

# Content-addressed bundles, logs and evidence.
resource "cloudflare_r2_bucket" "bundles" {
  account_id = var.account_id
  name       = "${local.prefix}-bundles"
}

# The permanent archive of the operation log.
resource "cloudflare_r2_bucket" "archive" {
  account_id = var.account_id
  name       = "${local.prefix}-archive"
}

# Tier 2 sandbox backups, written through the BACKUP_BUCKET binding.
resource "cloudflare_r2_bucket" "sandbox_backups" {
  account_id = var.account_id
  name       = "${local.prefix}-sandbox-backups"
}

# @cloudflare/ci backs a sandbox up after every run that exits 0, and a verify
# run exits 0 whatever its verdict, so backups pile up without this. A day
# covers a retry; nothing restores from an older one.
resource "cloudflare_r2_bucket_lifecycle" "sandbox_backups" {
  account_id  = var.account_id
  bucket_name = cloudflare_r2_bucket.sandbox_backups.name
  rules = [{
    id         = "expire-after-1-day"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
  }]
}

# The account's Secrets Store (one per account), which holds per-Worker deploy tokens.
data "cloudflare_secrets_stores" "account" {
  account_id = var.account_id
}

locals {
  secrets_store_id = data.cloudflare_secrets_stores.account.result[0].id
}

# The deploy token the Deployer adapters use. Inert until a real,
# Worker-scoped token; its value never comes from this module.
resource "cloudflare_secrets_store_secret" "deploy_token" {
  account_id = var.account_id
  store_id   = local.secrets_store_id
  name       = "${local.prefix}-deploy-token"
  value      = "unset: replace with a Worker-scoped token"
  scopes     = ["workers"]

  lifecycle {
    ignore_changes = [value]
  }
}

# Better Auth's secret: it signs the session cookies and encrypts what Better
# Auth keeps sealed. scripts/deploy.ts sets it as BETTER_AUTH_SECRET. Replacing
# it signs every user out.
resource "random_password" "better_auth" {
  length  = 64
  special = false
}

# The key pair that signs bundle URLs. keel signs every URL a sandbox is handed
# with the private key, which scripts/deploy.ts sets as its
# BUNDLE_URL_SIGNING_KEY secret. keel-verify's bundle host verifies with the
# public key, a plain var, so keel-verify still holds no secret. Replacing the
# pair refuses every URL signed before it: only a verification then in flight
# holds one, and it parks.
resource "tls_private_key" "bundle_url" {
  algorithm = "ED25519"
}

# The key that signs every commit Keel composes, apart from every other key
# Keel holds. scripts/deploy.ts sets its private half as keel's
# KEEL_COMMIT_SIGNING_KEY secret; its public half is the first entry of
# local.commit_signers. Never replace it without first writing its public half
# and window into that list by hand: the commits it signed stay on trunk for
# good, and they verify only while the list holds it.
resource "tls_private_key" "commit_signing" {
  algorithm = "ED25519"
}

locals {
  # Every key Keel signs or has signed commits with, and when: keel's
  # KEEL_COMMIT_SIGNERS var, which it serves as its allowed-signers file at
  # /.well-known/keel/allowed-signers. Times are ISO 8601 in UTC, both ends
  # included. Keel refuses to compose while this list does not hold its key
  # for the commit's time and the hour after (a verifier on daylight time
  # reads a commit an hour late), so a retired key's validBefore is set more
  # than an hour ahead, and the next key's entry is added before that time.
  commit_signers = [
    {
      publicKey  = trimspace(tls_private_key.commit_signing.public_key_openssh)
      validAfter = "2026-10-13T00:00:00Z"
    },
  ]
}
