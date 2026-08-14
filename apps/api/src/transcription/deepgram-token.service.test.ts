import { BadGatewayException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEEPGRAM_GRANT_TIMEOUT_MS, DEEPGRAM_GRANT_URL, DeepgramTokenService } from './deepgram-token.service';

describe('DeepgramTokenService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('mints a short-lived token with the permanent key kept in the authorization header', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'server-only-key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ access_token: 'temporary-jwt', expires_in: 30 }),
    } as unknown as Response);
    const service = new DeepgramTokenService(fetchImpl as unknown as typeof fetch);

    await expect(service.mint()).resolves.toEqual({ accessToken: 'temporary-jwt', expiresIn: 30 });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEEPGRAM_GRANT_URL);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('authorization')).toBe('Token server-only-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
    expect(DEEPGRAM_GRANT_TIMEOUT_MS).toBe(5_000);
    expect(JSON.stringify(await service.mint())).not.toContain('server-only-key');
  });

  it('reports an explicit unconfigured response so the browser may choose its fallback', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '');
    const service = new DeepgramTokenService(vi.fn() as unknown as typeof fetch);

    const error = await service.mint().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      code: 'deepgram_not_configured',
    });
  });

  it('does not forward upstream error bodies or credentials to the browser', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'server-only-key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ message: 'credential server-only-key rejected' }),
    } as unknown as Response);
    const service = new DeepgramTokenService(fetchImpl as unknown as typeof fetch);

    const error = await service.mint().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadGatewayException);
    expect(JSON.stringify((error as BadGatewayException).getResponse())).toBe(
      JSON.stringify({ code: 'deepgram_grant_rejected', message: 'Deepgram token grant failed (401).' }),
    );
  });

  it('rejects malformed successful responses', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'server-only-key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ access_token: '', expires_in: 0 }),
    } as unknown as Response);
    const service = new DeepgramTokenService(fetchImpl as unknown as typeof fetch);

    await expect(service.mint()).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects an unexpectedly long-lived credential instead of forwarding it to the browser', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'server-only-key');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ access_token: 'not-short-lived', expires_in: 3_601 }),
    } as unknown as Response);
    const service = new DeepgramTokenService(fetchImpl as unknown as typeof fetch);

    await expect(service.mint()).rejects.toBeInstanceOf(BadGatewayException);
  });
});
