# SelfHeal MCP

[![npm](https://img.shields.io/npm/v/selfheal-mcp)](https://www.npmjs.com/package/selfheal-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCPize](https://img.shields.io/badge/MCPize-Install-0ea5e9)](https://mcpize.com/mcp/selfheal-mcp)

**Agent-native self-healing proxy with x402 outcome-based pricing.**

Agents only pay when errors are successfully healed. Successes are always free. No subscriptions.

```
Agent → SelfHeal → Target API
  ✅ Success → Free pass-through ($0)
  ❌ Failure → x402 payment → LLM analysis → Structured fix + retry payload ($0.001–$0.005 USDC)
```

> **Install:** [MCPize](https://mcpize.com/mcp/selfheal-mcp) | `npx selfheal-mcp` | `npm i selfheal-mcp`

## How It Works

1. **Agent sends request** through SelfHeal proxy
2. **Target succeeds?** → Response passes through instantly. Zero cost.
3. **Target fails?** → SelfHeal returns HTTP 402 with x402 payment spec
4. **Agent pays** (USDC micropayment on Base/Solana via x402)
5. **SelfHeal analyzes** the error with an LLM → returns structured fix + retry payload
6. **Heal succeeds?** → Payment settles. Agent gets fix instructions.
7. **Heal fails?** → Payment is NOT settled. Agent is never charged for failed analysis.

## Quick Start

### As MCP Server (Claude Desktop / Claude Code)

```json
{
  "mcpServers": {
    "selfheal": {
      "command": "npx",
      "args": ["-y", "selfheal-mcp"]
    }
  }
}
```

### As HTTP API (x402 Proxy)

```bash
# Set required env vars
export PORT=3000
export X402_RECEIVING_WALLET=0xYourWalletAddress
export HEAL_LLM_API_KEY=sk-your-openai-key

# Start server
npx selfheal-mcp
```

Server exposes:
- `POST /api/proxy` — Main x402-protected proxy endpoint
- `POST /api/heal` — Direct error analysis endpoint
- `GET /api/pricing` — Current pricing tiers
- `GET /api/usage` — Usage statistics
- `GET /metrics` — Prometheus metrics
- `GET /sse` — MCP over SSE

### Proxy a Request (Agent Example)

```bash
# Step 1: Send request through proxy
curl -X POST https://selfheal.dev/api/proxy \
  -H "Content-Type: application/json" \
  -d '{"url": "https://api.example.com/data", "method": "GET"}'

# If target returns 200 → you get the response (free)
# If target returns error → you get 402 with payment instructions

# Step 2: Pay and retry (after receiving 402)
curl -X POST https://selfheal.dev/api/proxy \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <x402-payment-proof>" \
  -d '{"url": "https://api.example.com/data", "method": "GET"}'

# Returns: structured fix instructions + retry payload
```

### SDK Usage (TypeScript/JavaScript)

```typescript
import { SelfHealClient } from "selfheal-mcp/sdk";

const client = new SelfHealClient({
  baseUrl: "https://selfheal.dev",
  onPaymentRequired: async (info) => {
    // Your x402 payment logic here
    // Return payment proof string, or null to skip
    return await yourWallet.payX402(info.accepts[0]);
  },
});

// Automatic x402 flow: proxy → detect 402 → pay → get heal result
const result = await client.proxy({
  url: "https://api.example.com/users",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "test" }),
});

if (result.healed) {
  console.log("Fix:", result.healResult.fix);
  console.log("Retry with:", result.healResult.retryPayload);
}
```

### LangChain Integration

```typescript
import { createLangChainTool } from "selfheal-mcp/sdk";

const selfhealTool = createLangChainTool({
  baseUrl: "https://selfheal.dev",
  onPaymentRequired: async (info) => yourWallet.payX402(info.accepts[0]),
});

// Add to your LangChain agent's tools
const agent = createAgent({ tools: [selfhealTool, ...otherTools] });
```

## Pricing

**Outcome-based only.** No subscriptions. No monthly fees.

| Tier | Price (USDC) | Error Types |
|------|-------------|-------------|
| **Success** | **$0** | Any 2xx response — always free |
| Simple | $0.001–$0.002 | 400, 404, 405, 422, connection refused |
| Moderate | $0.002–$0.003 | 500, 502, 503, timeouts |
| Complex | $0.003–$0.005 | Rate limits (429), auth errors, permissions |

- **"Exact" scheme**: Fixed price per tier
- **"Upto" scheme**: Variable based on LLM token usage (capped at max)
- **Failed analysis**: Payment is NEVER settled — you're not charged

## x402 Protocol

SelfHeal uses the [x402 payment protocol](https://x402.org) for machine-to-machine micropayments.

When an error occurs, the 402 response includes:

```json
{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base",
      "maxAmountRequired": "1000",
      "resource": "/api/heal",
      "description": "SelfHeal: error analysis + structured fix + retry payload [simple]",
      "payTo": "0x...",
      "extra": { "name": "USDC", "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }
    }
  ],
  "error": "Payment required for error analysis. Tier: simple ($0.001 USDC)."
}
```

Supported networks: **Base** (mainnet + Sepolia testnet), **Solana**

## MCP Tools

### Standalone Mode

| Tool | Description |
|------|-------------|
| `wrap_call` | HTTP call with retry + circuit breaker |
| `circuit_status` | Check target health |
| `circuit_reset` | Reset circuit breaker |
| `metrics` | Success rates, latency, top errors |
| `recent_errors` | Recent failures with details |
| `x402_status` | Payment & heal statistics |

### Proxy Mode (wraps downstream MCP servers)

| Tool | Description |
|------|-------------|
| `selfheal_metrics` | Metrics for all proxied calls |
| `selfheal_circuits` | Circuit status for all targets |
| `selfheal_recent_errors` | Recent errors across targets |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| **Server** | | |
| `PORT` | _(stdio)_ | HTTP port (enables HTTP API + SSE) |
| **x402** | | |
| `X402_RECEIVING_WALLET` | _(required)_ | Your USDC wallet address |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | x402 facilitator URL |
| `X402_NETWORKS` | `base,base-sepolia` | Supported networks |
| `X402_TESTNET` | `true` | Use testnet (`false` for mainnet) |
| `SELFHEAL_DEMO_MODE` | `false` | Bypass x402, run heal for free (first-run trial — no wallet needed) |
| **LLM** | | |
| `HEAL_LLM_API_KEY` | _(required)_ | LLM API key |
| `HEAL_LLM_BASE_URL` | `https://api.openai.com/v1` | LLM API base URL |
| `HEAL_COMPLEX_MODEL` | `gpt-4o-mini` | Model for complex errors |
| `HEAL_SIMPLE_MODEL` | `gpt-4o-mini` | Model for simple errors |
| **Alerts** | | |
| `ALERT_WEBHOOK_URL` | _(optional)_ | Slack/Discord webhook |
| `ALERT_MAX_DAILY_LLM_COST` | `10` | Daily LLM cost alert ($) |
| `ALERT_MIN_HEAL_SUCCESS_RATE` | `0.9` | Min success rate alert |

See [.env.example](.env.example) for the full list.

## Monitoring

### Prometheus Metrics (`GET /metrics`)

```
selfheal_proxy_requests_total
selfheal_proxy_successes_total
selfheal_heal_requests_total
selfheal_heal_successes_total
selfheal_x402_payments_total
selfheal_x402_revenue_usdc_total
selfheal_proxy_latency_ms_bucket
selfheal_heal_latency_ms_bucket
selfheal_llm_tokens_total
```

### Alerts

Configure `ALERT_WEBHOOK_URL` for automatic alerts:
- Traffic spike (>5x baseline)
- LLM cost exceeds daily limit
- Heal success rate drops below threshold

Alert webhook payload:

```json
{
  "severity": "warning",
  "type": "traffic_spike",
  "message": "Traffic spike detected: 500 req/min vs 100 baseline",
  "value": 500,
  "threshold": 500,
  "timestamp": "2026-04-14T12:00:00Z",
  "service": "selfheal-mcp"
}
```

## Deployment

### Railway / Fly.io / Any Docker Host

```bash
PORT=3000 \
X402_RECEIVING_WALLET=0x... \
HEAL_LLM_API_KEY=sk-... \
node dist/index.js
```

### MCPize (Managed Hosting)

One-click install: **[Install on MCPize](https://mcpize.com/mcp/selfheal-mcp)**

### Vercel / Cloudflare Workers

The HTTP server works behind any reverse proxy. Set `PORT` and the server auto-scales with the platform.

### Testnet vs Mainnet

- **Testnet** (default): `X402_TESTNET=true`, `X402_NETWORKS=base-sepolia`
- **Mainnet**: `X402_TESTNET=false`, `X402_NETWORKS=base,solana`

## Heal Response Example

When an error is successfully healed, the response includes:

```json
{
  "healed": true,
  "settled": true,
  "txHash": "0xabc123...",
  "result": {
    "success": true,
    "category": "auth_error",
    "diagnosis": "Missing Authorization header. The API requires a Bearer token.",
    "fix": {
      "problem": "Request lacks authentication credentials",
      "steps": [
        "Add Authorization header with Bearer token",
        "Ensure token is valid and not expired"
      ],
      "changes": [
        {
          "target": "headers",
          "action": "add",
          "key": "Authorization",
          "value": "Bearer <your-token>",
          "description": "Add Bearer token authentication"
        }
      ]
    },
    "retryPayload": {
      "url": "https://api.example.com/data",
      "method": "GET",
      "headers": {
        "Authorization": "Bearer <your-token>",
        "Content-Type": "application/json"
      }
    },
    "retriable": true,
    "confidence": 0.95
  }
}
```

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │          SelfHeal MCP Server         │
                    │                                     │
  Agent ─── POST ──►│  /api/proxy                          │
                    │    │                                │
                    │    ├─ Forward to target              │
                    │    │    ├─ 2xx → Free pass-through   │
                    │    │    └─ Error → 402 (x402 spec)   │
                    │    │                                │
                    │    ├─ X-PAYMENT header?              │
                    │    │    ├─ Verify via facilitator    │
                    │    │    ├─ Run LLM heal analysis     │
                    │    │    ├─ Success → Settle payment  │
                    │    │    └─ Failure → Don't settle    │
                    │    │                                │
  MCP ──── SSE ────►│  /sse (MCP tools)                   │
                    │                                     │
  Prometheus ──────►│  /metrics                           │
                    └─────────────────────────────────────┘
```

## Migration from Subscriptions

SelfHeal has moved to **pure outcome-based pricing**. There are no monthly plans.

- **Free tier users**: No change — success pass-throughs remain free
- **Pro/Agency subscribers**: Contact us for migration. x402 pricing is cheaper for most usage patterns.
- **Dashboard**: Read-only dashboard remains free at selfheal.dev

## License

MIT — Built by [Freedom Engineers](https://freedomengineers.tech)
