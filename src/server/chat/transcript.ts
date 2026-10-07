// The only code that knows pi's entry and event semantics. Deterministic, no I/O.
// Mutable inside; observable only through frame().
import type { AssistantMessage, JsonObject, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";
import type { ChatFrame, Part, RunStatus, SessionId, ToolCallView, ToolStatus, Turn } from "../../shared/protocol";

export type ToolLabeler = (modelName: string) => { readonly plugin: string | null; readonly tool: string };

type Block = AssistantMessage["content"][number];
type CallState = { readonly status: ToolStatus; readonly output: string };

const MAX_ARGS = 2048;
const MAX_OUTPUT = 4096;

export class Transcript {
  #turns: Turn[] = [];
  #run: RunStatus = { phase: "idle" };
  #since = 0;
  #queued = 0;
  /** Entry ids already folded: at-most-once folding makes overlapping delivery idempotent. */
  #seen = new Set<number>();
  /** toolCallId → [turnIndex, partIndex] */
  #toolIndex = new Map<string, readonly [number, number]>();
  #calls = new Map<string, CallState>();
  #live: { readonly index: number; blocks: Block[] } | null = null;
  /** Lowest turn index changed by the batch being applied. */
  #dirty: number | null = null;

  private constructor(
    readonly session: SessionId,
    private readonly label: ToolLabeler,
  ) {}

  static fromSnapshot(session: SessionId, snapshot: SnapshotEvent, label: ToolLabeler): Transcript {
    const transcript = new Transcript(session, label);
    transcript.#load(snapshot);
    return transcript;
  }

  /** Fold one commit batch. Returns the lowest turn index changed, or null when nothing visible changed. */
  apply(events: readonly AgentEvent[]): number | null {
    this.#dirty = null;
    let statusChanged = false;
    for (const event of events) {
      switch (event.type) {
        case "snapshot":
          this.#load(event);
          this.#touch(0);
          break;
        case "message_start":
          if (event.message.role === "assistant") this.#startLive(event.message);
          break;
        case "message_update":
          this.#updateLive(event.changes);
          break;
        case "message_end":
        case "entry_appended":
          this.#fold(event.entry);
          break;
        case "tool_execution_start":
          this.#setCall(event.toolCallId, { status: "running", output: "" });
          break;
        case "tool_execution_update": {
          const output = event.output;
          if (output === undefined) break;
          const previous = this.#calls.get(event.toolCallId)?.output ?? "";
          const next = "set" in output ? output.set : previous.slice(output.trimStart ?? 0) + (output.append ?? "");
          this.#setCall(event.toolCallId, { status: "running", output: next });
          break;
        }
        case "tool_execution_end":
          if (event.entry === undefined) this.#failCall(event.toolCallId);
          break;
        case "run_start":
          this.#since = Date.now();
          this.#run = { phase: "running", since: this.#since };
          statusChanged = true;
          break;
        case "run_end":
          this.#run = { phase: "idle" };
          this.#dropLive();
          for (const callId of this.#toolIndex.keys()) this.#failCall(callId);
          statusChanged = true;
          break;
        case "auto_retry_start":
          this.#run = { phase: "retrying", at: event.at, error: event.errorMessage };
          this.#dropLive();
          statusChanged = true;
          break;
        case "auto_retry_end":
          this.#run = { phase: "running", since: this.#since };
          statusChanged = true;
          break;
        case "inbox_update":
          this.#queued = event.items.length;
          statusChanged = true;
          break;
        default:
          break;
      }
    }
    return this.#dirty ?? (statusChanged ? this.#turns.length : null);
  }

  frame(from: number): ChatFrame {
    return {
      t: "chat.tail",
      session: this.session,
      from,
      turns: this.#turns.slice(from),
      run: this.#run,
      queued: this.#queued,
    };
  }

  #load(snapshot: SnapshotEvent): void {
    this.#turns = [];
    this.#seen.clear();
    this.#toolIndex.clear();
    this.#calls.clear();
    this.#live = null;
    for (const slot of snapshot.tools) {
      if (slot.status === "running") this.#calls.set(slot.callId, { status: "running", output: slot.output ?? "" });
    }
    for (const entry of snapshot.entries) this.#fold(entry);
    const live = snapshot.generation?.message;
    if (live !== undefined) this.#startLive(live);
    for (const slot of snapshot.tools) {
      if (slot.status === "done" && slot.entry === undefined) this.#failCall(slot.callId);
    }
    if (snapshot.run === undefined) {
      for (const callId of this.#toolIndex.keys()) this.#failCall(callId);
    }
    this.#since = Date.now();
    const retry = snapshot.generation?.retry;
    this.#run =
      snapshot.run === undefined
        ? { phase: "idle" }
        : retry !== undefined
          ? { phase: "retrying", at: retry.at, error: retry.error }
          : { phase: "running", since: this.#since };
    this.#queued = snapshot.inbox.length;
  }

  #fold(entry: EntryRecord): void {
    if (this.#seen.has(entry.id)) return;
    this.#seen.add(entry.id);
    const message = entry.model?.[0];
    switch (entry.kind) {
      case "pi.user":
        if (message?.role === "user") {
          this.#push({ kind: "user", id: String(entry.id), text: userText(message) });
        }
        break;
      case "pi.assistant":
        if (message?.role === "assistant") this.#commitAssistant(String(entry.id), message);
        break;
      case "pi.tool-result":
        if (message?.role === "toolResult") {
          this.#setCall(message.toolCallId, {
            status: message.isError ? "error" : "done",
            output: resultText(message),
          });
        }
        break;
      case "pi.compaction":
        this.#push({ kind: "notice", id: String(entry.id), text: "Earlier messages were summarized to save context." });
        break;
      case "pi.reset": {
        this.#turns = [];
        this.#toolIndex.clear();
        this.#live = null;
        this.#touch(0);
        const handoff = message?.role === "user" ? userText(message) : "";
        this.#push({
          kind: "notice",
          id: String(entry.id),
          text: handoff.length > 0 ? `New context: ${handoff}` : "New context",
        });
        break;
      }
      default:
        break;
    }
  }

  #push(turn: Turn): void {
    this.#turns.push(turn);
    this.#touch(this.#turns.length - 1);
  }

  #commitAssistant(id: string, message: AssistantMessage): void {
    const index = this.#live?.index ?? this.#turns.length;
    this.#live = null;
    const failed = message.stopReason === "error" || message.stopReason === "aborted";
    this.#renderAssistant(index, id, message.content, false, failed ? (message.errorMessage ?? message.stopReason) : undefined);
  }

  #startLive(message: AssistantMessage): void {
    const index = this.#live?.index ?? this.#turns.length;
    this.#live = { index, blocks: structuredClone(message.content) };
    this.#renderLive();
  }

  #updateLive(changes: readonly MessageChange[]): void {
    const live = this.#live;
    if (live === null) return;
    for (const change of changes) {
      switch (change.type) {
        case "message":
          live.blocks = structuredClone(change.message.content);
          break;
        case "text_start":
        case "thinking_start":
        case "toolcall_start":
        case "block":
          live.blocks[change.contentIndex] = structuredClone(change.block);
          break;
        case "text_delta": {
          const block = live.blocks[change.contentIndex];
          if (block?.type === "text") block.text += change.delta;
          break;
        }
        case "thinking_delta": {
          const block = live.blocks[change.contentIndex];
          if (block?.type === "thinking") block.thinking += change.delta;
          break;
        }
        case "toolcall_delta": {
          const block = live.blocks[change.contentIndex];
          if (block?.type === "toolCall") appendAtPath(block.arguments, change.path, change.delta);
          break;
        }
      }
    }
    this.#renderLive();
  }

  #renderLive(): void {
    const live = this.#live;
    if (live !== null) this.#renderAssistant(live.index, `live:${live.index}`, live.blocks, true, undefined);
  }

  #dropLive(): void {
    const live = this.#live;
    if (live === null) return;
    this.#live = null;
    this.#turns.splice(live.index);
    for (const [callId, [turn]] of this.#toolIndex) {
      if (turn >= live.index) this.#toolIndex.delete(callId);
    }
    this.#touch(live.index);
  }

  #renderAssistant(index: number, id: string, blocks: readonly Block[], live: boolean, error: string | undefined): void {
    const parts: Part[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.text.length > 0) parts.push({ type: "text", text: block.text });
      } else if (block.type === "thinking") {
        if (block.thinking.length > 0) parts.push({ type: "thinking", text: block.thinking });
      } else {
        this.#toolIndex.set(block.id, [index, parts.length]);
        parts.push({ type: "tool", call: this.#callView(block.id, block.name, block.arguments) });
      }
    }
    this.#turns[index] = { kind: "assistant", id, parts, live, ...(error === undefined ? {} : { error }) };
    this.#touch(index);
  }

  #callView(callId: string, modelName: string, args: JsonObject): ToolCallView {
    const { plugin, tool } = this.label(modelName);
    const state = this.#calls.get(callId);
    const json = JSON.stringify(args ?? {});
    return {
      id: callId,
      plugin,
      tool,
      args: json.length > MAX_ARGS ? `${json.slice(0, MAX_ARGS - 1)}…` : json,
      status: state?.status ?? "preparing",
      output: (state?.output ?? "").slice(-MAX_OUTPUT),
    };
  }

  #setCall(callId: string, state: CallState): void {
    this.#calls.set(callId, state);
    const at = this.#toolIndex.get(callId);
    if (at === undefined) return;
    const [turnIndex, partIndex] = at;
    const turn = this.#turns[turnIndex];
    if (turn?.kind !== "assistant") return;
    const part = turn.parts[partIndex];
    if (part?.type !== "tool") return;
    const parts = [...turn.parts];
    parts[partIndex] = { type: "tool", call: { ...part.call, status: state.status, output: state.output.slice(-MAX_OUTPUT) } };
    this.#turns[turnIndex] = { ...turn, parts };
    this.#touch(turnIndex);
  }

  /** A call that ended without a result entry: faulted, orphaned, or cut off by the end of its run. */
  #failCall(callId: string): void {
    const state = this.#calls.get(callId);
    if (state?.status === "done" || state?.status === "error") return;
    this.#setCall(callId, { status: "error", output: state?.output || "The tool call did not finish." });
  }

  #touch(index: number): void {
    this.#dirty = this.#dirty === null ? index : Math.min(this.#dirty, index);
  }
}

function userText(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

function resultText(message: ToolResultMessage): string {
  return message.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}

/** Streamed tool-call arguments arrive as string appends at a path inside `arguments`. */
function appendAtPath(args: JsonObject, path: readonly (string | number)[], delta: string): void {
  if (path.length === 0) return;
  let node: Record<string | number, unknown> = args;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (typeof next !== "object" || next === null) return;
    node = next as Record<string | number, unknown>;
  }
  const last = path[path.length - 1] as string | number;
  const current = node[last];
  node[last] = (typeof current === "string" ? current : "") + delta;
}
