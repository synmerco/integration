import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SynmercoClient } from '../src/index';

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

let client: SynmercoClient;

beforeEach(() => {
  client = new SynmercoClient({ baseUrl: 'http://test.local', apiKey: 'sk_test' });
});

describe('SynmercoClient', () => {
  it('health', async () => {
    const fn = mockFetch(200, { status: 'ok' });
    vi.stubGlobal('fetch', fn);
    const r = await client.health();
    expect(r.status).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('createIdentity', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { did: 'did:key:a', publicKey: 'pk', createdAt: '2026-01-01' }));
    const r = await client.createIdentity('did:key:a', 'pk');
    expect(r.did).toBe('did:key:a');
    vi.unstubAllGlobals();
  });

  it('getReputation', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { did: 'did:key:a', score: 0.9, totalEvents: 5 }));
    const r = await client.getReputation('did:key:a');
    expect(r.score).toBe(0.9);
    vi.unstubAllGlobals();
  });

  it('raiseDispute', async () => {
    vi.stubGlobal('fetch', mockFetch(201, { disputeId: 'dsp_1', phase: 'evidence_submission', tier: 1 }));
    const r = await client.raiseDispute('esc_1', 'bad work');
    expect(r.disputeId).toBe('dsp_1');
    vi.unstubAllGlobals();
  });

  it('review fee: createEscrow, raiseDispute and quote send the consent fields', async () => {
    const fn = mockFetch(200, {});
    vi.stubGlobal('fetch', fn);
    const acceptFees = { tier: 'large', maxReviewFeeCents: 300, priceTableVersion: '2026-11-13' };
    await client.createEscrow({ buyerDid: 'did:key:b', sellerDid: 'did:key:s', amountCents: 2000, autoRelease: true, reviewTier: 'large', acceptFees });
    const b1 = JSON.parse(fn.mock.calls[0][1].body);
    expect(b1.reviewTier).toBe('large'); expect(b1.acceptFees).toEqual(acceptFees);
    await client.raiseDispute('esc_1', 'x'.repeat(25), { acceptDisputeFee: true });
    expect(JSON.parse(fn.mock.calls[1][1].body).acceptFees).toEqual({ disputeFeeCents: 500 });
    await client.raiseDispute('esc_1', 'x'.repeat(25));
    expect(JSON.parse(fn.mock.calls[2][1].body).acceptFees).toBeUndefined();
    await client.quoteReviewFee(2000, 'huge');
    expect(fn.mock.calls[3][0]).toBe('http://test.local/v1/fees/quote?budgetCents=2000&tier=huge');
    vi.unstubAllGlobals();
  });

  it('free start: starter tasks, roles, re-check, site report and Pro send the right calls', async () => {
    const fn = mockFetch(200, {});
    vi.stubGlobal('fetch', fn);
    await client.getStarterTasks(); expect(fn.mock.calls[0][0]).toBe('http://test.local/v1/starter');
    await client.submitStarterTask('proof-hash', 'abc');
    expect(fn.mock.calls[1][0]).toBe('http://test.local/v1/starter/proof-hash/submit'); expect(JSON.parse(fn.mock.calls[1][1].body)).toEqual({ answer: 'abc' });
    await client.listRoles(); expect(fn.mock.calls[2][0]).toBe('http://test.local/v1/roles');
    await client.submitRecheck('rc_1', 'fail', 'x'.repeat(30));
    expect(fn.mock.calls[3][0]).toBe('http://test.local/v1/roles/recheck/rc_1'); expect(JSON.parse(fn.mock.calls[3][1].body).verdict).toBe('fail');
    await client.reportSiteIssue('Broken link', 'y'.repeat(50));
    expect(JSON.parse(fn.mock.calls[4][1].body)).toEqual({ title: 'Broken link', detail: 'y'.repeat(50) });
    await client.setProBadge(true); expect(JSON.parse(fn.mock.calls[5][1].body)).toEqual({ on: true });
    await client.setProBadge(false, false); expect(JSON.parse(fn.mock.calls[6][1].body)).toEqual({ on: false, autoRenew: false });
    vi.unstubAllGlobals();
  });

  it('sends auth header', async () => {
    const fn = mockFetch(200, { status: 'ok' });
    vi.stubGlobal('fetch', fn);
    await client.health();
    const call = fn.mock.calls[0];
    expect(call[1].headers['Authorization']).toBe('Bearer sk_test');
    vi.unstubAllGlobals();
  });

  it('throws on error response', async () => {
    vi.stubGlobal('fetch', mockFetch(500, { error: 'boom' }));
    await expect(client.health()).rejects.toThrow('500');
    vi.unstubAllGlobals();
  });
});
