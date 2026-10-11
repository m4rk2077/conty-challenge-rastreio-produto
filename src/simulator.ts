import { Hono } from 'hono';

// Wire format belongs only to the adapter and this fictitious provider.
export interface RawShipmentEvent {
  event_id?: string | null;
  status: string;
  timestamp: string;
  location?: string | null;
}

export interface SimulatorScenario {
  events: RawShipmentEvent[];
  registerStatus?: number;
  consultStatus?: number;
  delayMs?: number;
  payload?: unknown;
}

export function createSimulator(scenarios = new Map<string, SimulatorScenario>()) {
  const app = new Hono();
  const registered = new Set<string>();
  const requests: Array<{ method: string; code: string }> = [];
  const delay = async (scenario: SimulatorScenario | undefined) => {
    if (scenario?.delayMs) await new Promise((resolve) => setTimeout(resolve, scenario.delayMs));
  };
  app.post('/shipments', async (c) => {
    const body = await c.req.json<{ code: string }>();
    if (typeof body.code !== 'string') return c.json({ error: 'code required' }, 400);
    requests.push({ method: 'POST', code: body.code });
    const scenario = scenarios.get(body.code);
    await delay(scenario);
    if (scenario?.registerStatus && scenario.registerStatus >= 400) return new Response('simulated failure', { status: scenario.registerStatus });
    const exists = registered.has(body.code);
    registered.add(body.code);
    return c.json({ code: body.code, registered: true }, exists ? 200 : 201);
  });
  app.get('/shipments/:code', async (c) => {
    const code = c.req.param('code');
    requests.push({ method: 'GET', code });
    if (!registered.has(code)) return c.json({ error: 'not registered' }, 404);
    const scenario = scenarios.get(code);
    await delay(scenario);
    if (scenario?.consultStatus && scenario.consultStatus >= 400) return new Response('simulated failure', { status: scenario.consultStatus });
    return c.json(scenario && 'payload' in scenario ? scenario.payload : { code, events: scenario?.events ?? [] });
  });
  return { app, requests, scenarios };
}
