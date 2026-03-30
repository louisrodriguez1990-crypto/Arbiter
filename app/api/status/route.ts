import { createClient, MODELS } from "@/lib/openrouter";

export const runtime = "edge";

export async function GET() {
  const keySet = !!process.env.OPENROUTER_API_KEY;

  if (!keySet) {
    return Response.json(
      { ok: false, error: "OPENROUTER_API_KEY environment variable is not set" },
      { status: 500 }
    );
  }

  try {
    const client = createClient();
    // Minimal probe: ask the utility model for a one-word reply
    const res = await client.chat.completions.create({
      model: MODELS.utility,
      messages: [{ role: "user", content: 'Reply with only the word "ok".' }],
      max_tokens: 5,
    });
    const reply = res.choices[0]?.message?.content ?? "";
    return Response.json({ ok: true, model: MODELS.utility, reply: reply.trim() });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
