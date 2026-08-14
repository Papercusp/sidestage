import { Injectable } from '@nestjs/common';
import { Subject, type Observable } from 'rxjs';

export interface SyncInvalidation {
  name: string;
  args?: Record<string, unknown>;
  tsMs: number;
}

/** One process-wide invalidation stream shared by every sync-enabled domain. */
@Injectable()
export class SyncInvalidationService {
  private readonly invalidations = new Subject<SyncInvalidation>();

  events(): Observable<SyncInvalidation> {
    return this.invalidations.asObservable();
  }

  invalidate(name: string, args?: Record<string, unknown>): SyncInvalidation {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('sync invalidation name must not be empty');

    const event: SyncInvalidation = {
      name: normalizedName,
      ...(args ? { args } : {}),
      tsMs: Date.now(),
    };
    this.invalidations.next(event);
    return event;
  }
}
