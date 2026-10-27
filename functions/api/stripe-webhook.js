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

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;

  const parts = signatureHeader.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signatures = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));

  if (!timestampPart || !signatures.length) return false;

  const timestamp = timestampPart.slice(2);
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${rawBody}`)
  );
  const expected = new Uint8Array(expectedBuffer);

  return signatures.some((sig) => {
    const actual = hexToBytes(sig);
    return actual ? timingSafeEqual(expected, actual) : false;
  });
}

function requireEnv(env) {
  const missing = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ].filter((name) => !env[name]);

  if (missing.length) {
    throw new Error(`Missing server configuration: ${missing.join(", ")}`);
  }
}

async function supabaseRequest(env, path, options = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : [];
}

async function markBallsSold(env, session) {
  const metadata = session.metadata || {};

  if (metadata.team_key !== TEAM_KEY) {
    return { ignored: true, reason: "Different fundraiser." };
  }

  if (session.payment_status !== "paid") {
    return { ignored: true, reason: "Payment not paid." };
  }

  const donationType = String(metadata.donation_type || "").trim();
  if (donationType !== "baseballs") {
    return { success: true, donationType: donationType || "general", updatedRows: 0 };
  }

  const playerId = String(metadata.player_id || "").trim();
  const baseballCsv = String(
    metadata.baseball_numbers || metadata.baseballs || ""
  ).trim();

  if (!playerId) throw new Error("Player ID missing from Stripe metadata.");
  if (!baseballCsv) throw new Error("Baseball numbers missing from Stripe metadata.");

  const baseballNumbers = [...new Set(
    baseballCsv
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 60)
  )].sort((a, b) => a - b);

  if (!baseballNumbers.length) {
    throw new Error("No valid baseball numbers found in Stripe metadata.");
  }

  const anonymous = metadata.anonymous === "true";
  let donorName = String(metadata.donor_name || "").trim();
  if (anonymous || !donorName) donorName = "Anonymous";

  const updated = await supabaseRequest(
    env,
    `baseballs?player_id=eq.${encodeURIComponent(playerId)}` +
      `&ball_number=in.(${baseballNumbers.join(",")})` +
      `&status=neq.sold`,
    {
      method: "PATCH",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        status: "sold",
        donor_name: donorName,
        sold_at: new Date().toISOString(),
        stripe_session_id: session.id,
        reserved_until: null,
      }),
    }
  );

  return {
    success: true,
    donationType: "baseballs",
    playerId,
    baseballNumbers,
    donorName,
    updatedRows: Array.isArray(updated) ? updated.length : 0,
  };
}

export async function onRequestPost({ request, env }) {
  try {
    requireEnv(env);

    const payload = await request.text();
    const signature = request.headers.get("stripe-signature");
    const valid = await verifyStripeSignature(
      payload,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );

    if (!valid) {
      return json({ success: false, error: "Invalid Stripe signature." }, 400);
    }

    const event = JSON.parse(payload);

    if (
      event.type !== "checkout.session.completed" &&
      event.type !== "checkout.session.async_payment_succeeded"
    ) {
      return json({ received: true, ignored: true, eventType: event.type });
    }

    const session = event.data?.object;
    if (!session) throw new Error("Stripe Checkout Session missing.");

    const result = await markBallsSold(env, session);
    return json({ received: true, ...result });
  } catch (error) {
    console.error("West Boca Stripe webhook error:", error);
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      500
    );
  }
}
