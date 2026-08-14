import { Module } from '@nestjs/common';
import { DeepgramTokenService } from './deepgram-token.service';
import { TranscriptionController } from './transcription.controller';

@Module({
  controllers: [TranscriptionController],
  providers: [DeepgramTokenService],
})
export class TranscriptionModule {}
