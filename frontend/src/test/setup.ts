import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { tokens } from '@/lib/api-client';

// jsdom's AbortSignal is not accepted by Node's Request, which react-router builds for navigations. Test-only shim.
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    if (init?.signal) { const { signal: _signal, ...rest } = init; super(input, rest); } else super(input, init);
  }
} as typeof Request;

// A busy machine (or many test files at once) can make the first render slow; waiting longer costs nothing when things are fast.
configure({ asyncUtilTimeout: 4000 });

afterEach(() => { cleanup(); tokens.set(null); localStorage.clear(); });
