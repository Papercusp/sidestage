/** Thin EasyPost v2 REST adapter. Shipping credentials never cross this API boundary. */
const EASYPOST_BASE_URL = 'https://api.easypost.com/v2';

export interface EasyPostAddress {
  name: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  phone?: string;
}

export interface EasyPostParcel {
  length: number;
  width: number;
  height: number;
  /** EasyPost expects ounces. */
  weight: number;
}

export interface EasyPostRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  delivery_days: number | null;
  delivery_date?: string | null;
}

export interface EasyPostShipment {
  id: string;
  rates: EasyPostRate[];
  reference?: string;
}

export class EasyPostClient {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

  isConfigured(): boolean {
    return Boolean(process.env.EASYPOST_API_KEY?.trim());
  }

  warehouseAddress(): EasyPostAddress {
    return {
      name: process.env.WAREHOUSE_FROM_NAME?.trim() || 'SideStage',
      street1: process.env.WAREHOUSE_FROM_STREET1?.trim() || '',
      city: process.env.WAREHOUSE_FROM_CITY?.trim() || '',
      state: process.env.WAREHOUSE_FROM_STATE?.trim() || '',
      zip: process.env.WAREHOUSE_FROM_ZIP?.trim() || '',
      country: process.env.WAREHOUSE_FROM_COUNTRY?.trim().toUpperCase() || 'US',
    };
  }

  async createShipment(
    toAddress: EasyPostAddress,
    parcel: EasyPostParcel,
    reference?: string,
  ): Promise<EasyPostShipment> {
    return this.request<EasyPostShipment>('POST', '/shipments', {
      shipment: {
        to_address: toAddress,
        from_address: this.warehouseAddress(),
        parcel,
        ...(reference ? { reference } : {}),
      },
    });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = process.env.EASYPOST_API_KEY?.trim();
    if (!key) throw new Error('EASYPOST_API_KEY is not set');

    const response = await this.fetchImpl(`${EASYPOST_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const payload = json as { error?: { message?: string }; message?: string } | undefined;
      throw new Error(payload?.error?.message ?? payload?.message ?? `EasyPost ${response.status}`);
    }
    return json as T;
  }
}
