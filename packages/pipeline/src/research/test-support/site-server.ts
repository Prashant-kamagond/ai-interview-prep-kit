import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** A local HTTP server for deterministic tests. Binds to loopback only. */

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Wait this long before responding. */
  delayMs?: number;
  /** Accept the request and never answer. */
  hang?: boolean;
  /** Send the headers and then drip the body forever, one byte at a time. */
  drip?: boolean;
}

export type RouteHandler =
  | RouteResponse
  | ((req: IncomingMessage, hitCount: number) => RouteResponse | Promise<RouteResponse>);

export interface LoggedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
}

export interface TestServer {
  host: '127.0.0.1';
  port: number;
  /** e.g. http://127.0.0.1:41234 */
  origin: string;
  requests: LoggedRequest[];
  /** `host:port` key to put in the loopback allow-list. */
  key: string;
  close(): Promise<void>;
}

export function html(body: string, extra: RouteResponse = {}): RouteResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
    ...extra,
  };
}

export function text(body: string, extra: RouteResponse = {}): RouteResponse {
  return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, body, ...extra };
}

export function redirect(location: string, status = 302): RouteResponse {
  return { status, headers: { location }, body: '' };
}

export async function startServer(routes: Record<string, RouteHandler>): Promise<TestServer> {
  const requests: LoggedRequest[] = [];
  const hits = new Map<string, number>();
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers });
    const count = (hits.get(path) ?? 0) + 1;
    hits.set(path, count);

    const handler = routes[path];
    void (async () => {
      const spec: RouteResponse = !handler
        ? { status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>Not found</h1>' }
        : typeof handler === 'function'
          ? await handler(req, count)
          : handler;

      if (spec.hang) return;
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));

      res.writeHead(spec.status ?? 200, spec.headers ?? { 'content-type': 'text/html' });
      if (spec.drip) {
        const timer = setInterval(() => res.write('x'), 20);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.end(spec.body ?? '');
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    origin: `http://127.0.0.1:${port}`,
    key: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
