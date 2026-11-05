import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';

const base = { DATABASE_URL: 'file:./x.db', JWT_ACCESS_SECRET: 'k3J9xQ2mVb7LpR4tYw8NzC1dHs6GfA0eUi5oPq3W' };

describe('environment checks', () => {
  it('accepts a normal production setup', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://office.example.com', TRUST_PROXY: '1' }).TRUST_PROXY).toBe(1);
  });

  it('refuses to start in production with the example secret or open CORS', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', JWT_ACCESS_SECRET: 'change-me-to-a-random-string-of-at-least-32-characters' })).toThrow(/example value/);
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://a.example.com, *' })).toThrow(/not \*/);
  });

  it('is relaxed outside production, and defaults to no proxy and the built-in scanner', () => {
    const dev = loadEnv({ ...base, NODE_ENV: 'development', JWT_ACCESS_SECRET: 'change-me-to-a-random-string-of-at-least-32-characters' });
    expect(dev.TRUST_PROXY).toBe(0);
    expect(dev.MALWARE_SCAN).toBe('builtin');
  });
});
