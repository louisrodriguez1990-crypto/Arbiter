"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  analysts?: string[];
  confidence?: number;
  edgeTag?: string;
}

interface SwarmState {
  phase: "idle" | "decompose" | "research" | "synthesis";
  phaseLabel: string;
  // research chunks per swarm (index 0-2), keyed by model name
  research: Record<number, Record<string, string>>;
  // streaming analyst outputs
  analysts: [string, string, string];
  // streaming synthesis
  synthesis: string;
}

const INITIAL_SWARM: SwarmState = {
  phase: "idle",
  phaseLabel: "",
  research: { 0: {}, 1: {}, 2: {} },
  analysts: ["", "", ""],
  synthesis: "",
};

// ─── Style constants ──────────────────────────────────────────────────────────

const mono = "'IBM Plex Mono', 'SF Mono', 'Consolas', monospace";
const sans = "'Inter', system-ui, -apple-system, sans-serif";

const INSTANCE_COLORS = ["#00ffaa", "#4488ff", "#ff8844"] as const;
const EDGE_COLORS: Record<string, string> = {
  structural: "#00ffaa",
  temporal: "#4488ff",
  behavioral: "#ff8844",
  informational: "#aa44ff",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function PhaseBar({ swarm }: { swarm: SwarmState }) {
  if (swarm.phase === "idle") return null;

  const phases = ["decompose", "research", "synthesis"] as const;
  const current = phases.indexOf(swarm.phase as (typeof phases)[number]);

  return (
    <div
      style={{
        padding: "10px 24px",
        background: "#0a0a0d",
        borderBottom: "1px solid #ffffff06",
        display: "flex",
        alignItems: "center",
        gap: 24,
      }}
    >
      {phases.map((p, i) => (
        <div
          key={p}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            opacity: i <= current ? 1 : 0.2,
          }}
        >
          <div
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: i === current ? "#00ffaa" : "#333",
              boxShadow: i === current ? "0 0 8px #00ffaa60" : "none",
              animation: i === current ? "thinkpulse 1.2s ease infinite" : "none",
            }}
          />
          <span
            style={{
              fontFamily: mono,
              fontSize: 9,
              color: i === current ? "#00ffaa80" : "#333",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
            }}
          >
            {p}
          </span>
        </div>
      ))}
      <span
        style={{
          fontFamily: mono,
          fontSize: 10,
          color: "#2a2a2a",
          marginLeft: "auto",
        }}
      >
        {swarm.phaseLabel}
      </span>
    </div>
  );
}

function SwarmGrid({ swarm }: { swarm: SwarmState }) {
  const hasActivity =
    swarm.phase !== "idle" &&
    (swarm.analysts.some((a) => a.length > 0) ||
      Object.values(swarm.research).some((r) => Object.keys(r).length > 0));

  if (!hasActivity) return null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr",
        gap: 1,
        background: "#ffffff04",
        borderBottom: "1px solid #ffffff06",
      }}
    >
      {([0, 1, 2] as const).map((i) => (
        <div
          key={i}
          style={{
            padding: "12px 16px",
            background: "#09090b",
            borderRight: i < 2 ? "1px solid #ffffff04" : "none",
          }}
        >
          <div
            style={{
              fontFamily: mono,
              fontSize: 8,
              color: INSTANCE_COLORS[i] + "60",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              marginBottom: 8,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <div
              style={{
                width: 4,
                height: 4,
                borderRadius: "50%",
                background: swarm.analysts[i] ? INSTANCE_COLORS[i] : "#222",
                boxShadow: swarm.analysts[i]
                  ? `0 0 8px ${INSTANCE_COLORS[i]}40`
                  : "none",
                animation: swarm.analysts[i] ? "thinkpulse 1.5s ease infinite" : "none",
              }}
            />
            Analyst {i}
          </div>

          {/* Research briefs received */}
          {Object.entries(swarm.research[i] ?? {}).map(([model, text]) => (
            <div
              key={model}
              style={{
                marginBottom: 6,
                padding: "6px 8px",
                background: "#0c0c0f",
                borderRadius: 4,
                borderLeft: `1px solid ${INSTANCE_COLORS[i]}20`,
              }}
            >
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 8,
                  color: "#222",
                  marginBottom: 4,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                {model}
              </div>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 10,
                  color: "#2a2a2a",
                  lineHeight: 1.6,
                  maxHeight: 60,
                  overflow: "hidden",
                  WebkitMaskImage:
                    "linear-gradient(to bottom, black 60%, transparent 100%)",
                }}
              >
                {text.slice(0, 200)}
              </div>
            </div>
          ))}

          {/* Analyst streaming output */}
          {swarm.analysts[i] && (
            <div
              style={{
                fontFamily: sans,
                fontSize: 11,
                color: "#444",
                lineHeight: 1.6,
                maxHeight: 120,
                overflow: "hidden",
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 70%, transparent 100%)",
              }}
            >
              {swarm.analysts[i]}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function SynthesisStream({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div
      style={{
        padding: "16px 24px",
        borderBottom: "1px solid #ffffff04",
        background: "#0c0c0f",
      }}
    >
      <div style={{ maxWidth: 680, margin: "0 auto" }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 9,
            color: "#00ffaa30",
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Synthesizing
        </div>
        <div
          style={{
            fontFamily: sans,
            fontSize: 14,
            color: "#555",
            lineHeight: 1.75,
            whiteSpace: "pre-wrap",
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Arbiter() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [swarm, setSwarm] = useState<SwarmState>(INITIAL_SWARM);
  const [expandedAnalysts, setExpandedAnalysts] = useState<
    Record<string, boolean>
  >({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [messages, swarm, loading]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "24px";

    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    setSwarm(INITIAL_SWARM);

    try {
      const history = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText.slice(0, 300)}`);
      }
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (event.type === "phase") {
            setSwarm((s) => ({
              ...s,
              phase: event.phase as SwarmState["phase"],
              phaseLabel: String(event.label),
            }));
          } else if (event.type === "research_chunk") {
            const si = event.swarm as number;
            const model = String(event.model);
            const content = String(event.content);
            setSwarm((s) => ({
              ...s,
              research: {
                ...s.research,
                [si]: { ...(s.research[si] ?? {}), [model]: content },
              },
            }));
          } else if (event.type === "analyst_chunk") {
            const idx = event.instance as 0 | 1 | 2;
            const chunk = String(event.content);
            setSwarm((s) => {
              const analysts = [...s.analysts] as [string, string, string];
              analysts[idx] = analysts[idx] + chunk;
              return { ...s, analysts };
            });
          } else if (event.type === "synthesis_chunk") {
            setSwarm((s) => ({
              ...s,
              synthesis: s.synthesis + String(event.content),
            }));
          } else if (event.type === "complete") {
            const msg = event.message as Message;
            setMessages((prev) => [...prev, { ...msg }]);
            setSwarm(INITIAL_SWARM);
          } else if (event.type === "error") {
            setMessages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "assistant",
                content: `Error: ${event.message}`,
              },
            ]);
            setSwarm(INITIAL_SWARM);
          }
        }
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Connection interrupted. Retry.",
        },
      ]);
      setSwarm(INITIAL_SWARM);
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [input, loading, messages]);

  const isEmpty = messages.length === 0 && !loading;

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "#09090b",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 0px; }
        ::selection { background: #00ffaa22; color: #e0e0e0; }
        textarea::placeholder { color: #1e1e1e; }
        textarea:focus { outline: none; }
        @keyframes fadein { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes thinkpulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
      `}</style>

      {/* Header */}
      <div
        style={{
          padding: "14px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid #ffffff06",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#00ffaa",
              boxShadow: "0 0 10px #00ffaa60, 0 0 30px #00ffaa20",
              animation: "thinkpulse 3s ease infinite",
            }}
          />
          <span
            style={{
              fontFamily: mono,
              fontSize: 13,
              fontWeight: 600,
              color: "#555",
              letterSpacing: "0.08em",
            }}
          >
            ARBITER
          </span>
          <span
            style={{
              fontFamily: mono,
              fontSize: 9,
              color: "#1e1e1e",
              letterSpacing: "0.06em",
              marginLeft: 8,
            }}
          >
            arbitrage synthesis engine · first-principles swarm
          </span>
        </div>
        <span
          style={{
            fontFamily: mono,
            fontSize: 10,
            color: "#1e1e1e",
            letterSpacing: "0.06em",
          }}
        >
          v0.2 · openrouter
        </span>
      </div>

      {/* Phase bar (shows during active swarm) */}
      <div style={{ flexShrink: 0 }}>
        <PhaseBar swarm={swarm} />
      </div>

      {/* Swarm grid (shows during research/analysis phases) */}
      <div style={{ flexShrink: 0 }}>
        <SwarmGrid swarm={swarm} />
      </div>

      {/* Synthesis stream */}
      <div style={{ flexShrink: 0 }}>
        <SynthesisStream text={swarm.synthesis} />
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}
      >
        {isEmpty && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              padding: 40,
              animation: "fadein 0.6s ease",
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: "50%",
                border: "1px solid #1a1a1a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: "#00ffaa",
                  boxShadow: "0 0 20px #00ffaa40",
                }}
              />
            </div>
            <div
              style={{
                fontFamily: sans,
                fontSize: 14,
                color: "#444",
                textAlign: "center",
                maxWidth: 360,
                lineHeight: 1.6,
              }}
            >
              3 analysts. 9 researchers. One synthesis.
            </div>
            <div
              style={{
                marginTop: 32,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {[
                "What's the market mispricing right now?",
                "Find me an asymmetric bet in energy.",
                "Why is everyone wrong about rates?",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => {
                    setInput(q);
                    setTimeout(() => textareaRef.current?.focus(), 10);
                  }}
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    color: "#333",
                    background: "transparent",
                    border: "1px solid #1a1a1a",
                    borderRadius: 8,
                    padding: "10px 16px",
                    cursor: "pointer",
                    textAlign: "left",
                    transition: "all 0.25s ease",
                    maxWidth: 340,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "#00ffaa30";
                    e.currentTarget.style.color = "#888";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "#1a1a1a";
                    e.currentTarget.style.color = "#333";
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              animation: "fadein 0.35s ease",
              padding:
                msg.role === "user" ? "20px 24px" : "24px 24px 28px",
              borderBottom: "1px solid #ffffff04",
              background: msg.role === "assistant" ? "#0c0c0f" : "transparent",
            }}
          >
            <div style={{ maxWidth: 680, margin: "0 auto" }}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color:
                    msg.role === "user" ? "#2a2a2a" : "#00ffaa40",
                  marginBottom: 8,
                }}
              >
                {msg.role === "user" ? "You" : "Arbiter"}
              </div>

              {/* Analyst outputs toggle (assistant only) */}
              {msg.analysts && msg.analysts.length > 0 && (
                <button
                  onClick={() =>
                    setExpandedAnalysts((prev) => ({
                      ...prev,
                      [msg.id]: !prev[msg.id],
                    }))
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: mono,
                    fontSize: 10,
                    color: "#222",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                    marginBottom: expandedAnalysts[msg.id] ? 0 : 12,
                    padding: "4px 0",
                    transition: "color 0.2s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = "#555")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = "#222")
                  }
                >
                  <span
                    style={{
                      display: "inline-block",
                      transition: "transform 0.2s",
                      transform: expandedAnalysts[msg.id]
                        ? "rotate(90deg)"
                        : "rotate(0deg)",
                      fontSize: 8,
                    }}
                  >
                    ▶
                  </span>
                  3 analyst threads
                  {msg.confidence != null && (
                    <span style={{ color: "#191919", marginLeft: 8 }}>
                      · {(msg.confidence * 100).toFixed(0)}% conviction
                    </span>
                  )}
                </button>
              )}

              {/* Expanded analyst outputs */}
              {msg.analysts && expandedAnalysts[msg.id] && (
                <div
                  style={{
                    margin: "8px 0 16px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                  }}
                >
                  {msg.analysts.map((analysis, i) => (
                    <div
                      key={i}
                      style={{
                        padding: "10px 14px",
                        background: "#09090b",
                        borderRadius: 6,
                        borderLeft: `2px solid ${INSTANCE_COLORS[i]}20`,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: mono,
                          fontSize: 8,
                          color: INSTANCE_COLORS[i] + "50",
                          marginBottom: 6,
                          textTransform: "uppercase",
                          letterSpacing: "0.1em",
                        }}
                      >
                        Analyst {i}
                      </div>
                      <div
                        style={{
                          fontFamily: sans,
                          fontSize: 12,
                          color: "#333",
                          lineHeight: 1.65,
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {analysis}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Main content */}
              <div
                style={{
                  fontFamily: sans,
                  fontSize: 14,
                  lineHeight: 1.75,
                  color: msg.role === "user" ? "#777" : "#999",
                  whiteSpace: "pre-wrap",
                }}
              >
                {msg.content
                  .split(/(\*[^*]+\*)/)
                  .map((part, i) =>
                    part.startsWith("*") && part.endsWith("*") ? (
                      <em
                        key={i}
                        style={{ color: "#bbb", fontStyle: "italic" }}
                      >
                        {part.slice(1, -1)}
                      </em>
                    ) : (
                      part
                    )
                  )}
              </div>

              {/* Edge tag */}
              {msg.edgeTag && (
                <div
                  style={{
                    marginTop: 16,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontFamily: mono,
                    fontSize: 9,
                    color: "#1e1e1e",
                    padding: "4px 10px",
                    borderRadius: 4,
                    border: "1px solid #151515",
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                  }}
                >
                  <span
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: "50%",
                      background:
                        EDGE_COLORS[msg.edgeTag] ?? "#888",
                      opacity: 0.5,
                    }}
                  />
                  {msg.edgeTag} edge
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Loading indicator — only when no swarm activity yet */}
        {loading && swarm.phase === "idle" && (
          <div
            style={{
              padding: "24px",
              background: "#0c0c0f",
              borderBottom: "1px solid #ffffff04",
              animation: "fadein 0.3s ease",
            }}
          >
            <div style={{ maxWidth: 680, margin: "0 auto" }}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "#00ffaa30",
                  marginBottom: 12,
                }}
              >
                Arbiter
              </div>
              <div
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#00ffaa",
                    animation: "thinkpulse 1.5s ease infinite",
                    boxShadow: "0 0 12px #00ffaa40",
                  }}
                />
                <span
                  style={{
                    fontFamily: mono,
                    fontSize: 11,
                    color: "#2a2a2a",
                    animation: "thinkpulse 2s ease infinite",
                  }}
                >
                  initializing swarm…
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div
        style={{
          padding: "16px 24px 20px",
          borderTop: "1px solid #ffffff06",
          background: "#09090b",
          flexShrink: 0,
        }}
      >
        <div style={{ maxWidth: 680, margin: "0 auto" }}>
          <div
            ref={inputRef}
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 12,
              background: "#0e0e11",
              border: "1px solid #1a1a1a",
              borderRadius: 12,
              padding: "12px 16px",
              transition: "border-color 0.3s ease",
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => {
                if (inputRef.current)
                  inputRef.current.style.borderColor = "#252525";
              }}
              onBlur={() => {
                if (inputRef.current)
                  inputRef.current.style.borderColor = "#1a1a1a";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="What should I think about?"
              rows={1}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                resize: "none",
                color: "#ccc",
                fontSize: 14,
                fontFamily: sans,
                lineHeight: "24px",
                minHeight: 24,
                maxHeight: 144,
                overflowY: "auto",
              }}
              onInput={(e) => {
                const el = e.target as HTMLTextAreaElement;
                el.style.height = "24px";
                el.style.height =
                  Math.min(el.scrollHeight, 144) + "px";
              }}
            />
            <button
              onClick={send}
              disabled={!input.trim() || loading}
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                border: "none",
                background:
                  input.trim() && !loading ? "#00ffaa" : "#1a1a1a",
                color: input.trim() && !loading ? "#000" : "#333",
                cursor:
                  input.trim() && !loading ? "pointer" : "default",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.3s ease",
                fontSize: 14,
                fontWeight: 600,
                flexShrink: 0,
              }}
            >
              ↑
            </button>
          </div>
          <div
            style={{
              marginTop: 8,
              fontFamily: mono,
              fontSize: 9,
              color: "#1a1a1a",
              textAlign: "center",
              letterSpacing: "0.06em",
            }}
          >
            3×gemini research · bull · bear · moderate · deepseek synthesis
          </div>
        </div>
      </div>
    </div>
  );
}
