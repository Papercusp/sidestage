import { describe, expect, it } from 'vitest';

describe('AppModule dependency graph', () => {
  it('evaluates without a temporal-dead-zone circular import', async () => {
    const { AppModule } = await import('./app.module');

    expect(AppModule).toBeDefined();
  }, 15_000);
});
