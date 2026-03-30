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

const DECOMPOSE_PROMPT = `You are a research coordinator. Given a user query, produce exactly 3 distinct research angles that together give full analytical coverage. Each angle should explore a different dimension: structural, temporal, behavioral, informational, or macro/micro level.

Respond with ONLY a JSON array of 3 strings. No explanation, no markdown fences.
Example: ["angle one", "angle two", "angle three"]`;

const RESEARCHER_PROMPT = `You are a focused research analyst. Given a specific research angle, produce a dense, factual research brief (150-250 words). Focus on concrete data, specific mechanisms, and non-obvious connections. Be direct — no filler, no hedging. Output plain text only.`;

const ANALYST_PROMPT = `You are Arbiter, an elite reasoning engine for asymmetric opportunity analysis. You receive a primary research angle and 3 research briefs from your swarm. Your job:

1. Synthesize the research into a tight analytical thesis
2. Identify the specific edge or mispricing others are missing
3. Explain the 2nd/3rd order effects being ignored
4. State your conviction and why

Be direct and contrarian. 150-300 words. No preamble. Output plain text only.`;

const SYNTHESIS_PROMPT = `You are a master synthesizer. You receive 3 parallel analyst outputs on the same user query. Your job: weave them into a single, unified, razor-sharp response that captures the best insights from all three without repetition.

Rules:
- Extract the sharpest insight from each analyst
- Find where they converge (high conviction) and where they diverge (uncertainty)
- Produce one coherent thesis, not a list of three summaries
- End with a single JSON line: {"confidence": <0.0-1.0>, "edgeTag": "<structural|temporal|informational|behavioral>"}
- Output plain text followed by the JSON line. No other formatting.`;

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
