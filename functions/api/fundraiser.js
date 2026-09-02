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


async function supabaseGet(
  env,
  path
) {
  const response =
    await fetch(
      `${env.SUPABASE_URL}/rest/v1/${path}`,
      {
        method: "GET",

        headers: {
          apikey:
            env.SUPABASE_SERVICE_ROLE_KEY,

          authorization:
            `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,

          accept:
            "application/json",
        },
      }
    );


  const text =
    await response.text();


  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }


  return text
    ? JSON.parse(text)
    : [];
}


export async function onRequestGet({
  request,
  env,
}) {
  try {

    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY
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


    const url =
      new URL(request.url);


    const playerKey =
      (
        url.searchParams.get("player") ||
        ""
      ).trim();


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
    // GET BASEBALLS
    // =====================================

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
          `&select=id,ball_number,amount_cents,status,donor_name,sold_at,stripe_session_id` +
          `&order=ball_number.asc`
      );


    const normalizedBaseballs =
      baseballs.map(
        ball => ({
          ...ball,

          amount_cents:
            Number(
              ball.amount_cents
            ) ||
            Number(
              ball.ball_number || 0
            ) * 100,
        })
      );


    // =====================================
    // BASEBALL TOTAL
    // =====================================

    const baseballRaisedCents =
      normalizedBaseballs.reduce(
        (
          total,
          ball
        ) => {

          if (
            ball.status !==
            "sold"
          ) {
            return total;
          }


          return (
            total +
            Number(
              ball.amount_cents || 0
            )
          );
        },
        0
      );


    const soldCount =
      normalizedBaseballs.filter(
        ball =>
          ball.status ===
          "sold"
      ).length;


    // =====================================
    // GENERAL DONATIONS
    // =====================================

    let generalDonationCents =
      0;


    try {

      const generalDonations =
        await supabaseGet(
          env,

          `orders` +
            `?team_id=eq.${encodeURIComponent(
              TEAM_KEY
            )}` +
            `&player_id=eq.${encodeURIComponent(
              player.id
            )}` +
            `&donation_type=eq.general` +
            `&status=eq.paid` +
            `&select=amount_cents`
        );


      generalDonationCents =
        generalDonations.reduce(
          (
            total,
            order
          ) =>
            total +
            Number(
              order.amount_cents || 0
            ),
          0
        );

    } catch (
      generalDonationError
    ) {

      console.warn(
        "Unable to load general donations:",
        generalDonationError
      );

    }


    // =====================================
    // FUNDRAISING TOTAL
    // =====================================

    const raisedCents =
      baseballRaisedCents +
      generalDonationCents;


    const goalCents =
      183000;


    const remainingCents =
      Math.max(
        0,
        goalCents -
          raisedCents
      );


    const progressPercent =
      Math.min(
        100,
        (
          raisedCents /
          goalCents
        ) * 100
      );


    // =====================================
    // RESPONSE
    // =====================================

    return json({
      success: true,

      team: {
        id:
          team.id,

        key:
          team.team_key,

        name:
          team.team_name,
      },

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
        normalizedBaseballs,

      totals: {
        goalCents,

        goalDollars:
          goalCents / 100,

        baseballRaisedCents,

        baseballRaisedDollars:
          baseballRaisedCents /
          100,

        generalDonationCents,

        generalDonationDollars:
          generalDonationCents /
          100,

        raisedCents,

        raisedDollars:
          raisedCents / 100,

        remainingCents,

        remainingDollars:
          remainingCents /
          100,

        progressPercent,

        soldCount,

        remainingCount:
          Math.max(
            0,
            60 -
              soldCount
          ),
      },
    });


  } catch (
    error
  ) {

    console.error(
      "West Boca Panthers fundraiser API error:",
      error
    );


    return json(
      {
        success: false,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );

  }
}
