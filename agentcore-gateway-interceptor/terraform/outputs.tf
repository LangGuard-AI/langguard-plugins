output "function_arn" {
  description = "ARN of the interceptor Lambda. Use it in the gateway interceptor configuration."
  value       = aws_lambda_function.interceptor.arn
}

output "role_arn" {
  description = "ARN of the Lambda execution role."
  value       = aws_iam_role.lambda.arn
}

output "key_map_table_name" {
  description = "Name of the STS key map table. Null when sts_key_map_enabled is false."
  value       = var.sts_key_map_enabled ? aws_dynamodb_table.key_map[0].name : null
}
