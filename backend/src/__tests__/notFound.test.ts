import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Application } from 'express';
import request from 'supertest';

let apiApp: Application;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DEMO_MODE = 'true';
  process.env.SESSION_SECRET = 'not-found-test-session-secret';
  const { default: App } = await import('../app');
  apiApp = new App([]).getServer();
});

afterAll(() => {
  delete process.env.DEMO_MODE;
});

describe('unmatched routes', () => {
  test('returns a JSON 404 for an unknown GET route', async () => {
    const response = await request(apiApp).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body).toEqual({
      message: 'Route not found',
      path: '/does-not-exist',
    });
  });

  test('returns a JSON 404 for an unknown POST route', async () => {
    const response = await request(apiApp).post('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
    expect(response.body.path).toBe('/does-not-exist');
  });
});
