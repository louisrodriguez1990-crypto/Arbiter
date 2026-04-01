import type { CompData } from "@/lib/arbiter/types";
import "@/lib/load-env";

const FINDING_ENDPOINT = "https://svcs.ebay.com/services/search/FindingService/v1";

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

type EbayFindingItem = Record<string, unknown>;

function firstText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const entry = value[0];
    return typeof entry === "string" ? entry : undefined;
  }

  return typeof value === "string" ? value : undefined;
}

function getNestedObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const entry = value[0];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

export interface EbayCompSearchResult {
  query: string;
  comps: CompData[];
  medianPrice: number | null;
  sampleCount: number;
  warnings: string[];
}

export async function fetchCompletedEbayComps(query: string, maxEntries = 20): Promise<EbayCompSearchResult> {
  const appId = process.env.EBAY_APP_ID?.trim();
  if (!appId) {
    return {
      query,
      comps: [],
      medianPrice: null,
      sampleCount: 0,
      warnings: ["Missing EBAY_APP_ID; eBay sold comps are disabled."],
    };
  }

  const url =
    `${FINDING_ENDPOINT}?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.13.0` +
    `&SECURITY-APPNAME=${encodeURIComponent(appId)}` +
    "&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD" +
    "&sortOrder=EndTimeSoonest" +
    `&keywords=${encodeURIComponent(query)}` +
    "&itemFilter(0).name=SoldItemsOnly" +
    "&itemFilter(0).value=true" +
    `&paginationInput.entriesPerPage=${Math.max(5, Math.min(maxEntries, 50))}`;

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Arbiter/1.0 (+manual-ingest-phase1)",
      },
    });

    if (!response.ok) {
      return {
        query,
        comps: [],
        medianPrice: null,
        sampleCount: 0,
        warnings: [`eBay request failed with HTTP ${response.status}.`],
      };
    }

    const json = (await response.json()) as Record<string, unknown>;
    const root = (json.findCompletedItemsResponse as unknown[])?.[0] as Record<string, unknown> | undefined;
    const searchResult = (root?.searchResult as unknown[])?.[0] as Record<string, unknown> | undefined;
    const items = (searchResult?.item as EbayFindingItem[] | undefined) ?? [];

    const comps: CompData[] = [];

    for (const item of items) {
      const sellingStatus = getNestedObject(item.sellingStatus);
      const currentPrice = getNestedObject(sellingStatus?.currentPrice);
      const price = Number(currentPrice?.__value__);
      if (!Number.isFinite(price) || price <= 0) {
        continue;
      }

      const listingInfo = getNestedObject(item.listingInfo);
      const conditionRoot = getNestedObject(item.condition);

      comps.push({
        id: crypto.randomUUID(),
        source: "ebay",
        price,
        soldDate: firstText(listingInfo?.endTime),
        condition: firstText(conditionRoot?.conditionDisplayName),
        confidence: "verified_sold",
        title: firstText(item.title),
        sourceUrl: firstText(item.viewItemURL),
        query,
        metadata: {
          itemId: firstText(item.itemId),
          listingType: firstText(listingInfo?.listingType),
        },
      });
    }

    return {
      query,
      comps,
      medianPrice: median(comps.map((comp) => comp.price)),
      sampleCount: comps.length,
      warnings: comps.length > 0 ? [] : [`No eBay sold comps matched "${query}".`],
    };
  } catch (error) {
    return {
      query,
      comps: [],
      medianPrice: null,
      sampleCount: 0,
      warnings: [error instanceof Error ? error.message : "Unknown eBay error."],
    };
  }
}
