/**
 * Retry with exponential backoff + jitter.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableErrors: [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "timeout",
    "rate_limit",
    "429",
    "500",
    "502",
    "503",
    "504",
  ],
};

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  attempts: number;
  totalTimeMs: number;
  retryLog: RetryLogEntry[];
}

export interface RetryLogEntry {
  attempt: number;
  error: string;
  delayMs: number;
  timestamp: string;
}

function isRetryable(error: unknown, patterns: string[]): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return patterns.some(
    (p) => msg.includes(p) || (error instanceof Error && error.name.includes(p)),
  );
}

function jitteredDelay(base: number, attempt: number, max: number): number {
  const exponential = base * Math.pow(2, attempt);
  const capped = Math.min(exponential, max);
  // Add 0-50% jitter
  return capped * (0.5 + Math.random() * 0.5);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<RetryResult<T>> {
  const options = { ...DEFAULT_OPTIONS, ...opts };
  const retryLog: RetryLogEntry[] = [];
  const start = Date.now();

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      const result = await fn();
      return {
        success: true,
        result,
        attempts: attempt + 1,
        totalTimeMs: Date.now() - start,
        retryLog,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (
        attempt >= options.maxRetries ||
        !isRetryable(err, options.retryableErrors!)
      ) {
        return {
          success: false,
          error: errorMsg,
          attempts: attempt + 1,
          totalTimeMs: Date.now() - start,
          retryLog,
        };
      }

      const delay = jitteredDelay(
        options.baseDelayMs,
        attempt,
        options.maxDelayMs,
      );

      retryLog.push({
        attempt: attempt + 1,
        error: errorMsg,
        delayMs: Math.round(delay),
        timestamp: new Date().toISOString(),
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Should not reach here
  return {
    success: false,
    error: "Max retries exceeded",
    attempts: options.maxRetries + 1,
    totalTimeMs: Date.now() - start,
    retryLog,
  };
}
