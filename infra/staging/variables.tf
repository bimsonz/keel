variable "account_id" {
  description = "The Cloudflare account Keel deploys to. Read from CLOUDFLARE_ACCOUNT_ID at run time; never committed."
  type        = string
  sensitive   = true
}

variable "environment" {
  description = "The environment every resource name carries after its keel- prefix."
  type        = string
  default     = "staging"
}

variable "host" {
  description = "The one site Keel serves: the console at its apex, Keel's API and MCP under it."
  type        = string
  default     = "keel.town"
}

variable "oauth_clients_api_token" {
  description = "An account API token holding only Account > OAuth Clients > Edit, which makes keel's OAuth client: a wrangler login cannot. scripts/tf.ts reads it from ~/.keel/cloudflare-oauth-clients-token; never committed. Empty, no client is made."
  type        = string
  sensitive   = true
  default     = ""
}
