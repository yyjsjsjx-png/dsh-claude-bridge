// Account model capabilities are stable metadata. Refresh only on demand;
// this cache never establishes authentication or guarantees model execution.
export const MODEL_CATALOG_CACHE_MS = 6 * 60 * 60 * 1000

export function isModelCatalogAuthFailure(code) {
  return ['AUTH_REQUIRED', 'AUTH_EXPIRED', 'AUTH_FLOW_FAILED', 'AUTH_STATUS_UNAVAILABLE',
    'AUTH_METHOD_UNSUPPORTED', 'AUTHORIZATION_DENIED', 'ACCOUNT_ON_HOLD'].includes(code)
}
