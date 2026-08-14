import { Controller, Inject, Post } from '@nestjs/common';
import { DeepgramTokenService, type DeepgramTemporaryToken } from './deepgram-token.service';

@Controller('transcription')
export class TranscriptionController {
  constructor(
    @Inject(DeepgramTokenService) private readonly deepgramTokens: DeepgramTokenService,
  ) {}

  @Post('deepgram-token')
  mintDeepgramToken(): Promise<DeepgramTemporaryToken> {
    return this.deepgramTokens.mint();
  }
}
