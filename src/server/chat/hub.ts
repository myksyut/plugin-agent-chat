// Conversations, viewers, and live watches for one user.
import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { Connection } from "agents";
import type { ConversationInfo, Outcome, SendInput, SessionId } from "../../shared/protocol";
import { ROOT_SESSION_ID } from "../../shared/protocol";
import type { UserAgent, ViewerState } from "../agent";
import { Transcript } from "./transcript";

type Watch = { readonly transcript: Transcript; readonly stream: AgentEventStream };

type ConversationRow = { id: string; title: string; model: string; updated_at: number };

const TITLE_LENGTH = 60;

/**
 * Table `conversations` lists the user-visible pi sessions and the model last applied to each.
 * pi's sessions.list() is not used: it includes subagent conversations.
 */
export class ChatHub {
  /** Single-flight per session: concurrent opens share one events() stream. */
  #watches = new Map<SessionId, Promise<Watch>>();

  constructor(private readonly agent: UserAgent) {}

  conversations(): ConversationInfo[] {
    return this.agent.sql<ConversationRow>`SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC, id DESC`.map(
      (row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }),
    );
  }

  /** Runs on every isolate start: tables, model migration, then re-attach watches for connected viewers. */
  async resume(): Promise<void> {
    this.agent.sql`CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.agent.sql`INSERT OR IGNORE INTO conversations (id, title, model, updated_at)
      VALUES (${ROOT_SESSION_ID}, '', '', ${Date.now()})`;
    const model = this.agent.modelId;
    for (const row of this.agent.sql<ConversationRow>`SELECT id FROM conversations WHERE model != ${model}`) {
      await this.agent.harness.session(row.id).setModel(this.agent.ai(model));
      this.agent.sql`UPDATE conversations SET model = ${model} WHERE id = ${row.id}`;
    }
    const viewed = new Set<SessionId>();
    for (const connection of this.agent.getConnections<ViewerState>()) {
      if (connection.state?.session !== undefined) viewed.add(connection.state.session);
    }
    for (const session of viewed) {
      const watch = await this.#ensureWatch(session);
      this.#sendToViewers(session, JSON.stringify(watch.transcript.frame(0)));
    }
  }

  async create(connection: Connection<ViewerState>): Promise<ConversationInfo> {
    const session = await this.agent.harness.sessions.create();
    const info: ConversationInfo = { id: session.id, title: "", updatedAt: Date.now() };
    this.agent.sql`INSERT INTO conversations (id, title, model, updated_at)
      VALUES (${info.id}, '', ${this.agent.modelId}, ${info.updatedAt})`;
    this.agent.publish();
    await this.open(connection, info.id);
    return info;
  }

  /** Makes `connection` a viewer of `session` only, and sends it a full frame. */
  async open(connection: Connection<ViewerState>, session: SessionId): Promise<Outcome<null>> {
    if (!this.#exists(session)) return { ok: false, error: `No conversation ${session}` };
    const previous = connection.state?.session;
    const watch = await this.#ensureWatch(session);
    // No await between becoming a viewer and the full frame: tail frames can only follow it.
    connection.setState({ session });
    connection.send(JSON.stringify(watch.transcript.frame(0)));
    if (previous !== undefined && previous !== session) await this.#release(previous);
    return { ok: true, value: null };
  }

  async close(connection: Connection<ViewerState>): Promise<void> {
    const session = connection.state?.session;
    if (session !== undefined) await this.#release(session, connection.id);
  }

  async send(input: SendInput): Promise<Outcome<{ accepted: boolean }>> {
    if (!this.#exists(input.session)) return { ok: false, error: `No conversation ${input.session}` };
    const text = input.text.trim();
    if (text.length === 0) return { ok: false, error: "Message is empty" };
    if (input.operationId.length === 0) return { ok: false, error: "operationId is required" };
    const receipt = await this.agent.harness
      .session(input.session)
      .submit(text, { operationId: input.operationId, whenBusy: "followUp" });
    if (receipt.accepted) {
      const title = text.replace(/\s+/g, " ").slice(0, TITLE_LENGTH);
      this.agent.sql`UPDATE conversations
        SET title = CASE WHEN title = '' THEN ${title} ELSE title END, updated_at = ${Date.now()}
        WHERE id = ${input.session}`;
      this.agent.publish();
    }
    return { ok: true, value: { accepted: receipt.accepted } };
  }

  async abort(session: SessionId): Promise<boolean> {
    if (!this.#exists(session)) return false;
    return this.agent.harness.session(session).abort();
  }

  #exists(session: SessionId): boolean {
    return this.agent.sql`SELECT 1 FROM conversations WHERE id = ${session}`.length > 0;
  }

  #ensureWatch(session: SessionId): Promise<Watch> {
    const existing = this.#watches.get(session);
    if (existing) return existing;
    const opening = (async (): Promise<Watch> => {
      const stream = await this.agent.harness.session(session).events();
      const transcript = Transcript.fromSnapshot(session, stream.snapshot, (name) => this.agent.book.labelTool(name));
      stream.start(async (events) => {
        const from = transcript.apply(events);
        if (from !== null) this.#sendToViewers(session, JSON.stringify(transcript.frame(from)));
      });
      void stream.closed.then(() => {
        if (this.#watches.get(session) === opening) this.#watches.delete(session);
      });
      return { transcript, stream };
    })();
    this.#watches.set(session, opening);
    opening.catch(() => {
      if (this.#watches.get(session) === opening) this.#watches.delete(session);
    });
    return opening;
  }

  /** Stops the session's stream when no viewer other than `leaving` remains. */
  async #release(session: SessionId, leaving?: string): Promise<void> {
    for (const connection of this.agent.getConnections<ViewerState>()) {
      if (connection.id !== leaving && connection.state?.session === session) return;
    }
    const watch = this.#watches.get(session);
    if (watch === undefined) return;
    this.#watches.delete(session);
    await (await watch.catch(() => null))?.stream.stop();
  }

  #sendToViewers(session: SessionId, frame: string): void {
    for (const connection of this.agent.getConnections<ViewerState>()) {
      if (connection.state?.session === session) connection.send(frame);
    }
  }
}
