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

const DECOMPOSE_PROMPT = `You are a first-principles arbitrage decomposition engine. Your job is NOT to find multiple opportunities — it is to find ONE hidden opportunity that requires three separate lenses to see. Break the user's query into exactly 3 complementary investigation legs that, when combined, reveal a single invisible arbitrage that no single line of inquiry could surface alone.

Leg 0 — SUPPLY DYNAMICS: Who controls the resource, what are their real incentives, and where is the structural inefficiency hiding?
Leg 1 — DEMAND BLINDSPOT: Who actually wants this and doesn't know where to get it? What false assumption keeps buyer and seller apart?
Leg 2 — TIMING & CATALYST: What recent shift (regulatory, technological, behavioral) just created this gap — and how long before it closes?

Respond with ONLY a JSON array of 3 strings. Each string is a sharp, specific investigation directive for that leg. No explanation, no markdown fences.
Example: ["Supply leg: ...", "Demand leg: ...", "Timing leg: ..."]`;

const RESEARCHER_PROMPT = `You are one leg of a three-part arbitrage investigation. You are building ONE piece of a puzzle — your findings will be combined with two other legs to reveal a single hidden opportunity that none of the legs could find alone.

Given your specific investigation directive, produce a dense intelligence brief (150-250 words) focused on: concrete mechanisms, specific actors, real pricing data, behavioral patterns, and the structural reason this gap exists and persists. Do NOT try to name the final opportunity — just surface the raw intelligence for your leg. Be ruthlessly specific. Output plain text only.`;

const ANALYST_PROMPT_BULL = `You are the BULL. Your job is to make the strongest possible case FOR this arbitrage opportunity based on the intelligence brief you've been given.

Find the most compelling evidence that this play is real, accessible, and has genuine asymmetric upside. Steel-man it. Assume the opportunity exists — your job is to explain exactly WHY it works, WHO is leaving money on the table, and WHAT the specific mechanism is that makes it exploitable right now.

Be specific and concrete. Name the real actors, real dynamics, real pricing gaps. 150-200 words. No preamble. End with one line: "Bull case: [one sentence on why this is real]". Output plain text only.`;

const ANALYST_PROMPT_BEAR = `You are the BEAR. Your job is to make the strongest possible case AGAINST this arbitrage opportunity based on the intelligence brief you've been given.

Tear it apart. Find every reason it doesn't work, can't scale, has hidden costs, or has already been arbitraged away. What are the real barriers people aren't seeing? Who actually benefits from maintaining this inefficiency and has the power to block you? What's the fatal assumption that makes this seem like an opportunity but isn't?

Be ruthless and specific. 150-200 words. No preamble. End with one line: "Bear case: [one sentence on the fatal flaw]". Output plain text only.`;

const ANALYST_PROMPT_MODERATE = `You are the MODERATOR. You've heard both the bull and bear arguments. Your job is to find the narrow version of this opportunity that survives the bear's objections.

Where exactly does the bull case hold up under scrutiny? What specific conditions, timing, or sub-market make this real even if the broad version is flawed? Strip away the parts the bear killed. What remains is the precise, defensible edge.

Be surgical. Don't try to argue for or against — find the exact version of this play that is real, accessible, and has genuine asymmetric payoff. 150-200 words. No preamble. End with one line: "The real edge: [one sentence on what survives both sides]". Output plain text only.`;

const SYNTHESIS_PROMPT = `You are the final arbitrage synthesis engine. Three analysts have debated this opportunity:
- Analyst 0 (Bull) made the case FOR it
- Analyst 1 (Bear) made the case AGAINST it
- Analyst 2 (Moderator) found what survives the debate

Your job: take the moderator's refined edge and forge it into ONE singular, razor-sharp arbitrage opportunity. The bull gave you the mechanism. The bear killed the weak parts. The moderator found the real play. You make it actionable.

Rules:
- Zero capital, zero license, accessible to any individual today
- Extreme asymmetric payoff: tiny downside, massive (10x–100x) upside
- It must feel "spooky" — obvious once said, invisible until now
- Not stocks, crypto bots, real estate, or Amazon FBA

Output in this exact format:

**Opportunity Name:** (one catchy, memorable line)
**Market:** (one sentence — the specific market being exploited)
**The Edge:** (what the debate revealed — the precise inefficiency that survives scrutiny)
**Bull was right about:** (one sentence)
**Bear was right about:** (one sentence — the version that DOESN'T work)
**How Anyone Does It:**
• step 1
• step 2
• step 3 (max 4 steps)
**Asymmetric Payoff:** Worst case = ___ | Best case = ___
**Why Zero Competition:** (one sentence)
**Window:** (how long before this closes and why)

Then end with a single JSON line: {"confidence": <0.0-1.0>, "edgeTag": "<lag|fragmentation|mismatch|inertia>"}
Output markdown bold labels followed by the JSON line. No other formatting.`;

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
