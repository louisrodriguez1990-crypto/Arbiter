import { getDb, withTransaction } from "@/lib/arbiter/db";
import { liquidationDomainModule } from "@/lib/arbiter/modules/liquidation";
import { calculateAnomalyScore } from "@/lib/arbiter/scoring";
import type {
  AnomalyFeedRow,
  CompData,
  DetectionSummary,
  DomainConfigRecord,
  NormalizedItem,
} from "@/lib/arbiter/types";

function toJson(value: unknown) {
  return JSON.stringify(value ?? {});
}

function fromJson<T>(value: string | null | undefined, fallback: T) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function ensureDefaultDomainConfig(): DomainConfigRecord {
  const db = getDb();
  const existing = db
    .prepare("SELECT domain, settings FROM domain_configs WHERE domain = ?")
    .get(liquidationDomainModule.id) as { domain: string; settings: string } | undefined;

  if (existing) {
    return {
      domain: existing.domain,
      settings: fromJson(existing.settings, liquidationDomainModule.thresholds),
    };
  }

  db.prepare(
    `INSERT INTO domain_configs (domain, settings, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)`
  ).run(liquidationDomainModule.id, toJson(liquidationDomainModule.thresholds));

  return {
    domain: liquidationDomainModule.id,
    settings: liquidationDomainModule.thresholds,
  };
}

export function insertItem(item: NormalizedItem) {
  withTransaction(() => {
    getDb()
      .prepare(
        `INSERT INTO items (
          id, domain, title, description, ask_price, currency, source, source_url,
          location, category, condition, metadata, ingested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(
        item.id,
        item.domain,
        item.title,
        item.description,
        item.askPrice,
        item.currency,
        item.source,
        item.sourceUrl,
        item.location ?? null,
        item.category,
        item.condition ?? null,
        toJson(item.metadata),
        item.ingestedAt
      );
  });
}

export function replaceComps(itemId: string, comps: CompData[]) {
  withTransaction(() => {
    const db = getDb();
    db.prepare("DELETE FROM comps WHERE item_id = ?").run(itemId);

    const insert = db.prepare(
      `INSERT INTO comps (
        id, item_id, source, query_text, title, price, sold_date, condition,
        confidence, source_url, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    );

    for (const comp of comps) {
      insert.run(
        comp.id,
        itemId,
        comp.source,
        comp.query ?? null,
        comp.title ?? null,
        comp.price,
        comp.soldDate ?? null,
        comp.condition ?? null,
        comp.confidence,
        comp.sourceUrl ?? null,
        toJson(comp.metadata)
      );
    }
  });
}

export function upsertAnomaly(item: NormalizedItem, summary: DetectionSummary) {
  const anomalyId = crypto.randomUUID();
  const anomalyScore = calculateAnomalyScore(summary);

  withTransaction(() => {
    const db = getDb();

    db.prepare("DELETE FROM anomalies WHERE item_id = ?").run(item.id);
    db.prepare(
      `INSERT INTO anomalies (
        id, item_id, domain, anomaly_score, gross_spread_pct, net_spread_pct, confidence_score,
        velocity_score, freshness_score, volume_score, estimated_fees_pct, comp_count, summary,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
      anomalyId,
      item.id,
      item.domain,
      anomalyScore,
      summary.grossSpreadPct,
      summary.netSpreadPct,
      summary.breakdown.confidenceScore,
      summary.breakdown.velocityScore,
      summary.breakdown.freshnessScore,
      summary.breakdown.volumeScore,
      summary.estimatedFeesPct,
      summary.compCount,
      toJson(summary)
    );
  });

  return anomalyId;
}

export function listAnomalyFeed(limit = 20): AnomalyFeedRow[] {
  const rows = getDb()
    .prepare(
      `SELECT
        a.id AS anomaly_id,
        a.item_id,
        a.domain,
        a.anomaly_score,
        a.gross_spread_pct,
        a.net_spread_pct,
        a.confidence_score,
        a.velocity_score,
        a.freshness_score,
        a.volume_score,
        a.comp_count,
        a.created_at,
        a.summary,
        i.title,
        i.source,
        i.source_url,
        i.ask_price,
        i.currency,
        i.location,
        i.category,
        i.condition
      FROM anomalies a
      JOIN items i ON i.id = a.item_id
      ORDER BY a.created_at DESC
      LIMIT ?`
    )
    .all(limit) as Array<{
      anomaly_id: string;
      item_id: string;
      domain: string;
      anomaly_score: number;
      gross_spread_pct: number;
      net_spread_pct: number;
      confidence_score: number;
      velocity_score: number;
      freshness_score: number;
      volume_score: number;
      comp_count: number;
      created_at: string;
      summary: string;
      title: string;
      source: string;
      source_url: string;
      ask_price: number;
      currency: string;
      location: string | null;
      category: string;
      condition: string | null;
    }>;

  return rows.map((row) => ({
    anomalyId: row.anomaly_id,
    itemId: row.item_id,
    domain: row.domain,
    title: row.title,
    source: row.source,
    sourceUrl: row.source_url,
    askPrice: row.ask_price,
    currency: row.currency,
    location: row.location ?? undefined,
    category: row.category,
    condition: row.condition ?? undefined,
    anomalyScore: row.anomaly_score,
    confidenceScore: row.confidence_score,
    velocityScore: row.velocity_score,
    freshnessScore: row.freshness_score,
    volumeScore: row.volume_score,
    grossSpreadPct: row.gross_spread_pct,
    netSpreadPct: row.net_spread_pct,
    compCount: row.comp_count,
    createdAt: row.created_at,
    summary: fromJson(row.summary, {
      estimatedGrossValue: 0,
      estimatedFunctionalValue: 0,
      estimatedNetValue: 0,
      estimatedNetProfit: 0,
      grossSpreadPct: 0,
      netSpreadPct: 0,
      functionalRate: 0.6,
      estimatedFeesPct: liquidationDomainModule.thresholds.estimatedFeesPct,
      compCount: 0,
      linesWithCoverage: 0,
      manifest: [],
      riskFlags: [],
      breakdown: {
        spreadScore: 0,
        confidenceScore: 0,
        velocityScore: 0,
        freshnessScore: 0,
        volumeScore: 0,
      },
    }),
  }));
}

export function getFeedStats() {
  const totals = getDb()
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM items) AS item_count,
        (SELECT COUNT(*) FROM anomalies) AS anomaly_count`
    )
    .get() as { item_count: number; anomaly_count: number } | undefined;

  return {
    itemCount: totals?.item_count ?? 0,
    anomalyCount: totals?.anomaly_count ?? 0,
    thresholds: ensureDefaultDomainConfig().settings,
  };
}
