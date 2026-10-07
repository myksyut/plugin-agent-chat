import { Check, NavArrowDown, Wrench, Xmark } from "iconoir-react";
import { useState } from "react";
import type { ToolCallView, ToolStatus } from "../../shared/protocol";

const BUSY: readonly ToolStatus[] = ["preparing", "running"];

function StatusMark({ status }: { status: ToolStatus }) {
  if (BUSY.includes(status)) {
    return (
      <span
        className="size-3 shrink-0 rounded-full border-[1.5px] border-line-strong border-t-ink-2"
        style={{ animation: "spin 700ms linear infinite" }}
        role="img"
        aria-label={status}
      />
    );
  }
  const failed = status === "error";
  return (
    <span
      className={`flex size-3.5 shrink-0 items-center justify-center rounded-full text-white ${failed ? "bg-red" : "bg-green"}`}
      style={{ animation: "pop-in 300ms cubic-bezier(0.23,1,0.32,1) both" }}
      role="img"
      aria-label={status}
    >
      {failed ? <Xmark width={9} height={9} strokeWidth={3} /> : <Check width={9} height={9} strokeWidth={3} />}
    </span>
  );
}

function ToolRow({ call }: { call: ToolCallView }) {
  const [open, setOpen] = useState(false);
  const label = call.plugin ? `${call.plugin} · ${call.tool}` : call.tool;
  const lines = call.output.split("\n");

  return (
    <div style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
          <span
            className={`transition-opacity duration-100 group-hover/row:opacity-0 ${open ? "opacity-0" : ""}`}
          >
            <StatusMark status={call.status} />
          </span>
          <NavArrowDown
            width={12}
            height={12}
            strokeWidth={2.2}
            className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${open ? "opacity-100" : "opacity-0"}`}
            style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
          />
        </span>
        <span className="shrink-0 text-[12.5px] font-medium text-ink">{label}</span>
        <span
          className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-1.5
            font-mono text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 group-hover/row:bg-hover-2"
        >
          {call.args}
        </span>
      </button>

      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{
          gridTemplateRows: open ? "1fr" : "0fr",
          opacity: open ? 1 : 0,
          transitionTimingFunction: "cubic-bezier(0.23, 1, 0.32, 1)",
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
            <span className="font-mono text-[11.5px] leading-[1.6] break-all text-ink-3">{call.args}</span>
            {call.output === "" ? (
              <span className="text-[11.5px] leading-[1.6] text-ink-3">
                {BUSY.includes(call.status) ? "Waiting for output…" : "No output"}
              </span>
            ) : (
              lines.map((line, i) => (
                <span
                  key={i}
                  className={`font-mono text-[11.5px] leading-[1.6] break-words whitespace-pre-wrap ${call.status === "error" ? "text-red" : "text-ink-2"}`}
                >
                  {line}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ToolRun({ calls }: { calls: readonly ToolCallView[] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-full max-w-prose pb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <NavArrowDown
          width={12}
          height={12}
          strokeWidth={2.2}
          className="transition-transform duration-200"
          style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}
        />
        <Wrench width={12} height={12} />
        <span className="tabular-nums">
          {calls.length} tool {calls.length === 1 ? "call" : "calls"}
        </span>
      </button>
      <div
        className="grid transition-[grid-template-rows,opacity] duration-300"
        style={{ gridTemplateRows: open ? "1fr" : "0fr", opacity: open ? 1 : 0 }}
      >
        <div className="-mx-1 overflow-hidden px-1.5 pb-1">
          <div className="mt-1.5 flex flex-col gap-1">
            {calls.map((call) => (
              <ToolRow key={call.id} call={call} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
