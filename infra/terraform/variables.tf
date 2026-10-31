variable "project" {
  description = "Short project name used in resource names."
  type        = string
  default     = "finnova"
}

variable "environment" {
  description = "Environment name used in resource names."
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Azure region for all resources."
  type        = string
  default     = "westeurope"
}

variable "unique_suffix" {
  description = "Short suffix that makes globally unique names (ACR, Key Vault, PostgreSQL) unique. 3-6 lowercase letters/digits."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{3,6}$", var.unique_suffix))
    error_message = "unique_suffix must be 3-6 lowercase letters or digits."
  }
}

variable "admin_object_ids" {
  description = "Entra ID object IDs (users or groups) that get cluster-admin on AKS and secret access in Key Vault, e.g. your own user."
  type        = list(string)
  default     = []
}

# ---------- Network ----------
variable "vnet_address_space" {
  type    = string
  default = "10.10.0.0/16"
}

variable "aks_subnet_prefix" {
  type    = string
  default = "10.10.0.0/22"
}

variable "postgres_subnet_prefix" {
  type    = string
  default = "10.10.8.0/24"
}

# ---------- AKS ----------
variable "kubernetes_version" {
  description = "AKS Kubernetes version. null = latest default version in the region."
  type        = string
  default     = null
}

variable "aks_sku_tier" {
  description = "Free (no SLA) or Standard (financially backed uptime SLA, recommended for real production)."
  type        = string
  default     = "Free"
}

variable "aks_node_vm_size" {
  type    = string
  default = "Standard_D2s_v5"
}

variable "aks_node_min_count" {
  type    = number
  default = 2
}

variable "aks_node_max_count" {
  type    = number
  default = 4
}

# ---------- Container registry ----------
variable "acr_sku" {
  type    = string
  default = "Standard"
}

# ---------- PostgreSQL ----------
variable "postgres_version" {
  type    = string
  default = "16"
}

variable "postgres_sku" {
  description = "B_Standard_B1ms is cheap; use e.g. GP_Standard_D2ds_v5 for real production (required for HA)."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  type    = number
  default = 32768
}

variable "postgres_admin_login" {
  type    = string
  default = "finnovaadmin"
}

variable "postgres_database_name" {
  type    = string
  default = "finnova"
}

variable "postgres_backup_retention_days" {
  type    = number
  default = 14
}

variable "postgres_geo_redundant_backup" {
  type    = bool
  default = false
}

variable "postgres_high_availability" {
  description = "Zone-redundant HA. Requires a General Purpose / Memory Optimized SKU."
  type        = bool
  default     = false
}

# ---------- Key Vault ----------
variable "key_vault_purge_protection" {
  description = "Recommended for production. Note: once enabled it cannot be disabled, and a deleted vault name stays reserved for the retention period."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
