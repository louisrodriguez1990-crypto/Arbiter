export type CompConfidence = "verified_sold" | "active_listing" | "estimated";

export interface DataSource {
  id: string;
  name: string;
  access: "api" | "feed" | "manual";
  updateFrequency: "manual" | "on_demand" | "daily" | "weekly";
}

export interface DomainThresholds {
  minNetSpreadPct: number;
  minComps: number;
  maxStalenessDays: number;
  estimatedFeesPct: number;
}

export interface DomainModule {
  id: string;
  name: string;
  sources: DataSource[];
  normalize(raw: unknown): NormalizedItem;
  getComps(item: NormalizedItem): Promise<CompData[]>;
  riskFactors: string[];
  thresholds: DomainThresholds;
}

export interface NormalizedItem {
  id: string;
  domain: string;
  title: string;
  description: string;
  askPrice: number;
  currency: string;
  source: string;
  sourceUrl: string;
  location?: string;
  category: string;
  condition?: string;
  metadata: Record<string, unknown>;
  ingestedAt: string;
}

export interface CompData {
  id: string;
  source: string;
  price: number;
  soldDate?: string;
  condition?: string;
  confidence: CompConfidence;
  title?: string;
  sourceUrl?: string;
  query?: string;
  metadata?: Record<string, unknown>;
}

export interface LiquidationManifestLine {
  id: string;
  title: string;
  query: string;
  quantity: number;
  condition?: string;
  notes?: string;
}

export interface ManualLiquidationInput {
  title: string;
  sourceUrl: string;
  askPrice: number;
  description?: string;
  sourceName?: string;
  location?: string;
  category?: string;
  condition?: string;
  currency?: string;
  manifestText: string;
  functionalRate?: number;
}

export interface DomainConfigRecord {
  domain: string;
  settings: DomainThresholds;
}

export interface ManifestCompRollup {
  manifestLineId: string;
  title: string;
  query: string;
  quantity: number;
  medianPrice: number | null;
  sampleCount: number;
  sampleUrls: string[];
  extendedValue: number;
}

export interface AnomalyScoreBreakdown {
  spreadScore: number;
  confidenceScore: number;
  velocityScore: number;
  freshnessScore: number;
  volumeScore: number;
}

export interface DetectionSummary {
  estimatedGrossValue: number;
  estimatedFunctionalValue: number;
  estimatedNetValue: number;
  estimatedNetProfit: number;
  grossSpreadPct: number;
  netSpreadPct: number;
  functionalRate: number;
  estimatedFeesPct: number;
  compCount: number;
  linesWithCoverage: number;
  manifest: ManifestCompRollup[];
  riskFlags: string[];
  breakdown: AnomalyScoreBreakdown;
}

export interface IngestResult {
  item: NormalizedItem;
  summary: DetectionSummary;
  anomalyId: string | null;
  thresholdMet: boolean;
  warnings: string[];
}

export interface AnomalyFeedRow {
  anomalyId: string;
  itemId: string;
  domain: string;
  title: string;
  source: string;
  sourceUrl: string;
  askPrice: number;
  currency: string;
  location?: string;
  category: string;
  condition?: string;
  anomalyScore: number;
  confidenceScore: number;
  velocityScore: number;
  freshnessScore: number;
  volumeScore: number;
  grossSpreadPct: number;
  netSpreadPct: number;
  compCount: number;
  createdAt: string;
  summary: DetectionSummary;
}
