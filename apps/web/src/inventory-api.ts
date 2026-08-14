import { resolveApiBaseUrl } from './catalog';

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
  const response = await fetch(
    `${resolveApiBaseUrl(apiBaseUrl)}/inventory/${encodeURIComponent(input.productId)}/restock`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quantity: input.quantity, priceCents: input.priceCents }),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: unknown } | null;
    throw new Error(typeof body?.message === 'string' ? body.message : `Inventory update failed: HTTP ${response.status}`);
  }
  return (await response.json()) as InventoryRestockResult;
}
