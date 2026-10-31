terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.30"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # Remote state lives in an Azure Storage Account created by infra/bootstrap/bootstrap.sh.
  # The concrete values are passed at init time (see backend.hcl.example and the
  # Terraform GitHub workflow), so no account names are hard-coded here.
  backend "azurerm" {}
}

provider "azurerm" {
  # subscription_id / tenant_id / client_id are read from ARM_* environment variables.
  features {
    key_vault {
      purge_soft_delete_on_destroy = false
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}
