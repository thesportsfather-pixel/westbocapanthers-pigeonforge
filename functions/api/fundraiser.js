const TEAM_KEY = "west-boca-panthers";
const GOAL_DOLLARS = 1830;

function json(data, status = 200) {
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


function requireSupabase(env) {

  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {

    throw new Error(
      "Missing server configuration: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY"
    );

  }

}


async function supabaseGet(
  env,
  path
) {

  requireSupabase(env);


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
  env
}) {

  try {

    const url =
      new URL(
        request.url
      );


    const playerKey =
      String(
        url.searchParams.get(
          "player"
        ) || ""
      ).trim();


    if (!playerKey) {

      return json(
        {
          success: false,
          error:
            "A player is required."
        },
        400
      );

    }


    /*
     * Find West Boca Panthers team.
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
      !Array.isArray(teams) ||
      !teams.length
    ) {

      return json(
        {
          success: false,
          error:
            "West Boca Panthers team was not found."
        },
        404
      );

    }


    const team =
      teams[0];


    /*
     * Find player using team_id.
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
      !Array.isArray(players) ||
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
     * Load the player's 60 baseballs.
     */

    const baseballs =
      await supabaseGet(
        env,

        `baseballs` +
        `?player_id=eq.${encodeURIComponent(
          player.id
        )}` +
        `&select=id,ball_number,amount_cents,status,donor_name,sold_at,stripe_session_id` +
        `&order=ball_number.asc`
      );


    const normalized =
      (baseballs || [])
        .map(
          ball => {

            const number =
              Number(
                ball.ball_number
              );


            const amountCents =
              Number(
                ball.amount_cents
              ) ||
              number * 100;


            return {
              ...ball,

              ball_number:
                number,

              amount_cents:
                amountCents
            };

          }
        );


    const soldBalls =
      normalized.filter(
        ball =>
          ball.status ===
          "sold"
      );


    const raisedCents =
      soldBalls.reduce(
        (
          total,
          ball
        ) =>
          total +
          Number(
            ball.amount_cents ||
            0
          ),
        0
      );


    const raisedDollars =
      raisedCents /
      100;


    const progressPercent =
      GOAL_DOLLARS
        ? (
            raisedDollars /
            GOAL_DOLLARS
          ) * 100
        : 0;


    return json({

      success: true,

      team: {
        id:
          team.id,

        teamKey:
          team.team_key,

        teamName:
          team.team_name
      },

      player: {
        id:
          player.id,

        key:
          player.player_key,

        playerKey:
          player.player_key,

        name:
          player.player_name,

        playerName:
          player.player_name,

        number:
          player.player_number,

        playerNumber:
          player.player_number
      },

      baseballs:
        normalized,

      soldBalls:
        soldBalls,

      amountRaised:
        raisedDollars,

      goalAmount:
        GOAL_DOLLARS,

      progressPercent:
        progressPercent,

      totals: {
        soldCount:
          soldBalls.length,

        raisedCents:
          raisedCents,

        raisedDollars:
          raisedDollars,

        goalCents:
          GOAL_DOLLARS *
          100,

        goalDollars:
          GOAL_DOLLARS,

        remainingCount:
          Math.max(
            0,
            60 -
            soldBalls.length
          )
      }

    });


  } catch (
    error
  ) {

    console.error(
      "West Boca fundraiser API error:",
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
