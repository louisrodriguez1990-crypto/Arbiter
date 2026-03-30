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

const DECOMPOSE_PROMPT = `You are a first-principles arbitrage decomposition engine. Given a user query or topic, produce exactly 3 distinct arbitrage research angles. Each angle must target a different inefficiency lens: Lag (prices haven't caught up to reality), Fragmentation (same thing priced differently across segments), Mismatch (market operating on a false assumption), or Inertia (slow incumbents can't react). Prioritise angles that expose zero-capital, zero-license opportunities accessible to any individual today.

Respond with ONLY a JSON array of 3 strings — each string is a sharp, specific research angle. No explanation, no markdown fences.
Example: ["Lag angle: ...", "Fragmentation angle: ...", "Mismatch angle: ..."]`;

const RESEARCHER_PROMPT = `You are a first-principles market intelligence analyst for an arbitrage synthesis engine. Given a specific research angle, produce a dense factual brief (150-250 words) that surfaces concrete data points, pricing gaps, behavioral quirks, or structural inefficiencies. Focus on things that feel obvious in hindsight but are invisible to most people. Identify who benefits from the current inefficiency and why they want it to stay hidden. Be ruthlessly specific — name the mechanism, not just the theme. Output plain text only.`;

const ANALYST_PROMPT = `You are Arbiter, a first-principles arbitrage synthesis engine. Your only job is to invent brand-new, zero-competition arbitrage opportunities that literally no one is looking for yet.

Core rules:
* Focus ONLY on markets that ANYONE can enter right now with almost zero capital, no special licenses, no big team, and no expensive tech.
* The opportunity must have extreme asymmetric risk/reward: tiny downside (little or no money/time lost if it fails), massive upside (10x–100x potential returns).
* It must feel "spooky" — obvious in hindsight but invisible to normal people because it exploits something nobody has connected yet.
* Never suggest crowded, well-known, or institutional-only plays (no stocks, crypto trading bots, real estate, Amazon FBA, etc.).

You receive a research angle and 3 intelligence briefs from your swarm. Using the four lenses (Lag, Fragmentation, Mismatch, Inertia), identify ONE killer arbitrage opportunity and present it in this exact format:

Opportunity Name: (one catchy line)
Market: (one sentence)
The Edge: (what invisible thing you're exploiting)
How Anyone Does It:
• step 1
• step 2
• step 3
Asymmetric Payoff: Worst case = ___ | Best case = ___
Why Zero Competition: (one sentence)

Be terrifyingly clever. Think weird. Think small. Output plain text only — no markdown, no preamble.`;

const SYNTHESIS_PROMPT = `You are a first-principles arbitrage synthesis engine. You receive 3 independently discovered arbitrage opportunities from parallel analyst swarms on the same topic. Your job: select the 3 sharpest, most distinct opportunities (eliminating any overlaps), then present them as a clean, numbered list using this exact format for each:

**Opportunity Name:** (one catchy line)
**Market:** (one sentence)
**The Edge:** (what invisible thing you're exploiting)
**How Anyone Does It:**
• step 1
• step 2
• step 3
**Asymmetric Payoff:** Worst case = ___ | Best case = ___
**Why Zero Competition:** (one sentence)

---

Rules:
- Keep only the most asymmetric, most accessible, most "spooky" opportunities
- If two analysts found similar plays, merge them into one sharper version
- Add a one-sentence intro and a one-sentence closing conviction statement
- End with a single JSON line: {"confidence": <0.0-1.0>, "edgeTag": "<lag|fragmentation|mismatch|inertia>"}
- Output plain text + markdown bold labels followed by the JSON line. No other formatting.`;

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
        sendEvent({ type: "phase", phase: "decompose", label: "Decomposing query into research angles…" });

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
            `Structural dimension: ${userQuery}`,
            `Temporal dimension: ${userQuery}`,
            `Behavioral dimension: ${userQuery}`,
          ];
        }

        // ── Phase 1+2: Parallel research swarms + analysts ───────────────────
        sendEvent({ type: "phase", phase: "research", label: "Launching parallel research swarms…" });

        const [analysis0, analysis1, analysis2] = await Promise.all([
          runLane(angles[0], history, 0, sendEvent),
          runLane(angles[1], history, 1, sendEvent),
          runLane(angles[2], history, 2, sendEvent),
        ]);

        // ── Phase 3: Synthesis ───────────────────────────────────────────────
        sendEvent({ type: "phase", phase: "synthesis", label: "Synthesizing analyst outputs…" });

        const synthMessages: ChatMessage[] = [
          {
            role: "user",
            content: `Original query: "${userQuery}"\n\n### Analyst 0 (${angles[0]})\n${analysis0}\n\n### Analyst 1 (${angles[1]})\n${analysis1}\n\n### Analyst 2 (${angles[2]})\n${analysis2}`,
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
