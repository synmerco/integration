/**
 * @synmerco/sdk - Commerce namespace tests
 *
 * Verifies the SynmercoCommerce class produces correct HTTP requests
 * and parses responses. Uses a mocked global fetch — no network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SynmercoCommerce, type ChainName } from './index.js';

const BASE_URL = 'https://test.synmerco.com';
const API_KEY = 'sk_test_123';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

let calls: FetchCall[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    const method = init?.method ?? 'GET';
    const headers = init?.headers as Record<string, string> ?? {};
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: u, method, headers, body });

    // Return a response shape based on the path
    if (u.endsWith('/v1/commerce/info')) {
      return new Response(JSON.stringify({
        protocol: 'ERC-8183',
        contract: 'SynmercoCommerce',
        version: 'v1.1.0',
        feeBps: 325,
        chains: [],
        docs: '',
      }), { status: 200 });
    }
    if (u.includes('/encode/fund')) {
      return new Response(JSON.stringify({
        approve: { to: '0xtoken', data: '0xaa', value: '0x0', chainId: 8453, description: 'a' },
        fund:    { to: '0xproxy', data: '0xbb', value: '0x0', chainId: 8453, description: 'b' },
      }), { status: 200 });
    }
    if (u.includes('/encode/')) {
      return new Response(JSON.stringify({
        to: '0xproxy', data: '0xdeadbeef', value: '0x0', chainId: 8453, description: 'mock',
      }), { status: 200 });
    }
    if (/jobs\/\w+\/\d+$/.test(u)) {
      return new Response(JSON.stringify({
        jobId: '1', client: '0x1', provider: '0x2', evaluator: '0x3',
        paymentToken: '0x4', budget: '1000000', expiredAt: '1735689600',
        status: 0, statusName: 'Open', deliverableHash: '0x' + '0'.repeat(64),
        hook: '0x' + '0'.repeat(40), clientDid: '', providerDid: '',
      }), { status: 200 });
    }
    // server-signed: complete/reject/refund
    return new Response(JSON.stringify({
      txHash: '0x' + 'a'.repeat(64), chainId: 8453,
    }), { status: 200 });
  }) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SynmercoCommerce SDK - configuration', () => {
  it('constructs without error', () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    expect(sdk).toBeDefined();
  });

  it('attaches Authorization header when apiKey is set', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL, apiKey: API_KEY });
    await sdk.info();
    expect(calls[0].headers['Authorization']).toBe(`Bearer ${API_KEY}`);
  });

  it('does not attach Authorization when apiKey is missing', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await sdk.info();
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });
});

describe('SynmercoCommerce SDK - reads', () => {
  it('info() hits GET /v1/commerce/info', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    const info = await sdk.info();
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/info`);
    expect(calls[0].method).toBe('GET');
    expect(info.protocol).toBe('ERC-8183');
  });

  it('getJob() hits GET /v1/commerce/jobs/:chain/:jobId', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    const job = await sdk.getJob('base', 42);
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/42`);
    expect(calls[0].method).toBe('GET');
    expect(job.jobId).toBe('1');
  });
});

describe('SynmercoCommerce SDK - encoders', () => {
  it('encodeCreateJob serializes expiredAt as string', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await sdk.encodeCreateJob('base', {
      provider: '0x1' as `0x${string}`,
      evaluator: '0x2' as `0x${string}`,
      expiredAt: 1735689600n,
      description: 'd',
    });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/encode/createJob`);
    expect(calls[0].body.expiredAt).toBe('1735689600');
    expect(typeof calls[0].body.expiredAt).toBe('string');
  });

  it('encodeSetBudget serializes amount as string', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await sdk.encodeSetBudget('base', 7, {
      token: '0xusdc' as `0x${string}`,
      amount: 1000000n,
    });
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/7/encode/setBudget`);
    expect(calls[0].body.amount).toBe('1000000');
  });

  it('encodeFund returns approve + fund tuple', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    const result = await sdk.encodeFund('base', 1, {
      token: '0xusdc' as `0x${string}`,
      expectedBudget: 5000000n,
    });
    expect(result.approve).toBeDefined();
    expect(result.fund).toBeDefined();
    expect(calls[0].body.expectedBudget).toBe('5000000');
  });

  it('encodeSubmit accepts string jobId', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await sdk.encodeSubmit('base', '999', {
      deliverableHash: ('0x' + 'f'.repeat(64)) as `0x${string}`,
    });
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/999/encode/submit`);
  });
});

describe('SynmercoCommerce SDK - server-signed', () => {
  it('complete() POSTs to /complete with reason+optParams', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL, apiKey: API_KEY });
    const r = await sdk.complete('base', 1, { reason: ('0x' + '0'.repeat(64)) as `0x${string}` });
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/1/complete`);
    expect(calls[0].method).toBe('POST');
    expect(r.txHash.startsWith('0x')).toBe(true);
  });

  it('reject() POSTs to /reject', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL, apiKey: API_KEY });
    await sdk.reject('base', 1);
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/1/reject`);
  });

  it('claimRefund() POSTs to /refund with no body required', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL, apiKey: API_KEY });
    await sdk.claimRefund('base', 1);
    expect(calls[0].url).toBe(`${BASE_URL}/v1/commerce/jobs/base/1/refund`);
  });
});

describe('SynmercoCommerce SDK - errors', () => {
  it('throws on non-2xx HTTP response', async () => {
    globalThis.fetch = vi.fn(async () => new Response('Not Found', { status: 404 })) as any;
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await expect(sdk.info()).rejects.toThrow(/404/);
  });

  it('error message includes response body for debugging', async () => {
    globalThis.fetch = vi.fn(async () => new Response('detailed error info', { status: 500 })) as any;
    const sdk = new SynmercoCommerce({ baseUrl: BASE_URL });
    await expect(sdk.info()).rejects.toThrow(/detailed error info/);
  });
});

describe('SynmercoCommerce SDK - URL construction', () => {
  it('strips trailing slash from baseUrl', async () => {
    const sdk = new SynmercoCommerce({ baseUrl: 'https://test.synmerco.com/' });
    await sdk.info();
    expect(calls[0].url).toBe('https://test.synmerco.com/v1/commerce/info');
  });

  it('handles all 5 chain names', () => {
    const chains: ChainName[] = ['base', 'arbitrum', 'optimism', 'polygon', 'baseSepolia'];
    expect(chains.length).toBe(5);
  });
});

