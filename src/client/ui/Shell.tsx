import type { ReactNode } from "react";

/** Sidebar on the striped canvas, content in one raised pane. */
export function Shell({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full">
      {sidebar}
      <main className="my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-window bg-page shadow-card">
        {children}
      </main>
    </div>
  );
}
