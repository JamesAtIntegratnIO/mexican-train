variable "account_id" {
  type        = string
  description = "Cloudflare account id."
}

variable "zone_id" {
  type        = string
  description = "Zone id of the domain the hostname belongs to."
}

variable "hostname" {
  type        = string
  description = "Where the game answers, e.g. mexicantrain.integratn.tech."
}

variable "worker_name" {
  type        = string
  default     = "mexican-train"
  description = "Name of the Worker to route the hostname to. Must match `name` in wrangler.toml, which is what actually deploys it."
}
