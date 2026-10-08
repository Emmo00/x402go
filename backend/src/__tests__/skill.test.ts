import express from 'express';
import request from 'supertest';
import { describe, expect, test } from 'bun:test';

import SkillRoute from '../routes/skill.route';

/**
 * `GET /skill.md`.
 *
 * Mounted on a bare Express app rather than through `App`, because this route
 * touches no database, no session and no chain — booting a Mongo instance to
 * assert a static string would be slower and would prove nothing extra. The
 * app-level wiring is one line in `server.ts`.
 */

const app = express();
app.use(new SkillRoute().path, new SkillRoute().router);

/** The guide, fetched once. Every assertion below reads this one response. */
const response = await request(app).get('/skill.md');
const body = response.text;

describe('GET /skill.md', () => {
  test('serves the guide as Markdown', () => {
    expect(response.status).toBe(200);

    // The media type is the contract, not a nicety: a client that renders this
    // as HTML, or downloads it as application/octet-stream, has been handed the
    // wrong thing. `charset=utf-8` is asserted separately because the guide
    // contains non-ASCII punctuation and a guessed latin-1 would mangle it.
    expect(response.headers['content-type']).toContain('text/markdown');
    expect(response.headers['content-type']).toContain('utf-8');
  });

  test('serves Markdown, not the styled documentation page', () => {
    expect(body).not.toContain('<!doctype html');
    expect(body).not.toContain('<html');
    // A fenced block is the shape an agent parses; HTML tags are not.
    expect(body).toContain('```');
  });

  test('carries a front-matter header an agent can read', () => {
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain('name: x402go');
  });

  test('documents every endpoint the API actually serves', () => {
    for (const path of ['/supported', '/verify', '/settle']) {
      expect(body).toContain(path);
    }

    // The base URL, so a reader is never guessing where the paths hang off.
    expect(body).toContain('http://localhost:8000');
  });

  test('covers the concepts the integration turns on', () => {
    const required = [
      'What x402Go is',
      'Facts you must not get wrong',
      'Base URL',
      'Authentication',
      'Supported networks and assets',
      'GET /supported',
      'POST /verify',
      'POST /settle',
      'Fee model',
      'payTo and deterministic vaults',
      'Payout and withdrawal',
      'Error responses',
      'Common mistakes',
    ];

    for (const heading of required) {
      expect(body).toContain(`## ${heading}`);
    }
  });

  test('states the fee rule exactly as the backend enforces it', () => {
    // $0.001 + $0.001, and a strict comparison. A guide that said "at least"
    // would have integrators pricing at exactly 2000 and collecting 402s.
    expect(body).toContain('$0.001');
    expect(body).toContain('$0.002');
    expect(body).toContain('1000 + 1000 = 2000');
    expect(body).toContain('grossAmount = merchantAmount + x402GoFee + facilitatorFee');
  });

  test('names the networks and the assets that actually settle', () => {
    expect(body).toContain('eip155:42220');
    expect(body).toContain('eip155:11142220');
    expect(body).toContain('0xcebA9300f2b948710d2653dD7B07f33A8B32118C'); // USDC, mainnet
    expect(body).toContain('0x01C5C0122039549AD1493B8220cABEdD739BC44E'); // USDC, Sepolia
  });

  test('warns about the assets that cannot be priced yet', () => {
    // These are enabled upstream but have no fee schedule, so they are refused
    // with a 500. A guide that listed them as usable would send integrators into
    // a failure they cannot diagnose.
    expect(body).toContain('wARS');
    expect(body).toContain('fee-schedule-unavailable');
  });

  test('tells the reader never to send their key to Celo', () => {
    expect(body).toContain('api.x402.celo.org');
    expect(body).toMatch(/[Nn]ever send your x402Go API key/);
  });

  test('carries no credential', () => {
    // The guide is public. It documents the *shape* of both credentials and the
    // value of neither.
    expect(body).not.toContain('CELO_FACILITATOR_API_KEY=');
    expect(body).not.toMatch(/x402go_[A-Za-z0-9]{20,}/);
  });

  test('is served identically on a second request', async () => {
    const again = await request(app).get('/skill.md');

    expect(again.text).toBe(body);
  });

  test('answers only GET', async () => {
    // It is a document, not a resource: a POST to it is a client confused about
    // which endpoint it wanted, and a 404 says so sooner than a 200 would.
    const posted = await request(app).post('/skill.md');

    expect(posted.status).toBe(404);
  });
});
