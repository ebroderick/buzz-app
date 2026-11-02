// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import { PanelWorkspace } from "../panels/PanelWorkspace";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
  useChannelMenuActions,
} from "./ChannelNavigationState";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
function fixture(
  run: (
    action: string,
    id: string,
    signal?: AbortSignal,
  ) => Promise<void> = async () => {},
) {
  let ids = ["existing"];
  const session = () =>
    ({
      channels: { list: () => ({ channels: ids.map((id) => ({ id })) }) },
      sidebarPreferences: { setMute: async () => [] },
      channelLifecycle: { run },
    }) as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    scope: "community:viewer",
    viewer: "viewer",
    generation: 1,
    session: session(),
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as RelayData;
  return {
    relay,
    roster: (next: string[]) => {
      ids = next;
    },
    replace() {
      snapshot = {
        ...snapshot,
        generation: snapshot.generation + 1,
        session: session(),
      };
      for (const listener of listeners) listener();
    },
  };
}
function mount(relay: RelayData, toasts = false) {
  return renderHook(
    () => {
      const value = useChannelNavigation();
      if (!value) throw new Error("Missing channel navigation provider");
      return value;
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <StrictMode>
          {toasts ? (
            <ToastProvider>
              <ChannelNavigationProvider relay={relay}>
                {children}
              </ChannelNavigationProvider>
            </ToastProvider>
          ) : (
            <ChannelNavigationProvider relay={relay}>
              {children}
            </ChannelNavigationProvider>
          )}
        </StrictMode>
      ),
    },
  );
}
it("captures the roster before DM preparation and preserves it across participant changes", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    h.roster(["existing", "new"]);
  });
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "peer"]),
  );
  act(() => view.result.current?.prepareDm(["other"]));
  expect(view.result.current.preparingDm?.existing).toEqual(
    new Set(["existing"]),
  );
  expect(view.result.current.preparingDm?.members).toEqual(
    new Set(["viewer", "other"]),
  );
  act(() => view.result.current?.clearPreparingDm());
  expect(view.result.current.preparingDm).toBeUndefined();
});
it("resets transient handoffs and rejects retired callbacks on session replacement", () => {
  const h = fixture();
  const view = mount(h.relay);
  act(() => {
    view.result.current?.prepareDm(["peer"]);
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "leave",
    );
  });
  const retired = view.result.current;
  retired.activityThread.current = {
    channelId: "channel",
    messageId: "root",
    entryId: "visit",
    signal: new AbortController().signal,
    trigger: null,
  };
  retired.activityAgent.current = {
    channelId: "channel",
    agent: "agent",
    trigger: null,
  };
  act(() => h.replace());
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  expect(view.result.current.activityThread.current).toBeUndefined();
  expect(view.result.current.activityAgent.current).toBeUndefined();
  act(() => {
    retired.prepareDm(["late"]);
    retired.openLifecycle({ id: "late", name: "Late" }, "leave");
  });
  expect(view.result.current.preparingDm).toBeUndefined();
  expect(view.result.current.lifecycleDialog).toBeUndefined();
});

it("hands both entrances to one confirmation and preserves its origin until closed", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const trigger = document.createElement("button");
  act(() => view.result.current.openLifecycle(channel, "leave", trigger));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "leave",
    trigger,
  });
  act(() =>
    view.result.current.openLifecycle({ id: "other", name: "Other" }, "delete"),
  );
  expect(view.result.current.lifecycleDialog?.channel).toBe(channel);
  act(() => view.result.current.closeLifecycle());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() => view.result.current.openLifecycle(channel, "archive"));
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});

it.each([true, false])(
  "says whether archiving starter channel (%s) resumes adding new members on Unarchive",
  async (autoJoin) => {
    const view = mount(fixture().relay, true);
    act(() =>
      view.result.current.openLifecycle(
        { id: "general", name: "general", ...(autoJoin && { autoJoin }) },
        "archive",
      ),
    );
    const archive =
      "Archive this channel for everyone and remove it from the sidebar. Messages are kept. Find it in search and open Settings to unarchive it later.";
    expect(
      await screen.findByRole("dialog", { name: "Archive channel: general" }),
    ).toHaveAccessibleDescription(
      autoJoin
        ? `${archive} It’s a starter channel, so new members will be added to it again once it’s unarchived. To stop that, turn off Starter channel for new members in Settings first.`
        : archive,
    );
  },
);

it("retains the settings tab close control when an archive action remounts", () => {
  const view = mount(fixture().relay);
  const content = (archived: boolean) => (
    <PanelWorkspace
      value="settings"
      select={() => {}}
      items={[
        {
          id: "settings",
          label: "Channel settings",
          close: () => {},
          content: (
            <aside aria-label="Channel settings">
              <button type="button">Canvas</button>
              <button key={String(archived)} type="button">
                {archived ? "Unarchive channel" : "Archive channel"}
              </button>
            </aside>
          ),
        },
      ]}
    />
  );
  const panel = render(content(false));
  const trigger = panel.getByRole("button", { name: "Archive channel" });
  const close = panel.getByRole("button", {
    name: "Close Channel settings tab",
  });
  act(() =>
    view.result.current.openLifecycle(
      { id: "channel", name: "Channel" },
      "archive",
      trigger,
    ),
  );
  panel.rerender(content(true));
  expect(trigger.isConnected).toBe(false);
  expect(view.result.current.lifecycleDialog?.focusFallback).toBe(close);
  expect(close.isConnected).toBe(true);
});

it("publishes sidebar actions to a sibling menu and retires them with the session", () => {
  const h = fixture();
  const view = renderHook(
    () => ({
      handoff: useChannelNavigation(),
      actions: useChannelMenuActions(),
    }),
    {
      wrapper: ({ children }) => (
        <ChannelNavigationProvider relay={h.relay}>
          {children}
        </ChannelNavigationProvider>
      ),
    },
  );
  const retired = view.result.current.handoff?.menuActions;
  if (!retired) throw new Error("Missing navigation provider");
  const actions = () => ["Mute"];
  act(() => retired.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => h.replace());
  expect(view.result.current.actions).toBeUndefined();
  act(() => retired.publish(() => ["stale"]));
  expect(view.result.current.actions).toBeUndefined();
  act(() => view.result.current.handoff?.menuActions.publish(actions));
  expect(view.result.current.actions).toBe(actions);
  act(() => view.result.current.handoff?.menuActions.publish(undefined));
  expect(view.result.current.actions).toBeUndefined();
});

it("retires only the originating header confirmation and rejects its deferred reopening", () => {
  const h = fixture();
  const view = mount(h.relay);
  const channel = { id: "channel", name: "Channel" };
  const origin = new AbortController();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog?.origin).toBe(origin.signal);
  act(() => origin.abort());
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  act(() =>
    view.result.current.openLifecycle(
      channel,
      "delete",
      undefined,
      origin.signal,
    ),
  );
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  const old = new AbortController();
  act(() =>
    view.result.current.openLifecycle(channel, "delete", undefined, old.signal),
  );
  act(() => view.result.current.closeLifecycle());
  act(() => view.result.current.openLifecycle(channel, "archive"));
  act(() => old.abort());
  expect(view.result.current.lifecycleDialog).toEqual({
    channel,
    action: "archive",
  });
});

it("runs a chat archive's Undo through the lifecycle gate, after any action holding it", async () => {
  const pending = new Map<string, () => void>();
  const run = vi.fn(
    (action: string, id: string) =>
      new Promise<void>((resolve) => pending.set(`${action}:${id}`, resolve)),
  );
  const view = mount(fixture(run).relay, true);
  const planning = { id: "a", name: "Planning", channelType: "solo" as const };
  const roadmap = { id: "b", name: "Roadmap", channelType: "solo" as const };
  act(() => view.result.current.openLifecycle(planning, "archive"));
  await waitFor(() => expect(pending.has("archive:a")).toBe(true));
  await act(async () => pending.get("archive:a")?.());
  await screen.findByRole("dialog", { name: "Chat archived: Planning" });
  expect(view.result.current.lifecycleDialog).toBeUndefined();

  // Another archive holds the session's one lifecycle slot.
  act(() => view.result.current.openLifecycle(roadmap, "archive"));
  await waitFor(() => expect(pending.has("archive:b")).toBe(true));
  const [undo] = screen.getAllByRole("button", { name: "Undo" });
  if (!undo) throw new Error("Missing Undo");
  fireEvent.click(undo);
  expect(run).not.toHaveBeenCalledWith("unarchive", "a", expect.anything());
  expect(view.result.current.lifecycleDialog?.channel).toBe(roadmap);

  await act(async () => pending.get("archive:b")?.());
  // Undo then holds the gate, so lifecycle menus stay disabled until it settles.
  await waitFor(() =>
    expect(run).toHaveBeenLastCalledWith(
      "unarchive",
      "a",
      expect.any(AbortSignal),
    ),
  );
  expect(view.result.current.lifecycleDialog).toMatchObject({
    channel: planning,
    action: "unarchive",
    confirmed: true,
  });
  // A slow Undo is announced instead of leaving the click unanswered.
  expect(
    await screen.findByRole(
      "dialog",
      { name: "Unarchiving chat…" },
      { timeout: 2000 },
    ),
  ).toBeDefined();
  await act(async () => pending.get("unarchive:a")?.());
  await screen.findByRole("dialog", { name: "Chat unarchived: Planning" });
  expect(view.result.current.lifecycleDialog).toBeUndefined();
  expect(run).toHaveBeenCalledTimes(3);
});
