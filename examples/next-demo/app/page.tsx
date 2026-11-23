"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

type Message = { id: string; role: string; content: string };
type Fact = { id: string; content: string; sourceMessageId: string; sourceConversationId: string };
type NoteItem = { id: string; content: string };
type PromptCall = { messages: Array<{ role: string; content?: unknown }> };
type ToolTraceEntry = { name: string; status: string; detail: string };
type RetrievedMemory = Fact & { sourceMessage?: Message | null };

type DemoState = {
  conversationId: string;
  messages: Message[];
  latestSummary: { content: string } | null;
  knownFacts: Fact[];
  sourceMessages: Message[];
  workingMemoryItems: NoteItem[];
  workingMemoryTokenUsage: number;
  workingMemoryTokenBudget: number;
  contextInputTokenBudget: number;
};

type SemanticOutcome =
  | { status: "success"; result: { saved: Array<{ id: string; content: string }> } }
  | { status: "failed"; error: string };

type TurnTrace = {
  promptCalls: PromptCall[];
  toolTrace: ToolTraceEntry[];
  retrievedMemories: RetrievedMemory[];
  semanticMemory?: SemanticOutcome;
};

export default function Home() {
  const [state, setState] = useState<DemoState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [resumeUserMessageId, setResumeUserMessageId] = useState<string | undefined>();
  const [trace, setTrace] = useState<TurnTrace | null>(null);
  const [openCall, setOpenCall] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        setLoadError(body.error ?? "Unable to load demo state");
        return;
      }
      setLoadError(null);
      setState(body as DemoState);
    } catch {
      setLoadError("Could not reach the local demo server.");
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const userMessage = draft.trim();
    if (!userMessage || pending) return;
    setPending(true);
    setTurnError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userMessage, ...(resumeUserMessageId ? { resumeUserMessageId } : {}) }),
      });
      const body = await response.json();
      setTrace({
        promptCalls: body.promptCalls ?? [],
        toolTrace: body.toolTrace ?? [],
        retrievedMemories: body.retrievedMemories ?? [],
        semanticMemory: body.semanticMemory,
      });
      setOpenCall(null);
      if (!response.ok) {
        setTurnError(body.error ?? "The agent turn failed.");
        setResumeUserMessageId(body.resumeUserMessageId);
      } else {
        setDraft("");
        setResumeUserMessageId(undefined);
      }
    } catch {
      setTurnError("Could not reach the local demo server.");
    } finally {
      setPending(false);
      await refresh();
    }
  }

  async function newConversation() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch("/api/conversation", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setTurnError(body.error ?? "Unable to start a new conversation");
      } else {
        setTrace(null);
        setTurnError(null);
        setResumeUserMessageId(undefined);
      }
    } catch {
      setTurnError("Could not reach the local demo server.");
    } finally {
      setPending(false);
      await refresh();
    }
  }

  const messages = state?.messages.filter((m) => m.role === "user" || m.role === "assistant") ?? [];
  const budget = state?.contextInputTokenBudget ?? 12_000;
  const lastCall = trace?.promptCalls.at(-1);
  // Rough estimate (~4 chars/token) for the meter; exact counting happens server-side.
  const contextEstimate = lastCall ? Math.round(JSON.stringify(lastCall.messages).length / 4) : 0;
  const meterPercent = Math.min(100, Math.round((contextEstimate / budget) * 100));
  const sourceById = new Map(state?.sourceMessages.map((m) => [m.id, m]) ?? []);

  return (
    <main className="lab-shell">
      <header className="topbar">
        <a className="brand" href="#home" aria-label="Recall Engine Memory Lab home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>recall<span className="brand-light">engine</span></span>
        </a>
        <div className="topbar-meta">
          <span className="local-pill"><span className="status-dot" /> LOCAL DEMO</span>
          <span className="model-label">HOST MODEL <b>GPT-OSS-120B</b></span>
        </div>
      </header>

      <section className="page-heading" id="home">
        <div>
          <p className="eyebrow">MEMORY LAB <span>/</span> CONVERSATION {state?.conversationId.slice(0, 8).toUpperCase() ?? "—"}</p>
          <h1>Memory, <em>in motion.</em></h1>
          <p className="heading-copy">Talk to the agent. Follow what it carries forward.</p>
        </div>
        <button className="new-conversation" type="button" onClick={newConversation} disabled={pending || !state}>
          <span aria-hidden="true">＋</span> New conversation
        </button>
      </section>

      {loadError && (
        <p className="error-banner" role="alert">
          {loadError} — check <code>.env</code> and that PostgreSQL, Redis and Qdrant are running (<code>docker compose up -d</code>).
        </p>
      )}

      <div className="workspace">
        <section className="conversation-panel" aria-labelledby="conversation-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ACTIVE THREAD</p>
              <h2 id="conversation-title">A conversation with memory</h2>
            </div>
            <span className="sequence-label">{messages.length ? `${messages.length} MESSAGES` : "NO MESSAGES YET"}</span>
          </div>

          {messages.length === 0 && !pending ? (
            <div className="conversation-empty">
              <div className="empty-glyph" aria-hidden="true">
                <span className="glyph-orbit orbit-one" />
                <span className="glyph-orbit orbit-two" />
                <span className="glyph-core" />
                <span className="glyph-node node-one" />
                <span className="glyph-node node-two" />
                <span className="glyph-node node-three" />
              </div>
              <p className="empty-kicker">A GOOD FIRST TEST</p>
              <h3>Tell the agent something worth remembering.</h3>
              <p className="empty-copy">
                Share a lasting preference, then ask about it in another conversation.
                The inspector will show what was kept and why.
              </p>
              <div className="example-prompts" aria-label="Example memory prompts">
                {["I prefer quiet places to work.", "We’re planning a week in Kyoto."].map((example) => (
                  <button type="button" key={example} onClick={() => setDraft(example)}>“{example}”</button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="transcript" aria-live="polite">
              {messages.map((message) => (
                <li key={message.id} className={`bubble bubble-${message.role}`}>
                  <span className="bubble-role">{message.role === "user" ? "YOU" : "AGENT"}</span>
                  <p>{message.content}</p>
                </li>
              ))}
              {pending && (
                <li className="bubble bubble-assistant bubble-pending">
                  <span className="bubble-role">AGENT</span>
                  <p>Thinking…</p>
                </li>
              )}
            </ol>
          )}

          <form className="composer" aria-label="Send a message to the demo agent" onSubmit={send}>
            <label className="sr-only" htmlFor="message">Your message</label>
            <textarea
              id="message"
              placeholder="Write a message to the agent…"
              rows={2}
              value={draft}
              maxLength={8_000}
              disabled={pending || !state}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-footer">
              <span>Model calls and memory tools run on this server.</span>
              <button type="submit" disabled={pending || !draft.trim() || !state} aria-label="Send message">↑</button>
            </div>
          </form>
          {turnError && (
            <p className="setup-note error-note" role="alert">
              {turnError}{resumeUserMessageId ? " Your message is saved — send again to retry this turn." : ""}
            </p>
          )}
        </section>

        <aside className="inspector" aria-labelledby="inspector-title">
          <div className="inspector-heading">
            <div>
              <p className="eyebrow">LIVE TRACE</p>
              <h2 id="inspector-title">Memory inspector</h2>
            </div>
            <span className="trace-state">{pending ? "RUNNING" : trace ? "LAST TURN" : "IDLE"}</span>
          </div>

          <section className="context-meter" aria-label="Context budget">
            <div className="meter-labels">
              <span>CONTEXT INPUT (EST.)</span>
              <span>{contextEstimate.toLocaleString()} <i>/</i> {budget.toLocaleString()} TOKENS</span>
            </div>
            <div className="meter-track"><span style={{ width: `${meterPercent}%` }} /></div>
            <div className="meter-foot">
              <span>Compaction starts at 80%</span>
              <span>Target 65%</span>
            </div>
          </section>

          <section className="memory-layers" aria-label="Memory layers">
            <div className="section-caption"><span>MEMORY LAYERS</span><span>3</span></div>
            <div className="trace-list">
              <article className="trace-row">
                <div className="trace-rail"><span>01</span></div>
                <div className="trace-copy">
                  <h3>Working memory</h3>
                  <p>Redis · {state?.workingMemoryTokenUsage ?? 0} / {state?.workingMemoryTokenBudget ?? 0} tokens</p>
                  {state?.workingMemoryItems.length
                    ? <ul className="layer-items">{state.workingMemoryItems.map((note) => <li key={note.id}>{note.content}</li>)}</ul>
                    : <span className="trace-empty-state">No task notes</span>}
                </div>
              </article>
              <article className="trace-row">
                <div className="trace-rail"><span>02</span></div>
                <div className="trace-copy">
                  <h3>Episodic memory</h3>
                  <p>PostgreSQL · {state?.messages.length ?? 0} messages</p>
                  {state?.latestSummary
                    ? <details className="layer-details"><summary>Latest summary</summary><p>{state.latestSummary.content}</p></details>
                    : <span className="trace-empty-state">No summary yet</span>}
                </div>
              </article>
              <article className="trace-row">
                <div className="trace-rail"><span>03</span></div>
                <div className="trace-copy">
                  <h3>Semantic memory</h3>
                  <p>PostgreSQL + Qdrant · {state?.knownFacts.length ?? 0} saved facts</p>
                  {state?.knownFacts.length ? (
                    <ul className="layer-items">
                      {state.knownFacts.map((fact) => {
                        const source = sourceById.get(fact.sourceMessageId);
                        return (
                          <li key={fact.id}>
                            {fact.content}
                            {source && <small>from: “{source.content.slice(0, 80)}”</small>}
                          </li>
                        );
                      })}
                    </ul>
                  ) : <span className="trace-empty-state">No facts saved yet</span>}
                </div>
              </article>
            </div>
          </section>

          <section className="model-trace">
            <div className="section-caption"><span>LAST TURN</span><span>{trace?.promptCalls.length ?? 0} CALLS</span></div>
            {!trace ? (
              <div className="trace-placeholder">
                <span className="placeholder-line" />
                <p>Each prompt and memory-tool result will appear here.</p>
              </div>
            ) : (
              <ol className="turn-trace">
                {trace.retrievedMemories.length > 0 && (
                  <li>
                    <b>Recalled {trace.retrievedMemories.length} fact(s)</b>
                    <ul className="layer-items">
                      {trace.retrievedMemories.map((memory) => (
                        <li key={memory.id}>
                          {memory.content}
                          {memory.sourceMessage && <small>from: “{memory.sourceMessage.content.slice(0, 80)}”</small>}
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                {trace.promptCalls.map((call, index) => (
                  <li key={`call-${index}`}>
                    <button
                      type="button"
                      className="trace-toggle"
                      onClick={() => setOpenCall(openCall === index ? null : index)}
                      aria-expanded={openCall === index}
                    >
                      Model call {index + 1} · {call.messages.length} messages
                    </button>
                    {openCall === index && <pre className="prompt-dump">{JSON.stringify(call.messages, null, 2)}</pre>}
                  </li>
                ))}
                {trace.toolTrace.map((tool, index) => (
                  <li key={`tool-${index}`}>
                    <b>{tool.name}</b> · {tool.status}
                    <small>{tool.detail}</small>
                  </li>
                ))}
                {trace.semanticMemory && (
                  <li>
                    <b>Fact extraction</b> · {trace.semanticMemory.status}
                    <small>
                      {trace.semanticMemory.status === "success"
                        ? `${trace.semanticMemory.result.saved.length} new fact(s) saved`
                        : trace.semanticMemory.error}
                    </small>
                  </li>
                )}
              </ol>
            )}
          </section>

          <div className="inspector-footer">
            <span className="footer-light" />
            <span>LOCAL STORES</span>
            <span className="footer-services">REDIS <i>·</i> POSTGRES <i>·</i> QDRANT</span>
          </div>
        </aside>
      </div>
      <footer className="page-footer">
        <span>RECALL ENGINE <i>0.1</i></span>
        <span>EXACT HISTORY <b>→</b> COMPACTED CONTEXT <b>→</b> DURABLE FACTS</span>
      </footer>
    </main>
  );
}
