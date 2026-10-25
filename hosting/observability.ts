export type LogSink = (event: Record<string, string | number>) => void;
export const writeLog: LogSink = (event) => console.log(JSON.stringify(event));
// Only fixed route segments are recorded; query strings, bodies, cookies and secrets are excluded.
export function safePath(path: string) {
  return /^\/api(?:\/(?:health|session|login|logout|spaces|availability|bookings|page|confirm|reschedule|tasks|trash|history|restore|status|meta|dashboard|projects|members|workspaces|invitations|accept|export|seatly|\d+))*$/.test(
    path,
  )
    ? path.replace(/\/\d+(?=\/|$)/g, '/:id')
    : '/api/unknown';
}
export async function observe(
  req: Request,
  handle: () => Promise<Response>,
  log: LogSink = writeLog,
) {
  const requestId = crypto.randomUUID(),
    start = performance.now();
  let response: Response;
  try {
    response = await handle();
  } catch {
    response = Response.json(
      { message: 'Сервис временно недоступен. Повторите запрос.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  response.headers.set('X-Request-Id', requestId);
  log({
    event: 'http_request',
    requestId,
    method: req.method,
    path: safePath(new URL(req.url).pathname),
    status: response.status,
    durationMs: Number((performance.now() - start).toFixed(2)),
    ...(response.status >= 500 ? { error: 'service_unavailable' } : {}),
  });
  return response;
}
