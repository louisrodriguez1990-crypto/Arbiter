export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { ingestManualLiquidationLot } from "@/lib/arbiter/manual-ingest";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await ingestManualLiquidationLot(body);

    return Response.json({
      ok: true,
      result,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Manual ingest failed.",
      },
      { status: 400 }
    );
  }
}
