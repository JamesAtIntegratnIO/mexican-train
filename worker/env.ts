// The Worker's bindings, as declared in wrangler.toml.
//
// Everything optional here is genuinely optional at runtime: a missing rate
// limiter is handled rather than assumed (see mintAllowed), and the vars all
// have defaults. Making that optionality explicit is what stops a binding
// being read as present when the deploy never provided it.

/** Cloudflare's rate limiter binding, narrowed to the one call we make. */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** One Durable Object per table. */
  ROOM: DurableObjectNamespace;
  /** The static site in public/. */
  ASSETS: Fetcher;
  NEW_ROOM_LIMIT?: RateLimiterBinding;
  /** Funnel events are cheap enough to send often, so they get their own budget
   *  rather than eating the one that guards table minting. */
  EVENT_LIMIT?: RateLimiterBinding;
  /** Usage telemetry. Optional so that a deploy can decline to collect it:
   *  without these the app is unchanged and simply counts nothing. */
  TABLES?: AnalyticsEngineDataset;
  FUNNEL?: AnalyticsEngineDataset;
  CF_VERSION?: { id?: string };
  EMPTY_GRACE_MIN?: string;
  EMPTY_GRACE_GAME_MIN?: string;
  MAX_LIFETIME_HOURS?: string;
  /** "1" or "true" turns player-to-player chat on. Anything else leaves it off. */
  CHAT_ENABLED?: string;
  LOG_LEVEL?: string;
  ALLOWED_ORIGINS?: string;
}
