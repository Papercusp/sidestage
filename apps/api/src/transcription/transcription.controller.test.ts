import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuctionAccessService } from '../auction/auction-access.service';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { TranscriptionController } from './transcription.controller';

const SELLER_TOKEN = 'seller-token-with-enough-entropy-for-tests';
const SELLER_PRINCIPAL = 'sidestage-seller';

function productionAccess(): AuctionAccessService {
  return new AuctionAccessService({
    NODE_ENV: 'production',
    SIDESTAGE_AUCTION_SELLER_TOKEN: SELLER_TOKEN,
  } as NodeJS.ProcessEnv);
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
  it('mints a temporary token only after seller authentication and bounded rate checks', async () => {
    const deepgram = {
      mint: vi.fn().mockResolvedValue({ accessToken: 'temporary-jwt', expiresIn: 30 }),
    };
    const access = {
      consumeRateLimit: vi.fn(),
      requireSeller: vi.fn().mockReturnValue({ sellerId: 'sidestage-seller' }),
    };
    const controller = new TranscriptionController(deepgram as never, access as never);

    await expect(controller.mintDeepgramToken(
      {
        authorization: `Bearer ${SELLER_TOKEN}`,
        [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
      },
      '203.0.113.9',
    )).resolves.toEqual({ accessToken: 'temporary-jwt', expiresIn: 30 });

    expect(access.requireSeller).toHaveBeenCalledWith(
      `Bearer ${SELLER_TOKEN}`,
      SELLER_PRINCIPAL,
    );
    expect(access.consumeRateLimit.mock.calls).toEqual([
      ['deepgram-token-ip', '203.0.113.9', 30, 60_000],
      ['deepgram-token-seller', 'sidestage-seller', 10, 60_000],
    ]);
    expect(deepgram.mint).toHaveBeenCalledOnce();
  });

  it('rejects anonymous and forged callers before contacting Deepgram', () => {
    const deepgram = { mint: vi.fn() };
    const access = productionAccess();
    const controller = new TranscriptionController(deepgram as never, access);

    expect(statusOf(() => controller.mintDeepgramToken({}, '203.0.113.10'))).toBe(401);
    expect(statusOf(() => controller.mintDeepgramToken(
      { authorization: 'Bearer forged' },
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
          authorization: `Bearer ${SELLER_TOKEN}`,
          [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
        },
        `203.0.113.${attempt + 20}`,
      );
    }
    expect(statusOf(() => controller.mintDeepgramToken(
      {
        authorization: `Bearer ${SELLER_TOKEN}`,
        [DEMO_PRINCIPAL_HEADER]: SELLER_PRINCIPAL,
      },
      '203.0.113.99',
    ))).toBe(429);
    expect(deepgram.mint).toHaveBeenCalledTimes(10);
  });
});
