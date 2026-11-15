import { getAuthenticatedUser } from "./auth";
import { verifyStripeWebhookSignature } from "./crypto";
import type { Env, PlanTier } from "./types";

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  tagline: string;
  monthly_usd: number;
  yearly_usd: number;
  features: string[];
  highlighted?: boolean;
}

export const FYDE_PLANS: PlanDefinition[] = [
  {
    tier: "starter",
    name: "Starter",
    tagline: "Instant memory search & friend-to-friend drops",
    monthly_usd: 0,
    yearly_usd: 0,
    features: [
      "Private on-device photo, video & file search",
      "Up to 2 GB Direct fyde. drops every month",
      "Up to 3 Smart Circle passes",
      "iPhone, Mac & Web companion",
    ],
  },
  {
    tier: "pro",
    name: "fyde. Pro",
    tagline: "Unlimited full-res 4K video & trip circle drops",
    monthly_usd: 12,
    yearly_usd: 99,
    highlighted: true,
    features: [
      "Unlimited full-res photo & 4K video drops",
      "Unlimited Smart Circles (trip, place, or crew)",
      "Always-On Pass so friends can pull while you sleep",
      "One-sentence iMessage & Email bridge",
    ],
  },
  {
    tier: "family",
    name: "fyde. Crew",
    tagline: "Shared trust & Camera Roll sync for up to 6 people",
    monthly_usd: 19,
    yearly_usd: 159,
    features: [
      "Everything in fyde. Pro for up to 6 members",
      "Mutual Partner / Family auto-pull passes",
      "Automatic Camera Roll album saving",
      "Priority 4K video moment indexing",
    ],
  },
];

export async function handleBillingRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;

  if (path === "/api/billing/plans" && request.method === "GET") {
    return Response.json({
      plans: FYDE_PLANS,
      stripe_live: Boolean(env.STRIPE_SECRET_KEY),
      payment_methods: ["Apple Pay", "Google Pay", "Link", "Visa / Mastercard / Amex"],
    });
  }

  // Create Stripe Checkout Session (or Sandbox Upgrade when STRIPE_SECRET_KEY is not set in dev)
  if (path === "/api/billing/checkout" && request.method === "POST") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) {
      return Response.json({ error: "Please log in first to subscribe." }, { status: 401 });
    }

    const body = (await request.json()) as {
      tier?: PlanTier;
      interval?: "monthly" | "yearly";
    };
    const tier: PlanTier = body.tier === "family" ? "family" : "pro";
    const interval = body.interval === "yearly" ? "yearly" : "monthly";
    const planDef = FYDE_PLANS.find((p) => p.tier === tier)!;
    const appOrigin = env.PUBLIC_APP_URL || url.origin;

    // Live Stripe Checkout Session via REST API (supports Apple Pay, Google Pay, Cards automatically)
    if (env.STRIPE_SECRET_KEY) {
      const configuredPriceId =
        tier === "pro"
          ? interval === "yearly"
            ? env.STRIPE_PRICE_PRO_YEARLY
            : env.STRIPE_PRICE_PRO_MONTHLY
          : interval === "yearly"
            ? env.STRIPE_PRICE_FAMILY_YEARLY
            : env.STRIPE_PRICE_FAMILY_MONTHLY;

      const params = new URLSearchParams();
      params.set("mode", "subscription");
      params.set("customer_email", user.email);
      params.set("success_url", `${appOrigin}/?view=app&checkout=success&tier=${tier}`);
      params.set("cancel_url", `${appOrigin}/?view=app&checkout=cancelled`);
      params.set("metadata[user_id]", user.id);
      params.set("metadata[plan_tier]", tier);
      params.set("metadata[billing_interval]", interval);

      if (configuredPriceId) {
        params.set("line_items[0][price]", configuredPriceId);
        params.set("line_items[0][quantity]", "1");
      } else {
        // Inline dynamic price_data so Stripe Checkout works immediately with ONLY `STRIPE_SECRET_KEY`!
        const unitAmountCents = (interval === "yearly" ? planDef.yearly_usd : planDef.monthly_usd) * 100;
        params.set("line_items[0][price_data][currency]", "usd");
        params.set("line_items[0][price_data][product_data][name]", `${planDef.name} (${interval})`);
        params.set("line_items[0][price_data][unit_amount]", String(unitAmountCents));
        params.set(
          "line_items[0][price_data][recurring][interval]",
          interval === "yearly" ? "year" : "month"
        );
        params.set("line_items[0][quantity]", "1");
      }

      const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      });

      const session = (await stripeRes.json()) as { url?: string; error?: { message?: string } };
      if (!stripeRes.ok || !session.url) {
        return Response.json(
          { error: session.error?.message || "Failed to create Stripe Checkout session." },
          { status: 502 }
        );
      }
      return Response.json({ mode: "stripe_redirect", checkout_url: session.url });
    }

    // Local Dev / Preview Sandbox Activation when `STRIPE_SECRET_KEY` isn't configured yet
    await env.DB.prepare(
      "UPDATE users SET plan_tier = ?, billing_interval = ?, subscription_status = 'active_sandbox' WHERE id = ?"
    )
      .bind(tier, interval, user.id)
      .run();

    return Response.json({
      mode: "sandbox_activated",
      plan_tier: tier,
      billing_interval: interval,
      message: `Activated ${planDef.name} (${interval}) in sandbox mode. Set STRIPE_SECRET_KEY via wrangler secret for live Apple Pay / Card billing.`,
    });
  }

  // Stripe Customer Billing Portal
  if (path === "/api/billing/portal" && request.method === "POST") {
    const user = await getAuthenticatedUser(request, env);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ stripe_customer_id?: string }>();

    if (env.STRIPE_SECRET_KEY && row?.stripe_customer_id) {
      const appOrigin = env.PUBLIC_APP_URL || url.origin;
      const portalRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          customer: row.stripe_customer_id,
          return_url: `${appOrigin}/?view=app`,
        }),
      });
      const portal = (await portalRes.json()) as { url?: string };
      if (portal.url) {
        return Response.json({ portal_url: portal.url });
      }
    }

    // Downgrade/reset option in sandbox mode
    const body = (await request.json().catch(() => ({}))) as { downgrade_to_starter?: boolean };
    if (body.downgrade_to_starter) {
      await env.DB.prepare(
        "UPDATE users SET plan_tier = 'starter', subscription_status = 'canceled' WHERE id = ?"
      )
        .bind(user.id)
        .run();
      return Response.json({ downgraded: true, plan_tier: "starter" });
    }

    return Response.json({
      error: "No live Stripe customer attached yet (configure STRIPE_SECRET_KEY for live Billing Portal).",
    }, { status: 400 });
  }

  // Verified Stripe Webhook (`/api/billing/webhook`)
  if (path === "/api/billing/webhook" && request.method === "POST") {
    const rawBody = await request.text();
    const sig = request.headers.get("Stripe-Signature") || "";
    if (!env.STRIPE_WEBHOOK_SECRET) {
      return Response.json({ error: "STRIPE_WEBHOOK_SECRET not set" }, { status: 400 });
    }
    const valid = await verifyStripeWebhookSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) {
      return Response.json({ error: "Invalid Stripe signature" }, { status: 400 });
    }

    const event = JSON.parse(rawBody) as {
      type: string;
      data: { object: Record<string, any> };
    };
    const obj = event.data.object;

    if (event.type === "checkout.session.completed") {
      const userId = obj.metadata?.user_id;
      const tier = obj.metadata?.plan_tier || "pro";
      const interval = obj.metadata?.billing_interval || "monthly";
      if (userId) {
        await env.DB.prepare(
          `UPDATE users
           SET plan_tier = ?, billing_interval = ?, subscription_status = 'active',
               stripe_customer_id = ?, stripe_subscription_id = ?
           WHERE id = ?`
        )
          .bind(tier, interval, obj.customer || null, obj.subscription || null, userId)
          .run();
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subId = obj.id;
      if (subId) {
        await env.DB.prepare(
          "UPDATE users SET plan_tier = 'starter', subscription_status = 'canceled' WHERE stripe_subscription_id = ?"
        )
          .bind(subId)
          .run();
      }
    }

    return Response.json({ received: true });
  }

  return null;
}
