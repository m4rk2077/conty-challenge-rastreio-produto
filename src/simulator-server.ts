import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { createSimulator, type RawShipmentEvent } from './simulator.js';

const fixture = JSON.parse(readFileSync(new URL('../examples/raw-payload.json', import.meta.url), 'utf8')) as { code: string; events: RawShipmentEvent[] };
const port = Number(process.env.SIMULATOR_PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SIMULATOR_PORT inválida.');
const simulator = createSimulator(new Map([[fixture.code, { events: fixture.events }]]));
const server = serve({ fetch: simulator.app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(`Agregador fictício: http://127.0.0.1:${port} (${fixture.code}; outros códigos retornam histórico vazio)`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close();
  if ('closeIdleConnections' in server) server.closeIdleConnections();
});
