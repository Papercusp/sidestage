import { afterEach, describe, expect, it, vi } from 'vitest';
import { EasyPostClient, type EasyPostShipment } from './easypost.client';

const shipment: EasyPostShipment = {
  id: 'shp_1',
  rates: [{
    id: 'rate_1',
    carrier: 'USPS',
    service: 'Priority',
    rate: '12.50',
    delivery_days: 3,
  }],
};

describe('EasyPostClient', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses native fetch with server-only basic auth and the warehouse address', async () => {
    vi.stubEnv('EASYPOST_API_KEY', 'test-key');
    vi.stubEnv('WAREHOUSE_FROM_NAME', 'SideStage Warehouse');
    vi.stubEnv('WAREHOUSE_FROM_STREET1', '1 Warehouse Way');
    vi.stubEnv('WAREHOUSE_FROM_CITY', 'Austin');
    vi.stubEnv('WAREHOUSE_FROM_STATE', 'TX');
    vi.stubEnv('WAREHOUSE_FROM_ZIP', '78701');
    vi.stubEnv('WAREHOUSE_FROM_COUNTRY', 'us');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue(shipment),
    } as unknown as Response);
    const client = new EasyPostClient(fetchImpl as unknown as typeof fetch);

    await expect(client.createShipment(
      { name: 'Buyer', street1: '99 Main St', city: 'New York', state: 'NY', zip: '10001', country: 'US' },
      { length: 12, width: 10, height: 4, weight: 32 },
      'cart-cart-1-parcel-0',
    )).resolves.toEqual(shipment);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.easypost.com/v2/shipments');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('test-key:').toString('base64')}`,
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      shipment: {
        from_address: {
          name: 'SideStage Warehouse',
          street1: '1 Warehouse Way',
          city: 'Austin',
          state: 'TX',
          zip: '78701',
          country: 'US',
        },
        to_address: { zip: '10001' },
        parcel: { weight: 32 },
        reference: 'cart-cart-1-parcel-0',
      },
    });
  });

  it('reports EasyPost API errors without leaking credentials', async () => {
    vi.stubEnv('EASYPOST_API_KEY', 'test-key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({ error: { message: 'invalid address' } }),
    } as unknown as Response);
    const client = new EasyPostClient(fetchImpl as unknown as typeof fetch);

    await expect(client.createShipment(
      { name: '', street1: '', city: '', state: '', zip: '', country: 'US' },
      { length: 1, width: 1, height: 1, weight: 1 },
    )).rejects.toThrow('invalid address');
  });
});
