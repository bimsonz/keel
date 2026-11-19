# keel.town after the hosted instance was retired: one static page, served by
# keel-site, a Worker of assets alone (no script, no bindings, no secrets),
# which `wrangler deploy` makes from this directory's wrangler.jsonc. This
# module only points the apex at it, through a Workers Custom Domain, which
# keeps the DNS record and the certificate.
#
# infra/staging, the full instance, holds the same hostname for keel-console:
# destroy this module before applying that one again (infra/README.md).

data "cloudflare_zone" "site" {
  filter = {
    name = var.host
  }
}

resource "cloudflare_workers_custom_domain" "site" {
  account_id = var.account_id
  zone_id    = data.cloudflare_zone.site.zone_id
  hostname   = var.host
  service    = "keel-site"
}
