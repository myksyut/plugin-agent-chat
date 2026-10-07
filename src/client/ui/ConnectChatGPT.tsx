import { useState, type FormEvent } from "react";
import type { ChatGPTState, Outcome } from "../../shared/protocol";
import type { WorkspaceActions } from "../use-workspace";
import { Button } from "./Button";
import { fieldClass } from "./PluginsPanel";

/** Shown in the chat pane until the plan is connected; `connecting` comes from AppState, so it survives reloads. */
export function ConnectChatGPT({
  chatgpt,
  actions,
}: {
  chatgpt: Exclude<ChatGPTState, { state: "connected" }>;
  actions: WorkspaceActions;
}) {
  const [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<Outcome<unknown>>) => {
    setPending(true);
    setError(null);
    const result = await call();
    setPending(false);
    if (!result.ok) setError(result.error);
    return result.ok;
  };

  return (
    <section
      className="mx-auto flex w-full max-w-md flex-col gap-3 rounded-card bg-surface p-4 shadow-card"
      aria-busy={pending}
      style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-[14px] font-semibold text-ink">Connect ChatGPT</h2>
        <p className="text-[13px] text-ink-2">The agent runs on your ChatGPT plan. Sign in to start chatting.</p>
      </header>
      {chatgpt.state === "disconnected" ? (
        <div>
          <Button size="sm" variant="primary" disabled={pending} onClick={() => void run(actions.connectChatGPT)}>
            Connect ChatGPT
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event: FormEvent) => {
            event.preventDefault();
            if (await run(() => actions.completeChatGPT(callbackUrl.trim()))) setCallbackUrl("");
          }}
        >
          <a
            href={chatgpt.authorizeUrl}
            target="_blank"
            rel="noopener"
            className="inline-flex h-7 w-fit items-center rounded-full bg-accent-tint px-3 text-[12.5px] font-medium text-accent-ink hover:underline"
          >
            Open ChatGPT sign-in
          </a>
          <p className="text-[12.5px] text-ink-2">
            After you approve, the tab shows a connection error. Copy that tab's address and paste it here.
          </p>
          <fieldset disabled={pending} className="flex items-center gap-2">
            <input
              required
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://127.0.0.1:1455/auth/callback?code=…"
              aria-label="Address of the sign-in tab"
              className={fieldClass}
            />
            <Button type="submit" size="sm" variant="primary">
              Finish
            </Button>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert" className="rounded-control bg-red-tint px-2.5 py-1.5 text-[12px] text-red [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </section>
  );
}
