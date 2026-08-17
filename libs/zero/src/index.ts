/**
 * `@papercusp/sidestage-zero` — the SideStage Zero contract.
 *
 * ONE package imported identically by both sides of the sync boundary:
 *   - the browser, through `<SyncProvider syncType="WEBSOCKETS" schema={schema}
 *     queries={queries} mutators={createMutators()} />` (apps/web/src/main.tsx), and
 *   - the API, in the `/zero/query` and `/zero/mutate` handlers that zero-cache
 *     calls to resolve named queries and apply mutations.
 *
 * Importing the same module on both sides is what makes schema/query/mutator
 * drift impossible by construction rather than by review.
 */
export {
  schema,
  zql,
  REPLICATED_TABLES,
  UNPUBLISHABLE_COLUMNS,
  // tables
  event,
  eventLineupItem,
  eventConfig,
  eventRunOfShow,
  auctionState,
  chatMessage,
  chatPresence,
  chatTranscriptMoment,
  copilotProposal,
  sellerPolicyRevision,
  actionAuditEntry,
  cart,
  checkoutOrder,
  inventoryReservation,
  productCatalog,
  storefrontProduct,
  productOptionAxis,
  productOptionValue,
  storefrontProductOption,
} from './schema';

export type {
  Schema,
  EventRow,
  EventLineupItemRow,
  EventConfigRow,
  EventRunOfShowRow,
  AuctionStateRow,
  ChatMessageRow,
  ChatPresenceRow,
  ChatTranscriptMomentRow,
  CopilotProposalRow,
  SellerPolicyRevisionRow,
  ActionAuditEntryRow,
  CartRow,
  CheckoutOrderRow,
  InventoryReservationRow,
  ProductCatalogRow,
  StorefrontProductRow,
  ProductOptionAxisRow,
  ProductOptionValueRow,
  StorefrontProductOptionRow,
} from './schema';

export {
  queries,
  SYNCED_QUERY_PRINCIPAL_SCOPE,
  UNSYNCED_QUERY_REASONS,
  CONTRACT_AHEAD_OF_REGISTRY,
} from './queries';
export type { Queries, SyncedQueryName } from './queries';

export { createMutators, REST_COMMAND_MUTATORS } from './mutators';
export type {
  Mutators,
  SideStageMutatorContext,
  TouchPresenceArgs,
  LeavePresenceArgs,
} from './mutators';
