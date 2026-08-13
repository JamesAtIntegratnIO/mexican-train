## What changed

<!-- And why. If it fixes something, describe the broken behaviour, not just the fix. -->

## How it was checked

<!-- CI covers the suites and the soak. Note anything you exercised by hand,
     and anything you could not check — an unverified assumption stated is
     worth more than a green tick that didn't cover it. -->

## Anything a reviewer should know

<!-- Rule changes: does the in-app rules panel still describe the game
     accurately? It has been wrong before.
     Deploy config: wrangler.toml changes are validated by CI's dry run, but a
     binding that resolves is not the same as one that behaves.
     Logging: new log lines are a per-line cost on Workers — is this one worth
     it in the healthy case, and can a stranger trigger it on repeat? -->
