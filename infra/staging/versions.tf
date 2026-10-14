terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.26.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "4.4.1"
    }
  }

  # State is shared through the R2 bucket keel-tfstate. Until its S3 credentials
  # exist, scripts/tf.ts keeps a local state and uploads a timestamped copy to
  # keel-tfstate after every apply (infra/README.md).
}

# Authenticated by CLOUDFLARE_API_TOKEN, which scripts/tf.ts takes from the
# operator's wrangler login.
provider "cloudflare" {}

# Only keel's OAuth client is made through this one. A wrangler login cannot
# create OAuth clients, so an account API token holding OAuth Clients Edit alone
# does, from a file of the operator's that scripts/tf.ts reads.
provider "cloudflare" {
  alias = "oauth_clients"
  # With no token, it is configured as the default one is, and makes nothing.
  api_token = var.oauth_clients_api_token == "" ? null : var.oauth_clients_api_token
}
