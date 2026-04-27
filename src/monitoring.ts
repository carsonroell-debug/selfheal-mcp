/**
 * Monitoring, Prometheus metrics, and alerting for SelfHeal.
 *
 * Tracks: heals/sec, LLM token spend, x402 volume, success rate, latency.
 * Fires webhook alerts on anomalies.
 */

// --- Prometheus-style Counters ---

interface CounterValue {
  value: number;
  labels: Record<string, string>;
}

class Counter {
  private values = new Map<string, CounterValue>();

  constructor(
    public name: string,
    public help: string,
  ) {}

  inc(labels: Record<string, string> = {}, amount = 1): void {
    const key = JSON.stringify(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      this.values.set(key, { value: amount, labels });
    }
  }

  toPrometheus(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const entry of this.values.values()) {
      const labelStr = Object.entries(entry.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      const suffix = labelStr ? `{${labelStr}}` : "";
      lines.push(`${this.name}${suffix} ${entry.value}`);
    }
    return lines.join("\n");
  }

  getTotal(): number {
    let total = 0;
    for (const entry of this.values.values()) total += entry.value;
    return total;
  }
}

class Histogram {
  private buckets: number[];
  private counts: number[];
  private sum = 0;
  private count = 0;

  constructor(
    public name: string,
    public help: string,
    buckets?: number[],
  ) {
    this.buckets = buckets ?? [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    this.counts = new Array(this.buckets.length + 1).fill(0);
  }

  observe(value: number): void {
    this.sum += value;
    this.count++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) {
        this.counts[i]++;
        return;
      }
    }
    this.counts[this.buckets.length]++; // +Inf
  }

  toPrometheus(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    let cumulative = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cumulative += this.counts[i];
      lines.push(`${this.name}_bucket{le="${this.buckets[i]}"} ${cumulative}`);
    }
    cumulative += this.counts[this.buckets.length];
    lines.push(`${this.name}_bucket{le="+Inf"} ${cumulative}`);
    lines.push(`${this.name}_sum ${this.sum}`);
    lines.push(`${this.name}_count ${this.count}`);
    return lines.join("\n");
  }

  getAvg(): number {
    return this.count > 0 ? this.sum / this.count : 0;
  }
}

// --- Gauge ---

class Gauge {
  private value = 0;

  constructor(
    public name: string,
    public help: string,
  ) {}

  set(val: number): void {
    this.value = val;
  }

  inc(amount = 1): void {
    this.value += amount;
  }

  dec(amount = 1): void {
    this.value -= amount;
  }

  toPrometheus(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.value}`,
    ].join("\n");
  }

  getVal(): number {
    return this.value;
  }
}

// --- Alert System ---

export interface AlertConfig {
  /** Webhook URL for alerts (Slack, Discord, generic) */
  webhookUrl?: string;
  /** Email for alerts (requires SMTP config) */
  alertEmail?: string;
  /** Traffic spike threshold multiplier (e.g., 5 = 5x baseline) */
  trafficSpikeMultiplier: number;
  /** Max daily LLM cost in USD before alert */
  maxDailyLlmCostUsd: number;
  /** Min heal success rate before alert (0-1) */
  minHealSuccessRate: number;
  /** Check interval in ms */
  checkIntervalMs: number;
}

function loadAlertConfig(): AlertConfig {
  return {
    webhookUrl: process.env.ALERT_WEBHOOK_URL,
    alertEmail: process.env.ALERT_EMAIL,
    trafficSpikeMultiplier: parseFloat(process.env.ALERT_TRAFFIC_SPIKE_MULTIPLIER ?? "5"),
    maxDailyLlmCostUsd: parseFloat(process.env.ALERT_MAX_DAILY_LLM_COST ?? "10"),
    minHealSuccessRate: parseFloat(process.env.ALERT_MIN_HEAL_SUCCESS_RATE ?? "0.9"),
    checkIntervalMs: parseInt(process.env.ALERT_CHECK_INTERVAL_MS ?? "60000"),
  };
}

export interface AlertPayload {
  severity: "warning" | "critical";
  type: string;
  message: string;
  value: number;
  threshold: number;
  timestamp: string;
  service: string;
}

// --- Monitoring Registry ---

export class MonitoringRegistry {
  // Counters
  readonly proxyRequests = new Counter(
    "selfheal_proxy_requests_total",
    "Total proxy requests",
  );
  readonly proxySuccesses = new Counter(
    "selfheal_proxy_successes_total",
    "Successful proxy pass-throughs (free)",
  );
  readonly proxyFailures = new Counter(
    "selfheal_proxy_failures_total",
    "Proxy requests that returned errors from target",
  );
  readonly healRequests = new Counter(
    "selfheal_heal_requests_total",
    "Total heal analysis requests (paid)",
  );
  readonly healSuccesses = new Counter(
    "selfheal_heal_successes_total",
    "Successful heal analyses",
  );
  readonly healFailures = new Counter(
    "selfheal_heal_failures_total",
    "Failed heal analyses",
  );
  readonly x402Payments = new Counter(
    "selfheal_x402_payments_total",
    "Total x402 payments received",
  );
  readonly x402Revenue = new Counter(
    "selfheal_x402_revenue_usdc_total",
    "Total revenue in USDC atomic units",
  );
  readonly x402Refunds = new Counter(
    "selfheal_x402_refunds_total",
    "Payments not settled (heal failed)",
  );
  readonly llmTokens = new Counter(
    "selfheal_llm_tokens_total",
    "Total LLM tokens consumed",
  );

  // Histograms
  readonly proxyLatency = new Histogram(
    "selfheal_proxy_latency_ms",
    "Proxy request latency in milliseconds",
  );
  readonly healLatency = new Histogram(
    "selfheal_heal_latency_ms",
    "Heal analysis latency in milliseconds",
    [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
  );

  // Gauges
  readonly activeRequests = new Gauge(
    "selfheal_active_requests",
    "Currently active proxy requests",
  );
  readonly cacheSize = new Gauge(
    "selfheal_cache_size",
    "Number of entries in response cache",
  );
  readonly cacheHitRate = new Gauge(
    "selfheal_cache_hit_rate",
    "Cache hit rate (0-1)",
  );

  // Alert state
  private alertConfig: AlertConfig;
  private alertCheckTimer: ReturnType<typeof setInterval> | null = null;
  private baselineRpm = 0;
  private lastMinuteRequests = 0;
  private lastMinuteTimestamp = Date.now();
  private dailyLlmCostUsd = 0;
  private dailyResetTimestamp = Date.now();

  constructor() {
    this.alertConfig = loadAlertConfig();
  }

  /** Start periodic alert checks */
  startAlertLoop(): void {
    if (this.alertCheckTimer) return;

    this.alertCheckTimer = setInterval(() => {
      this.checkAlerts().catch(() => {});
    }, this.alertConfig.checkIntervalMs);
  }

  stopAlertLoop(): void {
    if (this.alertCheckTimer) {
      clearInterval(this.alertCheckTimer);
      this.alertCheckTimer = null;
    }
  }

  /** Record LLM cost for daily tracking */
  recordLlmCost(tokens: number, costPerToken = 0.000002): void {
    const cost = tokens * costPerToken;

    // Reset daily counter if new day
    const now = Date.now();
    if (now - this.dailyResetTimestamp > 86_400_000) {
      this.dailyLlmCostUsd = 0;
      this.dailyResetTimestamp = now;
    }

    this.dailyLlmCostUsd += cost;
    this.llmTokens.inc({ type: "total" }, tokens);
  }

  /** Update requests-per-minute baseline */
  recordRequest(): void {
    const now = Date.now();
    if (now - this.lastMinuteTimestamp > 60_000) {
      // Update baseline with exponential moving average
      this.baselineRpm = this.baselineRpm * 0.8 + this.lastMinuteRequests * 0.2;
      this.lastMinuteRequests = 0;
      this.lastMinuteTimestamp = now;
    }
    this.lastMinuteRequests++;
  }

  private async checkAlerts(): Promise<void> {
    const alerts: AlertPayload[] = [];

    // Traffic spike
    if (
      this.baselineRpm > 0 &&
      this.lastMinuteRequests >
        this.baselineRpm * this.alertConfig.trafficSpikeMultiplier
    ) {
      alerts.push({
        severity: "warning",
        type: "traffic_spike",
        message: `Traffic spike detected: ${this.lastMinuteRequests} req/min vs ${Math.round(this.baselineRpm)} baseline`,
        value: this.lastMinuteRequests,
        threshold: this.baselineRpm * this.alertConfig.trafficSpikeMultiplier,
        timestamp: new Date().toISOString(),
        service: "selfheal-mcp",
      });
    }

    // LLM cost
    if (this.dailyLlmCostUsd > this.alertConfig.maxDailyLlmCostUsd) {
      alerts.push({
        severity: "critical",
        type: "llm_cost_exceeded",
        message: `Daily LLM cost $${this.dailyLlmCostUsd.toFixed(4)} exceeds $${this.alertConfig.maxDailyLlmCostUsd} limit`,
        value: this.dailyLlmCostUsd,
        threshold: this.alertConfig.maxDailyLlmCostUsd,
        timestamp: new Date().toISOString(),
        service: "selfheal-mcp",
      });
    }

    // Heal success rate
    const totalHeals = this.healSuccesses.getTotal() + this.healFailures.getTotal();
    if (totalHeals > 10) {
      const rate = this.healSuccesses.getTotal() / totalHeals;
      if (rate < this.alertConfig.minHealSuccessRate) {
        alerts.push({
          severity: "warning",
          type: "low_heal_success_rate",
          message: `Heal success rate ${(rate * 100).toFixed(1)}% below ${(this.alertConfig.minHealSuccessRate * 100).toFixed(0)}% threshold`,
          value: rate,
          threshold: this.alertConfig.minHealSuccessRate,
          timestamp: new Date().toISOString(),
          service: "selfheal-mcp",
        });
      }
    }

    // Send alerts
    for (const alert of alerts) {
      await this.sendAlert(alert);
    }
  }

  private async sendAlert(alert: AlertPayload): Promise<void> {
    if (!this.alertConfig.webhookUrl) return;

    try {
      await fetch(this.alertConfig.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(alert),
      });
    } catch {
      // Don't let alert failures crash the service
    }
  }

  /** Generate Prometheus-format metrics output */
  toPrometheus(): string {
    return [
      this.proxyRequests.toPrometheus(),
      this.proxySuccesses.toPrometheus(),
      this.proxyFailures.toPrometheus(),
      this.healRequests.toPrometheus(),
      this.healSuccesses.toPrometheus(),
      this.healFailures.toPrometheus(),
      this.x402Payments.toPrometheus(),
      this.x402Revenue.toPrometheus(),
      this.x402Refunds.toPrometheus(),
      this.llmTokens.toPrometheus(),
      this.proxyLatency.toPrometheus(),
      this.healLatency.toPrometheus(),
      this.activeRequests.toPrometheus(),
      this.cacheSize.toPrometheus(),
      this.cacheHitRate.toPrometheus(),
    ].join("\n\n");
  }

  /** Get summary for /api/usage endpoint */
  getUsageSummary(): Record<string, unknown> {
    return {
      proxy: {
        totalRequests: this.proxyRequests.getTotal(),
        successes: this.proxySuccesses.getTotal(),
        failures: this.proxyFailures.getTotal(),
        avgLatencyMs: Math.round(this.proxyLatency.getAvg()),
      },
      heal: {
        totalRequests: this.healRequests.getTotal(),
        successes: this.healSuccesses.getTotal(),
        failures: this.healFailures.getTotal(),
        successRate:
          this.healRequests.getTotal() > 0
            ? this.healSuccesses.getTotal() / this.healRequests.getTotal()
            : 0,
        avgLatencyMs: Math.round(this.healLatency.getAvg()),
      },
      x402: {
        totalPayments: this.x402Payments.getTotal(),
        refunds: this.x402Refunds.getTotal(),
      },
      llm: {
        totalTokens: this.llmTokens.getTotal(),
        dailyCostUsd: this.dailyLlmCostUsd,
      },
      cache: {
        size: this.cacheSize.getVal(),
        hitRate: this.cacheHitRate.getVal(),
      },
    };
  }
}
