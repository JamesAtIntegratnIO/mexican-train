// Deployment config, read from the environment by whichever host is running.
//
// Both hosts get their config as strings — `process.env` on Node, `[vars]` on
// Workers — so the parse lives here rather than at each reader, where "0",
// "false" and "off" could quietly come to mean different things on the two
// builds. Anything not explicitly on is off.

export const flagOn = (v: string | undefined): boolean => v === '1' || v === 'true';

/** A number from the environment, or the default if it was never set.
 *
 *  `Number(v || fallback)` is the trap this exists to avoid: it reads "0" as
 *  unset, which for a grace period means the one value that says *clear it
 *  immediately* silently becomes the longest one on offer. Unset and unusable
 *  fall back; zero does not. */
export const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
