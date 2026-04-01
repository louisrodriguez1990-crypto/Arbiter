import { getFunctionalRate, getManifestLines, liquidationDomainModule } from "@/lib/arbiter/modules/liquidation";
import type {
  CompData,
  DetectionSummary,
  DomainThresholds,
  ManifestCompRollup,
  NormalizedItem,
} from "@/lib/arbiter/types";

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[midpoint]
    : (sorted[midpoint - 1] + sorted[midpoint]) / 2;
}

function getRiskFlags(item: NormalizedItem, manifest: ManifestCompRollup[]) {
  const flags = new Set<string>();

  if (!item.condition) {
    flags.add("condition_unknown");
  }

  if (manifest.some((line) => line.sampleCount === 0)) {
    flags.add("sparse_comp_coverage");
  }

  if (manifest.length === 0) {
    flags.add("manifest_incomplete");
  }

  const functionalRate = getFunctionalRate(item);
  if (functionalRate < 0.65) {
    flags.add("functional_rate_assumption");
  }

  const dominantLine = [...manifest].sort((a, b) => b.extendedValue - a.extendedValue)[0];
  const totalValue = manifest.reduce((sum, line) => sum + line.extendedValue, 0);
  if (dominantLine && totalValue > 0 && dominantLine.extendedValue / totalValue > 0.65) {
    flags.add("high_single_sku_concentration");
  }

  return [...flags];
}

export function calculateDetectionSummary(
  item: NormalizedItem,
  comps: CompData[],
  thresholds: DomainThresholds = liquidationDomainModule.thresholds
): DetectionSummary {
  const manifestLines = getManifestLines(item);

  const manifest: ManifestCompRollup[] = manifestLines.map((line) => {
    const lineComps = comps.filter(
      (comp) =>
        comp.metadata &&
        typeof comp.metadata.manifestLineId === "string" &&
        comp.metadata.manifestLineId === line.id
    );
    const prices = lineComps.map((comp) => comp.price);
    const medianPrice = median(prices);

    return {
      manifestLineId: line.id,
      title: line.title,
      query: line.query,
      quantity: line.quantity,
      medianPrice,
      sampleCount: lineComps.length,
      sampleUrls: lineComps
        .map((comp) => comp.sourceUrl)
        .filter((url): url is string => Boolean(url))
        .slice(0, 3),
      extendedValue: round((medianPrice ?? 0) * line.quantity),
    };
  });

  const estimatedGrossValue = round(manifest.reduce((sum, line) => sum + line.extendedValue, 0));
  const functionalRate = getFunctionalRate(item);
  const estimatedFunctionalValue = round(estimatedGrossValue * functionalRate);
  const estimatedNetValue = round(estimatedFunctionalValue * (1 - thresholds.estimatedFeesPct));
  const estimatedNetProfit = round(estimatedNetValue - item.askPrice);
  const grossSpreadPct = item.askPrice > 0 ? round((estimatedGrossValue - item.askPrice) / item.askPrice) : 0;
  const netSpreadPct = item.askPrice > 0 ? round(estimatedNetProfit / item.askPrice) : 0;
  const compCount = comps.length;
  const linesWithCoverage = manifest.filter((line) => line.sampleCount > 0).length;

  const confidenceScore = clamp(
    (linesWithCoverage / Math.max(manifest.length, 1)) * 0.65 + (Math.min(compCount, 20) / 20) * 0.35,
    0,
    1
  );
  const velocityScore = clamp(
    manifest.length === 0
      ? 0
      : manifest.reduce((sum, line) => sum + Math.min(line.sampleCount, 10) / 10, 0) / manifest.length,
    0,
    1
  );
  const freshnessScore = 1;
  const volumeScore = clamp(compCount / Math.max(manifest.length * 6, 6), 0, 1);
  const spreadScore = clamp(netSpreadPct / 1.5, 0, 1);

  return {
    estimatedGrossValue,
    estimatedFunctionalValue,
    estimatedNetValue,
    estimatedNetProfit,
    grossSpreadPct,
    netSpreadPct,
    functionalRate,
    estimatedFeesPct: thresholds.estimatedFeesPct,
    compCount,
    linesWithCoverage,
    manifest,
    riskFlags: getRiskFlags(item, manifest),
    breakdown: {
      spreadScore: round(spreadScore, 4),
      confidenceScore: round(confidenceScore, 4),
      velocityScore: round(velocityScore, 4),
      freshnessScore: round(freshnessScore, 4),
      volumeScore: round(volumeScore, 4),
    },
  };
}

export function calculateAnomalyScore(summary: DetectionSummary) {
  const {
    spreadScore,
    confidenceScore,
    velocityScore,
    freshnessScore,
    volumeScore,
  } = summary.breakdown;

  return Math.round(
    100 *
      (spreadScore * 0.45 +
        confidenceScore * 0.2 +
        velocityScore * 0.15 +
        freshnessScore * 0.1 +
        volumeScore * 0.1)
  );
}

export function meetsDetectionThreshold(
  summary: DetectionSummary,
  thresholds: DomainThresholds = liquidationDomainModule.thresholds
) {
  return (
    summary.netSpreadPct >= thresholds.minNetSpreadPct &&
    summary.compCount >= thresholds.minComps &&
    summary.breakdown.confidenceScore > 0.6
  );
}
