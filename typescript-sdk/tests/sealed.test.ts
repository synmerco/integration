import { describe, it, expect } from 'vitest';
import { generateRecipientKeyPair, sealForSynmerco, openSealed, encryptContentKeyForRecipient, decryptContentKeyAsRecipient } from '../src/index.js';
describe('confidential v2 SDK helpers', () => {
  it('a sealed file opens with the witness key, and the content hash is checked', async () => {
    const w = await generateRecipientKeyPair();
    const s = await sealForSynmerco('# Report\nok', w.publicKey);
    const payload = JSON.parse(s.fileText);
    expect(await openSealed(payload, s.witnessEnvelope, w.privateKey, s.contentHash)).toBe('# Report\nok');
    await expect(openSealed(payload, s.witnessEnvelope, w.privateKey, '0'.repeat(64))).rejects.toThrow(/content hash/);
    const other = await generateRecipientKeyPair();
    await expect(openSealed(payload, s.witnessEnvelope, other.privateKey)).rejects.toThrow();
    expect(s.proofHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('wallet-DID onboarding (1.6.9)', () => {
  it('fetches the nonce, has the caller sign it, and sends walletProof', async () => {
    const calls: any[] = [];
    const orig = globalThis.fetch;
    (globalThis as any).fetch = async (url: string, init: any) => {
      calls.push({ url, init });
      if (String(url).includes('/v1/onboard/wallet-nonce')) return new Response(JSON.stringify({ ownerDid: 'did:pkh:eip155:8453:0xabc', nonce: 'n123', chainType: 'evm', address: '0xabc', message: 'MSG n123', expiresInSeconds: 600 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ apiKey: 'sk_x' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const { SynmercoClient } = await import('../src/index.js');
      const c = new SynmercoClient({ baseUrl: 'https://api.test' } as any);
      const out = await c.onboardWithWallet({ ownerDid: 'did:pkh:eip155:8453:0xabc' }, async (m) => 'SIG(' + m + ')');
      expect(out.apiKey).toBe('sk_x');
      expect(calls[0].url).toContain('/v1/onboard/wallet-nonce?ownerDid=did%3Apkh%3Aeip155%3A8453%3A0xabc');
      expect(JSON.parse(calls[1].init.body).walletProof).toEqual({ nonce: 'n123', message: 'MSG n123', signature: 'SIG(MSG n123)' });
    } finally { (globalThis as any).fetch = orig; }
  });
});
