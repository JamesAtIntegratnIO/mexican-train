#!/usr/bin/env bash
# Works out whether a failing `terraform apply` is a credentials problem, a
# permissions problem, or a provider problem. Run from the repo root, in the
# same shell you ran apply.
set -uo pipefail

TFVARS=terraform/terraform.tfvars
val() { grep -E "^\s*$1" "$TFVARS" 2>/dev/null | head -1 | sed 's/.*=[[:space:]]*"\?\([^"]*\)"\?.*/\1/'; }
ACCOUNT_ID="${1:-$(val account_id)}"
ZONE_ID="${2:-$(val zone_id)}"

ok()   { printf "  \033[32m✔\033[0m %s\n" "$1"; }
bad()  { printf "  \033[31m✘\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }

probe() { # url -> "http_code|message"
  local code msg
  code=$(curl -s -o /tmp/cfprobe.json -w '%{http_code}' \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:-}" "$1")
  msg=$(python3 -c 'import json,sys
try:
  d=json.load(open("/tmp/cfprobe.json"))
  print("ok" if d.get("success") else (d.get("errors") or [{}])[0].get("message","?"))
except Exception: print("unparseable")' 2>/dev/null)
  echo "$code|$msg"
}

echo
echo "1. Is the token in this shell?"
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  bad "CLOUDFLARE_API_TOKEN is UNSET — this alone causes error 9106."
  echo "     Put it in .env.local; the flake shell loads that on entry."
  echo "     If you were already in the shell, exit and re-enter."
  exit 1
fi
ok "set, ${#CLOUDFLARE_API_TOKEN} chars, starts ${CLOUDFLARE_API_TOKEN:0:6}…"

# Note: /user/tokens/verify only works for *user-owned* tokens. An account-owned
# token is perfectly valid and still 401s there, so it is not a useful gate.
echo
echo "2. Required — deploying the Worker script"
FAIL=0
IFS='|' read -r code msg <<<"$(probe "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts")"
if [ "$code" = "200" ]; then ok "Account · Workers Scripts: Edit"
else bad "Account · Workers Scripts: Edit — HTTP $code ($msg)"; FAIL=1; fi

echo
echo "3. Required — attaching mexicantrain.integratn.tech"
IFS='|' read -r code msg <<<"$(probe "https://api.cloudflare.com/client/v4/zones/$ZONE_ID")"
if [ "$code" = "200" ]; then ok "Zone · Zone: Read"
else bad "Zone · Zone: Read — HTTP $code ($msg)"; FAIL=1; fi

# Workers Routes lives under a *Zone* policy, not an Account one — if this 403s,
# add a second policy scoped to the zone rather than hunting for it in the
# account list, where it does not appear.
IFS='|' read -r code msg <<<"$(probe "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/domains")"
if [ "$code" = "200" ]; then ok "Workers custom domains readable"
else bad "Workers custom domains — HTTP $code ($msg): add a ZONE policy with Workers Routes: Edit"; FAIL=1; fi

echo
echo "4. Optional — only if Terraform ever manages R2 buckets"
IFS='|' read -r code msg <<<"$(probe "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/r2/buckets")"
if [ "$code" = "200" ]; then ok "Account · Workers R2 Storage: Edit"
else warn "Account · Workers R2 Storage — HTTP $code ($msg). Not needed: the state"
     warn "  bucket is reached with the separate R2 key pair in backend.hcl."; fi

echo
if [ "$FAIL" = "0" ]; then
  echo "4. The exact call Terraform failed on — assets-upload-session:"
  IFS='|' read -r code msg <<<"$(curl -s -o /tmp/cfprobe.json -w '%{http_code}|' -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    --data '{"manifest":{"/probe.txt":{"hash":"0123456789abcdef0123456789abcdef","size":4}}}' \
    "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/mexican-train/assets-upload-session")"
  if grep -q 9106 /tmp/cfprobe.json 2>/dev/null; then
    bad "9106 even with the header set by hand — that would be very surprising"
  else
    ok "auth accepted (HTTP $code) — credentials are good, go run: npm run tf:apply"
  fi
else
  warn "Fix the permissions above, then re-run this script."
  echo
  echo "  Cloudflare dashboard → the token → Edit → add under Permissions:"
  echo "    Account · Workers Scripts       Edit"
  echo "    Account · Workers R2 Storage    Edit"
  echo "    Account · Account Settings      Read"
  echo "    Zone    · Workers Routes        Edit"
  echo "    Zone    · Zone                  Read"
  echo "  and make sure Account Resources includes the account you're deploying to."
fi
echo
