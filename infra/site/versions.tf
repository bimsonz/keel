terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.26.0"
    }
  }

  # Local state, backed up to the keel-tfstate R2 bucket after every apply by
  # scripts/tf.ts, as infra/staging's is (infra/README.md).
}

# Authenticated by CLOUDFLARE_API_TOKEN, which scripts/tf.ts takes from the
# operator's wrangler login.
provider "cloudflare" {}
