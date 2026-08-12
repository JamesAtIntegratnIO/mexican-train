# Terraform owns the infrastructure around the Worker, not the Worker itself.
#
# The script, its bindings, the static assets and the Durable Object migrations
# are deployed by wrangler (see .github/workflows/deploy.yml). wrangler is the
# native tool for those and tracks migration tags properly; Terraform needed
# hand-holding for both and would fight wrangler over ownership.
#
# What lives here is the stuff that is created once and then left alone.

# Binds the hostname to the Worker and issues the certificate. Creating this also
# manages the DNS record, so there is no separate record resource.
#
# `service` is a plain string rather than a reference — the script is deployed
# out-of-band, so Terraform only needs to know its name.
resource "cloudflare_workers_custom_domain" "game" {
  account_id = var.account_id
  zone_id    = var.zone_id
  hostname   = var.hostname
  service    = var.worker_name
}
