import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { TrackingView } from '../src/domain.js';
import { HttpTrackingProvider } from '../src/http-tracking-provider.js';
import { SqliteTrackingRepository } from '../src/sqlite-repository.js';
import { createSimulator, type RawShipmentEvent } from '../src/simulator.js';
import { TrackingService } from '../src/tracking-service.js';
import { startHttp, TestClock } from './helpers.js';

describe('API → HTTP adapter → HTTP simulator → SQLite', () => {
  let simulator: ReturnType<typeof createSimulator>;
  let upstream: Awaited<ReturnType<typeof startHttp>>;
  let api: Awaited<ReturnType<typeof startHttp>>;
  let repository: SqliteTrackingRepository;
  let clock: TestClock;

  beforeEach(async () => {
    simulator = createSimulator();
    upstream = await startHttp(simulator.app);
    repository = new SqliteTrackingRepository(':memory:');
    clock = new TestClock('2026-10-11T00:00:00.000Z');
    api = await startHttp(createApp(new TrackingService(repository, new HttpTrackingProvider(upstream.url, 150), clock)));
  });
  afterEach(async () => {
    await api.close();
    await upstream.close();
    repository.close();
  });

  async function register(code = 'BR123', hours = 120) {
    return fetch(`${api.url}/trackings`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tracking_code: code, transit_limit_hours: hours }) });
  }
  async function sync(code = 'BR123') {
    return fetch(`${api.url}/trackings/${code}/sync`, { method: 'POST' });
  }
  const raw = (status: string, id: string | undefined = status): RawShipmentEvent => ({
    ...(id === undefined ? {} : { event_id: id }), status, timestamp: '2026-10-01T12:00:00Z',
  });

  it('runs real TCP registration/consultation and checks the documented raw → normalized example', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../examples/raw-payload.json', import.meta.url), 'utf8')) as { code: string; events: RawShipmentEvent[] };
    const normalized = JSON.parse(readFileSync(new URL('../examples/normalized-payload.json', import.meta.url), 'utf8')) as unknown;
    simulator.scenarios.set(fixture.code, { events: fixture.events });
    expect((await register()).status).toBe(201);
    expect((await register()).status).toBe(200);
    const response = await sync();
    expect(response.status).toBe(200);
    const view = await response.json() as TrackingView & { new_events: number };
    expect(view.new_events).toBe(4);
    expect({
      tracking_code: view.tracking_code, current_status: view.current_status, tracking_state: view.tracking_state,
      transit_started_at: view.transit_started_at, delivered_at: view.delivered_at, elapsed_transit_ms: view.elapsed_transit_ms,
      currently_delayed: view.currently_delayed, late_delivery: view.late_delivery, alert: view.alert,
      history: view.history.map(({ event_id, raw_status, normalized_status, occurred_at, location }) => ({
        event_id, raw_status, normalized_status, occurred_at, location,
      })),
    }).toEqual(normalized);
    expect(view.history.every((e) => e.received_at === clock.instant)).toBe(true);
    const repeat = await sync();
    expect(await repeat.json()).toMatchObject({ new_events: 0, current_status: 'delivered' });
    const get = await fetch(`${api.url}/trackings/BR123`);
    expect(get.status).toBe(200);
    expect(simulator.requests).toEqual([
      { method: 'POST', code: 'BR123' }, { method: 'GET', code: 'BR123' }, { method: 'GET', code: 'BR123' },
    ]);
  });

  it.each([
    ['POSTADO', 'posted'], ['EM_TRANSITO', 'in_transit'], ['SAIU_PARA_ENTREGA', 'out_for_delivery'],
    ['ENTREGUE', 'delivered'], ['EXCECAO', 'exception'],
  ])('translates external %s to %s', async (wire, normalized) => {
    simulator.scenarios.set('BR123', { events: [raw(wire)] });
    await register();
    const response = await sync();
    expect(await response.json()).toMatchObject({ current_status: normalized, history: [
      { raw_status: wire, normalized_status: normalized },
    ] });
  });

  it('keeps an invented external status pending and non-delivered', async () => {
    simulator.scenarios.set('BR123', { events: [raw('DELIVERY_ALMOST_SURE')] });
    await register();
    expect(await (await sync()).json()).toMatchObject({ current_status: null, tracking_state: 'pending',
      currently_delayed: false, late_delivery: false, alert: null, history: [{ normalized_status: 'unknown', raw_status: 'DELIVERY_ALMOST_SURE' }] });
  });

  it('canonicalizes timestamps and location for ID-less dedup while preserving raw status', async () => {
    const noId = { status: 'EM_TRANSITO', timestamp: '2026-10-01T09:00:00-03:00', location: ' São Paulo ' };
    simulator.scenarios.set('BR123', { events: [noId] });
    await register();
    const first = await (await sync()).json() as TrackingView & { new_events: number };
    simulator.scenarios.set('BR123', { events: [{ ...noId, timestamp: '2026-10-01T12:00:00.000Z', location: 'São Paulo' }] });
    clock.set('2026-10-12T00:00:00.000Z');
    const second = await (await sync()).json() as TrackingView & { new_events: number };
    expect(first.new_events).toBe(1);
    expect(second.new_events).toBe(0);
    expect(second.history).toEqual(first.history);
  });

  it('reports registration failure without a phantom local tracking and allows a clean retry', async () => {
    simulator.scenarios.set('BR123', { events: [], registerStatus: 503 });
    const failed = await register();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: 'provider_http_error' } });
    expect((await fetch(`${api.url}/trackings/BR123`)).status).toBe(404);
    simulator.scenarios.set('BR123', { events: [] });
    expect((await register()).status).toBe(201);
  });

  it('keeps saved history when consultation fails and ingests once after recovery', async () => {
    simulator.scenarios.set('BR123', { events: [raw('POSTADO')] });
    await register();
    await sync();
    simulator.scenarios.set('BR123', { events: [raw('ENTREGUE')], consultStatus: 500 });
    expect((await sync()).status).toBe(502);
    const before = await (await fetch(`${api.url}/trackings/BR123`)).json() as TrackingView;
    expect(before.current_status).toBe('posted');
    expect(before.history).toHaveLength(1);
    simulator.scenarios.set('BR123', { events: [raw('ENTREGUE')] });
    expect(await (await sync()).json()).toMatchObject({ new_events: 1, current_status: 'delivered' });
  });

  it.each([
    { code: 'OTHER', events: [] },
    { code: 'BR123', events: 'not-an-array' },
    { code: 'BR123', events: [{ status: 'POSTADO', timestamp: '2026-02-30T00:00:00Z' }] },
    { code: 'BR123', events: [{ status: 'POSTADO', timestamp: '2026-10-01T00:00:00' }] },
    { code: 'BR123', events: [{ status: 'POSTADO', timestamp: '2026-10-01T24:00:00Z' }] },
    { code: 'BR123', events: [{ status: 'POSTADO', timestamp: '2026-10-01T00:00:00Z', event_id: 42 }] },
    { code: 'BR123', events: [{ status: 'POSTADO', timestamp: '2026-10-01T00:00:00Z', location: {} }] },
    { code: 'BR123', events: [{ status: '  ', timestamp: '2026-10-01T00:00:00Z' }] },
    { code: 'BR123', events: [null] },
  ])('rejects malformed upstream atomically: %j', async (payload) => {
    simulator.scenarios.set('BR123', { events: [], payload });
    await register();
    const response = await sync();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_provider_payload' } });
    expect(repository.listEvents('BR123')).toHaveLength(0);
  });

  it('does not persist the valid prefix of a malformed batch', async () => {
    simulator.scenarios.set('BR123', { events: [], payload: { code: 'BR123', events: [raw('POSTADO'), { status: 'bad' }] } });
    await register();
    expect((await sync()).status).toBe(502);
    expect(repository.listEvents('BR123')).toHaveLength(0);
  });

  it('returns 504 on actual HTTP timeout and 502 on connection failure', async () => {
    await register();
    simulator.scenarios.set('BR123', { events: [raw('ENTREGUE')], delayMs: 350 });
    const timedOut = await sync();
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({ error: { code: 'provider_timeout' } });
    expect(repository.listEvents('BR123')).toHaveLength(0);
    const dead = await startHttp(new Hono());
    await dead.close();
    const provider = new HttpTrackingProvider(dead.url);
    await expect(provider.consult('BR123')).rejects.toMatchObject({ status: 502, code: 'provider_unavailable' });
  });

  it.each([
    null, [], {}, { tracking_code: 42 }, { tracking_code: '../x' }, { tracking_code: 'A', transit_limit_hours: '24' },
    { tracking_code: 'A', transit_limit_hours: -1 }, { tracking_code: 'A', transit_limit_hours: 0 },
  ])('returns 400 for invalid registration body %j before calling upstream', async (body) => {
    const response = await fetch(`${api.url}/trackings`, { method: 'POST', body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(simulator.requests).toHaveLength(0);
  });

  it('returns JSON errors for malformed JSON and missing tracking, and health works', async () => {
    expect((await fetch(`${api.url}/health`)).status).toBe(200);
    expect((await fetch(`${api.url}/trackings`, { method: 'POST', body: '{bad' })).status).toBe(400);
    expect((await fetch(`${api.url}/trackings/MISSING`)).status).toBe(404);
    expect((await sync('MISSING')).status).toBe(404);
    expect(simulator.requests).toHaveLength(0);
  });
});

describe('upstream malformed JSON and registration response validation', () => {
  it('rejects non-JSON consultation responses', async () => {
    const app = new Hono().get('/shipments/BR123', (c) => c.text('not-json'));
    const upstream = await startHttp(app);
    try {
      await expect(new HttpTrackingProvider(upstream.url).consult('BR123')).rejects.toMatchObject({ code: 'invalid_provider_payload' });
    } finally { await upstream.close(); }
  });

  it('rejects a successful HTTP registration with wrong confirmation', async () => {
    const app = new Hono().post('/shipments', (c) => c.json({ code: 'OTHER', registered: true }));
    const upstream = await startHttp(app);
    try {
      await expect(new HttpTrackingProvider(upstream.url).register('BR123')).rejects.toMatchObject({ code: 'invalid_provider_payload' });
    } finally { await upstream.close(); }
  });
});
