import { fetchCompletedEbayComps } from "@/lib/arbiter/ebay";
import { liquidationDomainModule } from "@/lib/arbiter/modules/liquidation";
import { calculateDetectionSummary, meetsDetectionThreshold } from "@/lib/arbiter/scoring";
import { ensureDefaultDomainConfig, insertItem, replaceComps, upsertAnomaly } from "@/lib/arbiter/repository";
import type { IngestResult, ManualLiquidationInput } from "@/lib/arbiter/types";

export async function ingestManualLiquidationLot(rawInput: ManualLiquidationInput): Promise<IngestResult> {
  const item = liquidationDomainModule.normalize(rawInput);
  const manifest = Array.isArray(item.metadata.manifest) ? item.metadata.manifest : [];

  const config = ensureDefaultDomainConfig().settings;
  const searches = await Promise.all(
    manifest.map((line) => fetchCompletedEbayComps(String((line as { query?: string }).query ?? "")))
  );

  const warnings = searches.flatMap((search) => search.warnings);
  const comps = searches.flatMap((search, index) =>
    search.comps.map((comp) => ({
      ...comp,
      metadata: {
        ...comp.metadata,
        manifestLineId: (manifest[index] as { id?: string }).id,
        manifestTitle: (manifest[index] as { title?: string }).title,
        manifestQuantity: (manifest[index] as { quantity?: number }).quantity,
      },
    }))
  );

  insertItem(item);
  replaceComps(item.id, comps);

  const summary = calculateDetectionSummary(item, comps, config);
  const thresholdMet = meetsDetectionThreshold(summary, config);
  const anomalyId = thresholdMet ? upsertAnomaly(item, summary) : null;

  return {
    item,
    summary,
    anomalyId,
    thresholdMet,
    warnings,
  };
}
