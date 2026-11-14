import { describe, it, expect, vi } from 'vitest';
import { createSynmercoMcpServer, synmercoApiCall } from '../src/server';

describe('createSynmercoMcpServer', () => {
  it('creates server', () => {
    const server = createSynmercoMcpServer({ synmercoBaseUrl: 'http://test.local' });
    expect(server).toBeDefined();
  });

  it('registers all 52 tools', () => {
    const server = createSynmercoMcpServer();
    const tools = (server as any)._registeredTools;
    const names = Object.keys(tools).sort();
    const expected = [
      'award_intent','broadcast_intent','check_readiness','compare_agents','counter_offer','create_escrow','create_sealed_brief',
      'create_wallet','deposit_review_credits','deposit_wallet','estimate_fees','fund_escrow','get_crypto_health','get_dispute',
      'get_escrow','get_identity','get_inbox','get_intent','get_platform_info','get_pro_badge','get_recheck_job','get_referral_earnings',
      'get_review_credits','get_sealed_brief','get_starter_tasks','get_wallet_balance','list_bids_on_intent','list_intents',
      'list_roles','list_service','lookup_trust_score','my_bids','onboard_agent','post_job','predict_deal','quote_review_fee',
      'raise_dispute','register_agent','register_referral','release_escrow','report_site_issue','search_agents','send_message',
      'set_pro_badge','start_negotiation','start_work','submit_bid','submit_proof','submit_recheck','submit_sealed','submit_starter_task',
      'withdraw_bid',
    ];
    expect(names).toEqual(expected);
    expect(names).toHaveLength(52);
  });
});

describe('synmercoApiCall', () => {
  it('calls API and returns JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: () => Promise.resolve({ score: 0.85 }),
    }));
    const r = await synmercoApiCall('http://test.local', 'sk_test', 'GET', '/v1/reputation/did:key:a');
    expect(r).toEqual({ score: 0.85 });
    vi.unstubAllGlobals();
  });

  it('sends auth header', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fn);
    await synmercoApiCall('http://test.local', 'sk_secret', 'GET', '/health');
    expect(fn.mock.calls[0][1].headers['Authorization']).toBe('Bearer sk_secret');
    vi.unstubAllGlobals();
  });

  it('works without auth', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fn);
    await synmercoApiCall('http://test.local', undefined, 'GET', '/health');
    expect(fn.mock.calls[0][1].headers['Authorization']).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('throws on error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 404, text: () => Promise.resolve('not found'),
    }));
    await expect(synmercoApiCall('http://test.local', undefined, 'GET', '/v1/x')).rejects.toThrow('404');
    vi.unstubAllGlobals();
  });

  it('sends body for POST', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 1 }) });
    vi.stubGlobal('fetch', fn);
    await synmercoApiCall('http://test.local', undefined, 'POST', '/v1/disputes', { reason: 'test' });
    expect(JSON.parse(fn.mock.calls[0][1].body)).toEqual({ reason: 'test' });
    vi.unstubAllGlobals();
  });
});
