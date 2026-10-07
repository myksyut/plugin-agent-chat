import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { ChatView, Part, ToolCallView, Turn } from "../../shared/protocol";
import { ThinkingTrace } from "./ThinkingTrace";
import { ToolRun } from "./ToolRun";

type Block =
  | { readonly kind: "text"; readonly text: string; readonly last: boolean }
  | { readonly kind: "thinking"; readonly text: string; readonly last: boolean }
  | { readonly kind: "tools"; readonly calls: readonly ToolCallView[]; readonly last: boolean };

function toBlocks(parts: readonly Part[]): Block[] {
  const blocks: Block[] = [];
  for (const part of parts) {
    const prev = blocks.at(-1);
    if (part.type === "tool" && prev?.kind === "tools") {
      blocks[blocks.length - 1] = { kind: "tools", calls: [...prev.calls, part.call], last: false };
    } else if (part.type === "tool") {
      blocks.push({ kind: "tools", calls: [part.call], last: false });
    } else {
      blocks.push({ kind: part.type, text: part.text, last: false });
    }
  }
  const final = blocks.pop();
  if (final) blocks.push({ ...final, last: true });
  return blocks;
}

export function AssistantTurn({ turn }: { turn: Extract<Turn, { kind: "assistant" }> }) {
  const blocks = toBlocks(turn.parts);
  return (
    <section className="flex flex-col gap-2" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
      {blocks.map((block, i) => {
        const streaming = turn.live && block.last;
        switch (block.kind) {
          case "text":
            return (
              <Streamdown
                key={i}
                mode={turn.live ? "streaming" : "static"}
                isAnimating={streaming}
                className="prose-chat"
              >
                {block.text}
              </Streamdown>
            );
          case "thinking":
            return <ThinkingTrace key={i} text={block.text} working={streaming} />;
          case "tools":
            return <ToolRun key={i} calls={block.calls} />;
        }
      })}
      {turn.error && (
        <p className="w-fit max-w-prose rounded-control bg-red-tint px-2.5 py-1.5 text-[12.5px] text-red">
          {turn.error}
        </p>
      )}
    </section>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  switch (turn.kind) {
    case "user":
      return (
        <div className="flex justify-end pl-14" style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
          <div className="max-w-full rounded-xl bg-field px-3 py-1.5 text-[13px] leading-[1.4] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            {turn.text}
          </div>
        </div>
      );
    case "assistant":
      return <AssistantTurn turn={turn} />;
    case "notice":
      return <p className="text-center text-[12px] text-ink-3">{turn.text}</p>;
  }
}

const STICK_THRESHOLD_PX = 48;

export function Transcript({ view, empty }: { view: ChatView | null; empty?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  useEffect(() => {
    stuck.current = true;
  }, [view?.session]);

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
      }}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-6">
        {view === null ? (
          <p className="py-16 text-center text-[13px] text-ink-3">Loading conversation…</p>
        ) : view.turns.length === 0 ? (
          (empty ?? <p className="py-16 text-center text-[13px] text-ink-3">Ask anything. Add plugins to give the agent tools and skills.</p>)
        ) : (
          view.turns.map((turn) => <TurnView key={turn.id} turn={turn} />)
        )}
      </div>
    </div>
  );
}
