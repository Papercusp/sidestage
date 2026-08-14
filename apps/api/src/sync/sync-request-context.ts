/**
 * Server half of the canonical demo-principal wire convention exported to
 * browser transports by @papercusp/sync/principal. This local leaf keeps the
 * Nest CommonJS build independent from the React-oriented sync package.
 */
export const DEMO_PRINCIPAL_HEADER = 'x-demo-principal';
export const DEMO_PRINCIPAL_QUERY_PARAM = 'demoPrincipal';

export interface SyncRequestContext {
  principal: string | null;
}

export function normalizeDemoPrincipal(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
