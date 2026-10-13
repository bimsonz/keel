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

output "better_auth_secret" {
  value     = random_password.better_auth.result
  sensitive = true
}

output "bundle_url_signing_key" {
  value     = tls_private_key.bundle_url.private_key_pem_pkcs8
  sensitive = true
}

# Public: it verifies a bundle URL's signature and signs nothing.
output "bundle_url_public_key" {
  value = tls_private_key.bundle_url.public_key_pem
}

# The host every Worker names as Keel's own (KEEL_HOST, and the console's KEEL_API_HOST).
output "keel_host" {
  value = var.host
}
