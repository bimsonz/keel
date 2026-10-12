# scripts/deploy.ts reads these to fill the sentinel ids in each wrangler.jsonc.
output "d1_database_id" {
  value = cloudflare_d1_database.keel.id
}

output "secrets_store_id" {
  value = local.secrets_store_id
}

output "deploy_token_secret_name" {
  value = cloudflare_secrets_store_secret.deploy_token.name
}

output "bootstrap_secret" {
  value     = random_password.bootstrap.result
  sensitive = true
}

output "better_auth_secret" {
  value     = random_password.better_auth.result
  sensitive = true
}

output "claim_code" {
  value     = random_password.claim_code.result
  sensitive = true
}

# The host every Worker names as Keel's own (KEEL_HOST, and the console's KEEL_API_HOST).
output "keel_host" {
  value = var.host
}

# Names held for the claimant: KEEL_HELD_NAMES, comma-separated.
output "held_names" {
  value = join(",", var.held_names)
}
