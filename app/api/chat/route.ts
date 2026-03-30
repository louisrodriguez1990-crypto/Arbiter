export const runtime = "edge";
export const maxDuration = 300; // seconds — respected on Pro; edge has no cap

import { NextRequest } from "next/server";
import {
  createClient,
  callModel,
  streamModel,
  MODELS,
  MAX_TOKENS,
  type ChatMessage,
} from "@/lib/openrouter";

// ─── System prompts ───────────────────────────────────────────────────────────

// Shared constraint block injected into every prompt — single source of truth
const CONSTRAINTS = `ALLOW LIST (all outputs must satisfy every item):
• MARKET: US local/physical/service markets only. Online if accessible to any American with a browser.
• SCALE: <$500 capital. No license. No team. One person starts today.
• RADAR: Below institutional radar — too small, too manual, too messy for hedge funds or pro traders.
• INVISIBLE: Also invisible to side-hustle influencers. Not on YouTube, Reddit, or TikTok yet.
• LENS: Must exploit ≥1 of — Lag (price hasn't caught demand shift) · Fragmentation (same thing priced differently by location/segment) · Mismatch (market runs on false assumption) · Inertia (small players/regulators react too slowly)
• ASYMMETRY: Downside = wasted afternoon. Upside = $10k–$100k+ repeatable.
• BANNED: Stocks, options, crypto, real estate, FBA, dropshipping, SMMA, anything already a side-hustle genre.`;

const RESEARCHER_PROMPT = `You are one leg of a three-part arbitrage investigation building toward ONE hidden opportunity.

${CONSTRAINTS}

Surface raw intelligence for your assigned leg: concrete actors, real pricing data, behavioral patterns, structural reasons the gap persists. Do NOT name the final opportunity. 150 words max. Plain text only.`;

const ANALYST_PROMPT_BULL = `You are the BULL on a three-analyst debate team.

${CONSTRAINTS}

Steel-man the opportunity from your intelligence brief. Name exactly WHO is leaving money on the table, WHY the gap exists, and WHAT makes it exploitable right now. 150 words max. End with: "Bull case: [one sentence]". Plain text only.`;

const ANALYST_PROMPT_BEAR = `You are the BEAR on a three-analyst debate team.

${CONSTRAINTS}

Tear apart the opportunity from your intelligence brief. Find the fatal assumption, the hidden cost, or the reason it's already arbitraged. Name who benefits from keeping the gap and can block you. 150 words max. End with: "Bear case: [one sentence]". Plain text only.`;

const ANALYST_PROMPT_MODERATE = `You are the MODERATOR on a three-analyst debate team.

${CONSTRAINTS}

Find the narrow version of this opportunity that survives the bear's attack. Strip what's broken. Name the exact conditions, sub-market, or timing that make the residual edge real and defensible. 150 words max. End with: "The real edge: [one sentence]". Plain text only.`;

const SYNTHESIS_PROMPT = `You are the final synthesis engine. Three analysts debated one opportunity (Bull argued for, Bear argued against, Moderator found what survives). Forge the surviving edge into ONE actionable card.

${CONSTRAINTS}

Output format (bold labels, no extras):

**Opportunity Name:** (one memorable line)
**Market:** (one sentence)
**The Edge:** (precise inefficiency that survived the debate)
**Bull was right about:** (one sentence)
**Bear was right about:** (one sentence — the version that doesn't work)
**How Anyone Does It:**
• step 1
• step 2
• step 3
**Asymmetric Payoff:** Worst case = ___ | Best case = ___
**Why Zero Competition:** (one sentence)
**Window:** (how long and why)

End with: {"confidence": <0.0-1.0>, "edgeTag": "<lag|fragmentation|mismatch|inertia>"}`;

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
 */
async function runResearch(
  angle: string,
  history: ChatMessage[],
  laneIdx: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const client = createClient();
  const messages: ChatMessage[] = [
    ...history,
    { role: "user", content: `Investigation leg: "${angle}"\n\nProvide your intelligence brief.` },
  ];
  const text = await callModel(client, MODELS.researcher, messages, RESEARCHER_PROMPT, MAX_TOKENS.researcher);
  sendEvent({ type: "research_chunk", swarm: laneIdx, model: "gemini-2.5-flash", content: text });
  return text;
}

const ANALYST_PROMPTS = [ANALYST_PROMPT_BULL, ANALYST_PROMPT_BEAR, ANALYST_PROMPT_MODERATE];
const ANALYST_LABELS = ["bull", "bear", "moderate"];

/**
 * Run one analyst (bull / bear / moderate) on the research brief (streaming).
 */
async function runAnalyst(
  angle: string,
  brief: string,
  history: ChatMessage[],
  instance: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const client = createClient();
  const label = ANALYST_LABELS[instance] ?? "analyst";
  const messages: ChatMessage[] = [
    ...history,
    { role: "user", content: `Role: ${label.toUpperCase()}\nInvestigation leg: "${angle}"\n\nIntelligence brief:\n\n${brief}\n\nProvide your ${label} analysis.` },
  ];
  return streamModel(
    client, MODELS.analyst, messages,
    (delta) => sendEvent({ type: "analyst_chunk", instance, content: delta }),
    ANALYST_PROMPTS[instance], MAX_TOKENS.analyst
  );
}

/**
 * Run researcher then analyst for one lane (0=bull, 1=bear, 2=moderate).
 */
async function runLane(
  angle: string,
  history: ChatMessage[],
  laneIdx: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const brief = await runResearch(angle, history, laneIdx, sendEvent);
  return runAnalyst(angle, brief, history, laneIdx, sendEvent);
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
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
          );
        } catch {
          // Client disconnected
        }
      };

      try {
        const client = createClient();

        // ── Phase 0: Decompose (hardcoded angles — saves ~4s vs LLM call) ───
        sendEvent({ type: "phase", phase: "decompose", label: "Targeting the three investigation legs…" });

        const userQuery = history.at(-1)?.content ?? "";

        const angles = [
          `Supply dynamics — who controls the resource, what are their real incentives, where is the structural inefficiency: ${userQuery}`,
          `Demand blindspot — who actually wants this and doesn't know where to get it, what false assumption keeps buyer and seller apart: ${userQuery}`,
          `Timing and catalyst — what recent shift just created this gap and how long before it closes: ${userQuery}`,
        ];

        // ── Phase 1+2: Parallel research swarms + analysts ───────────────────
        sendEvent({ type: "phase", phase: "research", label: "Running three collaborative investigation legs in parallel…" });

        const [analysis0, analysis1, analysis2] = await Promise.all([
          runLane(angles[0], history, 0, sendEvent),
          runLane(angles[1], history, 1, sendEvent),
          runLane(angles[2], history, 2, sendEvent),
        ]);

        // ── Phase 3: Synthesis ───────────────────────────────────────────────
        sendEvent({ type: "phase", phase: "synthesis", label: "Connecting all three legs into the single hidden opportunity…" });

        const synthMessages: ChatMessage[] = [
          {
            role: "user",
            content: `Original query: "${userQuery}"\n\n### Analyst 0 — BULL (argued FOR the opportunity)\n${analysis0}\n\n### Analyst 1 — BEAR (argued AGAINST the opportunity)\n${analysis1}\n\n### Analyst 2 — MODERATOR (found what survives the debate)\n${analysis2}\n\nForge the debate into ONE singular, defensible arbitrage opportunity.`,
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

        // ── Extract metadata ─────────────────────────────────────────────────
        let confidence = 0.75;
        let edgeTag = "structural";

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

        sendEvent({
          type: "complete",
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            content: fullSynthesis,
            analysts: [analysis0, analysis1, analysis2],
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
