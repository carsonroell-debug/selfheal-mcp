/**
 * HTTP API Server — the x402 proxy endpoint.
 *
 * Flow:
 *   Agent → POST /api/proxy → Forward to target
 *     ↓ (target succeeds)
 *     → 200 pass-through (FREE)
 *     ↓ (target fails)
 *     → Check for X-PAYMENT header
 *       → No payment: Return 402 with x402 spec
 *       → Has payment: Verify → Run LLM heal → Settle on success → Return fix
 */

import type { IncomingMessage, ServerResponse } from "http";
import {
  type X402Config,
  PricingEngine,
  FacilitatorClient,
  build402Response,
  extractPaymentProof,
  send402,
} from "./x402.js";
import { HealEngine, type HealRequest, type HealResult } from "./heal.js";
import { ResponseCache } from "./cache.js";
import { MonitoringRegistry } from "./monitoring.js";

// --- Request Types ---

export interface ProxyRequestBody {
  /** Target URL to proxy to */
  url: string;
  /** HTTP method */
  method?: string;
  /** Headers to forward (credentials will be stripped from logs, but forwarded to target) */
  headers?: Record<string, string>;
  /** Request body to forward */
  body?: string;
  /** Timeout in ms */
  timeoutMs?: number;
}

// --- Credential stripping for logging only ---

const LOG_SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-payment",
  "x-payment-response",
]);

function stripForLog(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    clean[key] = LOG_SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  }
  return clean;
}

// --- Rate Limiter ---

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

class PaymentAwareRateLimiter {
  private limits = new Map<string, RateLimitEntry>();
  private windowMs: number;
  private freeLimit: number;
  private paidLimit: number;

  constructor(windowMs = 60_000, freeLimit = 30, paidLimit = 300) {
    this.windowMs = windowMs;
    this.freeLimit = freeLimit;
    this.paidLimit = paidLimit;
  }

  check(ip: string, hasPaid: boolean): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const limit = hasPaid ? this.paidLimit : this.freeLimit;
    let entry = this.limits.get(ip);

    if (!entry || now - entry.windowStart > this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.limits.set(ip, entry);
    }

    entry.count++;
    const remaining = Math.max(0, limit - entry.count);

    return { allowed: entry.count <= limit, remaining };
  }

  /** Periodic cleanup of expired entries */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.limits) {
      if (now - entry.windowStart > this.windowMs * 2) {
        this.limits.delete(ip);
      }
    }
  }
}

// --- HTTP API Handler ---

export class HttpApiHandler {
  private pricing: PricingEngine;
  private facilitator: FacilitatorClient;
  private healEngine: HealEngine;
  private cache: ResponseCache;
  private monitor: MonitoringRegistry;
  private rateLimiter: PaymentAwareRateLimiter;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private x402Config: X402Config,
    monitor: MonitoringRegistry,
    healEngine?: HealEngine,
    cache?: ResponseCache,
  ) {
    this.pricing = new PricingEngine(x402Config.pricingTiers);
    this.facilitator = new FacilitatorClient(x402Config.facilitatorUrl);
    this.healEngine = healEngine ?? new HealEngine();
    this.cache = cache ?? new ResponseCache(1000, 30_000);
    this.monitor = monitor;
    this.rateLimiter = new PaymentAwareRateLimiter();

    // Periodic cache pruning and rate limiter cleanup
    this.cleanupTimer = setInterval(() => {
      this.cache.prune();
      this.rateLimiter.cleanup();
      const stats = this.cache.getStats();
      this.monitor.cacheSize.set(stats.size);
      this.monitor.cacheHitRate.set(stats.hitRate);
    }, 30_000);
  }

  shutdown(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Main request router */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers":
          "Content-Type, X-Payment, X-Payment-Response, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Add CORS headers to all responses
    res.setHeader("Access-Control-Allow-Origin", "*");

    try {
      switch (url.pathname) {
        case "/api/proxy":
          await this.handleProxy(req, res);
          break;
        case "/api/heal":
          await this.handleHealDirect(req, res);
          break;
        case "/api/usage":
          this.handleUsage(req, res);
          break;
        case "/api/pricing":
          this.handlePricing(res);
          break;
        case "/metrics":
          this.handleMetrics(res);
          break;
        case "/health":
        case "/":
          this.handleHealth(res);
          break;
        default:
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      console.error("Request handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  /** POST /api/proxy — the main x402-protected proxy endpoint */
  private async handleProxy(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
      return;
    }

    // Rate limit check
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";
    const hasPayment = !!extractPaymentProof(req);
    const rateCheck = this.rateLimiter.check(clientIp, hasPayment);
    if (!rateCheck.allowed) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "60",
        "X-RateLimit-Remaining": "0",
      });
      res.end(
        JSON.stringify({
          error: "Rate limit exceeded",
          retryAfterSeconds: 60,
          hint: hasPayment
            ? "Paid rate limit reached. Try again in 60 seconds."
            : "Free tier rate limit. Include x402 payment proof for higher limits.",
        }),
      );
      return;
    }

    // Parse request body
    const body = await readBody(req);
    let proxyReq: ProxyRequestBody;
    try {
      proxyReq = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid JSON body",
          expected: {
            url: "string (required)",
            method: "string (default: GET)",
            headers: "object (optional)",
            body: "string (optional)",
            timeoutMs: "number (optional, default: 30000)",
          },
        }),
      );
      return;
    }

    if (!proxyReq.url) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: url" }));
      return;
    }

    this.monitor.proxyRequests.inc({ method: proxyReq.method ?? "GET" });
    this.monitor.recordRequest();
    this.monitor.activeRequests.inc();

    const start = Date.now();

    try {
      // Check cache for successful responses
      const cacheKey = ResponseCache.buildKey(
        proxyReq.method ?? "GET",
        proxyReq.url,
        proxyReq.body,
      );
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.monitor.proxySuccesses.inc();
        const latency = Date.now() - start;
        this.monitor.proxyLatency.observe(latency);

        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-SelfHeal-Cache": "HIT",
          "X-SelfHeal-Latency": String(latency),
        });
        res.end(JSON.stringify(cached));
        return;
      }

      // Forward to target
      const targetResponse = await this.forwardRequest(proxyReq);
      const latency = Date.now() - start;
      this.monitor.proxyLatency.observe(latency);

      // SUCCESS PATH — free pass-through
      if (targetResponse.ok) {
        this.monitor.proxySuccesses.inc();

        const responseBody = await targetResponse.text();
        const result = {
          status: targetResponse.status,
          headers: Object.fromEntries(targetResponse.headers.entries()),
          body: responseBody.length > 100_000
            ? responseBody.slice(0, 100_000) + "\n...[truncated]"
            : responseBody,
        };

        // Cache successful GET responses
        if ((proxyReq.method ?? "GET") === "GET") {
          this.cache.set(cacheKey, result);
        }

        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-SelfHeal-Status": "pass-through",
          "X-SelfHeal-Latency": String(latency),
          "X-SelfHeal-Cost": "0",
        });
        res.end(JSON.stringify(result));
        return;
      }

      // FAILURE PATH — check for x402 payment
      this.monitor.proxyFailures.inc({ status: String(targetResponse.status) });

      const errorBody = await targetResponse.text();
      const errorHeaders = Object.fromEntries(targetResponse.headers.entries());

      // Check if agent provided payment proof
      const paymentProof = extractPaymentProof(req);

      if (!paymentProof) {
        // Demo mode — run heal analysis for free, no x402 required
        if (this.x402Config.demoMode) {
          await this.handleDemoHeal(
            res,
            proxyReq,
            targetResponse.status,
            errorBody,
            errorHeaders,
          );
          return;
        }
        // No payment — return 402 with pricing
        const paymentRequired = build402Response(
          this.x402Config,
          this.pricing,
          errorBody.slice(0, 500),
          targetResponse.status,
          proxyReq.url,
        );
        send402(res, paymentRequired);
        return;
      }

      // PAID PATH — verify payment, run heal, settle on success
      await this.handlePaidHeal(
        req,
        res,
        proxyReq,
        paymentProof,
        targetResponse.status,
        errorBody,
        errorHeaders,
      );
    } finally {
      this.monitor.activeRequests.dec();
    }
  }

  /**
   * Handle demo heal flow: skip payment, run analysis, return result with demoMode flag.
   * Used when SELFHEAL_DEMO_MODE=true so first-time users can try the heal flow
   * without provisioning a USDC wallet.
   */
  private async handleDemoHeal(
    res: ServerResponse,
    proxyReq: ProxyRequestBody,
    statusCode: number,
    errorBody: string,
    errorHeaders: Record<string, string>,
  ): Promise<void> {
    if (!this.healEngine.isConfigured) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Heal engine not configured",
          hint: "Server LLM API key not set. Demo mode requires the same heal engine as paid mode.",
        }),
      );
      return;
    }

    this.monitor.healRequests.inc({ status: String(statusCode) });
    const healStart = Date.now();

    const healReq: HealRequest = {
      url: proxyReq.url,
      method: proxyReq.method ?? "GET",
      headers: proxyReq.headers ?? {},
      body: proxyReq.body,
      statusCode,
      errorBody,
      errorHeaders,
    };

    let healResult: HealResult;
    try {
      healResult = await this.healEngine.analyze(healReq);
    } catch (err) {
      this.monitor.healFailures.inc();
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Heal analysis failed",
          reason: err instanceof Error ? err.message : String(err),
          demoMode: true,
        }),
      );
      return;
    }

    const healLatency = Date.now() - healStart;
    this.monitor.healLatency.observe(healLatency);
    this.monitor.recordLlmCost(healResult.tokenUsage.total);

    if (healResult.success) {
      this.monitor.healSuccesses.inc();
    } else {
      this.monitor.healFailures.inc();
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-SelfHeal-Status": "demo-healed",
      "X-SelfHeal-Cost": "$0 (demo mode)",
      "X-SelfHeal-Latency": String(healLatency),
    });
    res.end(
      JSON.stringify({
        healed: healResult.success,
        demoMode: true,
        result: healResult,
        hint: "You're using SelfHeal demo mode. Paid heals (via x402 USDC or Reliability Plan) include unlimited usage and production guarantees.",
      }),
    );
  }

  /** Handle paid heal flow: verify → analyze → settle on success */
  private async handlePaidHeal(
    req: IncomingMessage,
    res: ServerResponse,
    proxyReq: ProxyRequestBody,
    paymentProof: { payload: string; scheme: "exact" | "upto" },
    statusCode: number,
    errorBody: string,
    errorHeaders: Record<string, string>,
  ): Promise<void> {
    // Verify payment
    const tier = this.pricing.getTier(errorBody, statusCode);
    const expectedAmount = Math.round(tier.basePrice * 1_000_000).toString();

    const verification = await this.facilitator.verify(
      paymentProof.payload,
      expectedAmount,
      this.x402Config.receivingWallet,
    );

    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payment verification failed",
          reason: verification.invalidReason,
          hint: "Ensure payment proof is valid and meets the required amount.",
        }),
      );
      return;
    }

    this.monitor.x402Payments.inc({ scheme: paymentProof.scheme });

    // Check if LLM is configured
    if (!this.healEngine.isConfigured) {
      this.monitor.x402Refunds.inc();
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Heal engine not configured",
          hint: "Server LLM API key not set. Payment was NOT settled.",
          refunded: true,
        }),
      );
      return;
    }

    // Run LLM heal analysis
    this.monitor.healRequests.inc({ status: String(statusCode) });
    const healStart = Date.now();

    const healReq: HealRequest = {
      url: proxyReq.url,
      method: proxyReq.method ?? "GET",
      headers: proxyReq.headers ?? {},
      body: proxyReq.body,
      statusCode,
      errorBody,
      errorHeaders,
    };

    let healResult: HealResult;
    try {
      healResult = await this.healEngine.analyze(healReq);
    } catch (err) {
      // LLM failed — don't settle payment
      this.monitor.healFailures.inc();
      this.monitor.x402Refunds.inc();

      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Heal analysis failed",
          reason: err instanceof Error ? err.message : String(err),
          refunded: true,
          hint: "Payment was NOT settled. You were not charged.",
        }),
      );
      return;
    }

    const healLatency = Date.now() - healStart;
    this.monitor.healLatency.observe(healLatency);
    this.monitor.recordLlmCost(healResult.tokenUsage.total);

    if (!healResult.success) {
      // Analysis produced no useful result — don't settle
      this.monitor.healFailures.inc();
      this.monitor.x402Refunds.inc();

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          healed: false,
          refunded: true,
          result: healResult,
          hint: "Analysis could not produce a fix. Payment was NOT settled.",
        }),
      );
      return;
    }

    // SUCCESS — settle payment
    this.monitor.healSuccesses.inc();
    const settleResult = await this.facilitator.settle(
      paymentProof.payload,
      this.x402Config.receivingWallet,
    );

    if (settleResult.success) {
      this.monitor.x402Revenue.inc(
        { tier: tier.name },
        parseInt(expectedAmount),
      );
    }

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-SelfHeal-Status": "healed",
      "X-SelfHeal-Cost": `$${tier.basePrice} USDC`,
      "X-SelfHeal-Latency": String(healLatency),
    });
    res.end(
      JSON.stringify({
        healed: true,
        settled: settleResult.success,
        txHash: settleResult.txHash,
        result: healResult,
      }),
    );
  }

  /** POST /api/heal — direct heal endpoint (submit error for analysis) */
  private async handleHealDirect(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed. Use POST." }));
      return;
    }

    // This endpoint requires payment unless demo mode is enabled
    const paymentProof = extractPaymentProof(req);
    if (!paymentProof) {
      const body = await readBody(req);
      let errorMsg = "Unknown error";
      let statusCode = 500;
      try {
        const parsed = JSON.parse(body);
        errorMsg = parsed.errorBody ?? parsed.error ?? "Unknown error";
        statusCode = parsed.statusCode ?? 500;
      } catch {
        // Use defaults
      }

      // Demo mode — run heal analysis for free, no x402 required
      if (this.x402Config.demoMode) {
        let healReq: HealRequest;
        try {
          healReq = JSON.parse(body) as HealRequest;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }
        await this.handleDemoHeal(
          res,
          { url: healReq.url, method: healReq.method, headers: healReq.headers, body: healReq.body },
          healReq.statusCode,
          healReq.errorBody,
          healReq.errorHeaders,
        );
        return;
      }

      const paymentRequired = build402Response(
        this.x402Config,
        this.pricing,
        errorMsg,
        statusCode,
        "/api/heal",
      );
      send402(res, paymentRequired);
      return;
    }

    // Parse heal request
    const body = await readBody(req);
    let healReq: HealRequest;
    try {
      healReq = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid JSON body",
          expected: {
            url: "string",
            method: "string",
            headers: "object",
            body: "string (optional)",
            statusCode: "number",
            errorBody: "string",
            errorHeaders: "object",
          },
        }),
      );
      return;
    }

    // Verify payment
    const tier = this.pricing.getTier(healReq.errorBody, healReq.statusCode);
    const expectedAmount = Math.round(tier.basePrice * 1_000_000).toString();

    const verification = await this.facilitator.verify(
      paymentProof.payload,
      expectedAmount,
      this.x402Config.receivingWallet,
    );

    if (!verification.valid) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Payment verification failed",
          reason: verification.invalidReason,
        }),
      );
      return;
    }

    this.monitor.x402Payments.inc({ scheme: paymentProof.scheme });
    this.monitor.healRequests.inc({ status: String(healReq.statusCode) });

    // Run analysis
    try {
      const healResult = await this.healEngine.analyze(healReq);
      this.monitor.recordLlmCost(healResult.tokenUsage.total);

      if (!healResult.success) {
        this.monitor.healFailures.inc();
        this.monitor.x402Refunds.inc();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            healed: false,
            refunded: true,
            result: healResult,
          }),
        );
        return;
      }

      // Settle
      this.monitor.healSuccesses.inc();
      const settleResult = await this.facilitator.settle(
        paymentProof.payload,
        this.x402Config.receivingWallet,
      );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          healed: true,
          settled: settleResult.success,
          txHash: settleResult.txHash,
          result: healResult,
        }),
      );
    } catch (err) {
      this.monitor.healFailures.inc();
      this.monitor.x402Refunds.inc();

      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Heal analysis failed",
          reason: err instanceof Error ? err.message : String(err),
          refunded: true,
        }),
      );
    }
  }

  /** GET /api/usage — public usage stats */
  private handleUsage(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(this.monitor.getUsageSummary(), null, 2));
  }

  /** GET /api/pricing — show current pricing tiers */
  private handlePricing(res: ServerResponse): void {
    const tiers = this.x402Config.pricingTiers ?? [
      { name: "simple", basePrice: 0.001, maxPrice: 0.002 },
      { name: "moderate", basePrice: 0.002, maxPrice: 0.003 },
      { name: "complex", basePrice: 0.003, maxPrice: 0.005 },
    ];

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          model: "outcome-based",
          description:
            "Pay only when errors are successfully healed. Successes pass through free.",
          currency: "USDC",
          networks: this.x402Config.networks,
          tiers,
          protocol: "x402",
          facilitator: this.x402Config.facilitatorUrl,
        },
        null,
        2,
      ),
    );
  }

  /** GET /metrics — Prometheus scrape endpoint */
  private handleMetrics(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(this.monitor.toPrometheus());
  }

  /** GET /health */
  private handleHealth(res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        service: "selfheal-mcp",
        x402Enabled: !!this.x402Config.receivingWallet,
        healConfigured: this.healEngine.isConfigured,
        demoMode: this.x402Config.demoMode,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /** Forward request to target */
  private async forwardRequest(
    proxyReq: ProxyRequestBody,
  ): Promise<Response> {
    const timeout = proxyReq.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      return await fetch(proxyReq.url, {
        method: proxyReq.method ?? "GET",
        headers: proxyReq.headers ?? {},
        body: proxyReq.body ?? undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Helpers ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      // Limit body size to 1MB
      if (body.length > 1_048_576) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
