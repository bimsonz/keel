# keel.town is one site. The console is the apex origin (a Custom Domain, so
# Cloudflare keeps its DNS record and certificate), and Keel's own paths are
# Workers routes in front of it, which take precedence over the Custom Domain.
# The clone route (/<org>/<project>.git/...) can't be a route pattern, since a
# route allows only a trailing wildcard, so the console forwards it to Keel over
# its service binding. Both scripts are created by wrangler deploy.

data "cloudflare_zone" "site" {
  filter = {
    name = var.host
  }
}

resource "cloudflare_workers_custom_domain" "console" {
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.site.zone_id
  hostname   = var.host
  service    = "keel-console"
}

# Keel's public API, under the same origin as the console, so a session cookie is first-party.
resource "cloudflare_workers_route" "api" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/v1/*"
  script  = "keel"
}

# The MCP endpoint and what is under it (its card, at /mcp/server-card). Two
# patterns and not "/mcp*": a wildcard on the bare word would take the page of
# any handle that begins with it.
resource "cloudflare_workers_route" "mcp" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/mcp"
  script  = "keel"
}

resource "cloudflare_workers_route" "mcp_under" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/mcp/*"
  script  = "keel"
}

# The front door, for an agent that knows only the address: the walk at /start
# and its index at /llms.txt. Exact, with no wildcard: "/start*" would take
# /starter and /startup, which are handles anyone may hold. Both words are
# reserved names, so nobody holds the exact ones.
resource "cloudflare_workers_route" "start" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/start"
  script  = "keel"
}

resource "cloudflare_workers_route" "llms" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/llms.txt"
  script  = "keel"
}

# Everything under /.well-known/ is Keel's to answer, never the console's page:
# its allowed-signers file (/.well-known/keel/allowed-signers), which stock git
# verifies a landed commit against, the OAuth discovery documents, the API
# catalogue and the MCP server card's older place.
resource "cloudflare_workers_route" "well_known" {
  zone_id = data.cloudflare_zone.site.zone_id
  pattern = "${var.host}/.well-known/*"
  script  = "keel"
}
