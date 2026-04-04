/**
 * MCP-to-MCP proxy — wraps any downstream MCP server with self-healing.
 * Connects as a client to the target server and forwards tool calls
 * through retry + circuit breaker.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { withRetry, type RetryOptions } from "./retry.js";
import { MetricsCollector } from "./metrics.js";

export interface TargetServer {
  name: string;
  transport: "stdio" | "streamable-http";
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // For streamable-http
  url?: string;
  headers?: Record<string, string>;
}

export interface ProxyConfig {
  targets: TargetServer[];
  retry: Partial<RetryOptions>;
  circuitThreshold: number;
  circuitCooldownMs: number;
}

export class SelfHealProxy {
  private clients = new Map<string, Client>();
  private toolToTarget = new Map<string, string>();
  readonly breaker: CircuitBreaker;
  readonly metrics: MetricsCollector;

  constructor(private config: ProxyConfig) {
    this.breaker = new CircuitBreaker(
      config.circuitThreshold,
      config.circuitCooldownMs,
    );
    this.metrics = new MetricsCollector();
  }

  async connect(): Promise<void> {
    for (const target of this.config.targets) {
      const client = new Client(
        { name: `selfheal-proxy/${target.name}`, version: "0.1.0" },
        { capabilities: {} },
      );

      let transport;
      if (target.transport === "stdio") {
        if (!target.command) throw new Error(`Target ${target.name}: stdio requires 'command'`);
        transport = new StdioClientTransport({
          command: target.command,
          args: target.args ?? [],
          env: { ...process.env, ...(target.env ?? {}) } as Record<string, string>,
        });
      } else {
        if (!target.url) throw new Error(`Target ${target.name}: streamable-http requires 'url'`);
        transport = new StreamableHTTPClientTransport(
          new URL(target.url),
          { requestInit: { headers: target.headers ?? {} } },
        );
      }

      await client.connect(transport);
      this.clients.set(target.name, client);

      // Discover tools from this target
      const { tools } = await client.listTools();
      for (const tool of tools) {
        this.toolToTarget.set(tool.name, target.name);
      }
    }
  }

  async listAllTools(): Promise<
    { name: string; description?: string; inputSchema: unknown; target: string }[]
  > {
    const allTools: {
      name: string;
      description?: string;
      inputSchema: unknown;
      target: string;
    }[] = [];

    for (const target of this.config.targets) {
      const client = this.clients.get(target.name);
      if (!client) continue;

      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          allTools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            target: target.name,
          });
        }
      } catch {
        // Target unavailable — skip
      }
    }

    return allTools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    target: string;
    attempts: number;
    durationMs: number;
    circuitState: string;
  }> {
    const targetName = this.toolToTarget.get(toolName);
    if (!targetName) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        target: "none",
        attempts: 0,
        durationMs: 0,
        circuitState: "unknown",
      };
    }

    const client = this.clients.get(targetName);
    if (!client) {
      return {
        success: false,
        error: `Target ${targetName} not connected`,
        target: targetName,
        attempts: 0,
        durationMs: 0,
        circuitState: "unknown",
      };
    }

    // Circuit breaker check
    if (!this.breaker.canRequest(targetName)) {
      const status = this.breaker.getStatus(targetName);
      this.metrics.record({
        tool: toolName,
        target: targetName,
        success: false,
        durationMs: 0,
        attempts: 0,
        error: `Circuit open — ${Math.round(status.cooldownRemaining / 1000)}s remaining`,
        timestamp: new Date().toISOString(),
      });

      return {
        success: false,
        error: `Circuit breaker OPEN for ${targetName}. ${Math.round(status.cooldownRemaining / 1000)}s until retry.`,
        target: targetName,
        attempts: 0,
        durationMs: 0,
        circuitState: status.state,
      };
    }

    const start = Date.now();
    const retryResult = await withRetry(
      () => client.callTool({ name: toolName, arguments: args }),
      this.config.retry,
    );

    const durationMs = Date.now() - start;

    if (retryResult.success) {
      this.breaker.recordSuccess(targetName);
    } else {
      this.breaker.recordFailure(targetName);
    }

    this.metrics.record({
      tool: toolName,
      target: targetName,
      success: retryResult.success,
      durationMs,
      attempts: retryResult.attempts,
      error: retryResult.error,
      timestamp: new Date().toISOString(),
    });

    return {
      success: retryResult.success,
      result: retryResult.result,
      error: retryResult.error,
      target: targetName,
      attempts: retryResult.attempts,
      durationMs,
      circuitState: this.breaker.getStatus(targetName).state,
    };
  }

  async disconnect(): Promise<void> {
    for (const [, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // Ignore cleanup errors
      }
    }
    this.clients.clear();
  }
}
