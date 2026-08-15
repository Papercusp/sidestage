import { resolveApiBaseUrl } from './catalog';
import { requestJson } from './events/api';

export interface InventorySaveMutation {
  productId: string;
  quantity: number;
  priceCents: number;
}

export interface InventorySaveResult {
  saved: true;
  quantity: number;
  priceCents: number;
  snapshot: {
    productId: string;
    qty: number;
    reservedQty: number;
    availableQty: number;
    priceCents?: number;
  };
}

export async function saveInventory(
  input: InventorySaveMutation,
  apiBaseUrl?: string,
): Promise<InventorySaveResult> {
  return requestJson<InventorySaveResult>(
    `${resolveApiBaseUrl(apiBaseUrl)}/inventory/${encodeURIComponent(input.productId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ quantity: input.quantity, priceCents: input.priceCents }),
    },
  );
}
