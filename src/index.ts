#!/usr/bin/env node

/**
 * SelfHeal MCP Server
 *
 * A self-healing proxy for MCP servers. Wraps any MCP tool call with:
 * - Retry with exponential backoff + jitter
 * - Per-target circuit breaker
 * - Call metrics and observability
 * - Fallback chains (call target B if target A fails)
 *
 * Modes:
 *   1. Standalone — exposes its own tools (wrap_call, metrics, circuit status)
 *   2. Proxy — connects to downstream MCP servers, re-exposes their tools with healing
 *
 * Config via env vars or selfheal.config.json in cwd.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "http";
import { z } from "zod";
import { CircuitBreaker } from "./circuit-breaker.js";
import { withRetry } from "./retry.js";
import { MetricsCollector } from "./metrics.js";
import { SelfHealProxy, type TargetServer } from "./proxy.js";
import { readFileSync } from "fs";
import { join } from "path";

// --- Config ---
interface Config {
  mode: "standalone" | "proxy";
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitThreshold: number;
  circuitCooldownMs: number;
  targets: TargetServer[];
}

function loadConfig(): Config {
  const defaults: Config = {
    mode: "standalone",
    maxRetries: parseInt(process.env.SELFHEAL_MAX_RETRIES ?? "3"),
    baseDelayMs: parseInt(process.env.SELFHEAL_BASE_DELAY_MS ?? "1000"),
    maxDelayMs: parseInt(process.env.SELFHEAL_MAX_DELAY_MS ?? "30000"),
    circuitThreshold: parseInt(process.env.SELFHEAL_CIRCUIT_THRESHOLD ?? "5"),
    circuitCooldownMs: parseInt(process.env.SELFHEAL_CIRCUIT_COOLDOWN_MS ?? "120000"),
    targets: [],
  };

  // Try loading config file
  try {
    const configPath = process.env.SELFHEAL_CONFIG ?? join(process.cwd(), "selfheal.config.json");
    const raw = readFileSync(configPath, "utf-8");
    const file = JSON.parse(raw);
    return { ...defaults, ...file };
  } catch {
    return defaults;
  }
}

// --- Server ---
async function main() {
  const config = loadConfig();
  const breaker = new CircuitBreaker(config.circuitThreshold, config.circuitCooldownMs);
  const metrics = new MetricsCollector();

  const server = new McpServer(
    { name: "selfheal-mcp", version: "0.1.0" },
    {
      instructions: [
        "SelfHeal wraps MCP tool calls with automatic retry, circuit breaker, and observability.",
        "",
        "STANDALONE MODE: Use `wrap_call` to execute any function with self-healing.",
        "Use `circuit_status` to check health of targets.",
        "Use `metrics` to see call success rates, latency, and top errors.",
        "",
        "PROXY MODE: All downstream tools are re-exposed with self-healing built in.",
        "Use `selfheal_metrics` and `selfheal_circuits` for observability.",
      ].join("\n"),
      capabilities: { logging: {} },
    },
  );

  // --- Proxy mode: connect to downstream servers and re-expose tools ---
  if (config.mode === "proxy" && config.targets.length > 0) {
    const proxy = new SelfHealProxy({
      targets: config.targets,
      retry: {
        maxRetries: config.maxRetries,
        baseDelayMs: config.baseDelayMs,
        maxDelayMs: config.maxDelayMs,
      },
      circuitThreshold: config.circuitThreshold,
      circuitCooldownMs: config.circuitCooldownMs,
    });

    await proxy.connect();
    const tools = await proxy.listAllTools();

    // Re-register each downstream tool with healing
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: `[SelfHeal] ${tool.description ?? tool.name}`,
          inputSchema: z.object({}).passthrough(),
          annotations: { readOnlyHint: false, idempotentHint: true },
        },
        async (args: Record<string, unknown>) => {
          const result = await proxy.callTool(tool.name, args);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        },
      );
    }

    // Observability tools for proxy mode
    server.registerTool(
      "selfheal_metrics",
      {
        description: "Get SelfHeal proxy metrics — success rates, latency, top errors",
        inputSchema: z.object({
          windowMinutes: z.number().optional().describe("Time window in minutes (default: 60)"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ windowMinutes }) => {
        const windowMs = (windowMinutes ?? 60) * 60_000;
        const summary = proxy.metrics.getSummary(windowMs);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
        };
      },
    );

    server.registerTool(
      "selfheal_circuits",
      {
        description: "Get circuit breaker status for all proxied targets",
        annotations: { readOnlyHint: true },
      },
      async () => {
        const statuses = proxy.breaker.getAllStatuses();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(statuses, null, 2) }],
        };
      },
    );

    server.registerTool(
      "selfheal_recent_errors",
      {
        description: "Get recent failed tool calls with error details",
        inputSchema: z.object({
          limit: z.number().optional().describe("Number of errors to return (default: 20)"),
        }),
        annotations: { readOnlyHint: true },
      },
      async ({ limit }) => {
        const errors = proxy.metrics.getRecentErrors(limit ?? 20);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(errors, null, 2) }],
        };
      },
    );
  }

  // --- Standalone mode tools (always registered) ---

  server.registerTool(
    "wrap_call",
    {
      title: "Self-Healing Function Call",
      description:
        "Execute a function call with retry, circuit breaker, and metrics. " +
        "Pass a target name and the function will be retried on transient failures. " +
        "Use this to wrap any unreliable external call.",
      inputSchema: z.object({
        target: z.string().describe("Identifier for the target service (used for circuit breaker tracking)"),
        description: z.string().describe("Human-readable description of what this call does"),
        url: z.string().optional().describe("URL to call (for HTTP targets)"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional().describe("HTTP method (default: GET)"),
        headers: z.record(z.string()).optional().describe("HTTP headers"),
        body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
        timeoutMs: z.number().optional().describe("Timeout per attempt in ms (default: 30000)"),
      }),
    },
    async ({ target, description, url, method, headers, body, timeoutMs }) => {
      // Circuit breaker check
      if (!breaker.canRequest(target)) {
        const status = breaker.getStatus(target);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error: `Circuit breaker OPEN for "${target}". ${Math.round(status.cooldownRemaining / 1000)}s until next attempt.`,
                circuitState: status.state,
                suggestion: "The target has failed too many times. Wait for the cooldown or check the service health.",
              }, null, 2),
            },
          ],
        };
      }

      if (!url) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "No URL provided" }, null, 2),
            },
          ],
        };
      }

      const start = Date.now();
      const timeout = timeoutMs ?? 30_000;

      const result = await withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);

          try {
            const resp = await fetch(url, {
              method: method ?? "GET",
              headers: headers ?? {},
              body: body ?? undefined,
              signal: controller.signal,
            });

            if (!resp.ok && resp.status >= 500) {
              throw new Error(`${resp.status} ${resp.statusText}`);
            }
            if (resp.status === 429) {
              throw new Error("429 rate_limit");
            }

            const contentType = resp.headers.get("content-type") ?? "";
            const text = await resp.text();

            return {
              status: resp.status,
              contentType,
              body: text.length > 50_000 ? text.slice(0, 50_000) + "\n...[truncated]" : text,
            };
          } finally {
            clearTimeout(timer);
          }
        },
        {
          maxRetries: config.maxRetries,
          baseDelayMs: config.baseDelayMs,
          maxDelayMs: config.maxDelayMs,
        },
      );

      const durationMs = Date.now() - start;

      if (result.success) {
        breaker.recordSuccess(target);
      } else {
        breaker.recordFailure(target);
      }

      metrics.record({
        tool: "wrap_call",
        target,
        success: result.success,
        durationMs,
        attempts: result.attempts,
        error: result.error,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: result.success,
                description,
                target,
                result: result.result,
                error: result.error,
                attempts: result.attempts,
                durationMs,
                retryLog: result.retryLog,
                circuitState: breaker.getStatus(target).state,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "circuit_status",
    {
      title: "Circuit Breaker Status",
      description: "Check the health status of a target. Returns circuit state, failure count, and cooldown.",
      inputSchema: z.object({
        target: z.string().optional().describe("Target to check. Omit to see all targets."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ target }) => {
      const result = target
        ? breaker.getStatus(target)
        : breaker.getAllStatuses();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "circuit_reset",
    {
      title: "Reset Circuit Breaker",
      description: "Reset a circuit breaker back to closed (healthy). Use after fixing the underlying issue.",
      inputSchema: z.object({
        target: z.string().optional().describe("Target to reset. Omit to reset all."),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ target }) => {
      if (target) {
        breaker.reset(target);
      } else {
        breaker.resetAll();
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: target ? `Circuit for "${target}" reset` : "All circuits reset",
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "metrics",
    {
      title: "Call Metrics",
      description:
        "Get observability metrics — success rates, latency, top errors, breakdown by tool and target.",
      inputSchema: z.object({
        windowMinutes: z.number().optional().describe("Time window in minutes (default: 60)"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ windowMinutes }) => {
      const windowMs = (windowMinutes ?? 60) * 60_000;
      const summary = metrics.getSummary(windowMs);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    "recent_errors",
    {
      title: "Recent Errors",
      description: "Get the most recent failed calls with full error details and retry logs.",
      inputSchema: z.object({
        limit: z.number().optional().describe("Number of errors to return (default: 20)"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const errors = metrics.getRecentErrors(limit ?? 20);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errors, null, 2) }],
      };
    },
  );

  // --- Start server ---
  const port = process.env.PORT ? parseInt(process.env.PORT) : undefined;
  if (port) {
    // SSE mode for cloud deployments (MCPize, etc.)
    const transports: Record<string, SSEServerTransport> = {};
    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        transports[transport.sessionId] = transport;
        transport.onclose = () => { delete transports[transport.sessionId]; };
        await server.connect(transport);
        await transport.start();
      } else if (url.pathname === "/messages" && req.method === "POST") {
        const sessionId = url.searchParams.get("sessionId") ?? "";
        const transport = transports[sessionId];
        if (!transport) { res.writeHead(404).end("Session not found"); return; }
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        req.on("end", () => { transport.handlePostMessage(req, res, JSON.parse(body)); });
      } else if (url.pathname === "/" || url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      } else {
        res.writeHead(404).end("Not found");
      }
    });
    httpServer.listen(port, () => {
      console.error(`SelfHeal MCP server listening on port ${port} (SSE mode, ${config.mode})`);
    });
  } else {
    // Stdio mode for local usage
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("SelfHeal MCP server started (mode: " + config.mode + ")");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
