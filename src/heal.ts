/**
 * LLM-powered error analysis and fix generation.
 *
 * Analyzes HTTP errors, generates structured fix instructions,
 * and builds retry payloads. Falls back to cheaper models for simple errors.
 */

// --- Types ---

export interface HealRequest {
  /** Original request URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Request headers (credentials stripped) */
  headers: Record<string, string>;
  /** Request body (truncated) */
  body?: string;
  /** Error status code from target */
  statusCode: number;
  /** Error response body from target */
  errorBody: string;
  /** Error response headers from target */
  errorHeaders: Record<string, string>;
}

export interface HealResult {
  success: boolean;
  /** Error category */
  category: string;
  /** Human-readable diagnosis */
  diagnosis: string;
  /** Structured fix instructions */
  fix: FixInstruction;
  /** Ready-to-use retry payload */
  retryPayload: RetryPayload | null;
  /** Whether the error is likely retriable */
  retriable: boolean;
  /** Confidence score 0-1 */
  confidence: number;
  /** Token usage for billing */
  tokenUsage: { prompt: number; completion: number; total: number };
  /** Model used */
  model: string;
  /** Analysis duration in ms */
  durationMs: number;
}

export interface FixInstruction {
  /** What went wrong */
  problem: string;
  /** Steps to fix */
  steps: string[];
  /** Specific changes to make */
  changes: {
    target: "headers" | "body" | "url" | "method" | "query";
    action: "add" | "remove" | "modify";
    key?: string;
    value?: string;
    description: string;
  }[];
  /** Code example if applicable */
  codeExample?: string;
}

export interface RetryPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

// --- LLM Provider Abstraction ---

interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], opts: LLMOptions): Promise<LLMResponse>;
}

interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface LLMOptions {
  model: string;
  maxTokens: number;
  temperature: number;
}

interface LLMResponse {
  content: string;
  usage: { prompt: number; completion: number; total: number };
  model: string;
}

// --- OpenAI-Compatible Provider ---

class OpenAICompatibleProvider implements LLMProvider {
  constructor(
    public name: string,
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async chat(messages: LLMMessage[], opts: LLMOptions): Promise<LLMResponse> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        response_format: { type: "json_object" },
      }),
    });

    if (!resp.ok) {
      throw new Error(`LLM API error: ${resp.status} ${await resp.text()}`);
    }

    const data = (await resp.json()) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
      model: string;
    };

    return {
      content: data.choices[0].message.content,
      usage: {
        prompt: data.usage.prompt_tokens,
        completion: data.usage.completion_tokens,
        total: data.usage.total_tokens,
      },
      model: data.model,
    };
  }
}

// --- Heal Config ---

export interface HealConfig {
  /** Primary LLM provider */
  provider: string;
  /** API key */
  apiKey: string;
  /** Base URL (for OpenAI-compatible APIs) */
  baseUrl: string;
  /** Model for complex errors */
  complexModel: string;
  /** Model for simple errors (cheaper, faster) */
  simpleModel: string;
  /** Max tokens for response */
  maxTokens: number;
  /** Max body size to send to LLM (bytes) */
  maxBodySize: number;
}

export function loadHealConfig(): HealConfig {
  return {
    provider: process.env.HEAL_LLM_PROVIDER ?? "openai",
    apiKey: process.env.HEAL_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseUrl:
      process.env.HEAL_LLM_BASE_URL ?? "https://api.openai.com/v1",
    complexModel: process.env.HEAL_COMPLEX_MODEL ?? "gpt-4o-mini",
    simpleModel: process.env.HEAL_SIMPLE_MODEL ?? "gpt-4o-mini",
    maxTokens: parseInt(process.env.HEAL_MAX_TOKENS ?? "1024"),
    maxBodySize: parseInt(process.env.HEAL_MAX_BODY_SIZE ?? "4096"),
  };
}

// --- Error Complexity Classification ---

type Complexity = "simple" | "complex";

function classifyError(statusCode: number, errorBody: string): Complexity {
  // Simple: well-known status codes with obvious fixes
  const simpleStatuses = [400, 401, 403, 404, 405, 408, 413, 415, 429];
  if (simpleStatuses.includes(statusCode) && errorBody.length < 500) {
    return "simple";
  }
  return "complex";
}

// --- Credential Stripping ---

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
  "x-llm-api-key",
  "x-payment",
  "x-payment-response",
]);

function stripCredentials(
  headers: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      clean[key] = "[REDACTED]";
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "\n...[truncated]";
}

// --- System Prompt ---

const SYSTEM_PROMPT = `You are SelfHeal, an expert API error analyst. Given a failed HTTP request and its error response, you must:

1. Diagnose the root cause
2. Provide structured fix instructions
3. Build a ready-to-use retry payload with the fix applied

IMPORTANT RULES:
- NEVER include secrets, API keys, or credentials in your response
- If auth is needed, describe what type but use placeholder values
- Be specific and actionable — agents will execute your instructions programmatically
- Always respond in valid JSON matching the schema below

Response JSON schema:
{
  "category": "string (auth_error|rate_limit|bad_request|not_found|server_error|timeout|permission|schema_error|other)",
  "diagnosis": "string (1-2 sentence root cause explanation)",
  "fix": {
    "problem": "string (what went wrong)",
    "steps": ["string (step 1)", "string (step 2)"],
    "changes": [
      {
        "target": "headers|body|url|method|query",
        "action": "add|remove|modify",
        "key": "string (optional)",
        "value": "string (optional, NEVER real credentials)",
        "description": "string"
      }
    ],
    "codeExample": "string (optional, short code snippet showing the fix)"
  },
  "retryPayload": {
    "url": "string",
    "method": "string",
    "headers": {},
    "body": "string (optional)"
  } or null if not retriable,
  "retriable": true/false,
  "confidence": 0.0-1.0
}`;

// --- Heal Engine ---

export class HealEngine {
  private provider: LLMProvider;
  private config: HealConfig;

  constructor(config?: HealConfig) {
    this.config = config ?? loadHealConfig();

    // Build provider based on config
    this.provider = new OpenAICompatibleProvider(
      this.config.provider,
      this.config.baseUrl,
      this.config.apiKey,
    );
  }

  get isConfigured(): boolean {
    return this.config.apiKey.length > 0;
  }

  async analyze(req: HealRequest): Promise<HealResult> {
    if (!this.isConfigured) {
      throw new Error(
        "LLM not configured. Set HEAL_LLM_API_KEY or OPENAI_API_KEY environment variable.",
      );
    }

    const start = Date.now();
    const complexity = classifyError(req.statusCode, req.errorBody);
    const model =
      complexity === "simple"
        ? this.config.simpleModel
        : this.config.complexModel;

    const safeHeaders = stripCredentials(req.headers);
    const safeErrorHeaders = stripCredentials(req.errorHeaders);

    const userMessage = JSON.stringify(
      {
        request: {
          url: req.url,
          method: req.method,
          headers: safeHeaders,
          body: req.body ? truncate(req.body, this.config.maxBodySize) : undefined,
        },
        response: {
          statusCode: req.statusCode,
          headers: safeErrorHeaders,
          body: truncate(req.errorBody, this.config.maxBodySize),
        },
      },
      null,
      2,
    );

    const llmResp = await this.provider.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      {
        model,
        maxTokens: this.config.maxTokens,
        temperature: 0.1,
      },
    );

    const durationMs = Date.now() - start;

    try {
      const parsed = JSON.parse(llmResp.content) as {
        category: string;
        diagnosis: string;
        fix: FixInstruction;
        retryPayload: RetryPayload | null;
        retriable: boolean;
        confidence: number;
      };

      return {
        success: true,
        category: parsed.category,
        diagnosis: parsed.diagnosis,
        fix: parsed.fix,
        retryPayload: parsed.retryPayload,
        retriable: parsed.retriable,
        confidence: parsed.confidence,
        tokenUsage: llmResp.usage,
        model: llmResp.model,
        durationMs,
      };
    } catch {
      return {
        success: false,
        category: "parse_error",
        diagnosis: "LLM response could not be parsed as valid JSON",
        fix: {
          problem: "Internal analysis error",
          steps: ["Retry the analysis"],
          changes: [],
        },
        retryPayload: null,
        retriable: false,
        confidence: 0,
        tokenUsage: llmResp.usage,
        model: llmResp.model,
        durationMs,
      };
    }
  }
}
