import { Module } from '@nestjs/common';
import { AuctionAccessService } from '../auction/auction-access.service';
import { DeepgramTokenService } from './deepgram-token.service';
import { TranscriptionController } from './transcription.controller';

@Module({
  controllers: [TranscriptionController],
  providers: [
    {
      provide: AuctionAccessService,
      useFactory: () => new AuctionAccessService(),
    },
    DeepgramTokenService,
  ],
})
export class TranscriptionModule {}
