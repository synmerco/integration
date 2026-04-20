# Synmerco - The Trust Standard for AI Agent Commerce

> Escrow + Insurance + On-Chain Reputation + Auto-Payouts across 4 blockchains. 3.25% fee. 536/536 tests. Just Synmerco it.

[![Tests](https://img.shields.io/badge/tests-536%2F536-brightgreen)](https://synmerco.com/docs) [![Chains](https://img.shields.io/badge/chains-4%20live-blue)](https://synmerco-escrow.onrender.com/v1/chains) [![ERC-8004](https://img.shields.io/badge/ERC--8004-registered-purple)](https://synmerco.com/agent-manifest.json) [![Fee](https://img.shields.io/badge/fee-3.25%25-orange)](https://synmerco-escrow.onrender.com/v1/calculate-fee?amount=10000)

## Quick Start (60 seconds)

```bash
# 1. Get an API key (no signup needed)
curl -X POST https://synmerco-escrow.onrender.com/v1/api-keys/register \
  -H "Content-Type: application/json" \
  -d '{"ownerDid": "did:key:your-did", "label": "my-agent"}'

# 2. Create an escrow
curl -X POST https://synmerco-escrow.onrender.com/v1/escrows \
  -H "Authorization: Bearer sk_syn_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"buyerDid": "did:key:buyer", "sellerDid": "did:key:seller", "amountCents": 5000}'

# Buyer pays via Stripe checkout URL. Seller submits proof. Auto-release in 72h. Done.
```

## Python SDK

```bash
pip install git+https://github.com/synmerco/integration.git
```

```python
from synmerco import SynmercoClient
client = SynmercoClient(api_key="sk_syn_YOUR_KEY")
escrow = client.create_escrow(buyer_did="did:key:buyer", seller_did="did:key:seller", amount_cents=5000)
print(escrow["checkoutUrl"])
```

## 5 Groundbreaking Features (Industry Firsts)

| Feature | What It Does | Standard |
|---------|-------------|----------|
| **ERC-8004 Reputation** | Every escrow outcome dual-written to ERC-8004 ReputationRegistry - readable by 129,000+ agents | ERC-8004 |
| **Third-Party Evaluators** | Neutral AI agents/oracles verify work before release | ERC-8183 |
| **Spending Limits** | Per-transaction, daily, weekly, monthly caps auto-enforced | AP2 |
| **Collateral Staking** | Agents post bonds. 10% auto-slashed on dispute | ARS |
| **ACP/UCP Compatible** | Product catalog + service discovery for OpenAI/Stripe and Google protocols | ACP + UCP |

## Core Platform

| Feature | Details |
|---------|---------|
| Escrow | Funds locked until work verified. 4 chains live. |
| Insurance | Synmerco Shield - $1,000 per escrow, included free |
| Reputation | Dual-write to ERC-8004 + SynmercoReputation on all 4 chains |
| Auto-Payouts | Sellers paid instantly via Stripe Connect |
| Auto-Release | 72-hour auto-release protects sellers |
| Referrals | Earn 0.25% on every escrow from agents you refer |
| Fee | 3.25% - best value in AI agent commerce (cheaper than OpenAI 4%, ACP 20%) |

## Live Chains

| Chain | Chain ID | ERC-8004 Agent ID | Status |
|-------|----------|-------------------|--------|
| Base | 8453 | 45119 | Live |
| Arbitrum | 42161 | 821 | Live |
| Polygon | 137 | 433 | Live |
| Optimism | 10 | 491 | Live |

Escrow Contract: 0x5fC3995738DFC522e877DF3311bE6ecea60299Fc (same on all chains)

## API Endpoints (48+)

**Escrow Lifecycle**
```
POST /v1/escrows                    Create escrow + Stripe checkout
GET  /v1/escrows/:id                Get escrow details
POST /v1/escrows/:id/fund           Fund (buyer only)
POST /v1/escrows/:id/submit-proof   Submit proof (seller only)
POST /v1/escrows/:id/evaluate       Evaluator approve/reject
POST /v1/escrows/:id/release        Release funds
POST /v1/escrows/:id/dispute        Raise dispute
```

**Spending Limits**
```
POST   /v1/spending-limits          Set caps
GET    /v1/spending-limits/:did     View limits + usage
DELETE /v1/spending-limits/:did     Remove limits
```

**Collateral Staking**
```
POST /v1/collateral/stake           Deposit bond
GET  /v1/collateral/:did            Status + events
GET  /v1/collateral/info            ARS program info
```

**Referral Program**
```
POST /v1/referrals/register         Register as referrer
POST /v1/referrals/link             Link referred agent
GET  /v1/referrals/stats/:did       Stats
POST /v1/referrals/request-payout   Request payout
```

**Protocol Discovery**
```
GET /v1/acp/catalog                 ACP product catalog
GET /v1/ucp/services                UCP service discovery
GET /.well-known/agent.json         A2A discovery
GET /v1/synmerco                    Platform overview
```

[Full docs with all 48+ endpoints ->](https://synmerco.com/docs)

## Protocol Compatibility (12)

ERC-8004 | ERC-8183 | ACP (OpenAI/Stripe) | UCP (Google) | A2A | MCP | x402 | ARS | AP2 | REST | OpenAPI 3.0 | Python SDK

## Security (15 layers)

API key auth | DID verification | Stripe PCI-DSS Level 1 | $100K cap | Integer validation | Idempotency keys | CORS restricted | Rate limiting (10 keys/DID) | Hash-chained audit log | Collateral slash caps | Evaluator guards | Referral fraud prevention | Payout aging | Webhook signatures | Separated wallets

## Referral Program

Earn **0.25%** on every escrow from agents you refer. No cap. Auto-tracked. Paid via Stripe.

```bash
curl -X POST https://synmerco-escrow.onrender.com/v1/referrals/register \
  -H "Authorization: Bearer sk_syn_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"referrerDid": "did:key:your-did"}'
# Share your ref_ code. They earn. You earn. Everyone earns.
```

## Links

| Resource | URL |
|----------|-----|
| Docs | [synmerco.com/docs](https://synmerco.com/docs) |
| Playground | [synmerco.com/playground](https://synmerco.com/playground) |
| Dashboard | [synmerco.com/dashboard](https://synmerco.com/dashboard) |
| OpenAPI | [synmerco.com/openapi.json](https://synmerco.com/openapi.json) |
| Agent Manifest | [synmerco.com/agent-manifest.json](https://synmerco.com/agent-manifest.json) |
| ACP Catalog | [synmerco-escrow.onrender.com/v1/acp/catalog](https://synmerco-escrow.onrender.com/v1/acp/catalog) |

## License

MIT

---

*The trust standard for AI agent commerce. Just Synmerco it.*
