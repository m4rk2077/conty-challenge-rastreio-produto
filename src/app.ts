import { Hono } from 'hono';
import { ApiError } from './domain.js';
import type { TrackingService } from './tracking-service.js';

export function createApp(service: TrackingService) {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.post('/trackings', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { throw new ApiError(400, 'invalid_json', 'Envie um objeto JSON válido.'); }
    if (typeof body !== 'object' || body === null || Array.isArray(body)
      || !('tracking_code' in body) || typeof body.tracking_code !== 'string'
      || ('transit_limit_hours' in body && typeof body.transit_limit_hours !== 'number')) {
      throw new ApiError(400, 'invalid_body', 'Informe tracking_code e, opcionalmente, transit_limit_hours numérico.');
    }
    const result = await service.register(body.tracking_code, 'transit_limit_hours' in body ? body.transit_limit_hours as number : undefined);
    return c.json(result.tracking, result.created ? 201 : 200);
  });
  app.post('/trackings/:code/sync', async (c) => c.json(await service.sync(c.req.param('code'))));
  app.get('/trackings/:code', (c) => c.json(service.get(c.req.param('code'))));
  app.notFound((c) => c.json({ error: { code: 'route_not_found', message: 'Rota não encontrada.' } }, 404));
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    console.error(error);
    return c.json({ error: { code: 'internal_error', message: 'Erro interno ao processar rastreio.' } }, 500);
  });
  return app;
}
