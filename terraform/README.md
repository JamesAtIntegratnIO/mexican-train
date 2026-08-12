# Deploying

Terraform owns everything: the Worker script, its Durable Object namespace, the
static assets, and the hostname. `wrangler` is used only to create the R2 bucket
that holds Terraform's state, and for local development.

Everything below assumes you're in the flake shell (`nix develop`, or `direnv
allow` once).

## One-time setup

### 1. A Cloudflare API token

Create one at **My Profile → API Tokens → Create Token → Custom token** with:

| Scope | Permission |
| --- | --- |
| Account · Workers Scripts | Edit |
| Account · Workers R2 Storage | Edit |
| Account · Account Settings | Read |
| Zone · Workers Routes | Edit |
| Zone · Zone | Read |
| Zone · DNS | Edit |

Restrict the zone scopes to `integratn.tech`.

Put it in `.env.local` at the repo root — `.envrc` loads it and git ignores it:

```bash
export CLOUDFLARE_API_TOKEN="..."
```

### 2. An R2 token for the state bucket

Terraform has no Cloudflare-native state backend, so state goes in R2 over its
S3-compatible API. That needs a *separate* credential from the API token above:
**R2 → API → Manage API Tokens → Create token**, Object Read & Write. Keep the
Access Key ID and Secret Access Key.

> These are R2 credentials, not AWS ones. Terraform's `s3` backend is an AWS SDK
> client and R2 speaks the same protocol, so the argument names are AWS-shaped.
> No AWS account is involved. They go in `backend.hcl` (git-ignored), following
> [Cloudflare's remote backend guide](https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/).

### 3. Create the state bucket

```bash
wrangler login
wrangler r2 bucket create mexican-train-tfstate
```

### 4. Fill in the two config files

```bash
cd terraform
cp backend.hcl.example backend.hcl              # bucket, endpoint, R2 key pair
cp terraform.tfvars.example terraform.tfvars    # account_id, zone_id, hostname
```

Your account id is in the dashboard URL, or `wrangler whoami`. The zone id is
on the zone's overview page.

### 5. Initialise against R2

```bash
terraform init -backend-config=backend.hcl
```

## Deploying

From the repo root, so the bundle is rebuilt first:

```bash
npm run tf:plan     # build + plan
npm run tf:apply    # build + apply
```

`npm run build` bundles `worker/index.js` (and everything it imports from
`server/`) into `dist/worker.js` with esbuild. Terraform hashes that file, so a
source change is what triggers a new deploy.

## Notes

- **Durable Object migrations.** `migrations.new_tag` in `main.tf` is `v1`. If
  you ever rename or delete `RoomDO`, bump the tag and add the matching
  `renamed_classes` / `deleted_classes` entry — Cloudflare rejects a migration
  whose tag doesn't advance.
- **No state locking**, matching Cloudflare's documented backend config. If more
  than one person will ever run apply, Terraform ≥ 1.11 can do S3-native
  lockfiles — add `use_lockfile = true` to `backend.hcl`.
- **The assets upload** is done by the provider: it hashes `public/`, runs the
  upload session, and attaches the result to the script. No manual JWT.
- Terraform and wrangler both know how to deploy this Worker. Pick one — if you
  `wrangler deploy` over a Terraform-managed script, the next `terraform apply`
  will want to put its own version back. `wrangler` here is for local dev and
  for creating the R2 bucket.
- **Local dev state is version-specific.** If you ever run a different wrangler
  than the flake's, `rm -rf .wrangler` — workerd refuses to open a state DB
  written by a newer build.
