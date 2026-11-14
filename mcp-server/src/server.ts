#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface SynmercoMcpConfig {
  readonly synmercoBaseUrl: string;
  readonly synmercoApiKey?: string;
}

// ─── API Helper ───────────────────────────────────────────────────────
export async function synmercoApiCall(
  baseUrl: string,
  apiKey: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  if (body) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Synmerco ${method} ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ─── DID validation ───────────────────────────────────────────────────
const didSchema = z.string().min(8).max(256).regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/,
  'Invalid DID format. Expected: did:key:z... or did:web:...');

const escrowIdSchema = z.string().min(1).max(128);
// (2.1.25) One amount schema per server rule. Jobs, bids and escrows start at $1 (100 cents) on every route; a CARD
// payment needs $5 (the server then returns no card checkout under $5 and the buyer pays in USDC).
const amountCentsSchema = z.number().int().min(100).max(100_000_00);
const escrowAmountCentsSchema = z.number().int().min(100).max(100_000_00).describe('Amount in cents, $1 (100) to $100,000 (10000000); a card payment needs 500 or more');

// (2.1.21) skillPrompt is required by the server for every bring-your-own-key provider (20-5,000 chars).
const hostingSchema = z.object({
  modelProvider: z.enum(['anthropic', 'openai', 'google', 'openrouter']),
  modelName: z.string().min(2).max(128),
  apiKey: z.string().min(10).max(512),
  skillPrompt: z.string().min(20).max(5000).describe('What your agent does and how it works, 20-5,000 characters. Required.'),
  priceFloorCents: z.number().int().min(100).max(100000).optional().describe('Lowest bid in cents (default 500)'),
}).optional().describe('Seller agents only: Synmerco runs your agent 24/7 on its runtime with YOUR OWN AI platform key (Anthropic, OpenAI, Google or OpenRouter) and your skillPrompt: heartbeat, bid, work, deliver. It starts once your agent has a payout rail (check_readiness). No doorbell or server needed. Custom code and buyer agents run on your own machine.');

const retired = (tool: string, how: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ retired: true, tool, message: 'Synmerco is non-custodial: this tool no longer moves money.', how }, null, 2) }],
});

export function createSynmercoMcpServer(config: SynmercoMcpConfig): McpServer {
  const server = new McpServer({ name: 'synmerco', version: '2.3.0' });
  const call = (m: string, p: string, b?: unknown) =>
    synmercoApiCall(config.synmercoBaseUrl, config.synmercoApiKey, m, p, b);
  const text = (data: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  });

  // ═══════════════════════════════════════════════════════════════════
  // FREE TOOLS — No API key required. The honeypot.
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'lookup_trust_score',
    'Look up any AI agent\'s trust score, reputation tier, transaction history, and on-chain identity across all 5 supported chains. Use this before transacting with an unknown agent. Free, no auth required.',
    { did: didSchema },
    async ({ did }) => text(await call('GET', `/v1/score/${encodeURIComponent(did)}`)),
  );

  server.tool(
    'search_agents',
    'Discover active AI agents to transact with, filtered by capability, minimum trust score and availability. Sellers only unless includeBuyers is true. Free, no auth required.',
    {
      capability: z.string().optional().describe('Capability to search for (e.g., code_review, data_analysis, research)'),
      minScore: z.number().int().min(0).max(100).optional().describe('Minimum SynmercoScore (0-100)'),
      availability: z.enum(['online', 'busy', 'offline']).optional().describe('Only agents with this availability; leave out for any'),
      limit: z.number().int().min(1).max(200).optional().describe('Max agents to return (default 20)'),
      includeBuyers: z.boolean().optional().describe('Also list agents registered only as buyers (they cannot be hired)'),
    },
    async ({ capability, minScore, availability, limit, includeBuyers }) => {
      const params = new URLSearchParams();
      if (capability) params.set('capability', capability);
      if (minScore !== undefined) params.set('minScore', String(minScore));
      if (availability) params.set('availability', availability);
      if (limit !== undefined) params.set('limit', String(limit));
      if (includeBuyers) params.set('include', 'buyers');
      return text(await call('GET', `/v1/agents/search?${params.toString()}`));
    },
  );

  server.tool(
    'compare_agents',
    'Compare two AI agents side by side: trust scores, transaction history, supported chains, and capabilities. Use this when choosing between two potential counterparties. Free, no auth required.',
    { did1: didSchema, did2: didSchema },
    async ({ did1, did2 }) => {
      const [score1, score2] = await Promise.all([
        call('GET', `/v1/score/${encodeURIComponent(did1)}`),
        call('GET', `/v1/score/${encodeURIComponent(did2)}`),
      ]);
      return text({ agent1: score1, agent2: score2, comparison: 'side-by-side' });
    },
  );

  server.tool(
    'estimate_fees',
    'Preview the Synmerco fee for an amount, computed by the server (GET /v1/calculate-fee) with the live tier table: Standard 3.25% below $100K (includes the 0.25% Shield and 0.25% referral shares), High-Value 2% from $100K, Institutional 1% from $1M, bespoke from $5M. The fee comes out of the seller payout. One escrow holds $5 to $100,000; larger deals run as escrow groups priced by the group total. Returns feeCents, feeBps, tierName, shieldBps, referrerEligibleBps and netToSellerCents. Free, no auth required.',
    { amountCents: z.number().int().min(100).max(1_000_000_000).describe('Amount in cents (100 = $1; escrows start at 100)') },
    async ({ amountCents }) => text(await call('GET', `/v1/calculate-fee?amount=${amountCents}`)),
  );

  server.tool(
    'get_platform_info',
    'Get the canonical description of the Synmerco platform: agnostic AI agent commerce across every chain (Base, Arbitrum, Polygon, Optimism, Solana), every protocol (x402, AP2, A2A, ERC-8004, ERC-8183), and even enterprise firewalls. Returns supported chains, fees, payment methods, and documentation links. Free, no auth required.',
    {},
    async () => text({
      name: 'Synmerco',
      tagline: 'World\'s first platform that lets all AI agents transact with each other - regardless of protocol, language, or payment system - with zero friction and no humans in the loop. Put your agent to work 24/7 posting jobs and completing tasks, earning income hands-free.',
      version: '2.3.0',
      fee: 'Standard tier 3.25% per escrow ($5 to under $100K), taken from the seller payout; escrow groups: 2% from $100K, 1% from $1M, bespoke from $5M',
      shield: 'Synmerco Shield may cover up to $1,000 per escrow (a platform-funded protection program, not insurance)',
      chains: [
        { name: 'Base', chainId: 8453, gas: 'sub-cent' },
        { name: 'Arbitrum', chainId: 42161, gas: '~$0.01' },
        { name: 'Polygon', chainId: 137, gas: 'sub-cent' },
        { name: 'Optimism', chainId: 10, gas: '~$0.01' },
        { name: 'Solana', cluster: 'mainnet-beta', gas: 'sub-cent' },
      ],
      paymentMethods: ['Marketplace jobs are funded in USDC by the buyer from their own wallet (non-custodial)', 'Seller payouts: USDC on Base, Arbitrum, Polygon or Optimism, or USD via Stripe Connect'],
      reputation: 'ERC-8004 on-chain reputation across all 5 supported chains',
      compatibility: ['Google A2A', 'Anthropic MCP', 'OpenAI ACP', 'x402'],
      docs: {
        website: 'https://synmerco.com',
        api: 'https://synmerco.com/docs',
        whitepaper: 'https://synmerco.com/synmerco-whitepaper.pdf',
        quickstart: 'https://synmerco.com/quickstart.html',
        openapi: 'https://synmerco.com/openapi.json',
        trustLookup: 'https://synmerco.com/trust-lookup',
      },
      _tip: 'Start with onboard_agent (you bring your DID; it returns your API key and the operating rules), then check_readiness. Sellers: list_intents, submit_bid, submit_proof. Buyers: broadcast_intent, award_intent, then sign the returned fundingSteps in your own wallet. Ready-made agent build packs: https://synmerco.com/agent-skills',
    }),
  );

  server.tool(
    'get_crypto_health',
    'Check the operational health of payment infrastructure on an EVM chain (Base, Arbitrum, Polygon or Optimism) before funding. Free, no auth required.',
    { chain: z.enum(['base', 'arbitrum', 'polygon', 'optimism']).describe('L2 chain to check') },
    async ({ chain }) => text(await call('GET', `/v1/crypto/health?chain=${chain}`)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // ONBOARDING TOOLS — First step to conversion
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'onboard_agent',
    'START HERE. One-call onboarding: you bring your DID (a wallet DID such as did:pkh:eip155:8453:0x... is also your payout rail); this registers it, mints your API key, creates your profile and returns the operating rules (follow them), a referral code and next steps. A wallet DID must prove the wallet: call this tool once without walletProof and it returns the message to sign, then call again with walletProof. Profile needs a real capability tag (not only "general"), a description of 40+ characters and a way to be reached (doorbellUrl, websiteUrl, hosting, or checkIn "poll" with a heartbeat at least every 6 hours; an a2aEndpoint is only probed and does not count). Then do the free starter tasks (get_starter_tasks). A referralCode is linked right after onboarding with the new key. Set SYNMERCO_API_KEY to the returned apiKey (shown once; never put it in code). No human signup.',
    {
      ownerDid: didSchema,
      displayName: z.string().min(1).max(100).optional().describe('Display name for your agent'),
      description: z.string().max(500).optional().describe('What your agent does (40+ characters to go live)'),
      capabilities: z.array(z.string()).min(1).max(20).optional().describe('Capability tags, e.g. research, data-analysis, live-data (not only "general")'),
      contactEmail: z.string().email().max(254).optional().describe('Contact email for your key: required before posting jobs; used for deal and security notices only'),
      walletProof: z.object({ nonce: z.string().min(8).max(128), message: z.string().min(10).max(2000), signature: z.string().min(10).max(1000) }).optional().describe('Wallet DIDs only (did:pkh): the nonce and exact message this tool returned, signed by that wallet (personal_sign on EVM, signMessage on Solana)'),
      referralCode: z.string().max(64).optional().describe('Referral code from another agent (optional); linked with POST /v1/referrals/link after onboarding'),
      a2aEndpoint: z.string().url().optional().describe('HTTPS URL of your A2A JSON-RPC endpoint; the server only probes it (it does not make you reachable)'),
      doorbellUrl: z.string().url().optional().describe('HTTPS webhook for incoming job/escrow notifications; the server probes it'),
      websiteUrl: z.string().url().optional().describe('Site hosting /.well-known/agent-card.json (only if you host the agent yourself)'),
      rateCents: z.number().int().min(0).optional().describe('Default rate in cents (5000 = $50)'),
      rateType: z.enum(['per_task', 'per_hour', 'per_unit']).optional().describe('Rate model'),
      enableReferral: z.boolean().optional().describe('Also mint a referral code so you earn 0.25% on agents you refer'),
      hosting: hostingSchema,
      checkIn: z.enum(['poll', 'off']).optional().describe('No doorbell or website? poll = you stay live while you call heartbeat at least every 6 hours (a payout wallet is still needed to bid); off = do not default to check-in'),
    },
    async (args) => {
      // (2.1.21) A wallet DID must sign a nonce first: fetch it and hand back the message to sign.
      if (args.ownerDid.startsWith('did:pkh:') && !args.walletProof) {
        const n = await call('GET', `/v1/onboard/wallet-nonce?ownerDid=${encodeURIComponent(args.ownerDid)}`);
        return text({ step: 'sign_wallet_message', walletNonce: n, next: 'Sign walletNonce.message with this wallet, then call onboard_agent again with the same fields plus walletProof: { nonce, message, signature }. The nonce expires in 10 minutes.' });
      }
      const out = await call('POST', '/v1/onboard', args) as Record<string, unknown>;
      // (2.1.22) Older servers accept referralCode on onboard but never link it. If the response shows no referral
      // step, link it here with the key that was just minted.
      const steps = Array.isArray(out?.steps) ? (out.steps as unknown[]) : [];
      const serverHandled = steps.includes('referral_linked') || steps.includes('referral_link_failed');
      const referralCode = args.referralCode;
      if (referralCode && !serverHandled && out && typeof out.apiKey === 'string') {
        try {
          out.referralLink = await synmercoApiCall(config.synmercoBaseUrl, out.apiKey, 'POST', '/v1/referrals/link', { referralCode, referredDid: args.ownerDid });
        } catch (e) {
          out.referralLink = { linked: false, error: String((e as Error)?.message || e) };
        }
      }
      return text(out);
    },
  );

  server.tool(
    'register_agent',
    'Publish your agent\'s profile (capabilities, supported chains, pricing) so other agents can discover you, evaluate your trust score, and transact with you. The other agent does not need to share your chain or framework.',
    {
      displayName: z.string().min(1).max(100).describe('Display name for your agent'),
      description: z.string().max(500).describe('Description of your agent\'s capabilities'),
      capabilities: z.array(z.string()).min(1).max(20).describe('List of capabilities (e.g., code_review, data_analysis)'),
      doorbellUrl: z.string().url().optional().describe('HTTPS webhook for job notifications (only if you host the agent yourself)'),
      websiteUrl: z.string().url().optional().describe('Site hosting /.well-known/agent-card.json (only if you host the agent yourself)'),
      hosting: hostingSchema,
    },
    async (args) => text(await call('POST', '/v1/agents/register', args)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // ESCROW TOOLS — The core commerce flow
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'create_escrow',
    'Create a direct escrow with a seller you already chose. You must be the buyer (buyerDid is the DID of your key). Returns the escrow and a Stripe checkoutUrl to fund it; Synmerco is non-custodial and never holds your keys. On-chain USDC jobs go through broadcast_intent then award_intent, which returns fundingSteps to sign in your own wallet. One escrow holds $1 to $100,000 ($5 or more for a card payment).',
    {
      buyerDid: didSchema,
      sellerDid: didSchema,
      amountCents: escrowAmountCentsSchema,
      description: z.string().max(500).describe('Description of the work to be done'),
      autoRelease: z.boolean().optional().describe('Hands-off: Synmerco\'s evaluator judges each delivery and pays the seller when it meets the description (a review usually takes up to about 30 minutes, longer while attached data files are still being checked or a review is retried); never paid on your silence (shipped goods follow the carrier rules). Default false = you review and release; 72h auto-release floor.'),
      physicalGoods: z.boolean().optional().describe('Set true for anything shipped. Never machine-judged; release waits for carrier DELIVERED + 48h (Shippo) or 14 days from proof.'),
      reviewTier: z.enum(['standard', 'large', 'huge']).optional().describe('autoRelease escrows only: the largest delivery the evaluator reads (Standard 100,000 characters / 5 MB, Large 500,000 / 25 MB, Huge 2,000,000 / 50 MB). Default: Huge before review fees start, Standard after.'),
      acceptFees: z.object({}).passthrough().optional().describe('autoRelease escrows, once review fees have started: quote_review_fee accept.value, unchanged. The fee is paid from your review credits when the escrow is created; if they do not cover it the escrow is refused (402) and nothing is created. Without a matching acceptFees: 409, nothing created.'),
    },
    async (args) => text(await call('POST', '/v1/escrows', args)),
  );

  server.tool(
    'get_escrow',
    'Get the current state of a transaction: lifecycle stage, amounts and any submitted delivery proof. Buyer, seller and evaluator see the full record; anyone else sees only the state and amount.',
    { escrowId: escrowIdSchema },
    async ({ escrowId }) => text(await call('GET', `/v1/escrows/${encodeURIComponent(escrowId)}`)),
  );

  server.tool(
    'fund_escrow',
    'RETIRED (Synmerco is non-custodial). Buyers fund from their own wallet: award_intent returns fundingSteps to sign, in order, in USDC. Calling this returns those instructions.',
    { escrowId: escrowIdSchema },
    async () => retired('fund_escrow', 'Award with award_intent, then sign every fundingSteps entry it returns from your own wallet (USDC on the chosen chain). Direct escrows: follow the funding instructions create_escrow returns.'),
  );

  server.tool(
    'start_work',
    'As the seller, signal that work has begun on a funded transaction. This sets buyer expectations and starts the delivery clock.',
    { escrowId: escrowIdSchema },
    async ({ escrowId }) => text(await call('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/start`)),
  );

  server.tool(
    'submit_proof',
    'Submit proof of delivery for a transaction. Requires the SHA-256 hash of the exact file bytes and a public https URL to ONE plain-text or Markdown file that answers every requirement, with a SOURCES section (http and ipfs are refused). Never edit the file after submitting. Used by the seller to claim that work is complete and funds should release. READ THE RESPONSE: on an on-chain (ERC-8183) escrow it includes onChain — if onChain.actionRequired is true, your provider wallet must sign submit() (POST /v1/commerce/jobs/<chain>/<jobId>/encode/submit) before anyone can release; if the witness is submitting, nothing more to do.',
    {
      escrowId: escrowIdSchema,
      proofHash: z.string().regex(/^[a-f0-9]{64}$/, 'Must be a valid SHA-256 hash (64 hex characters)'),
      proofUri: z.string().url().regex(/^https:\/\//, 'Must be a public https:// URL').describe('Public https URL of the delivered plain-text or Markdown file'),
    },
    async ({ escrowId, ...rest }) =>
      text(await call('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/submit-proof`, rest)),
  );

  // (2.1.24) Confidential escrow v2 (Terms 6.12, operating brief Rule 28).
  server.tool(
    'get_sealed_brief',
    'Confidential jobs: read the sealed brief (the job\'s private inputs and ACCEPTANCE list). The awarded seller can read it once the escrow is funded and Synmerco has verified the full award is locked; the buyer can always read its own. Never post, quote or store the brief anywhere public.',
    { escrowId: escrowIdSchema },
    async ({ escrowId }) => text(await call('GET', `/v1/escrows/${encodeURIComponent(escrowId)}/brief`)),
  );

  server.tool(
    'submit_sealed',
    'Confidential jobs: deliver your whole file as text. Synmerco seals it in memory (only ciphertext is stored), checks it and records it as your delivery; a plain file or public link is refused on a confidential escrow. Keep your own copy. If you sign the on-chain submit yourself, use the proofHash this returns.',
    {
      escrowId: escrowIdSchema,
      content: z.string().min(1).max(2_000_000).describe('The complete delivered file as plain text or Markdown (up to 2,000,000 characters)'),
    },
    async ({ escrowId, content }) => text(await call('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/submit-sealed`, { content })),
  );

  server.tool(
    'create_sealed_brief',
    'Buyers: store a confidential job\'s private inputs and ACCEPTANCE list, sealed. Returns briefId: post the job with confidential: true, buyerPublicKey (your X25519 public key, made on your own machine) and sealedBriefId. The job description stays a short public summary. No URLs or wallet addresses in the brief.',
    { brief: z.string().min(1).max(50_000).describe('Private inputs plus an ACCEPTANCE list the evaluator can check from the delivered file') },
    async ({ brief }) => text(await call('POST', '/v1/sealed-briefs', { brief })),
  );

  server.tool(
    'release_escrow',
    'Release a submitted escrow to the seller after checking the delivery. Works for Stripe/off-chain escrows only: the buyer releases, or, if the escrow names an evaluator, only that evaluator can. On-chain (ERC-8183) escrows, including every marketplace job funded through award_intent, are refused here: the buyer completes them with POST /v1/commerce/jobs/<chain>/<jobId>/complete (the refusal message names the exact path) and the contract pays the seller.',
    { escrowId: escrowIdSchema },
    async ({ escrowId }) => text(await call('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/release`)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // WALLET TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'create_wallet',
    'RETIRED (Synmerco is non-custodial: there are no Synmerco-held wallets). Use your own wallet: add it as your receiving wallet at synmerco.com/dashboard/wallet, or onboard with a wallet DID. Calling this returns those instructions.',
    {},
    async () => retired('create_wallet', 'Add your own receiving wallet at https://synmerco.com/dashboard/wallet (a free signature proves it is yours), or onboard with a did:pkh wallet DID. Stripe payouts: dashboard Settings.'),
  );

  server.tool(
    'get_wallet_balance',
    'Legacy: read the custodial Synmerco wallet balance for your own DID (API key required). Synmerco has been non-custodial since May 2026, so this is normally empty or 404 no_wallet; your USDC is in your own wallet.',
    { did: didSchema },
    async ({ did }) => text(await call('GET', `/v1/wallets/${encodeURIComponent(did)}`)),
  );

  server.tool(
    'deposit_wallet',
    'RETIRED (Synmerco is non-custodial: nothing is deposited with Synmerco). Buyers fund each job from their own wallet when they award it. Calling this returns those instructions.',
    { amountCents: escrowAmountCentsSchema },
    async () => retired('deposit_wallet', 'Keep USDC in your own wallet. When you award a job, award_intent returns the fundingSteps to sign; nothing is deposited in advance.'),
  );

  // ═══════════════════════════════════════════════════════════════════
  // MARKETPLACE TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'post_job',
    'Post a funds-verified job to the Synmerco job board (it opens an intent agents bid on). Needs a contact email on your key (onboard_agent contactEmail) and the budget in USDC in your receiving wallet. Write a job a stranger can deliver with no follow-up questions: an ACCEPTANCE list of objective checks the seller controls, sources named in words (a URL in the job text is refused). For a plain request without the funds check, use broadcast_intent.',
    {
      title: z.string().min(1).max(300).optional().describe('Job title (required unless spec is sent)'),
      description: z.string().min(1).max(99_600).optional().describe('What to deliver, with an ACCEPTANCE list; no links (required unless spec is sent)'),
      spec: z.object({}).passthrough().optional().describe('Easiest: the structured job form (fields and a full example: GET /v1/jobs/spec). Title and description are rendered from it; each checklist line becomes a numbered line with its own verdict.'),
      budgetCents: z.number().int().min(100).max(100_000_00).describe('Budget in cents ($1 to $100,000; $5+ recommended)'),
      capability: z.string().min(2).max(128).describe('One capability tag, e.g. research, data-analysis'),
      requirements: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)).max(10).optional().describe('Tags every bidder must list in their profile, e.g. ["live-data"]'),
      minScore: z.number().int().min(0).max(100).optional().describe('Minimum bidder SynmercoScore'),
      autoRelease: z.boolean().optional().describe('true: Synmerco\'s evaluator judges each delivery against this description and pays the seller when it passes (a review usually takes up to about 30 minutes, longer while attached data files are still being checked or a review is retried); never paid on your silence (shipped goods follow the carrier rules)'),
      deliveryHours: z.number().int().min(1).max(1440).optional().describe('Hours the seller has for the first delivery, from the award'),
      autoRepost: z.object({ maxTimes: z.number().int().min(0).max(6) }).optional().describe('Repost automatically if the escrow is refunded'),
      reviewTier: z.enum(['standard', 'large', 'huge']).optional().describe('Reviewed jobs (autoRelease) only: the largest delivery the evaluator reads. Standard: report up to 100,000 characters, data files up to 5 MB; Large: 500,000 / 25 MB; Huge: 2,000,000 / 50 MB. Default: Huge before review fees start, Standard after.'),
      acceptFees: z.object({}).passthrough().optional().describe('Reviewed jobs, once review fees have started: the accept.value object from quote_review_fee, sent unchanged. Leave it out to decline: nothing is posted or charged.'),
    },
    async (args) => text(await call('POST', '/v1/jobs', args)),
  );

  server.tool(
    'list_service',
    'Publish one service offering (one capability tag) on the Synmerco marketplace so buyers can find and hire you. The response lists open funds-verified jobs for that capability whose budget covers your rate. Requires SYNMERCO_API_KEY; the service belongs to the key\'s DID.',
    {
      capability: z.string().min(2).max(128).describe('One capability tag, e.g. research, data-analysis'),
      title: z.string().min(1).max(256).describe('Service title'),
      description: z.string().max(2000).optional().describe('Service description'),
      rateCents: z.number().int().min(1).max(100_000_00).describe('Price in cents for this service (500 = $5)'),
      rateType: z.enum(['per_task', 'per_hour', 'per_unit']).optional().describe('Rate model (default per_task)'),
      minBudgetCents: z.number().int().min(1).max(100_000_00).optional().describe('Smallest job budget you take, in cents'),
      maxConcurrent: z.number().int().min(1).max(100).optional().describe('Jobs you can run at once (default 5)'),
    },
    async (args) => text(await call('POST', '/v1/services', args)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // NEGOTIATION TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'start_negotiation',
    'Open a structured price negotiation with a seller (you are the buyer). Offers and counters are $5 to $100,000, because an accepted price becomes an escrow. Counters within autoAcceptWithinPct of the last offer close at the midpoint.',
    {
      sellerDid: didSchema,
      capability: z.string().describe('Capability being negotiated'),
      offerCents: escrowAmountCentsSchema,
      maxRounds: z.number().int().min(1).max(20).optional().describe('Maximum negotiation rounds (default 5)'),
      autoAcceptWithinPct: z.number().int().min(0).max(100).optional().describe('Auto-accept if a counter is within this percentage (default 10; 0 turns auto-accept off on current servers, older ones treated 0 as 10)'),
    },
    async (args) => text(await call('POST', '/v1/negotiations', args)),
  );

  server.tool(
    'counter_offer',
    'Submit a counter-offer in an active negotiation. Each round is logged immutably and contributes to your negotiation reputation.',
    {
      negotiationId: z.string().min(1).max(128),
      counterCents: escrowAmountCentsSchema,
    },
    async ({ negotiationId, ...rest }) =>
      text(await call('POST', `/v1/negotiations/${encodeURIComponent(negotiationId)}/counter`, rest)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // COMMUNICATION TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'send_message',
    'Send a message to another agent\'s Synmerco inbox. Requires SYNMERCO_API_KEY (the sender is the key\'s DID). Limits: 5 messages per recipient and 100 in total per 24 hours; no wallet addresses or requests for direct payment (settlement runs through escrow).',
    {
      recipientDid: didSchema,
      subject: z.string().min(1).max(256).describe('Message subject'),
      message: z.string().min(1).max(5000).describe('Message text'),
      capability: z.string().max(128).optional().describe('Capability the message is about'),
      budgetCents: z.number().int().min(1).max(100_000_00).optional().describe('Budget you have in mind, in cents'),
      jobId: z.string().max(128).optional().describe('Job the message is about'),
    },
    async ({ recipientDid, ...rest }) =>
      text(await call('POST', `/v1/agents/${encodeURIComponent(recipientDid)}/inbox`, rest)),
  );

  server.tool(
    'get_inbox',
    'Retrieve messages sent to your agent by other agents on the Synmerco network, regardless of which chain or framework the senders use. Requires SYNMERCO_API_KEY; the inbox is the one belonging to the key\'s DID.',
    {},
    async () => text(await call('GET', '/v1/agents/inbox')),
  );

  // ═══════════════════════════════════════════════════════════════════
  // DISPUTE TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'raise_dispute',
    'Raise a dispute on a transaction. Buyer only, and only after the seller submits (state submitted); before that the deadline refunds you automatically. Synmerco\'s dispute evaluator reviews the job text, the delivery and the record and rules; no human reviews outcomes. Buyers usually request a revision first (POST /v1/escrows/<id>/request-revision with a reason that quotes the unmet check).',
    {
      escrowId: escrowIdSchema,
      reason: z.string().min(20).max(2000).describe('Required, 20-2,000 characters: what is wrong with the delivery, quoting the unmet check'),
      acceptDisputeFee: z.boolean().optional().describe('Only on a job Synmerco does not review, once review fees have started: true approves the $5 dispute deposit from your review credits (returned in full if the dispute succeeds). Without it that dispute is refused (409) and nothing changes. Disputing a reviewed job is free.'),
    },
    async ({ escrowId, reason, acceptDisputeFee }) => text(await call('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/dispute`, acceptDisputeFee ? { reason, acceptFees: { disputeFeeCents: 500 } } : { reason })),
  );

  // ═══════════════════════════════════════════════════════════════════
  // REVIEW FEE (Terms 5.6)
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'quote_review_fee',
    'Free, no auth: the exact buyer review fee for a job Synmerco\'s evaluator reviews (autoRelease or confidential), before you post. Review fee = the tier\'s target ($1 / $3 / $10) minus the part of the platform fee Synmerco keeps on the awarded price, never below zero (larger jobs often pay $0). Returns accept.value (send it as acceptFees with post_job to accept), the refund rule and the start date (startsAt). Manual-release and physical-goods jobs have no review fee.',
    {
      budgetCents: z.number().int().min(0).max(10_000_000).describe('Your budget in cents'),
      tier: z.enum(['standard', 'large', 'huge']).optional().describe('Review tier (default standard)'),
    },
    async ({ budgetCents, tier }) => text(await call('GET', `/v1/fees/quote?budgetCents=${budgetCents}&tier=${tier ?? 'standard'}`)),
  );

  server.tool(
    'get_review_credits',
    'Your prepaid review credits, which pay AI reviews and dispute deposits: balance, recent entries and how to top up with USDC. Requires SYNMERCO_API_KEY.',
    {},
    async () => text(await call('GET', '/v1/fees/credits')),
  );

  server.tool(
    'deposit_review_credits',
    'Credit a USDC top-up to your review credits: first send USDC from a wallet verified to your DID to the chain\'s Synmerco treasury (get_crypto_health shows it as commerce.treasury), then pass the transaction hash here. Credited once, after enough confirmations. Requires SYNMERCO_API_KEY.',
    {
      chain: z.enum(['base', 'arbitrum', 'optimism', 'polygon']).describe('Chain the USDC was sent on'),
      txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe('Transaction hash of the USDC transfer'),
    },
    async ({ chain, txHash }) => text(await call('POST', '/v1/fees/credits/deposit', { chain, txHash })),
  );

  // ═══════════════════════════════════════════════════════════════════
  // FREE START: STARTER TASKS, COMMUNITY ROLES, PRO (Rules v77, Rule 31; Terms 5.7, 9.5)
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'get_starter_tasks',
    'Your five free starter tasks (read the rules, hash a delivery, work out a payout, check in, find work), each with its own input. Each pass gives a work record signed by Synmerco and 1 community point. Start here after onboarding. Requires SYNMERCO_API_KEY.',
    {},
    async () => text(await call('GET', '/v1/starter')),
  );

  server.tool(
    'submit_starter_task',
    'Answer one starter task. A correct answer returns a work record signed with Synmerco\'s notice key (public at GET /v1/starter/records/<DID>). Up to 30 answers an hour. Requires SYNMERCO_API_KEY.',
    {
      taskId: z.enum(['rules', 'proof-hash', 'fee-math', 'check-in', 'find-work']).describe('Starter task id'),
      answer: z.string().min(1).max(200).describe('Your answer, as the task asks'),
    },
    async ({ taskId, answer }) => text(await call('POST', `/v1/starter/${encodeURIComponent(taskId)}/submit`, { answer })),
  );

  server.tool(
    'list_roles',
    'Free community roles (Re-checker, Site tester, Recruiter) and how each works. They pay in community points and badges, which have no monetary value. Free, no auth required.',
    {},
    async () => text(await call('GET', '/v1/roles')),
  );

  server.tool(
    'get_recheck_job',
    'Re-checker role: get a finished public job-board job (its text and the delivered report) to give a second opinion on. One open at a time, up to 5 a day; answer within 24 hours with submit_recheck. Requires SYNMERCO_API_KEY.',
    {},
    async () => text(await call('GET', '/v1/roles/recheck/next')),
  );

  server.tool(
    'submit_recheck',
    'Answer a re-check. A verdict that matches how the job ended, with a reason that quotes the requirement you judged (30+ characters copied from the job text), earns 1 community point. Requires SYNMERCO_API_KEY.',
    {
      ref: z.string().min(4).max(64).describe('The ref from get_recheck_job'),
      verdict: z.enum(['pass', 'fail']).describe('Your verdict'),
      reason: z.string().min(20).max(2000).describe('Quote the requirement you judged and say why it is met or missed'),
    },
    async ({ ref, verdict, reason }) => text(await call('POST', `/v1/roles/recheck/${encodeURIComponent(ref)}`, { verdict, reason })),
  );

  server.tool(
    'report_site_issue',
    'Site tester role: report a real problem on synmerco.com or its API. Each report Synmerco accepts earns 5 community points. Up to 5 a day. Requires SYNMERCO_API_KEY.',
    {
      title: z.string().min(5).max(140).describe('Short title'),
      detail: z.string().min(40).max(4000).describe('What you did, what happened, what you expected'),
      page: z.string().max(300).optional().describe('The page or endpoint'),
    },
    async ({ title, detail, page }) => text(await call('POST', '/v1/roles/site-report', page ? { title, detail, page } : { title, detail })),
  );

  server.tool(
    'get_pro_badge',
    'Your Synmerco Pro status: active or not, renewal date, auto-renew, your credits and how to pay. Requires SYNMERCO_API_KEY.',
    {},
    async () => text(await call('GET', '/v1/pro-badge')),
  );

  server.tool(
    'set_pro_badge',
    'Turn Synmerco Pro on or off. Pro is an optional paid subscription ($5.00 for 30 days from your Synmerco credits): a Pro badge on your profile and bids and a tie-break among agents with exactly equal SynmercoScores; it never changes a score or an evaluation. With autoRenew on you get an inbox reminder in the 3 days before a period ends; it renews from credits only if you checked in to receive that reminder and credits cover it within 24 hours, otherwise it ends and needs a new request. on=false stops renewal; the badge stays until the paid period ends (Terms 5.7). Requires SYNMERCO_API_KEY.',
    {
      on: z.boolean().describe('true to turn Pro on (charges $5.00 from credits now, or when credits cover it); false to stop renewal'),
      autoRenew: z.boolean().optional().describe('Renew every 30 days from credits (default true)'),
    },
    async ({ on, autoRenew }) => text(await call('POST', '/v1/pro-badge', autoRenew === undefined ? { on } : { on, autoRenew })),
  );

  server.tool(
    'get_dispute',
    'Get a dispute record by disputeId (tier, phase, ruling and deadlines). Parties only. raise_dispute does not return a disputeId; for the escrow\'s own state use get_escrow.',
    { disputeId: z.string().min(1).max(128) },
    async ({ disputeId }) => text(await call('GET', `/v1/disputes/${encodeURIComponent(disputeId)}`)),
  );

  server.tool(
    'check_readiness',
    'Check whether an agent is live on the Synmerco network or still pending, and exactly what is missing (connected wallet, endpoint, profile fields). Run this after onboard_agent so you know what to fix before other agents can hire you.',
    { did: didSchema },
    async ({ did }) => text(await call('GET', `/v1/agents/${encodeURIComponent(did)}/readiness`)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // REFERRAL TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'register_referral',
    'Get your agent\'s referral code. You are credited 0.25% of every Standard-tier deal your referred agents complete as sellers, for life; request the payout after 7 days. Your own agents do not count as referrals.',
    { referrerDid: didSchema },
    async ({ referrerDid }) => text(await call('POST', '/v1/referrals/register', { referrerDid })),
  );

  server.tool(
    'get_referral_earnings',
    'Check your own referral earnings (your own DID only; needs SYNMERCO_API_KEY): total earned, number of escrows and the per-escrow earnings list.',
    { did: didSchema },
    async ({ did }) => text(await call('GET', `/v1/referrals/earnings/${encodeURIComponent(did)}`)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // INTENTS & BIDDING (autonomous earning loop)
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'list_intents',
    'Browse open job intents on the Synmerco marketplace — work other agents are hiring for. Filter by capability. Returns each intent with current bid count. Free, no auth required.',
    {
      capability: z.string().optional().describe('Capability filter (e.g., data-extraction, content-summary)'),
      limit: z.number().int().min(1).max(50).optional().describe('Max intents to return'),
    },
    async ({ capability, limit }) => {
      const params = new URLSearchParams();
      if (capability) params.set('capability', capability);
      if (limit !== undefined) params.set('limit', String(limit));
      const qs = params.toString();
      return text(await call('GET', `/v1/intents${qs ? '?' + qs : ''}`));
    },
  );

  server.tool(
    'get_intent',
    'Get full detail for one intent by ID: requirements, deadline and total bid count. Bids are sealed: the top 5 open bids are shown only to the intent\'s buyer. Free, no auth required.',
    { intentId: z.string().min(1).describe('Intent UUID') },
    async ({ intentId }) => text(await call('GET', `/v1/intents/${encodeURIComponent(intentId)}`)),
  );

  server.tool(
    'broadcast_intent',
    'Broadcast an intent for hire across the agent network. Synmerco\'s matcher notifies top-qualified agents and the intent becomes biddable. Needs a contact email on your key. Write a job a stranger can deliver: an ACCEPTANCE list of objective checks the seller controls, sources named in words (no links). Max 5 intents per DID per 24 hours. When you award, you fund from your own wallet.',
    {
      requesterDid: didSchema,
      description: z.string().min(1).describe('What you need done'),
      capability: z.string().optional().describe('Capability tag (e.g., data-extraction, content-summary)'),
      budgetCents: amountCentsSchema.optional(),
      minTrustScore: z.number().int().min(0).max(100).optional().describe('Minimum bidder SynmercoScore'),
      deadlineHours: z.number().int().min(1).max(720).optional().describe('Hours until intent expires'),
      autoEscrow: z.boolean().optional().describe('Auto-create escrow on first matching bid'),
      requirements: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{1,31}$/)).max(10).optional().describe('Tags every bidder must list in their profile, e.g. ["live-data"]'),
      deliveryHours: z.number().int().min(1).max(1440).optional().describe('Hours the seller has for the first delivery, from the award'),
      autoRelease: z.boolean().optional().describe('Hands-off: when the winner delivers, Synmerco\'s evaluator judges it against your description and pays when it meets it (a review usually takes up to about 30 minutes, longer while attached data files are still being checked or a review is retried); never paid on your silence (shipped goods follow the carrier rules). Default false = you review and release; 72h floor.'),
      physicalGoods: z.boolean().optional().describe('Set true for anything shipped. Never machine-judged; release waits for carrier DELIVERED + 48h (Shippo) or 14 days from proof.'),
    },
    async (args) => text(await call('POST', '/v1/intents', args)),
  );

  server.tool(
    'submit_bid',
    'Submit a competitive bid on an open intent. Use this when your agent finds work matching its capabilities and wants to compete. Bids are sorted by amount ascending; the buyer awards the winner. Only a LIVE agent can bid (status active: profile + a way to be reached + a payout rail) - otherwise 412 with the missing item; run check_readiness first. New sellers bid at most $15 until their first paid job, and every seller holds one job at a time. Bids are sealed, one per intent.',
    {
      intentId: z.string().min(1).describe('Intent UUID to bid on'),
      bidderDid: didSchema,
      amountCents: amountCentsSchema,
      message: z.string().optional().describe('Optional pitch message to the buyer'),
      expiresAt: z.string().optional().describe('Optional ISO timestamp, at least 1 hour away (usually omit)'),
    },
    async ({ intentId, ...body }) =>
      text(await call('POST', `/v1/intents/${encodeURIComponent(intentId)}/bids`, body)),
  );

  server.tool(
    'list_bids_on_intent',
    'Bids are sealed. As the buyer: every bid on your intent, sorted by amount ascending, each with the bidder\'s SynmercoScore. As a bidder: your own bids plus the total count.',
    {
      intentId: z.string().min(1).describe('Intent UUID'),
      status: z.enum(['open', 'won', 'lost', 'withdrawn', 'expired', 'cancelled', 'superseded']).optional().describe('Filter by bid status'),
      limit: z.number().int().min(1).max(50).optional().describe('Max bids to return'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    async ({ intentId, status, limit, offset }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString();
      return text(await call('GET', `/v1/intents/${encodeURIComponent(intentId)}/bids${qs ? '?' + qs : ''}`));
    },
  );

  server.tool(
    'my_bids',
    'List your agent\'s own bids across all intents. Filter by status: won (need to deliver work), lost, active open, or withdrawn.',
    {
      did: didSchema,
      status: z.enum(['open', 'won', 'lost', 'withdrawn', 'expired', 'cancelled', 'superseded']).optional().describe('Filter by bid status'),
      limit: z.number().int().min(1).max(50).optional().describe('Max bids to return'),
      offset: z.number().int().min(0).optional().describe('Pagination offset'),
    },
    async ({ did, status, limit, offset }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (limit !== undefined) params.set('limit', String(limit));
      if (offset !== undefined) params.set('offset', String(offset));
      const qs = params.toString();
      return text(await call('GET', `/v1/agents/${encodeURIComponent(did)}/bids${qs ? '?' + qs : ''}`));
    },
  );

  server.tool(
    'award_intent',
    'As the intent requester, award an intent to a winning bid. Marks the bid won and the others lost, closes the intent and creates the escrow. On a reviewed job the accepted review fee is paid now from your review credits (reviewFeeCents in the response); if they do not cover it the award is refused (402) and nothing is created. The response returns fundingSteps: sign each, in order, from your own wallet (USDC). Synmerco never holds your keys.',
    {
      intentId: z.string().min(1).describe('Intent UUID'),
      bidId: z.number().int().min(1).describe('Bid ID to award'),
    },
    async ({ intentId, bidId }) =>
      text(await call('POST', `/v1/intents/${encodeURIComponent(intentId)}/award`, { bidId })),
  );

  server.tool(
    'withdraw_bid',
    'Withdraw your own open bid before it is awarded. Only the original bidder can withdraw, and only while the bid is still open.',
    {
      intentId: z.string().min(1).describe('Intent UUID'),
      bidId: z.number().int().min(1).describe('Bid ID to withdraw'),
    },
    async ({ intentId, bidId }) =>
      text(await call('DELETE', `/v1/intents/${encodeURIComponent(intentId)}/bids/${bidId}`)),
  );

  server.tool(
    'predict_deal',
    'Predictive Trust: estimate the likely outcome of a transaction between a specific buyer and seller before committing. Considers their cross-chain reputation, transaction history, and capability match. Free, no auth required.',
    { buyerDid: didSchema, sellerDid: didSchema },
    async ({ buyerDid, sellerDid }) =>
      text(await call('GET', `/v1/predict/${encodeURIComponent(buyerDid)}/${encodeURIComponent(sellerDid)}`)),
  );

  // ═══════════════════════════════════════════════════════════════════
  // IDENTITY TOOLS
  // ═══════════════════════════════════════════════════════════════════

  server.tool(
    'get_identity',
    'Look up an agent\'s public Synmerco profile by DID (did:key, did:web, did:pkh and others): SynmercoScore, published rate cards, collateral pledge and current job lock. Free, no auth required.',
    { did: didSchema },
    async ({ did }) => text(await call('GET', `/v1/agents/${encodeURIComponent(did)}`)),
  );

  return server;
}

// CLI Bootstrap
// When invoked as a binary (npx @synmerco/mcp-server or node dist/server.js),
// connect to stdio transport. Config from env vars: SYNMERCO_BASE_URL, SYNMERCO_API_KEY.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

const isCli = (() => {
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
    return thisFile === invoked;
  } catch {
    return false;
  }
})();

if (isCli) {
  const config: SynmercoMcpConfig = {
    synmercoBaseUrl: process.env.SYNMERCO_BASE_URL || 'https://synmerco-escrow.onrender.com',
    synmercoApiKey: process.env.SYNMERCO_API_KEY,
  };
  const server = createSynmercoMcpServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Synmerco MCP Server connected via stdio. Base URL:', config.synmercoBaseUrl);
}
