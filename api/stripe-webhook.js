
import crypto from "node:crypto";

export const config = {
  api: {
    bodyParser: false
  }
};

const SUPABASE_URL = "https://vszyugcnkwcrcdfncary.supabase.co";

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function verifyStripeSignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;

  const parts = signatureHeader.split(",");
  const timestamp = parts.find(p => p.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter(p => p.startsWith("v1="))
    .map(p => p.slice(3));

  if (!timestamp || signatures.length === 0) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return signatures.some(signature => {
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");

    return a.length === b.length &&
      crypto.timingSafeEqual(a, b);
  });
}

async function saveSubscription(subscription, forcedStatus) {
  const userId = subscription.metadata?.user_id;
  const selectedPlan = subscription.metadata?.plan;

  if (!userId || !["base", "premium"].includes(selectedPlan)) {
    throw new Error("Metadati utente o piano mancanti nell'abbonamento");
  }

  const status = forcedStatus || subscription.status;
  const plan = status === "active" || status === "trialing"
    ? selectedPlan
    : "free";

  const periodEnd = subscription.current_period_end
    ? new Date(subscription.current_period_end * 1000).toISOString()
    : null;

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/lumos_subscriptions?on_conflict=user_id`,
    {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify({
        user_id: userId,
        stripe_customer_id: subscription.customer,
        stripe_subscription_id: subscription.id,
        plan,
        status,
        current_period_end: periodEnd,
        updated_at: new Date().toISOString()
      })
    }
  );

  if (!response.ok) {
    throw new Error("Errore nel salvataggio dell'abbonamento su Supabase");
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!webhookSecret || !stripeKey ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).send("Configurazione mancante");
  }

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["stripe-signature"];

    if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
      return res.status(400).send("Firma Stripe non valida");
    }

    const event = JSON.parse(rawBody.toString("utf8"));

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      if (session.mode === "subscription" && session.subscription) {
        const subscriptionResponse = await fetch(
          `https://api.stripe.com/v1/subscriptions/${session.subscription}`,
          {
            headers: {
              Authorization: `Bearer ${stripeKey}`
            }
          }
        );

        const subscription = await subscriptionResponse.json();

        if (!subscriptionResponse.ok) {
          throw new Error("Impossibile recuperare l'abbonamento Stripe");
        }

        await saveSubscription(subscription);
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;

      await saveSubscription(
        subscription,
        event.type === "customer.subscription.deleted"
          ? "canceled"
          : undefined
      );
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Stripe webhook error:", error);
    return res.status(500).send("Errore webhook");
  }
}
