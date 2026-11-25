# The STS key map: a table of temporary access key IDs and the IAM Identity Center user of each.
# A writer function in each Region of `local.key_map_regions` reads the CloudTrail AssumeRoleWithSAML events and
# writes the table in the Region of the interceptor. STS global endpoint calls are logged in `sts_global_region`.

data "aws_region" "current" {}

locals {
  key_map_name    = "${var.function_name}-key-map"
  key_map_regions = var.sts_key_map_enabled ? toset(concat([data.aws_region.current.region, var.sts_global_region], var.sts_key_map_extra_regions)) : toset([])
}

resource "aws_dynamodb_table" "key_map" {
  count        = var.sts_key_map_enabled ? 1 : 0
  name         = local.key_map_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "accessKeyId"

  attribute {
    name = "accessKeyId"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  lifecycle {
    precondition {
      condition     = var.gateway_authorizer_type == "AWS_IAM"
      error_message = "sts_key_map_enabled needs gateway_authorizer_type = \"AWS_IAM\"."
    }
  }
}

data "aws_iam_policy_document" "key_map_read" {
  count = var.sts_key_map_enabled ? 1 : 0
  statement {
    actions   = ["dynamodb:GetItem"]
    resources = [aws_dynamodb_table.key_map[0].arn]
  }
}

resource "aws_iam_role_policy" "key_map_read" {
  count  = var.sts_key_map_enabled ? 1 : 0
  name   = "read-sts-key-map"
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.key_map_read[0].json
}

resource "aws_iam_role" "key_map_writer" {
  count                = var.sts_key_map_enabled ? 1 : 0
  name                 = "${local.key_map_name}-writer-role"
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  permissions_boundary = var.role_permissions_boundary_arn != "" ? var.role_permissions_boundary_arn : null
}

resource "aws_iam_role_policy_attachment" "key_map_writer_logs" {
  count      = var.sts_key_map_enabled ? 1 : 0
  role       = aws_iam_role.key_map_writer[0].name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "key_map_write" {
  count = var.sts_key_map_enabled ? 1 : 0
  statement {
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.key_map[0].arn]
  }
}

resource "aws_iam_role_policy" "key_map_write" {
  count  = var.sts_key_map_enabled ? 1 : 0
  name   = "write-sts-key-map"
  role   = aws_iam_role.key_map_writer[0].id
  policy = data.aws_iam_policy_document.key_map_write[0].json
}

resource "aws_lambda_function" "key_map_writer" {
  for_each         = local.key_map_regions
  region           = each.key
  function_name    = "${local.key_map_name}-writer"
  role             = aws_iam_role.key_map_writer[0].arn
  runtime          = "nodejs22.x"
  handler          = "key-map-writer.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 10
  memory_size      = 128

  environment {
    variables = {
      LANGGUARD_KEY_MAP_TABLE   = aws_dynamodb_table.key_map[0].name
      LANGGUARD_KEY_MAP_REGION  = data.aws_region.current.region
      LANGGUARD_STS_ROLE_PREFIX = var.sts_role_name_prefix
    }
  }

  depends_on = [aws_iam_role_policy_attachment.key_map_writer_logs]
}

# AssumeRoleWithSAML is a read-only management event. EventBridge delivers it only to a rule in this state.
resource "aws_cloudwatch_event_rule" "sign_in" {
  for_each    = local.key_map_regions
  region      = each.key
  name        = "${local.key_map_name}-sign-in"
  description = "IAM Identity Center sign-ins for the LangGuard STS key map."
  state       = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
  event_pattern = jsonencode({
    source        = ["aws.sts"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["sts.amazonaws.com"]
      eventName   = ["AssumeRoleWithSAML"]
    }
  })
}

resource "aws_cloudwatch_event_target" "sign_in" {
  for_each = local.key_map_regions
  region   = each.key
  rule     = aws_cloudwatch_event_rule.sign_in[each.key].name
  arn      = aws_lambda_function.key_map_writer[each.key].arn
}

resource "aws_lambda_permission" "sign_in" {
  for_each      = local.key_map_regions
  region        = each.key
  statement_id  = "AllowEventBridgeSignIn"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.key_map_writer[each.key].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.sign_in[each.key].arn
}
