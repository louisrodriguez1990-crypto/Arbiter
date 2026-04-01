"use client";

import { FormEvent, useEffect, useState } from "react";

type DetectionSummary = {
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
  manifest: Array<{
    manifestLineId: string;
    title: string;
    query: string;
    quantity: number;
    medianPrice: number | null;
    sampleCount: number;
    sampleUrls: string[];
    extendedValue: number;
  }>;
  riskFlags: string[];
  breakdown: {
    spreadScore: number;
    confidenceScore: number;
    velocityScore: number;
    freshnessScore: number;
    volumeScore: number;
  };
};

type FeedStats = {
  itemCount: number;
  anomalyCount: number;
  thresholds: {
    minNetSpreadPct: number;
    minComps: number;
    estimatedFeesPct: number;
  };
};

type AnomalyFeedRow = {
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
};

type IngestResult = {
  item: {
    id: string;
    title: string;
    sourceUrl: string;
    askPrice: number;
    currency: string;
  };
  summary: DetectionSummary;
  anomalyId: string | null;
  thresholdMet: boolean;
  warnings: string[];
};

const EXAMPLE_MANIFEST = [
  "12 x Dyson V15 Detect | condition: customer returns",
  "18 x Dyson Airwrap | condition: customer returns",
  "12 x Dyson Pure Cool | condition: customer returns",
].join("\n");

const INITIAL_FORM = {
  title: "Dyson Mixed Returns Pallet",
  sourceUrl: "https://example-liquidation-source.test/lot-48291",
  askPrice: "2840",
  location: "Nashville, TN",
  condition: "customer returns",
  functionalRate: "0.6",
  manifestText: EXAMPLE_MANIFEST,
  description: "",
};

function formatCurrency(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function Metric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "good" | "warn";
}) {
  return (
    <div className={`metric-chip metric-chip--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function HomePage() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [stats, setStats] = useState<FeedStats | null>(null);
  const [feed, setFeed] = useState<AnomalyFeedRow[]>([]);
  const [loadingFeed, setLoadingFeed] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<IngestResult | null>(null);

  async function loadFeed() {
    setLoadingFeed(true);
    try {
      const response = await fetch("/api/anomalies?limit=20", {
        cache: "no-store",
      });
      const payload = (await response.json()) as {
        ok: boolean;
        stats: FeedStats;
        anomalies: AnomalyFeedRow[];
      };

      if (!payload.ok) {
        throw new Error("Could not load anomaly feed.");
      }

      setStats(payload.stats);
      setFeed(payload.anomalies);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load anomaly feed.");
    } finally {
      setLoadingFeed(false);
    }
  }

  useEffect(() => {
    void loadFeed();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/ingest/manual", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: form.title,
          sourceUrl: form.sourceUrl,
          askPrice: Number(form.askPrice),
          location: form.location,
          condition: form.condition,
          description: form.description,
          category: "liquidation-lot",
          sourceName: "manual_liquidation",
          functionalRate: Number(form.functionalRate),
          manifestText: form.manifestText,
          currency: "USD",
        }),
      });

      const payload = (await response.json()) as {
        ok: boolean;
        error?: string;
        result?: IngestResult;
      };

      if (!response.ok || !payload.ok || !payload.result) {
        throw new Error(payload.error ?? "Manual ingest failed.");
      }

      setLastResult(payload.result);
      await loadFeed();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Manual ingest failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="phase1-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Arbiter / Phase 1</p>
          <h1>Manual liquidation ingest, eBay comps, anomaly scoring.</h1>
          <p className="hero-copy">
            Paste a liquidation lot and its manifest, let Arbiter pull sold comps from eBay, and
            surface only the lots that clear the first detection threshold.
          </p>
        </div>
        <div className="hero-metrics">
          <Metric
            label="Tracked lots"
            value={stats ? String(stats.itemCount) : loadingFeed ? "..." : "0"}
          />
          <Metric
            label="Flagged anomalies"
            value={stats ? String(stats.anomalyCount) : loadingFeed ? "..." : "0"}
            tone="good"
          />
          <Metric
            label="Min net spread"
            value={stats ? formatPercent(stats.thresholds.minNetSpreadPct) : "25%"}
          />
          <Metric
            label="Min sold comps"
            value={stats ? String(stats.thresholds.minComps) : "3"}
          />
        </div>
      </section>

      <section className="phase1-grid">
        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Manual Ingest</p>
              <h2>Seed the engine with a liquidation lot.</h2>
            </div>
            <p className="panel-note">
              Phase 1 expects a lot URL plus a pasted manifest. Each line becomes an eBay sold-comp
              lookup.
            </p>
          </div>

          <form className="ingest-form" onSubmit={handleSubmit}>
            <label>
              Lot title
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                required
              />
            </label>

            <label>
              Source URL
              <input
                value={form.sourceUrl}
                onChange={(event) =>
                  setForm((current) => ({ ...current, sourceUrl: event.target.value }))
                }
                required
              />
            </label>

            <div className="form-row">
              <label>
                Ask price
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.askPrice}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, askPrice: event.target.value }))
                  }
                  required
                />
              </label>

              <label>
                Functional rate
                <input
                  type="number"
                  min="0.1"
                  max="1"
                  step="0.05"
                  value={form.functionalRate}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, functionalRate: event.target.value }))
                  }
                  required
                />
              </label>
            </div>

            <div className="form-row">
              <label>
                Location
                <input
                  value={form.location}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, location: event.target.value }))
                  }
                />
              </label>

              <label>
                Condition
                <input
                  value={form.condition}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, condition: event.target.value }))
                  }
                />
              </label>
            </div>

            <label>
              Notes
              <textarea
                rows={3}
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="Optional notes about freight, source, or manifest quality."
              />
            </label>

            <label>
              Manifest lines
              <textarea
                rows={10}
                value={form.manifestText}
                onChange={(event) =>
                  setForm((current) => ({ ...current, manifestText: event.target.value }))
                }
                required
              />
            </label>

            <div className="form-helper">
              <span>Accepted format:</span>
              <code>12 x Dyson V15 Detect | condition: customer returns</code>
            </div>

            <button className="primary-button" type="submit" disabled={submitting}>
              {submitting ? "Scoring lot..." : "Ingest and score lot"}
            </button>
          </form>

          {error && <p className="error-banner">{error}</p>}

          {lastResult && (
            <div className="result-card">
              <div className="result-header">
                <div>
                  <p className="eyebrow">Latest Result</p>
                  <h3>{lastResult.item.title}</h3>
                </div>
                <span
                  className={`badge ${lastResult.thresholdMet ? "badge--good" : "badge--muted"}`}
                >
                  {lastResult.thresholdMet ? "Flagged anomaly" : "Below threshold"}
                </span>
              </div>

              <div className="metric-grid">
                <Metric
                  label="Ask"
                  value={formatCurrency(lastResult.item.askPrice, lastResult.item.currency)}
                />
                <Metric
                  label="Est. net value"
                  value={formatCurrency(lastResult.summary.estimatedNetValue, lastResult.item.currency)}
                  tone="good"
                />
                <Metric
                  label="Net spread"
                  value={formatPercent(lastResult.summary.netSpreadPct)}
                  tone={lastResult.thresholdMet ? "good" : "warn"}
                />
                <Metric label="Sold comps" value={String(lastResult.summary.compCount)} />
              </div>

              <div className="result-copy">
                <p>
                  Estimated net profit:{" "}
                  <strong>
                    {formatCurrency(lastResult.summary.estimatedNetProfit, lastResult.item.currency)}
                  </strong>
                </p>
                <p>
                  Coverage: {lastResult.summary.linesWithCoverage}/{lastResult.summary.manifest.length}{" "}
                  manifest lines with sold comps.
                </p>
              </div>

              {lastResult.warnings.length > 0 && (
                <div className="warning-box">
                  <strong>Warnings</strong>
                  <ul>
                    {lastResult.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="manifest-list">
                {lastResult.summary.manifest.map((line) => (
                  <div key={line.manifestLineId} className="manifest-row">
                    <div>
                      <strong>{line.title}</strong>
                      <span>
                        Qty {line.quantity} / {line.sampleCount} sold comps
                      </span>
                    </div>
                    <div>
                      <strong>
                        {line.medianPrice == null
                          ? "No comps"
                          : formatCurrency(line.medianPrice, lastResult.item.currency)}
                      </strong>
                      <span>{formatCurrency(line.extendedValue, lastResult.item.currency)} extended</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Anomaly Feed</p>
              <h2>Lots that cleared the detection threshold.</h2>
            </div>
            <button className="ghost-button" type="button" onClick={() => void loadFeed()}>
              Refresh
            </button>
          </div>

          {loadingFeed ? (
            <p className="empty-state">Loading the anomaly feed...</p>
          ) : feed.length === 0 ? (
            <p className="empty-state">
              No anomalies yet. Ingest a lot on the left and Arbiter will write qualifying entries
              here.
            </p>
          ) : (
            <div className="feed-stack">
              {feed.map((entry) => (
                <details key={entry.anomalyId} className="feed-card">
                  <summary>
                    <div>
                      <p className="feed-title">{entry.title}</p>
                      <p className="feed-subtitle">
                        {entry.category} / {entry.location ?? "Unknown location"} /{" "}
                        {formatTimestamp(entry.createdAt)}
                      </p>
                    </div>
                    <div className="feed-summary-metrics">
                      <Metric label="Score" value={String(entry.anomalyScore)} tone="good" />
                      <Metric
                        label="Net spread"
                        value={formatPercent(entry.netSpreadPct)}
                        tone="good"
                      />
                    </div>
                  </summary>

                  <div className="feed-details">
                    <div className="metric-grid">
                      <Metric label="Ask" value={formatCurrency(entry.askPrice, entry.currency)} />
                      <Metric
                        label="Gross value"
                        value={formatCurrency(entry.summary.estimatedGrossValue, entry.currency)}
                      />
                      <Metric
                        label="Net value"
                        value={formatCurrency(entry.summary.estimatedNetValue, entry.currency)}
                      />
                      <Metric
                        label="Net profit"
                        value={formatCurrency(entry.summary.estimatedNetProfit, entry.currency)}
                        tone="good"
                      />
                    </div>

                    <div className="detail-columns">
                      <div>
                        <h3>Detection breakdown</h3>
                        <ul className="detail-list">
                          <li>Confidence score: {formatPercent(entry.confidenceScore)}</li>
                          <li>Velocity score: {formatPercent(entry.velocityScore)}</li>
                          <li>Functional rate: {formatPercent(entry.summary.functionalRate)}</li>
                          <li>Sold comps: {entry.compCount}</li>
                        </ul>
                      </div>
                      <div>
                        <h3>Risk flags</h3>
                        <ul className="detail-list">
                          {entry.summary.riskFlags.map((flag) => (
                            <li key={flag}>{flag.replaceAll("_", " ")}</li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="manifest-list">
                      {entry.summary.manifest.map((line) => (
                        <div key={line.manifestLineId} className="manifest-row">
                          <div>
                            <strong>{line.title}</strong>
                            <span>
                              Qty {line.quantity} / {line.sampleCount} comps / query "{line.query}"
                            </span>
                          </div>
                          <div>
                            <strong>
                              {line.medianPrice == null
                                ? "No comps"
                                : formatCurrency(line.medianPrice, entry.currency)}
                            </strong>
                            <span>{formatCurrency(line.extendedValue, entry.currency)} extended</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    <a className="source-link" href={entry.sourceUrl} target="_blank" rel="noreferrer">
                      Open source lot
                    </a>
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
