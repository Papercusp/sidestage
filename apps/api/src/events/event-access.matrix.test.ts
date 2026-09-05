import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ActionController } from '../actions/action.controller';
import { AuctionController } from '../auction/auction.controller';
import { CartController } from '../cart/cart.controller';
import { ChatController } from '../chat/chat.controller';
import { EventConfigController } from '../config/event-config.controller';
import { CopilotController } from '../copilot/copilot.controller';
import { PolicyController } from '../policies/policy.controller';
import { RehearsalController } from '../rehearsals/rehearsal.controller';
import { RunOfShowController } from '../run-of-show/run-of-show.controller';
import { StatsController } from '../stats/stats.module';
import { SyncController } from '../sync/sync.controller';
import { TranscriptionController } from '../transcription/transcription.controller';
import { EVENT_ACCESS } from './event-access.registry';
import { EventController } from './event.controller';

type ControllerType = { name: string; prototype: object };

const REPO_ROOT = resolve(__dirname, '../../../..');
const API_ROOT = join(REPO_ROOT, 'apps/api/src');

const EVENT_CONTROLLERS: readonly { source: string; controller: ControllerType }[] = [
  { source: 'apps/api/src/actions/action.controller.ts', controller: ActionController },
  { source: 'apps/api/src/auction/auction.controller.ts', controller: AuctionController },
  { source: 'apps/api/src/cart/cart.controller.ts', controller: CartController },
  { source: 'apps/api/src/chat/chat.controller.ts', controller: ChatController },
  { source: 'apps/api/src/config/event-config.controller.ts', controller: EventConfigController },
  { source: 'apps/api/src/copilot/copilot.controller.ts', controller: CopilotController },
  { source: 'apps/api/src/events/event.controller.ts', controller: EventController },
  { source: 'apps/api/src/policies/policy.controller.ts', controller: PolicyController },
  { source: 'apps/api/src/rehearsals/rehearsal.controller.ts', controller: RehearsalController },
  { source: 'apps/api/src/run-of-show/run-of-show.controller.ts', controller: RunOfShowController },
  { source: 'apps/api/src/stats/stats.module.ts', controller: StatsController },
  { source: 'apps/api/src/sync/sync.controller.ts', controller: SyncController },
  { source: 'apps/api/src/transcription/transcription.controller.ts', controller: TranscriptionController },
];

function sourceFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(name)) output.push(absolute);
    }
  };
  visit(root);
  return output;
}

const repoPath = (path: string) => relative(REPO_ROOT, path).replaceAll('\\', '/');
const sorted = (values: readonly string[]) => [...values].sort();
const read = (path: string) => readFileSync(path, 'utf8');

function discoveredControllerSources(): string[] {
  const eventScoped = sourceFiles(API_ROOT)
    .filter((file) => {
      const source = read(file);
      return source.includes('@Controller')
        && (/\beventId\b/.test(source) || /@Controller\(\s*['"]events['"]\s*\)/.test(source));
    })
    .map(repoPath);
  // The Deepgram credential endpoint is seller-private but intentionally not
  // event-anchored, so pin it alongside the event-scoped discovery set.
  eventScoped.push('apps/api/src/transcription/transcription.controller.ts');
  return sorted([...new Set(eventScoped)]);
}

function paths(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : ''];
}

function routePath(...parts: string[]): string {
  const joined = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined ? `/${joined}` : '/';
}

function discoveredEndpoints(): string[] {
  const endpoints: string[] = [];
  for (const { controller } of EVENT_CONTROLLERS) {
    const controllerPaths = paths(Reflect.getMetadata(PATH_METADATA, controller));
    const prototype = controller.prototype as Record<string, unknown>;
    for (const property of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[property];
      if (typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const methodPaths = paths(Reflect.getMetadata(PATH_METADATA, handler));
      for (const controllerPath of controllerPaths) {
        for (const methodPath of methodPaths) {
          endpoints.push(`${RequestMethod[method]} ${routePath(controllerPath, methodPath)}`);
        }
      }
    }
  }
  return sorted(endpoints);
}

function discoveredEventSyncQueries(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles(API_ROOT).filter((path) => path.endsWith('.module.ts'))) {
    const pattern = /queries\.register\('((?:event|events|rehearsal)\.[^']+)'/g;
    for (const match of read(file).matchAll(pattern)) {
      if (match[1].startsWith('event.') || match[1].startsWith('events.') || match[1] === 'rehearsal.preflight') {
        names.add(match[1]);
      }
    }
  }
  return sorted([...names]);
}

describe('event access registry', () => {
  it('discovers every event-aware controller source, including embedded controllers', () => {
    expect(sorted(EVENT_CONTROLLERS.map(({ source }) => source))).toEqual(discoveredControllerSources());
  });

  it('requires every discovered endpoint to have an explicit access policy', () => {
    expect(sorted(Object.keys(EVENT_ACCESS.endpoints))).toEqual(discoveredEndpoints());
  });

  it('requires every event-scoped named query to have an explicit access policy', () => {
    expect(sorted(Object.keys(EVENT_ACCESS.syncQueries))).toEqual(discoveredEventSyncQueries());
  });
});
