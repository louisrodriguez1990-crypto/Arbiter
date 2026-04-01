import { MODELS } from "@/lib/openrouter";

/** Node runtime so `.env.local` is reliably loaded in dev (Edge can miss env with some Next/Turbopack setups). */
export const dynamic = "force-dynamic";

export async function GET() {
  const key = process.env.OPENROUTER_API_KEY?.trim();

  if (!key) {
    return Response.json(
      {
        ok: false,
        keyLoaded: false,
        error: "OPENROUTER_API_KEY is missing or empty",
        hint: "Add OPENROUTER_API_KEY to .env.local in the project root (same folder as package.json), then restart `npm run dev`.",
      },
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    });

    const text = await res.text();
    if (!res.ok) {
      return Response.json(
        {
          ok: false,
          keyLoaded: true,
          openrouter: "error",
          httpStatus: res.status,
          error: text.slice(0, 500),
        },
        { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    return Response.json(
      {
        ok: true,
        keyLoaded: true,
        openrouter: "ok",
        modelsEndpoint: "reachable",
        defaultModel: MODELS.utility,
      },
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  } catch (err) {
    return Response.json(
      {
        ok: false,
        keyLoaded: true,
        openrouter: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }
}
