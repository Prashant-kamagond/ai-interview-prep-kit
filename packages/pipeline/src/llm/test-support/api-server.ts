import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** A local HTTP server that stands in for the provider's API in adapter tests. Loopback only. */

export interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ApiReply {
  status?: number;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings are sent as is. */
  body?: unknown;
  delayMs?: number;
  /** Accept the request and never answer. */
  hang?: boolean;
}

export interface ApiServer {
  baseUrl: string;
  calls: ApiCall[];
  close(): Promise<void>;
}

export async function startApiServer(
  handler: (call: ApiCall, callNumber: number) => ApiReply | Promise<ApiReply>,
): Promise<ApiServer> {
  const calls: ApiCall[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const call: ApiCall = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      calls.push(call);
      void (async () => {
        const reply = await handler(call, calls.length);
        if (reply.hang) return;
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, {
          'content-type': 'application/json; charset=UTF-8',
          ...reply.headers,
        });
        res.end(body);
      })();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
