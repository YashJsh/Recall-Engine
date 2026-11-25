"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Pause, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Sketch, type Shape } from "@/components/architecture/sketch";
import { cn } from "@/lib/utils";

export default function ArchitecturePage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 border-b border-neutral-200/80 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2 text-[13px] text-neutral-500 transition-colors hover:text-neutral-900">
            <ArrowLeft className="size-4" /> Back to Memory Lab
          </Link>
          <p className="text-[11px] tracking-[0.14em] text-neutral-400 uppercase">Recall Engine</p>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 pb-24">
        <div className="pt-16 pb-10">
          <p className="text-[11px] tracking-[0.14em] text-neutral-400 uppercase">Architecture</p>
          <h1 className="mt-3 font-serif text-5xl leading-[1.05] tracking-tight">
            How the agent <em>remembers</em>
          </h1>
          <p className="mt-5 max-w-2xl text-[17px] leading-relaxed text-neutral-600">
            Language models forget everything between messages. Recall Engine gives an AI agent memory the way people have it:
            a notepad for the task at hand, a diary of what was said, and long-term facts about you. This page follows one
            short story through the whole system.
          </p>
          <ol className="mt-8 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[12px] text-neutral-400">
            {SECTIONS.map(([id, title], index) => (
              <li key={id}><a href={`#${id}`} className="hover:text-neutral-900">{String(index + 1).padStart(2, "0")} {title}</a></li>
            ))}
          </ol>
        </div>

        <Chapter id="problem" n={1} title="The problem: models forget">
          <p>
            Every call to a language model starts from a blank page. If you told it your name a minute ago, it only “knows”
            because the app sent the whole conversation again. Send too much and you hit the model’s limit; send too little
            and it forgets you. Start a new chat and everything is gone.
          </p>
          <Figure caption="Without memory, each new chat starts from zero.">
            <Sketch width={760} height={230} label="Two chats: in the second, the model no longer knows the user's preference" shapes={PROBLEM} />
          </Figure>
          <UnderTheHood>
            Recall Engine is a TypeScript library the host application calls around its own model call. The app keeps
            ownership of the model; the library decides what to remember, what to recall, and how to fit it in the context window.
          </UnderTheHood>
        </Chapter>

        <Chapter id="types" n={2} title="Three kinds of memory">
          <p>
            Recall Engine splits memory the way psychologists do. Each kind lives in the store best suited to it, and each
            answers a different question.
          </p>
          <Figure caption="The agent's app talks to one library; the library keeps three kinds of memory.">
            <Sketch width={760} height={360} label="Host app above three memory stores: working, episodic, semantic" shapes={TYPES} />
          </Figure>
          <div className="grid gap-4 sm:grid-cols-3">
            <Kind title="Working memory" tag="notepad" store="Redis">
              Short notes for the task in progress, like “planning a Kyoto trip, budget $2k”. Cleared when you switch
              conversations or after 30 idle minutes.
            </Kind>
            <Kind title="Episodic memory" tag="diary" store="PostgreSQL">
              Every message, in order, plus rolling summaries of older parts so long chats still fit.
            </Kind>
            <Kind title="Semantic memory" tag="long-term facts" store="PostgreSQL + Qdrant">
              Durable facts like “prefers TypeScript”, with a link to the exact message they came from. Shared across all your conversations.
            </Kind>
          </div>
          <UnderTheHood>
            <ul className="list-disc space-y-1.5 pl-5">
              <li><b>Working memory</b>: Redis list per session, written by the agent through a <Code>save_temporary_note</Code> tool. Token budget 4,000 by default; lowest-priority notes are dropped first.</li>
              <li><b>Episodic memory</b>: PostgreSQL conversations, messages with sequence numbers, and versioned summaries. The transcript is never edited.</li>
              <li><b>Semantic memory</b>: PostgreSQL is the source of truth for each fact and its provenance. Qdrant holds a local FastEmbed vector of each fact for similarity search, keyed by the same ID.</li>
            </ul>
          </UnderTheHood>
        </Chapter>

        <Chapter id="turn" n={3} title="Life of one turn">
          <p>
            Here is what happens when you send a message. Step through it, or press play.
          </p>
          <TurnStepper />
          <UnderTheHood>
            <ul className="list-disc space-y-1.5 pl-5">
              <li><Code>prepareTurn</Code> saves the user message, runs a semantic search, and builds the prompt. The host app then calls its own model.</li>
              <li>Recall keeps at most 5 facts with similarity ≥ 0.5 (configurable). Search hits are re-checked in PostgreSQL so a stale vector can never inject a removed fact.</li>
              <li>Recalled facts are labelled as untrusted reference data, not instructions.</li>
              <li><Code>completeTurn</Code> saves the reply, then a Groq model proposes facts from up to eight recent messages. Each candidate is compared with similar existing facts and classified <i>same</i>, <i>new</i>, <i>update</i> or <i>uncertain</i>. Updates supersede the old fact, which is kept for history.</li>
              <li>If extraction fails, the reply is still saved and the failure is reported separately.</li>
            </ul>
          </UnderTheHood>
        </Chapter>

        <Chapter id="compaction" n={4} title="Fitting long chats in the window">
          <p>
            A model can only read so much at once. When a conversation grows past 80% of the budget, Recall Engine writes a
            summary of the oldest messages and sends that instead, until the prompt is back under 65%. The newest messages
            are always sent word for word.
          </p>
          <Figure caption="Older messages fold into a summary; recent ones stay verbatim.">
            <Sketch width={760} height={300} label="Context window before and after compaction, with 65% target and 80% trigger" shapes={COMPACTION} />
          </Figure>
          <UnderTheHood>
            The full prompt, including system prompt and recalled facts, is counted with the model’s tokenizer. Summaries are
            versioned and record which message they cover up to. At most two summary calls happen per turn. The default
            budget is 12,000 input tokens.
          </UnderTheHood>
        </Chapter>

        <Chapter id="scope" n={5} title="Whose memory is it?">
          <p>
            Every read and write is tied to a <em>memory scope</em>: which organisation, which person, and which session. One
            person’s facts can never surface in another person’s chat, even inside the same company.
          </p>
          <Figure caption="Each kind of memory lives at a different level.">
            <Sketch width={760} height={330} label="Nested scopes: tenant contains users, user contains sessions" shapes={SCOPE} />
          </Figure>
          <UnderTheHood>
            Scope is checked in every query: PostgreSQL rows carry tenant and user IDs, Qdrant searches filter on tenant,
            user and active status, and Redis keys include the session.
          </UnderTheHood>
        </Chapter>

        <footer className="mt-16 border-t border-neutral-200/80 pt-8 text-[13px] text-neutral-500">
          <Link href="/" className="inline-flex items-center gap-2 hover:text-neutral-900">
            <ArrowLeft className="size-4" /> Try it in Memory Lab: open the inspector to watch each turn.
          </Link>
        </footer>
      </main>
    </div>
  );
}

const SECTIONS = [
  ["problem", "The problem"],
  ["types", "Three kinds of memory"],
  ["turn", "Life of a turn"],
  ["compaction", "Compaction"],
  ["scope", "Memory scope"],
] as const;

function Chapter({ id, n, title, children }: { id: string; n: number; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-neutral-200/80 py-14">
      <p className="font-mono text-[11px] text-neutral-400">{String(n).padStart(2, "0")}</p>
      <h2 className="mt-2 font-serif text-3xl tracking-tight">{title}</h2>
      <div className="mt-4 space-y-6 text-[15px] leading-relaxed text-neutral-600 [&>p]:max-w-2xl">{children}</div>
    </section>
  );
}

function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="rounded-2xl border border-neutral-200/80 bg-neutral-50/50 p-4 sm:p-6">
      {children}
      <figcaption className="mt-2 text-center text-[12px] text-neutral-400">{caption}</figcaption>
    </figure>
  );
}

function Kind({ title, tag, store, children }: { title: string; tag: string; store: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-neutral-200/80 p-4">
      <p className="font-serif text-lg leading-tight text-neutral-900">{title}</p>
      <p className="mt-0.5 font-mono text-[11px] text-neutral-400">{tag} · {store}</p>
      <p className="mt-2 text-[13px] leading-relaxed">{children}</p>
    </div>
  );
}

function UnderTheHood({ children }: { children: ReactNode }) {
  return (
    <Collapsible className="group rounded-xl border border-dashed border-neutral-200">
      <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-[12px] text-neutral-500 hover:text-neutral-900">
        <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-mono">Under the hood</span>
        <span className="text-neutral-400">· for engineers</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4 text-[13px] leading-relaxed text-neutral-600">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800">{children}</code>;
}

/* ---------- Life of a turn ---------- */

type Store = "redis" | "postgres" | "qdrant";
const STEPS: Array<{ title: string; story: string; touches: Store[]; note: string }> = [
  {
    title: "You send a message",
    story: "“What language should I use for my Kyoto trip planner?”",
    touches: ["postgres"],
    note: "saved to the diary first",
  },
  {
    title: "Recall relevant facts",
    story: "The question is compared by meaning with every fact about you. “Prefers TypeScript” matches strongly (0.82). “Owns a cat” is unrelated (0.31) and is left out.",
    touches: ["qdrant", "postgres"],
    note: "0.82 ✓   0.31 ✗",
  },
  {
    title: "Build the prompt",
    story: "Instructions, the recalled fact, your task notes, and as much recent conversation as fits are packed into one prompt. Older messages are swapped for a summary if needed.",
    touches: ["postgres", "redis"],
    note: "fits the budget",
  },
  {
    title: "The model replies",
    story: "“Since you prefer TypeScript, use it with a small Next.js app…” The agent can also jot a task note, like “building Kyoto planner”.",
    touches: ["redis"],
    note: "note jotted",
  },
  {
    title: "Save the reply",
    story: "The answer is written to the diary in order, so the next turn sees it.",
    touches: ["postgres"],
    note: "diary updated",
  },
  {
    title: "Learn new facts",
    story: "A second model reads the recent messages and proposes durable facts: “is building a Kyoto trip planner”. It is checked against similar existing facts, then saved as new, merged as an update, or skipped as a duplicate.",
    touches: ["postgres", "qdrant"],
    note: "new fact saved",
  },
];

const STORE_X: Record<Store, number> = { redis: 150, postgres: 380, qdrant: 610 };
const STORE_LABEL: Record<Store, [string, string]> = {
  redis: ["notepad", "Redis"],
  postgres: ["diary + facts", "PostgreSQL"],
  qdrant: ["meaning index", "Qdrant"],
};

function turnShapes(active: number): Shape[] {
  const shapes: Shape[] = [];
  const stepW = 108;
  const gap = 14;
  const startX = (760 - (STEPS.length * stepW + (STEPS.length - 1) * gap)) / 2;
  STEPS.forEach((step, i) => {
    const x = startX + i * (stepW + gap);
    const state = i === active ? "fill" : i < active ? "ink" : "muted";
    shapes.push({ kind: "box", x, y: 24, w: stepW, h: 64, tone: state });
    shapes.push({ kind: "text", x: x + stepW / 2, y: 44, text: String(i + 1), size: 22, tone: state === "muted" ? "muted" : "accent" });
    shapes.push({ kind: "text", x: x + stepW / 2, y: 70, text: SHORT[i], size: 18, tone: state === "muted" ? "muted" : "accent" });
    if (i < STEPS.length - 1) {
      shapes.push({ kind: "arrow", from: [x + stepW + 2, 56], to: [x + stepW + gap - 1, 56], tone: i < active ? "ink" : "muted" });
    }
  });
  (Object.keys(STORE_X) as Store[]).forEach((store) => {
    const on = STEPS[active].touches.includes(store);
    const x = STORE_X[store];
    shapes.push({ kind: "box", x: x - 85, y: 196, w: 170, h: 72, tone: on ? "fill" : "muted", radius: 18 });
    shapes.push({ kind: "text", x, y: 222, text: STORE_LABEL[store][0], size: 22, tone: on ? "accent" : "muted" });
    shapes.push({ kind: "text", x, y: 250, text: STORE_LABEL[store][1], font: "mono", tone: on ? "ink" : "muted" });
  });
  const activeX = startX + active * (stepW + gap) + stepW / 2;
  STEPS[active].touches.forEach((store, i) => {
    shapes.push({ kind: "arrow", from: [activeX, 94], to: [STORE_X[store], 190], tone: "accent", bend: i % 2 === 0 ? 0.08 : -0.08 });
  });
  shapes.push({ kind: "text", x: 380, y: 296, text: `↑ ${STEPS[active].note}`, size: 22, tone: "ink" });
  return shapes;
}
const SHORT = ["message", "recall", "prompt", "reply", "save", "learn"];

function TurnStepper() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const shapes = useMemo(() => turnShapes(step), [step]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setStep((current) => {
        if (current >= STEPS.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 2600);
    return () => window.clearInterval(timer);
  }, [playing]);

  return (
    <div className="rounded-2xl border border-neutral-200/80 bg-neutral-50/50 p-4 sm:p-6">
      <Sketch width={760} height={315} label={`Step ${step + 1}: ${STEPS[step].title}`} shapes={shapes} />
      <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
        <div aria-live="polite">
          <p className="font-mono text-[11px] text-neutral-400">step {step + 1} of {STEPS.length}</p>
          <p className="mt-1 font-serif text-xl text-neutral-900">{STEPS[step].title}</p>
          <p className="mt-1 max-w-xl text-[14px] leading-relaxed text-neutral-600">{STEPS[step].story}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0}>Back</Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (!playing && step === STEPS.length - 1) setStep(0);
              setPlaying((p) => !p);
            }}
          >
            {playing ? <><Pause /> Pause</> : <><Play /> Play</>}
          </Button>
          <Button size="sm" onClick={() => { setPlaying(false); setStep((s) => Math.min(STEPS.length - 1, s + 1)); }} disabled={step === STEPS.length - 1}>Next</Button>
        </div>
      </div>
      <div className="mt-4 flex gap-1.5">
        {STEPS.map((s, i) => (
          <button
            key={s.title}
            type="button"
            aria-label={`Go to step ${i + 1}: ${s.title}`}
            onClick={() => { setPlaying(false); setStep(i); }}
            className={cn("h-1 flex-1 rounded-full transition-colors", i <= step ? "bg-neutral-800" : "bg-neutral-200")}
          />
        ))}
      </div>
    </div>
  );
}

/* ---------- Static diagrams ---------- */

const PROBLEM: Shape[] = [
  { kind: "text", x: 190, y: 22, text: "Chat 1", size: 24 },
  { kind: "box", x: 40, y: 44, w: 300, h: 52, radius: 20 },
  { kind: "text", x: 190, y: 70, text: "“I prefer TypeScript.”", size: 22 },
  { kind: "box", x: 70, y: 120, w: 270, h: 52, radius: 20, tone: "muted" },
  { kind: "text", x: 205, y: 146, text: "“Got it!”", size: 22, tone: "ink" },
  { kind: "line", from: [380, 20], to: [380, 210], dashed: true, tone: "muted" },
  { kind: "text", x: 380, y: 222, text: "new chat", size: 18, tone: "muted" },
  { kind: "text", x: 570, y: 22, text: "Chat 2", size: 24 },
  { kind: "box", x: 420, y: 44, w: 300, h: 52, radius: 20 },
  { kind: "text", x: 570, y: 70, text: "“What language should I use?”", size: 21 },
  { kind: "box", x: 450, y: 120, w: 270, h: 52, radius: 20, tone: "fill" },
  { kind: "text", x: 585, y: 146, text: "“Hmm… any language?”", size: 22, tone: "accent" },
  { kind: "text", x: 585, y: 196, text: "it forgot you ↑", size: 20, tone: "ink" },
];

const TYPES: Shape[] = [
  { kind: "box", x: 260, y: 16, w: 240, h: 60, radius: 14, tone: "accent" },
  { kind: "text", x: 380, y: 40, text: "your agent's app", size: 24, tone: "accent" },
  { kind: "text", x: 380, y: 62, text: "owns the model", font: "mono", tone: "ink" },
  { kind: "arrow", from: [380, 80], to: [380, 120], tone: "ink" },
  { kind: "box", x: 200, y: 124, w: 360, h: 44, radius: 14, tone: "ink" },
  { kind: "text", x: 380, y: 147, text: "Recall Engine", size: 24, tone: "accent" },
  { kind: "arrow", from: [300, 172], to: [140, 222], tone: "ink", bend: 0.1 },
  { kind: "arrow", from: [380, 172], to: [380, 222], tone: "ink" },
  { kind: "arrow", from: [460, 172], to: [620, 222], tone: "ink", bend: -0.1 },
  { kind: "box", x: 40, y: 228, w: 200, h: 110, radius: 16, tone: "fill" },
  { kind: "text", x: 140, y: 256, text: "Working", size: 26, tone: "accent" },
  { kind: "text", x: 140, y: 284, text: "notepad · right now", size: 19 },
  { kind: "text", x: 140, y: 314, text: "Redis", font: "mono" },
  { kind: "box", x: 280, y: 228, w: 200, h: 110, radius: 16, tone: "fill" },
  { kind: "text", x: 380, y: 256, text: "Episodic", size: 26, tone: "accent" },
  { kind: "text", x: 380, y: 284, text: "diary · what was said", size: 19 },
  { kind: "text", x: 380, y: 314, text: "PostgreSQL", font: "mono" },
  { kind: "box", x: 520, y: 228, w: 200, h: 110, radius: 16, tone: "fill" },
  { kind: "text", x: 620, y: 256, text: "Semantic", size: 26, tone: "accent" },
  { kind: "text", x: 620, y: 284, text: "facts · forever", size: 19 },
  { kind: "text", x: 620, y: 314, text: "Postgres + Qdrant", font: "mono" },
];

const COMPACTION: Shape[] = (() => {
  const shapes: Shape[] = [];
  const x0 = 60;
  const width = 640;
  const bar = (y: number, label: string) => {
    shapes.push({ kind: "text", x: x0 - 8, y: y + 22, text: label, size: 20, anchor: "end" });
    shapes.push({ kind: "box", x: x0, y, w: width, h: 44, radius: 8, tone: "muted" });
  };
  bar(46, "before");
  for (let i = 0; i < 13; i++) {
    shapes.push({ kind: "box", x: x0 + 8 + i * 42, y: 54, w: 34, h: 28, radius: 5, tone: i < 9 ? "ink" : "accent" });
  }
  shapes.push({ kind: "text", x: x0 + 8 + 13 * 42 + 20, y: 68, text: "86%", size: 20, tone: "accent", anchor: "start" });
  bar(176, "after");
  shapes.push({ kind: "box", x: x0 + 8, y: 184, w: 150, h: 28, radius: 5, tone: "fill" });
  shapes.push({ kind: "text", x: x0 + 83, y: 198, text: "summary", size: 19, tone: "accent" });
  for (let i = 0; i < 4; i++) {
    shapes.push({ kind: "box", x: x0 + 170 + i * 42, y: 184, w: 34, h: 28, radius: 5, tone: "accent" });
  }
  shapes.push({ kind: "text", x: x0 + 170 + 4 * 42 + 20, y: 198, text: "≈ 55%", size: 20, tone: "accent", anchor: "start" });
  for (const [pct, label] of [[0.65, "target 65%"], [0.8, "compact at 80%"]] as const) {
    const x = x0 + width * pct;
    shapes.push({ kind: "line", from: [x, 34], to: [x, 236], dashed: true, tone: "ink" });
    shapes.push({ kind: "text", x, y: 22, text: label, font: "mono", tone: "ink" });
  }
  shapes.push({ kind: "arrow", from: [x0 + 100, 96], to: [x0 + 60, 176], tone: "accent", bend: 0.15 });
  shapes.push({ kind: "text", x: x0 + 120, y: 136, text: "oldest messages → one summary", size: 21, anchor: "start" });
  shapes.push({ kind: "text", x: x0 + 420, y: 262, text: "newest messages stay word for word", size: 20, tone: "ink" });
  return shapes;
})();

const SCOPE: Shape[] = [
  { kind: "box", x: 20, y: 14, w: 720, h: 300, radius: 20, tone: "ink" },
  { kind: "text", x: 44, y: 40, text: "Tenant: a company using the app", size: 22, anchor: "start" },
  { kind: "box", x: 44, y: 62, w: 430, h: 236, radius: 18, tone: "accent" },
  { kind: "text", x: 66, y: 88, text: "User: you", size: 22, anchor: "start", tone: "accent" },
  { kind: "box", x: 260, y: 74, w: 196, h: 40, radius: 12, tone: "fill" },
  { kind: "text", x: 358, y: 94, text: "semantic facts", size: 20, tone: "accent" },
  { kind: "box", x: 66, y: 130, w: 180, h: 150, radius: 14, tone: "ink" },
  { kind: "text", x: 156, y: 154, text: "Session A", size: 21 },
  { kind: "text", x: 156, y: 194, text: "notepad", size: 19 },
  { kind: "text", x: 156, y: 222, text: "conversations", size: 19 },
  { kind: "box", x: 270, y: 130, w: 180, h: 150, radius: 14, tone: "ink" },
  { kind: "text", x: 360, y: 154, text: "Session B", size: 21 },
  { kind: "text", x: 360, y: 194, text: "notepad", size: 19 },
  { kind: "text", x: 360, y: 222, text: "conversations", size: 19 },
  { kind: "box", x: 500, y: 62, w: 220, h: 236, radius: 18, tone: "muted" },
  { kind: "text", x: 610, y: 88, text: "User: a colleague", size: 21, tone: "ink" },
  { kind: "text", x: 610, y: 170, text: "can't see", size: 22, tone: "ink" },
  { kind: "text", x: 610, y: 196, text: "your facts ✗", size: 22, tone: "ink" },
  { kind: "arrow", from: [462, 94], to: [560, 156], tone: "muted", dashed: true, bend: -0.1 },
];
