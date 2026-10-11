import { DatabaseSync } from 'node:sqlite';
import type { DelayAlert, Tracking, TrackingEvent, TrackingRepository } from './domain.js';

export class SqliteTrackingRepository implements TrackingRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS trackings (
        tracking_code TEXT PRIMARY KEY,
        transit_limit_hours REAL NOT NULL CHECK (transit_limit_hours > 0),
        registered_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        tracking_code TEXT NOT NULL REFERENCES trackings(tracking_code),
        identity TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY (tracking_code, identity)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS alerts (
        tracking_code TEXT PRIMARY KEY REFERENCES trackings(tracking_code),
        alert_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  getTracking(code: string): Tracking | null {
    return this.db.prepare('SELECT * FROM trackings WHERE tracking_code = ?').get(code) as unknown as Tracking | undefined ?? null;
  }

  insertTracking(tracking: Tracking): boolean {
    return Number(this.db.prepare('INSERT INTO trackings VALUES (?, ?, ?) ON CONFLICT(tracking_code) DO NOTHING')
      .run(tracking.tracking_code, tracking.transit_limit_hours, tracking.registered_at).changes) === 1;
  }

  listEvents(code: string): TrackingEvent[] {
    return this.db.prepare('SELECT event_json FROM events WHERE tracking_code = ?').all(code)
      .map((row) => JSON.parse(row.event_json as string) as TrackingEvent);
  }

  insertEvents(code: string, events: TrackingEvent[]): number {
    const statement = this.db.prepare('INSERT INTO events VALUES (?, ?, ?) ON CONFLICT(tracking_code, identity) DO NOTHING');
    return events.reduce((count, event) => count + Number(statement.run(code, event.identity, JSON.stringify(event)).changes), 0);
  }

  getAlert(code: string): DelayAlert | null {
    const row = this.db.prepare('SELECT alert_json FROM alerts WHERE tracking_code = ?').get(code);
    return row ? JSON.parse(row.alert_json as string) as DelayAlert : null;
  }

  insertAlert(alert: DelayAlert): void {
    this.db.prepare('INSERT INTO alerts VALUES (?, ?) ON CONFLICT(tracking_code) DO NOTHING')
      .run(alert.tracking_code, JSON.stringify(alert));
  }

  updateAlertAssessment(code: string, assessment: NonNullable<DelayAlert['delivery_assessment']>): void {
    const alert = this.getAlert(code);
    if (!alert) return;
    this.db.prepare('UPDATE alerts SET alert_json = ? WHERE tracking_code = ?')
      .run(JSON.stringify({ ...alert, delivery_assessment: assessment }), code);
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
