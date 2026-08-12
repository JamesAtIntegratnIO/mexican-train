terraform {
  required_version = ">= 1.9"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State lives in R2, reached over its S3-compatible API. Terraform has no
  # Cloudflare-native backend, so the "s3" backend is the documented route:
  # https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/
  #
  # The bucket, endpoint and R2 credentials are supplied at init time, keeping
  # the account id and secrets out of git:
  #   terraform init -backend-config=backend.hcl
  backend "s3" {
    region = "auto"

    # R2 is not AWS, so every AWS-shaped preflight check has to be turned off.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment.
}
