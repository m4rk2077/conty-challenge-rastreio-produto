import { ApiError, type ProviderEvent, type TrackingProvider, type TrackingStatus } from './domain.js';

const dialect: Record<string, TrackingStatus> = {
  POSTADO: 'posted',
  EM_TRANSITO: 'in_transit',
  SAIU_PARA_ENTREGA: 'out_for_delivery',
  ENTREGUE: 'delivered',
  EXCECAO: 'exception',
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidPayload(): never {
  throw new ApiError(502, 'invalid_provider_payload', 'O agregador retornou um payload inválido. Nenhum evento foi aplicado.');
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string') return invalidPayload();
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return invalidPayload();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
    || Number(offsetHourText ?? 0) > 23 || Number(offsetMinuteText ?? 0) > 59) return invalidPayload();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return invalidPayload();
  return new Date(parsed).toISOString();
}

export class HttpTrackingProvider implements TrackingProvider {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 3000) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PROVIDER_URL deve usar HTTP ou HTTPS.');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Timeout do agregador deve ser positivo.');
  }

  async register(code: string): Promise<void> {
    const response = await this.request('/shipments', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
    });
    if (!object(response) || response.code !== code || response.registered !== true) invalidPayload();
  }

  async consult(code: string): Promise<ProviderEvent[]> {
    const response = await this.request(`/shipments/${encodeURIComponent(code)}`);
    if (!object(response) || response.code !== code || !Array.isArray(response.events)) invalidPayload();
    return response.events.map((event: unknown): ProviderEvent => {
      if (!object(event) || typeof event.status !== 'string' || !event.status.trim()
        || (event.event_id !== undefined && event.event_id !== null && (typeof event.event_id !== 'string' || !event.event_id.trim()))
        || (event.location !== undefined && event.location !== null && typeof event.location !== 'string')) return invalidPayload();
      return {
        event_id: typeof event.event_id === 'string' ? event.event_id : null,
        raw_status: event.status,
        normalized_status: dialect[event.status.trim().toUpperCase()] ?? 'unknown',
        occurred_at: timestamp(event.timestamp),
        location: typeof event.location === 'string' ? event.location.trim() : null,
      };
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new ApiError(502, 'provider_http_error', `O agregador respondeu HTTP ${response.status}. Tente sincronizar novamente.`);
      try { return await response.json() as unknown; }
      catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw error;
        return invalidPayload();
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new ApiError(504, 'provider_timeout', 'O agregador excedeu o tempo de resposta. Tente sincronizar novamente.');
      }
      throw new ApiError(502, 'provider_unavailable', 'Não foi possível conectar ao agregador. Tente sincronizar novamente.');
    }
  }
}
