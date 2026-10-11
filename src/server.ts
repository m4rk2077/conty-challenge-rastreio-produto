import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createApp } from './app.js';
import { systemClock } from './domain.js';
import { HttpTrackingProvider } from './http-tracking-provider.js';
import { SqliteTrackingRepository } from './sqlite-repository.js';
import { TrackingService } from './tracking-service.js';

const databasePath = process.env.DATABASE_PATH ?? './data/trackings.sqlite';
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT inválida.');
mkdirSync(dirname(databasePath), { recursive: true });
const repository = new SqliteTrackingRepository(databasePath);
const service = new TrackingService(
  repository,
  new HttpTrackingProvider(process.env.PROVIDER_URL ?? 'http://127.0.0.1:4000', Number(process.env.PROVIDER_TIMEOUT_MS ?? 3000)),
  systemClock,
  Number(process.env.TRANSIT_LIMIT_HOURS ?? 120),
);
const server = serve({ fetch: createApp(service).fetch, hostname: '127.0.0.1', port }, () => {
  console.log(`API: http://127.0.0.1:${port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { repository.close(); });
  if ('closeIdleConnections' in server) server.closeIdleConnections();
});
