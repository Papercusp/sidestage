import {
  BadGatewayException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

export const DEEPGRAM_FETCH = Symbol('DEEPGRAM_FETCH');
export const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
export const DEEPGRAM_GRANT_TIMEOUT_MS = 5_000;

export interface DeepgramTemporaryToken {
  accessToken: string;
  expiresIn: number;
}

interface DeepgramGrantResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

/**
 * Mints browser-safe, short-lived Deepgram credentials without ever exposing
 * the permanent API key to Vite or a WebSocket URL.
 */
@Injectable()
export class DeepgramTokenService {
  private readonly fetchImpl: typeof fetch;

  constructor(
    @Optional() @Inject(DEEPGRAM_FETCH) fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  async mint(): Promise<DeepgramTemporaryToken> {
    const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException({
        code: 'deepgram_not_configured',
        message: 'Deepgram transcription is not configured on this server.',
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(DEEPGRAM_GRANT_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Token ${apiKey}`,
        },
        signal: AbortSignal.timeout(DEEPGRAM_GRANT_TIMEOUT_MS),
      });
    } catch {
      throw new BadGatewayException({
        code: 'deepgram_unavailable',
        message: 'Deepgram token service is unavailable.',
      });
    }

    if (!response.ok) {
      throw new BadGatewayException({
        code: 'deepgram_grant_rejected',
        message: `Deepgram token grant failed (${response.status}).`,
      });
    }

    let body: DeepgramGrantResponse;
    try {
      body = await response.json() as DeepgramGrantResponse;
    } catch {
      throw new BadGatewayException({
        code: 'deepgram_invalid_response',
        message: 'Deepgram token service returned an invalid response.',
      });
    }

    const accessToken = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number.NaN;
    if (!accessToken || !Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 3_600) {
      throw new BadGatewayException({
        code: 'deepgram_invalid_response',
        message: 'Deepgram token service returned an invalid response.',
      });
    }

    return { accessToken, expiresIn };
  }
}
