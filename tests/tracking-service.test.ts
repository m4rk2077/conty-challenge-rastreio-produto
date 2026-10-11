import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteTrackingRepository } from '../src/sqlite-repository.js';
import { TrackingService } from '../src/tracking-service.js';
import { event, MemoryProvider, TestClock } from './helpers.js';

describe('tracking domain with real SQLite and controlled clock', () => {
  let repository: SqliteTrackingRepository;
  let provider: MemoryProvider;
  let clock: TestClock;
  let service: TrackingService;

  beforeEach(() => {
    repository = new SqliteTrackingRepository(':memory:');
    provider = new MemoryProvider();
    clock = new TestClock();
    service = new TrackingService(repository, provider, clock, 24);
  });
  afterEach(() => repository.close());

  it('registers idempotently, preserves original limit, and reads without consulting provider', async () => {
    const first = await service.register('BR123', 48);
    const repeat = await service.register('BR123', 72);
    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.tracking).toEqual(first.tracking);
    expect(first.tracking).toMatchObject({ current_status: null, tracking_state: 'pending', transit_limit_hours: 48 });
    service.get('BR123');
    expect(provider.registrations).toEqual(['BR123']);
    expect(provider.consultCount).toBe(0);
  });

  it('deduplicates by stable ID and fingerprint independently from reception time', async () => {
    await service.register('BR123');
    const identified = event('posted');
    const noId = event('in_transit', '2026-10-01T01:00:00.000Z', null);
    provider.events = [identified, identified, noId, { ...noId }];
    clock.set('2026-10-01T02:00:00.000Z');
    const first = await service.sync('BR123');
    expect(first.new_events).toBe(2);
    clock.set('2026-10-01T03:00:00.000Z');
    const repeat = await service.sync('BR123');
    expect(repeat.new_events).toBe(0);
    expect(repeat.history).toEqual(first.history);
    expect(repeat.history.every((e) => e.received_at === '2026-10-01T02:00:00.000Z')).toBe(true);
  });

  it('scopes identity to each code and keeps the first payload when an ID is reused', async () => {
    await service.register('A');
    await service.register('B');
    provider.events = [event('posted', undefined, 'same')];
    await service.sync('A');
    await service.sync('B');
    provider.events = [event('delivered', '2026-10-02T00:00:00.000Z', 'same')];
    expect(await service.sync('A')).toMatchObject({ current_status: 'posted', new_events: 0 });
    expect(service.get('B').history).toHaveLength(1);
  });

  it('retains an old event received later without regressing state', async () => {
    await service.register('BR123');
    provider.events = [event('out_for_delivery', '2026-10-02T00:00:00.000Z')];
    clock.set('2026-10-02T01:00:00.000Z');
    await service.sync('BR123');
    provider.events = [event('posted')];
    clock.set('2026-10-03T00:00:00.000Z');
    const view = await service.sync('BR123');
    expect(view.current_status).toBe('out_for_delivery');
    expect(view.history.map((e) => [e.normalized_status, e.occurred_at, e.received_at])).toEqual([
      ['posted', '2026-10-01T00:00:00.000Z', '2026-10-03T00:00:00.000Z'],
      ['out_for_delivery', '2026-10-02T00:00:00.000Z', '2026-10-02T01:00:00.000Z'],
    ]);
    expect(view.transit_started_at).toBe('2026-10-01T00:00:00.000Z');
    expect(view.currently_delayed).toBe(true);
  });

  it('resolves ties identically for reversed arrival order, including exception and delivery', async () => {
    await service.register('A');
    await service.register('B');
    const events = [event('delivered'), event('posted'), event('exception'), event('in_transit'), event('out_for_delivery')];
    provider.events = events;
    const a = await service.sync('A');
    provider.events = events.toReversed();
    const b = await service.sync('B');
    expect(a.current_status).toBe('delivered');
    expect(b.current_status).toBe('delivered');
    expect(a.history).toEqual(b.history);
    expect(a.history.map((e) => e.normalized_status)).toEqual(['posted', 'in_transit', 'out_for_delivery', 'exception', 'delivered']);
  });

  it('uses lexicographic identity for same-time, same-status ties', async () => {
    await service.register('BR123');
    provider.events = [event('in_transit', undefined, 'z'), event('in_transit', undefined, 'a'), event('posted')];
    const first = await service.sync('BR123');
    provider.events = provider.events.toReversed();
    const second = await service.sync('BR123');
    expect(first.history.map((e) => e.identity)).toEqual([`id:posted-2026-10-01T00:00:00.000Z`, 'id:a', 'id:z']);
    expect(second.history).toEqual(first.history);
  });

  it('keeps delivery terminal even with newer transit/exception events and duplicate delivery confirmations', async () => {
    await service.register('BR123');
    provider.events = [event('posted'), event('delivered', '2026-10-01T12:00:00.000Z')];
    await service.sync('BR123');
    clock.set('2026-10-10T00:00:00.000Z');
    provider.events = [
      event('in_transit', '2026-10-03T00:00:00.000Z'), event('exception', '2026-10-04T00:00:00.000Z'),
      event('delivered', '2026-10-05T00:00:00.000Z'),
    ];
    expect(await service.sync('BR123')).toMatchObject({
      current_status: 'delivered', tracking_state: 'completed', delivered_at: '2026-10-01T12:00:00.000Z',
      elapsed_transit_ms: 12 * 3_600_000, currently_delayed: false, late_delivery: false, alert: null,
    });
  });

  it('allows recovery from exception when a newer recognized transit event arrives', async () => {
    await service.register('BR123');
    provider.events = [event('posted'), event('exception', '2026-10-01T01:00:00.000Z')];
    expect((await service.sync('BR123')).current_status).toBe('exception');
    provider.events = [event('in_transit', '2026-10-01T02:00:00.000Z')];
    expect((await service.sync('BR123')).current_status).toBe('in_transit');
  });

  it('unknown alone stays pending without transit clock, delivery or alert', async () => {
    await service.register('BR123');
    provider.events = [{ ...event('unknown'), raw_status: 'TRANSPORTADORA_INVENTOU' }];
    clock.set('2026-10-20T00:00:00.000Z');
    const view = await service.sync('BR123');
    expect(view).toMatchObject({ current_status: null, tracking_state: 'pending', transit_started_at: null,
      elapsed_transit_ms: null, currently_delayed: false, late_delivery: false, alert: null });
    expect(view.history[0]).toMatchObject({ normalized_status: 'unknown', raw_status: 'TRANSPORTADORA_INVENTOU' });
  });

  it('unknown preserves the last recognized state and its raw evidence', async () => {
    await service.register('BR123');
    provider.events = [event('in_transit'), event('unknown', '2026-10-02T00:00:00.000Z')];
    expect(await service.sync('BR123')).toMatchObject({ current_status: 'in_transit', tracking_state: 'active' });
    expect(service.get('BR123').history.at(-1)?.normalized_status).toBe('unknown');
  });

  it('starts transit at the earliest posted/in_transit occurrence and not first reception', async () => {
    await service.register('BR123');
    clock.set('2026-10-02T12:00:00.000Z');
    provider.events = [event('in_transit', '2026-10-02T00:00:00.000Z')];
    expect((await service.sync('BR123')).currently_delayed).toBe(false);
    provider.events = [event('posted')];
    expect(await service.sync('BR123')).toMatchObject({ transit_started_at: '2026-10-01T00:00:00.000Z', currently_delayed: true });
  });

  it('checks strict threshold on GET and retains one immutable alert across repeated sync/read', async () => {
    await service.register('BR123');
    provider.events = [event('posted')];
    await service.sync('BR123');
    clock.set('2026-10-02T00:00:00.000Z');
    expect(service.get('BR123')).toMatchObject({ currently_delayed: false, alert: null });
    clock.set('2026-10-02T00:00:00.001Z');
    const first = service.get('BR123');
    expect(first.currently_delayed).toBe(true);
    expect(first.alert).toMatchObject({ elapsed_ms: 86_400_001, limit_ms: 86_400_000, basis: 'open', detected_at: clock.instant });
    clock.set('2026-10-04T00:00:00.000Z');
    expect((await service.sync('BR123')).alert).toEqual(first.alert);
    expect(service.get('BR123').alert).toEqual(first.alert);
  });

  it.each([
    ['2026-10-01T12:00:00.000Z', false],
    ['2026-10-02T00:00:00.000Z', false],
    ['2026-10-02T00:00:00.001Z', true],
    ['2026-10-03T00:00:00.000Z', true],
  ] as const)('freezes first-sync delivery duration at %s (late=%s)', async (deliveredAt, late) => {
    await service.register('BR123');
    provider.events = [event('posted'), event('delivered', deliveredAt)];
    clock.set('2026-10-08T00:00:00.000Z');
    const view = await service.sync('BR123');
    expect(view.currently_delayed).toBe(false);
    expect(view.late_delivery).toBe(late);
    expect(view.elapsed_transit_ms).toBe(Date.parse(deliveredAt) - Date.parse('2026-10-01T00:00:00.000Z'));
    if (late) expect(view.alert).toMatchObject({ basis: 'delivered', delivered_at: deliveredAt });
    else expect(view.alert).toBeNull();
    clock.set('2026-10-13T00:00:00.000Z');
    expect(service.get('BR123')).toEqual(viewWithoutNewEvents(view));
  });

  it('clears current delay after delivery while retaining historical observation evidence', async () => {
    await service.register('BR123');
    provider.events = [event('posted')];
    clock.set('2026-10-03T00:00:00.000Z');
    const open = await service.sync('BR123');
    expect(open.currently_delayed).toBe(true);
    // A late-arriving event proves actual delivery was on time; keep the earlier observation audit.
    provider.events = [event('delivered', '2026-10-01T12:00:00.000Z')];
    const completed = await service.sync('BR123');
    expect(completed).toMatchObject({ currently_delayed: false, late_delivery: false, current_status: 'delivered' });
    expect(completed.alert).toMatchObject({ ...open.alert, delivery_assessment: {
      outcome: 'invalidated_on_time', assessed_at: clock.instant,
      delivered_at: '2026-10-01T12:00:00.000Z', elapsed_ms: 43_200_000,
    } });
    clock.set('2026-10-05T00:00:00.000Z');
    expect(service.get('BR123').alert).toEqual(completed.alert);
  });

  it('does not invent a start when only out_for_delivery/delivered exist', async () => {
    await service.register('BR123');
    provider.events = [event('out_for_delivery'), event('delivered', '2026-10-03T00:00:00.000Z')];
    expect(await service.sync('BR123')).toMatchObject({ current_status: 'delivered', elapsed_transit_ms: null, late_delivery: false, alert: null });
  });

  it('reassesses the same alert when an older start proves the delivery was late after all', async () => {
    await service.register('BR123');
    provider.events = [event('posted', '2026-10-02T00:00:00.000Z')];
    clock.set('2026-10-04T00:00:00.000Z');
    const initial = await service.sync('BR123');
    expect(initial.alert?.basis).toBe('open');
    provider.events = [event('delivered', '2026-10-02T12:00:00.000Z')];
    clock.set('2026-10-05T00:00:00.000Z');
    const onTime = await service.sync('BR123');
    expect(onTime.late_delivery).toBe(false);
    expect(onTime.alert?.delivery_assessment?.outcome).toBe('invalidated_on_time');
    provider.events = [event('posted', '2026-10-01T00:00:00.000Z')];
    clock.set('2026-10-06T00:00:00.000Z');
    const late = await service.sync('BR123');
    expect(late).toMatchObject({ current_status: 'delivered', currently_delayed: false, late_delivery: true,
      transit_started_at: '2026-10-01T00:00:00.000Z', elapsed_transit_ms: 129_600_000 });
    expect(late.alert).toMatchObject({ ...initial.alert, delivery_assessment: {
      outcome: 'confirmed_late', assessed_at: clock.instant, delivered_at: '2026-10-02T12:00:00.000Z', elapsed_ms: 129_600_000,
    } });
    clock.set('2026-10-07T00:00:00.000Z');
    expect((await service.sync('BR123')).alert).toEqual(late.alert);
  });

  it.each([0, -1, NaN, Infinity, Number.MAX_VALUE])('rejects invalid limit %s', async (limit) => {
    await expect(service.register('BR123', limit)).rejects.toMatchObject({ status: 400, code: 'invalid_transit_limit' });
    expect(provider.registrations).toHaveLength(0);
  });

  it('uses an explicitly configured per-tracking limit', async () => {
    await service.register('BR123', 0.5);
    provider.events = [event('in_transit')];
    clock.set('2026-10-01T00:30:00.000Z');
    expect((await service.sync('BR123')).currently_delayed).toBe(false);
    clock.set('2026-10-01T00:30:00.001Z');
    expect(service.get('BR123').currently_delayed).toBe(true);
  });

  it('returns not found without making provider requests', async () => {
    expect(() => service.get('MISSING')).toThrow('não cadastrado');
    await expect(service.sync('MISSING')).rejects.toMatchObject({ status: 404 });
    expect(provider.consultCount).toBe(0);
  });
});

function viewWithoutNewEvents<T extends { new_events: number }>(value: T): Omit<T, 'new_events'> {
  const { new_events: _, ...view } = value;
  return view;
}

describe('disk persistence', () => {
  it('persists delivery assessment across reopen and retains exactly one audit record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conty-07-assessment-'));
    const path = join(directory, 'tracking.sqlite');
    let repository = new SqliteTrackingRepository(path);
    const provider = new MemoryProvider();
    const clock = new TestClock('2026-10-03T00:00:00.000Z');
    try {
      let service = new TrackingService(repository, provider, clock);
      await service.register('BR123', 24);
      provider.events = [event('posted')];
      await service.sync('BR123');
      provider.events = [event('delivered', '2026-10-01T12:00:00.000Z')];
      clock.set('2026-10-04T00:00:00.000Z');
      const assessed = await service.sync('BR123');
      expect(assessed.alert?.delivery_assessment).toMatchObject({ outcome: 'invalidated_on_time',
        assessed_at: clock.instant, delivered_at: '2026-10-01T12:00:00.000Z', elapsed_ms: 43_200_000 });
      repository.close();
      repository = new SqliteTrackingRepository(path);
      service = new TrackingService(repository, provider, clock);
      clock.set('2026-10-10T00:00:00.000Z');
      expect(service.get('BR123').alert).toEqual(assessed.alert);
      expect((await service.sync('BR123')).alert).toEqual(assessed.alert);
      const readOnly = new DatabaseSync(path, { readOnly: true });
      try { expect(readOnly.prepare('SELECT COUNT(*) AS count FROM alerts').get()?.count).toBe(1); }
      finally { readOnly.close(); }
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reopens SQLite preserving limits, received_at, ID/fingerprint dedup and the unique alert', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'conty-07-'));
    const path = join(directory, 'tracking.sqlite');
    let repository = new SqliteTrackingRepository(path);
    const provider = new MemoryProvider();
    const clock = new TestClock('2026-10-03T00:00:00.000Z');
    try {
      let service = new TrackingService(repository, provider, clock);
      await service.register('BR123', 24);
      provider.events = [event('posted'), event('in_transit', '2026-10-01T12:00:00.000Z', null)];
      const first = await service.sync('BR123');
      repository.close();
      repository = new SqliteTrackingRepository(path);
      service = new TrackingService(repository, provider, clock);
      clock.set('2026-10-05T00:00:00.000Z');
      const repeat = await service.sync('BR123');
      expect(repeat.new_events).toBe(0);
      expect(repeat.history).toEqual(first.history);
      expect(repeat.alert).toEqual(first.alert);
      expect(repeat.transit_limit_hours).toBe(24);
      expect((await service.register('BR123')).created).toBe(false);
      expect(provider.registrations).toEqual(['BR123']);
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
