import { describe, it, expect, afterEach } from 'vitest';
import { openDb, type DbHandle } from '@bftp/db';
import { buildApp } from '../src/app.js';

describe('GET /api/version', () => {
  let handle: DbHandle;
  afterEach(() => handle.close());

  it('reports the package version and, in this git checkout, a commit hash', async () => {
    handle = openDb(':memory:');
    const app = buildApp({ handle });

    const res = await app.inject({ method: 'GET', url: '/api/version' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    // The test suite runs inside a real git checkout, so these should resolve;
    // a tarball/no-.git deploy would see null instead, which the route must
    // also tolerate (it never throws either way).
    expect(body.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(body.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await app.close();
  });
});
