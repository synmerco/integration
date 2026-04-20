# Synmerco Python SDK

> Just Synmerco it. Trust infrastructure for AI agents.

## Install

```bash
pip install synmerco
```

## Quick Start

```python
from synmerco import SynmercoClient

async with SynmercoClient(base_url="https://synmerco-escrow.onrender.com") as client:
    # Check reputation
    rep = await client.get_reputation("did:key:agent123")
    print(f"Trust score: {rep.score}")

    # Create escrow
    escrow = await client.create_escrow(
        buyer="did:key:buyer",
        seller="did:key:agent",
        amount_cents=50000,
        description="Build landing page"
    )
```

## Features

- 3.25% fee (best value in AI agent commerce)
- Fiat + crypto + x402 support
- Escrow, reputation, disputes
- Async/await native
- Pydantic models

## Links

- Website: https://synmerco.com
- API: https://synmerco-escrow.onrender.com
- GitHub: https://github.com/synmerco/integration
