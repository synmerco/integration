#!/usr/bin/env node
/**
 * @synmerco/mcp-server
 * MCP server for Synmerco - the trust standard for AI agent commerce.
 *
 * Provides 14 tools for escrow lifecycle, spending limits, collateral staking,
 * reputation, referrals, and platform discovery.
 *
 * Best practices implemented:
 * - Structured error responses (isError: true)
 * - Input validation before API calls
 * - API key never logged or exposed in errors
 * - Descriptive tool descriptions with examples
 * - Timeout handling on all API calls
 * - Rate limit awareness
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://synmerco-escrow.onrender.com";
const TIMEOUT_MS = 30000;

// --- Helpers ---

function sanitizeError(msg) {
  // Never expose API keys in error messages
  return (msg || "Unknown error").replace(/sk_syn_[a-f0-9]+/g, "sk_syn_***");
}

function validateRequired(args, fields) {
  const missing = fields.filter(f => !args[f] && args[f] !== 0);
  if (missing.length > 0) {
    return `Missing required fields: ${missing.join(", ")}`;
  }
  return null;
}

function validateDid(did) {
  if (typeof did !== "string" || did.length < 5) return "Invalid DID format";
  return null;
}

function validateAmount(cents) {
  if (!Number.isInteger(cents)) return "Amount must be a whole number (integer cents)";
  if (cents < 100) return "Minimum amount is 100 cents ($1.00)";
  if (cents > 10000000) return "Maximum amount is 10000000 cents ($100,000)";
  return null;
}

function errorResponse(msg) {
  return { content: [{ type: "text", text: sanitizeError(msg) }], isError: true };
}

function successResponse(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function callAPI(method, path, body, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const opts = { method, headers, signal: controller.signal };
    if (body && method !== "GET") opts.body = JSON.stringify(body);
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, opts);
    const json = await res.json();

    if (!res.ok) {
      const detail = json.detail || json.message || JSON.stringify(json);
      throw new Error(`API ${res.status}: ${detail}`);
    }
    return json;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Request timed out after 30 seconds");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// --- Tool Definitions ---

const TOOLS = [
  {
    name: "synmerco_register_key",
    description: "Register for a Synmerco API key. No signup, no KYC, instant. Returns an API key (sk_syn_...) tied to your DID. Max 10 keys per DID. Example: { ownerDid: 'did:key:z6MkTest123', label: 'my-agent' }",
    inputSchema: {
      type: "object",
      required: ["ownerDid"],
      properties: {
        ownerDid: { type: "string", description: "Your DID identifier (e.g. did:key:z6Mk...)" },
        label: { type: "string", description: "Optional human-readable label for this key" },
      },
    },
  },
  {
    name: "synmerco_create_escrow",
    description: "Create a new escrow with Stripe checkout. Funds are locked until work is verified. Returns escrowId and checkoutUrl. Set evaluatorDid for third-party verification (ERC-8183). Fee: 1.75%. Insurance: $1K. Example: { buyerDid: 'did:key:buyer', sellerDid: 'did:key:seller', amountCents: 5000 }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "buyerDid", "sellerDid", "amountCents"],
      properties: {
        apiKey: { type: "string", description: "Your API key (sk_syn_...)" },
        buyerDid: { type: "string", description: "Buyer's DID" },
        sellerDid: { type: "string", description: "Seller's DID" },
        amountCents: { type: "integer", description: "Amount in cents ($1.00 = 100, max $100,000 = 10000000)" },
        description: { type: "string", description: "What the escrow is for" },
        evaluatorDid: { type: "string", description: "Optional neutral evaluator DID for third-party verification" },
        idempotencyKey: { type: "string", description: "Optional key to prevent duplicate escrows" },
      },
    },
  },
  {
    name: "synmerco_get_escrow",
    description: "Get full details of an escrow: state, amounts, buyer, seller, evaluator, fees, and timestamps. Example: { escrowId: 'esc_abc123' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId"],
      properties: {
        apiKey: { type: "string", description: "Your API key" },
        escrowId: { type: "string", description: "Escrow ID (starts with esc_)" },
      },
    },
  },
  {
    name: "synmerco_list_escrows",
    description: "List escrows, optionally filtered by a DID (shows both buyer and seller escrows). Example: { did: 'did:key:myagent' }",
    inputSchema: {
      type: "object",
      required: ["apiKey"],
      properties: {
        apiKey: { type: "string", description: "Your API key" },
        did: { type: "string", description: "Optional DID to filter by" },
      },
    },
  },
  {
    name: "synmerco_fund_escrow",
    description: "Fund an escrow (buyer only). Moves state from 'draft' to 'funded'. Usually auto-funded via Stripe webhook, but can be called manually. Example: { escrowId: 'esc_abc123' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId"],
      properties: { apiKey: { type: "string" }, escrowId: { type: "string" } },
    },
  },
  {
    name: "synmerco_submit_proof",
    description: "Submit delivery proof (seller only). Moves state to 'submitted'. Buyer then has 72h to release or it auto-releases. Example: { escrowId: 'esc_abc123', proofHash: 'sha256hash', proofUri: 'https://example.com/proof.pdf' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId", "proofHash", "proofUri"],
      properties: {
        apiKey: { type: "string" },
        escrowId: { type: "string" },
        proofHash: { type: "string", description: "SHA-256 hash of proof document" },
        proofUri: { type: "string", description: "URL where proof document is hosted" },
      },
    },
  },
  {
    name: "synmerco_evaluate",
    description: "Third-party evaluator approves or rejects escrow release (ERC-8183). Only works if evaluatorDid was set on creation. Approve = release funds + auto-payout + reputation. Reject = dispute. Example: { escrowId: 'esc_abc123', verdict: 'approve' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId", "verdict"],
      properties: {
        apiKey: { type: "string" },
        escrowId: { type: "string" },
        verdict: { type: "string", enum: ["approve", "reject"], description: "'approve' releases funds, 'reject' creates dispute" },
      },
    },
  },
  {
    name: "synmerco_release",
    description: "Release escrowed funds to seller (buyer only, or evaluator if assigned). Triggers: auto-payout via Stripe Connect, on-chain reputation write to ERC-8004 + SynmercoReputation on 4 chains, referral earnings tracking. Example: { escrowId: 'esc_abc123' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId"],
      properties: { apiKey: { type: "string" }, escrowId: { type: "string" } },
    },
  },
  {
    name: "synmerco_dispute",
    description: "Raise a dispute on an escrow (buyer or seller). Auto-slashes 10% of buyer's collateral if staked (ARS). Dispute reviewed within 48-72h. Example: { escrowId: 'esc_abc123' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "escrowId"],
      properties: { apiKey: { type: "string" }, escrowId: { type: "string" } },
    },
  },
  {
    name: "synmerco_set_spending_limits",
    description: "Set spending caps for an agent (AP2 compatible). Limits auto-enforced on every escrow creation. Set any combination of per-transaction, daily, weekly, monthly. Example: { agentDid: 'did:key:myagent', maxDailyCents: 100000, maxPerTransactionCents: 50000 }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "agentDid"],
      properties: {
        apiKey: { type: "string" },
        agentDid: { type: "string" },
        maxPerTransactionCents: { type: "integer", description: "Max per single escrow" },
        maxDailyCents: { type: "integer", description: "Max total per 24h" },
        maxWeeklyCents: { type: "integer", description: "Max total per 7 days" },
        maxMonthlyCents: { type: "integer", description: "Max total per 30 days" },
      },
    },
  },
  {
    name: "synmerco_get_spending_limits",
    description: "View current spending limits and real-time usage for an agent. Shows remaining budget for each period. Example: { agentDid: 'did:key:myagent' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "agentDid"],
      properties: { apiKey: { type: "string" }, agentDid: { type: "string" } },
    },
  },
  {
    name: "synmerco_stake_collateral",
    description: "Deposit a collateral bond (ARS - Agentic Risk Standard). Higher collateral = higher trust signal. 10% auto-slashed on dispute. Min $1, max $100K. Example: { agentDid: 'did:key:myagent', amountCents: 10000 }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "agentDid", "amountCents"],
      properties: {
        apiKey: { type: "string" },
        agentDid: { type: "string" },
        amountCents: { type: "integer", description: "Bond amount in cents (min 100, max 10000000)" },
      },
    },
  },
  {
    name: "synmerco_get_collateral",
    description: "Check an agent's collateral status: staked amount, slashed amount, available balance, and recent events. Example: { agentDid: 'did:key:myagent' }",
    inputSchema: {
      type: "object",
      required: ["agentDid"],
      properties: { agentDid: { type: "string" } },
    },
  },
  {
    name: "synmerco_register_referral",
    description: "Register as a referrer to earn 0.25% on every escrow completed by agents you refer. Returns a unique referral code (ref_...). No cap on earnings. Auto-tracked. Paid via Stripe. Example: { referrerDid: 'did:key:myagent' }",
    inputSchema: {
      type: "object",
      required: ["apiKey", "referrerDid"],
      properties: { apiKey: { type: "string" }, referrerDid: { type: "string" } },
    },
  },
  {
    name: "synmerco_platform_info",
    description: "Get Synmerco platform overview: fees (1.75%), supported chains (4 live), protocols (12), insurance ($1K per escrow), features, and SDK info. No authentication needed.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- Server Setup ---

const server = new Server(
  {
    name: "synmerco",
    version: "1.0.0",
  },
  {
    capabilities: { tools: {} },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let result;
    let err;

    switch (name) {
      case "synmerco_register_key": {
        err = validateRequired(args, ["ownerDid"]) || validateDid(args.ownerDid);
        if (err) return errorResponse(err);
        result = await callAPI("POST", "/v1/api-keys/register", {
          ownerDid: args.ownerDid,
          label: args.label || "mcp-agent",
        });
        break;
      }

      case "synmerco_create_escrow": {
        err = validateRequired(args, ["apiKey", "buyerDid", "sellerDid", "amountCents"])
          || validateDid(args.buyerDid)
          || validateDid(args.sellerDid)
          || validateAmount(args.amountCents);
        if (err) return errorResponse(err);
        if (args.buyerDid === args.sellerDid) return errorResponse("Buyer and seller cannot be the same");
        const body = {
          buyerDid: args.buyerDid,
          sellerDid: args.sellerDid,
          amountCents: args.amountCents,
        };
        if (args.description) body.description = args.description;
        if (args.evaluatorDid) body.evaluatorDid = args.evaluatorDid;
        if (args.idempotencyKey) body.idempotencyKey = args.idempotencyKey;
        result = await callAPI("POST", "/v1/escrows", body, args.apiKey);
        break;
      }

      case "synmerco_get_escrow": {
        err = validateRequired(args, ["apiKey", "escrowId"]);
        if (err) return errorResponse(err);
        result = await callAPI("GET", `/v1/escrows/${encodeURIComponent(args.escrowId)}`, null, args.apiKey);
        break;
      }

      case "synmerco_list_escrows": {
        err = validateRequired(args, ["apiKey"]);
        if (err) return errorResponse(err);
        const query = args.did ? `?did=${encodeURIComponent(args.did)}` : "";
        result = await callAPI("GET", `/v1/escrows${query}`, null, args.apiKey);
        break;
      }

      case "synmerco_fund_escrow": {
        err = validateRequired(args, ["apiKey", "escrowId"]);
        if (err) return errorResponse(err);
        result = await callAPI("POST", `/v1/escrows/${encodeURIComponent(args.escrowId)}/fund`, {}, args.apiKey);
        break;
      }

      case "synmerco_submit_proof": {
        err = validateRequired(args, ["apiKey", "escrowId", "proofHash", "proofUri"]);
        if (err) return errorResponse(err);
        if (args.proofHash.length < 16) return errorResponse("proofHash should be a valid hash (at least 16 characters)");
        result = await callAPI("POST", `/v1/escrows/${encodeURIComponent(args.escrowId)}/submit-proof`, {
          proofHash: args.proofHash,
          proofUri: args.proofUri,
        }, args.apiKey);
        break;
      }

      case "synmerco_evaluate": {
        err = validateRequired(args, ["apiKey", "escrowId", "verdict"]);
        if (err) return errorResponse(err);
        if (args.verdict !== "approve" && args.verdict !== "reject") {
          return errorResponse("verdict must be 'approve' or 'reject'");
        }
        result = await callAPI("POST", `/v1/escrows/${encodeURIComponent(args.escrowId)}/evaluate`, {
          verdict: args.verdict,
        }, args.apiKey);
        break;
      }

      case "synmerco_release": {
        err = validateRequired(args, ["apiKey", "escrowId"]);
        if (err) return errorResponse(err);
        result = await callAPI("POST", `/v1/escrows/${encodeURIComponent(args.escrowId)}/release`, {}, args.apiKey);
        break;
      }

      case "synmerco_dispute": {
        err = validateRequired(args, ["apiKey", "escrowId"]);
        if (err) return errorResponse(err);
        result = await callAPI("POST", `/v1/escrows/${encodeURIComponent(args.escrowId)}/dispute`, {}, args.apiKey);
        break;
      }

      case "synmerco_set_spending_limits": {
        err = validateRequired(args, ["apiKey", "agentDid"]) || validateDid(args.agentDid);
        if (err) return errorResponse(err);
        const limitsBody = { agentDid: args.agentDid };
        for (const k of ["maxPerTransactionCents", "maxDailyCents", "maxWeeklyCents", "maxMonthlyCents"]) {
          if (args[k] !== undefined) {
            if (!Number.isInteger(args[k]) || args[k] < 0) return errorResponse(`${k} must be a non-negative integer`);
            limitsBody[k] = args[k];
          }
        }
        result = await callAPI("POST", "/v1/spending-limits", limitsBody, args.apiKey);
        break;
      }

      case "synmerco_get_spending_limits": {
        err = validateRequired(args, ["apiKey", "agentDid"]) || validateDid(args.agentDid);
        if (err) return errorResponse(err);
        result = await callAPI("GET", `/v1/spending-limits/${encodeURIComponent(args.agentDid)}`, null, args.apiKey);
        break;
      }

      case "synmerco_stake_collateral": {
        err = validateRequired(args, ["apiKey", "agentDid", "amountCents"])
          || validateDid(args.agentDid)
          || validateAmount(args.amountCents);
        if (err) return errorResponse(err);
        result = await callAPI("POST", "/v1/collateral/stake", {
          agentDid: args.agentDid,
          amountCents: args.amountCents,
        }, args.apiKey);
        break;
      }

      case "synmerco_get_collateral": {
        err = validateRequired(args, ["agentDid"]) || validateDid(args.agentDid);
        if (err) return errorResponse(err);
        result = await callAPI("GET", `/v1/collateral/${encodeURIComponent(args.agentDid)}`);
        break;
      }

      case "synmerco_register_referral": {
        err = validateRequired(args, ["apiKey", "referrerDid"]) || validateDid(args.referrerDid);
        if (err) return errorResponse(err);
        result = await callAPI("POST", "/v1/referrals/register", {
          referrerDid: args.referrerDid,
        }, args.apiKey);
        break;
      }

      case "synmerco_platform_info": {
        result = await callAPI("GET", "/v1/synmerco");
        break;
      }

      default:
        return errorResponse(`Unknown tool: ${name}. Available tools: ${TOOLS.map(t => t.name).join(", ")}`);
    }

    return successResponse(result);
  } catch (error) {
    return errorResponse(error.message || String(error));
  }
});

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Synmerco MCP server fatal error: ${err.message}\n`);
  process.exit(1);
});
