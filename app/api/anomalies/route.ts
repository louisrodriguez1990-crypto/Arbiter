export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { getFeedStats, listAnomalyFeed } from "@/lib/arbiter/repository";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : 20;

  return Response.json({
    ok: true,
    stats: getFeedStats(),
    anomalies: listAnomalyFeed(limit),
  });
}
