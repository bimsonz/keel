# Keel's staging resources, on an account that may hold others: every name starts with keel-.
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

# The account's Secrets Store (one per account), which holds the key that
# wraps every credential an org stores in Keel.
data "cloudflare_secrets_stores" "account" {
  account_id = var.account_id
}

locals {
  secrets_store_id = data.cloudflare_secrets_stores.account.result[0].id
}

# The key-encryption key of the credential store: each credential an
# org stores is sealed with a data key of its own, and that data key is wrapped
# with this one (AES-KW), so a credential is never at rest unsealed. keel reads
# it through its CREDENTIAL_KEK binding. Its value is made here, so no person
# ever handles it, and is kept only in this state; replacing it makes every
# stored credential unreadable, so it is never rotated in place.
resource "random_bytes" "credential_kek" {
  length = 32
}

resource "cloudflare_secrets_store_secret" "credential_kek" {
  account_id = var.account_id
  store_id   = local.secrets_store_id
  name       = "${local.prefix}-credential-kek"
  value      = random_bytes.credential_kek.base64
  scopes     = ["workers"]
}

# Keel's OAuth client on Cloudflare: what an owner consents to when they
# connect a project's deploy target to their own account, from the project's
# settings. Its two scopes let keel mint, on the one account the owner ticks,
# an API token of its own that may only edit that account's Workers, and read
# which account that was; keel deploys with that token, never with the
# consent's own access. The scopes are keel's CLOUDFLARE_SCOPES, which a unit
# test holds equal to these. Private until made public, which needs a logo and
# the host's domain verified: until then only this account's members consent.
resource "cloudflare_oauth_client" "keel" {
  # Optional configuration: made only once the operator has the token that may
  # make it. Without it the instance still applies and deploys, with no client.
  count                      = var.oauth_clients_api_token == "" ? 0 : 1
  provider                   = cloudflare.oauth_clients
  account_id                 = var.account_id
  client_name                = "Keel"
  grant_types                = ["authorization_code"]
  response_types             = ["code"]
  redirect_uris              = ["https://${var.host}/v1/cloudflare/callback"]
  token_endpoint_auth_method = "client_secret_basic"
  scopes                     = ["account-api-tokens.write", "account-settings.read"]
  client_uri                 = "https://${var.host}"
  policy_uri                 = "https://${var.host}/privacy"
  tos_uri                    = "https://${var.host}/terms"

  # The provider answers oauth_client_id and visibility after creating the
  # client where it planned null: the id it reads back is the client's own, and
  # visibility is Cloudflare's "private", which the provider cannot be told
  # (it takes only "public"). A later plan must change neither.
  lifecycle {
    ignore_changes = [oauth_client_id, visibility]
  }
}

# The client's secret, which Cloudflare issues once, as the client is made, and
# Terraform keeps only in its state: keel reads it through its
# CF_OAUTH_CLIENT_SECRET binding to exchange a consent's code. No person
# handles it, and no output carries it.
resource "cloudflare_secrets_store_secret" "cloudflare_oauth_client_secret" {
  count      = length(cloudflare_oauth_client.keel)
  account_id = var.account_id
  store_id   = local.secrets_store_id
  name       = "${local.prefix}-cloudflare-oauth-client-secret"
  value      = cloudflare_oauth_client.keel[0].client_secret
  scopes     = ["workers"]
}

# Better Auth's secret: it signs the session cookies and encrypts what Better
# Auth keeps sealed. scripts/deploy.ts sets it as BETTER_AUTH_SECRET. Replacing
# it signs every user out.
resource "random_password" "better_auth" {
  length  = 64
  special = false
}

# The swarm's admin bearer (examples/swarm): every route of keel-swarm but its
# root needs it, the agents' own among them, since an open route would spend
# the account's model calls. scripts/deploy.ts sets it as SWARM_ADMIN_TOKEN.
resource "random_password" "swarm_admin" {
  length  = 48
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
