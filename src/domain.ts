export type TrackingStatus = 'posted' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception';

export interface Clock {
  now(): Date;
}

// The adapter resolves its dialect before crossing this boundary.
export interface ProviderEvent {
  event_id: string | null;
  raw_status: string;
  normalized_status: TrackingStatus | 'unknown';
  occurred_at: string;
  location: string | null;
}

export interface TrackingProvider {
  register(code: string): Promise<void>;
  consult(code: string): Promise<ProviderEvent[]>;
}

export interface Tracking {
  tracking_code: string;
  transit_limit_hours: number;
  registered_at: string;
}

export interface TrackingEvent extends ProviderEvent {
  identity: string;
  received_at: string;
}

export interface DelayAlert {
  tracking_code: string;
  detected_at: string;
  transit_started_at: string;
  delivered_at: string | null;
  elapsed_ms: number;
  limit_ms: number;
  basis: 'open' | 'delivered';
  delivery_assessment: {
    outcome: 'confirmed_late' | 'invalidated_on_time';
    assessed_at: string;
    delivered_at: string;
    elapsed_ms: number;
  } | null;
}

export interface TrackingView extends Tracking {
  tracking_state: 'pending' | 'active' | 'completed';
  current_status: TrackingStatus | null;
  transit_started_at: string | null;
  delivered_at: string | null;
  elapsed_transit_ms: number | null;
  currently_delayed: boolean;
  late_delivery: boolean;
  alert: DelayAlert | null;
  history: TrackingEvent[];
}

export interface TrackingRepository {
  getTracking(code: string): Tracking | null;
  insertTracking(tracking: Tracking): boolean;
  listEvents(code: string): TrackingEvent[];
  insertEvents(code: string, events: TrackingEvent[]): number;
  getAlert(code: string): DelayAlert | null;
  insertAlert(alert: DelayAlert): void;
  updateAlertAssessment(code: string, assessment: NonNullable<DelayAlert['delivery_assessment']>): void;
  transaction<T>(work: () => T): T;
}

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 404 | 502 | 504,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const systemClock: Clock = { now: () => new Date() };
