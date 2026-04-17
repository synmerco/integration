export interface SynmercoConfig {
  readonly baseUrl: string;
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

export class SynmercoClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;

  constructor(config: SynmercoConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
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

  async createIdentity(did: string, publicKey: string): Promise<Identity> {
    return this.request('POST', '/v1/identities', { did, publicKey });
  }

  async getIdentity(did: string): Promise<Identity> {
    return this.request('GET', `/v1/identities/${encodeURIComponent(did)}`);
  }

  async getReputation(did: string): Promise<ReputationReport> {
    return this.request('GET', `/v1/reputation/${encodeURIComponent(did)}`);
  }

  async getKycStatus(did: string): Promise<KycStatus> {
    return this.request('GET', `/v1/kyc/status?did=${encodeURIComponent(did)}`);
  }

  async createKycSession(did: string): Promise<Record<string, unknown>> {
    return this.request('POST', '/v1/kyc/sessions', { did });
  }

  async raiseDispute(escrowId: string, raisedBy: string, respondent: string, reason: string): Promise<DisputeSummary> {
    return this.request('POST', '/v1/disputes', { escrowId, raisedBy, respondent, reason });
  }

  async getDispute(disputeId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/disputes/${encodeURIComponent(disputeId)}`);
  }

  async submitEvidence(disputeId: string, actor: string, evidenceHash: string, evidenceUri: string): Promise<Record<string, unknown>> {
    return this.request('POST', `/v1/disputes/${encodeURIComponent(disputeId)}/evidence`, {
      actor, evidenceHash, evidenceUri,
    });
  }

  async disputeAction(disputeId: string, action: string, extra?: Record<string, unknown>): Promise<DisputeSummary> {
    return this.request('POST', `/v1/disputes/${encodeURIComponent(disputeId)}/action`, {
      action, ...extra,
    });
  }
}
