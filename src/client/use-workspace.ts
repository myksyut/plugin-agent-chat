// The browser's single entry point to the user's agent: identity, agent state,
// the folded chat view of the open conversation, and the callable actions.
import { useAgent } from "agents/react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ROOT_SESSION_ID,
  applyFrame,
  isChatFrame,
  type Added,
  type AppState,
  type ChatView,
  type ConversationInfo,
  type Me,
  type Outcome,
  type PluginDraft,
  type SendInput,
  type SessionId,
} from "../shared/protocol";

export type Panel = "chat" | "plugins";

export type WorkspaceActions = {
  send(text: string): Promise<Outcome<{ accepted: boolean }>>;
  abort(): Promise<void>;
  open(session: SessionId): Promise<void>;
  newConversation(): Promise<void>;
  addPlugin(draft: PluginDraft): Promise<Outcome<Added>>;
  setPluginEnabled(id: string, enabled: boolean): Promise<Outcome<null>>;
  removePlugin(id: string): Promise<Outcome<null>>;
  refreshPlugin(id: string): Promise<Outcome<Added>>;
  showPanel(panel: Panel): void;
};

export type Workspace =
  | { readonly status: "connecting" }
  | {
      readonly status: "ready";
      readonly state: AppState;
      readonly session: SessionId;
      /** null until the first frame for `session` arrives. */
      readonly chat: ChatView | null;
      readonly panel: Panel;
      /** false while the socket is down and reconnecting. */
      readonly online: boolean;
      readonly actions: WorkspaceActions;
    };

const HASH = /^#\/c\/(.+)$/;

function sessionFromHash(): SessionId {
  return HASH.exec(window.location.hash)?.[1] ?? ROOT_SESSION_ID;
}

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function useWorkspace(me: Me): Workspace {
  const [state, setState] = useState<AppState | null>(null);
  const [session, setSession] = useState<SessionId>(sessionFromHash);
  const [chat, setChat] = useState<ChatView | null>(null);
  const [panel, setPanel] = useState<Panel>("chat");
  const [online, setOnline] = useState(false);

  const sessionRef = useRef(session);
  const chatRef = useRef<ChatView | null>(null);
  const callRef = useRef<(method: string, args: unknown[]) => Promise<unknown>>(() =>
    Promise.reject(new Error("Not connected")),
  );

  const invoke = useCallback(async <T,>(method: string, args: unknown[]): Promise<Outcome<T>> => {
    try {
      return (await callRef.current(method, args)) as Outcome<T>;
    } catch (error) {
      return failure(error);
    }
  }, []);

  const openSession = useCallback(
    async (next: SessionId): Promise<void> => {
      if (next !== sessionRef.current) {
        sessionRef.current = next;
        chatRef.current = null;
        setSession(next);
        setChat(null);
        window.history.replaceState(null, "", `#/c/${next}`);
      }
      setPanel("chat");
      const result = await invoke<null>("openConversation", [next]);
      if (!result.ok && next !== ROOT_SESSION_ID && sessionRef.current === next) {
        await openSession(ROOT_SESSION_ID);
      }
    },
    [invoke],
  );

  const agent = useAgent<AppState>({
    agent: "UserAgent",
    name: me.agentName,
    onStateUpdate: (next) => setState(next),
    onOpen: () => {
      setOnline(true);
      void invoke<null>("openConversation", [sessionRef.current]);
    },
    onClose: () => setOnline(false),
    onMessage: (event) => {
      if (typeof event.data !== "string") return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isChatFrame(frame) || frame.session !== sessionRef.current) return;
      const next = applyFrame(chatRef.current, frame);
      if (next === "resync") {
        void invoke<null>("openConversation", [sessionRef.current]);
        return;
      }
      chatRef.current = next;
      setChat(next);
    },
  });
  callRef.current = (method, args) => agent.call(method, args);

  const actions = useMemo<WorkspaceActions>(
    () => ({
      send: (text) => {
        const input: SendInput = {
          session: sessionRef.current,
          text,
          operationId: crypto.randomUUID(),
        };
        return invoke<{ accepted: boolean }>("send", [input]);
      },
      abort: async () => {
        await invoke<boolean>("abort", [sessionRef.current]);
      },
      open: openSession,
      newConversation: async () => {
        try {
          const info = (await callRef.current("newConversation", [])) as ConversationInfo;
          await openSession(info.id);
        } catch {
          // The sidebar stays on the current conversation; nothing else to reconcile.
        }
      },
      addPlugin: (draft) => invoke<Added>("addPlugin", [draft]),
      setPluginEnabled: (id, enabled) => invoke<null>("setPluginEnabled", [id, enabled]),
      removePlugin: (id) => invoke<null>("removePlugin", [id]),
      refreshPlugin: (id) => invoke<Added>("refreshPlugin", [id]),
      showPanel: setPanel,
    }),
    [invoke, openSession],
  );

  if (state === null) return { status: "connecting" };
  return { status: "ready", state, session, chat, panel, online, actions };
}
