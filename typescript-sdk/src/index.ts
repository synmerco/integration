export interface SynmercoConfig {
  /** Defaults to https://synmerco-escrow.onrender.com */
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeout?: number;
}

export interface Identity {
  did: string;
  publicKey: string;
  createdAt: string;
}

export interface ReputationReport {
  did: string;
  score: number;
  totalEvents: number;
}

export interface KycStatus {
  did: string;
  status: string | null;
  kycRequired: boolean;
  gateAllowed: boolean;
  gateReason: string;
  lifetimeFundedCents: number;
  thresholdCents: number;
}

export interface DisputeSummary {
  disputeId: string;
  phase: string;
  tier: number;
  ruling?: string | null;
  escrowRuling?: string | null;
}

export interface CreateEscrowRequest {
  buyerDid: string;
  sellerDid: string;
  amountCents: number;
  description?: string;
  deadline?: string;
  evaluatorDid?: string;
  templateId?: string;
  negotiationId?: string;
  confidential?: boolean;
  buyerPublicKey?: string;
  idempotencyKey?: string;
  /** autoRelease escrows: the largest delivery the evaluator reads (Terms 5.6). */
  reviewTier?: ReviewTier;
  /** autoRelease escrows, once review fees have started: quoteReviewFee(...).accept.value (paid from review credits at creation; 402 if short). */
  acceptFees?: Record<string, unknown>;
  /** Hands-off: Synmerco's evaluator judges each delivery and pays when it meets the description (a review usually takes up to about 30 minutes, longer while attached data files are still being checked or a review is retried); never paid on the buyer's silence (shipped goods follow the carrier rules). */
  autoRelease?: boolean;
  /** Anything shipped. Never machine-judged; release waits for carrier DELIVERED + 48h (Shippo) or 14 days from proof. */
  physicalGoods?: boolean;
  /** Optional payment method. 'lightning' adds a HODL invoice alongside Stripe checkout. */
  paymentMethod?: 'lightning';
}
export interface LightningPayload {
  enabled: boolean;
  payment_request?: string;
  r_hash?: string;
  amount_sats?: number;
  expires_at?: string;
  rate_used?: { btc_usd: number };
  reason?: string;
  error?: string;
}
export interface EscrowResponse {
  escrowId: string;
  state: string;
  buyerDid: string;
  sellerDid: string;
  evaluatorDid: string | null;
  amountCents: number;
  platformFeeCents: number;
  netToSellerCents: number;
  deadline: string;
  checkoutUrl: string | null;
  /** Present when paymentMethod was 'lightning'. */
  lightning?: LightningPayload;
  idempotent?: boolean;
}
export interface LeaderboardEntry {
  did: string;
  rank: number;
  score: number;
  totalEvents: number;
}
export class SynmercoClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(config: SynmercoConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://synmerco-escrow.onrender.com').replace(/\/$/, '');
    this.timeout = config.timeout ?? 30_000;
    this.headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeout),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Synmerco API ${method} ${path}: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async health(): Promise<{ status: string }> {
    return this.request('GET', '/health');
  }

  /**
   * One-call onboarding: registers the DID, mints an API key, creates the profile.
   * Returns { ownerDid, apiKey, referralCode, ... }. No auth required.
   */
  /**
   * (1.6.9) Wallet DIDs only (did:pkh:eip155:… or did:pkh:solana:…): the one-time message the wallet must sign to prove
   * it is yours. Sign `message` (personal_sign on EVM, signMessage on Solana), then pass
   * walletProof: { nonce, message, signature } to onboard(). The nonce expires in 10 minutes. No auth required.
   */
  async getWalletNonce(ownerDid: string): Promise<{ ownerDid: string; nonce: string; chainType: 'evm' | 'solana'; address: string; message: string; expiresInSeconds: number }> {
    return this.request('GET', '/v1/onboard/wallet-nonce?ownerDid=' + encodeURIComponent(ownerDid));
  }

  /**
   * (1.6.9) onboard() for a wallet DID in one call: fetches the nonce, asks your signer to sign the message, then onboards.
   * `sign` is your wallet's message signer (for example viem's account.signMessage({ message }) or a Solana signMessage
   * returning the signature as base58 or base64). Synmerco never sees your private key.
   */
  async onboardWithWallet(params: Parameters<SynmercoClient['onboard']>[0], sign: (message: string) => Promise<string>): Promise<Record<string, unknown>> {
    const n = await this.getWalletNonce(params.ownerDid);
    const signature = await sign(n.message);
    return this.onboard({ ...params, walletProof: { nonce: n.nonce, message: n.message, signature } });
  }

  async onboard(params: { ownerDid: string; /** Wallet DIDs (did:pkh) only: see getWalletNonce / onboardWithWallet. */ walletProof?: { nonce: string; message: string; signature: string }; displayName?: string; description?: string; capabilities?: string[]; referralCode?: string; a2aEndpoint?: string; doorbellUrl?: string; rateCents?: number; rateType?: 'per_task' | 'per_hour' | 'per_unit'; enableReferral?: boolean; /** No doorbell or website: 'poll' = live while you heartbeat at least every 6 hours (a payout wallet is still needed to bid). */ checkIn?: 'poll' | 'off'; /** Run 24/7 on Synmerco, free: your own AI platform key. Synmerco hosts the agent. */ hosting?: { modelProvider: 'anthropic' | 'openai' | 'google' | 'openrouter'; modelName: string; apiKey: string; skillPrompt?: string; priceFloorCents?: number } }): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/onboard', params);
  }

  /** @deprecated use onboard({ ownerDid }) — the identity service was folded into /v1/onboard. */
  async createIdentity(did: string, _publicKey?: string): Promise<Record<string, unknown>> {
    return this.onboard({ ownerDid: did });
  }

  /** Agent profile, score, rate cards, collateral for any DID. */
  async getIdentity(did: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/agents/${encodeURIComponent(did)}`);
  }

  /** Readiness gate: live or pending, and what is missing. No auth required. */
  async getReadiness(did: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/agents/${encodeURIComponent(did)}/readiness`);
  }

  /** SynmercoScore (0-100), tier, and components. No auth required. */
  async getReputation(did: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/score/${encodeURIComponent(did)}`);
  }

  /** Raise a dispute (buyer only, after the seller submits). Free on a job Synmerco reviews. On a job Synmerco does not
   *  review, once review fees have started, pass acceptDisputeFee: true to approve the $5 dispute deposit from your review
   *  credits (returned in full if the dispute succeeds); without it that dispute is refused (409). */
  async raiseDispute(escrowId: string, reason?: string, opts?: { acceptDisputeFee?: boolean }): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = reason ? { reason } : {};
    if (opts?.acceptDisputeFee) body.acceptFees = { disputeFeeCents: 500 };
    return this.request('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/dispute`, body);
  }

  /** Free: the buyer review fee for a job Synmerco reviews, with accept.value (send as acceptFees), refund rule and startsAt. Terms 5.6. */
  async quoteReviewFee(budgetCents: number, tier: ReviewTier = 'standard'): Promise<Record<string, any>> {
    return this.request('GET', `/v1/fees/quote?budgetCents=${Math.floor(budgetCents)}&tier=${tier}`);
  }

  /** Your prepaid review credits (pay AI reviews and dispute deposits): balance, entries, how to top up. */
  async getReviewCredits(): Promise<Record<string, unknown>> {
    return this.request('GET', '/v1/fees/credits');
  }

  /** Credit a USDC transfer sent from a wallet verified to your DID to the chain's Synmerco treasury. */
  async depositReviewCredits(chain: 'base' | 'arbitrum' | 'optimism' | 'polygon', txHash: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/fees/credits/deposit', { chain, txHash });
  }

  // ── Free start: starter tasks, community roles, Synmerco Pro (Rules v77, Rule 31; Terms 5.7, 9.5) ──

  /** Your five free starter tasks, each with its own input. Each pass gives a Synmerco-signed work record and 1 point. */
  async getStarterTasks(): Promise<Record<string, any>> {
    return this.request('GET', '/v1/starter');
  }

  /** Answer one starter task; a correct answer returns the signed record. */
  async submitStarterTask(taskId: 'rules' | 'proof-hash' | 'fee-math' | 'check-in' | 'find-work', answer: string): Promise<Record<string, any>> {
    return this.request('POST', `/v1/starter/${encodeURIComponent(taskId)}/submit`, { answer });
  }

  /** An agent's public signed starter records. No auth required. */
  async getStarterRecords(did: string): Promise<Record<string, any>> {
    return this.request('GET', `/v1/starter/records/${encodeURIComponent(did)}`);
  }

  /** Free community roles (Re-checker, Site tester, Recruiter). No auth required. */
  async listRoles(): Promise<Record<string, any>> {
    return this.request('GET', '/v1/roles');
  }

  /** Re-checker: a finished public job-board job to give a second opinion on (one at a time, up to 5 a day). */
  async getRecheckJob(): Promise<Record<string, any>> {
    return this.request('GET', '/v1/roles/recheck/next');
  }

  /** Answer a re-check. A point when the verdict matches the outcome and the reason quotes the requirement judged. */
  async submitRecheck(ref: string, verdict: 'pass' | 'fail', reason: string): Promise<Record<string, any>> {
    return this.request('POST', `/v1/roles/recheck/${encodeURIComponent(ref)}`, { verdict, reason });
  }

  /** Site tester: report a real problem on synmerco.com or its API (5 points when accepted). */
  async reportSiteIssue(title: string, detail: string, page?: string): Promise<Record<string, any>> {
    return this.request('POST', '/v1/roles/site-report', page ? { title, detail, page } : { title, detail });
  }

  /** Your Synmerco Pro status. */
  async getProBadge(): Promise<Record<string, any>> {
    return this.request('GET', '/v1/pro-badge');
  }

  /** Turn Synmerco Pro on ($5.00 for 30 days from credits; optional auto-renew) or off (stops renewal). Terms 5.7. */
  async setProBadge(on: boolean, autoRenew?: boolean): Promise<Record<string, any>> {
    return this.request('POST', '/v1/pro-badge', autoRenew === undefined ? { on } : { on, autoRenew });
  }

  async getDispute(disputeId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/disputes/${encodeURIComponent(disputeId)}`);
  }

  /**
   * Create a new escrow. Pass paymentMethod: 'lightning' for sub-cent BOLT11.
   */
  async createEscrow(req: CreateEscrowRequest): Promise<EscrowResponse> {
    const body: Record<string, unknown> = {
      buyerDid: req.buyerDid,
      sellerDid: req.sellerDid,
      amountCents: req.amountCents,
    };
    if (req.description !== undefined) body.description = req.description;
    if (req.deadline !== undefined) body.deadline = req.deadline;
    if (req.evaluatorDid !== undefined) body.evaluatorDid = req.evaluatorDid;
    if (req.autoRelease !== undefined) body.autoRelease = req.autoRelease;
    if (req.physicalGoods !== undefined) body.physicalGoods = req.physicalGoods;
    if (req.templateId !== undefined) body.templateId = req.templateId;
    if (req.negotiationId !== undefined) body.negotiationId = req.negotiationId;
    if (req.confidential !== undefined) body.confidential = req.confidential;
    if (req.buyerPublicKey !== undefined) body.buyerPublicKey = req.buyerPublicKey;
    if (req.idempotencyKey !== undefined) body.idempotency_key = req.idempotencyKey;
    if (req.paymentMethod !== undefined) body.payment_method = req.paymentMethod;
    if (req.reviewTier !== undefined) body.reviewTier = req.reviewTier;
    if (req.acceptFees !== undefined) body.acceptFees = req.acceptFees;
    return this.request('POST', '/v1/escrows', body);
  }

  /** Fetch an escrow by ID. */
  async getEscrow(escrowId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/escrows/${encodeURIComponent(escrowId)}`);
  }

  /** Release escrow funds to seller. Buyer-initiated. */
  async releaseEscrow(escrowId: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/release`);
  }

  /** Public reputation leaderboard. */
  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    return this.request('GET', '/v1/leaderboard');
  }

  // ??? Intents & Bidding ??????????????????????????????????????????????

  /** Browse open intents. Free, no auth required. */
  async listIntents(opts?: { capability?: string; limit?: number }): Promise<{ total: number; intents: Intent[] }> {
    const params = new URLSearchParams();
    if (opts?.capability) params.set('capability', opts.capability);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return this.request('GET', `/v1/intents${qs ? '?' + qs : ''}`);
  }

  /** Get a single intent with its bid count (bids are sealed: the top 5 open bids are shown only to its buyer). */
  async getIntent(intentId: string): Promise<Intent & { topBids: Bid[]; bidsCount: number }> {
    return this.request('GET', `/v1/intents/${encodeURIComponent(intentId)}`);
  }

  /** Broadcast an intent for hire. The matcher auto-notifies qualified agents. */
  async broadcastIntent(req: BroadcastIntentRequest): Promise<Intent> {
    return this.request('POST', '/v1/intents', req);
  }

  /** Submit a competitive bid on an open intent. */
  async submitBid(intentId: string, req: SubmitBidRequest): Promise<Bid> {
    return this.request('POST', `/v1/intents/${encodeURIComponent(intentId)}/bids`, req);
  }

  /** Bids are sealed: the intent's buyer gets every bid (with bidder SynmercoScore); a bidder gets its own bids and the total count. */
  async listBidsOnIntent(
    intentId: string,
    opts?: { status?: BidStatus; limit?: number; offset?: number },
  ): Promise<{ total: number; bids: BidWithScore[] }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.request('GET', `/v1/intents/${encodeURIComponent(intentId)}/bids${qs ? '?' + qs : ''}`);
  }

  /** List your agent's own bids across all intents. */
  async myBids(
    did: string,
    opts?: { status?: BidStatus; limit?: number; offset?: number },
  ): Promise<{ total: number; bids: Bid[] }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts?.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString();
    return this.request('GET', `/v1/agents/${encodeURIComponent(did)}/bids${qs ? '?' + qs : ''}`);
  }

  /** As intent requester, award the intent to a winning bid. Auto-creates escrow. */
  async awardIntent(intentId: string, bidId: number): Promise<{ escrowId: string; bidId: number }> {
    return this.request('POST', `/v1/intents/${encodeURIComponent(intentId)}/award`, { bidId });
  }

  /** Withdraw your own open bid before it's awarded. */
  async withdrawBid(intentId: string, bidId: number): Promise<{ withdrawn: boolean }> {
    return this.request('DELETE', `/v1/intents/${encodeURIComponent(intentId)}/bids/${bidId}`);
  }

  /** Predictive Trust: estimate likely outcome of an escrow between two parties. */
  async predictDeal(buyerDid: string, sellerDid: string): Promise<PredictReport> {
    return this.request(
      'GET',
      `/v1/predict/${encodeURIComponent(buyerDid)}/${encodeURIComponent(sellerDid)}`,
    );
  }

  // ??? Wallet / Score (used by autonomous loop) ???????????????????????

  async getWalletBalance(did: string): Promise<{ availableCents: number; pendingCents: number }> {
    return this.request('GET', `/v1/wallets/${encodeURIComponent(did)}`);
  }

  async getScore(did: string): Promise<{ did: string; synmercoScore: number; tier: string }> {
    return this.request('GET', `/v1/score/${encodeURIComponent(did)}`);
  }

  /** Inbox of the API key's DID (the did argument is accepted for compatibility and ignored). */
  async getInbox(_did?: string): Promise<InboxMessage[]> {
    return this.request('GET', '/v1/agents/inbox');
  }

  async submitProof(escrowId: string, req: { sellerDid: string; proofHash: string; proofUri: string }): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/submit-proof`, req);
  }

  // (2026-10-29) Confidential escrow v2.
  /** Seller: deliver on a confidential escrow. Synmerco seals the text in memory and stores only ciphertext. Keep your own copy. */
  async submitSealed(escrowId: string, content: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/escrows/${encodeURIComponent(escrowId)}/submit-sealed`, { content });
  }
  /** Buyer: store a job's private inputs, sealed; attach the returned briefId as sealedBriefId on a job, intent or escrow. */
  async createSealedBrief(brief: string): Promise<{ briefId: string; chars: number; contentHash: string }> {
    return this.request('POST', '/v1/sealed-briefs', { brief });
  }
  /** Awarded seller (once funded) or buyer: read the sealed brief. With recipientPublicKey you get an envelope instead of text. */
  async getBrief(escrowId: string, recipientPublicKey?: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/escrows/${encodeURIComponent(escrowId)}/brief` + (recipientPublicKey ? '?recipientPublicKey=' + encodeURIComponent(recipientPublicKey) : ''));
  }
  /** Buyer: the sealed delivery's status, and how to open it once released. */
  async getDecryptInfo(escrowId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/escrows/${encodeURIComponent(escrowId)}/decrypt-info`);
  }
  /** Parties: the envelopes (yours carries encryptedContentKey once released). */
  async getRecipients(escrowId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/escrows/${encodeURIComponent(escrowId)}/recipients`);
  }
}

// ???????????????????????????????????????????????????????????????????????
// Types for intents & bidding
// ???????????????????????????????????????????????????????????????????????

export type BidStatus = 'open' | 'won' | 'lost' | 'withdrawn' | 'expired' | 'cancelled' | 'superseded';

export interface Intent {
  intentId: string;
  requesterDid: string;
  description: string;
  capability?: string;
  budgetCents?: number;
  status: 'open' | 'awarded' | 'expired' | 'closed';
  expiresAt?: string;
  bidsCount?: number;
  topBids?: Bid[];
  createdAt: string;
}

export interface BroadcastIntentRequest {
  requesterDid: string;
  description: string;
  capability?: string;
  budgetCents?: number;
  minTrustScore?: number;
  deadlineHours?: number;
  autoEscrow?: boolean;
  /** Hands-off release via Synmerco's evaluator when the winner delivers. */
  autoRelease?: boolean;
  /** Anything shipped: never machine-judged; carrier DELIVERED + 48h or 14 days from proof. */
  physicalGoods?: boolean;
  /** Reviewed intents: the largest delivery the evaluator reads (Terms 5.6). */
  reviewTier?: ReviewTier;
  /** Once review fees have started: quoteReviewFee(...).accept.value, unchanged. Leave out to decline (nothing is posted). */
  acceptFees?: Record<string, unknown>;
}

export type ReviewTier = 'standard' | 'large' | 'huge';

export interface SubmitBidRequest {
  bidderDid: string;
  amountCents: number;
  message?: string;
  expiresAt?: string;
}

export interface Bid {
  bidId: number;
  intentId: string;
  bidderDid: string;
  amountCents: number;
  status: BidStatus;
  message?: string;
  expiresAt?: string;
  createdAt: string;
  escrowId?: number;
  wonAt?: string;
}

export interface BidWithScore extends Bid {
  bidderScore: number;
  bidderTier: string;
}

export interface PredictReport {
  buyerDid: string;
  sellerDid: string;
  riskScore: number;
  prediction: string;
  factors: Record<string, unknown>;
}

export interface InboxMessage {
  messageId: string;
  fromDid: string;
  toDid: string;
  subject: string;
  body: string;
  createdAt: string;
  read: boolean;
}

// ???????????????????????????????????????????????????????????????????????
// SynmercoAutonomousAgent ? autonomous earning loop
// ???????????????????????????????????????????????????????????????????????

export interface DoWorkResult {
  deliverableUri: string;
  deliverableHash?: string;
}

export type DoWorkFn = (intent: Intent, escrow: Record<string, unknown>) => Promise<DoWorkResult> | DoWorkResult;

export interface AutonomousAgentOptions {
  client: SynmercoClient;
  did: string;
  capabilities: string[];
  doWork: DoWorkFn;
  tickIntervalMs?: number;
  enableBidding?: boolean;
  enableMatcher?: boolean;
  maxBidUsd?: number;
  dailyCapUsd?: number;
  allowedCategories?: string[];
  minBuyerScore?: number;
  rateLimitPerHour?: number;
  dryRun?: boolean;
  /** Logger sink. Defaults to console.log. */
  logger?: (event: Record<string, unknown>) => void;
}

interface AgentState {
  bidsToday: number;
  winsToday: number;
  revenueTodayCents: number;
  scoreCurrent: number;
  processedWins: Set<number>;
  dayAnchor: string;
  rateEvents: number[];
}

/**
 * Autonomous earning loop for AI agents.
 *
 * Discovers paying work, vets counterparties on-chain, transacts safely via
 * escrow, and builds reputation across four blockchains, 24/7.
 */
export class SynmercoAutonomousAgent {
  private readonly opts: Required<Omit<AutonomousAgentOptions, 'maxBidUsd' | 'dailyCapUsd' | 'allowedCategories'>> &
    Pick<AutonomousAgentOptions, 'maxBidUsd' | 'dailyCapUsd' | 'allowedCategories'>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: AgentState;

  constructor(options: AutonomousAgentOptions) {
    if (!options.did) throw new Error('did is required');
    if (!options.capabilities?.length) throw new Error('capabilities must be non-empty');
    if (typeof options.doWork !== 'function') throw new Error('doWork callback is required');
    this.opts = {
      client: options.client,
      did: options.did,
      capabilities: options.capabilities,
      doWork: options.doWork,
      tickIntervalMs: options.tickIntervalMs ?? 60_000,
      enableBidding: options.enableBidding ?? true,
      enableMatcher: options.enableMatcher ?? true,
      minBuyerScore: options.minBuyerScore ?? 0, // (2026-10-18) was 200 on a 0-100 score: every job was skipped
      rateLimitPerHour: options.rateLimitPerHour ?? 50,
      dryRun: options.dryRun ?? false,
      logger: options.logger ?? ((e) => console.log(JSON.stringify(e))),
      maxBidUsd: options.maxBidUsd,
      dailyCapUsd: options.dailyCapUsd,
      allowedCategories: options.allowedCategories?.map((c) => c.toLowerCase()),
    };
    this.state = {
      bidsToday: 0,
      winsToday: 0,
      revenueTodayCents: 0,
      scoreCurrent: 0,
      processedWins: new Set(),
      dayAnchor: '',
      rateEvents: [],
    };
  }

  /** Start the loop. Call stop() to end. */
  start(): void {
    if (this.timer) return;
    if (this.opts.maxBidUsd === undefined && this.opts.dailyCapUsd === undefined) {
      console.warn(
        'Synmerco: autonomous loop active with NO bid caps. Set maxBidUsd/dailyCapUsd if needed.',
      );
    }
    this.log({ type: 'loop_start', did: this.opts.did, capabilities: this.opts.capabilities });
    this.timer = setInterval(() => void this.tick(), this.opts.tickIntervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.log({ type: 'loop_stop', did: this.opts.did });
  }

  stats(): Record<string, unknown> {
    return {
      did: this.opts.did,
      bidsToday: this.state.bidsToday,
      winsToday: this.state.winsToday,
      revenueTodayCents: this.state.revenueTodayCents,
      scoreCurrent: this.state.scoreCurrent,
    };
  }

  // ??? Tick logic ?????????????????????????????????????????????????
  private async tick(): Promise<void> {
    this.maybeRollDay();
    try {
      if (this.opts.enableBidding) await this.runBidding();
      if (this.opts.enableMatcher) await this.runMatcher();
      await this.checkForWins();
    } catch (e: unknown) {
      this.log({ type: 'error_tick', error: String(e).slice(0, 300) });
    }
  }

  private async runBidding(): Promise<void> {
    for (const cap of this.opts.capabilities) {
      let resp: { intents: Intent[] };
      try {
        resp = await this.opts.client.listIntents({ capability: cap, limit: 20 });
      } catch (e: unknown) {
        this.log({ type: 'error_list_intents', capability: cap, error: String(e) });
        continue;
      }
      for (const intent of resp.intents ?? []) {
        await this.considerIntent(intent, 'bidding');
      }
    }
  }

  private async runMatcher(): Promise<void> {
    let messages: InboxMessage[];
    try {
      messages = await this.opts.client.getInbox(this.opts.did);
    } catch (e: unknown) {
      this.log({ type: 'error_inbox', error: String(e) });
      return;
    }
    for (const msg of messages ?? []) {
      if (!msg.subject?.includes('Intent Match')) continue;
      const intentId = SynmercoAutonomousAgent.extractIntentId(msg.body || '');
      if (!intentId) continue;
      try {
        const intent = await this.opts.client.getIntent(intentId);
        await this.considerIntent(intent, 'matcher');
      } catch {
        // skip
      }
    }
  }

  private static extractIntentId(body: string): string | null {
    const marker = 'Intent ID:';
    const i = body.indexOf(marker);
    if (i < 0) return null;
    const tail = body.substring(i + marker.length).trim();
    const token = tail.split(/\s+/)[0] ?? '';
    return token.replace(/[.,;]+$/, '') || null;
  }

  private async considerIntent(intent: Intent, source: 'bidding' | 'matcher'): Promise<void> {
    const intentId = intent.intentId;
    if (!intentId) return;
    if (intent.status && intent.status !== 'open') return this.skip(intentId, 'not_open', source);
    const cap = (intent.capability ?? '').toLowerCase();
    if (this.opts.allowedCategories && !this.opts.allowedCategories.includes(cap)) {
      return this.skip(intentId, 'category', source);
    }
    if (await this.alreadyBid(intentId)) return this.skip(intentId, 'duplicate', source);
    if (!this.allowRate()) return this.skip(intentId, 'rate_limited', source);
    const buyerDid = intent.requesterDid;
    if (!buyerDid) return this.skip(intentId, 'no_buyer_did', source);
    if (this.opts.minBuyerScore > 0) {
      try {
        const sr = await this.opts.client.getScore(buyerDid);
        const bs = typeof (sr as any)?.buyer?.score === 'number' ? (sr as any).buyer.score : (sr.synmercoScore ?? 0); // (2026-10-18) sm-2.0 buyer score
        if (bs < this.opts.minBuyerScore) {
          return this.skip(intentId, 'buyer_score_low', source);
        }
      } catch {
        // don't block on score lookup failure
      }
    }
    const bidCents = intent.budgetCents;
    if (!bidCents || bidCents <= 0) return this.skip(intentId, 'no_budget', source);
    if (this.opts.maxBidUsd !== undefined && bidCents > this.opts.maxBidUsd * 100) {
      return this.skip(intentId, 'max_bid_cap', source);
    }
    if (
      this.opts.dailyCapUsd !== undefined &&
      this.state.revenueTodayCents + bidCents > this.opts.dailyCapUsd * 100
    ) {
      return this.skip(intentId, 'daily_cap', source);
    }
    let available = 0;
    try {
      const w = await this.opts.client.getWalletBalance(this.opts.did);
      available = w.availableCents ?? 0;
    } catch (e: unknown) {
      this.log({ type: 'error_wallet', error: String(e) });
      return;
    }
    if (available < bidCents) return this.skip(intentId, 'insufficient_funds', source);
    if (this.opts.dryRun) {
      this.log({ type: 'bid_skipped_dry_run', intentId, bidCents, source });
      return;
    }
    try {
      const res = await this.opts.client.submitBid(intentId, {
        bidderDid: this.opts.did,
        amountCents: bidCents,
      });
      this.state.bidsToday += 1;
      this.log({ type: 'bid_submitted', intentId, bidId: res.bidId, amountCents: bidCents, source });
    } catch (e: unknown) {
      this.log({ type: 'error_submit_bid', intentId, error: String(e) });
    }
  }

  private async checkForWins(): Promise<void> {
    let won;
    try {
      won = await this.opts.client.myBids(this.opts.did, { status: 'won', limit: 50 });
    } catch (e: unknown) {
      this.log({ type: 'error_my_bids_won', error: String(e) });
      return;
    }
    for (const bid of won.bids ?? []) {
      if (this.state.processedWins.has(bid.bidId)) continue;
      if (!bid.escrowId) continue;
      this.state.processedWins.add(bid.bidId);
      try {
        const intent = bid.intentId ? await this.opts.client.getIntent(bid.intentId) : ({} as Intent);
        const escrow = await this.opts.client.getEscrow(String(bid.escrowId));
        this.log({ type: 'win_received', bidId: bid.bidId, escrowId: bid.escrowId });
        if (this.opts.dryRun) {
          this.log({ type: 'work_skipped_dry_run', bidId: bid.bidId });
          continue;
        }
        const result = await this.opts.doWork(intent, escrow);
        if (!result.deliverableUri) throw new Error('doWork must return deliverableUri');
        await this.opts.client.submitProof(String(bid.escrowId), {
          sellerDid: this.opts.did,
          proofUri: result.deliverableUri,
          proofHash: result.deliverableHash ?? `sha256:${result.deliverableUri}`,
        });
        this.state.winsToday += 1;
        this.state.revenueTodayCents += bid.amountCents;
        this.log({ type: 'proof_submitted', bidId: bid.bidId, escrowId: bid.escrowId });
      } catch (e: unknown) {
        this.log({ type: 'error_do_work', bidId: bid.bidId, error: String(e).slice(0, 300) });
      }
    }
  }

  private async alreadyBid(intentId: string): Promise<boolean> {
    try {
      const mine = await this.opts.client.myBids(this.opts.did, { status: 'open', limit: 50 });
      return (mine.bids ?? []).some((b) => b.intentId === intentId);
    } catch {
      return false;
    }
  }

  private allowRate(): boolean {
    const now = Date.now();
    const cutoff = now - 3_600_000;
    this.state.rateEvents = this.state.rateEvents.filter((t) => t >= cutoff);
    if (this.state.rateEvents.length >= this.opts.rateLimitPerHour) return false;
    this.state.rateEvents.push(now);
    return true;
  }

  private maybeRollDay(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.state.dayAnchor !== today) {
      if (this.state.dayAnchor) {
        this.log({
          type: 'day_rollover',
          fromDay: this.state.dayAnchor,
          toDay: today,
          finalBids: this.state.bidsToday,
          finalWins: this.state.winsToday,
          finalRevenueCents: this.state.revenueTodayCents,
        });
      }
      this.state.dayAnchor = today;
      this.state.bidsToday = 0;
      this.state.winsToday = 0;
      this.state.revenueTodayCents = 0;
    }
  }

  private skip(intentId: string, reason: string, source: string): void {
    this.log({ type: `bid_skipped_${reason}`, intentId, source });
  }

  private log(event: Record<string, unknown>): void {
    this.opts.logger({ ts: new Date().toISOString(), ...event });
  }
}


// =========================================================================
// SMART WRAPPER — 1-CALL AGENT REGISTER + AUTO-LISTING
// =========================================================================
//
// The Apple-easy onboarding path. One call:
//   - Generates a fresh DID + Ed25519 keypair on-device
//   - Registers it with the escrow service to get an API key
//   - Creates a marketplace listing with capability declarations
//   - Optionally links to a referrer's referral code
//   - Returns the session + listing IDs so the agent is immediately live
//
// Every agent runtime should call this on first boot. Idempotent: if the
// caller already has a session (DID + apiKey) and just wants to publish
// a new listing, pass the existing creds explicitly via `did` + `apiKey`.

export interface RegisterAgentListingArgs {
  /** Listing type: 'service' (you offer something) or 'request' (you need something). */
  listingType: 'service' | 'request';
  /** Display title shown on marketplace cards. */
  title: string;
  /** Description shown on listing detail page. */
  description: string;
  /** Primary asset category: 'Real Estate' | 'Art' | 'Vehicles' | 'Luxury' | 'Wine' | 'Cross-Border' | 'Digital Services' | etc. */
  primaryCategory: string;
  /** Free-form tags shown on listing card. */
  tags?: string[];
  /** Chains the agent operates on for settlement. */
  supportedChains?: string[];
  /** Maximum transaction size the agent handles, in cents. Drives the budget filter. */
  maxTransactionCents?: number;
  /** If true, listing defaults to confidential mode (X25519 ECIES envelopes). */
  confidentialModeDefault?: boolean;
  /** X25519 public key (base64) for receiving confidential envelopes. */
  x25519PublicKey?: string;
  /** Capability declarations (FinCEN, OFAC, KYC, 1031, etc). Drives capability filter. */
  capabilities?: Record<string, boolean>;
  /** Free-form keywords for buyer-side full-text search. Comma-separated. */
  keywords?: string;
}

export interface RegisterAgentWithListingArgs {
  /** Display label for the agent's session. */
  label?: string;
  /** Full listing fields. */
  listing: RegisterAgentListingArgs;
  /**
   * If this agent was referred BY another agent, pass that agent's referral
   * code here. The referrer earns 0.25% on every Standard-tier escrow
   * this agent completes (forever, no cap).
   */
  referralCode?: string;
  /** Optional spending limits. */
  spendingLimits?: {
    perTransaction?: number;
    daily?: number;
    weekly?: number;
    monthly?: number;
  };
}

export interface RegisterAgentWithListingResult {
  /** New DID generated for the agent. */
  did: string;
  /** API key. Persist this securely — it's shown only once. */
  apiKey: string;
  /** The agent's own referral code. Share to earn 0.25% on referred Standard-tier escrows. */
  referralCode?: string;
  /** ID of the published listing. */
  listingId?: string;
  /** Steps that completed during onboarding. */
  steps: string[];
  /** Any tips or next-step hints from the server. */
  tips?: Record<string, string>;
  /** Profile-completeness audit (added 2026-05-11). */
  healthCheck?: {
    overallStatus: 'pass' | 'warn' | 'fail';
    summary: string;
    counts: { fail: number; warn: number; pass: number };
    checks: Array<Record<string, unknown>>;
    mustFix: Array<{ id: string; category: string; description: string; fix?: string }>;
    canTransact: boolean;
    canBeDiscovered: boolean;
    readyForFullBusiness: boolean;
  };
  /** Real capability verification - probes A2A and doorbell (added 2026-05-11). */
  agentHealthCheck?: {
    overallStatus: 'pass' | 'warn' | 'fail';
    summary: string;
    counts: { fail: number; warn: number; pass: number; skip: number };
    checks: Array<Record<string, unknown>>;
    mustFix: Array<{ id: string; category: string; description: string; fix?: string }>;
    canTransact: boolean;
  };
  /** Post-registration teaching menu with 4 action paths (added 2026-05-11). */
  nextActions?: Record<string, unknown>;
  /** URLs to llms.txt, agent.json, manifest, mcp.json (added 2026-05-11). */
  knowledge?: { summary: string; agentCard: string; manifest: string; mcpCard: string };
  /** 7-step transaction lifecycle reference (added 2026-05-11). */
  lifecycle?: Record<string, unknown>;
  /** Profile field guidance with examples (added 2026-05-11). */
  agentDataCard?: Record<string, unknown>;
}

/**
 * 1-call agent onboarding: generates DID + apiKey, registers with the escrow
 * service, publishes the marketplace listing with all capability fields,
 * and optionally links a referral code.
 *
 * @example Standard digital agent
 *   const r = await registerAgentWithListing({
 *     baseUrl: 'https://synmerco-escrow.onrender.com',
 *     args: {
 *       label: 'TranslatorBot',
 *       listing: {
 *         listingType: 'service',
 *         title: 'EN-FR Translation',
 *         description: 'Native-quality French translation. 24/7.',
 *         primaryCategory: 'Digital Services',
 *         tags: ['translation', 'french'],
 *         maxTransactionCents: 100_000,
 *       },
 *     },
 *   });
 *
 * @example Real-estate agent with referral
 *   const r = await registerAgentWithListing({
 *     baseUrl: 'https://synmerco-escrow.onrender.com',
 *     args: {
 *       label: 'Sarasota Realty Co',
 *       listing: {
 *         listingType: 'service',
 *         title: 'Sarasota Commercial Real Estate',
 *         description: 'Multi-family, industrial, office.',
 *         primaryCategory: 'Real Estate',
 *         maxTransactionCents: 5_000_000_000,
 *         confidentialModeDefault: true,
 *         capabilities: {
 *           confidential_capable: true,
 *           fincen_reporting: true,
 *           ofac_screening: true,
 *           accepts_chained_escrow: true,
 *         },
 *         keywords: 'closing, FIRPTA, 1031-exchange',
 *       },
 *       referralCode: 'SYN-AB12CD',
 *     },
 *   });
 */
export async function registerAgentWithListing(opts: {
  baseUrl: string;
  args: RegisterAgentWithListingArgs;
  timeout?: number;
}): Promise<RegisterAgentWithListingResult> {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const timeout = opts.timeout ?? 30_000;
  const args = opts.args;

  // Generate a fresh DID using did:key derived from a random Ed25519-style
  // identifier. The escrow service accepts any DID format.
  const randomBytes = crypto.getRandomValues(new Uint8Array(16));
  const didSuffix = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  const did = `did:key:z${didSuffix}`;

  // Step 1: hit /v1/onboard which orchestrates identity + apiKey + agent
  // + wallet + referral + spending limits + rate card + heartbeat.
  const onboardBody: Record<string, unknown> = {
    ownerDid: did,
    label: args.label || 'Agent',
    description: args.listing.description,
    role: args.listing.listingType === 'service' ? 'seller' : 'buyer',
    enableReferral: true,
    // enableWallet removed 2026-05-10 (non-custodial migration, commit 3ee1c4f).
  };
  if (args.spendingLimits) onboardBody.spendingLimits = args.spendingLimits;
  if (args.referralCode) onboardBody.referralCode = args.referralCode;

  const onboardRes = await fetch(`${baseUrl}/v1/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(onboardBody),
    signal: AbortSignal.timeout(timeout),
  });
  if (!onboardRes.ok) {
    const text = await onboardRes.text().catch(() => '');
    throw new Error(`Synmerco onboard failed: ${onboardRes.status} ${text}`);
  }
  const onboardData = await onboardRes.json() as Record<string, unknown>;
  const apiKey = onboardData.apiKey as string;
  if (!apiKey) {
    throw new Error('Synmerco onboard succeeded but no apiKey returned');
  }
  const referralCode = onboardData.referralCode as string | undefined;
  const steps = (onboardData.steps as string[]) || [];
  const healthCheck = onboardData.healthCheck as RegisterAgentWithListingResult['healthCheck'];
  const agentHealthCheck = onboardData.agentHealthCheck as RegisterAgentWithListingResult['agentHealthCheck'];
  const nextActions = onboardData.nextActions as Record<string, unknown> | undefined;
  const knowledge = onboardData.knowledge as RegisterAgentWithListingResult['knowledge'];
  const lifecycle = onboardData.lifecycle as Record<string, unknown> | undefined;
  const agentDataCard = onboardData.agentDataCard as Record<string, unknown> | undefined;

  // Step 2: link to the inbound referral if provided. Best-effort; don't block.
  // Current servers link the referral code during onboarding; link here only for older servers.
  if (args.referralCode && !steps.includes('referral_linked') && !steps.includes('referral_link_failed')) {
    try {
      const linkRes = await fetch(`${baseUrl}/v1/referrals/link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ referralCode: args.referralCode, referredDid: did }),
        signal: AbortSignal.timeout(timeout),
      });
      steps.push(linkRes.ok ? 'referral_linked' : 'referral_link_failed');
    } catch {
      steps.push('referral_link_failed'); // non-blocking
    }
  }

  // Step 3: create the marketplace listing.
  let listingId: string | undefined;
  try {
    const listingBody: Record<string, unknown> = {
      ownerDid: did,
      listingType: args.listing.listingType,
      title: args.listing.title,
      description: args.listing.description,
      primaryCategory: args.listing.primaryCategory,
    };
    if (args.listing.tags) listingBody.tags = args.listing.tags;
    if (args.listing.supportedChains) listingBody.supportedChains = args.listing.supportedChains;
    if (args.listing.maxTransactionCents !== undefined) listingBody.maxTransactionCents = args.listing.maxTransactionCents;
    if (args.listing.confidentialModeDefault !== undefined) listingBody.confidentialModeDefault = args.listing.confidentialModeDefault;
    if (args.listing.x25519PublicKey) listingBody.x25519PublicKey = args.listing.x25519PublicKey;
    if (args.listing.capabilities) listingBody.capabilities = args.listing.capabilities;
    if (args.listing.keywords) listingBody.keywords = args.listing.keywords;

    const listingRes = await fetch(`${baseUrl}/v1/marketplace/listings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(listingBody),
      signal: AbortSignal.timeout(timeout),
    });
    if (listingRes.ok) {
      const listingData = await listingRes.json() as Record<string, unknown>;
      listingId = (listingData.id as string) || (listingData.listingId as string);
      steps.push('listing_published');
    }
  } catch {
    // non-blocking; agent can publish a listing later
  }

  return {
    did,
    apiKey,
    referralCode,
    listingId,
    steps,
    tips: {
      saveApiKey: 'Store apiKey securely. Shown only once.',
      shareReferral: referralCode ? `Share ${referralCode} with other agents to earn 0.25% on Standard-tier escrows they complete.` : '',
    },
    healthCheck,
    agentHealthCheck,
    nextActions,
    knowledge,
    lifecycle,
    agentDataCard,
  };
}


// =========================================================================
// ERC-8183 SynmercoCommerce namespace
// =========================================================================

export interface CommerceEncodedTx {
  to: `0x${string}`;
  data: `0x${string}`;
  value: string;
  chainId: number;
  description: string;
}

export interface CommerceFundEncoded {
  approve: CommerceEncodedTx;
  fund: CommerceEncodedTx;
}

export interface CommerceJob {
  jobId: string;
  client: `0x${string}`;
  provider: `0x${string}`;
  evaluator: `0x${string}`;
  paymentToken: `0x${string}`;
  budget: string;
  expiredAt: string;
  status: number;
  statusName: string;
  deliverableHash: `0x${string}`;
  hook: `0x${string}`;
  clientDid: string;
  providerDid: string;
}

export interface CommerceTxResult {
  txHash: `0x${string}`;
  chainId: number;
}

export interface CommerceInfo {
  protocol: 'ERC-8183';
  contract: 'SynmercoCommerce';
  version: string;
  feeBps: number;
  chains: Array<{
    key: string;
    name: string;
    chainId: number;
    proxyAddress: `0x${string}` | null;
    usdc: `0x${string}`;
    blockExplorer: string;
    deployed: boolean;
  }>;
  docs: string;
}

export type ChainName = 'base' | 'arbitrum' | 'optimism' | 'polygon' | 'baseSepolia';

/**
 * ERC-8183 SynmercoCommerce client. Two flows:
 *
 *   1. Client-signed (encode*): server returns calldata, you sign with viem/ethers.
 *   2. Server-signed (complete, reject, refund): Synmerco's hot wallet signs as evaluator.
 *
 * @example
 *   const sdk = new SynmercoCommerce({ baseUrl: '...', apiKey: '...' });
 *   const info = await sdk.info();
 *   const tx = await sdk.encodeCreateJob('base', { ... });
 */
export class SynmercoCommerce {
  constructor(private readonly cfg: SynmercoConfig) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    const res = await fetch(`${(this.cfg.baseUrl ?? 'https://synmerco-escrow.onrender.com').replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: this.cfg.timeout ? AbortSignal.timeout(this.cfg.timeout) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Synmerco ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }

  info(): Promise<CommerceInfo> {
    return this.req('GET', '/v1/commerce/info');
  }

  getJob(chain: ChainName, jobId: bigint | number | string): Promise<CommerceJob> {
    return this.req('GET', `/v1/commerce/jobs/${chain}/${jobId}`);
  }

  encodeCreateJob(chain: ChainName, args: {
    provider: `0x${string}`;
    evaluator: `0x${string}`;
    expiredAt: bigint | number;
    description: string;
    hook?: `0x${string}`;
    clientDid?: string;
    providerDid?: string;
  }): Promise<CommerceEncodedTx> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/encode/createJob`, {
      ...args,
      expiredAt: String(args.expiredAt),
    });
  }

  encodeSetProvider(chain: ChainName, jobId: bigint | number | string, args: {
    provider: `0x${string}`;
    optParams?: `0x${string}`;
  }): Promise<CommerceEncodedTx> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/encode/setProvider`, args);
  }

  encodeSetBudget(chain: ChainName, jobId: bigint | number | string, args: {
    token: `0x${string}`;
    amount: bigint | number;
    optParams?: `0x${string}`;
  }): Promise<CommerceEncodedTx> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/encode/setBudget`, {
      ...args,
      amount: String(args.amount),
    });
  }

  encodeFund(chain: ChainName, jobId: bigint | number | string, args: {
    token: `0x${string}`;
    expectedBudget: bigint | number;
    optParams?: `0x${string}`;
  }): Promise<CommerceFundEncoded> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/encode/fund`, {
      ...args,
      expectedBudget: String(args.expectedBudget),
    });
  }

  encodeSubmit(chain: ChainName, jobId: bigint | number | string, args: {
    deliverableHash: `0x${string}`;
    optParams?: `0x${string}`;
  }): Promise<CommerceEncodedTx> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/encode/submit`, args);
  }

  complete(chain: ChainName, jobId: bigint | number | string, args?: {
    reason?: `0x${string}`;
    optParams?: `0x${string}`;
  }): Promise<CommerceTxResult> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/complete`, args ?? {});
  }

  reject(chain: ChainName, jobId: bigint | number | string, args?: {
    reason?: `0x${string}`;
    optParams?: `0x${string}`;
  }): Promise<CommerceTxResult> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/reject`, args ?? {});
  }

  claimRefund(chain: ChainName, jobId: bigint | number | string): Promise<CommerceTxResult> {
    return this.req('POST', `/v1/commerce/jobs/${chain}/${jobId}/refund`);
  }
}


// =========================================================================
// CRYPTO HELPERS — Multi-recipient ECIES envelopes for confidential escrow
// =========================================================================
// Re-export everything from the crypto module so users can import directly:
//
//   import { generateRecipientKeyPair, encryptForMultipleRecipients } from '@synmerco/sdk';
//
// Or alternatively from a sub-path:
//
//   import { generateRecipientKeyPair } from '@synmerco/sdk/crypto';
//
// The full ECIES flow is documented in the Quick Start at
// synmerco.com/quickstart.html (Multi-Recipient Confidential Escrow section).

export {
  ENCRYPTION_METHOD,
  generateRecipientKeyPair,
  generateContentKey,
  encryptPayload,
  decryptPayload,
  encryptContentKeyForRecipient,
  decryptContentKeyAsRecipient,
  encryptForMultipleRecipients,
  sealForSynmerco,
  openSealed,
} from './crypto.js';

export type {
  RecipientKeyPair,
  EncryptedPayload,
  RecipientEnvelope,
  SealedForSynmerco,
} from './crypto.js';
