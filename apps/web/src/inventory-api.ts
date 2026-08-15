import { resolveApiBaseUrl } from './catalog';
import { requestJson, sellerPrivateRequestHeaders } from './events/api';

export interface InventorySaveMutation {
  productId: string;
  quantity: number;
  priceCents: number;
}

export interface InventorySnapshot {
  productId: string;
  qty: number;
  reservedQty: number;
  availableQty: number;
  priceCents?: number;
}

export interface InventorySaveResult {
  saved: true;
  quantity: number;
  priceCents: number;
  snapshot: InventorySnapshot;
}

export interface InventoryOnboardMutation {
  sourceProductId: string;
  quantity: number;
  priceCents: number;
}

export interface InventoryOnboardResult {
  onboarded: true;
  sourceProductId: string;
  productId: string;
  quantity: number;
  priceCents: number;
  snapshot: InventorySnapshot;
}

export async function saveInventory(
  input: InventorySaveMutation,
  apiBaseUrl?: string,
  principal?: string,
): Promise<InventorySaveResult> {
  return requestJson<InventorySaveResult>(
    `${resolveApiBaseUrl(apiBaseUrl)}/inventory/${encodeURIComponent(input.productId)}`,
    {
      method: 'PUT',
      headers: sellerPrivateRequestHeaders(principal),
      body: JSON.stringify({ quantity: input.quantity, priceCents: input.priceCents }),
    },
  );
}

export async function onboardInventory(
  input: InventoryOnboardMutation,
  apiBaseUrl?: string,
  principal?: string,
): Promise<InventoryOnboardResult> {
  return requestJson<InventoryOnboardResult>(
    `${resolveApiBaseUrl(apiBaseUrl)}/inventory/${encodeURIComponent(input.sourceProductId)}/onboard`,
    {
      method: 'POST',
      headers: sellerPrivateRequestHeaders(principal),
      body: JSON.stringify({ quantity: input.quantity, priceCents: input.priceCents }),
    },
  );
}
