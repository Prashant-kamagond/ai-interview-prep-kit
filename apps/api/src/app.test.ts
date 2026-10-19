import type { Db } from 'mongodb';
import request from 'supertest';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { testConfig } from './test/harness.js';

// /health must not touch the database, so a stub that only hands out empty collections is enough.
const stubDb = { collection: () => ({}) } as unknown as Db;

describe('GET /health', () => {
  it('reports ok without needing the database', async () => {
    const { app } = createApp({
      db: stubDb,
      config: testConfig(),
      logger: pino({ level: 'silent' }),
    });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
