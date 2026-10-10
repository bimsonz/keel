terraform {
  required_version = ">= 1.14.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.26.0"
    }
  }

  # State is shared through the R2 bucket keel-tfstate. Until its S3 credentials
  # exist, scripts/tf.ts keeps a local state and uploads a timestamped copy to
  # keel-tfstate after every apply (infra/README.md).
}

# Authenticated by CLOUDFLARE_API_TOKEN, which scripts/tf.ts takes from the
# operator's wrangler login. No credential is ever written to a file.
provider "cloudflare" {}
