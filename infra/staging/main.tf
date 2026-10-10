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

# The bootstrap credential's secret: exchanged as client `keel-bootstrap` for a
# token that may only enrol agents, so a new deployment can enrol its first
# operator through the API. scripts/deploy.ts sets it as KEEL_BOOTSTRAP_SECRET
# and the seed reads it from the output. Replace this resource to retire it.
resource "random_password" "bootstrap" {
  length  = 48
  special = false
}
