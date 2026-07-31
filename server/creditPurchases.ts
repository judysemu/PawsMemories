import type { RequestHandler } from "express";
import type Stripe from "stripe";

import type { PurchasedCreditGrantResult } from "../db";
import { CREDIT_PACKS } from "../src/pricing";

export interface StripeCheckoutSessionLike {
  id: string;
  payment_status?: string | null;
  mode?: string | null;
  currency?: string | null;
  amount_total?: number | null;
  metadata?: Record<string, string> | null;
}

export type PurchasedCreditGrant = (
  phone: string,
  amount: number,
  stripeSessionId: string,
) => Promise<PurchasedCreditGrantResult>;

export interface FulfilledCreditPurchase extends PurchasedCreditGrantResult {
  credits: number;
  packId: string;
}

export class CreditPurchaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditPurchaseValidationError";
  }
}

/** Validate a paid Checkout session against server-owned pack and owner data. */
export async function fulfillCreditPurchaseSession(
  session: StripeCheckoutSessionLike,
  expectedOwner: string | undefined,
  grant: PurchasedCreditGrant,
): Promise<FulfilledCreditPurchase> {
  const metadata = session.metadata || {};
  if (metadata.type !== "credit_purchase") {
    throw new CreditPurchaseValidationError("Session is not a credit purchase.");
  }
  if (session.payment_status !== "paid" || session.mode !== "payment") {
    throw new CreditPurchaseValidationError("Credit purchase session is not paid.");
  }

  const owner = metadata.userPhone;
  if (!owner || (expectedOwner !== undefined && owner !== expectedOwner)) {
    throw new CreditPurchaseValidationError("Credit purchase owner does not match.");
  }

  const pack = CREDIT_PACKS.find((candidate) => candidate.id === metadata.packId);
  if (!pack) {
    throw new CreditPurchaseValidationError("Credit purchase pack is invalid.");
  }
  if (pack.comingSoon) {
    throw new CreditPurchaseValidationError("Credit purchase pack is unavailable.");
  }
  if (String(session.currency || "").toLowerCase() !== "usd") {
    throw new CreditPurchaseValidationError("Credit purchase must be paid in USD.");
  }
  const expectedAmount = Math.round(pack.price * 100);
  if (session.amount_total !== expectedAmount) {
    throw new CreditPurchaseValidationError("Credit purchase amount does not match the selected pack.");
  }

  const result = await grant(owner, pack.credits, session.id);
  return {
    ...result,
    credits: pack.credits,
    packId: pack.id,
  };
}

type CheckoutSessionCreator = {
  checkout: {
    sessions: {
      create(input: Stripe.Checkout.SessionCreateParams): Promise<{ url: string | null }>;
    };
  };
};

export function createCreditsSessionHandler(input: {
  stripe: CheckoutSessionCreator | null;
  appUrl: string;
}): RequestHandler {
  return async (req, res) => {
    try {
      const packId = req.body?.packId;
      const pack = CREDIT_PACKS.find((candidate) => candidate.id === packId && !candidate.comingSoon);
      if (!pack) {
        return res.status(400).json({ success: false, error: "Invalid credit pack selected." });
      }
      if (!input.stripe) {
        return res.status(503).json({
          success: false,
          error: "Credit purchases are temporarily unavailable.",
        });
      }

      const owner = (req as typeof req & { user?: { phone?: string } }).user?.phone;
      if (!owner) {
        return res.status(401).json({ success: false, error: "Authentication required." });
      }
      const session = await input.stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
          price_data: {
            currency: "usd",
            product_data: {
              name: `Paws & Memories — ${pack.label}`,
              description: `${pack.credits} AI creation credits`,
            },
            unit_amount: Math.round(pack.price * 100),
          },
          quantity: 1,
        }],
        mode: "payment",
        metadata: {
          type: "credit_purchase",
          userPhone: owner,
          packId: pack.id,
          creditsToAdd: String(pack.credits),
        },
        success_url: `${input.appUrl}/?credits_success=true&pack=${pack.id}&added=${pack.credits}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${input.appUrl}/?credits_cancelled=true`,
      });

      return res.json({ success: true, url: session.url, mode: "live_stripe" });
    } catch (error) {
      console.error("Error creating credits checkout session:", error);
      return res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : "Failed to initiate credit purchase.",
      });
    }
  };
}

export const retiredAlbumCheckoutHandler: RequestHandler = (_req, res) => {
  return res.status(410).json({
    success: false,
    error: "Photo album checkout is no longer available.",
  });
};

export function ignoreUnsupportedCheckoutSession(
  session: Pick<StripeCheckoutSessionLike, "id" | "metadata">,
  log: (message: string) => void = (message) => console.warn(message),
): "retired_album" | "unknown" {
  if (session.metadata?.type === "album_order") {
    log(`[Stripe] Retired album Checkout session ${session.id} acknowledged without fulfillment.`);
    return "retired_album";
  }
  log(`[Stripe] Unsupported Checkout session ${session.id} ignored.`);
  return "unknown";
}
