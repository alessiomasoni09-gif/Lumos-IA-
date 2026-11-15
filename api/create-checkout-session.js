
const SUPABASE_URL = "https://vszyugcnkwcrcdfncary.supabase.co";
const SITE_URL = "https://lumos-ia-livid.vercel.app";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito" });
  }

  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!stripeKey || !supabaseKey) {
      return res.status(500).json({
        error: "Configurazione del server incompleta"
      });
    }

    const authorization = req.headers.authorization || "";
    const accessToken = authorization.replace(/^Bearer\s+/i, "");

    if (!accessToken) {
      return res.status(401).json({
        error: "Devi effettuare l'accesso"
      });
    }

    // Verifica l'identità dell'utente tramite Supabase
    const userResponse = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    if (!userResponse.ok) {
      return res.status(401).json({
        error: "Sessione non valida"
      });
    }

    const user = await userResponse.json();

    const body = typeof req.body === "string"
      ? JSON.parse(req.body)
      : req.body || {};

    const plan = body.plan;

    let priceId;

    if (plan === "base") {
      priceId = process.env.STRIPE_BASE_PRICE_ID;
    } else if (plan === "premium") {
      priceId = process.env.STRIPE_PREMIUM_PRICE_ID;
    } else {
      return res.status(400).json({
        error: "Piano non valido"
      });
    }

    if (!priceId) {
      return res.status(500).json({
        error: "Prezzo Stripe non configurato"
      });
    }

    // Crea la sessione di pagamento
    const form = new URLSearchParams();

    form.set("mode", "subscription");
    form.set("line_items[0][price]", priceId);
    form.set("line_items[0][quantity]", "1");

    form.set(
      "success_url",
      `${SITE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`
    );

    form.set("cancel_url", `${SITE_URL}/?checkout=cancel`);

    form.set("client_reference_id", user.id);
    form.set("metadata[user_id]", user.id);
    form.set("metadata[plan]", plan);
    form.set("subscription_data[metadata][user_id]", user.id);
    form.set("subscription_data[metadata][plan]", plan);

    if (user.email) {
      form.set("customer_email", user.email);
    }

    const stripeResponse = await fetch(
      "https://api.stripe.com/v1/checkout/sessions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: form
      }
    );

    const session = await stripeResponse.json();

    if (!stripeResponse.ok) {
      console.error("Stripe error:", session);
      return res.status(500).json({
        error: "Impossibile creare il pagamento"
      });
    }

    return res.status(200).json({
      url: session.url
    });

  } catch (error) {
    console.error("Checkout error:", error);

    return res.status(500).json({
      error: "Errore interno durante il pagamento"
    });
  }
}
