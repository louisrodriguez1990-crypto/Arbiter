import OpenAI from "openai";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const MODELS = {
  // Primary analyst — DeepSeek V3.1 hybrid reasoning model
  analyst: "deepseek/deepseek-chat-v3.1",

  // Research swarm — 2× Step-3.5 Flash (free) + 1× Gemini 2.5 Flash (deep research, 1M ctx)
  researcherA: "stepfun/step-3.5-flash:free",
  researcherB: "stepfun/step-3.5-flash:free",
  researcherC: "google/gemini-2.5-flash",

  // Orchestration (decompose + synthesis) — DeepSeek V3.1 for full-pipeline reasoning
  utility: "deepseek/deepseek-chat-v3.1",
} as const;

// Per-swarm researcher assignment — each swarm gets the same three models
export const SWARM_RESEARCHERS: [string, string, string] = [
  MODELS.researcherA,
  MODELS.researcherB,
  MODELS.researcherC,
];

// ─── Client ───────────────────────────────────────────────────────────────────

export function createClient() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "https://arbiter.local",
      "X-Title": process.env.OPENROUTER_SITE_NAME ?? "Arbiter",
    },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatMessage = { role: "user" | "assistant"; content: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Single non-streaming call. Returns the full text response.
 */
export async function callModel(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  systemPrompt?: string
): Promise<string> {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  msgs.push(...messages);

  const response = await client.chat.completions.create({
    model,
    messages: msgs,
    temperature: 0.7,
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Streaming call. Yields text deltas and returns the full accumulated text.
 * The `onChunk` callback fires for each token delta.
 */
export async function streamModel(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  systemPrompt?: string
): Promise<string> {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  msgs.push(...messages);

  const stream = await client.chat.completions.create({
    model,
    messages: msgs,
    stream: true,
    temperature: 0.7,
  });

  let full = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onChunk(delta);
    }
  }
  return full;
}
