variable "langguard_url" {
  description = "Base URL of LangGuard, for example https://langguard.example.com. The Lambda sends requests to <langguard_url>/api/interceptor."
  type        = string

  validation {
    condition     = can(regex("^https://", var.langguard_url))
    error_message = "langguard_url must start with https://."
  }
}

variable "langguard_api_key_secret_arn" {
  description = "ARN of the Secrets Manager secret. The secret value is the plain LangGuard API key (lgr_...)."
  type        = string
}

variable "secret_kms_key_arn" {
  description = "ARN of the customer-managed KMS key that encrypts the secret. Empty means the secret uses the AWS managed key."
  type        = string
  default     = ""
}

variable "function_name" {
  description = "Name of the Lambda function."
  type        = string
  default     = "langguard-agentcore-interceptor"
}

variable "gateway_role_arn" {
  description = "ARN of the gateway service role. When set, the function gets a resource-based permission that lets this role call it. Empty means you add lambda:InvokeFunction to the gateway role yourself."
  type        = string
  default     = ""
}

variable "role_permissions_boundary_arn" {
  description = "ARN of the permissions boundary for the function role. Empty means no boundary."
  type        = string
  default     = ""
}

variable "log_group_name" {
  description = "Name of the CloudWatch Logs group for the function. Empty means the Lambda default, /aws/lambda/<function_name>."
  type        = string
  default     = ""
}

variable "timeout_ms" {
  description = "Time limit in milliseconds for one LangGuard call. The Lambda timeout is set from this value and the 3000 ms limit for the API key read."
  type        = number
  default     = 5000

  validation {
    condition     = floor(var.timeout_ms) == var.timeout_ms && var.timeout_ms > 0 && var.timeout_ms <= 20000
    error_message = "timeout_ms must be a whole number greater than 0 and not more than 20000."
  }
}

variable "gateway_authorizer_type" {
  description = "Inbound authorizer of the gateway: CUSTOM_JWT, AWS_IAM or NONE. The function reads the claims of a bearer token only with CUSTOM_JWT, because only that authorizer verifies the token."
  type        = string
  default     = "CUSTOM_JWT"

  validation {
    condition     = contains(["CUSTOM_JWT", "AWS_IAM", "NONE"], var.gateway_authorizer_type)
    error_message = "gateway_authorizer_type must be CUSTOM_JWT, AWS_IAM or NONE."
  }
}

variable "user_claim" {
  description = "Name of the JWT claim that LangGuard uses as the user ID. Empty means no user ID from a claim."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Subnets for the Lambda. Set them when LangGuard has a private endpoint. Empty means no VPC."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Security groups for the Lambda. Use them together with subnet_ids."
  type        = list(string)
  default     = []
}

variable "sts_key_map_enabled" {
  description = "Make the STS key map, which gives LangGuard the IAM Identity Center user of a gateway call with the AWS_IAM authorizer. It creates a DynamoDB table, a writer function and an EventBridge rule in each Region of the key map, us-east-1 included."
  type        = bool
  default     = false
}

variable "sts_role_name_prefix" {
  description = "Prefix of the role names that the key map accepts. IAM Identity Center roles start with AWSReservedSSO_."
  type        = string
  default     = "AWSReservedSSO_"

  validation {
    condition     = length(var.sts_role_name_prefix) > 0
    error_message = "sts_role_name_prefix must not be empty."
  }
}

variable "sts_global_region" {
  description = "Region where CloudTrail logs the calls to the STS global endpoint: us-east-1 in the commercial partition. Set it for another partition, for example us-gov-west-1."
  type        = string
  default     = "us-east-1"
}

variable "sts_key_map_extra_regions" {
  description = "More Regions that get a writer function and an EventBridge rule for the key map, for example the Regions where your users call STS. The Region of the function and sts_global_region always get them."
  type        = list(string)
  default     = []
}
