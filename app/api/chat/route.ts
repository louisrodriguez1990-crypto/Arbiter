/** Node runtime: reliable `process.env` from `.env.local` in dev; Edge can omit env with some setups. */
export const maxDuration = 300; // seconds — on Pro / compatible hosts

import { NextRequest } from "next/server";
import {
  createClient,
  callModel,
  streamModel,
  MODELS,
  MAX_TOKENS,
  type ChatMessage,
} from "@/lib/openrouter";
import { getEvidenceForQuery } from "@/lib/evidence-sources";

// ─── System prompts ───────────────────────────────────────────────────────────

// Shared constraint block — local flip / peer marketplace arbitrage
const CONSTRAINTS = `ALLOW LIST (all outputs must satisfy every item):
• GEO: US-only. Focus on local peer marketplaces (Facebook Marketplace, OfferUp, Craigslist, Nextdoor, Mercari local pickup, garage/community sales) where you can inspect before you buy.
• PLAY: Buy underpriced used goods locally, resell where velocity is high (eBay sold comps, Mercari, StockX/GOAT where applicable, specialty forums). One person, no warehouse team.
• CAPITAL: Prefer deals under ~$500 per buy; stack small wins.
• VELOCITY: Prioritize categories with fast sell-through (days–few weeks) when priced at market — not long-tail museum pieces unless the spread is huge.
• HONESTY: You cannot open marketplace apps from here. Tell the user how THEY search: Google dork lines (below), in-app filters, and optional local HTML parse (repo script). Flag what must be verified in person. When Google Search grounding is enabled for this run, you may cite brief live web findings (trends, rough price bands) — still prioritize actionable dorks and filters.
• EVIDENCE: Never present a **specific live listing, price, or deal** as fact unless you have a **verified http(s) URL** for it in this brief. If you have zero listing URLs, say so plainly and explain **why discovery failed** (indexing / login wall / JS-only pages / noindex / geo / query mismatch / rate limits / thin results) — do not fill the gap with invented inventory.
• BANNED: Securities/options/crypto as the play, drop-shipping fantasy, multi-level schemes, stolen goods, counterfeits, anything requiring a dealer license where relevant.`;

/** Indexable / search-operator playbook — models must emit concrete dorks, not fake URLs. */
const GOOGLE_DORK_PLAYBOOK = `GOOGLE DORK TOOLKIT (give 3–6 copy-paste queries tailored to the user; combine with city/region keywords):
• Facebook Marketplace (indexed crumbs): site:facebook.com/marketplace "YOUR_ITEM" "CITY_OR_ZIP" | site:facebook.com/marketplace/item/
• OfferUp: site:offerup.com "YOUR_ITEM" | site:offerup.com/item/
• Craigslist: site:*.craigslist.org intitle:YOUR_ITEM | site:craigslist.org/search "YOUR_ITEM" (swap subdomain for region, e.g. sfbay.craigslist.org)
• Nextdoor / Mercari (sometimes indexed): site:nextdoor.com "for sale" YOUR_ITEM | site:mercari.com YOUR_ITEM
• Noise control: add -site:pinterest.com -site:etsy.com when results are polluted; use quoted phrases for model numbers.
• Sold comps (separate tab): site:ebay.com/sch/i.html "sold" YOUR_ITEM OR use eBay/Mercari sold filters inside the app (dorks are backup).`;

const LISTING_PARSE_SCRIPT = `Optional local parse: \`scripts/parse_listings.py\` (pip install -r requirements.txt; playwright install chromium). Save HTML after load, or \`-u URL --render --a11y\` for JS sites. JSON hints only — verify in-app.`;

const RESEARCHER_PROMPT_LISTINGS = `You are STEP 1 — AVAILABLE LISTINGS / HUNT MAP for a local arbitrage workflow.

${CONSTRAINTS}

${GOOGLE_DORK_PLAYBOOK}

${LISTING_PARSE_SCRIPT}

Goal: describe how to **search and filter all relevant local inventory channels** (Marketplace, OfferUp, Craigslist, etc.) for the user's focus: keywords, filters, dork lines with real keywords/city, what “good” vs “bad” listings look like, meetup safety.

For links: include only **verified, directly found listing URLs** (http/https) when you actually have them. Never invent, infer, or template URLs. If a platform has no verifiable item URLs, explicitly say so.

End with a required section **### INDEXING REPORT** (bullets, plain text):
• **Distinct listing URLs found:** number + list each URL on its own line (or "0")
• **Platforms with no crawlable item URLs:** name each (e.g. Facebook Marketplace often behind login / thin indexing)
• **Likely causes:** be specific (login wall, JS-rendered results, robots/noindex, wrong city terms, query too broad/narrow, category noise, rate limits, search tool returned snippets only)
• **What the user should try next:** 2–4 concrete troubleshooting steps (not generic)

Give 2–5 concrete product examples to stalk (categories/SKUs) with plausible local ask vs online exit **ranges** only as **hypothetical** if you have no URLs — label them "hypothetical (no listing URL found)". 280 words max for the main brief + indexing report. Plain text only.`;

const RESEARCHER_PROMPT_COMPS = `You are STEP 2 — SOLD LISTINGS & PRICE GAP ANALYSIS.

${CONSTRAINTS}

You will receive OUTPUT FROM STEP 1 (listings scout) above your task. Your job: **cross-reference** those hunts with **sold / completed listings** logic (eBay sold, Mercari, StockX/GOAT where relevant, category forums).

For each distinct hunt or SKU family the scout named, estimate: typical **local buy/ask band**, **sold comp band**, platform/shipping **fees**, **net gap** (spread), and what **kills** the gap (returns, auth, seasonality). Flag the largest **price gaps** first in your thinking.

If STEP 1 had **zero verified listing URLs**, do not imply you validated local asks against real listings. Frame local bands as **hypothetical** unless tied to a URL from STEP 1. End with **### COMPS EVIDENCE NOTE**: sold-comp sources you relied on (e.g. eBay sold URL or "category-level only"). 240 words max. Plain text only.`;

const ANALYST_PROMPT_SCOUT = `You are ANALYST 1 — LISTINGS SCOUT.

${CONSTRAINTS}

The brief below already includes dork lines and parse-script notes — synthesize, don't repeat them verbatim. Output a tight **hunt map**: where to search, top 3 subcategories/SKUs to stalk, exact dorks + in-app strings, max buy vs expected online exit, deal-breakers. If the brief had **no verified listing URLs**, state that clearly and do not pretend specific local deals exist. 200 words max. End with: "Top pick to hunt: [one line]". Plain text only.`;

const ANALYST_PROMPT_ROI = `You are ANALYST 2 — SOLD COMPS & PRICE GAPS.

${CONSTRAINTS}

You have STEP 1 output in context. Turn the research brief into a **gap analysis**: for each hunt line, realistic buy band, sold band, fees, **net spread**, velocity tier (fast/medium/slow). Order your bullets by **largest net spread first** when possible. If there were **no verified listing URLs** in STEP 1, label spreads **hypothetical** and avoid claiming a specific local listing exists. 220 words max. End with: "Strongest gap: [one sentence]". Plain text only.`;

/** Appended when OpenRouter web plugin is enabled for researcher lanes. */
const GROUNDING_SYSTEM_APPEND = `Use live web results when relevant. If the search tool returns **no listing URLs** or only category pages, say so explicitly — list what failed (e.g. marketplace not indexed, login-only results, empty SERP) and why that limits evidence. Do not invent listings to compensate. Still obey the dork playbook and US-only constraints.`;

const SYNTHESIS_PROMPT = `You are STEP 3 — OPPORTUNITY RANKER. You receive (1) listings scout + analyst and (2) sold-listing / gap analyst output.

${CONSTRAINTS}

The user message includes an **EVIDENCE GATE** line: distinct http(s) URLs counted from upstream research. Follow it exactly.

**If EVIDENCE GATE count is 0:** Do **not** output a normal ranked ROI list as if deals were found. Instead output only:
1) **Indexing & evidence gap** — bullet list: what blocked listing discovery (per platform: login wall, JS rendering, noindex/robots, SERP empty, wrong geo terms, category noise, tool limits, etc.)
2) **Troubleshooting** — numbered steps the user can run next (queries to change, in-app filters, widen/narrow city, try Craigslist subdomain, use parse_listings.py, etc.)
3) **Hypotheses (unverified)** — optional 2–4 bullets clearly labeled **UNVERIFIED** — category-level only, **no** fake listing URLs and **no** dollar ROI ranked as "opportunities"
4) **Watch list / Pass on** — short

Set confidence ≤ 0.35 in the JSON line.

**If EVIDENCE GATE count is ≥ 1:** Produce a **ranked list of flip opportunities from highest estimated ROI (net spread after fees) to lowest**. Each opportunity must either cite a **verified listing URL** copied from upstream or be explicitly labeled **hypothesis (no listing URL)** with no fake precision.

Output format when ranked list is allowed (bold labels, plain text):

**Ranked opportunities** (repeat this block for each opportunity, in order — #1 = best ROI):
**#N — [short name]**
• **Local search:** where / how to find listings (platforms + filters or dorks)
• **Typical local buy:** $ range
• **Sold / online exit:** $ range (comps)
• **Fees & shipping drag:** ~$
• **Est. net per flip:** ~$
• **Verified listing links:** 1–3 real http(s) listing URLs only if present upstream; otherwise "none — see link coverage"
• **Link coverage:** one line stating where links are missing (e.g., "0 verified links for Facebook Marketplace due to indexing limits")
• **ROI notes:** why the gap exists; what to verify in person
• **Risk / kill:** one line

After the list (at least 3 rows only if evidence supports real listings or clearly labeled hypotheses; otherwise fewer), add:

**Watch list:** categories to monitor this week
**Pass on:** what to skip

End with: {"confidence": <0.0-1.0>, "edgeTag": "<lag|fragmentation|mismatch|inertia|velocity>"}`;

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

function isLikelyTemplateOrFake(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes("your_item") || lower.includes("city_or_zip")) return true;
  if (lower.includes("example.com") || lower.includes("localhost")) return true;
  if (lower.includes("{") || lower.includes("}") || lower.includes("<") || lower.includes(">")) return true;
  return false;
}

function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_REGEX)].map((m) => m[0]);
}

/** True if URL plausibly points to a peer marketplace listing (not sold-comps sites like eBay). */
function isLocalListingEvidenceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host.includes("craigslist.org")) return true;
    if (host.includes("facebook.com") && path.includes("/marketplace")) return true;
    if (host.includes("offerup.com") && path.includes("/item")) return true;
    if (host.includes("nextdoor.com")) return true;
    if (host.includes("mercari.com") && path.includes("/item")) return true;
    if (host.includes("kijiji.com")) return true;
    return false;
  } catch {
    return false;
  }
}

function sanitizeSynthesisLinks(text: string, allowedSourceText: string): { text: string; kept: number; removed: number } {
  const matches = [...text.matchAll(URL_REGEX)].map((m) => m[0]);
  if (matches.length === 0) return { text, kept: 0, removed: 0 };

  const allowedUrls = new Set(extractUrls(allowedSourceText).map((u) => u.trim()));
  const unique = [...new Set(matches)];
  const bad = new Set(
    unique.filter((url) => {
      if (isLikelyTemplateOrFake(url)) return true;
      return !allowedUrls.has(url.trim());
    })
  );
  let sanitized = text;
  let removed = 0;

  for (const url of bad) {
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(escaped, "g");
    const count = (sanitized.match(re) ?? []).length;
    if (count > 0) {
      removed += count;
      sanitized = sanitized.replace(re, "[removed-unverified-link]");
    }
  }

  return { text: sanitized, kept: matches.length - removed, removed };
}

function formatEvidenceContext(input: {
  listings: Array<{ url: string; title: string; price?: number; source: string }>;
  comps: { soldMin?: number; soldMax?: number; soldMedian?: number; sampleSoldUrls: string[] } | null;
  usedSources: string[];
  skippedSources: string[];
}): string {
  const listingLines = input.listings
    .slice(0, 10)
    .map((l, i) => {
      const px = typeof l.price === "number" ? ` | $${l.price}` : "";
      return `${i + 1}. ${l.title}${px} | ${l.source} | ${l.url}`;
    })
    .join("\n");
  const compsLines = input.comps
    ? [
        `soldMin=${input.comps.soldMin ?? "n/a"}`,
        `soldMedian=${input.comps.soldMedian ?? "n/a"}`,
        `soldMax=${input.comps.soldMax ?? "n/a"}`,
        ...input.comps.sampleSoldUrls.slice(0, 5).map((u) => `- ${u}`),
      ].join("\n")
    : "none";

  return [
    "### FETCHED EVIDENCE (from public/free APIs and feeds)",
    `Used sources: ${input.usedSources.join(", ") || "none"}`,
    `Skipped sources: ${input.skippedSources.join(" | ") || "none"}`,
    `Listings fetched count: ${input.listings.length}`,
    `Comps fetched count: ${input.comps?.sampleSoldUrls.length ?? 0}`,
    "",
    "Listing rows (verifiable URLs only):",
    listingLines || "none",
    "",
    "Comps summary:",
    compsLines,
    "",
    "Rules: treat listing rows above as highest-trust evidence; do not invent missing rows/URLs.",
  ].join("\n");
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

type SwarmEvent =
  | { type: "phase"; phase: string; label: string }
  | { type: "research_chunk"; swarm: number; model: string; content: string }
  | { type: "analyst_chunk"; instance: number; content: string }
  | { type: "synthesis_chunk"; content: string }
  | { type: "complete"; message: CompleteMessage }
  | { type: "error"; message: string };

interface CompleteMessage {
  id: string;
  role: "assistant";
  content: string;
  analysts: string[];
  confidence?: number;
  edgeTag?: string;
}

// ─── Swarm orchestration ──────────────────────────────────────────────────────

/**
 * Run one researcher for a lane, emit the chunk, return the brief.
 * Optional prefix (e.g. Step 1 output for cross-reference in Step 2).
 */
async function runResearch(
  angle: string,
  history: ChatMessage[],
  laneIdx: number,
  researcherSystemPrompt: string,
  sendEvent: (e: SwarmEvent) => void,
  extraUserPrefix?: string
): Promise<string> {
  const client = createClient();
  const body = extraUserPrefix
    ? `${extraUserPrefix.trim()}\n\n---\n\nInvestigation leg: "${angle}"\n\nProvide your intelligence brief.`
    : `Investigation leg: "${angle}"\n\nProvide your intelligence brief.`;
  const messages: ChatMessage[] = [...history, { role: "user", content: body }];
  let text = "";
  let modelLabel = "google/gemini-2.5-flash (OpenRouter)";

  // #region agent log
  fetch("http://127.0.0.1:7849/ingest/1b6ec78e-0033-46ec-95cb-4c223d740d0f", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "240042" },
    body: JSON.stringify({
      sessionId: "240042",
      location: "app/api/chat/route.ts:runResearch",
      message: "research_path",
      data: { laneIdx, provider: "openrouter", model: MODELS.researcher },
      timestamp: Date.now(),
      hypothesisId: "H1",
    }),
  }).catch(() => {});
  // #endregion

  try {
    text = await callModel(client, MODELS.researcher, messages, `${researcherSystemPrompt}\n\n${GROUNDING_SYSTEM_APPEND}`, {
      maxTokens: MAX_TOKENS.researcher,
      enableWebSearch: true,
    });
    // #region agent log
    fetch("http://127.0.0.1:7849/ingest/1b6ec78e-0033-46ec-95cb-4c223d740d0f", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "240042" },
      body: JSON.stringify({
        sessionId: "240042",
        location: "app/api/chat/route.ts:runResearch",
        message: "openrouter_web_success",
        data: { laneIdx, textLen: text.length },
        timestamp: Date.now(),
        hypothesisId: "H2",
      }),
    }).catch(() => {});
    // #endregion
    modelLabel = "google/gemini-2.5-flash + web (OpenRouter)";
    if (!text.trim()) {
      throw new Error("Empty response with OpenRouter web plugin");
    }
  } catch {
    // #region agent log
    fetch("http://127.0.0.1:7849/ingest/1b6ec78e-0033-46ec-95cb-4c223d740d0f", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "240042" },
      body: JSON.stringify({
        sessionId: "240042",
        location: "app/api/chat/route.ts:runResearch",
        message: "openrouter_web_failed",
        data: { laneIdx },
        timestamp: Date.now(),
        hypothesisId: "H3",
      }),
    }).catch(() => {});
    // #endregion
    try {
      text = await callModel(client, MODELS.researcher, messages, researcherSystemPrompt, MAX_TOKENS.researcher);
      // #region agent log
      fetch("http://127.0.0.1:7849/ingest/1b6ec78e-0033-46ec-95cb-4c223d740d0f", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "240042" },
        body: JSON.stringify({
          sessionId: "240042",
          location: "app/api/chat/route.ts:runResearch",
          message: "openrouter_standard_success",
          data: { laneIdx, textLen: text.length },
          timestamp: Date.now(),
          hypothesisId: "H4",
        }),
      }).catch(() => {});
      // #endregion
      modelLabel = "google/gemini-2.5-flash (OpenRouter fallback)";
    } catch {
      modelLabel = "deepseek-chat (fallback)";
      text = await callModel(client, MODELS.analyst, messages, researcherSystemPrompt, MAX_TOKENS.researcher);
    }
  }
  sendEvent({ type: "research_chunk", swarm: laneIdx, model: modelLabel, content: text });
  return text;
}

const ANALYST_PROMPTS = [ANALYST_PROMPT_SCOUT, ANALYST_PROMPT_ROI] as const;
const ANALYST_LABELS = ["scout", "roi"] as const;

/**
 * Run one analyst (scout or ROI) on the research brief (streaming).
 */
async function runAnalyst(
  angle: string,
  brief: string,
  history: ChatMessage[],
  instance: number,
  sendEvent: (e: SwarmEvent) => void,
  extraUserPrefix?: string
): Promise<string> {
  const client = createClient();
  const label = ANALYST_LABELS[instance] ?? "analyst";
  const body = extraUserPrefix
    ? `${extraUserPrefix.trim()}\n\n---\n\nRole: ${label.toUpperCase()}\nInvestigation leg: "${angle}"\n\nIntelligence brief:\n\n${brief}\n\nProvide your ${label} analysis.`
    : `Role: ${label.toUpperCase()}\nInvestigation leg: "${angle}"\n\nIntelligence brief:\n\n${brief}\n\nProvide your ${label} analysis.`;
  const messages: ChatMessage[] = [...history, { role: "user", content: body }];
  return streamModel(
    client,
    MODELS.analyst,
    messages,
    (delta) => sendEvent({ type: "analyst_chunk", instance, content: delta }),
    ANALYST_PROMPTS[instance],
    MAX_TOKENS.analyst
  );
}

/**
 * Run researcher then analyst for one lane (0=listings, 1=comps).
 */
async function runLane(
  angle: string,
  history: ChatMessage[],
  laneIdx: number,
  researcherSystemPrompt: string,
  sendEvent: (e: SwarmEvent) => void,
  extraUserPrefix?: string
): Promise<string> {
  const brief = await runResearch(angle, history, laneIdx, researcherSystemPrompt, sendEvent, extraUserPrefix);
  return runAnalyst(angle, brief, history, laneIdx, sendEvent, extraUserPrefix);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let history: ChatMessage[];

  try {
    const body = await req.json();
    history = body.history;
    if (!Array.isArray(history) || history.length === 0) {
      return Response.json({ error: "history must be a non-empty array" }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: SwarmEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // Client disconnected
        }
      };

      try {
        const client = createClient();

        sendEvent({
          type: "phase",
          phase: "decompose",
          label: "Pipeline: local listings → sold comps / gaps → ranked opportunities…",
        });

        const userQuery = history.at(-1)?.content ?? "";
        const historyForSwarm = history.length <= 10 ? history : history.slice(-10);
        const fetchedEvidence = await getEvidenceForQuery(userQuery);
        const fetchedEvidenceContext = formatEvidenceContext(fetchedEvidence);

        const angleListings = `Available listings — surface every practical way to find inventory (Marketplace, OfferUp, Craigslist, Nextdoor, etc.) for underpriced, high-velocity items. User focus: ${userQuery}`;
        const angleComps = `Sold listings & price gaps — compare typical local asks vs sold comps and fees for the hunts in STEP 1. User focus: ${userQuery}`;

        // Step 1: search / hunt map (listings)
        sendEvent({ type: "phase", phase: "research", label: "Step 1 — Searching available listings (channels, dorks, examples)…" });
        const analysisScout = await runLane(
          angleListings,
          historyForSwarm,
          0,
          RESEARCHER_PROMPT_LISTINGS,
          sendEvent,
          fetchedEvidenceContext
        );

        // Step 2: cross-reference sold listings vs Step 1 (sequential so comps can use scout output)
        const crossRefPrefix = `${fetchedEvidenceContext}\n\n### STEP 1 OUTPUT — LISTINGS SCOUT (cross-reference these hunts against sold listings; quantify price gaps)\n\n${analysisScout}`;
        sendEvent({
          type: "phase",
          phase: "research",
          label: "Step 2 — Cross-referencing sold listings & price gaps…",
        });
        const analysisRoi = await runLane(
          angleComps,
          historyForSwarm,
          1,
          RESEARCHER_PROMPT_COMPS,
          sendEvent,
          crossRefPrefix
        );

        // Step 3: synthesize ranked opportunity list
        sendEvent({
          type: "phase",
          phase: "synthesis",
          label: "Step 3 — Ranking opportunities by ROI…",
        });

        const evidenceText = `${analysisScout}\n${analysisRoi}\n${fetchedEvidence.listings.map((l) => l.url).join("\n")}`;
        const evidenceUrlList = [
          ...new Set(fetchedEvidence.listings.map((l) => l.url).filter(isLocalListingEvidenceUrl)),
        ];
        const evidenceCount = evidenceUrlList.length;
        const evidenceGateBlock =
          evidenceCount === 0
            ? `EVIDENCE GATE: **0** distinct **local marketplace listing** URLs (e.g. Craigslist item, Facebook Marketplace item path, OfferUp /item/…) in STEP 1–2. eBay sold pages do **not** count. Follow STEP 3 "count is 0" instructions — indexing/troubleshooting first, no speculative ranked deals.`
            : `EVIDENCE GATE: **${evidenceCount}** verified local listing URL(s). Only these may be cited as live listings:\n${evidenceUrlList.map((u) => `- ${u}`).join("\n")}\nDo not invent additional listing URLs.`;

        const synthMessages: ChatMessage[] = [
          {
            role: "user",
            content: `Original query: "${userQuery}"\n\n${evidenceGateBlock}\n\n${fetchedEvidenceContext}\n\n### STEP 1 — LISTINGS (search + scout)\n${analysisScout}\n\n### STEP 2 — SOLD COMPS & GAPS\n${analysisRoi}\n\nProduce STEP 3 output per system instructions.`,
          },
        ];

        let fullSynthesis = "";
        fullSynthesis = await streamModel(
          client,
          MODELS.utility,
          synthMessages,
          (delta) => sendEvent({ type: "synthesis_chunk", content: delta }),
          SYNTHESIS_PROMPT,
          MAX_TOKENS.synthesis
        );

        let confidence = 0.75;
        let edgeTag = "velocity";

        const trimmed = fullSynthesis.trimEnd();
        const lastNl = trimmed.lastIndexOf("\n");
        const lastLine = lastNl >= 0 ? trimmed.slice(lastNl + 1).trim() : trimmed;

        if (lastLine.startsWith("{") && lastLine.endsWith("}")) {
          try {
            const meta = JSON.parse(lastLine);
            if (typeof meta.confidence === "number") {
              confidence = Math.min(1, Math.max(0, meta.confidence));
            }
            if (typeof meta.edgeTag === "string") edgeTag = meta.edgeTag;
            fullSynthesis = (lastNl >= 0 ? trimmed.slice(0, lastNl) : "").trim();
          } catch {
            // keep defaults
          }
        }

        if (evidenceCount === 0) {
          confidence = Math.min(confidence, 0.35);
        }

        const linkGuard = sanitizeSynthesisLinks(fullSynthesis, evidenceText);
        if (linkGuard.removed > 0) {
          fullSynthesis = `${linkGuard.text}\n\nNote: removed ${linkGuard.removed} unverified or template-style link(s); only URLs that appeared in STEP 1–2 research are allowed.`;
        } else if (!/Verified listing links:/i.test(fullSynthesis)) {
          fullSynthesis = `${fullSynthesis}\n\nVerified listing links: none found in this run.\nLink coverage: No crawlable listing URLs were present in upstream research — common causes include login-gated marketplaces, JS-only results, thin Google indexing for item pages, or queries that need tighter keywords/geo.`;
        }
        fullSynthesis = `${fullSynthesis}\n\nEvidence sources used: ${fetchedEvidence.usedSources.join(", ") || "none"}\nListings fetched count: ${fetchedEvidence.listings.length}\nComps fetched count: ${fetchedEvidence.comps?.sampleSoldUrls.length ?? 0}\nSkipped sources: ${fetchedEvidence.skippedSources.join(" | ") || "none"}`;

        sendEvent({
          type: "complete",
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            content: fullSynthesis,
            analysts: [analysisScout, analysisRoi],
            confidence,
            edgeTag,
          },
        });

        controller.close();
      } catch (err) {
        sendEvent({
          type: "error",
          message: err instanceof Error ? err.message : "An error occurred",
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
