variable "account_id" {
  description = "The Cloudflare account keel.town is served from. Read from CLOUDFLARE_ACCOUNT_ID at run time; never committed."
  type        = string
  sensitive   = true
}

variable "host" {
  description = "The site's host."
  type        = string
  default     = "keel.town"
}
