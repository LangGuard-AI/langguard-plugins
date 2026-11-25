terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # 6.0 adds the `region` argument that key-map.tf uses.
      version = ">= 6.0, < 7.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

locals {
  in_vpc = length(var.subnet_ids) > 0
  # The function waits up to 3000 ms for the API key, then up to timeout_ms for LangGuard.
  lambda_timeout_s = ceil((var.timeout_ms + 3000) / 1000) + 2
  # Secrets Manager decrypts in the Region of the secret, which can differ from the Region of the function.
  secret_region = split(":", var.langguard_api_key_secret_arn)[3]
}

data "aws_partition" "current" {}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../src"
  output_path = "${path.module}/.build/${var.function_name}.zip"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name                 = "${var.function_name}-role"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.role_permissions_boundary_arn != "" ? var.role_permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "vpc" {
  count      = local.in_vpc ? 1 : 0
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "secret" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.langguard_api_key_secret_arn]
  }

  dynamic "statement" {
    for_each = var.secret_kms_key_arn != "" ? [var.secret_kms_key_arn] : []
    content {
      actions   = ["kms:Decrypt"]
      resources = [statement.value]
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["secretsmanager.${local.secret_region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_iam_role_policy" "secret" {
  name   = "read-langguard-api-key"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.secret.json
}

resource "aws_lambda_function" "interceptor" {
  function_name    = var.function_name
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = local.lambda_timeout_s
  memory_size      = 256

  environment {
    variables = merge(
      {
        LANGGUARD_URL                = var.langguard_url
        LANGGUARD_API_KEY_SECRET_ARN = var.langguard_api_key_secret_arn
        LANGGUARD_TIMEOUT_MS         = tostring(var.timeout_ms)
        LANGGUARD_AUTHORIZER         = var.gateway_authorizer_type
      },
      var.user_claim != "" ? { LANGGUARD_USER_CLAIM = var.user_claim } : {},
      var.sts_key_map_enabled ? { LANGGUARD_KEY_MAP_TABLE = aws_dynamodb_table.key_map[0].name } : {},
    )
  }

  dynamic "vpc_config" {
    for_each = local.in_vpc ? [1] : []
    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  dynamic "logging_config" {
    for_each = var.log_group_name != "" ? [var.log_group_name] : []
    content {
      log_format = "Text"
      log_group  = logging_config.value
    }
  }

  lifecycle {
    precondition {
      condition     = !local.in_vpc || length(var.security_group_ids) > 0
      error_message = "Set security_group_ids when subnet_ids is set."
    }
    precondition {
      condition     = var.user_claim == "" || var.gateway_authorizer_type == "CUSTOM_JWT"
      error_message = "user_claim needs gateway_authorizer_type = \"CUSTOM_JWT\"."
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.logs,
    aws_iam_role_policy_attachment.vpc,
  ]
}

# Lets the gateway service role call the function, with no change to that role.
resource "aws_lambda_permission" "gateway" {
  count         = var.gateway_role_arn != "" ? 1 : 0
  statement_id  = "AllowAgentCoreGatewayRole"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.interceptor.function_name
  principal     = var.gateway_role_arn
}
