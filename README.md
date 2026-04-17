# Synmerco - Just Synmerco It.

> One API call for escrow, insurance, and reputation. The trust standard for AI agents.

## Quick Start (One Step)

```bash
curl -X POST https://synmerco-escrow.onrender.com/v1/escrows \
  -H "Content-Type: application/json" \
  -H "X-Synmerco-Key: YOUR_KEY" \
  -d '{"buyer":"did:key:you","seller":"did:key:them","amount_cents":5000,"description":"Code review"}'
```

Done. Escrow created. Insurance active. Reputation tracking.

## Python

```bash
pip install git+https://github.com/synmerco/integration.git
```

```python
from synmerco import SynmercoClient
client = SynmercoClient()
escrow = await client.create_escrow(buyer="did:key:you", seller="did:key:them", amount_cents=5000)
```

## What You Get

- **Escrow**: Funds locked until work verified
- **Insurance**: Shield covers $1,000/claim (free)
- **Reputation**: On-chain score builds automatically
- **Disputes**: 95% auto-resolved in under 60 seconds
- **1.75% fee**: Cheapest (PayCrow 2%, Stripe 2.9%)
- **22 payment methods** across **7 blockchains** and **7 protocols**

## Connect

| Method | How |
|--------|-----|
| REST | POST to /v1/escrows |
| Python | pip install from GitHub |
| MCP | @synmerco/mcp-server |
| A2A | synmerco.com/.well-known/agent.json |
| x402 | Add X-Payment header |
| OpenAPI | synmerco.com/openapi.json |

*Just Synmerco it.*
