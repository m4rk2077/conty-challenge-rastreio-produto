import { serve } from '@hono/node-server';
import { once } from 'node:events';
import type { Hono } from 'hono';
import type { Clock, ProviderEvent, TrackingProvider, TrackingStatus } from '../src/domain.js';

export class TestClock implements Clock {
  constructor(public instant = '2026-10-01T00:00:00.000Z') {}
  now(): Date { return new Date(this.instant); }
  set(instant: string): void { this.instant = instant; }
}

export class MemoryProvider implements TrackingProvider {
  events: ProviderEvent[] = [];
  registrations: string[] = [];
  consultCount = 0;
  async register(code: string): Promise<void> { this.registrations.push(code); }
  async consult(): Promise<ProviderEvent[]> { this.consultCount++; return this.events; }
}

export function event(
  status: TrackingStatus | 'unknown',
  occurredAt = '2026-10-01T00:00:00.000Z',
  id: string | null = `${status}-${occurredAt}`,
): ProviderEvent {
  return { event_id: id, raw_status: `RAW_${status}`, normalized_status: status, occurred_at: occurredAt, location: null };
}

export async function startHttp(app: Hono) {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
    },
  };
}
