import { Injectable } from '@nestjs/common';
import { normalizeDemoPrincipal } from '@papercusp/sync/principal';
import { Subject, type Observable } from 'rxjs';
import type { SyncRequestContext } from './sync-query.registry';

export interface SyncInvalidation {
  name: string;
  args?: Record<string, unknown>;
  /** Omitted for a public/global event; set for one selected demo principal. */
  principal?: string;
  tsMs: number;
}

/** One process-wide invalidation stream shared by every sync-enabled domain. */
@Injectable()
export class SyncInvalidationService {
  private readonly invalidations = new Subject<SyncInvalidation>();

  events(): Observable<SyncInvalidation> {
    return this.invalidations.asObservable();
  }

  invalidate(
    name: string,
    args?: Record<string, unknown>,
    context?: Partial<SyncRequestContext>,
  ): SyncInvalidation {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('sync invalidation name must not be empty');

    const principal = normalizeDemoPrincipal(context?.principal);
    const event: SyncInvalidation = {
      name: normalizedName,
      ...(args ? { args } : {}),
      ...(principal ? { principal } : {}),
      tsMs: Date.now(),
    };
    this.invalidations.next(event);
    return event;
  }
}
