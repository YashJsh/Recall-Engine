"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUp, ChevronRight, MessageSquare, PanelRightClose, PanelRightOpen, Plus, ScanSearch } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
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
type ConversationListItem = { id: string; title: string; messageCount: number; lastActivityAt: string | null };

type DemoState = {
  conversationId: string;
  conversations: ConversationListItem[];
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
  conversationId: string;
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
  const [switching, setSwitching] = useState(false);
  const [resumeUserMessageId, setResumeUserMessageId] = useState<string | undefined>();
  const [traces, setTraces] = useState<TurnTrace[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("turn");
  const [inspectorOpen, setInspectorOpen] = useState(true);
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
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [state?.conversationId, state?.messages.length, pending]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const userMessage = draft.trim();
    if (!userMessage || pending || !state) return;
    const conversationId = state.conversationId;
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
        conversationId,
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

  async function changeConversation(conversationId?: string) {
    if (pending || switching || (conversationId && conversationId === state?.conversationId)) return;
    setSwitching(true);
    try {
      const response = await fetch("/api/conversation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(conversationId ? { conversationId } : {}),
      });
      const body = await response.json();
      if (!response.ok) {
        setTurnError(body.error ?? "Unable to change conversation");
        return;
      }
      setSelected(null);
      setTurnError(null);
      setResumeUserMessageId(undefined);
      setDraft("");
    } catch {
      setTurnError("Could not reach the local demo server.");
    } finally {
      setSwitching(false);
      await refresh();
    }
  }

  const messages = state?.messages.filter((m) => m.role === "user" || m.role === "assistant") ?? [];
  const traceByAssistantId = new Map(
    traces.flatMap((trace, index) => (trace.assistantMessageId ? [[trace.assistantMessageId, index] as const] : [])),
  );
  const trace = selected === null ? null : traces[selected] ?? null;
  const pendingAlreadySaved = !!pending && messages.some((m) => m.id === resumeUserMessageId);
  const activeConversation = state?.conversations.find((c) => c.id === state.conversationId);
  const busy = !!pending || switching || !state;

  return (
    <div className="flex h-screen overflow-hidden bg-white">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-neutral-200/80 bg-neutral-50/70 md:flex">
        <div className="px-5 pt-6 pb-5">
          <p className="font-serif text-[26px] leading-none tracking-tight">Memory <em>Lab</em></p>
          <p className="mt-1.5 text-[11px] tracking-[0.14em] text-neutral-400 uppercase">Recall Engine</p>
        </div>
        <div className="px-3">
          <Button variant="outline" className="h-9 w-full justify-start gap-2 bg-white font-normal shadow-xs" onClick={() => changeConversation()} disabled={busy}>
            <Plus className="text-neutral-500" /> New conversation
          </Button>
        </div>
        <p className="mt-6 mb-1.5 px-5 text-[11px] font-medium tracking-[0.12em] text-neutral-400 uppercase">Conversations</p>
        <ScrollArea className="min-h-0 flex-1">
          <nav className="space-y-0.5 px-3 pb-4">
            {state?.conversations.map((conversation) => {
              const active = conversation.id === state.conversationId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  disabled={busy && !active}
                  onClick={() => changeConversation(conversation.id)}
                  className={cn(
                    "group w-full rounded-lg px-3 py-2 text-left transition-colors disabled:opacity-60",
                    active ? "bg-white shadow-xs ring-1 ring-neutral-200" : "hover:bg-neutral-100",
                  )}
                >
                  <span className={cn("block truncate text-[13px]", active ? "text-neutral-900" : "text-neutral-600")}>
                    {conversation.messageCount ? conversation.title : "Untitled conversation"}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-neutral-400">
                    {conversation.messageCount} messages{conversation.lastActivityAt ? ` · ${timeAgo(conversation.lastActivityAt)}` : ""}
                  </span>
                </button>
              );
            })}
          </nav>
        </ScrollArea>
        <div className="border-t border-neutral-200/80 px-5 py-4 text-[11px] text-neutral-500">
          <div className="flex justify-between"><span>Durable facts</span><span className="font-mono text-neutral-800">{state?.knownFacts.length ?? 0}</span></div>
          <div className="mt-1 flex justify-between"><span>Task notes</span><span className="font-mono text-neutral-800">{state?.workingMemoryItems.length ?? 0}</span></div>
          <p className="mt-3 text-neutral-400">Facts carry across conversations. Notes are cleared when you switch.</p>
        </div>
      </aside>

      {/* Conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-neutral-200/80 px-6">
          <div className="min-w-0">
            <h1 className="truncate font-serif text-xl leading-tight">
              {activeConversation?.messageCount ? activeConversation.title : "New conversation"}
            </h1>
            <p className="font-mono text-[11px] text-neutral-400">{state ? state.conversationId.slice(0, 8) : "connecting…"}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="md:hidden" onClick={() => changeConversation()} disabled={busy}><Plus /> New</Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="text-neutral-500" onClick={() => setInspectorOpen((open) => !open)} aria-label="Toggle inspector">
                  {inspectorOpen ? <PanelRightClose /> : <PanelRightOpen />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{inspectorOpen ? "Hide inspector" : "Show inspector"}</TooltipContent>
            </Tooltip>
          </div>
        </header>

        {loadError && (
          <p role="alert" className="border-b border-red-100 bg-red-50/60 px-6 py-2 text-sm text-red-700">
            {loadError} — check .env and that PostgreSQL, Redis and Qdrant are running.
          </p>
        )}

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-8" aria-live="polite">
            {messages.length === 0 && !pending ? (
              <div className="mt-[12vh] text-center">
                <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-full border border-neutral-200 text-neutral-400">
                  <MessageSquare className="size-5" strokeWidth={1.5} />
                </div>
                <h2 className="font-serif text-3xl tracking-tight">What should it remember?</h2>
                <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-neutral-500">
                  Share something lasting, start a new conversation, then ask about it. Every reply can be inspected.
                </p>
                <div className="mt-7 flex flex-col items-center gap-2">
                  {EXAMPLES.map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setDraft(example)}
                      className="rounded-full border border-neutral-200 px-4 py-1.5 text-[13px] text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50 hover:text-neutral-900"
                    >
                      {example}
                    </button>
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
                      role={message.role}
                      content={message.content}
                      selected={traceIndex !== undefined && selected === traceIndex && inspectorOpen}
                      onInspect={traceIndex === undefined ? undefined : () => { setSelected(traceIndex); setTab("turn"); setInspectorOpen(true); }}
                    />
                  );
                })}
                {pending && !pendingAlreadySaved && <ChatMessage role="user" content={pending} />}
                {pending && (
                  <div className="flex gap-1 py-2" aria-label="Agent is thinking">
                    {[0, 1, 2].map((i) => <span key={i} className="lab-dot size-1.5 rounded-full bg-neutral-400" />)}
                  </div>
                )}
              </>
            )}
            <div ref={bottom} />
          </div>
        </ScrollArea>

        <form onSubmit={send} className="shrink-0 px-6 pt-2 pb-5">
          <div className="mx-auto max-w-2xl">
            <div className="flex items-end gap-2 rounded-2xl border border-neutral-200 bg-white p-2 pl-4 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_-4px_rgba(0,0,0,0.06)] transition-colors focus-within:border-neutral-300">
              <label className="sr-only" htmlFor="message">Message</label>
              <Textarea
                id="message"
                rows={1}
                placeholder="Message the agent…"
                className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-0 py-2 shadow-none focus-visible:ring-0"
                value={draft}
                maxLength={8_000}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <Button type="submit" size="icon" className="size-9 shrink-0 rounded-xl" disabled={busy || !draft.trim()} aria-label="Send">
                <ArrowUp />
              </Button>
            </div>
            <p role={turnError ? "alert" : undefined} className={cn("mt-2 text-center text-[11px]", turnError ? "text-red-600" : "text-neutral-400")}>
              {turnError
                ? `${turnError}${resumeUserMessageId ? " Your message is saved — send again to retry." : ""}`
                : "Enter to send · Shift + Enter for a new line"}
            </p>
          </div>
        </form>
      </main>

      {/* Inspector */}
      {inspectorOpen && (
        <aside aria-label="Memory inspector" className="hidden w-[420px] shrink-0 flex-col border-l border-neutral-200/80 bg-white lg:flex">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="flex h-16 shrink-0 items-end justify-between border-b border-neutral-200/80 px-6">
              <TabsList variant="line" className="h-auto gap-4 p-0 pb-[5px]">
                <TabsTrigger value="turn" className="px-0">Turn{trace && <Count>#{(selected ?? 0) + 1}</Count>}</TabsTrigger>
                <TabsTrigger value="memory" className="px-0">Memory</TabsTrigger>
                <TabsTrigger value="prompt" className="px-0">Prompt{trace && <Count>{trace.promptCalls.length}</Count>}</TabsTrigger>
              </TabsList>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="px-6 pb-10">
                <TabsContent value="turn"><TurnPanel trace={trace} /></TabsContent>
                <TabsContent value="memory"><MemoryPanel state={state} /></TabsContent>
                <TabsContent value="prompt"><PromptPanel trace={trace} /></TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        </aside>
      )}
    </div>
  );
}

function ChatMessage({ role, content, selected, onInspect }: {
  role: Role; content: string; selected?: boolean; onInspect?: () => void;
}) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-100 px-4 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-neutral-900">
          {content}
        </p>
      </div>
    );
  }
  return (
    <div className={cn("group -mx-3 rounded-xl px-3 py-2 transition-colors", selected && "bg-neutral-50 ring-1 ring-neutral-200")}>
      <Markdown className="text-[15px] leading-7">{content}</Markdown>
      {onInspect && (
        <button
          type="button"
          onClick={onInspect}
          className={cn(
            "mt-1.5 inline-flex items-center gap-1 text-[11px] text-neutral-400 transition-colors hover:text-neutral-900",
            selected && "text-neutral-700",
          )}
        >
          <ScanSearch className="size-3" /> {selected ? "Inspecting" : "Inspect memory"}
        </button>
      )}
    </div>
  );
}

function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        "prose prose-neutral max-w-none break-words text-neutral-800",
        "prose-p:my-2 prose-headings:font-serif prose-headings:font-normal prose-headings:tracking-tight",
        "prose-h1:text-2xl prose-h2:text-xl prose-h3:text-lg prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5",
        "prose-a:text-neutral-900 prose-a:underline-offset-2 prose-strong:font-semibold",
        "prose-code:rounded prose-code:bg-neutral-100 prose-code:px-1 prose-code:py-0.5 prose-code:font-mono prose-code:text-[0.85em] prose-code:font-normal prose-code:before:content-none prose-code:after:content-none",
        "prose-pre:rounded-xl prose-pre:border prose-pre:border-neutral-200 prose-pre:bg-neutral-50 prose-pre:text-neutral-800 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "prose-table:text-sm prose-th:font-medium prose-blockquote:font-normal prose-blockquote:text-neutral-600",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <span className="ml-1 font-mono text-[11px] font-normal text-neutral-400">{children}</span>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="py-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-serif text-[17px] leading-none text-neutral-900">{title}</h3>
        {aside !== undefined && <span className="font-mono text-[11px] text-neutral-400">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[13px] text-neutral-400">{children}</p>;
}

function Row({ main, side, sub, dim }: { main: ReactNode; side?: ReactNode; sub?: ReactNode; dim?: boolean }) {
  return (
    <li className="border-t border-neutral-100 py-2.5 first:border-t-0 first:pt-0">
      <div className="flex justify-between gap-3">
        <span className={cn("text-[13px] leading-relaxed break-words", dim ? "text-neutral-400" : "text-neutral-800")}>{main}</span>
        {side && <span className="shrink-0">{side}</span>}
      </div>
      {sub && <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">{sub}</div>}
    </li>
  );
}

function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "solid" | "warn" | "bad" }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 rounded-md px-1.5 font-mono text-[10px] font-normal",
        tone === "neutral" && "border-neutral-200 text-neutral-500",
        tone === "solid" && "border-neutral-900 bg-neutral-900 text-white",
        tone === "warn" && "border-amber-200 bg-amber-50 text-amber-700",
        tone === "bad" && "border-red-200 bg-red-50 text-red-700",
      )}
    >
      {children}
    </Badge>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="px-3 py-3">
      <dt className="text-[11px] text-neutral-400">{label}</dt>
      <dd className="mt-1 font-mono text-[15px] text-neutral-900">{value}</dd>
    </div>
  );
}

function Source({ content }: { content?: string }) {
  if (!content) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="min-w-0 cursor-help truncate italic">from “{truncate(content, 60)}”</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap">{content}</TooltipContent>
    </Tooltip>
  );
}

function TurnPanel({ trace }: { trace: TurnTrace | null }) {
  if (!trace) return <Placeholder title="No turn selected">Send a message, or choose “Inspect memory” under a reply, to see what memory did on that turn.</Placeholder>;
  const c = trace.compaction;
  const percent = c ? Math.min(100, (c.tokenCount / c.inputTokenBudget) * 100) : 0;
  const outcome = trace.semanticMemory;

  return (
    <div className="divide-y divide-neutral-100">
      <section className="py-5">
        <p className="text-[11px] tracking-[0.12em] text-neutral-400 uppercase">You asked</p>
        <p className="mt-1.5 font-serif text-lg leading-snug text-neutral-900">“{trace.userMessage}”</p>
        {!trace.ok && <p className="mt-2 flex items-center gap-1.5 text-xs text-red-700"><Tag tone="bad">failed</Tag>{trace.error}</p>}
      </section>

      {c && (
        <Section title="Context window" aside={c.compactionPerformed ? `compacted · summary v${c.summaryVersion ?? "?"}` : "no compaction"}>
          <dl className="grid grid-cols-4 divide-x divide-neutral-100 rounded-xl border border-neutral-200/80">
            <Stat label="Tokens" value={c.tokenCount.toLocaleString()} />
            <Stat label="Budget" value={c.inputTokenBudget.toLocaleString()} />
            <Stat label="Used" value={`${percent.toFixed(0)}%`} />
            <Stat label="Calls" value={trace.promptCalls.length} />
          </dl>
          <div className="relative mt-4">
            <Progress value={percent} className="h-1 bg-neutral-100 [&>*]:bg-neutral-800" aria-label={`${percent.toFixed(0)}% of context budget`} />
            <span className="absolute -top-1 h-3 w-px bg-neutral-300" style={{ left: "65%" }} />
            <span className="absolute -top-1 h-3 w-px bg-neutral-400" style={{ left: "80%" }} />
          </div>
          <div className="mt-1.5 flex justify-end gap-3 font-mono text-[10px] text-neutral-400"><span>target 65%</span><span>compact 80%</span></div>
          {c.compactionPerformed && (
            <p className="mt-2 text-xs text-neutral-500">
              Summarized {c.summaryBatches} batch(es) through message #{c.summaryThroughSequenceNo}{c.targetReached ? "." : " — target not reached."}
            </p>
          )}
        </Section>
      )}

      <Section title="Recalled facts" aside={trace.retrievedMemories.length}>
        {trace.retrievedMemories.length === 0 ? <Empty>No durable facts matched this message.</Empty> : (
          <ul>
            {trace.retrievedMemories.map((memory) => (
              <Row
                key={memory.semanticMemoryId}
                main={memory.content}
                side={<ScoreBar score={memory.score} />}
                sub={<><Tag>{memory.category.replace("_", " ")}</Tag><Source content={memory.sourceMessage?.content} /></>}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Task-note tools" aside={`${trace.toolTrace.length} / 3`}>
        {trace.toolTrace.length === 0 ? <Empty>The agent did not save or clear any notes.</Empty> : (
          <ul>
            {trace.toolTrace.map((tool, index) => (
              <Row
                key={index}
                main={<span className="font-mono text-xs">{tool.name}</span>}
                side={<Tag tone={tool.status === "rejected" ? "warn" : "solid"}>{tool.status}</Tag>}
                sub={tool.detail}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Fact extraction"
        aside={outcome?.status === "success"
          ? `${outcome.result.saved.length} saved · ${outcome.result.skipped.length} skipped`
          : outcome?.status}
      >
        {!outcome ? <Empty>Extraction did not run because the turn did not complete.</Empty>
          : outcome.status === "failed" ? <p className="flex items-center gap-1.5 text-xs text-red-700"><Tag tone="bad">failed</Tag>{outcome.error}</p>
          : outcome.result.extracted.length === 0 ? <Empty>Nothing worth remembering in this turn.</Empty>
          : (
            <ul>
              {outcome.result.saved.map((fact) => (
                <Row
                  key={fact.id}
                  main={fact.content}
                  side={<Tag tone="solid">saved</Tag>}
                  sub={<><Tag>{fact.category.replace("_", " ")}</Tag>{outcome.result.supersededMemoryIds.length > 0 && "replaces an earlier fact"}</>}
                />
              ))}
              {outcome.result.skipped.map((skip, index) => (
                <Row
                  key={`skip-${index}`}
                  dim
                  main={skip.candidate.content}
                  side={<Tag>skipped</Tag>}
                  sub={<><Tag>{skip.candidate.category.replace("_", " ")}</Tag>{skip.reason.replaceAll("_", " ")}</>}
                />
              ))}
            </ul>
          )}
      </Section>
    </div>
  );
}

function ScoreBar({ score }: { score: number }) {
  const width = Math.max(0, Math.min(1, score)) * 100;
  return (
    <span className="flex items-center gap-2" title={`similarity ${score.toFixed(3)}`}>
      <span className="h-1 w-10 overflow-hidden rounded-full bg-neutral-100"><span className="block h-full bg-neutral-700" style={{ width: `${width}%` }} /></span>
      <span className="font-mono text-[11px] text-neutral-500">{score.toFixed(2)}</span>
    </span>
  );
}

function MemoryPanel({ state }: { state: DemoState | null }) {
  if (!state) return <Placeholder title="Loading">Reading memory stores…</Placeholder>;
  const sources = new Map(state.sourceMessages.map((m) => [m.id, m.content]));
  const wmPercent = state.workingMemoryTokenBudget
    ? Math.min(100, (state.workingMemoryTokenUsage / state.workingMemoryTokenBudget) * 100)
    : 0;

  return (
    <div className="divide-y divide-neutral-100">
      <Section title="Working memory" aside="redis">
        <div className="mb-3 flex items-center gap-3">
          <Progress value={wmPercent} className="h-1 flex-1 bg-neutral-100 [&>*]:bg-neutral-800" />
          <span className="font-mono text-[11px] text-neutral-400">{state.workingMemoryTokenUsage} / {state.workingMemoryTokenBudget} tok</span>
        </div>
        {state.workingMemoryItems.length === 0 ? <Empty>No task notes for this conversation.</Empty> : (
          <ul>
            {state.workingMemoryItems.map((note) => (
              <Row key={note.id} main={note.content} side={<span className="font-mono text-[11px] text-neutral-400">{note.tokenCount} tok</span>} />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Episodic memory" aside={`postgres · ${state.messages.length} msgs`}>
        {state.latestSummary ? (
          <>
            <p className="mb-2 text-xs text-neutral-500">
              Messages 1–{state.latestSummary.throughSequenceNo} are summarized (v{state.latestSummary.version}); later ones are sent verbatim.
            </p>
            <div className="rounded-xl border border-neutral-200/80 bg-neutral-50/60 px-4 py-3">
              <Markdown className="prose-sm text-[13px]">{state.latestSummary.summaryText}</Markdown>
            </div>
          </>
        ) : <Empty>No summary yet — the full transcript still fits in the context budget.</Empty>}
      </Section>

      <Section title="Semantic memory" aside={`postgres + qdrant · ${state.knownFacts.length}`}>
        {state.knownFacts.length === 0 ? <Empty>No durable facts yet. Facts persist across conversations.</Empty> : (
          <ul>
            {state.knownFacts.map((fact) => (
              <Row
                key={fact.id}
                dim={fact.status === "superseded"}
                main={fact.content}
                side={fact.status === "superseded" ? <Tag>superseded</Tag> : undefined}
                sub={<><Tag>{fact.category.replace("_", " ")}</Tag><Source content={sources.get(fact.sourceMessageId)} /></>}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function PromptPanel({ trace }: { trace: TurnTrace | null }) {
  if (!trace) return <Placeholder title="No turn selected">Select a reply to see the exact messages sent to the model.</Placeholder>;
  if (trace.promptCalls.length === 0) return <Placeholder title="No model calls">Nothing was sent to the model on this turn.</Placeholder>;
  return (
    <div className="space-y-4 pt-5">
      {trace.promptCalls.map((call, index) => (
        <div key={index} className="overflow-hidden rounded-xl border border-neutral-200/80">
          <div className="flex items-baseline justify-between px-4 py-2.5">
            <span className="font-serif text-[15px]">Call {index + 1}</span>
            <span className="font-mono text-[11px] text-neutral-400">
              {call.messages.length} msgs · {call.messages.reduce((n, m) => n + text(m).length, 0).toLocaleString()} chars
            </span>
          </div>
          {call.messages.map((message, i) => (
            <Collapsible key={i} className="group border-t border-neutral-100">
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-xs transition-colors hover:bg-neutral-50">
                <ChevronRight className="size-3 shrink-0 text-neutral-400 transition-transform group-data-[state=open]:rotate-90" />
                <span className="w-16 shrink-0 font-mono text-[11px] text-neutral-500">{label(message)}</span>
                <span className="min-w-0 flex-1 truncate text-neutral-700">{text(message).replace(/\s+/g, " ")}</span>
                <span className="font-mono text-[10px] text-neutral-400">{text(message).length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="max-h-80 overflow-auto border-t border-dashed border-neutral-200 bg-neutral-50/60 px-4 py-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-neutral-700">
                  {text(message)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ))}
    </div>
  );
}

function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="py-16 text-center">
      <p className="font-serif text-lg text-neutral-800">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[260px] text-[13px] leading-relaxed text-neutral-400">{children}</p>
    </div>
  );
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

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
