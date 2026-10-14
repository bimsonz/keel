# scripts/deploy.ts reads these to fill the sentinel ids in each wrangler.jsonc.
output "d1_database_id" {
  value = cloudflare_d1_database.keel.id
}

output "secrets_store_id" {
  value = local.secrets_store_id
}

output "better_auth_secret" {
  value     = random_password.better_auth.result
  sensitive = true
}

output "swarm_admin_token" {
  value     = random_password.swarm_admin.result
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

output "commit_signing_key" {
  value     = tls_private_key.commit_signing.private_key_pem_pkcs8
  sensitive = true
}

# Public: the keys a commit Keel signed verifies against.
output "commit_signers" {
  value = jsonencode(local.commit_signers)
}

# The host every Worker names as Keel's own (KEEL_HOST, and the console's KEEL_API_HOST).
output "keel_host" {
  value = var.host
}
