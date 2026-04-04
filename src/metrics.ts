/**
 * In-memory metrics collector for tool call observability.
 */

interface ToolCallRecord {
  tool: string;
  target: string;
  success: boolean;
  durationMs: number;
  attempts: number;
  error?: string;
  timestamp: string;
}

export class MetricsCollector {
  private records: ToolCallRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords = 10_000) {
    this.maxRecords = maxRecords;
  }

  record(entry: ToolCallRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  getSummary(windowMs = 3_600_000): {
    totalCalls: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgDurationMs: number;
    avgAttempts: number;
    topErrors: { error: string; count: number }[];
    byTool: Record<string, { calls: number; successRate: number; avgDurationMs: number }>;
    byTarget: Record<string, { calls: number; successRate: number }>;
  } {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const recent = this.records.filter((r) => r.timestamp >= cutoff);

    if (recent.length === 0) {
      return {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDurationMs: 0,
        avgAttempts: 0,
        topErrors: [],
        byTool: {},
        byTarget: {},
      };
    }

    const successes = recent.filter((r) => r.success);
    const failures = recent.filter((r) => !r.success);

    // Error frequency
    const errorCounts = new Map<string, number>();
    for (const r of failures) {
      if (r.error) {
        errorCounts.set(r.error, (errorCounts.get(r.error) || 0) + 1);
      }
    }
    const topErrors = Array.from(errorCounts.entries())
      .map(([error, count]) => ({ error, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // By tool
    const byTool: Record<string, { calls: number; successRate: number; avgDurationMs: number }> = {};
    const toolGroups = new Map<string, ToolCallRecord[]>();
    for (const r of recent) {
      if (!toolGroups.has(r.tool)) toolGroups.set(r.tool, []);
      toolGroups.get(r.tool)!.push(r);
    }
    for (const [tool, records] of toolGroups) {
      const s = records.filter((r) => r.success).length;
      byTool[tool] = {
        calls: records.length,
        successRate: s / records.length,
        avgDurationMs: Math.round(
          records.reduce((sum, r) => sum + r.durationMs, 0) / records.length,
        ),
      };
    }

    // By target
    const byTarget: Record<string, { calls: number; successRate: number }> = {};
    const targetGroups = new Map<string, ToolCallRecord[]>();
    for (const r of recent) {
      if (!targetGroups.has(r.target)) targetGroups.set(r.target, []);
      targetGroups.get(r.target)!.push(r);
    }
    for (const [target, records] of targetGroups) {
      const s = records.filter((r) => r.success).length;
      byTarget[target] = {
        calls: records.length,
        successRate: s / records.length,
      };
    }

    return {
      totalCalls: recent.length,
      successCount: successes.length,
      failureCount: failures.length,
      successRate: successes.length / recent.length,
      avgDurationMs: Math.round(
        recent.reduce((sum, r) => sum + r.durationMs, 0) / recent.length,
      ),
      avgAttempts: +(
        recent.reduce((sum, r) => sum + r.attempts, 0) / recent.length
      ).toFixed(2),
      topErrors,
      byTool,
      byTarget,
    };
  }

  getRecentErrors(limit = 20): ToolCallRecord[] {
    return this.records
      .filter((r) => !r.success)
      .slice(-limit)
      .reverse();
  }

  clear(): void {
    this.records = [];
  }
}
