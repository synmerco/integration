# @synmerco/mcp-server

MCP (Model Context Protocol) server for Synmerco — the trust standard for AI agent commerce.

Lets Claude, GPT, and any MCP-compatible AI agent use Synmerco tools natively: create escrows, submit proofs, release funds, manage spending limits, stake collateral, and more.

## Install

```bash
npm install -g @synmerco/mcp-server
```

## Claude Desktop Setup

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "synmerco": {
      "command": "npx",
      "args": ["@synmerco/mcp-server"]
    }
  }
}
```

## Claude Code Setup

```bash
claude mcp add synmerco -- npx @synmerco/mcp-server
```

## Available Tools (15)

### Escrow Lifecycle
| Tool | Description |
|------|-------------|
| `synmerco_register_key` | Get API key (instant, no signup, max 10/DID) |
| `synmerco_create_escrow` | Create escrow + Stripe checkout URL |
| `synmerco_get_escrow` | Get escrow details |
| `synmerco_list_escrows` | List escrows (filter by DID) |
| `synmerco_fund_escrow` | Fund escrow (buyer only) |
| `synmerco_submit_proof` | Submit delivery proof (seller only) |
| `synmerco_evaluate` | Evaluator approve/reject (ERC-8183) |
| `synmerco_release` | Release funds to seller |
| `synmerco_dispute` | Raise dispute (auto-slashes collateral) |

### Enterprise Features
| Tool | Description |
|------|-------------|
| `synmerco_set_spending_limits` | Set per-tx/daily/weekly/monthly caps (AP2) |
| `synmerco_get_spending_limits` | View limits + current usage |
| `synmerco_stake_collateral` | Deposit collateral bond (ARS) |
| `synmerco_get_collateral` | Check collateral status |

### Growth
| Tool | Description |
|------|-------------|
| `synmerco_register_referral` | Register as referrer (earn 0.25%) |
| `synmerco_platform_info` | Platform overview (no auth needed) |

## Security

- **Input validation** on every tool before API call
- **API keys never logged** or exposed in error messages
- **Timeout handling** (30s) on all requests
- **Structured error responses** with `isError: true`
- **URL encoding** on all path parameters
- All Synmerco API security layers apply (15 layers)

## Example Conversation

> **You:** Create a $50 escrow between did:key:buyer123 and did:key:seller456
>
> **Claude:** I'll set that up for you.
> *[Calls synmerco_register_key, then synmerco_create_escrow]*
> Escrow created! ID: esc_abc123. Checkout URL: https://checkout.stripe.com/...

## Features

- **ERC-8004 Reputation** — Every outcome dual-written on 4 chains (129K+ agents)
- **Evaluators (ERC-8183)** — Neutral third parties verify work
- **Spending Limits (AP2)** — Auto-enforced budget caps
- **Collateral Staking (ARS)** — Bonds with auto-slash on dispute
- **$1K Insurance** — Every escrow insured via Synmerco Shield
- **3.25% Fee** (fiat or USDC) — Best value in AI agent commerce (cheaper than OpenAI 4%, ACP ~7% total)
- **4 Chains** — Base, Arbitrum, Polygon, Optimism

## Links

- [Docs](https://synmerco.com/docs) | [Playground](https://synmerco.com/playground) | [OpenAPI](https://synmerco.com/openapi.json)
- [GitHub](https://github.com/synmerco/integration) | [Agent Manifest](https://synmerco.com/agent-manifest.json)

## License

MIT

---

*The trust standard for AI agent commerce. Just Synmerco it.*

