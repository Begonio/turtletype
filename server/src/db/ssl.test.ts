import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSslOptions } from './ssl.js';

const relaxed = { rejectUnauthorized: false };

describe('resolveSslOptions', () => {
  it('does not ask for TLS on a private provider network', () => {
    // Railway's Postgres plugin hands out exactly this shape, and it has TLS
    // switched off — requesting it fails the connection outright.
    assert.equal(
      resolveSslOptions('postgres://postgres:pw@postgres.railway.internal:5432/railway'),
      undefined,
    );
    assert.equal(resolveSslOptions('postgres://u:p@myapp-db.flycast:5432/app'), undefined);
  });

  it('does not ask for TLS for a Compose service or a local database', () => {
    assert.equal(resolveSslOptions('postgres://turtletype:pw@db:5432/turtletype'), undefined);
    assert.equal(resolveSslOptions('postgres://postgres:postgres@localhost:5432/turtletype'), undefined);
    assert.equal(resolveSslOptions('postgres://postgres:postgres@127.0.0.1:5432/turtletype'), undefined);
  });

  it('uses relaxed TLS for managed Postgres over the public internet', () => {
    assert.deepEqual(
      resolveSslOptions('postgres://u:p@ep-cool-name.eu-central-1.aws.neon.tech/neondb'),
      relaxed,
    );
    assert.deepEqual(
      resolveSslOptions('postgres://u:p@dpg-abc123-a.frankfurt-postgres.render.com/turtletype'),
      relaxed,
    );
    assert.deepEqual(
      resolveSslOptions('postgres://postgres:pw@containers-us-west-1.railway.app:7777/railway'),
      relaxed,
    );
  });

  it('honours sslmode in the connection string', () => {
    assert.equal(
      resolveSslOptions('postgres://u:p@db.example.com:5432/app?sslmode=disable'),
      undefined,
    );
    assert.deepEqual(
      resolveSslOptions('postgres://postgres:pw@localhost:5432/app?sslmode=require'),
      relaxed,
    );
  });

  it('lets DATABASE_SSL override the guess in both directions', () => {
    assert.equal(
      resolveSslOptions('postgres://u:p@db.example.com:5432/app', 'false'),
      undefined,
    );
    assert.deepEqual(
      resolveSslOptions('postgres://u:p@postgres.railway.internal:5432/railway', 'true'),
      relaxed,
    );
    assert.deepEqual(resolveSslOptions('postgres://u:p@db.example.com/app', 'strict'), {
      rejectUnauthorized: true,
    });
  });

  it('does not mistake a password containing @ for the host', () => {
    // Reading from the FIRST @ would see "ss" here, decide it is a bare
    // service name, and drop TLS on a public internet connection.
    assert.deepEqual(resolveSslOptions('postgres://user:p@ss@db.example.com:5432/app'), relaxed);
    assert.deepEqual(
      resolveSslOptions('postgres://user:p%40ss@db.example.com:5432/app'),
      relaxed,
    );
    // ...and the same trap in reverse: a private host must stay TLS-free.
    assert.equal(resolveSslOptions('postgres://user:p@ss@postgres.railway.internal/db'), undefined);
  });

  it('handles IPv6 hosts and URLs without a port', () => {
    assert.equal(resolveSslOptions('postgres://u:p@[::1]:5432/app'), undefined);
    assert.deepEqual(resolveSslOptions('postgres://u:p@db.example.com/app'), relaxed);
  });
});
