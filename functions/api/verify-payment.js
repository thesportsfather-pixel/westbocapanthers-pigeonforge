const TEAM_KEY = "west-boca-panthers";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function requireEnv(env) {
  const missing = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "STRIPE_SECRET_KEY",
  ].filter((name) => !env[name]);

  if (missing.length) {
    throw new Error(`Missing server configuration: ${missing.join(", ")}`);
  }
}

async function supabasePatch(env, path, data) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

export async function onRequestGet({ request, env }) {
  try {
    requireEnv(env);

    const url = new URL(request.url);
    const sessionId = String(url.searchParams.get("session_id") || "").trim();
    if (!sessionId.startsWith("cs_")) {
      return json({ success: false, error: "A valid Stripe session_id is required." }, 400);
    }

    const stripeResponse = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {
        headers: {
          authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
          accept: "application/json",
        },
      }
    );

    const text = await stripeResponse.text();
    let session;
    try {
      session = JSON.parse(text);
    } catch {
      throw new Error(`Stripe returned an invalid response: ${text}`);
    }

    if (!stripeResponse.ok) {
      throw new Error(session?.error?.message || "Unable to retrieve Stripe session.");
    }

    if (session.payment_status !== "paid") {
      return json({ success: false, paid: false, error: "Payment is not marked paid yet." }, 409);
    }

    const metadata = session.metadata || {};
    if (metadata.team_key !== TEAM_KEY) {
      return json({ success: false, error: "This payment belongs to a different fundraiser." }, 400);
    }

    const donationType = String(metadata.donation_type || "").trim();
    if (donationType !== "baseballs") {
      return json({ success: true, paid: true, donationType: donationType || "general", updatedRows: 0 });
    }

    const playerId = String(metadata.player_id || "").trim();
    const baseballCsv = String(metadata.baseball_numbers || metadata.baseballs || "").trim();
    if (!playerId || !baseballCsv) {
      return json({ success: false, error: "Stripe metadata is missing player/baseball information." }, 400);
    }

    const baseballNumbers = [...new Set(
      baseballCsv
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 60)
    )].sort((a, b) => a - b);

    const anonymous = metadata.anonymous === "true";
    let donorName = String(metadata.donor_name || "").trim();
    if (anonymous || !donorName) donorName = "Anonymous";

    const updated = await supabasePatch(
      env,
      `baseballs?player_id=eq.${encodeURIComponent(playerId)}` +
        `&ball_number=in.(${baseballNumbers.join(",")})` +
        `&status=neq.sold`,
      {
        status: "sold",
        donor_name: donorName,
        sold_at: new Date().toISOString(),
        stripe_session_id: session.id,
        reserved_until: null,
      }
    );

    return json({
      success: true,
      paid: true,
      playerKey: metadata.player_key || null,
      baseballNumbers,
      donorName,
      updatedRows: Array.isArray(updated) ? updated.length : 0,
    });
  } catch (error) {
    console.error("West Boca verify-payment error:", error);
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      500
    );
  }
}
