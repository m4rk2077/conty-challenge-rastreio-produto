import { createHash } from 'node:crypto';
import {
  ApiError,
  type Clock,
  type ProviderEvent,
  type TrackingEvent,
  type TrackingProvider,
  type TrackingRepository,
  type TrackingView,
} from './domain.js';

const precedence = { unknown: 0, posted: 1, in_transit: 2, out_for_delivery: 3, exception: 4, delivered: 5 };

export function compareEvents(a: TrackingEvent, b: TrackingEvent): number {
  return Date.parse(a.occurred_at) - Date.parse(b.occurred_at)
    || precedence[a.normalized_status] - precedence[b.normalized_status]
    || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0);
}

function identity(code: string, event: ProviderEvent): string {
  if (event.event_id !== null) return `id:${event.event_id}`;
  const canonical = JSON.stringify([code, event.raw_status, event.occurred_at, event.location]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export class TrackingService {
  constructor(
    private readonly repository: TrackingRepository,
    private readonly provider: TrackingProvider,
    private readonly clock: Clock,
    private readonly defaultLimitHours = 120,
  ) {
    this.validateLimit(defaultLimitHours);
  }

  async register(code: string, limitHours = this.defaultLimitHours): Promise<{ created: boolean; tracking: TrackingView }> {
    this.validateCode(code);
    this.validateLimit(limitHours);
    if (this.repository.getTracking(code)) return { created: false, tracking: this.get(code) };
    // Do not advertise a local registration when the HTTP provider failed.
    // Retrying after a crash is safe because the provider's registration is idempotent.
    await this.provider.register(code);
    const created = this.repository.insertTracking({
      tracking_code: code,
      transit_limit_hours: limitHours,
      registered_at: this.clock.now().toISOString(),
    });
    return { created, tracking: this.get(code) };
  }

  async sync(code: string): Promise<TrackingView & { new_events: number }> {
    this.requireTracking(code);
    const events = await this.provider.consult(code);
    const receivedAt = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      const newEvents = this.repository.insertEvents(code, events.map((event) => ({
        ...event, identity: identity(code, event), received_at: receivedAt,
      })));
      return { ...this.evaluate(code), new_events: newEvents };
    });
  }

  get(code: string): TrackingView {
    this.requireTracking(code);
    return this.repository.transaction(() => this.evaluate(code));
  }

  private evaluate(code: string): TrackingView {
    const tracking = this.requireTracking(code);
    const history = this.repository.listEvents(code).sort(compareEvents);
    const recognized = history.filter((event) => event.normalized_status !== 'unknown');
    // Delivery is terminal. Use the earliest confirmation to freeze transit time.
    const delivery = recognized.find((event) => event.normalized_status === 'delivered');
    const current = delivery ?? recognized.at(-1);
    const start = recognized.find((event) => event.normalized_status === 'posted' || event.normalized_status === 'in_transit');
    const now = this.clock.now();
    const elapsed = start
      ? Math.max(0, (delivery ? Date.parse(delivery.occurred_at) : now.getTime()) - Date.parse(start.occurred_at))
      : null;
    const limitMs = tracking.transit_limit_hours * 3_600_000;
    const delayed = elapsed !== null && elapsed > limitMs;
    if (delayed && start) {
      this.repository.insertAlert({
        tracking_code: code,
        detected_at: now.toISOString(),
        transit_started_at: start.occurred_at,
        delivered_at: delivery?.occurred_at ?? null,
        elapsed_ms: elapsed,
        limit_ms: limitMs,
        basis: delivery ? 'delivered' : 'open',
        delivery_assessment: null,
      });
    }
    const alert = this.repository.getAlert(code);
    if (alert && delivery && elapsed !== null) {
      const outcome = delayed ? 'confirmed_late' : 'invalidated_on_time';
      const assessment = alert.delivery_assessment;
      if (!assessment || assessment.outcome !== outcome || assessment.elapsed_ms !== elapsed
        || assessment.delivered_at !== delivery.occurred_at) {
        this.repository.updateAlertAssessment(code, {
          outcome, assessed_at: now.toISOString(), delivered_at: delivery.occurred_at, elapsed_ms: elapsed,
        });
      }
    }
    return {
      ...tracking,
      tracking_state: delivery ? 'completed' : current ? 'active' : 'pending',
      current_status: current && current.normalized_status !== 'unknown' ? current.normalized_status : null,
      transit_started_at: start?.occurred_at ?? null,
      delivered_at: delivery?.occurred_at ?? null,
      elapsed_transit_ms: elapsed,
      currently_delayed: !delivery && delayed,
      late_delivery: Boolean(delivery) && delayed,
      alert: this.repository.getAlert(code),
      history,
    };
  }

  private requireTracking(code: string) {
    this.validateCode(code);
    const tracking = this.repository.getTracking(code);
    if (!tracking) throw new ApiError(404, 'tracking_not_found', 'Código de rastreio não cadastrado.');
    return tracking;
  }

  private validateCode(code: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(code)) {
      throw new ApiError(400, 'invalid_tracking_code', 'Use um código de 1 a 80 caracteres: letras, números, hífen ou sublinhado.');
    }
  }

  private validateLimit(limit: number): void {
    if (!Number.isFinite(limit) || limit <= 0 || limit * 3_600_000 < 1 || limit * 3_600_000 > Number.MAX_SAFE_INTEGER) {
      throw new ApiError(400, 'invalid_transit_limit', 'transit_limit_hours deve ser um número positivo finito.');
    }
  }
}
