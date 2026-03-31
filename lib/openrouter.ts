import OpenAI from "openai";

// ─── Model IDs ────────────────────────────────────────────────────────────────

export const MODELS = {
  // One researcher per lane — Gemini 2.5 Flash (fast, large context, no free-tier rate limits)
  researcher: "google/gemini-2.5-flash",

  // Analyst + synthesis — DeepSeek V3 (strong reasoning, fast streaming)
  analyst:  "deepseek/deepseek-v3.2",
  utility:  "deepseek/deepseek-v3.2",
} as const;

// ─── Token budgets (keep every call short to stay under 25s Edge limit) ──────

export const MAX_TOKENS = {
  researcher: 250,
  analyst:    350,
  synthesis:  550,
} as const;

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
  systemPrompt?: string,
  maxTokens?: number
): Promise<string> {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  msgs.push(...messages);

  const response = await client.chat.completions.create({
    model,
    messages: msgs,
    temperature: 0.7,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Streaming call. Yields text deltas and returns the full accumulated text.
 */
export async function streamModel(
  client: OpenAI,
  model: string,
  messages: ChatMessage[],
  onChunk: (delta: string) => void,
  systemPrompt?: string,
  maxTokens?: number
): Promise<string> {
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  msgs.push(...messages);

  const stream = await client.chat.completions.create({
    model,
    messages: msgs,
    stream: true,
    temperature: 0.7,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
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
