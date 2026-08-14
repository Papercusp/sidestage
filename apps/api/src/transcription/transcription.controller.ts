import { Controller, Headers, Inject, Ip, Post } from '@nestjs/common';
import { AuctionAccessService, auctionHeader } from '../auction/auction-access.service';
import { DeepgramTokenService, type DeepgramTemporaryToken } from './deepgram-token.service';

type HeadersMap = Record<string, string | string[] | undefined>;

@Controller('transcription')
export class TranscriptionController {
  constructor(
    @Inject(DeepgramTokenService) private readonly deepgramTokens: DeepgramTokenService,
    @Inject(AuctionAccessService) private readonly sellerAccess: AuctionAccessService,
  ) {}

  @Post('deepgram-token')
  mintDeepgramToken(
    @Headers() headers: HeadersMap,
    @Ip() ip: string,
  ): Promise<DeepgramTemporaryToken> {
    this.sellerAccess.consumeRateLimit('deepgram-token-ip', ip || 'unknown', 30, 60_000);
    const seller = this.sellerAccess.requireSeller(auctionHeader(headers, 'authorization'));
    this.sellerAccess.consumeRateLimit('deepgram-token-seller', seller.sellerId, 10, 60_000);
    return this.deepgramTokens.mint();
  }
}
