/**
 * x402 Payment Protocol — outcome-based micropayments for SelfHeal.
 *
 * Agents only pay when a failure is successfully healed.
 * Successes pass through free. Failed analyses are never charged.
 *
 * Supports "exact" and "upto" payment schemes per the x402 spec.
 * Default facilitator: https://x402.org/facilitator
 */

import type { IncomingMessage, ServerResponse } from "http";

// --- x402 Types ---

export interface X402PaymentRequired {
  /** x402 protocol version */
  x402Version: 1;
  /** Available payment schemes */
  accepts: X402PaymentScheme[];
  /** Human-readable error context */
  error: string;
}

export interface X402PaymentScheme {
  /** "exact" for fixed price, "upto" for variable (LLM token cost) */
  scheme: "exact" | "upto";
  /** Network identifier */
  network: string;
  /** Maximum payment amount in smallest unit (e.g., USDC atomic units) */
  maxAmountRequired: string;
  /** Resource being purchased */
  resource: string;
  /** Human-readable description */
  description: string;
  /** MIME type of the response */
  mimeType: string;
  /** Receiving wallet address */
  payTo: string;
  /** Required payment asset (USDC contract address) */
  requiredDeadlineSeconds: number;
  extra: {
    /** Token symbol */
    name: string;
    /** Token contract or mint address */
    token: string;
  };
}

export interface X402PaymentProof {
  /** The payment header value from the client */
  payload: string;
  /** Decoded scheme type */
  scheme: "exact" | "upto";
}

export interface X402VerifyResult {
  valid: boolean;
  /** Actual amount paid (for upto scheme) */
  amountPaid?: string;
  invalidReason?: string;
}

export interface X402SettleResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

// --- Pricing ---

export interface PricingTier {
  name: string;
  /** Base price in USDC (e.g., 0.001) */
  basePrice: number;
  /** Max price for upto scheme */
  maxPrice: number;
  /** Error patterns that match this tier */
  patterns: string[];
}

const DEFAULT_PRICING: PricingTier[] = [
  {
    name: "simple",
    basePrice: 0.001,
    maxPrice: 0.002,
    patterns: ["400", "404", "405", "422", "ECONNREFUSED", "ENOTFOUND"],
  },
  {
    name: "moderate",
    basePrice: 0.002,
    maxPrice: 0.003,
    patterns: ["500", "502", "503", "timeout", "ETIMEDOUT", "ECONNRESET"],
  },
  {
    name: "complex",
    basePrice: 0.003,
    maxPrice: 0.005,
    patterns: ["rate_limit", "429", "auth", "permission", "forbidden", "403"],
  },
];

// USDC has 6 decimals
const USDC_DECIMALS = 6;

function usdcToAtomic(usd: number): string {
  return Math.round(usd * 10 ** USDC_DECIMALS).toString();
}

// --- Network Config ---

interface NetworkConfig {
  name: string;
  chainId?: number;
  usdcToken: string;
}

const SUPPORTED_NETWORKS: NetworkConfig[] = [
  {
    name: "base",
    chainId: 8453,
    usdcToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    name: "base-sepolia",
    chainId: 84532,
    usdcToken: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
  {
    name: "solana",
    usdcToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];

// --- x402 Config ---

export interface X402Config {
  /** Facilitator URL for verify/settle */
  facilitatorUrl: string;
  /** Wallet address to receive payments */
  receivingWallet: string;
  /** Networks to support */
  networks: string[];
  /** Pricing tiers (override defaults) */
  pricingTiers?: PricingTier[];
  /** Whether to use testnet */
  testnet: boolean;
  /** Payment deadline in seconds */
  deadlineSeconds: number;
  /**
   * Demo mode — bypass x402 payment entirely and run heal analysis for free.
   * Used so first-time users can try the heal flow without provisioning a USDC wallet.
   * Server-only setting; never enable in production with a real wallet attached.
   */
  demoMode: boolean;
}

export function loadX402Config(): X402Config {
  const pricingEnv = process.env.X402_PRICING_CONFIG;
  let customPricing: PricingTier[] | undefined;
  if (pricingEnv) {
    try {
      customPricing = JSON.parse(pricingEnv);
    } catch {
      // Ignore invalid JSON, use defaults
    }
  }

  return {
    facilitatorUrl:
      process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
    receivingWallet: process.env.X402_RECEIVING_WALLET ?? "",
    networks: (process.env.X402_NETWORKS ?? "base,base-sepolia")
      .split(",")
      .map((n) => n.trim()),
    pricingTiers: customPricing,
    testnet: process.env.X402_TESTNET === "true",
    deadlineSeconds: parseInt(process.env.X402_DEADLINE_SECONDS ?? "300"),
    demoMode: process.env.SELFHEAL_DEMO_MODE === "true",
  };
}

// --- Pricing Engine ---

export class PricingEngine {
  private tiers: PricingTier[];

  constructor(customTiers?: PricingTier[]) {
    this.tiers = customTiers ?? DEFAULT_PRICING;
  }

  /** Determine pricing tier from error context */
  getTier(errorMessage: string, statusCode?: number): PricingTier {
    const searchStr = `${statusCode ?? ""} ${errorMessage}`.toLowerCase();

    for (const tier of this.tiers) {
      if (tier.patterns.some((p) => searchStr.includes(p.toLowerCase()))) {
        return tier;
      }
    }

    // Default to moderate tier
    return this.tiers[1] ?? DEFAULT_PRICING[1];
  }
}

// --- Facilitator Client ---

export class FacilitatorClient {
  constructor(private facilitatorUrl: string) {}

  async verify(
    paymentHeader: string,
    expectedAmount: string,
    payTo: string,
  ): Promise<X402VerifyResult> {
    try {
      const resp = await fetch(`${this.facilitatorUrl}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment: paymentHeader,
          expectedAmount,
          payTo,
        }),
      });

      if (!resp.ok) {
        return { valid: false, invalidReason: `Facilitator error: ${resp.status}` };
      }

      return (await resp.json()) as X402VerifyResult;
    } catch (err) {
      return {
        valid: false,
        invalidReason: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async settle(
    paymentHeader: string,
    payTo: string,
  ): Promise<X402SettleResult> {
    try {
      const resp = await fetch(`${this.facilitatorUrl}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payment: paymentHeader,
          payTo,
        }),
      });

      if (!resp.ok) {
        return { success: false, error: `Facilitator settle error: ${resp.status}` };
      }

      return (await resp.json()) as X402SettleResult;
    } catch (err) {
      return {
        success: false,
        error: `Facilitator unreachable: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

// --- x402 Response Builder ---

export function build402Response(
  config: X402Config,
  pricing: PricingEngine,
  errorMessage: string,
  statusCode?: number,
  resource?: string,
): X402PaymentRequired {
  const tier = pricing.getTier(errorMessage, statusCode);
  const enabledNetworks = SUPPORTED_NETWORKS.filter((n) =>
    config.networks.includes(n.name),
  );

  const accepts: X402PaymentScheme[] = [];

  for (const net of enabledNetworks) {
    // Exact scheme — fixed base price
    accepts.push({
      scheme: "exact",
      network: net.name,
      maxAmountRequired: usdcToAtomic(tier.basePrice),
      resource: resource ?? "/api/heal",
      description: `SelfHeal: error analysis + structured fix + retry payload [${tier.name}]`,
      mimeType: "application/json",
      payTo: config.receivingWallet,
      requiredDeadlineSeconds: config.deadlineSeconds,
      extra: {
        name: "USDC",
        token: net.usdcToken,
      },
    });

    // Upto scheme — variable based on LLM token usage
    accepts.push({
      scheme: "upto",
      network: net.name,
      maxAmountRequired: usdcToAtomic(tier.maxPrice),
      resource: resource ?? "/api/heal",
      description: `SelfHeal: error analysis + structured fix + retry payload [${tier.name}, token-based]`,
      mimeType: "application/json",
      payTo: config.receivingWallet,
      requiredDeadlineSeconds: config.deadlineSeconds,
      extra: {
        name: "USDC",
        token: net.usdcToken,
      },
    });
  }

  return {
    x402Version: 1,
    accepts,
    error: `Payment required for error analysis. Tier: ${tier.name} ($${tier.basePrice}–$${tier.maxPrice} USDC). ${errorMessage}`,
  };
}

// --- Payment Extraction ---

/** Extract x402 payment proof from request headers */
export function extractPaymentProof(
  req: IncomingMessage,
): X402PaymentProof | null {
  // x402 spec: payment in X-PAYMENT or X-PAYMENT-RESPONSE header
  const paymentHeader =
    (req.headers["x-payment"] as string) ??
    (req.headers["x-payment-response"] as string);

  if (!paymentHeader) return null;

  // Detect scheme from payload structure
  let scheme: "exact" | "upto" = "exact";
  try {
    const decoded = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8"),
    );
    if (decoded.maxDebitAmount || decoded.scheme === "upto") {
      scheme = "upto";
    }
  } catch {
    // If not base64 JSON, treat as exact
  }

  return { payload: paymentHeader, scheme };
}

/** Write 402 response to HTTP response */
export function send402(
  res: ServerResponse,
  body: X402PaymentRequired,
): void {
  const json = JSON.stringify(body);
  res.writeHead(402, {
    "Content-Type": "application/json",
    "X-Payment-Required": "true",
    "Access-Control-Expose-Headers": "X-Payment-Required",
  });
  res.end(json);
}
