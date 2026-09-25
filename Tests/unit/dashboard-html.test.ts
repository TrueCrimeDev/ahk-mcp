import { describe, expect, it } from '@jest/globals';
import express from 'express';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mountDashboard } from '../../src/dashboard.js';

describe('AHK MCP monitoring dashboard', () => {
  it('redirects the server root to the dashboard', async () => {
    const app = express();
    mountDashboard(app, new Map());

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        redirect: 'manual',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('/dashboard');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });

  it('serves browser JavaScript that parses successfully', async () => {
    const app = express();
    mountDashboard(app, new Map());

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const address = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/dashboard`);
      const html = await response.text();
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];

      expect(response.status).toBe(200);
      expect(scripts).toHaveLength(1);
      expect(() => new Function(scripts[0][1])).not.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
      });
    }
  });
});
