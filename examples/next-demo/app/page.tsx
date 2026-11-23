"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Plus, SendHorizontal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Role = "system" | "user" | "assistant" | "tool";
type Message = { id: string; role: Role; content: string; sequenceNo: number };
type Category = "preference" | "profile" | "project_fact";
type Fact = {
  id: string;
  content: string;
  category: Category;
  status: "active" | "superseded";
  sourceMessageId: string;
  sourceConversationId: string;
};
type Note = { id: string; content: string; tokenCount: number; priority: number };
type Summary = { summaryText: string; version: number; throughSequenceNo: number } | null;

type DemoState = {
  conversationId: string;
  messages: Message[];
  latestSummary: Summary;
  knownFacts: Fact[];
  sourceMessages: Array<Pick<Message, "id" | "content">>;
  workingMemoryItems: Note[];
  workingMemoryTokenUsage: number;
  workingMemoryTokenBudget: number;
  contextInputTokenBudget: number;
};

type PromptMessage = { role: string; content?: unknown; tool_calls?: unknown };
type RetrievedMemory = {
  semanticMemoryId: string;
  content: string;
  category: Category;
  score: number;
  sourceMessage?: Pick<Message, "id" | "content"> | null;
};
type Candidate = { content: string; category: Category };
type SemanticOutcome =
  | {
    status: "success";
    result: {
      extracted: Candidate[];
      saved: Fact[];
      skipped: Array<{ candidate: Candidate; reason: string }>;
      supersededMemoryIds: string[];
    };
  }
  | { status: "failed"; error: string };

type Compaction = {
  tokenCount: number;
  inputTokenBudget: number;
  compactionPerformed: boolean;
  targetReached: boolean;
  summaryBatches: number;
  summaryVersion: number | null;
  summaryThroughSequenceNo: number | null;
};

type TurnTrace = {
  userMessage: string;
  ok: boolean;
  error?: string;
  assistantMessageId?: string;
  compaction?: Compaction;
  promptCalls: Array<{ messages: PromptMessage[] }>;
  toolTrace: Array<{ name: string; status: string; detail: string }>;
  retrievedMemories: RetrievedMemory[];
  semanticMemory?: SemanticOutcome;
};

type Tab = "turn" | "memory" | "prompt";

const EXAMPLES = [
  "I prefer concise answers with code examples.",
  "I'm planning a week in Kyoto in April, budget $2,000.",
  "What do you remember about me?",
];

export default function Home() {
  const [state, setState] = useState<DemoState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turnError, setTurnError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [resumeUserMessageId, setResumeUserMessageId] = useState<string | undefined>();
  const [traces, setTraces] = useState<TurnTrace[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("turn");
  const bottom = useRef<HTMLDivElement>(null);

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
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [state?.messages.length, pending]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const userMessage = draft.trim();
    if (!userMessage || pending) return;
    setPending(userMessage);
    setDraft("");
    setTurnError(null);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userMessage, ...(resumeUserMessageId ? { resumeUserMessageId } : {}) }),
      });
      const body = await response.json();
      const trace: TurnTrace = {
        userMessage,
        ok: response.ok,
        error: body.error,
        assistantMessageId: body.assistantMessage?.id,
        compaction: body.compaction,
        promptCalls: body.promptCalls ?? [],
        toolTrace: body.toolTrace ?? [],
        retrievedMemories: body.retrievedMemories ?? [],
        semanticMemory: body.semanticMemory,
      };
      setTraces((current) => {
        setSelected(current.length);
        return [...current, trace];
      });
      setTab("turn");
      if (!response.ok) {
        setTurnError(body.error ?? "The agent turn failed.");
        setResumeUserMessageId(body.resumeUserMessageId);
        setDraft(userMessage);
      } else {
        setResumeUserMessageId(undefined);
      }
    } catch {
      setTurnError("Could not reach the local demo server.");
      setDraft(userMessage);
    } finally {
      setPending(null);
      await refresh();
    }
  }

  async function newConversation() {
    if (pending) return;
    try {
      const response = await fetch("/api/conversation", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setTurnError(body.error ?? "Unable to start a new conversation");
        return;
      }
      setTraces([]);
      setSelected(null);
      setTurnError(null);
      setResumeUserMessageId(undefined);
    } catch {
      setTurnError("Could not reach the local demo server.");
    } finally {
      await refresh();
    }
  }

  const messages = state?.messages.filter((m) => m.role === "user" || m.role === "assistant") ?? [];
  const traceByAssistantId = new Map(
    traces.flatMap((trace, index) => (trace.assistantMessageId ? [[trace.assistantMessageId, index] as const] : [])),
  );
  const trace = selected === null ? null : traces[selected] ?? null;
  const pendingAlreadySaved = !!pending && messages.some((m) => m.id === resumeUserMessageId);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b px-5 py-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-sm font-semibold">Memory Lab</h1>
          <span className="truncate font-mono text-xs text-muted-foreground">
            {state ? `conversation ${state.conversationId.slice(0, 8)}` : "connecting…"}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={newConversation} disabled={!!pending || !state}>
          <Plus /> New conversation
        </Button>
      </header>

      {loadError && (
        <p role="alert" className="border-b bg-destructive/5 px-5 py-2 text-sm text-destructive">
          {loadError} — check .env and that PostgreSQL, Redis and Qdrant are running.
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Conversation */}
        <section aria-label="Conversation" className="flex min-h-[70vh] flex-col border-b md:min-h-0 md:border-r md:border-b-0">
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-1 p-5" aria-live="polite">
              {messages.length === 0 && !pending ? (
                <div className="mx-auto mt-24 max-w-sm text-center">
                  <h2 className="text-sm font-semibold">Start a conversation</h2>
                  <p className="mt-1 mb-4 text-sm text-muted-foreground">
                    Share something lasting, start a new conversation, then ask about it. Select a reply to inspect its turn.
                  </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {EXAMPLES.map((example) => (
                      <Button key={example} variant="outline" size="sm" className="h-auto rounded-full py-1 text-xs font-normal" onClick={() => setDraft(example)}>
                        {example}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {messages.map((message) => {
                    const traceIndex = traceByAssistantId.get(message.id);
                    return (
                      <ChatMessage
                        key={message.id}
                        seq={message.sequenceNo}
                        role={message.role}
                        content={message.content}
                        selected={traceIndex !== undefined && selected === traceIndex}
                        onInspect={traceIndex === undefined ? undefined : () => { setSelected(traceIndex); setTab("turn"); }}
                      />
                    );
                  })}
                  {pending && !pendingAlreadySaved && <ChatMessage seq="·" role="user" content={pending} />}
                  {pending && <ChatMessage seq="·" role="assistant" content="Thinking…" muted />}
                </>
              )}
              <div ref={bottom} />
            </div>
          </ScrollArea>

          <form onSubmit={send} className="border-t px-5 pt-3 pb-4">
            <div className="flex items-end gap-2">
              <label className="sr-only" htmlFor="message">Message</label>
              <Textarea
                id="message"
                rows={1}
                placeholder="Message the agent…"
                className="max-h-40 min-h-10 resize-none"
                value={draft}
                maxLength={8_000}
                disabled={!!pending || !state}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <Button type="submit" size="icon" className="size-10" disabled={!!pending || !draft.trim() || !state} aria-label="Send">
                <SendHorizontal />
              </Button>
            </div>
            <p role={turnError ? "alert" : undefined} className={cn("mt-1.5 text-xs", turnError ? "text-destructive" : "text-muted-foreground")}>
              {turnError
                ? `${turnError}${resumeUserMessageId ? " Your message is saved — send again to retry." : ""}`
                : "Enter to send · Shift+Enter for a new line"}
            </p>
          </form>
        </section>

        {/* Inspector */}
        <aside aria-label="Memory inspector" className="flex min-h-0 flex-col bg-card">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b px-4 py-2">
              <TabsList>
                <TabsTrigger value="turn">Turn{trace && <Count>#{(selected ?? 0) + 1}</Count>}</TabsTrigger>
                <TabsTrigger value="memory">Memory{state && <Count>{state.knownFacts.length + state.workingMemoryItems.length}</Count>}</TabsTrigger>
                <TabsTrigger value="prompt">Prompt{trace && <Count>{trace.promptCalls.length}</Count>}</TabsTrigger>
              </TabsList>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-5 pb-8">
                <TabsContent value="turn"><TurnPanel trace={trace} /></TabsContent>
                <TabsContent value="memory"><MemoryPanel state={state} /></TabsContent>
                <TabsContent value="prompt"><PromptPanel trace={trace} /></TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        </aside>
      </div>
    </div>
  );
}

function ChatMessage({ seq, role, content, selected, onInspect, muted }: {
  seq: number | string; role: Role; content: string; selected?: boolean; onInspect?: () => void; muted?: boolean;
}) {
  const inner = (
    <>
      <span className="pt-0.5 font-mono text-[11px] text-muted-foreground/70">{seq}</span>
      <div className="min-w-0">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{role === "user" ? "You" : "Agent"}</span>
        <p className={cn("mt-0.5 text-sm break-words whitespace-pre-wrap", muted && "text-muted-foreground")}>{content}</p>
        {onInspect && (
          <span className="mt-1 inline-flex items-center text-[11px] text-muted-foreground">Inspect turn <ChevronRight className="size-3" /></span>
        )}
      </div>
    </>
  );
  const base = cn(
    "grid w-full grid-cols-[28px_1fr] gap-2 rounded-lg border border-transparent px-2.5 py-2 text-left",
    role === "user" && "bg-muted/60",
    selected && "border-border bg-card",
  );
  return onInspect
    ? <button type="button" onClick={onInspect} className={cn(base, "cursor-pointer hover:border-border")}>{inner}</button>
    : <div className={base}>{inner}</div>;
}

function Count({ children }: { children: ReactNode }) {
  return <span className="ml-1 font-mono text-[11px] text-muted-foreground">{children}</span>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="py-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {aside && <span className="font-mono text-[11px] text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground/80">{children}</p>;
}

function Row({ main, side, sub, dim }: { main: ReactNode; side?: ReactNode; sub?: ReactNode; dim?: boolean }) {
  return (
    <li className="border-t py-2 first:border-t-0 first:pt-0">
      <div className="flex justify-between gap-3">
        <span className={cn("text-sm break-words", dim && "text-muted-foreground")}>{main}</span>
        {side && <span className="shrink-0">{side}</span>}
      </div>
      {sub && <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{sub}</div>}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-base font-medium">{value}</dd>
    </div>
  );
}

function Source({ content }: { content?: string }) {
  if (!content) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help truncate italic">from “{truncate(content, 70)}”</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap">{content}</TooltipContent>
    </Tooltip>
  );
}

function TurnPanel({ trace }: { trace: TurnTrace | null }) {
  if (!trace) return <Placeholder>Send a message, or select an agent reply, to see what memory did on that turn.</Placeholder>;
  const c = trace.compaction;
  const percent = c ? Math.min(100, (c.tokenCount / c.inputTokenBudget) * 100) : 0;
  const outcome = trace.semanticMemory;

  return (
    <div className="divide-y">
      <Section title="Request">
        <p className="text-sm">{trace.userMessage}</p>
        {!trace.ok && <p className="mt-1 text-xs text-destructive"><Badge variant="destructive" className="mr-1.5">failed</Badge>{trace.error}</p>}
      </Section>

      {c && (
        <Section title="Context window" aside={c.compactionPerformed ? `compacted · summary v${c.summaryVersion ?? "?"}` : "no compaction"}>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
            <Stat label="Prompt tokens" value={c.tokenCount.toLocaleString()} />
            <Stat label="Budget" value={c.inputTokenBudget.toLocaleString()} />
            <Stat label="Used" value={`${percent.toFixed(0)}%`} />
            <Stat label="Model calls" value={trace.promptCalls.length} />
          </dl>
          <div className="relative mt-3">
            <Progress value={percent} aria-label={`${percent.toFixed(0)}% of context budget`} />
            <span className="absolute -top-0.5 h-[calc(100%+4px)] w-px bg-muted-foreground/50" style={{ left: "65%" }} />
            <span className="absolute -top-0.5 h-[calc(100%+4px)] w-px bg-muted-foreground/50" style={{ left: "80%" }} />
          </div>
          <div className="mt-1 flex justify-between font-mono text-[11px] text-muted-foreground"><span>0</span><span>target 65% · compact at 80%</span></div>
          {c.compactionPerformed && (
            <p className="mt-2 text-xs text-muted-foreground">
              Summarized {c.summaryBatches} batch(es) through message #{c.summaryThroughSequenceNo}{c.targetReached ? "." : " — target not reached."}
            </p>
          )}
        </Section>
      )}

      <Section title="Recalled facts" aside={trace.retrievedMemories.length}>
        {trace.retrievedMemories.length === 0 ? <Empty>No semantic memories matched this message.</Empty> : (
          <ul>
            {trace.retrievedMemories.map((memory) => (
              <Row
                key={memory.semanticMemoryId}
                main={memory.content}
                side={<span className="font-mono text-xs text-muted-foreground">{memory.score.toFixed(3)}</span>}
                sub={<><Badge variant="outline">{memory.category}</Badge><Source content={memory.sourceMessage?.content} /></>}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Working-memory tools" aside={`${trace.toolTrace.length} / 3`}>
        {trace.toolTrace.length === 0 ? <Empty>The agent did not use any tools.</Empty> : (
          <ul>
            {trace.toolTrace.map((tool, index) => (
              <Row
                key={index}
                main={<span className="font-mono text-xs">{tool.name}</span>}
                side={<Badge variant={tool.status === "rejected" ? "destructive" : "secondary"}>{tool.status}</Badge>}
                sub={tool.detail}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Fact extraction"
        aside={outcome?.status === "success"
          ? `${outcome.result.extracted.length} extracted · ${outcome.result.saved.length} saved · ${outcome.result.skipped.length} skipped`
          : outcome?.status}
      >
        {!outcome ? <Empty>Extraction did not run (the turn did not complete).</Empty>
          : outcome.status === "failed" ? <p className="text-xs text-destructive"><Badge variant="destructive" className="mr-1.5">failed</Badge>{outcome.error}</p>
          : outcome.result.extracted.length === 0 ? <Empty>Nothing worth remembering in this turn.</Empty>
          : (
            <ul>
              {outcome.result.saved.map((fact) => (
                <Row
                  key={fact.id}
                  main={fact.content}
                  side={<Badge>saved</Badge>}
                  sub={<><Badge variant="outline">{fact.category}</Badge>{fact.status === "active" && outcome.result.supersededMemoryIds.length > 0 && "supersedes an earlier fact"}</>}
                />
              ))}
              {outcome.result.skipped.map((skip, index) => (
                <Row
                  key={`skip-${index}`}
                  dim
                  main={skip.candidate.content}
                  side={<Badge variant="outline">skipped</Badge>}
                  sub={<><Badge variant="outline">{skip.candidate.category}</Badge>{skip.reason.replaceAll("_", " ")}</>}
                />
              ))}
            </ul>
          )}
      </Section>
    </div>
  );
}

function MemoryPanel({ state }: { state: DemoState | null }) {
  if (!state) return <Placeholder>Loading memory…</Placeholder>;
  const sources = new Map(state.sourceMessages.map((m) => [m.id, m.content]));
  const wmPercent = state.workingMemoryTokenBudget
    ? Math.min(100, (state.workingMemoryTokenUsage / state.workingMemoryTokenBudget) * 100)
    : 0;

  return (
    <div className="divide-y">
      <Section title="Working memory · Redis" aside={`${state.workingMemoryTokenUsage} / ${state.workingMemoryTokenBudget} tokens`}>
        <Progress value={wmPercent} className="mb-3" />
        {state.workingMemoryItems.length === 0 ? <Empty>No task notes. Cleared on new conversation.</Empty> : (
          <ul>
            {state.workingMemoryItems.map((note) => (
              <Row key={note.id} main={note.content} side={<span className="font-mono text-xs text-muted-foreground">{note.tokenCount} tok</span>} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Episodic memory · PostgreSQL"
        aside={state.latestSummary ? `${state.messages.length} msgs · summary v${state.latestSummary.version}` : `${state.messages.length} msgs`}
      >
        {state.latestSummary ? (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              Messages #1–{state.latestSummary.throughSequenceNo} are summarized; later messages are sent verbatim.
            </p>
            <p className="rounded-lg border bg-muted/40 px-3 py-2.5 text-sm whitespace-pre-wrap">{state.latestSummary.summaryText}</p>
          </>
        ) : <Empty>No summary yet — the full transcript fits in the context budget.</Empty>}
      </Section>

      <Section title="Semantic memory · PostgreSQL + Qdrant" aside={`${state.knownFacts.length} facts`}>
        {state.knownFacts.length === 0 ? <Empty>No durable facts saved yet. Facts persist across conversations.</Empty> : (
          <ul>
            {state.knownFacts.map((fact) => (
              <Row
                key={fact.id}
                dim={fact.status === "superseded"}
                main={fact.content}
                side={fact.status === "superseded" ? <Badge variant="outline">superseded</Badge> : undefined}
                sub={<><Badge variant="outline">{fact.category}</Badge><Source content={sources.get(fact.sourceMessageId)} /></>}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PromptPanel({ trace }: { trace: TurnTrace | null }) {
  if (!trace) return <Placeholder>Select a turn to see the exact messages sent to the model.</Placeholder>;
  if (trace.promptCalls.length === 0) return <Placeholder>No model calls were recorded for this turn.</Placeholder>;
  return (
    <div className="space-y-3 pt-4">
      {trace.promptCalls.map((call, index) => (
        <div key={index} className="overflow-hidden rounded-lg border">
          <div className="flex justify-between bg-muted/60 px-3 py-2 text-sm font-medium">
            Call {index + 1}
            <span className="font-mono text-[11px] font-normal text-muted-foreground">
              {call.messages.length} messages · {call.messages.reduce((n, m) => n + text(m).length, 0).toLocaleString()} chars
            </span>
          </div>
          {call.messages.map((message, i) => (
            <Collapsible key={i} className="group border-t">
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40">
                <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
                <span className="w-16 shrink-0 font-mono text-muted-foreground">{label(message)}</span>
                <span className="min-w-0 flex-1 truncate">{text(message).replace(/\s+/g, " ")}</span>
                <span className="font-mono text-muted-foreground/70">{text(message).length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Separator className="border-dashed" />
                <pre className="max-h-80 overflow-auto bg-muted/30 px-3 py-2.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">{text(message)}</pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ))}
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function text(message: PromptMessage): string {
  if (typeof message.content === "string" && message.content) return message.content;
  if (message.tool_calls) return JSON.stringify(message.tool_calls, null, 2);
  return message.content == null ? "" : JSON.stringify(message.content, null, 2);
}

function label(message: PromptMessage): string {
  if (message.role === "system") {
    const head = text(message).slice(0, 120);
    if (text(message).includes("<temporary-task-notes>")) return "system";
    if (/summary/i.test(head)) return "summary";
    if (/memor/i.test(head)) return "memories";
  }
  return message.tool_calls ? "tool call" : message.role;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
