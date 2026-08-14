import { resolveApiBaseUrl } from './catalog';
import { requestJson } from './events/api';

export interface InventoryRestockMutation {
  productId: string;
  quantity: number;
  priceCents?: number;
}

export interface InventoryRestockResult {
  restocked: true;
  quantity: number;
  snapshot: {
    productId: string;
    qty: number;
    reservedQty: number;
    availableQty: number;
    priceCents?: number;
  };
}

export async function restockInventory(
  input: InventoryRestockMutation,
  apiBaseUrl?: string,
): Promise<InventoryRestockResult> {
  return requestJson<InventoryRestockResult>(
    `${resolveApiBaseUrl(apiBaseUrl)}/inventory/${encodeURIComponent(input.productId)}/restock`,
    {
      method: 'POST',
      body: JSON.stringify({ quantity: input.quantity, priceCents: input.priceCents }),
    },
  );
}
