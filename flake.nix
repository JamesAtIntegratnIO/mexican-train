{
  description = "Mexican Train — dev shell and toolchain";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Terraform is BUSL-licensed, which nixpkgs treats as unfree. Swap the
        # `terraform` entry below for `opentofu` if you'd rather avoid that.
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24          # local Node server, and npm for the app's deps
            wrangler           # Workers CLI: local dev, R2 buckets
            terraform          # infrastructure
            jq                 # poking at wrangler/terraform JSON output
            curl
          ];

          # node_modules/.bin is appended, not prepended, so a stale npm-installed
          # wrangler can't shadow the one this flake pins.
          shellHook = ''
            export PATH="$PATH:$PWD/node_modules/.bin"

            # `nix develop` does not read .envrc, so direnv's dotenv line never
            # runs on that path. Load secrets here instead and both entry points
            # behave the same. set -a exports bare KEY=value as well as export'd.
            if [ -f .env.local ]; then
              set -a; . ./.env.local; set +a
            fi

            echo "  mexican train"
            echo "    node       $(node --version)"
            echo "    wrangler   $(wrangler --version 2>/dev/null | tail -1)"
            echo "    terraform  $(terraform version -json | jq -r .terraform_version 2>/dev/null || echo '?')"
            echo ""
            if [ -n "''${CLOUDFLARE_API_TOKEN:-}" ]; then
              echo "    cloudflare token  loaded from .env.local"
            else
              echo "    cloudflare token  NOT SET — terraform apply will fail with error 9106."
              echo "                      put 'CLOUDFLARE_API_TOKEN=...' in .env.local"
            fi
            echo ""
            echo "    npm run dev         local Node server     :3000"
            echo "    npm run cf:dev      local Worker + DOs    :8787"
            echo "    npm run soak        replay the rules engine"
            echo "    npm run cf:deploy   ship the Worker (CI does this on main)"
            echo "    npm run tf:apply    infrastructure only"
          '';
        };
      });
}
