function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const TEAM_KEY = "west-boca-panthers";

async function supabaseGet(env, path) {
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "GET",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        accept: "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

async function stripeCreateCheckoutSession(
  env,
  params
) {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null
    ) {
      body.append(
        key,
        String(value)
      );
    }
  }

  const response = await fetch(
    "https://api.stripe.com/v1/checkout/sessions",
    {
      method: "POST",

      headers: {
        authorization:
          `Bearer ${env.STRIPE_SECRET_KEY}`,

        "content-type":
          "application/x-www-form-urlencoded",
      },

      body,
    }
  );

  const text =
    await response.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(
      `Stripe ${response.status}: ${
        data?.error?.message ||
        text ||
        "Unable to create checkout."
      }`
    );
  }

  return data;
}

export async function onRequestPost({
  request,
  env,
}) {
  try {

    // =====================================
    // REQUIRED CONFIGURATION
    // =====================================

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.STRIPE_SECRET_KEY ||
      !env.SITE_URL
    ) {
      return json(
        {
          success: false,
          error:
            "Missing server configuration.",
        },
        500
      );
    }


    // =====================================
    // READ REQUEST
    // =====================================

    let body;

    try {
      body =
        await request.json();
    } catch {
      return json(
        {
          success: false,
          error:
            "Invalid request body.",
        },
        400
      );
    }


    const playerKey =
      String(
        body.playerKey ??
        body.player_key ??
        body.player ??
        ""
      ).trim();


    const anonymous =
      body.anonymous === true ||
      body.anonymous === "true";


    const enteredDonorName =
      String(
        body.donorName ??
        body.donor_name ??
        ""
      ).trim();


    const donorName =
      anonymous
        ? "Anonymous"
        : enteredDonorName;


    if (!playerKey) {
      return json(
        {
          success: false,
          error:
            "A player is required.",
        },
        400
      );
    }


    if (
      !anonymous &&
      !donorName
    ) {
      return json(
        {
          success: false,
          error:
            "Enter a donor name or choose Anonymous.",
        },
        400
      );
    }


    // =====================================
    // NORMALIZE SELECTED BASEBALLS
    // =====================================

    const incomingBaseballs =
      body.baseballs ??
      body.ballNumbers ??
      body.ball_numbers ??
      [];


    let baseballNumbers = [];


    if (
      Array.isArray(
        incomingBaseballs
      )
    ) {

      baseballNumbers =
        incomingBaseballs;

    } else if (
      typeof incomingBaseballs ===
      "string"
    ) {

      baseballNumbers =
        incomingBaseballs.split(",");

    }


    baseballNumbers =
      [
        ...new Set(
          baseballNumbers
            .map(value =>
              Number(value)
            )
            .filter(value =>
              Number.isInteger(value) &&
              value >= 1 &&
              value <= 60
            )
        ),
      ].sort(
        (a, b) =>
          a - b
      );


    if (
      baseballNumbers.length === 0
    ) {
      return json(
        {
          success: false,
          error:
            "Choose at least one baseball.",
        },
        400
      );
    }


    // =====================================
    // FIND TEAM
    // =====================================

    const teams =
      await supabaseGet(
        env,

        `teams` +
          `?team_key=eq.${encodeURIComponent(
            TEAM_KEY
          )}` +
          `&select=id,team_key,team_name` +
          `&limit=1`
      );


    if (
      !Array.isArray(teams) ||
      teams.length === 0
    ) {
      return json(
        {
          success: false,
          error:
            "Team not found.",
        },
        404
      );
    }


    const team =
      teams[0];


    // =====================================
    // FIND PLAYER
    // =====================================

    const players =
      await supabaseGet(
        env,

        `players` +
          `?team_id=eq.${encodeURIComponent(
            team.id
          )}` +
          `&player_key=eq.${encodeURIComponent(
            playerKey
          )}` +
          `&select=id,player_key,player_name,player_number` +
          `&limit=1`
      );


    if (
      !Array.isArray(players) ||
      players.length === 0
    ) {
      return json(
        {
          success: false,
          error:
            "Player not found.",
        },
        404
      );
    }


    const player =
      players[0];


    // =====================================
    // CHECK BASEBALL AVAILABILITY
    // =====================================

    const baseballQuery =
      baseballNumbers.join(",");


    const baseballs =
      await supabaseGet(
        env,

        `baseballs` +
          `?team_id=eq.${encodeURIComponent(
            TEAM_KEY
          )}` +
          `&player_id=eq.${encodeURIComponent(
            player.id
          )}` +
          `&ball_number=in.(${baseballQuery})` +
          `&select=id,ball_number,amount_cents,status` +
          `&order=ball_number.asc`
      );


    const baseballMap =
      new Map(
        baseballs.map(
          ball => [
            Number(
              ball.ball_number
            ),
            ball,
          ]
        )
      );


    const unavailable =
      baseballNumbers.filter(
        ballNumber => {

          const ball =
            baseballMap.get(
              ballNumber
            );

          return (
            !ball ||
            ball.status !==
              "available"
          );

        }
      );


    if (
      unavailable.length > 0
    ) {
      return json(
        {
          success: false,

          error:
            `These baseballs are no longer available: ${
              unavailable
                .map(number =>
                  `#${number}`
                )
                .join(", ")
            }. Please refresh and choose again.`,

          unavailable,
        },
        409
      );
    }


    // =====================================
    // CALCULATE DONATION
    // =====================================

    const amountCents =
      baseballNumbers.reduce(
        (
          total,
          ballNumber
        ) =>
          total +
          ballNumber * 100,
        0
      );


    if (
      amountCents <= 0
    ) {
      return json(
        {
          success: false,
          error:
            "Invalid donation amount.",
        },
        400
      );
    }


    // =====================================
    // RETURN URLS
    // =====================================

    const siteUrl =
      String(
        env.SITE_URL
      ).replace(
        /\/+$/,
        ""
      );


    const successUrl =
      `${siteUrl}/fundraiser.html` +
      `?player=${encodeURIComponent(
        player.player_key
      )}` +
      `&payment=success` +
      `&session_id={CHECKOUT_SESSION_ID}`;


    const cancelUrl =
      `${siteUrl}/fundraiser.html` +
      `?player=${encodeURIComponent(
        player.player_key
      )}` +
      `&payment=cancelled`;


    // =====================================
    // CREATE STRIPE CHECKOUT
    // =====================================

    const baseballDescription =
      baseballNumbers
        .map(number =>
          `#${number}`
        )
        .join(", ");


    const session =
      await stripeCreateCheckoutSession(
        env,
        {
          mode:
            "payment",

          "payment_method_types[0]":
            "card",

          "line_items[0][price_data][currency]":
            "usd",

          "line_items[0][price_data][product_data][name]":
            `West Boca Travel Panthers — ${player.player_name} #${player.player_number}`,

          "line_items[0][price_data][product_data][description]":
            `Baseballs ${baseballDescription}`,

          "line_items[0][price_data][unit_amount]":
            amountCents,

          "line_items[0][quantity]":
            1,

          success_url:
            successUrl,

          cancel_url:
            cancelUrl,

          "metadata[team_key]":
            TEAM_KEY,

          "metadata[player_id]":
            player.id,

          "metadata[player_key]":
            player.player_key,

          "metadata[player_name]":
            player.player_name,

          "metadata[player_number]":
            player.player_number,

          "metadata[donation_type]":
            "baseballs",

          "metadata[baseballs]":
            baseballNumbers.join(","),

          "metadata[donor_name]":
            donorName,

          "metadata[anonymous]":
            anonymous
              ? "true"
              : "false",

          "metadata[amount_cents]":
            amountCents,
        }
      );


    if (
      !session?.url
    ) {
      throw new Error(
        "Stripe did not return a checkout URL."
      );
    }


    // =====================================
    // IMPORTANT:
    // NO BASEBALL IS MARKED SOLD HERE.
    //
    // The Stripe webhook will mark the
    // baseballs sold only after payment.
    // =====================================

    return json({
      success: true,

      url:
        session.url,

      sessionId:
        session.id,

      player: {
        id:
          player.id,

        key:
          player.player_key,

        name:
          player.player_name,

        number:
          player.player_number,
      },

      baseballs:
        baseballNumbers,

      amountCents,

      amountDollars:
        amountCents / 100,

      donorName,
    });


  } catch (error) {

    console.error(
      "West Boca Panthers create checkout error:",
      error
    );


    return json(
      {
        success: false,

        error:
          "Unable to create checkout.",

        details:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );

  }
}
