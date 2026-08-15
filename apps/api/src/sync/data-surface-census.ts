/**
 * Canonical inventory for the Universal Zero migration.
 *
 * This file is intentionally data-only.  The companion contract test derives
 * tables, query names, mutator names, controller modules, process-local maps,
 * and browser transport modules from the repository and requires every
 * discovered surface to appear here before it can land.
 */

export type DataAudience =
  | 'public'
  | 'buyer-owned'
  | 'seller-owned'
  | 'operational'
  | 'streaming'
  | 'device-local';

export type ZeroDisposition =
  | 'replicate'
  | 'command-with-synced-result'
  | 'purpose-built-transport'
  | 'runtime-only'
  | 'device-local';

export interface SurfaceContract {
  domain: string;
  audiences: readonly DataAudience[];
  authority: string;
  zeroDisposition: ZeroDisposition;
  identityScope: string;
  fallback: string;
  freshnessSlo: string;
  migrationOwner: string;
}

export interface PostgresSurface extends SurfaceContract {
  zeroTable: string;
  queries: readonly string[];
  mutators: readonly string[];
}

const pg = (
  domain: string,
  audiences: readonly DataAudience[],
  identityScope: string,
  queries: readonly string[],
  mutators: readonly string[],
  migrationOwner: string,
): PostgresSurface => ({
  domain,
  audiences,
  authority: 'Postgres public schema',
  zeroDisposition: 'replicate',
  identityScope,
  fallback: 'SSE invalidation then bounded REST polling',
  freshnessSlo: audiences.includes('streaming') ? '<= 1s lifecycle updates' : '<= 2s visible updates',
  migrationOwner,
  zeroTable: domain,
  queries,
  mutators,
});

/** Every table created by db/schema.sql, with its intended Zero contract. */
export const POSTGRES_SURFACES = {
  product_catalog: pg('product_catalog', ['public'], 'public projection', ['catalog.page', 'catalog.types', 'event.lineup.items'], [], 'P-017'),
  storefront_product: pg('storefront_product', ['public', 'seller-owned'], 'seller owner; public availability projection', ['catalog.page', 'event.actions.items', 'event.lineup.items'], ['event.addItems', 'event.adjustStock', 'inventory.save'], 'P-017/P-019'),
  product_option_axes: pg('product_option_axes', ['public'], 'public projection', ['catalog.page', 'event.lineup.items'], [], 'P-017'),
  product_option_values: pg('product_option_values', ['public'], 'public projection', ['catalog.page', 'event.lineup.items'], [], 'P-017'),
  storefront_product_option: pg('storefront_product_option', ['public'], 'public projection', ['catalog.page', 'event.lineup.items'], [], 'P-017'),
  inventory_reservation: pg('inventory_reservation', ['buyer-owned', 'seller-owned', 'operational'], 'buyer/source owner plus seller inventory owner', ['catalog.page', 'cart.byId', 'event.auction.active'], ['cart.holdProduct', 'auction.start', 'auction.close', 'event.adjustStock', 'inventory.save'], 'P-018/P-019'),
  cart: pg('cart', ['buyer-owned'], 'selected buyer/cart owner', ['cart.byId'], ['cart.holdProduct'], 'P-018'),
  chat_message: pg('chat_message', ['public'], 'event room participant', ['event.chat.messages', 'event.chat.stats'], ['chat.sendMessage'], 'P-003/P-017'),
  chat_presence: pg('chat_presence', ['public', 'streaming'], 'event room participant', ['event.chat.presence', 'event.chat.stats'], ['chat.leavePresence', 'chat.touchPresence'], 'P-003/P-017/P-020'),
  chat_transcript_moment: pg('chat_transcript_moment', ['public', 'seller-owned'], 'public event projection; seller command authority', ['event.chat.transcript', 'event.replay.chapters'], ['chat.addTranscriptMoment'], 'P-003/P-017/P-019'),
  scout_session: pg('scout_session', ['buyer-owned'], 'selected buyer', [], [], 'P-018'),
  scout_memory: pg('scout_memory', ['buyer-owned'], 'selected buyer through scout session', [], [], 'P-018'),
  checkout_order: pg('checkout_order', ['buyer-owned'], 'selected buyer/order owner', ['orders.byBuyer'], ['cart.holdProduct'], 'P-018'),
  auction_state: pg('auction_state', ['public', 'seller-owned'], 'public active-auction projection; seller command authority', ['event.auction.active'], ['auction.start', 'auction.placeBid', 'auction.close'], 'P-017/P-019'),
  event_config: pg('event_config', ['seller-owned'], 'event seller owner', ['event.config'], ['event.updateConfig', 'event.setup'], 'P-019'),
  event_lineup_item: pg('event_lineup_item', ['public', 'seller-owned'], 'event seller owner; published event projection', ['event.actions.items', 'event.lineup.items'], ['event.addItems', 'event.executeAction'], 'P-011/P-017/P-019'),
  copilot_proposal: pg('copilot_proposal', ['seller-owned'], 'event seller owner', ['event.copilot.proposals'], ['copilot.createTurn', 'copilot.approve', 'copilot.skip', 'copilot.confirmAction'], 'P-019'),
  event_run_of_show: pg('event_run_of_show', ['seller-owned'], 'event seller owner', ['event.runOfShow'], ['runOfShow.save'], 'P-019'),
  seller_policy_revision: pg('seller_policy_revision', ['seller-owned'], 'seller owner', ['event.config'], ['event.updateConfig'], 'P-019'),
  policy_audit_entry: pg('policy_audit_entry', ['seller-owned', 'operational'], 'seller owner and audit actor', ['event.actions.items'], ['event.executeAction'], 'P-019'),
  policy_outbox_event: pg('policy_outbox_event', ['seller-owned', 'operational'], 'seller owner', [], ['event.executeAction'], 'P-019/P-020'),
  policy_idempotency: pg('policy_idempotency', ['seller-owned', 'operational'], 'seller owner and idempotency key', [], ['event.executeAction'], 'P-019/P-020'),
  event: pg('event', ['public', 'seller-owned'], 'seller owner; explicitly published public projection', ['events.guide', 'events.mine', 'event.stats'], ['event.setup'], 'P-017/P-019'),
  system_test_run: pg('system_test_run', ['operational'], 'authorized operator or release principal', [], [], 'P-020'),
  system_test_suite: pg('system_test_suite', ['operational'], 'parent test-run authority', [], [], 'P-020'),
  system_test_case: pg('system_test_case', ['operational'], 'parent test-run authority', [], [], 'P-020'),
  system_test_artifact: pg('system_test_artifact', ['operational'], 'parent test-run authority; redacted evidence only', [], [], 'P-020'),
  system_test_environment: pg('system_test_environment', ['operational'], 'parent test-run authority', [], [], 'P-020'),
  system_test_fixture_lease: pg('system_test_fixture_lease', ['operational'], 'authorized cleanup worker scoped to one test run', [], [], 'P-020'),
  system_test_fixture_resource: pg('system_test_fixture_resource', ['operational'], 'parent fixture-lease authority; redacted external metadata only', [], [], 'P-020'),
  system_test_transition: pg('system_test_transition', ['operational'], 'parent test-run authority; append-only lifecycle', [], [], 'P-020'),
  system_test_cancellation: pg('system_test_cancellation', ['operational'], 'authorized operator or release principal', [], [], 'P-020'),
  system_test_retention: pg('system_test_retention', ['operational'], 'parent test-run authority', [], [], 'P-020'),
  system_test_cleanup: pg('system_test_cleanup', ['operational'], 'authorized cleanup worker scoped to one test run', [], [], 'P-020'),
} as const satisfies Record<string, PostgresSurface>;

export interface NamedSurface extends SurfaceContract {
  name: string;
  source: string;
  backingTables: readonly string[];
}

const query = (
  name: string,
  source: string,
  domain: string,
  audiences: readonly DataAudience[],
  backingTables: readonly string[],
  identityScope: string,
  migrationOwner: string,
): NamedSurface => ({
  name,
  source,
  domain,
  audiences,
  authority: backingTables.length > 0 ? 'Postgres-backed domain service' : 'domain service pending P-011 persistence',
  zeroDisposition: 'replicate',
  identityScope,
  fallback: 'SSE invalidation then bounded REST polling',
  freshnessSlo: '<= 2s visible updates',
  migrationOwner,
  backingTables,
});

/** Every SyncQueryRegistry registration in apps/api. */
export const SYNC_QUERY_SURFACES: readonly NamedSurface[] = [
  query('build.history', 'build-history/build-history.module.ts', 'build-history', ['operational'], [], 'operator-visible', 'P-020'),
  query('cart.byId', 'cart/cart.module.ts', 'cart', ['buyer-owned'], ['cart'], 'selected buyer/cart owner', 'P-018'),
  query('catalog.page', 'catalog/catalog.module.ts', 'catalog', ['public'], ['product_catalog', 'storefront_product'], 'public projection', 'P-017'),
  query('catalog.types', 'catalog/catalog.module.ts', 'catalog', ['public'], ['product_catalog'], 'public projection', 'P-017'),
  query('inventory.page', 'catalog/catalog.module.ts', 'inventory', ['seller-owned'], ['storefront_product'], 'selected seller', 'P-019'),
  query('event.actions.items', 'actions/action.module.ts', 'actions', ['seller-owned'], ['event_lineup_item'], 'event seller owner', 'P-019'),
  query('event.lineup.items', 'actions/action.module.ts', 'actions', ['public'], ['event_lineup_item', 'storefront_product', 'product_catalog', 'storefront_product_option', 'product_option_axes', 'product_option_values'], 'published event projection', 'P-017'),
  query('event.auction.active', 'auction/auction.module.ts', 'auction', ['public', 'seller-owned'], ['auction_state'], 'public read; seller command authority', 'P-017/P-019'),
  query('event.chat.messages', 'chat/chat.module.ts', 'chat', ['public'], ['chat_message'], 'event room participant', 'P-017'),
  query('event.chat.presence', 'chat/chat.module.ts', 'chat-presence', ['public', 'streaming'], ['chat_presence'], 'event room participant', 'P-017/P-020'),
  query('event.chat.stats', 'chat/chat.module.ts', 'chat-stats', ['public'], ['chat_message', 'chat_presence'], 'public projection', 'P-017'),
  query('event.chat.transcript', 'chat/chat.module.ts', 'transcript', ['public', 'seller-owned'], ['chat_transcript_moment'], 'event visibility policy', 'P-017/P-019'),
  query('event.config', 'config/event-config.module.ts', 'event_config', ['seller-owned'], ['event_config', 'seller_policy_revision'], 'event seller owner', 'P-019'),
  query('event.copilot.proposals', 'copilot/copilot.module.ts', 'copilot_proposal', ['seller-owned'], ['copilot_proposal'], 'event seller owner', 'P-019'),
  query('event.pricingHistory', 'stats/stats.module.ts', 'pricing-history', ['public', 'seller-owned'], ['policy_audit_entry'], 'event visibility policy', 'P-017/P-019'),
  query('event.replay.chapters', 'chat/chat.module.ts', 'replay', ['public'], ['chat_transcript_moment'], 'public event projection', 'P-017'),
  query('event.runOfShow', 'run-of-show/run-of-show.module.ts', 'event_run_of_show', ['seller-owned'], ['event_run_of_show'], 'event seller owner', 'P-019'),
  query('event.stats', 'stats/stats.module.ts', 'event-stats', ['public'], ['event', 'checkout_order', 'auction_state'], 'public projection', 'P-017'),
  query('events.guide', 'events/event.module.ts', 'event-directory', ['public'], ['event'], 'published public projection', 'P-017'),
  query('events.mine', 'events/event.module.ts', 'event-directory', ['seller-owned'], ['event'], 'selected seller', 'P-019'),
  query('judge.latest', 'judge/judge.module.ts', 'judge', ['operational'], [], 'operator-visible', 'P-020'),
  query('orders.byBuyer', 'checkout/checkout.module.ts', 'orders', ['buyer-owned'], ['checkout_order'], 'selected buyer', 'P-018'),
  query('rehearsal.preflight', 'rehearsals/rehearsal.module.ts', 'rehearsal', ['seller-owned', 'operational'], [], 'event seller owner', 'P-020'),
];

const mutator = (
  name: string,
  domain: string,
  audiences: readonly DataAudience[],
  identityScope: string,
  migrationOwner: string,
): NamedSurface => ({
  name,
  source: 'apps/web useSyncMutate call site',
  domain,
  audiences,
  authority: 'API command transaction; durable result must commit before invalidation',
  zeroDisposition: 'command-with-synced-result',
  identityScope,
  fallback: 'explicit REST command fallback',
  freshnessSlo: '<= 2s reconciliation or immediate optimistic rollback',
  migrationOwner,
  backingTables: [],
});

/** Every mutator name consumed by the SideStage web client. */
export const SYNC_MUTATOR_SURFACES: readonly NamedSurface[] = [
  mutator('auction.close', 'auction', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('auction.placeBid', 'auction', ['buyer-owned'], 'selected buyer/bidder', 'P-018'),
  mutator('auction.start', 'auction', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('cart.holdProduct', 'cart', ['buyer-owned'], 'selected buyer/cart owner', 'P-018'),
  mutator('cart.removeItem', 'cart', ['buyer-owned'], 'selected buyer/cart owner', 'P-018'),
  mutator('cart.setQuantity', 'cart', ['buyer-owned'], 'selected buyer/cart owner', 'P-018'),
  mutator('chat.addTranscriptMoment', 'transcript', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('chat.leavePresence', 'chat-presence', ['public', 'streaming'], 'event room participant', 'P-017/P-020'),
  mutator('chat.sendMessage', 'chat', ['public'], 'event room participant', 'P-017'),
  mutator('chat.touchPresence', 'chat-presence', ['public', 'streaming'], 'event room participant', 'P-017/P-020'),
  mutator('checkout.createSession', 'checkout', ['buyer-owned'], 'selected buyer/cart owner', 'P-018/P-020'),
  mutator('copilot.approve', 'copilot', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('copilot.confirmAction', 'copilot', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('copilot.createTurn', 'copilot', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('copilot.skip', 'copilot', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('event.addItems', 'event-items', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('event.adjustStock', 'inventory', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('event.executeAction', 'actions', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('event.setup', 'event-directory', ['seller-owned'], 'selected seller', 'P-019'),
  mutator('event.updateConfig', 'event_config', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('inventory.save', 'inventory', ['seller-owned'], 'selected seller', 'P-019'),
  mutator('judge.run', 'judge', ['operational'], 'operator-visible', 'P-020'),
  mutator('rehearsal.run', 'rehearsal', ['seller-owned', 'operational'], 'event seller owner', 'P-020'),
  mutator('rehearsal.runAll', 'rehearsal', ['seller-owned', 'operational'], 'event seller owner', 'P-020'),
  mutator('runOfShow.save', 'event_run_of_show', ['seller-owned'], 'event seller owner', 'P-019'),
  mutator('shipping.rates', 'shipping', ['buyer-owned'], 'selected buyer/cart owner', 'P-018/P-020'),
];

export interface SourceSurface extends SurfaceContract {
  source: string;
  name: string;
  replacement: string;
}

const local = (
  source: string,
  name: string,
  domain: string,
  audiences: readonly DataAudience[],
  authority: string,
  zeroDisposition: ZeroDisposition,
  replacement: string,
  migrationOwner: string,
): SourceSurface => ({
  source,
  name,
  domain,
  audiences,
  authority,
  zeroDisposition,
  identityScope: audiences.includes('seller-owned') ? 'event seller owner' : audiences.includes('buyer-owned') ? 'selected buyer' : 'runtime scoped',
  fallback: 'none; restart behavior is explicit in the replacement contract',
  freshnessSlo: '<= 2s when client-visible',
  migrationOwner,
  replacement,
});

/** Class fields backed by process-local Maps. Method-local projection maps are not authorities. */
export const PROCESS_LOCAL_SURFACES: readonly SourceSurface[] = [
  local('apps/api/src/actions/action-item.store.ts', 'items', 'actions', ['seller-owned'], 'development fallback authority', 'replicate', 'event_lineup_item', 'P-011/P-019'),
  local('apps/api/src/actions/action.service.ts', 'policies', 'actions-policy', ['seller-owned'], 'temporary authority', 'replicate', 'seller_policy_revision', 'P-011/P-019'),
  local('apps/api/src/actions/action.service.ts', 'offers', 'offers', ['buyer-owned', 'seller-owned'], 'temporary authority', 'replicate', 'Postgres targeted offer table', 'P-011/P-018/P-019'),
  local('apps/api/src/actions/action.service.ts', 'audits', 'action-audit', ['seller-owned', 'operational'], 'temporary authority', 'replicate', 'policy_audit_entry', 'P-011/P-019'),
  local('apps/api/src/actions/action.service.ts', 'idempotentExecutions', 'action-idempotency', ['seller-owned', 'operational'], 'in-flight dedupe', 'runtime-only', 'policy_idempotency plus bounded in-flight promise cache', 'P-011/P-019'),
  local('apps/api/src/auction/auction-access.service.ts', 'counters', 'auction-rate-limit', ['operational'], 'ephemeral rate-limit cache', 'runtime-only', 'bounded runtime rate limiter', 'P-020'),
  local('apps/api/src/auction/auction.service.ts', 'items', 'auction-inventory', ['seller-owned'], 'memory backend authority', 'replicate', 'storefront_product plus inventory_reservation', 'P-011/P-019'),
  local('apps/api/src/auction/auction.service.ts', 'owners', 'auction-inventory-owner', ['seller-owned'], 'memory backend authority', 'replicate', 'storefront_product.seller_id', 'P-011/P-019'),
  local('apps/api/src/auction/auction.service.ts', 'holds', 'auction-holds', ['buyer-owned', 'seller-owned'], 'memory backend authority', 'replicate', 'inventory_reservation', 'P-011/P-018/P-019'),
  local('apps/api/src/auction/auction.service.ts', 'auctions', 'auction', ['public', 'seller-owned'], 'memory backend authority', 'replicate', 'auction_state', 'P-011/P-017/P-019'),
  local('apps/api/src/auction/auction.service.ts', 'eventAvailability', 'auction-event-allocation', ['seller-owned'], 'memory backend authority', 'replicate', 'event_lineup_item.current_quantity', 'P-011/P-019'),
  local('apps/api/src/auction/auction.service.ts', 'currentByEvent', 'auction-index', ['public'], 'derived index', 'runtime-only', 'derive from auction_state', 'P-011/P-017'),
  local('apps/api/src/auction/auction.service.ts', 'updatesByEvent', 'auction-stream', ['streaming'], 'fanout only', 'purpose-built-transport', 'Zero lifecycle rows plus purpose-built transient stream', 'P-020'),
  local('apps/api/src/cart/cart.service.ts', 'carts', 'cart', ['buyer-owned'], 'memory backend authority', 'replicate', 'cart', 'P-011/P-018'),
  local('apps/api/src/chat/chat.service.ts', 'updatesByEvent', 'chat-stream', ['streaming'], 'fanout only', 'purpose-built-transport', 'Postgres chat lifecycle rows plus transient SSE fanout', 'P-020'),
  local('apps/api/src/chat/chat.store.ts', 'events', 'chat', ['public', 'streaming'], 'development fallback authority', 'replicate', 'Postgres chat message/transcript/presence tables in production', 'P-011/P-017/P-020'),
  local('apps/api/src/checkout/order-store.ts', 'orders', 'orders', ['buyer-owned'], 'memory backend authority', 'replicate', 'checkout_order', 'P-011/P-018'),
  local('apps/api/src/checkout/checkout.service.ts', 'paymentEventTails', 'payment-webhook-ordering', ['buyer-owned', 'operational'], 'bounded in-flight serializer', 'runtime-only', 'checkout_order monotonic Stripe event fields plus bounded per-order promise tail', 'P-011/P-018/P-020'),
  local('apps/api/src/config/event-config.service.ts', 'configs', 'event_config', ['seller-owned'], 'memory backend authority', 'replicate', 'event_config', 'P-011/P-019'),
  local('apps/api/src/copilot/copilot.service.ts', 'generationBySource', 'copilot-generation-dedupe', ['seller-owned', 'operational'], 'in-flight dedupe', 'runtime-only', 'copilot_proposal source-message uniqueness plus bounded promise cache', 'P-015 seller Copilot'),
  local('apps/api/src/copilot/copilot.service.ts', 'reconciliationByEvent', 'copilot-question-reconciliation', ['seller-owned', 'operational'], 'in-flight serializer', 'runtime-only', 'durable chat seller-queue state plus idempotent copilot_proposal reconciliation', 'P-015 seller Copilot'),
  local('apps/api/src/copilot/copilot.store.ts', 'proposals', 'copilot', ['seller-owned'], 'memory backend authority', 'replicate', 'copilot_proposal', 'P-011/P-019'),
  local('apps/api/src/policies/policy.service.ts', 'revisions', 'policies', ['seller-owned'], 'memory backend authority', 'replicate', 'seller_policy_revision', 'P-011/P-019'),
  local('apps/api/src/policies/policy.service.ts', 'idem', 'policy-idempotency', ['seller-owned', 'operational'], 'memory backend authority', 'replicate', 'policy_idempotency', 'P-011/P-019'),
  local('apps/api/src/run-of-show/run-of-show.service.ts', 'plans', 'run-of-show', ['seller-owned'], 'memory backend authority', 'replicate', 'event_run_of_show', 'P-011/P-019'),
  local('apps/api/src/scout/scout-session.store.ts', 'sessions', 'scout-session', ['buyer-owned'], 'memory backend authority', 'replicate', 'scout_session and scout_memory', 'P-011/P-018'),
  local('apps/api/src/shipping/shipping.service.ts', 'rateCache', 'shipping-rates', ['buyer-owned', 'operational'], 'external-result cache', 'command-with-synced-result', 'persist quote inputs/status/final result; retain bounded cache', 'P-011/P-018/P-020'),
  local('apps/api/src/sync/sync-query.registry.ts', 'handlers', 'sync-registry', ['operational'], 'runtime registry', 'runtime-only', 'shared typed Zero query registry', 'P-012'),
];

export interface ModuleSurface extends SurfaceContract {
  source: string;
  role: string;
}

const moduleSurface = (
  source: string,
  role: string,
  domain: string,
  audiences: readonly DataAudience[],
  zeroDisposition: ZeroDisposition,
  migrationOwner: string,
): ModuleSurface => ({
  source,
  role,
  domain,
  audiences,
  authority: role,
  zeroDisposition,
  identityScope: audiences.includes('seller-owned') ? 'selected seller/event owner' : audiences.includes('buyer-owned') ? 'selected buyer' : 'explicit public or operational policy',
  fallback: zeroDisposition === 'purpose-built-transport' ? 'purpose-built transport' : 'shared sync REST command/query fallback',
  freshnessSlo: '<= 2s when client-visible',
  migrationOwner,
});

/** Every Nest controller is classified as query/mutator, command, or explicit exception. */
export const CONTROLLER_SURFACES: readonly ModuleSurface[] = [
  moduleSurface('apps/api/src/actions/action.controller.ts', 'seller command/query boundary', 'actions', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/auction/auction.controller.ts', 'public read plus buyer/seller commands', 'auction', ['public', 'buyer-owned', 'seller-owned'], 'command-with-synced-result', 'P-017/P-018/P-019'),
  moduleSurface('apps/api/src/cart/cart.controller.ts', 'buyer command/query boundary', 'cart', ['buyer-owned'], 'command-with-synced-result', 'P-018'),
  moduleSurface('apps/api/src/catalog/catalog.controller.ts', 'public query fallback', 'catalog', ['public'], 'replicate', 'P-017'),
  moduleSurface('apps/api/src/chat/chat.controller.ts', 'room commands and streaming reads', 'chat', ['public', 'streaming'], 'command-with-synced-result', 'P-017/P-020'),
  moduleSurface('apps/api/src/checkout/checkout.controller.ts', 'buyer checkout commands', 'checkout', ['buyer-owned'], 'command-with-synced-result', 'P-018'),
  moduleSurface('apps/api/src/config/event-config.controller.ts', 'seller config command/query boundary', 'event_config', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/copilot/copilot.controller.ts', 'seller copilot commands', 'copilot', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/events/event.controller.ts', 'public directory plus seller commands', 'event-directory', ['public', 'seller-owned'], 'command-with-synced-result', 'P-017/P-019'),
  moduleSurface('apps/api/src/health.controller.ts', 'runtime health probe', 'health', ['operational'], 'runtime-only', 'P-020'),
  moduleSurface('apps/api/src/inventory/inventory.controller.ts', 'seller inventory commands', 'inventory', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/judge/judge.controller.ts', 'operational command/query boundary', 'judge', ['operational'], 'command-with-synced-result', 'P-020'),
  moduleSurface('apps/api/src/policies/policy.controller.ts', 'seller policy commands', 'policies', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/rehearsals/rehearsal.controller.ts', 'seller operational commands and stream', 'rehearsal', ['seller-owned', 'operational', 'streaming'], 'command-with-synced-result', 'P-020'),
  moduleSurface('apps/api/src/run-of-show/run-of-show.controller.ts', 'seller command/query boundary', 'run-of-show', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/api/src/scout/scout.controller.ts', 'buyer AI command/stream boundary', 'scout', ['buyer-owned', 'streaming'], 'purpose-built-transport', 'P-018/P-020'),
  moduleSurface('apps/api/src/shipping/shipping.controller.ts', 'buyer external command boundary', 'shipping', ['buyer-owned'], 'command-with-synced-result', 'P-018/P-020'),
  moduleSurface('apps/api/src/sync/sync.controller.ts', 'shared query and invalidation transport', 'sync', ['public', 'buyer-owned', 'seller-owned', 'operational'], 'runtime-only', 'P-012/P-014'),
  moduleSurface('apps/api/src/system-tests/system-tests.controller.ts', 'authorized system-test run command/read boundary', 'system-tests', ['operational'], 'command-with-synced-result', 'P-020'),
  moduleSurface('apps/api/src/transcription/transcription.controller.ts', 'ephemeral media token boundary', 'transcription', ['seller-owned', 'streaming'], 'purpose-built-transport', 'P-020'),
];

/** Browser modules that still own direct fetch/EventSource access during migration. */
export const CLIENT_TRANSPORT_SURFACES: readonly ModuleSurface[] = [
  moduleSurface('apps/web/src/ConfigTab.tsx', 'useSyncMutate REST fallback', 'event_config', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/web/src/CopilotPanel.tsx', 'useSyncMutate REST fallback', 'copilot', ['seller-owned'], 'command-with-synced-result', 'P-019'),
  moduleSurface('apps/web/src/auction.ts', 'auction command fallback', 'auction', ['public', 'buyer-owned', 'seller-owned'], 'command-with-synced-result', 'P-017/P-018/P-019'),
  moduleSurface('apps/web/src/buyer-checkout-api.ts', 'checkout command fallback', 'checkout', ['buyer-owned'], 'command-with-synced-result', 'P-018'),
  moduleSurface('apps/web/src/catalog.ts', 'catalog query fallback', 'catalog', ['public'], 'replicate', 'P-017'),
  moduleSurface('apps/web/src/chat-api.ts', 'chat command fallback', 'chat', ['public'], 'command-with-synced-result', 'P-017'),
  moduleSurface('apps/web/src/events/api.ts', 'event/run-of-show command fallback', 'events', ['public', 'seller-owned'], 'command-with-synced-result', 'P-017/P-019'),
  moduleSurface('apps/web/src/judge.ts', 'judge command fallback', 'judge', ['operational'], 'command-with-synced-result', 'P-020'),
  moduleSurface('apps/web/src/rehearsals.ts', 'rehearsal command fallback and progress stream', 'rehearsal', ['seller-owned', 'operational', 'streaming'], 'purpose-built-transport', 'P-020'),
];

/** Device-local state stays outside Zero and must never contain server authority. */
export const DEVICE_LOCAL_SURFACES: readonly ModuleSurface[] = [
  'apps/web/src/BuyerScoutDrawer.tsx',
  'apps/web/src/SellerDock.tsx',
  'apps/web/src/buyer-checkout-api.ts',
  'apps/web/src/buyer-identity.ts',
  'apps/web/src/rehearsals.ts',
  'apps/web/src/seller-dock-layout.ts',
  'apps/web/src/seller-dock-store.ts',
].map((source) => moduleSurface(source, 'device-local UI/cache state only', 'browser-state', ['device-local'], 'device-local', 'P-020'));

/** API calls whose raw bytes/tokens/RPC stay purpose-built while final results sync. */
export const EXTERNAL_COMMAND_SURFACES: readonly (ModuleSurface & { usesRawFetch: boolean })[] = [
  { ...moduleSurface('apps/api/src/copilot/copilot.model.ts', 'OpenAI response command', 'copilot-model', ['seller-owned', 'operational'], 'command-with-synced-result', 'P-019/P-020'), usesRawFetch: true },
  { ...moduleSurface('apps/api/src/chat/product-focus.classifier.ts', 'OpenAI classification command', 'chat-classifier', ['seller-owned', 'operational'], 'command-with-synced-result', 'P-019/P-020'), usesRawFetch: true },
  { ...moduleSurface('apps/api/src/shipping/shipping.service.ts', 'shipping-rate provider command', 'shipping', ['buyer-owned', 'operational'], 'command-with-synced-result', 'P-018/P-020'), usesRawFetch: false },
  { ...moduleSurface('apps/api/src/checkout/checkout.service.ts', 'Square checkout/payment command', 'payment', ['buyer-owned', 'operational'], 'command-with-synced-result', 'P-018/P-020'), usesRawFetch: false },
  { ...moduleSurface('apps/api/src/transcription/deepgram-token.service.ts', 'Deepgram ephemeral token command', 'transcription', ['seller-owned', 'streaming'], 'purpose-built-transport', 'P-020'), usesRawFetch: false },
];

export function findUnclassified(discovered: readonly string[], declared: readonly string[]): string[] {
  const known = new Set(declared);
  return [...new Set(discovered)].filter((value) => !known.has(value)).sort();
}
