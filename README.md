# SelfHeal MCP

Self-healing proxy for MCP servers. Wraps any MCP tool call with automatic retry, circuit breaker protection, and call observability.

**Your AI agents stop breaking on flaky APIs.**

## Features

- **Retry with backoff** — Exponential backoff + jitter on transient failures (5xx, timeouts, rate limits)
- **Circuit breaker** — Per-target circuit breaker stops hammering dead services
- **Call metrics** — Success rates, latency, error frequency, broken down by tool and target
- **Proxy mode** — Wrap any existing MCP server transparently
- **Zero config** — Works standalone out of the box, config file for proxy mode

## Quick Start

### Standalone Mode

Add to your Claude Desktop / Claude Code config:

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

Then use `wrap_call` to make any HTTP request with self-healing:

```
Use the wrap_call tool to GET https://api.example.com/data with target "example-api"
```

### Proxy Mode

Create `selfheal.config.json`:

```json
{
  "mode": "proxy",
  "targets": [
    {
      "name": "my-server",
      "transport": "streamable-http",
      "url": "https://my-mcp-server.com/mcp"
    }
  ]
}
```

```json
{
  "mcpServers": {
    "selfheal": {
      "command": "npx",
      "args": ["-y", "selfheal-mcp"],
      "env": {
        "SELFHEAL_CONFIG": "/path/to/selfheal.config.json"
      }
    }
  }
}
```

All tools from `my-server` are re-exposed with self-healing built in.

## Tools

| Tool | Description |
|------|-------------|
| `wrap_call` | Execute HTTP call with retry + circuit breaker |
| `circuit_status` | Check health of any target |
| `circuit_reset` | Reset circuit breaker after fixing issues |
| `metrics` | Success rates, latency, top errors |
| `recent_errors` | Recent failures with full details |

### Proxy Mode Adds

| Tool | Description |
|------|-------------|
| `selfheal_metrics` | Metrics for all proxied calls |
| `selfheal_circuits` | Circuit status for all targets |
| `selfheal_recent_errors` | Recent errors across all targets |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SELFHEAL_CONFIG` | `./selfheal.config.json` | Config file path |
| `SELFHEAL_MAX_RETRIES` | `3` | Max retry attempts |
| `SELFHEAL_BASE_DELAY_MS` | `1000` | Base delay for backoff |
| `SELFHEAL_MAX_DELAY_MS` | `30000` | Max delay cap |
| `SELFHEAL_CIRCUIT_THRESHOLD` | `5` | Failures before circuit opens |
| `SELFHEAL_CIRCUIT_COOLDOWN_MS` | `120000` | Cooldown before half-open test |

## How It Works

```
Agent → SelfHeal MCP → [Retry + Circuit Breaker] → Target API/MCP Server
                ↓
          Metrics Collector
```

1. **Request arrives** — Agent calls a tool
2. **Circuit check** — If target has failed too many times, reject immediately
3. **Execute with retry** — Try the call, retry on transient errors with exponential backoff
4. **Record metrics** — Log success/failure, duration, attempts
5. **Update circuit** — Track consecutive failures per target

## License

MIT — Built by [Freedom Engineers](https://freedomengineers.tech)
