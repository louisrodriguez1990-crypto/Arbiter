export async function GET() {
  return Response.json({
    online: true,
    latency: null,
    modelsLoaded: 1,
    model: "claude-opus-4-6",
    webSearch: process.env.ENABLE_WEB_SEARCH !== "false",
  });
}
