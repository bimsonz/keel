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
