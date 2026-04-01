import { fetchCompletedEbayComps } from "@/lib/arbiter/ebay";
import type {
  CompData,
  DomainModule,
  LiquidationManifestLine,
  ManualLiquidationInput,
  NormalizedItem,
} from "@/lib/arbiter/types";

const DEFAULT_FUNCTIONAL_RATE = 0.6;

function parseNumber(value: string) {
  const normalized = value.replace(/[$,%]/g, "").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseManifestJson(text: string): LiquidationManifestLine[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const row = entry as Record<string, unknown>;
      const title = String(row.title ?? row.query ?? "").trim();
      const query = String(row.query ?? row.title ?? "").trim();
      const quantity = Number(row.quantity ?? 1);

      if (!title || !query || !Number.isFinite(quantity) || quantity <= 0) {
        return [];
      }

      return [
        {
          id: crypto.randomUUID(),
          title,
          query,
          quantity,
          condition: typeof row.condition === "string" ? row.condition : undefined,
          notes: typeof row.notes === "string" ? row.notes : undefined,
        },
      ];
    });
  } catch {
    return null;
  }
}

function parseManifestLine(line: string): LiquidationManifestLine | null {
  const parts = line
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  let quantity = 1;
  let title = parts[0];
  let query = parts[0];
  let condition: string | undefined;
  let notes: string | undefined;

  const leadingQty = title.match(/^(\d+)\s*(?:x|×)\s+(.+)$/i);
  const trailingQty = title.match(/^(.+?)\s+(?:x|×)\s*(\d+)$/i);

  if (leadingQty) {
    quantity = Number(leadingQty[1]);
    title = leadingQty[2].trim();
    query = title;
  } else if (trailingQty) {
    quantity = Number(trailingQty[2]);
    title = trailingQty[1].trim();
    query = title;
  }

  for (const part of parts.slice(1)) {
    const [rawKey, ...rest] = part.split(":");
    if (!rawKey || rest.length === 0) {
      continue;
    }

    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "qty" || key === "quantity") {
      const parsed = parseNumber(value);
      if (parsed && parsed > 0) {
        quantity = parsed;
      }
      continue;
    }

    if (key === "query" || key === "sku" || key === "search") {
      query = value;
      continue;
    }

    if (key === "condition") {
      condition = value;
      continue;
    }

    if (key === "notes") {
      notes = value;
    }
  }

  if (!title || !query || !Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    title,
    query,
    quantity,
    condition,
    notes,
  };
}

export function parseLiquidationManifest(manifestText: string) {
  const trimmed = manifestText.trim();
  if (!trimmed) {
    throw new Error("Manifest text is required.");
  }

  const fromJson = parseManifestJson(trimmed);
  if (fromJson && fromJson.length > 0) {
    return fromJson;
  }

  const parsed = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseManifestLine)
    .filter((line): line is LiquidationManifestLine => line !== null);

  if (parsed.length === 0) {
    throw new Error(
      "Could not parse the manifest. Use one line per SKU, for example `12 x Dyson V15 Detect | condition: returns`."
    );
  }

  return parsed;
}

function normalizeManualInput(raw: unknown): ManualLiquidationInput {
  if (!raw || typeof raw !== "object") {
    throw new Error("Manual ingest payload must be an object.");
  }

  const input = raw as Record<string, unknown>;
  const title = String(input.title ?? "").trim();
  const sourceUrl = String(input.sourceUrl ?? "").trim();
  const askPrice = Number(input.askPrice);
  const manifestText = String(input.manifestText ?? "").trim();

  if (!title) {
    throw new Error("A lot title is required.");
  }

  if (!sourceUrl) {
    throw new Error("A source URL is required.");
  }

  if (!Number.isFinite(askPrice) || askPrice <= 0) {
    throw new Error("Ask price must be a positive number.");
  }

  if (!manifestText) {
    throw new Error("Paste at least one manifest line.");
  }

  return {
    title,
    sourceUrl,
    askPrice,
    description: String(input.description ?? "").trim(),
    sourceName: String(input.sourceName ?? "manual_liquidation").trim(),
    location: String(input.location ?? "").trim() || undefined,
    category: String(input.category ?? "liquidation-lot").trim() || "liquidation-lot",
    condition: String(input.condition ?? "").trim() || undefined,
    currency: String(input.currency ?? "USD").trim() || "USD",
    manifestText,
    functionalRate: Number.isFinite(Number(input.functionalRate))
      ? Number(input.functionalRate)
      : DEFAULT_FUNCTIONAL_RATE,
  };
}

export function getFunctionalRate(item: NormalizedItem) {
  const value = Number(item.metadata.functionalRate ?? DEFAULT_FUNCTIONAL_RATE);
  if (!Number.isFinite(value)) {
    return DEFAULT_FUNCTIONAL_RATE;
  }

  return Math.min(1, Math.max(0.1, value));
}

export function getManifestLines(item: NormalizedItem) {
  const lines = item.metadata.manifest;
  if (!Array.isArray(lines)) {
    return [] as LiquidationManifestLine[];
  }

  return lines.filter((line): line is LiquidationManifestLine => {
    if (!line || typeof line !== "object") {
      return false;
    }

    const row = line as Record<string, unknown>;
    return (
      typeof row.id === "string" &&
      typeof row.title === "string" &&
      typeof row.query === "string" &&
      typeof row.quantity === "number"
    );
  });
}

export const liquidationDomainModule: DomainModule = {
  id: "liquidation",
  name: "Liquidation & Surplus",
  sources: [
    {
      id: "manual_manifest",
      name: "Manual manifest ingest",
      access: "manual",
      updateFrequency: "manual",
    },
    {
      id: "ebay_completed",
      name: "eBay completed listings",
      access: "api",
      updateFrequency: "on_demand",
    },
  ],
  thresholds: {
    minNetSpreadPct: 0.25,
    minComps: 3,
    maxStalenessDays: 7,
    estimatedFeesPct: 0.18,
  },
  riskFactors: [
    "condition_unknown",
    "functional_rate_assumption",
    "shipping_weight",
    "manifest_incomplete",
    "sparse_comp_coverage",
  ],
  normalize(raw: unknown) {
    const input = normalizeManualInput(raw);
    const manifest = parseLiquidationManifest(input.manifestText);

    return {
      id: crypto.randomUUID(),
      domain: "liquidation",
      title: input.title,
      description: input.description ?? "",
      askPrice: input.askPrice,
      currency: input.currency ?? "USD",
      source: input.sourceName ?? "manual_liquidation",
      sourceUrl: input.sourceUrl,
      location: input.location,
      category: input.category ?? "liquidation-lot",
      condition: input.condition,
      ingestedAt: new Date().toISOString(),
      metadata: {
        functionalRate: Math.min(1, Math.max(0.1, input.functionalRate ?? DEFAULT_FUNCTIONAL_RATE)),
        manifest,
      },
    };
  },
  async getComps(item: NormalizedItem): Promise<CompData[]> {
    const manifest = getManifestLines(item);
    if (manifest.length === 0) {
      return [];
    }

    const searches = await Promise.all(manifest.map((line) => fetchCompletedEbayComps(line.query)));

    return searches.flatMap((search, index) =>
      search.comps.map((comp) => ({
        ...comp,
        metadata: {
          ...comp.metadata,
          manifestLineId: manifest[index]?.id,
          manifestTitle: manifest[index]?.title,
          manifestQuantity: manifest[index]?.quantity,
        },
      }))
    );
  },
};
