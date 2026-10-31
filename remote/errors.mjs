// Only map structured SDK/OS error fields. Never echo raw errors, stderr or URLs.
const assistantErrors = {
  authentication_failed: ['AUTH_EXPIRED', 'Claude 登录已失效，请在服务器重新登录'],
  oauth_org_not_allowed: ['AUTHORIZATION_DENIED', '当前账号没有使用此服务的权限'],
  account_on_hold: ['ACCOUNT_ON_HOLD', 'Claude 账号当前不可用'],
  billing_error: ['BILLING_ERROR', 'Claude 账号计费状态异常'],
  rate_limit: ['RATE_LIMITED', 'Claude 当前触及速率或额度限制'],
  overloaded: ['UPSTREAM_UNAVAILABLE', 'Claude 服务当前繁忙'],
  invalid_request: ['SDK_INVALID_REQUEST', 'Claude 请求无效'],
  model_not_found: ['MODEL_UNAVAILABLE', '当前账号无法使用所选模型'],
  server_error: ['UPSTREAM_UNAVAILABLE', 'Claude 服务当前不可用'],
  cloud_credential_error: ['AUTH_EXPIRED', 'Claude 云端凭据不可用'],
}

const networkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])

export function sdkErrorDetail(error, assistantError) {
  if (typeof assistantError === 'string' && Object.hasOwn(assistantErrors, assistantError)) {
    const [code, message] = assistantErrors[assistantError]
    return { code, message }
  }
  const status = error?.api_error_status ?? error?.status ?? error?.statusCode
  if (status === 401 || error?.name === 'AuthenticationError') return { code: 'AUTH_EXPIRED', message: 'Claude 登录已失效，请在服务器重新登录' }
  if (status === 403) return { code: 'AUTHORIZATION_DENIED', message: 'Claude 服务拒绝了当前账号的请求' }
  if (status === 404) return { code: 'MODEL_UNAVAILABLE', message: '当前账号无法使用所选模型或接口' }
  if (status === 429) return { code: 'RATE_LIMITED', message: 'Claude 当前触及速率或额度限制' }
  if (Number.isInteger(status) && status >= 500 && status <= 599) return { code: 'UPSTREAM_UNAVAILABLE', message: 'Claude 服务当前不可用' }
  if (networkCodes.has(error?.code) || networkCodes.has(error?.cause?.code)) return { code: 'NETWORK', message: '连接 Claude 服务时发生网络错误' }
  return undefined
}
