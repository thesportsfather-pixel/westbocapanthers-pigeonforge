function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type":
        "application/json; charset=utf-8",
      "cache-control":
        "no-store",
    },
  });
}

const TEAM_KEY =
  "west-boca-panthers";


// =====================================
// VERIFY STRIPE SIGNATURE
// =====================================

async function verifyStripeSignature(
  payload,
  signature,
  secret
) {
  if (
    !signature ||
    !secret
  ) {
    return false;
  }

  const parts =
    signature.split(",");

  const timestampPart =
    parts.find(
      part =>
        part.startsWith("t=")
    );

  const signatures =
    parts
      .filter(
        part =>
          part.startsWith("v1=")
      )
      .map(
        part =>
          part.slice(3)
      );

  if (
    !timestampPart ||
    signatures.length === 0
  ) {
    return false;
  }

  const timestamp =
    timestampPart.slice(2);

  const signedPayload =
    `${timestamp}.${payload}`;

  const encoder =
    new TextEncoder();

  const key =
    await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      {
        name:
          "HMAC",
        hash:
          "SHA-256",
      },
      false,
      ["sign"]
    );

  const signatureBuffer =
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(
        signedPayload
      )
    );

  const expectedSignature =
    Array.from(
      new Uint8Array(
        signatureBuffer
      )
    )
      .map(
        byte =>
          byte
            .toString(16)
            .padStart(2, "0")
      )
      .join("");

  return signatures.some(
    stripeSignature =>
      stripeSignature ===
      expectedSignature
  );
}


// =====================================
// SUPABASE REQUEST
// =====================================

async function supabaseRequest(
  env,
  path,
  options = {}
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        ...options,

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          "content-type":
            "application/json",

          accept:
            "application/json",

          ...(options.headers || {}),
        },
      }
    );

  const text =
    await response.text();

  let data = null;

  if (text) {
    try {
      data =
        JSON.parse(text);
    } catch {
      data =
        text;
    }
  }

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${
        typeof data ===
        "string"
          ? data
          : JSON.stringify(
              data
            )
      }`
    );
  }

  return data;
}


// =====================================
// CHECK FOR EXISTING ORDER
// =====================================

async function findExistingOrder(
  env,
  stripeSessionId
) {
  return supabaseRequest(
    env,

    `orders` +
      `?stripe_session_id=eq.${encodeURIComponent(
        stripeSessionId
      )}` +
      `&select=id,stripe_session_id` +
      `&limit=1`
  );
}


// =====================================
// GET ONE BASEBALL
// =====================================

async function getBaseball(
  env,
  playerId,
  ballNumber
) {
  return supabaseRequest(
    env,

    `baseballs` +
      `?team_id=eq.${encodeURIComponent(
        TEAM_KEY
      )}` +
      `&player_id=eq.${encodeURIComponent(
        playerId
      )}` +
      `&ball_number=eq.${encodeURIComponent(
        ballNumber
      )}` +
      `&select=id,ball_number,status,stripe_session_id` +
      `&limit=1`
  );
}


// =====================================
// MARK BASEBALL SOLD
// RETRY SAFE
// =====================================

async function processBaseball(
  env,
  {
    playerId,
    ballNumber,
    donorName,
    stripeSessionId,
  }
) {

  const rows =
    await getBaseball(
      env,
      playerId,
      ballNumber
    );

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    throw new Error(
      `Baseball #${ballNumber} was not found.`
    );
  }


  const ball =
    rows[0];


  // -------------------------------------
  // ALREADY SOLD BY THIS SAME SESSION
  //
  // This means Stripe is retrying a
  // webhook that partially succeeded.
  // That is safe — continue.
  // -------------------------------------

  if (
    ball.status ===
      "sold" &&
    ball.stripe_session_id ===
      stripeSessionId
  ) {
    return {
      alreadySold:
        true,
    };
  }


  // -------------------------------------
  // SOLD BY A DIFFERENT PAYMENT
  // -------------------------------------

  if (
    ball.status ===
      "sold"
  ) {
    throw new Error(
      `Baseball #${ballNumber} is already sold by another Stripe session.`
    );
  }


  // -------------------------------------
  // MUST STILL BE AVAILABLE
  // -------------------------------------

  if (
    ball.status !==
      "available"
  ) {
    throw new Error(
      `Baseball #${ballNumber} is not available.`
    );
  }


  // -------------------------------------
  // MARK SOLD
  // -------------------------------------

  const updated =
    await supabaseRequest(
      env,

      `baseballs` +
        `?id=eq.${encodeURIComponent(
          ball.id
        )}` +
        `&status=eq.available`,

      {
        method:
          "PATCH",

        headers: {
          Prefer:
            "return=representation",
        },

        body:
          JSON.stringify({
            status:
              "sold",

            donor_name:
              donorName,

            sold_at:
              new Date()
                .toISOString(),

            stripe_session_id:
              stripeSessionId,

            reserved_until:
              null,

            reservation_id:
              null,
          }),
      }
    );


  if (
    !Array.isArray(updated) ||
    updated.length !== 1
  ) {
    /*
     * Another request may have changed
     * the baseball between our GET and
     * PATCH.
     *
     * Read it again before deciding
     * whether this is actually an error.
     */

    const retryRows =
      await getBaseball(
        env,
        playerId,
        ballNumber
      );


    const retryBall =
      Array.isArray(
        retryRows
      )
        ? retryRows[0]
        : null;


    if (
      retryBall &&
      retryBall.status ===
        "sold" &&
      retryBall.stripe_session_id ===
        stripeSessionId
    ) {
      return {
        alreadySold:
          true,
      };
    }


    throw new Error(
      `Baseball #${ballNumber} could not be marked sold.`
    );
  }


  return {
    sold:
      true,
  };
}


// =====================================
// CREATE PAID ORDER
// =====================================

async function createPaidOrder(
  env,
  {
    playerId,
    donationType,
    amountCents,
    stripeSessionId,
    donorName,
  }
) {
  return supabaseRequest(
    env,
    "orders",
    {
      method:
        "POST",

      headers: {
        Prefer:
          "return=representation",
      },

      body:
        JSON.stringify({
          team_id:
            TEAM_KEY,

          player_id:
            playerId,

          donation_type:
            donationType,

          status:
            "paid",

          stripe_session_id:
            stripeSessionId,

          donor_name:
            donorName,

          amount_cents:
            amountCents,

          // IMPORTANT:
          // orders.total_cents is NOT NULL
          total_cents:
            amountCents,
        }),
    }
  );
}


// =====================================
// WEBHOOK
// =====================================

export async function onRequestPost({
  request,
  env,
}) {
  try {

    // =================================
    // CONFIGURATION
    // =================================

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_WEBHOOK_SECRET
    ) {
      return json(
        {
          success:
            false,

          error:
            "Missing webhook configuration.",
        },
        500
      );
    }


    // =================================
    // VERIFY STRIPE
    // =================================

    const payload =
      await request.text();


    const signature =
      request.headers.get(
        "stripe-signature"
      );


    const validSignature =
      await verifyStripeSignature(
        payload,
        signature,
        env.STRIPE_WEBHOOK_SECRET
      );


    if (!validSignature) {
      return json(
        {
          success:
            false,

          error:
            "Invalid Stripe signature.",
        },
        400
      );
    }


    const event =
      JSON.parse(
        payload
      );


    // =================================
    // ONLY CHECKOUT COMPLETED
    // =================================

    if (
      event.type !==
      "checkout.session.completed"
    ) {
      return json({
        success:
          true,

        ignored:
          true,

        event:
          event.type,
      });
    }


    const session =
      event.data?.object;


    if (!session) {
      throw new Error(
        "Stripe Checkout Session missing."
      );
    }


    // =================================
    // PAYMENT MUST BE PAID
    // =================================

    if (
      session.payment_status !==
      "paid"
    ) {
      return json({
        success:
          true,

        ignored:
          true,

        reason:
          "Payment not paid.",
      });
    }


    const metadata =
      session.metadata || {};


    // =================================
    // IGNORE OTHER FUNDRAISERS
    // =================================

    if (
      metadata.team_key !==
      TEAM_KEY
    ) {
      return json({
        success:
          true,

        ignored:
          true,

        reason:
          "Different fundraiser.",
      });
    }


    // =================================
    // METADATA
    // =================================

    const stripeSessionId =
      String(
        session.id ||
        ""
      ).trim();


    const playerId =
      String(
        metadata.player_id ||
        ""
      ).trim();


    const donationType =
      String(
        metadata.donation_type ||
        ""
      ).trim();


    const donorName =
      String(
        metadata.donor_name ||
        "Anonymous"
      ).trim() ||
      "Anonymous";


    const amountCents =
      Number(
        session.amount_total ||
        metadata.amount_cents ||
        0
      );


    if (
      !stripeSessionId
    ) {
      throw new Error(
        "Stripe session ID missing."
      );
    }


    if (!playerId) {
      throw new Error(
        "Player ID missing from Stripe metadata."
      );
    }


    if (
      !Number.isFinite(
        amountCents
      ) ||
      amountCents <= 0
    ) {
      throw new Error(
        "Invalid Stripe payment amount."
      );
    }


    // =================================
    // HAS ORDER ALREADY BEEN SAVED?
    // =================================

    const existingOrders =
      await findExistingOrder(
        env,
        stripeSessionId
      );


    if (
      Array.isArray(
        existingOrders
      ) &&
      existingOrders.length >
        0
    ) {
      return json({
        success:
          true,

        alreadyProcessed:
          true,

        stripeSessionId,
      });
    }


    // =================================
    // BASEBALL DONATION
    // =================================

    if (
      donationType ===
      "baseballs"
    ) {

      const baseballNumbers =
        [
          ...new Set(
            String(
              metadata.baseballs ||
              ""
            )
              .split(",")
              .map(
                value =>
                  Number(
                    value.trim()
                  )
              )
              .filter(
                number =>
                  Number.isInteger(
                    number
                  ) &&
                  number >= 1 &&
                  number <= 60
              )
          ),
        ].sort(
          (a, b) =>
            a - b
        );


      if (
        baseballNumbers.length ===
        0
      ) {
        throw new Error(
          "No valid baseballs found in Stripe metadata."
        );
      }


      // ---------------------------------
      // PROCESS EVERY BALL
      // ---------------------------------

      for (
        const ballNumber of
          baseballNumbers
      ) {

        await processBaseball(
          env,
          {
            playerId,
            ballNumber,
            donorName,
            stripeSessionId,
          }
        );

      }


      // ---------------------------------
      // SAVE PAID ORDER
      //
      // This intentionally happens AFTER
      // the baseball updates.
      //
      // If the insert fails, Stripe can
      // retry and the same-session sold
      // baseballs will be accepted.
      // ---------------------------------

      await createPaidOrder(
        env,
        {
          playerId,

          donationType:
            "baseballs",

          amountCents,

          stripeSessionId,

          donorName,
        }
      );


      return json({
        success:
          true,

        donationType:
          "baseballs",

        baseballs:
          baseballNumbers,

        amountCents,

        stripeSessionId,
      });
    }


    // =================================
    // GENERAL PLAYER DONATION
    // =================================

    if (
      donationType ===
      "general"
    ) {

      await createPaidOrder(
        env,
        {
          playerId,

          donationType:
            "general",

          amountCents,

          stripeSessionId,

          donorName,
        }
      );


      return json({
        success:
          true,

        donationType:
          "general",

        amountCents,

        stripeSessionId,
      });
    }


    // =================================
    // UNKNOWN TYPE
    // =================================

    return json({
      success:
        true,

      ignored:
        true,

      reason:
        "Unknown donation type.",
    });


  } catch (error) {

    console.error(
      "West Boca Panthers Stripe webhook error:",
      error
    );


    return json(
      {
        success:
          false,

        error:
          "Webhook processing failed.",

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );

  }
}
