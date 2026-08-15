import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuctionAccessService } from '../auction/auction-access.service';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { TranscriptionController } from './transcription.controller';

const SELLER_PRINCIPAL = 'sidestage-seller';

function productionAccess(): AuctionAccessService {
  return new AuctionAccessService({ NODE_ENV: 'production' } as NodeJS.ProcessEnv);
}

function statusOf(run: () => unknown): number {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('Expected an HttpException');
}

describe('TranscriptionController Deepgram boundary', () => {
  it('mints a temporary token only for a selected seller principal and bounded rate checks', async () => {
    const deepgram = {
      mint: vi.fn().mockResolvedValue({ accessToken: 'temporary-jwt', expiresIn: 30 }),
    };
    const access = {
      consumeRateLimit: vi.fn(),
      requireSellerPrincipal: vi.fn().mockReturnValue({ sellerId: 'seller-sidestage-seller' }),
    };
    const controller = new TranscriptionController(deepgram as never, access as never);

    await expect(controller.mintDeepgramToken(
      {
        [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
      },
      '203.0.113.9',
    )).resolves.toEqual({ accessToken: 'temporary-jwt', expiresIn: 30 });

    expect(access.requireSellerPrincipal).toHaveBeenCalledWith(SELLER_PRINCIPAL);
    expect(access.consumeRateLimit.mock.calls).toEqual([
      ['deepgram-token-ip', '203.0.113.9', 30, 60_000],
      ['deepgram-token-seller', 'seller-sidestage-seller', 10, 60_000],
    ]);
    expect(deepgram.mint).toHaveBeenCalledOnce();
  });

  it('rejects missing principals and does not accept a bearer credential as authority', () => {
    const deepgram = { mint: vi.fn() };
    const access = productionAccess();
    const controller = new TranscriptionController(deepgram as never, access);

    expect(statusOf(() => controller.mintDeepgramToken({}, '203.0.113.10'))).toBe(401);
    expect(statusOf(() => controller.mintDeepgramToken(
      { authorization: 'Bearer seller-token-with-enough-entropy-for-tests' },
      '203.0.113.11',
    ))).toBe(401);
    expect(deepgram.mint).not.toHaveBeenCalled();
  });

  it('rate-limits repeated mint attempts without contacting Deepgram', () => {
    const deepgram = { mint: vi.fn() };
    const access = productionAccess();
    const controller = new TranscriptionController(deepgram as never, access);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      void controller.mintDeepgramToken(
        {
          [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
        },
        `203.0.113.${attempt + 20}`,
      );
    }
    expect(statusOf(() => controller.mintDeepgramToken(
      {
        [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
      },
      '203.0.113.99',
    ))).toBe(429);
    expect(deepgram.mint).toHaveBeenCalledTimes(10);
  });
});
