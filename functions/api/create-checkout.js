const TEAM_KEY =
  "west-boca-panthers";


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "cache-control":
          "no-store"
      }
    }
  );

}


function requireEnvironment(
  env
) {

  const missing =
    [];


  if (
    !env.SUPABASE_URL
  ) {

    missing.push(
      "SUPABASE_URL"
    );

  }


  if (
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {

    missing.push(
      "SUPABASE_SERVICE_ROLE_KEY"
    );

  }


  if (
    !env.STRIPE_SECRET_KEY
  ) {

    missing.push(
      "STRIPE_SECRET_KEY"
    );

  }


  if (
    missing.length
  ) {

    throw new Error(
      `Missing server configuration: ${missing.join(
        ", "
      )}`
    );

  }

}


async function supabaseGet(
  env,
  path
) {

  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method:
          "GET",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json"
        }
      }
    );


  const text =
    await response.text();


  if (
    !response.ok
  ) {

    throw new Error(
      `Supabase ${response.status}: ${text}`
    );

  }


  return text
    ? JSON.parse(
        text
      )
    : [];

}


export async function onRequestPost({
  request,
  env
}) {

  try {

    requireEnvironment(
      env
    );


    const body =
      await request.json();


    const playerKey =
      String(
        body.playerKey ||
        body.player_key ||
        body.player_slug ||
        ""
      ).trim();


    const anonymous =
      body.anonymous ===
      true;


    let donorName =
      String(
        body.donorName ||
        body.donor_name ||
        ""
      )
        .trim()
        .replace(
          /\s+/g,
          " "
        );


    if (
      anonymous
    ) {

      donorName =
        "Anonymous";

    }


    if (
      !anonymous &&
      donorName.length <
      2
    ) {

      return json(
        {
          success: false,

          error:
            "Please enter a donor name or choose Anonymous."
        },
        400
      );

    }


    const rawBaseballs =
      Array.isArray(
        body.baseballs
      )
        ? body.baseballs
        : [];


    const baseballNumbers =
      Array.from(
        new Set(
          rawBaseballs
            .map(
              Number
            )
            .filter(
              number =>
                Number.isInteger(
                  number
                ) &&
                number >= 1 &&
                number <= 60
            )
        )
      ).sort(
        (a,b) =>
          a - b
      );


    if (
      !playerKey
    ) {

      return json(
        {
          success: false,

          error:
            "A player is required."
        },
        400
      );

    }


    if (
      !baseballNumbers.length
    ) {

      return json(
        {
          success: false,

          error:
            "Choose at least one baseball."
        },
        400
      );

    }


    /*
     * Resolve team.
     */

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
      !teams.length
    ) {

      return json(
        {
          success: false,
          error:
            "West Boca Panthers team not found."
        },
        404
      );

    }


    const team =
      teams[0];


    /*
     * Resolve player.
     */

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
        `&select=id,team_id,player_key,player_name,player_number` +
        `&limit=1`
      );


    if (
      !players.length
    ) {

      return json(
        {
          success: false,
          error:
            "Player not found."
        },
        404
      );

    }


    const player =
      players[0];


    /*
     * Confirm balls exist
     * and remain available.
     */

    const baseballs =
      await supabaseGet(
        env,

        `baseballs` +
        `?player_id=eq.${encodeURIComponent(
          player.id
        )}` +
        `&ball_number=in.(${baseballNumbers.join(
          ","
        )})` +
        `&select=id,ball_number,amount_cents,status`
      );


    if (
      baseballs.length !==
      baseballNumbers.length
    ) {

      return json(
        {
          success: false,

          error:
            "One or more selected baseballs could not be found."
        },
        409
      );

    }


    const unavailable =
      baseballs.filter(
        ball =>
          ball.status !==
          "available"
      );


    if (
      unavailable.length
    ) {

      return json(
        {
          success: false,

          error:
            `Baseball${unavailable.length === 1 ? "" : "s"} ` +
            `${unavailable.map(
              ball =>
                `#${ball.ball_number}`
            ).join(", ")} ` +
            `${unavailable.length === 1 ? "is" : "are"} no longer available.`
        },
        409
      );

    }


    /*
     * Ball number = donation dollars.
     */

    const amountCents =
      baseballNumbers.reduce(
        (
          total,
          number
        ) =>
          total +
          number * 100,
        0
      );


    if (
      amountCents <
      50
    ) {

      return json(
        {
          success: false,
          error:
            "Invalid checkout amount."
        },
        400
      );

    }


    const origin =
      new URL(
        request.url
      ).origin;


    const successUrl =
      `${origin}/fundraiser.html` +
      `?player=${encodeURIComponent(
        playerKey
      )}` +
      `&payment=success` +
      `&session_id={CHECKOUT_SESSION_ID}`;


    const cancelUrl =
      `${origin}/fundraiser.html` +
      `?player=${encodeURIComponent(
        playerKey
      )}` +
      `&payment=cancelled`;


    const params =
      new URLSearchParams();


    params.set(
      "mode",
      "payment"
    );


    params.set(
      "payment_method_types[0]",
      "card"
    );


    params.set(
      "success_url",
      successUrl
    );


    params.set(
      "cancel_url",
      cancelUrl
    );


    params.set(
      "line_items[0][price_data][currency]",
      "usd"
    );


    params.set(
      "line_items[0][price_data][product_data][name]",
      `West Boca Panthers - ${player.player_name} #${player.player_number}`
    );


    params.set(
      "line_items[0][price_data][product_data][description]",
      `Pigeon Forge Baseball${baseballNumbers.length === 1 ? "" : "s"} ` +
      `${baseballNumbers.map(
        n =>
          `#${n}`
      ).join(", ")}`
    );


    params.set(
      "line_items[0][price_data][unit_amount]",
      String(
        amountCents
      )
    );


    params.set(
      "line_items[0][quantity]",
      "1"
    );


    /*
     * Stripe metadata used by
     * webhook + verify-payment.
     */

    params.set(
      "metadata[team_key]",
      TEAM_KEY
    );


    params.set(
      "metadata[player_id]",
      String(
        player.id
      )
    );


    params.set(
      "metadata[player_key]",
      player.player_key
    );


    params.set(
      "metadata[player_name]",
      player.player_name
    );


    params.set(
      "metadata[player_number]",
      String(
        player.player_number
      )
    );


    params.set(
      "metadata[baseball_numbers]",
      baseballNumbers.join(
        ","
      )
    );


    params.set(
      "metadata[donor_name]",
      donorName
    );


    params.set(
      "metadata[anonymous]",
      anonymous
        ? "true"
        : "false"
    );


    params.set(
      "metadata[donation_type]",
      "baseballs"
    );


    params.set(
      "metadata[amount_cents]",
      String(
        amountCents
      )
    );


    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method:
            "POST",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "content-type":
              "application/x-www-form-urlencoded",

            accept:
              "application/json"
          },

          body:
            params.toString()
        }
      );


    const stripeText =
      await stripeResponse.text();


    let session;


    try {

      session =
        JSON.parse(
          stripeText
        );

    } catch {

      throw new Error(
        `Stripe returned an invalid response: ${stripeText}`
      );

    }


    if (
      !stripeResponse.ok
    ) {

      throw new Error(
        session?.error?.message ||
        "Unable to create Stripe checkout session."
      );

    }


    if (
      !session.url
    ) {

      throw new Error(
        "Stripe checkout URL was not returned."
      );

    }


    return json({
      success: true,

      url:
        session.url,

      sessionId:
        session.id
    });


  } catch (
    error
  ) {

    console.error(
      "West Boca create checkout error:",
      error
    );


    return json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(error)
      },
      500
    );

  }

}
