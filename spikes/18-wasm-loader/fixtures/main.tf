terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

variable "zone_id" {
  type        = string
  description = "Zone to attach the route to"
}

locals {
  name   = "keel-spike"
  tags   = ["spike", "wasm"]
  copies = 3
}

resource "cloudflare_workers_script" "tool" {
  account_id  = var.account_id
  script_name = "${local.name}-tool"
  content     = file("${path.module}/dist/index.js")
  bindings = [
    { name = "MODE", type = "plain_text", text = "verify" },
  ]
}

output "script" {
  value = cloudflare_workers_script.tool.script_name
}
