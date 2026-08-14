import { Injectable } from '@nestjs/common';
import type { DemoPrincipal } from '@papercusp/sync/principal';

export type SyncQueryArgs = Record<string, unknown>;
export interface SyncRequestContext {
  principal: DemoPrincipal;
}
export type SyncQueryHandler = (
  args: SyncQueryArgs,
  context: SyncRequestContext,
) => unknown[] | Promise<unknown[]>;

/**
 * App-wide named-query registry for the lightweight @papercusp/sync REST
 * transport. Domain modules register their own handlers, which keeps the
 * transport layer independent of the services that supply each result.
 */
@Injectable()
export class SyncQueryRegistry {
  private readonly handlers = new Map<string, SyncQueryHandler>();

  register(name: string, handler: SyncQueryHandler): () => void {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error('sync query name must not be empty');

    const existing = this.handlers.get(normalizedName);
    if (existing && existing !== handler) {
      throw new Error(`sync query already registered: ${normalizedName}`);
    }

    this.handlers.set(normalizedName, handler);
    return () => {
      if (this.handlers.get(normalizedName) === handler) {
        this.handlers.delete(normalizedName);
      }
    };
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async resolve(
    name: string,
    args: SyncQueryArgs,
    context: SyncRequestContext = { principal: null },
  ): Promise<unknown[]> {
    const handler = this.handlers.get(name);
    if (!handler) throw new Error(`unknown sync query: ${name || '<empty>'}`);

    const rows = await handler(args, context);
    if (!Array.isArray(rows)) {
      throw new Error(`sync query must return an array: ${name}`);
    }
    return rows;
  }
}
