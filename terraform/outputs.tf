output "url" {
  value       = "https://${cloudflare_workers_custom_domain.game.hostname}"
  description = "Where the game answers."
}
