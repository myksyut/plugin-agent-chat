import { useEffect, useState } from "react";
import type { Me, PluginView } from "../shared/protocol";
import { Composer } from "./ui/Composer";
import { ConnectChatGPT } from "./ui/ConnectChatGPT";
import { PluginsPanel } from "./ui/PluginsPanel";
import { RunIndicator } from "./ui/RunIndicator";
import { Shell } from "./ui/Shell";
import { Sidebar } from "./ui/Sidebar";
import { Transcript } from "./ui/Transcript";
import { useWorkspace } from "./use-workspace";

type Identity =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: string }
  | { readonly status: "ready"; readonly me: Me };

function useIdentity(): Identity {
  const [identity, setIdentity] = useState<Identity>({ status: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/me", { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Sign-in required (${response.status})`);
        return (await response.json()) as Me;
      })
      .then((me) => setIdentity({ status: "ready", me }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setIdentity({ status: "failed", error: error instanceof Error ? error.message : String(error) });
      });
    return () => abort.abort();
  }, []);
  return identity;
}

function Centered({ children }: { children: string }) {
  return <div className="flex h-full items-center justify-center text-[13px] text-ink-3">{children}</div>;
}

export function App() {
  const identity = useIdentity();
  if (identity.status === "loading") return <Centered>Loading…</Centered>;
  if (identity.status === "failed") return <Centered>{identity.error}</Centered>;
  return <Workspace me={identity.me} />;
}

function enabledSkills(plugins: readonly PluginView[]) {
  return plugins.flatMap((p) => (p.kind === "skill" && p.enabled ? [{ name: p.name, description: p.description }] : []));
}

function Workspace({ me }: { me: Me }) {
  const workspace = useWorkspace(me);
  const [sendError, setSendError] = useState<string | null>(null);
  if (workspace.status === "connecting") return <Centered>Connecting…</Centered>;

  const { state, session, chat, panel, online, actions } = workspace;
  const chatgpt = state.chatgpt;
  const connect = chatgpt.state === "connected" ? null : <ConnectChatGPT chatgpt={chatgpt} actions={actions} />;

  return (
    <Shell
      sidebar={
        <Sidebar
          conversations={state.conversations}
          active={session}
          panel={panel}
          pluginCount={state.plugins.length}
          email={me.email}
          chatgpt={chatgpt}
          onNew={async () => {
            setSendError(null);
            const result = await actions.newConversation();
            if (!result.ok) setSendError(result.error);
          }}
          onPick={(id) => {
            setSendError(null);
            void actions.open(id);
          }}
          onPanel={actions.showPanel}
          onDisconnect={actions.disconnectChatGPT}
        />
      }
    >
      {!online && (
        <div role="status" className="bg-orange-tint px-4 py-1.5 text-center text-[12px] text-orange">
          Reconnecting…
        </div>
      )}
      {panel === "plugins" ? (
        <PluginsPanel plugins={state.plugins} actions={actions} />
      ) : (
        <>
          <Transcript view={chat} empty={connect && <div className="py-10">{connect}</div>} />
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-3">
            {connect !== null && chat !== null && chat.turns.length > 0 && connect}
            <RunIndicator run={chat?.run} />
            {chat !== null && chat.queued > 0 && (
              <span className="text-[12px] text-ink-3">{chat.queued} queued</span>
            )}
            {sendError && (
              <p role="alert" className="rounded-control bg-red-tint px-2.5 py-1.5 text-[12px] text-red">
                {sendError}
              </p>
            )}
          </div>
          <Composer
            skills={enabledSkills(state.plugins)}
            plugins={state.plugins}
            run={chat?.run}
            disabled={chatgpt.state !== "connected"}
            model={
              chatgpt.state === "connected"
                ? {
                    models: chatgpt.models,
                    current: chatgpt.model,
                    pick: async (slug) => {
                      setSendError(null);
                      const result = await actions.setModel(slug);
                      if (!result.ok) setSendError(result.error);
                    },
                  }
                : null
            }
            onSend={async (text) => {
              setSendError(null);
              const result = await actions.send(text);
              if (!result.ok) setSendError(result.error);
            }}
            onStop={() => void actions.abort()}
            onTogglePlugin={(id, enabled) => void actions.setPluginEnabled(id, enabled)}
          />
        </>
      )}
    </Shell>
  );
}
