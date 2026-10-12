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

variable "held_names" {
  description = "Handles and org names held for this instance's claimant (KEEL_HELD_NAMES): no one else may sign up with them, and the claim code releases them."
  type        = list(string)
  default     = ["bimsonz"]
}
