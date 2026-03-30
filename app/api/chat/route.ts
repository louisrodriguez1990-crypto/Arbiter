export const runtime = "edge";
export const maxDuration = 300; // seconds — respected on Pro; edge has no cap

import { NextRequest } from "next/server";
import {
  createClient,
  callModel,
  streamModel,
  MODELS,
  SWARM_RESEARCHERS,
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

const ANALYST_PROMPT = `You are one of three parallel reasoning engines working toward ONE shared conclusion. You are NOT finding your own opportunity — you are building your piece of an argument. The other two engines are investigating complementary legs of the same hidden arbitrage.

You receive your investigation leg and 3 intelligence briefs. Your job:
1. Extract the sharpest signal from the briefs for your leg
2. Identify what specific mechanism or gap your leg contributes to the final opportunity
3. State what the other legs MUST confirm for this to be a real play
4. End with one sentence: "My leg contributes: [the specific thing you've confirmed]"

Core constraints for the final opportunity this is building toward:
- Zero capital, zero license, accessible to any individual today
- Extreme asymmetric payoff: tiny downside, 10x–100x upside
- "Spooky" — obvious in hindsight, invisible now because it connects things nobody has connected
- Not stocks, crypto bots, real estate, or Amazon FBA

150-200 words. No preamble. Output plain text only.`;

const SYNTHESIS_PROMPT = `You are the final synthesis engine of a collaborative arbitrage investigation. Three parallel reasoning engines have each investigated one leg of the same hidden opportunity: supply dynamics, demand blindspot, and timing catalyst. Your job is to connect all three into ONE singular, razor-sharp arbitrage opportunity that could not have been found without every leg.

Rules:
- Read all three analyst outputs and find the single thread connecting them
- The opportunity must emerge FROM the intersection — not from any one leg alone
- It must be zero-capital, zero-license, accessible to any individual today
- Extreme asymmetric payoff: tiny downside, massive (10x–100x) upside
- It must feel "spooky" — the kind of thing that's obvious once said but invisible until now

Output in this exact format:

**Opportunity Name:** (one catchy, memorable line)
**Market:** (one sentence — the specific market being exploited)
**The Hidden Connection:** (one sentence — what only becomes visible when all three legs are combined)
**The Edge:** (what invisible inefficiency you're exploiting and why it exists)
**How Anyone Does It:**
• step 1
• step 2
• step 3 (max 4 steps)
**Asymmetric Payoff:** Worst case = ___ | Best case = ___
**Why Zero Competition:** (one sentence — the real reason nobody has done this)
**Window:** (how long before this closes and why)

Then end with a single JSON line: {"confidence": <0.0-1.0>, "edgeTag": "<lag|fragmentation|mismatch|inertia>"}
Output markdown bold labels followed by the JSON line. No other formatting.

`;

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
 * Run 3 free researchers in parallel on one angle, return combined brief.
 */
async function runResearchSwarm(
  angle: string,
  history: ChatMessage[],
  swarmIdx: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const client = createClient();

  const researchPromises = SWARM_RESEARCHERS.map(async (model) => {
    const messages: ChatMessage[] = [
      ...history,
      {
        role: "user",
        content: `Research angle: "${angle}"\n\nProvide a research brief covering this angle in the context of the conversation.`,
      },
    ];

    const text = await callModel(client, model, messages, RESEARCHER_PROMPT);

    // Stream each researcher's output as it completes (non-streaming API — emit full chunk)
    sendEvent({
      type: "research_chunk",
      swarm: swarmIdx,
      model: model.split("/").pop() ?? model,
      content: text,
    });

    return text;
  });

  const briefs = await Promise.all(researchPromises);
  return briefs.join("\n\n---\n\n");
}

/**
 * Run one DeepSeek analyst on the combined research brief (streaming).
 */
async function runAnalyst(
  angle: string,
  combinedBrief: string,
  history: ChatMessage[],
  instance: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const client = createClient();

  const messages: ChatMessage[] = [
    ...history,
    {
      role: "user",
      content: `Primary research angle: "${angle}"\n\nResearch briefs from swarm:\n\n${combinedBrief}\n\nProvide your analysis.`,
    },
  ];

  return streamModel(
    client,
    MODELS.analyst,
    messages,
    (delta) => sendEvent({ type: "analyst_chunk", instance, content: delta }),
    ANALYST_PROMPT
  );
}

/**
 * Run swarm research then analyst for one lane. Returns analyst output.
 */
async function runLane(
  angle: string,
  history: ChatMessage[],
  laneIdx: number,
  sendEvent: (e: SwarmEvent) => void
): Promise<string> {
  const combinedBrief = await runResearchSwarm(angle, history, laneIdx, sendEvent);
  return runAnalyst(angle, combinedBrief, history, laneIdx, sendEvent);
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

        // ── Phase 0: Decompose ───────────────────────────────────────────────
        sendEvent({ type: "phase", phase: "decompose", label: "Identifying the three legs of the hidden opportunity…" });

        const userQuery = history.at(-1)?.content ?? "";

        let angles: string[] = [];
        try {
          const raw = await callModel(
            client,
            MODELS.utility,
            [{ role: "user", content: `Query: ${userQuery}` }],
            DECOMPOSE_PROMPT
          );
          // Strip markdown fences if present
          const cleaned = raw.replace(/```[a-z]*\n?/g, "").trim();
          angles = JSON.parse(cleaned);
          if (!Array.isArray(angles) || angles.length < 3) throw new Error("bad parse");
          angles = angles.slice(0, 3);
        } catch {
          // Fallback: use the query itself for all 3 angles with slight variations
          angles = [
            `Supply dynamics leg: ${userQuery}`,
            `Demand blindspot leg: ${userQuery}`,
            `Timing and catalyst leg: ${userQuery}`,
          ];
        }

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
            content: `Original query: "${userQuery}"\n\nThree collaborative investigation legs have each uncovered one piece of the same hidden opportunity. Connect them into ONE singular play.\n\n### Leg 0 — Supply Dynamics (${angles[0]})\n${analysis0}\n\n### Leg 1 — Demand Blindspot (${angles[1]})\n${analysis1}\n\n### Leg 2 — Timing & Catalyst (${angles[2]})\n${analysis2}\n\nWhat single opportunity only becomes visible when all three legs are read together?`,
          },
        ];

        let fullSynthesis = "";
        fullSynthesis = await streamModel(
          client,
          MODELS.utility,
          synthMessages,
          (delta) => sendEvent({ type: "synthesis_chunk", content: delta }),
          SYNTHESIS_PROMPT
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
