// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi, assert } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { SIDEBAR_REVEAL_BUDGET_MS } from "../../bundled/channels/useSidebarStartup";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { DiscoveryState } from "../relay/discovery";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { huddleDescription } from "../huddle/lifecycle";
import { createRelaySession } from "../relay/session";
import { createChannelLifecycle } from "../relay/channel-lifecycle";
import { ReadError } from "../relay/errors";
import { createRecovery, RECOVERY_NOTICE_DELAY_MS } from "../relay/recovery";
import { createSidebarPreferencesStore } from "../relay/sidebar-preferences-store";
import type {
  SidebarGroups,
  SidebarPreferences,
  SidebarFilterMode,
  SidebarSortMode,
} from "../relay/sidebar-preferences";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { ChannelList } from "../relay/contracts";
import type { Navigation } from "../navigation/controller";
import type {
  RegisteredSidebarSection,
  SidebarSectionRow,
  SidebarSections,
} from "./sidebar-sections-service";
import type {
  RegisteredSidebarRows,
  SidebarRows,
  SidebarRowContribution,
  SidebarRow,
} from "./sidebar-rows-service";
import { SidebarRowsService } from "./sidebar-rows-service";
import { createRef, useState, type ReactNode, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { ChannelHeaderMenu } from "../../bundled/channels/ChannelHeaderMenu";
import { PrimarySidebar } from "../../app/shell/PrimarySidebar";
import { buzzLinkTarget } from "../navigation/buzz-links";
import {
  ChannelNavigationProvider,
  useChannelNavigation,
} from "./ChannelNavigationState";
import { readView, writeView } from "../../shared/view-state";
import styles from "../../app/shell/PrimarySidebar.module.css";
import { BestieNavigationProvider } from "../../app/shell/BestieNavigation";
import { PageNavigation } from "../../app/shell/PageNavigation";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import { localAgentsFixture } from "../agents/local-testing";
import { forgetDefaultAgent, setDefaultAgent } from "../solo/default-agent";
import type { RegisteredPage } from "../pages/service";

const { rowRender, menuRender } = vi.hoisted(() => ({
  rowRender: vi.fn(),
  menuRender: vi.fn(),
}));
// Observe the real row below ChannelSidebarItem's production memo boundary.
// React hooks, the parent, the item and the row implementation remain real.
vi.mock("../../bundled/channels/ChannelSidebarRow", async (original) => {
  const actual =
    await original<typeof import("../../bundled/channels/ChannelSidebarRow")>();
  return {
    ...actual,
    ChannelSidebarRow: (
      props: Parameters<typeof actual.ChannelSidebarRow>[0],
    ) => {
      rowRender(props);
      return <actual.ChannelSidebarRow {...props} />;
    },
  };
});
// Observe the real row menu provider and popup the same way.
vi.mock("../../shared/design-system/ui/Menu", async (original) => {
  const actual =
    await original<typeof import("../../shared/design-system/ui/Menu")>();
  return {
    ...actual,
    ContextMenuRoot: (props: Parameters<typeof actual.ContextMenuRoot>[0]) => {
      menuRender("root", props);
      return <actual.ContextMenuRoot {...props} />;
    },
    MenuPopup: (props: Parameters<typeof actual.MenuPopup>[0]) => {
      menuRender("popup", props);
      return <actual.MenuPopup {...props} />;
    },
  };
});
beforeEach(() => {
  // jsdom has no layout; browser journeys own geometry. Only supply the API.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function fixture(
  sidebarPreferences?: ReturnType<
    typeof createSidebarPreferencesStore
  >["queries"],
  status: RelaySnapshot["status"] = "ready",
  initialChannels: ChannelList["channels"] = [
    { id: "alpha", name: "alpha", channelType: "stream" },
    { id: "beta", name: "beta", channelType: "stream" },
    { id: "gamma", name: "gamma", channelType: "stream" },
  ],
  sidebarSections?: SidebarSections,
  sidebarRows?: SidebarRows,
) {
  const owner = createRelaySession(null);
  owners.push(owner);
  let list: ChannelList = {
    status: "ready",
    activityStatus: "unavailable",
    channels: initialChannels.map((channel) => ({
      space: "collaborative",
      ...channel,
    })),
  };
  const listeners = new Set<() => void>();
  const live = {
    ...owner.session.live.snapshot(),
    roster: { state: "verified" as const },
  };
  const session = {
    ...owner.session,
    scope: `https://relay.test:${"a".repeat(64)}`,
    viewer: "a".repeat(64),
    ...(sidebarPreferences ? { sidebarPreferences } : {}),
    live: { ...owner.session.live, snapshot: () => live },
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
      subscribeList(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  // Like the store: changed summaries are replaced, the rest keep identity.
  const publish = (
    id: string,
    change: Partial<ChannelList["channels"][number]>,
  ) =>
    act(() => {
      list = {
        ...list,
        channels: list.channels.map((channel) =>
          channel.id === id ? { ...channel, ...change } : channel,
        ),
      };
      for (const listener of listeners) listener();
    });
  // A discovery commit, as live roster events produce.
  const commit = () =>
    act(() => {
      list = { ...list, asOf: (list.asOf ?? 0) + 1 };
      for (const listener of listeners) listener();
    });
  const drop = (id: string) =>
    act(() => {
      list = {
        ...list,
        channels: list.channels.filter((channel) => channel.id !== id),
      };
      for (const listener of listeners) listener();
    });
  let snapshot: RelaySnapshot = {
    status,
    ...(status === "ready"
      ? { scope: session.scope, viewer: "a".repeat(64) }
      : {}),
    generation: 1,
    session,
  };
  const connectionListeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    retry() {},
    disconnect() {},
    async clearCache() {},
  } satisfies RelayData;
  const navigator = {
    open: vi.fn().mockResolvedValue({ status: "opened" }),
    subscribe: () => () => {},
    snapshot: () => ({ attempt: { id: "visit" } }),
  } as unknown as Navigation;
  const view = (
    id: string,
    pages: ReactNode = (
      <nav aria-label="Pages">
        <button type="button">Projects</button>
      </nav>
    ),
    sidebarVisible = true,
  ) => (
    <ToastProvider>
      <ChannelNavigationProvider relay={relay}>
        {sidebarVisible && (
          <PrimarySidebar
            relay={relay}
            navigator={navigator}
            target={{
              version: 1,
              kind: "conversation",
              channelId: id,
              scope: {
                viewer: "a".repeat(64),
                communityOrigin: "https://relay.test",
              },
            }}
            sidebarSections={sidebarSections}
            sidebarRows={sidebarRows}
          >
            {pages}
          </PrimarySidebar>
        )}
      </ChannelNavigationProvider>
    </ToastProvider>
  );
  return {
    view,
    navigator,
    snapshot,
    list,
    session,
    publish,
    commit,
    drop,
    connection(next: RelaySnapshot) {
      act(() => {
        snapshot = next;
        for (const listener of connectionListeners) listener();
      });
    },
  };
}

function visibilityFixture() {
  const f = fixture();
  const read = vi
    .fn()
    .mockRejectedValue(new ReadError("unavailable", "offline", 503));
  const lifecycle = createChannelLifecycle({
    reader: { read },
    viewer: f.session.viewer,
    relayAuthor: "b".repeat(64),
    canAccess: () => true,
    acceptDiscovery() {},
    removed() {},
  });
  f.session.channelLifecycle = lifecycle.capability;
  return { f, read, lifecycle };
}

it("keeps visibility recovery quiet, then offers the existing retry after exhaustion", async () => {
  vi.useFakeTimers();
  const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
  const { f, read, lifecycle } = visibilityFixture();
  try {
    render(f.view("alpha"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("Hidden conversations could not be refreshed."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry hidden conversations" }),
    ).not.toBeInTheDocument();
    f.commit();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    f.commit();
    await act(() => vi.advanceTimersByTimeAsync(4250));
    expect(read).toHaveBeenCalledTimes(4);
    expect(
      screen.getByText("Hidden conversations could not be refreshed."),
    ).toBeVisible();
    read.mockResolvedValue([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Retry hidden conversations" }),
    );
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledTimes(5);
    expect(
      screen.queryByRole("button", { name: "Retry hidden conversations" }),
    ).not.toBeInTheDocument();
  } finally {
    cleanup();
    lifecycle.dispose();
    random.mockRestore();
    vi.useRealTimers();
  }
});

it("keeps a roster failure quiet while recovery retries it, but not a denial while another read recovers", async () => {
  vi.useFakeTimers();
  const f = fixture();
  // Another background read (sidebar preferences) keeps recovery running.
  const recovery = createRecovery([
    { status: () => "failed", subscribe: () => () => {}, retry() {} },
  ]);
  const live = f.session.live;
  // A stable snapshot, as the session's live view keeps between changes.
  let view = {
    ...live.snapshot(),
    roster: { state: "error", transient: true } as {
      state: string;
      transient?: true;
    },
  };
  const liveListeners = new Set<() => void>();
  f.session.live = {
    ...live,
    snapshot: () => view,
    subscribe(listener) {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
  } as typeof live;
  const failed: ChannelList = {
    status: "error",
    error: "Channels could not be loaded.",
    channels: [],
  };
  f.session.recovery = recovery;
  f.session.channels = { ...f.session.channels, list: () => failed };
  try {
    render(f.view("alpha"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(recovery.snapshot()).toMatchObject({
      recovering: true,
      shown: false,
    });
    expect(
      screen.queryByText("Channels could not be loaded."),
    ).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(RECOVERY_NOTICE_DELAY_MS - 1));
    expect(
      screen.queryByText("Channels could not be loaded."),
    ).not.toBeInTheDocument();
    // A denial is not recovery's to retry: the channel and Solo inventories
    // each report it at once, though recovery still runs for the other read.
    view = { ...view, roster: { state: "error" } };
    act(() => {
      for (const listener of liveListeners) listener();
    });
    expect(recovery.snapshot()).toMatchObject({
      recovering: true,
      shown: false,
    });
    const alerts = screen.getAllByText("Channels could not be loaded.");
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) expect(alert).toHaveAttribute("role", "alert");
  } finally {
    cleanup();
    recovery.dispose();
    vi.useRealTimers();
  }
});

it("cancels visibility retries on sidebar unmount and session changes", async () => {
  vi.useFakeTimers();
  const { f, read, lifecycle } = visibilityFixture();
  try {
    const mounted = render(f.view("alpha"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledOnce();
    const next = fixture();
    mounted.rerender(next.view("beta"));
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(read).toHaveBeenCalledOnce();
    mounted.rerender(f.view("alpha"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(read).toHaveBeenCalledTimes(2);
    mounted.unmount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    lifecycle.dispose();
    vi.useRealTimers();
  }
});

it.each(["Retry", "Dismiss"] as const)(
  "%s restores mute recovery focus after cached-to-live session handoff without remounting",
  async (action) => {
    const data: SidebarPreferences = {
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    };
    let finish: (error?: Error) => void = () => {};
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<readonly string[]>((resolve, reject) => {
            finish = (error) => (error ? reject(error) : resolve(["alpha"]));
          }),
      )
      .mockResolvedValue(["alpha"]);
    const cached = createSidebarPreferencesStore({
      read: async () => data,
      available: true,
    });
    const live = createSidebarPreferencesStore({
      read: async () => data,
      available: true,
      writeMute: write,
    });
    const user = userEvent.setup();
    try {
      await cached.queries.ensure();
      await live.queries.ensure();
      const h = fixture(cached.queries);
      h.connection({ ...h.snapshot, status: "connecting", cached: true });
      render(h.view("alpha"));
      const row = await screen.findByRole("button", { name: "alpha" });
      h.connection({
        ...h.snapshot,
        status: "ready",
        session: { ...h.session, sidebarPreferences: live.queries },
      });
      expect(screen.getByRole("button", { name: "alpha" })).toBe(row);

      fireEvent.keyDown(row, { key: "ContextMenu" });
      await user.click(await screen.findByRole("menuitem", { name: "Mute" }));
      await waitFor(() =>
        expect(write).toHaveBeenCalledExactlyOnceWith(
          { channelId: "alpha", muted: true },
          expect.any(AbortSignal),
        ),
      );
      await act(async () => finish(new Error("offline")));
      const notice = await screen.findByRole("dialog", {
        name: "Couldn’t mute alpha",
      });
      expect(notice).toHaveTextContent("offline");
      if (action === "Retry") {
        fireEvent.keyDown(screen.getByRole("button", { name: "beta" }), {
          key: "ContextMenu",
        });
        await screen.findByRole("menuitem", { name: "Mute" });
      }
      await user.click(within(notice).getByRole("button", { name: action }));
      expect(row).toHaveFocus();
      if (action === "Retry") {
        await waitFor(() =>
          expect(live.queries.snapshot().data?.muted).toEqual(["alpha"]),
        );
        expect(write).toHaveBeenCalledTimes(2);
        expect(screen.queryByRole("menuitem", { name: "Mute" })).toBeNull();
      } else {
        expect(write).toHaveBeenCalledOnce();
      }
      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Couldn’t mute alpha" }),
        ).toBeNull(),
      );
    } finally {
      finish();
      cached.dispose();
      live.dispose();
    }
  },
);

it("uses relay section filters across navigation and remount, and offers only hidden channels", async () => {
  const user = userEvent.setup();
  let filters: Record<string, SidebarFilterMode> = {};
  const preferences = createSidebarPreferencesStore({
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
      filters,
    }),
    available: true,
    writeFilter: async (group, mode) => {
      filters = mode === "all" ? {} : { [group]: mode };
      return { filters, activeWindowSeconds: {} };
    },
  });
  const h = fixture(preferences.queries);
  const mounted = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  expect(screen.queryByRole("menuitem", { name: "View All" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  fireEvent.click(
    await screen.findByRole("menuitemradio", { name: "Unreads" }),
  );
  expect(screen.getByRole("button", { name: "alpha" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  const betaChoice = await screen.findByRole("menuitem", { name: "beta" });
  const choices = betaChoice.closest('[role="menu"]');
  assert(choices instanceof HTMLElement);
  expect(within(choices).queryByRole("menuitem", { name: "alpha" })).toBeNull();
  expect(
    within(choices).getByRole("menuitem", { name: "gamma" }),
  ).toBeVisible();
  fireEvent.click(betaChoice);
  expect(h.navigator.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "beta" }),
  );
  mounted.rerender(h.view("beta"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "beta" })).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
  mounted.rerender(h.view("not-in-this-section"));
  expect(screen.queryByText("0 matches")).toBeNull();
  expect(
    screen
      .getByLabelText("Channels", { selector: "summary" })
      .closest("details"),
  ).toHaveAttribute("open");
  expect(screen.queryByText("No channels match this filter.")).toBeNull();
  mounted.unmount();
  expect(filters).toEqual({ channels: "unreads" });
  expect(
    readView("https://relay.test:viewer", "channel-sidebar", {}),
  ).not.toHaveProperty("sectionFilters");
  const restored = render(h.view("gamma"));
  expect(await screen.findByRole("button", { name: "gamma" })).toBeVisible();
  expect(screen.queryByText("0 matches")).toBeNull();
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  restored.rerender(h.view("alpha"));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "alpha" })).toBeVisible(),
  );
  expect(screen.queryByRole("button", { name: "gamma" })).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "All" }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "beta" })).toBeVisible();
    expect(screen.getByRole("button", { name: "gamma" })).toBeVisible();
  });
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  expect(screen.queryByRole("menuitem", { name: "View All" })).toBeNull();
  restored.unmount();
  expect(
    readView("https://relay.test:viewer", "channel-sidebar", {}),
  ).not.toHaveProperty("sectionFilters");
  expect(filters).toEqual({});
  preferences.dispose();
});

it("ignores local and legacy filter state", async () => {
  writeView("https://relay.test:viewer", "channel-sidebar", {
    filter: "unreads",
    sectionFilters: { channels: "bogus", dms: null },
  });
  const h = fixture();
  render(h.view("alpha"));
  expect(await screen.findByRole("button", { name: "beta" })).toBeVisible();
  expect(screen.getByRole("button", { name: "gamma" })).toBeVisible();
});

it("preserves disabled contribution positions when active sections reorder", async () => {
  const makeSection = (id: string): RegisteredSidebarSection => {
    const rows = [{ id: `${id}-row`, label: `${id.toUpperCase()} item` }];
    return {
      version: 1,
      id,
      title: id.toUpperCase(),
      icon: "★",
      rows: { snapshot: () => rows, subscribe: () => () => {} },
      select: () => ({ version: 1, kind: "home" }),
      key: `example.plugin/${id}`,
      pluginId: "example.plugin",
      revision: "one",
    };
  };
  const [a, b, c] = ["a", "b", "c"].map(makeSection);
  assert(a && b && c);
  let active: readonly RegisteredSidebarSection[] = [a, c];
  const listeners = new Set<() => void>();
  const registry: SidebarSections = {
    version: 1,
    snapshot: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: () => {},
  };
  const h = fixture(undefined, "ready", [], registry);
  const scope = h.snapshot.scope;
  assert.exists(scope);
  // A raw key saved before canonical section keys keeps its position, and
  // another owner's section key keeps its slot.
  const solo = "solo-region:buzz.region:example:work";
  writeView(scope, "channel-sidebar", {
    collapsed: [],
    contributionOrder: [a.key, solo, `plugin:${b.key}`, c.key],
    scrollTop: 0,
  });
  const visibleOrder = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-sidebar-section^="plugin:example.plugin/"]',
      ),
    ].map((section) => section.dataset.sidebarSection);
  const user = userEvent.setup();

  render(h.view("alpha"));
  await waitFor(() =>
    expect(visibleOrder()).toEqual([
      "plugin:example.plugin/a",
      "plugin:example.plugin/c",
    ]),
  );
  await user.click(screen.getByRole("button", { name: "More actions for C" }));
  await user.click(await screen.findByRole("menuitem", { name: "Move up" }));

  expect(readView(scope, "channel-sidebar", {})).toMatchObject({
    contributionOrder: [
      `plugin:${c.key}`,
      solo,
      `plugin:${b.key}`,
      `plugin:${a.key}`,
    ],
  });
  act(() => {
    active = [a, b, c];
    for (const listener of listeners) listener();
  });
  await waitFor(() =>
    expect(visibleOrder()).toEqual([
      "plugin:example.plugin/c",
      "plugin:example.plugin/b",
      "plugin:example.plugin/a",
    ]),
  );
});

it("retries a contributed section after invalid rows recover", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    let rows: readonly SidebarSectionRow[] = [{ id: "queue", label: "" }];
    const section = (
      id: string,
      title: string,
      snapshot: () => readonly SidebarSectionRow[],
    ): RegisteredSidebarSection => ({
      version: 1,
      id,
      title,
      icon: "★",
      rows: { snapshot, subscribe: () => () => {} },
      select: () => ({ version: 1, kind: "home" }),
      key: `example.plugin/${id}`,
      pluginId: "example.plugin",
      revision: "one",
    });
    const sibling = [{ id: "review", label: "Review item" }];
    const sections = [
      section("work", "Workspace", () => rows),
      section("review", "Review", () => sibling),
    ];
    const registry: SidebarSections = {
      version: 1,
      snapshot: () => sections,
      subscribe: () => () => {},
      register: () => {},
    };
    const h = fixture(undefined, "ready", [], registry);
    const work = () => {
      const element = document.querySelector<HTMLElement>(
        '[data-sidebar-section="plugin:example.plugin/work"]',
      );
      if (!element) throw new Error("The Workspace section is not mounted");
      return element;
    };
    const user = userEvent.setup();
    render(h.view("alpha"));

    expect(
      await screen.findByText(/Workspace is unavailable/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review item" }));
    expect(h.navigator.open).toHaveBeenCalledWith({ version: 1, kind: "home" });

    // Retrying unchanged invalid rows keeps the recovery control in reach.
    const retry = within(work()).getByRole("button", { name: "Retry" });
    await user.click(retry);
    expect(within(work()).getByRole("alert")).toHaveTextContent(
      "Workspace is unavailable.",
    );
    expect(within(work()).getByRole("button", { name: "Retry" })).toHaveFocus();

    // A later valid snapshot is not observed by the failed section until Retry.
    rows = [{ id: "queue", label: "Queue" }];
    expect(screen.queryByRole("button", { name: "Queue" })).toBeNull();
    await user.click(within(work()).getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Queue" }),
    ).toBeInTheDocument();
    expect(within(work()).queryByRole("alert")).toBeNull();
    expect(work().querySelector("summary")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Review item" })).toBeVisible();
  } finally {
    consoleError.mockRestore();
  }
});

it("does not rebuild unchanged rows on channel switches", async () => {
  const h = fixture();
  const mounted = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  rowRender.mockClear();
  menuRender.mockClear();
  mounted.rerender(h.view("beta"));
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).not.toContain(
    "gamma",
  );
  // Unchanged rows keep their menu provider and popup behind the memo too.
  expect(
    menuRender.mock.calls.filter(([, props]) =>
      String(props["aria-label"] ?? "").includes("gamma"),
    ),
  ).toEqual([]);
  expect(
    menuRender.mock.calls.filter(([kind]) => kind === "root"),
  ).toHaveLength(rowRender.mock.calls.length);
  expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.getByRole("button", { name: "alpha" })).not.toHaveAttribute(
    "aria-current",
  );
  // Ordinary selection still uses the current session and navigator.
  fireEvent.click(screen.getByRole("button", { name: "gamma" }));
  expect(h.navigator.open).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
  );
});

it("rebuilds only the changed row on a list publish", async () => {
  const h = fixture();
  render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  rowRender.mockClear();
  h.publish("beta", { preview: "hello" });
  expect(rowRender.mock.calls.map(([props]) => props.channel.id)).toEqual([
    "beta",
  ]);
});

it("closes a removed DM's menu and focuses its neighbor before the exit ends", async () => {
  const h = fixture(undefined, "ready", [
    { id: "alice", name: "Alice", channelType: "dm" },
    { id: "bob", name: "Bob", channelType: "dm" },
  ]);
  render(h.view("alice"));
  const alice = await screen.findByRole("button", { name: "Alice" });
  const bob = screen.getByRole("button", { name: "Bob" });
  fireEvent.keyDown(alice, { key: "ContextMenu" });
  await screen.findByRole("menu", { name: "Actions for Alice" });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove from Team" }));
  // Assert synchronously while the retained row's exit is still mounted.
  expect(alice.closest("[inert]")).not.toBeNull();
  expect(screen.queryByRole("menu", { name: "Actions for Alice" })).toBeNull();
  await act(async () => {});
  expect(alice).toBeInTheDocument();
  expect(bob).toHaveFocus();
});

it("copies a channel link that opens the same channel", async () => {
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("denied"));
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const h = fixture();
  render(h.view("alpha"));
  const copy = async () => {
    fireEvent.keyDown(await screen.findByRole("button", { name: "beta" }), {
      key: "ContextMenu",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
  };
  await copy();
  expect(await screen.findByText("Link copied.")).toBeInTheDocument();
  const [link] = writeText.mock.calls[0] ?? [];
  expect(link).toBe("buzz://channel/beta");
  expect(
    buzzLinkTarget(link, {
      viewer: "a".repeat(64),
      communityOrigin: "https://relay.test",
    }),
  ).toMatchObject({ kind: "conversation", channelId: "beta" });
  await copy();
  expect(
    await screen.findByText("Couldn’t copy the link."),
  ).toBeInTheDocument();
});

it("offers DMs a Move conversation menu and relocates them into a saved group", async () => {
  const saved: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: {},
    starred: [],
    muted: [],
  };
  let assignments: Record<string, string> = {};
  const read = vi.fn(async () => ({ ...saved, assignments }));
  const write = vi.fn(
    async (intent: { channelId?: string; sectionId?: string }) => {
      if (intent.channelId === undefined)
        throw new Error("Expected channel move");
      const changedAssignments = intent.sectionId
        ? { ...assignments, [intent.channelId]: intent.sectionId }
        : Object.fromEntries(
            Object.entries(assignments).filter(
              ([id]) => id !== intent.channelId,
            ),
          );
      assignments = changedAssignments;
      return { sections: saved.sections, assignments };
    },
  );
  const star = vi.fn(async () => []);
  const preferences = createSidebarPreferencesStore({
    read,
    available: true,
    write,
    writeStar: star,
  });
  await preferences.queries.ensure();
  const h = fixture(preferences.queries, "ready", [
    { id: "alpha", name: "alpha", channelType: "stream" },
    { id: "dm", name: "Alice", channelType: "dm" },
  ]);
  const user = userEvent.setup();
  try {
    render(h.view("alpha"));
    await screen.findByRole("button", { name: "Alice" });
    const row = screen.getByRole("button", { name: "Alice" });
    fireEvent.keyDown(row, { key: "ContextMenu" });
    await user.hover(
      await screen.findByRole("menuitem", { name: "Move conversation" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Direct messages" }),
    ).toBeChecked();
    await screen.findByRole("menuitemradio", { name: "Work" });
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
    await waitFor(() =>
      expect(write).toHaveBeenCalledWith(
        { channelId: "dm", sectionId: "work" },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-sidebar-section="group:work"]'),
      ).toContainElement(screen.getByRole("button", { name: "Alice" }));
      expect(
        document.querySelector('[data-sidebar-section="dms"]'),
      ).not.toContainElement(screen.queryByRole("button", { name: "Alice" }));
    });
    fireEvent.keyDown(screen.getByRole("button", { name: "Alice" }), {
      key: "ContextMenu",
    });
    await user.hover(
      await screen.findByRole("menuitem", { name: "Move conversation" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Work" }),
    ).toBeChecked();
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Direct messages" }),
    );
    await waitFor(() => {
      expect(
        document.querySelector('[data-sidebar-section="dms"]'),
      ).toContainElement(screen.getByRole("button", { name: "Alice" }));
      expect(
        document.querySelector('[data-sidebar-section="group:work"]'),
      ).not.toContainElement(screen.queryByRole("button", { name: "Alice" }));
    });
    expect(write).toHaveBeenLastCalledWith(
      { channelId: "dm" },
      expect.any(AbortSignal),
    );
    expect(star).toHaveBeenLastCalledWith(
      { channelId: "dm", starred: false },
      expect.any(AbortSignal),
    );
  } finally {
    preferences.dispose();
  }
});

async function failedMoveFixture() {
  const data: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
  };
  const read = vi.fn(async () => data);
  const write = vi.fn(async () => {
    throw new Error("offline");
  });
  const star = vi.fn(async () => []);
  const owner = createSidebarPreferencesStore({
    read,
    available: true,
    write,
    writeStar: star,
  });
  const prefs = owner.queries;
  await prefs.ensure();
  await expect(prefs.assign("beta")).rejects.toThrow("offline");
  const h = fixture(prefs);
  const mounted = render(h.view("alpha"));
  const notice = await screen.findByRole("alert");
  expect(notice).toHaveTextContent("Couldn’t save the move for beta. offline");
  return { ...h, owner, prefs, read, write, star, data, notice, mounted };
}

it("explains and disables unavailable move retries, then enables them after preference recovery", async () => {
  const h = await failedMoveFixture();
  try {
    h.read.mockRejectedValueOnce(new Error("refresh failed"));
    await act(() => h.prefs.refresh());
    const retry = within(h.notice).getByRole("button", { name: "Retry move" });
    expect(retry).toBeDisabled();
    expect(h.notice).toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
    // Direct/stale callers also publish their rejection, not just a rejected promise.
    await act(async () => {
      await expect(h.prefs.retryMove("beta")).rejects.toThrow(
        "refresh saved sidebar preferences before retrying",
      );
    });
    expect(h.notice).not.toHaveTextContent("offline");
    expect(h.notice).toHaveTextContent("Sidebar group moves are unavailable");
    expect(h.write).toHaveBeenCalledOnce();
    expect(h.star).not.toHaveBeenCalled();
    await act(() => h.prefs.refresh());
    expect(retry).toBeEnabled();
    expect(h.notice).not.toHaveTextContent(
      "Refresh saved sidebar preferences before retrying this move.",
    );
  } finally {
    h.owner.dispose();
  }
});

it.each(["ready", "error"] as const)(
  "keeps the supplied page navigation while the relay is %s",
  (status) => {
    const h = fixture(undefined, status);
    render(h.view("alpha"));
    const pages = screen.getByRole("navigation", { name: "Pages" });
    expect(
      within(pages).getByRole("button", { name: "Projects" }),
    ).toBeVisible();
    expect(pages.closest(`.${styles.destinations}`)).not.toBeNull();
  },
);

it.each(["Laptop", "Channels", "Starred"])(
  "uses only the invoking section for placement (%s)",
  async (section) => {
    const fromGroup = section === "Laptop";
    const fromStarred = section === "Starred";
    const preferences = createSidebarPreferencesStore({
      read: async () => ({
        sections: [{ id: "laptop", name: "Laptop", icon: "💻", order: 0 }],
        assignments: { beta: "laptop" },
        starred: ["alpha"],
        muted: [],
      }),
      available: true,
      write: async () => ({
        sections: [{ id: "laptop", name: "Laptop", icon: "💻", order: 0 }],
        assignments: {},
      }),
      writeStar: async () => [],
    });
    await preferences.queries.ensure();
    const h = fixture(preferences.queries);
    const create = vi.fn(async () => "new-channel");
    h.session.channelKit = {
      ...h.session.channelKit,
      available: true,
      ensure() {},
    };
    h.session.channelCreation = {
      ...h.session.channelCreation,
      available: true,
      create,
    };
    try {
      render(h.view("beta"));
      await screen.findByRole("button", { name: /Laptop/ });
      // An active grouped channel must not make the general Channels + inherit it.
      const header = screen.getByRole("button", {
        name: `More actions for ${section}`,
      }).parentElement;
      assert.exists(header);
      if (section === "Starred") {
        const icon = screen
          .getByLabelText("Starred")
          .querySelector("[data-sidebar-group-icon]");
        const emoji = screen
          .getByLabelText("Laptop")
          .querySelector("[data-sidebar-group-icon]");
        assert.exists(icon);
        assert.exists(emoji);
        expect(icon).toHaveAttribute("class", emoji.className);
        expect(icon).toHaveAttribute("aria-hidden", "true");
        expect(icon.querySelector("svg")).toBeInTheDocument();
        expect(icon).not.toHaveTextContent("★");
      }
      fireEvent.click(
        within(header).getByRole("button", { name: "Create channel" }),
      );
      expect(
        screen.queryByRole("combobox", { name: "Destination group" }),
      ).not.toBeInTheDocument();
      const title = fromGroup
        ? "Create a channel in Laptop"
        : fromStarred
          ? "Create a channel in Starred"
          : "Create a channel";
      expect(screen.getByRole("dialog")).toHaveAccessibleName(title);
      if (fromGroup)
        expect(
          screen
            .getByRole("dialog")
            .querySelector(".buzz-dialog-step [data-sidebar-group-icon]"),
        ).toHaveTextContent("💻");
      fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
        target: { value: "New laptop channel" },
      });
      fireEvent.click(
        within(screen.getByRole("dialog", { name: title })).getByRole(
          "button",
          {
            name: "Create channel",
          },
        ),
      );
      await waitFor(() =>
        expect(create).toHaveBeenCalledWith({
          name: "New laptop channel",
          visibility: "open",
          ...(fromGroup || fromStarred
            ? {
                setup: {
                  agents: [],
                  canvas: "",
                  templateId: "",
                  groupId: fromGroup ? "laptop" : "",
                  ...(fromStarred ? { starred: true } : {}),
                },
              }
            : {}),
        }),
      );
    } finally {
      preferences.dispose();
    }
  },
);

it("keeps Huddle rooms out of the sidebar before and after metadata arrives", async () => {
  const h = fixture();
  const relay = keypair(),
    viewer = keypair();
  const room = "11111111-1111-4111-8111-111111111111";
  const parent = "22222222-2222-4222-8222-222222222222";
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  discovery.accept(roster(relay, room, [viewer.pubkey]));
  discovery.accept(roster(relay, "legacy", [viewer.pubkey]));
  discovery.accept(metadata(relay, "legacy", "Legacy channel"));
  let list: ChannelList = {
    ...h.list,
    channels: [
      ...h.list.channels,
      ...discovery
        .channels()
        .map((channel) =>
          channel.id === room ? { ...channel, metadataPending: true } : channel,
        ),
      {
        id: "private",
        name: "Private project",
        channelType: "stream",
        visibility: "private",
      },
    ],
  };
  h.session.channels.list = () => list;
  const mounted = render(h.view("alpha"));
  expect(
    await screen.findByRole("button", { name: "Private project" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: room.slice(0, 8) })).toBeNull();
  discovery.accept(
    metadata(relay, room, "Call room", 30, [
      ["private"],
      ["about", huddleDescription(parent)],
      ["P", viewer.pubkey],
    ]),
  );
  discovery.accept(
    signed(viewer, {
      kind: 9007,
      created_at: 10,
      content: "",
      tags: [
        ["h", room],
        ["visibility", "private"],
        ["channel_type", "stream"],
        ["about", huddleDescription(parent)],
      ],
    }),
  );
  list = {
    ...list,
    channels: [
      ...list.channels.filter((c) => c.id !== room && c.id !== "legacy"),
      ...discovery.channels(),
    ],
  };
  mounted.rerender(h.view("alpha"));
  expect(screen.getByRole("button", { name: "alpha" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Legacy channel" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Private project" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Call room" })).toBeNull();
});

it("hides generated legacy rooms while keeping ordinary expiring channels visible", async () => {
  const h = fixture();
  const relay = keypair(),
    viewer = keypair();
  const discovery = new DiscoveryState(viewer.pubkey, relay.pubkey);
  const legacy = "33333333-3333-4333-8333-333333333333";
  const cases = [
    {
      id: "trial",
      name: "Huddle",
      tags: [["private"], ["ttl", "3600"]],
      hidden: false,
    },
    {
      id: legacy,
      name: `huddle-${legacy.slice(0, 8)}`,
      tags: [["private"], ["ttl", "60"]],
      hidden: true,
    },
    { id: "ordinary", name: "Huddle", tags: [["private"]], hidden: false },
    {
      id: "expiring",
      name: "Private project",
      tags: [["private"], ["ttl", "3600"]],
      hidden: false,
    },
    {
      id: "public",
      name: "Huddle",
      tags: [["public"], ["ttl", "3600"]],
      hidden: false,
    },
    {
      id: "invalid",
      name: "Huddle",
      tags: [["private"], ["ttl", "broken"]],
      hidden: false,
    },
  ];
  for (const item of cases) {
    discovery.accept(roster(relay, item.id, [viewer.pubkey]));
    discovery.accept(
      metadata(relay, item.id, item.name, 30, [["t", "stream"], ...item.tags]),
    );
    expect(discovery.get(item.id)?.huddle === true).toBe(item.hidden);
    // Presentation classification neither removes membership nor invents parent access.
    expect(discovery.authorized(item.id)).toBe(true);
    expect(discovery.get(item.id)?.parentChannelId).toBeUndefined();
  }
  const list = {
    ...h.list,
    channels: [...h.list.channels, ...discovery.channels()],
  };
  h.session.channels.list = () => list;
  render(h.view("alpha"));
  expect(
    await screen.findByRole("button", {
      name: "Private projectTemporary channel. Cleans up after 1 hour without activity.",
    }),
  ).toBeVisible();
  expect(
    screen.getAllByRole("button", {
      name: /^Huddle(?:Temporary channel\. Cleans up after 1 hour without activity\.)?$/,
    }),
  ).toHaveLength(4);
  expect(screen.queryByRole("button", { name: /^huddle-33333333/ })).toBeNull();
});

it("rejects a deferred header Create section after its navigation origin retires", async () => {
  const preferences = createSidebarPreferencesStore({
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
    }),
    available: true,
    write: vi.fn(async () => ({ sections: [], assignments: {} })),
    writeStar: vi.fn(async () => []),
  });
  await preferences.queries.ensure();
  const h = fixture(preferences.queries);
  const origin = new AbortController();
  const user = userEvent.setup();
  render(
    h.view(
      "alpha",
      <ChannelHeaderMenu
        channel={h.list.channels[0]}
        session={h.session}
        origin={origin.signal}
        trigger={createRef<HTMLButtonElement>()}
        openDetails={() => {}}
      />,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Channel actions" }));
  await user.hover(
    await screen.findByRole("menuitem", { name: "Move channel" }),
  );
  const create = await screen.findByRole("menuitem", { name: "Create new…" });
  // Hold only the deferred handoff after the menu is ready, not a timing delay.
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  fireEvent.click(create);
  expect(frames.length).toBeGreaterThan(0);
  act(() => {
    origin.abort();
    for (const frame of frames.splice(0)) frame(0);
  });
  expect(
    screen.queryByRole("dialog", { name: "Move to new section" }),
  ).not.toBeInTheDocument();
  expect(preferences.queries.snapshot().data?.sections).toEqual([]);
  preferences.dispose();
});

it("gates all creation entry points while uncertain creation reconciles, preserving ordinary moves", async () => {
  const data = { sections: [], assignments: {}, starred: [], muted: [] };
  let finish!: (value: SidebarPreferences) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = new Promise<SidebarPreferences>((resolve) => {
    finish = resolve;
  });
  const preferences = createSidebarPreferencesStore({
    read: async () => data,
    readAfterWrite: () => {
      entered();
      return read;
    },
    available: true,
    write: vi.fn().mockRejectedValue(new Error("response lost")),
    writeStar: vi.fn(async () => []),
  });
  await preferences.queries.ensure();
  const creating = expect(
    preferences.queries.createSection({ id: "saved", name: "Saved" }),
  ).rejects.toThrow("response lost");
  try {
    await started;
    const h = fixture(preferences.queries);
    const user = userEvent.setup();
    render(h.view("alpha"));
    const row = await screen.findByRole("button", { name: "beta" });
    expect(document.querySelector("[data-create-section-trigger]")).toBeNull();
    fireEvent.keyDown(row, { key: "ContextMenu" });
    await user.hover(
      await screen.findByRole("menuitem", { name: "Move channel" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Create new…" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitemradio", { name: "Starred" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await act(async () => {
      finish(data);
      await creating;
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-create-section-trigger]"),
      ).not.toBeNull(),
    );
  } finally {
    finish(data);
    await creating;
    preferences.dispose();
  }
});

it("clears only the removed section's collapsed intent after confirmation, never on cancel or failure", async () => {
  const user = userEvent.setup();
  const current: SidebarPreferences = {
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
  };
  let resolve!: (value: SidebarGroups) => void;
  const pending = new Promise<SidebarGroups>((yes) => {
    resolve = yes;
  });
  const remove = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockReturnValueOnce(pending);
  const preferences = createSidebarPreferencesStore({
    read: async () => current,
    available: true,
    write: async () => current,
    writeStar: async () => [],
    writeSort: async () => ({}),
    removeSection: remove,
  });
  try {
    await preferences.queries.ensure();
    const h = fixture(preferences.queries);
    const scope = h.snapshot.scope;
    assert.exists(scope);
    writeView(scope, "channel-sidebar", {
      collapsed: ["group:work", "dms"],
      scrollTop: 0,
      width: 287,
    });
    const mounted = render(h.view("alpha"));
    const open = async () => {
      await user.click(
        await screen.findByRole("button", { name: "More actions for Work" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Remove section" }),
      );
      return screen.getByRole("dialog", { name: "Remove Work?" });
    };
    let dialog = await open();
    expect(dialog).toHaveAccessibleDescription(
      "1 channel will move back to Channels. This does not delete any channels.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Work").closest("details"),
    ).not.toHaveAttribute("open");
    dialog = await open();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "offline",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    mounted.unmount();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["group:work", "dms"],
      width: 287,
    });
    const retry = render(h.view("alpha"));
    dialog = await open();
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(dialog).toBeVisible();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["group:work", "dms"],
    });
    await act(async () => {
      resolve({ sections: [], assignments: {} });
      await pending;
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    retry.unmount();
    expect(readView(scope, "channel-sidebar", {})).toMatchObject({
      collapsed: ["dms"],
      width: 287,
    });
  } finally {
    resolve?.({ sections: [], assignments: {} });
    preferences.dispose();
  }
});
it("restores lifecycle focus to the active row while an inert copy is exiting", async () => {
  const h = fixture();
  const channel = h.list.channels[1];
  assert(channel);
  h.session.channelLifecycle = {
    ...h.session.channelLifecycle,
    available: true,
  };
  function Start() {
    const navigation = useChannelNavigation();
    return (
      <button
        type="button"
        onClick={() => {
          assert(channel);
          navigation?.openLifecycle(channel, "archive");
        }}
      >
        Start action
      </button>
    );
  }
  render(h.view("beta", <Start />));
  const active = await screen.findByRole("button", { name: "beta" });
  const leaving = active.cloneNode(true) as HTMLButtonElement;
  const retired = document.createElement("div");
  retired.setAttribute("inert", "");
  retired.append(leaving);
  active.before(retired);
  // Both copies have layout during popLayout exit; geometry alone is insufficient.
  const rects = [active.getBoundingClientRect()] as unknown as DOMRectList;
  vi.spyOn(active, "getClientRects").mockReturnValue(rects);
  vi.spyOn(leaving, "getClientRects").mockReturnValue(rects);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Start action" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Archive channel: beta",
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(active).toHaveFocus());
  expect(leaving).not.toHaveFocus();
});

it.each(["archive", "unarchive", "delete"] as const)(
  "%s completion preserves focus moved during pending work and retains required navigation",
  async (action) => {
    const h = fixture();
    const channel = h.list.channels[1];
    assert(channel);
    const origin = new AbortController();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const run = vi.fn(
      (_action: unknown, _id: string, _signal?: AbortSignal) => pending,
    );
    h.session.channelLifecycle = {
      ...h.session.channelLifecycle,
      available: true,
      run,
    };
    function StartAction() {
      const navigation = useChannelNavigation();
      return (
        <button
          type="button"
          onClick={(event) => {
            assert(channel);
            navigation?.openLifecycle(
              channel,
              action,
              event.currentTarget,
              origin.signal,
            );
          }}
        >
          Start action
        </button>
      );
    }
    render(
      h.view(
        "beta",
        <>
          <StartAction />
          <button type="button">Other control</button>
        </>,
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Start action" }));
    await user.click(
      await screen.findByRole("button", {
        name:
          action === "delete"
            ? "Delete channel"
            : action === "archive"
              ? "Archive channel"
              : "Unarchive channel",
      }),
    );
    try {
      await screen.findByRole("dialog", {
        name:
          action === "delete"
            ? "Deleting channel…"
            : action === "archive"
              ? "Archiving channel…"
              : "Unarchiving channel…",
      });
      act(() => origin.abort());
      expect(run.mock.calls[0]?.[2]?.aborted).toBe(false);
      await user.click(screen.getByRole("button", { name: "Other control" }));
      expect(
        screen.getByRole("button", { name: "Other control" }),
      ).toHaveFocus();
    } finally {
      await act(async () => finish());
    }
    await screen.findByRole("dialog", {
      name:
        action === "delete"
          ? "Channel deleted: beta"
          : action === "archive"
            ? "Channel archived: beta"
            : "Channel unarchived: beta",
    });
    expect(screen.getByRole("button", { name: "Other control" })).toHaveFocus();
    if (action === "delete")
      expect(h.navigator.open).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
      );
    else expect(h.navigator.open).not.toHaveBeenCalled();
  },
);

function pendingLifecycle(
  action: "archive" | "delete" | "leave" | "hide",
  preferences?: Parameters<typeof fixture>[0],
  sidebarRows?: SidebarRows,
  unreadChannelId?: string,
) {
  const h = fixture(preferences, "ready", undefined, undefined, sidebarRows);
  if (unreadChannelId) {
    const unread = h.session.unread;
    const target = { kind: "channel" as const, channelId: unreadChannelId };
    const snapshot = {
      ...unread.snapshot(target),
      manual: "local-only" as const,
    };
    h.session.unread = {
      ...unread,
      snapshot: (target) =>
        target.kind === "channel" && target.channelId === unreadChannelId
          ? snapshot
          : unread.snapshot(target),
    };
  }
  const channel = h.list.channels[1];
  assert(channel);
  let finish!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  const run = vi.fn(
    (_action: unknown, _id: string, _signal?: AbortSignal) => pending,
  );
  h.session.channelLifecycle = {
    ...h.session.channelLifecycle,
    available: true,
    run,
  };
  function Start() {
    const navigation = useChannelNavigation();
    return (
      <button
        type="button"
        onClick={() => {
          assert(channel);
          navigation?.openLifecycle(channel, action);
        }}
      >
        Start action
      </button>
    );
  }
  const view = (target = "beta", visible = true) =>
    h.view(target, <Start />, visible);
  const mounted = render(view());
  return {
    ...h,
    run,
    finish,
    reject,
    mounted,
    view,
    async start() {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Start action" }));
      await user.click(
        screen.getByRole("button", {
          name: {
            archive: "Archive channel",
            delete: "Delete channel",
            leave: "Leave channel",
            hide: "Hide conversation",
          }[action],
        }),
      );
      await waitFor(() => expect(run).toHaveBeenCalledOnce());
    },
  };
}

it.each(["archive", "delete"] as const)(
  "submitted %s survives sidebar swaps without reopening confirmation",
  async (action) => {
    const h = pendingLifecycle(action);
    await h.start();
    try {
      h.mounted.rerender(h.view("beta", false));
      expect(h.run.mock.calls[0]?.[2]?.aborted).toBe(false);
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
      expect(
        screen.getByRole("dialog", {
          name:
            action === "archive" ? "Archiving channel…" : "Deleting channel…",
        }),
      ).toBeVisible();
    } finally {
      await act(async () => h.finish());
    }
    await screen.findByRole("dialog", {
      name:
        action === "archive"
          ? "Channel archived: beta"
          : "Channel deleted: beta",
    });
    h.mounted.rerender(h.view("alpha"));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(h.navigator.open).not.toHaveBeenCalled();
  },
);

it.each(["delete", "leave", "hide"] as const)(
  "pending %s does not redirect a newer conversation",
  async (action) => {
    const h = pendingLifecycle(action);
    await h.start();
    try {
      h.mounted.rerender(h.view("gamma"));
    } finally {
      await act(async () => h.finish());
    }
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull(),
    );
    expect(h.navigator.open).not.toHaveBeenCalled();
  },
);

it("a failed lifecycle action releases its gate while keeping recovery visible", async () => {
  const h = pendingLifecycle("delete");
  await h.start();
  await act(async () =>
    h.reject(new Error("Refresh channels before trying again.")),
  );
  await screen.findByRole("dialog", { name: "Delete channel failed" });
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Start action" }));
  expect(screen.getByRole("dialog", { name: "Delete beta?" })).toBeVisible();
  expect(
    screen.getByText("Refresh channels before trying again."),
  ).toBeVisible();
  expect(h.run).toHaveBeenCalledOnce();
});

// Opening the sidebar's first row would scroll a long sidebar away from where
// the channel was; its neighbor is already in view.
it.each([
  {
    name: "host neighbor",
    before: [],
    after: [],
    reveal: false,
    replacement: false,
    next: "gamma",
  },
  {
    name: "hidden neighbor",
    before: ["gamma"],
    after: [],
    reveal: false,
    replacement: false,
    next: "alpha",
  },
  {
    name: "neighbor hidden while pending",
    before: [],
    after: ["gamma"],
    reveal: false,
    replacement: false,
    next: "alpha",
  },
  {
    name: "newly visible neighbor",
    before: ["gamma"],
    after: ["alpha"],
    reveal: true,
    replacement: false,
    next: "gamma",
  },
  {
    name: "no visible neighbor",
    before: ["gamma"],
    after: ["alpha"],
    reveal: false,
    replacement: false,
    next: undefined,
  },
  {
    name: "visible replacement",
    before: [],
    after: [],
    reveal: false,
    replacement: true,
    next: "gamma",
  },
])(
  "deleting the open channel uses its $name after the roster drops it",
  async ({ before, after, reveal, replacement, next }) => {
    const registry = rowRegistry({
      version: 1,
      id: "visibility",
      render: (row, Default) =>
        row.label.startsWith("hidden ") ? null : replacement &&
          row.id === "gamma" ? (
          <button type="button">Replacement gamma</button>
        ) : (
          Default
        ),
    });
    const h = pendingLifecycle("delete", undefined, registry);
    try {
      for (const id of before) h.publish(id, { name: `hidden ${id}` });
      await h.start();
      h.drop("beta");
      for (const id of after) h.publish(id, { name: `hidden ${id}` });
      if (reveal) h.publish("gamma", { name: "gamma" });
      for (const id of [...before, ...after]) {
        expect(
          screen.queryByRole("button", { name: `hidden ${id}` }),
        ).toBeNull();
      }
    } finally {
      await act(async () => h.finish());
    }
    await waitFor(() =>
      expect(h.navigator.open).toHaveBeenCalledWith(
        expect.objectContaining(
          next
            ? { kind: "conversation", channelId: next }
            : {
                kind: "page",
                pageId: "channels",
                route: { version: 1, params: "empty" },
              },
        ),
      ),
    );
    expect(h.navigator.open).toHaveBeenCalledOnce();
  },
);

it.each(
  (["delete", "leave"] as const).flatMap((action) =>
    [false, true].map((hideUnread) => ({ action, hideUnread })),
  ),
)(
  "pending $action recovers within the Unreads roster (hide remaining unread: $hideUnread)",
  async ({ action, hideUnread }) => {
    const registry = rowRegistry({
      version: 1,
      id: "visibility",
      render: (row, Default) =>
        row.id === "gamma" || row.label.startsWith("hidden ") ? null : Default,
    });
    const preferences = createSidebarPreferencesStore({
      available: true,
      read: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        filters: { channels: "unreads" },
      }),
    });
    await preferences.queries.ensure();
    const h = pendingLifecycle(action, preferences.queries, registry, "alpha");
    try {
      const alpha = await screen.findByRole("button", { name: /^alpha/ });
      expect(alpha).toBeVisible();
      expect(
        within(alpha).getByRole("img", {
          name: "Marked unread on this device only",
        }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "beta" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "gamma" })).toBeNull();
      await h.start();
      h.drop("beta");
      if (hideUnread) h.publish("alpha", { name: "hidden alpha" });
    } finally {
      await act(async () => h.finish());
      preferences.dispose();
    }
    await waitFor(() =>
      expect(h.navigator.open).toHaveBeenCalledWith(
        expect.objectContaining(
          hideUnread
            ? {
                kind: "page",
                pageId: "channels",
                route: { version: 1, params: "empty" },
              }
            : { kind: "conversation", channelId: "alpha" },
        ),
      ),
    );
    expect(h.navigator.open).toHaveBeenCalledOnce();
  },
);

it("deleting a custom-sorted channel opens its displayed neighbor after the roster drops it", async () => {
  const registry = rowRegistry({
    version: 1,
    id: "order",
    sortModes: [
      {
        id: "reverse",
        label: "Reverse name",
        compare: (a, b) => b.label.localeCompare(a.label),
      },
    ],
  });
  const preferences = createSidebarPreferencesStore({
    available: true,
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
      sort: { channels: "plugin:fixture0/order/reverse" },
    }),
  });
  await preferences.queries.ensure();
  const h = pendingLifecycle("delete", preferences.queries, registry);
  try {
    await h.start();
    expect(
      [...document.querySelectorAll("[data-channel-id]")].map((row) =>
        row.getAttribute("data-channel-id"),
      ),
    ).toEqual(["gamma", "beta", "alpha"]);
    h.drop("beta");
  } finally {
    await act(async () => h.finish());
    preferences.dispose();
  }
  await waitFor(() =>
    expect(h.navigator.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "conversation", channelId: "alpha" }),
    ),
  );
  expect(h.navigator.open).toHaveBeenCalledOnce();
});

it("deleting the only row in its section opens the nearest row below it", async () => {
  const preferences = createSidebarPreferencesStore({
    read: async () => ({
      sections: [{ id: "laptop", name: "Laptop", order: 0 }],
      assignments: { beta: "laptop" },
      starred: ["alpha"],
      muted: [],
    }),
    available: true,
    write: async () => ({ sections: [], assignments: {} }),
    writeStar: async () => [],
  });
  await preferences.queries.ensure();
  // Starred: alpha; Laptop: beta; Channels: gamma.
  const h = pendingLifecycle("delete", preferences.queries);
  await h.start();
  await act(async () => h.finish());
  await waitFor(() =>
    expect(h.navigator.open).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "conversation", channelId: "gamma" }),
    ),
  );
});

it("session teardown still aborts submitted lifecycle work", async () => {
  const h = pendingLifecycle("delete");
  await h.start();
  h.mounted.unmount();
  expect(h.run.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => h.finish());
  expect(h.navigator.open).not.toHaveBeenCalled();
});

it("a replacement relay session cancels the previous submitted action", async () => {
  const h = pendingLifecycle("delete");
  await h.start();
  const replacement = fixture();
  h.mounted.rerender(replacement.view("alpha"));
  expect(h.run.mock.calls[0]?.[2]?.aborted).toBe(true);
  await act(async () => h.finish());
  expect(h.navigator.open).not.toHaveBeenCalled();
  expect(replacement.navigator.open).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("a sidebar remount does not resubmit or redirect pending work", async () => {
  const h = pendingLifecycle("delete");
  await h.start();
  try {
    h.mounted.rerender(h.view("beta", false));
    h.mounted.rerender(h.view("gamma"));
    expect(h.run.mock.calls[0]?.[2]?.aborted).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  } finally {
    await act(async () => h.finish());
  }
  await screen.findByRole("dialog", { name: "Channel deleted: beta" });
  expect(h.run).toHaveBeenCalledOnce();
  expect(h.navigator.open).not.toHaveBeenCalled();
});

// The actual mounted caller owns the Solo/Team visibility boundary.
it("keeps owned and unfiled shared Solo chats out of Team without removing access", async () => {
  const h = fixture();
  h.publish("beta", {
    channelType: "solo",
    private: true,
    creator: "a".repeat(64),
  });
  render(h.view("alpha", undefined, true));
  await userEvent.click(screen.getByRole("tab", { name: "Team" }));
  await screen.findByRole("button", { name: "gamma" });
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  h.publish("beta", { creator: "b".repeat(64) });
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  expect(
    h.session.channels.list().channels.find((channel) => channel.id === "beta"),
  ).toMatchObject({ channelType: "solo", creator: "b".repeat(64) });
  expect(h.navigator.open).not.toHaveBeenCalled();
});

it("moves a saved group from its menu, rolls back a failed save, and retries it", async () => {
  const data: SidebarPreferences = {
    sections: [
      { id: "work", name: "Work", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { beta: "work" },
    starred: [],
    muted: [],
  };
  const order = vi
    .fn(async (ids: readonly string[]) => ({
      sections: ids.map((id, index) => ({
        id,
        name: id === "work" ? "Work" : "Later",
        order: index,
      })),
      assignments: data.assignments,
    }))
    .mockRejectedValueOnce(new Error("offline"));
  const read = vi.fn(async () => data);
  const preferences = createSidebarPreferencesStore({
    read,
    available: true,
    write: async () => data,
    writeStar: async () => [],
    writeOrder: order,
  });
  await preferences.queries.ensure();
  const h = fixture(preferences.queries, "ready", [
    { id: "beta", name: "beta", channelType: "stream" },
  ]);
  const user = userEvent.setup();
  const groups = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        '[data-sidebar-section^="group:"]',
      ),
    ].map((section) => section.dataset.sidebarSection);
  try {
    render(h.view("beta"));
    await waitFor(() =>
      expect(groups()).toEqual(["group:work", "group:later"]),
    );
    expect(
      document.querySelector(
        "[data-create-section-slot] + [data-sidebar-section]",
      ),
    ).toHaveAttribute("data-sidebar-section", "group:work");
    await user.click(
      screen.getByRole("button", { name: "More actions for Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Move down" }),
    );
    expect(
      await screen.findByText("Couldn’t save the move for Work. offline"),
    ).toBeVisible();
    expect(groups()).toEqual(["group:work", "group:later"]);
    read.mockRejectedValueOnce(new Error("refresh failed"));
    await act(() => preferences.queries.refresh());
    const retry = screen.getByRole("button", { name: "Retry move" });
    expect(retry).toBeDisabled();
    expect(
      screen.getByText(
        "Refresh saved sidebar preferences before retrying this move.",
      ),
    ).toBeVisible();
    await act(() => preferences.queries.refresh());
    expect(retry).toBeEnabled();
    expect(
      screen.queryByText(
        "Refresh saved sidebar preferences before retrying this move.",
      ),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry move" }));
    await waitFor(() =>
      expect(groups()).toEqual(["group:later", "group:work"]),
    );
    expect(
      document.querySelector(
        "[data-create-section-slot] + [data-sidebar-section]",
      ),
    ).toHaveAttribute("data-sidebar-section", "group:later");
    expect(order).toHaveBeenLastCalledWith(
      ["later", "work"],
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("button", { name: "Retry move" })).toBeNull();
    expect(
      document.querySelector('[data-sidebar-section="group:work"]'),
    ).toContainElement(screen.getByRole("button", { name: "beta" }));
  } finally {
    preferences.dispose();
  }
});

it.each(["star", "section", "unfiled"])(
  "lists a shared chat with the viewer's chats, never under Team (%s)",
  async (placement) => {
    const data = {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: placement === "section" ? { beta: "work" } : {},
      starred: placement === "star" ? ["beta"] : [],
      muted: [],
    };
    const store = createSidebarPreferencesStore({
      available: true,
      read: async () => data,
      write: async () => data,
    });
    await store.queries.ensure();
    const h = fixture(store.queries, "ready", [
      {
        id: "beta",
        name: "Shared work",
        channelType: "solo",
        private: true,
        creator: "b".repeat(64),
      },
      { id: "alpha", name: "Team channel", channelType: "stream" },
    ]);
    render(h.view("alpha"));
    await screen.findByRole("button", { name: "Team channel" });
    // One row, in the Solo list (which the sidebar navigation contains).
    const rows = screen.getAllByRole("button", { name: "Shared work" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.closest("nav")).toHaveAccessibleName("Solo conversations");
  },
);

it("opening a shared chat lists it once, with the viewer's chats", async () => {
  const h = fixture();
  h.publish("beta", {
    channelType: "solo",
    private: true,
    creator: "b".repeat(64),
  });
  const view = render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  await userEvent.click(screen.getByRole("tab", { name: "Solo" }));
  view.rerender(h.view("beta"));
  expect(screen.getByRole("tab", { name: "Solo" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const rows = await screen.findAllByRole("button", { name: "beta" });
  expect(rows).toHaveLength(1);
  expect(rows[0]?.closest("nav")).toHaveAccessibleName("Solo conversations");
});
it("promotes exactly the Bestie DM, restores prior local removal, and releases it on replacement, deletion and plugin disable", async () => {
  const viewer = "a".repeat(64),
    pollen = "b".repeat(64),
    fizz = "c".repeat(64);
  const h = fixture(undefined, "ready", [
    {
      id: "pollen-dm",
      name: "Pollen DM",
      channelType: "dm",
      members: [viewer, pollen],
    },
    {
      id: "fizz-dm",
      name: "Fizz DM",
      channelType: "dm",
      members: [viewer, fizz],
    },
    {
      id: "group-dm",
      name: "Group DM",
      channelType: "dm",
      members: [viewer, pollen, fizz],
    },
    {
      id: "namesake",
      name: "Pollen namesake",
      channelType: "dm",
      members: [viewer, "d".repeat(64)],
    },
  ]);
  const library = createAgentLibrary(async () => ({
    definitions: [],
    identities: [],
  }));
  const native = localAgentsFixture([
    {
      pubkey: pollen,
      name: "Pollen",
      owner: viewer,
      relayUrl: "wss://relay.test",
    },
    { pubkey: fizz, name: "Fizz", owner: viewer, relayUrl: "wss://relay.test" },
  ]);
  const lifetime = new AbortController();
  const choices = createAgentChoices({
    scope: h.session.scope,
    library: library.queries,
    native,
    signal: lifetime.signal,
  });
  await choices.refresh();
  h.session.agentChoices = choices;
  const page: RegisteredPage = {
    id: "bestie",
    key: "buzz.bestie/bestie",
    pluginId: "buzz.bestie",
    revision: "bundled",
    title: "Bestie",
    primary: true,
    component: () => null,
  };
  const relay: RelayData = {
    snapshot: () => h.snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    async clearCache() {},
  };
  const tree = (enabled = true) => (
    <BestieNavigationProvider pages={enabled ? [page] : []} relay={relay}>
      {h.view(
        "other-page",
        <PageNavigation
          pages={enabled ? [page] : []}
          selected={page.key}
          onSelect={() => {}}
        />,
      )}
    </BestieNavigationProvider>
  );
  const row = (id: string) =>
    document.querySelector(`[data-channel-id="${id}"]`);
  const scope = h.session.scope;
  // Previously removed locally, not a relay Hide or an authorization change.
  writeView(scope, "hidden-dms", [
    { id: "pollen-dm", baseline: null, knownIds: [] },
  ]);
  setDefaultAgent(scope, pollen);
  try {
    const view = render(tree(), { reactStrictMode: true });
    await screen.findByRole("button", { name: "Pollen" });
    await waitFor(() => expect(row("fizz-dm")).not.toBeNull());
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    expect(row("group-dm")).not.toBeNull();
    expect(row("namesake")).not.toBeNull();
    await waitFor(() => expect(readView(scope, "hidden-dms", [])).toEqual([]));

    act(() => {
      setDefaultAgent(scope, fizz);
    });
    await screen.findByRole("button", { name: "Fizz" });
    expect(row("pollen-dm")).not.toBeNull();
    // Promotion immediately removes the DM from accessible navigation; its
    // inert exit copy must also leave the DOM when the fade completes.
    expect(screen.queryByRole("button", { name: "Fizz DM" })).toBeNull();
    await waitFor(() => expect(row("fizz-dm")).toBeNull());
    act(() => {
      forgetDefaultAgent(fizz);
    });
    expect(screen.getByRole("button", { name: "Bestie" })).toBeInTheDocument();
    expect(row("fizz-dm")).not.toBeNull();

    act(() => {
      setDefaultAgent(scope, pollen);
    });
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    view.unmount();
    const reopened = render(tree(), { reactStrictMode: true });
    await waitFor(() => expect(row("fizz-dm")).not.toBeNull());
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    reopened.rerender(tree(false));
    expect(row("pollen-dm")).not.toBeNull();
    reopened.rerender(tree());
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    // A retained name is not enough to suppress a conversation whose exact
    // membership or chosen-agent eligibility is no longer established.
    h.publish("pollen-dm", { members: [viewer, pollen, fizz] });
    expect(row("pollen-dm")).not.toBeNull();
    h.publish("pollen-dm", { members: [viewer, pollen] });
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    // Source failure removes its candidates but does not release an explicit
    // account choice whose exact verified DM still exists.
    act(() => {
      native.set({ status: "error", agents: [], error: "Agents unavailable" });
    });
    await waitFor(() => expect(row("pollen-dm")).toBeNull());
    expect(screen.getByRole("button", { name: "Bestie" })).toBeInTheDocument();
    // A settled successful inventory proving the saved agent is gone releases it.
    act(() => {
      native.set({ status: "ready", agents: [] });
    });
    expect(row("pollen-dm")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Bestie" })).toBeInTheDocument();
    expect(h.session.channels.list().channels).toHaveLength(4);
    expect(readView(scope, "hidden-dms", [])).toEqual([]);
  } finally {
    lifetime.abort();
    library.dispose();
  }
});

function rowRegistry(...values: SidebarRowContribution[]) {
  const registered: readonly RegisteredSidebarRows[] = values.map(
    (value, index) => ({
      ...value,
      key: `fixture${index}/${value.id}`,
      pluginId: `fixture${index}`,
      revision: "one",
    }),
  );
  let entries = registered;
  const listeners = new Set<() => void>();
  return {
    version: 1 as const,
    snapshot: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register: () => {},
    disable() {
      entries = [];
      for (const listener of listeners) listener();
    },
    enable() {
      entries = registered;
      for (const listener of listeners) listener();
    },
  };
}

it.each([
  "active",
  "failed",
  "budget",
  "built-in",
  "registered",
  "unrelated-mode",
  "mixed-sections",
] as const)(
  "keeps cold saved sorting stable through plugin startup: %s",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const root = new Context();
    let release!: () => void;
    const loading = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const loadingStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registeredPlugin =
      outcome === "registered"
        ? "delayed.rows"
        : outcome === "unrelated-mode"
          ? "unrelated.plugin"
          : undefined;
    const runtime = new PluginRuntime(root, async (plugin) => {
      if (plugin.manifest.id !== registeredPlugin) {
        started();
        await loading;
      }
      if (plugin.manifest.id === "unrelated.plugin" && outcome === "registered")
        return { apply() {} };
      if (outcome === "failed") throw new Error("Plugin unavailable");
      return {
        apply(ctx) {
          ctx.reflect.get("sidebarRows")?.register({
            version: 1,
            id: "order",
            sortModes: [
              {
                id: "reverse",
                label: "Reverse name",
                compare: (a: SidebarRow, b: SidebarRow) =>
                  b.label.localeCompare(a.label),
              },
            ],
          });
        },
      };
    });
    const registry = new SidebarRowsService(root);
    const registered = registeredPlugin
      ? new Promise<void>((resolve) => {
          const unsubscribe = runtime.subscribe(() => {
            if (runtime.snapshot()[registeredPlugin]?.status !== "active")
              return;
            unsubscribe();
            resolve();
          });
        })
      : Promise.resolve();
    const pendingPlugin =
      outcome === "registered" ? "unrelated.plugin" : "delayed.rows";
    const prefs = createSidebarPreferencesStore({
      available: true,
      read: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        sort: {
          channels:
            outcome === "built-in"
              ? "alpha"
              : "plugin:delayed.rows/order/reverse",
          ...(outcome === "mixed-sections" ? { dms: "alpha" as const } : {}),
        },
      }),
    });
    const order = () =>
      [
        ...document.querySelectorAll(
          '[data-sidebar-section="channels"] [data-channel-id]',
        ),
      ].map((row) => row.getAttribute("data-channel-id"));
    try {
      runtime.reconcile(
        ["delayed.rows", ...(registeredPlugin ? ["unrelated.plugin"] : [])].map(
          (id) => ({
            manifest: { id, name: id, apiVersion: 1 },
            source: "external" as const,
            revision: "one",
            enabled: true,
            previous: null,
            reloadable: true,
            error: null,
          }),
        ),
      );
      await loadingStarted;
      await registered;
      await prefs.queries.ensure();
      const h = fixture(prefs.queries, "ready", undefined, undefined, registry);
      await act(async () => {
        render(h.view("alpha"));
      });
      expect(runtime.snapshot()[pendingPlugin]?.status).toBe("starting");
      if (outcome === "built-in") {
        expect(order()).toEqual(["alpha", "beta", "gamma"]);
      } else if (outcome === "registered") {
        expect(order()).toEqual(["gamma", "beta", "alpha"]);
        expect(screen.queryByText("Loading your sidebar…")).toBeNull();
      } else {
        expect(order()).toEqual([]);
        expect(screen.getByText("Loading your sidebar…")).toBeVisible();
      }
      if (outcome === "budget") {
        await act(() =>
          vi.advanceTimersByTimeAsync(SIDEBAR_REVEAL_BUDGET_MS - 1),
        );
        expect(order()).toEqual([]);
        await act(() => vi.advanceTimersByTimeAsync(1));
        expect(order()).toEqual(["alpha", "beta", "gamma"]);
        expect(
          screen.getByRole("complementary", { name: "Sidebar" }),
        ).not.toHaveAttribute("aria-busy", "true");
        expect(
          screen.getByRole("complementary", { name: "Sidebar" }),
        ).not.toHaveAttribute("data-buzz-launch-pending");
      }
      const finished = new Promise<void>((resolve) => {
        const unsubscribe = runtime.subscribe(() => {
          if (runtime.snapshot()[pendingPlugin]?.status === "starting") return;
          unsubscribe();
          resolve();
        });
      });
      await act(async () => {
        release();
        await finished;
      });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(order()).toEqual(
        outcome === "failed" || outcome === "built-in"
          ? ["alpha", "beta", "gamma"]
          : ["gamma", "beta", "alpha"],
      );
      expect(screen.queryByText("Loading your sidebar…")).toBeNull();
      expect(
        screen.getByRole("complementary", { name: "Sidebar" }),
      ).not.toHaveAttribute("aria-busy", "true");
    } finally {
      cleanup();
      release();
      prefs.dispose();
      await runtime.dispose();
      await root.fiber.dispose();
      vi.useRealTimers();
    }
  },
);

it("reveals an unavailable saved sort when configuration settles and stays settled during later startup", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = new Context();
  let configuring = true;
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const loadingStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const runtime = new PluginRuntime(
    root,
    async () => {
      started();
      await loading;
      return { apply() {} };
    },
    undefined,
    () => configuring,
  );
  const registry = new SidebarRowsService(root);
  const prefs = createSidebarPreferencesStore({
    available: true,
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
      sort: { channels: "plugin:disabled.rows/order/reverse" },
    }),
  });
  try {
    await prefs.queries.ensure();
    const h = fixture(prefs.queries, "ready", undefined, undefined, registry);
    await act(async () => {
      render(h.view("alpha"));
    });
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(screen.getByText("Loading your sidebar…")).toBeVisible();
    expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();

    await act(async () => {
      configuring = false;
      runtime.reconcile([]);
    });
    expect(screen.getByRole("button", { name: "alpha" })).toBeVisible();
    expect(screen.queryByText("Loading your sidebar…")).toBeNull();
    expect(sidebar).not.toHaveAttribute("aria-busy", "true");
    expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");

    await act(async () => {
      runtime.reconcile([
        {
          manifest: {
            id: "unrelated.plugin",
            name: "Unrelated",
            apiVersion: 1,
          },
          source: "external",
          revision: "one",
          enabled: true,
          previous: null,
          reloadable: true,
          error: null,
        },
      ]);
      await loadingStarted;
    });
    expect(runtime.snapshot()["unrelated.plugin"]?.status).toBe("starting");
    expect(sidebar).not.toHaveAttribute("aria-busy", "true");
    expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");
    expect(screen.getByRole("button", { name: "alpha" })).toBeVisible();
    expect(prefs.queries.snapshot().data?.sort?.channels).toBe(
      "plugin:disabled.rows/order/reverse",
    );

    const finished = new Promise<void>((resolve) => {
      const unsubscribe = runtime.subscribe(() => {
        if (runtime.snapshot()["unrelated.plugin"]?.status === "starting")
          return;
        unsubscribe();
        resolve();
      });
    });
    await act(async () => {
      release();
      await finished;
    });
    expect(runtime.snapshot()["unrelated.plugin"]?.status).toBe("active");
    expect(sidebar).not.toHaveAttribute("aria-busy", "true");
    expect(sidebar).not.toHaveAttribute("data-buzz-launch-pending");
  } finally {
    cleanup();
    release();
    prefs.dispose();
    await runtime.dispose();
    await root.fiber.dispose();
    vi.useRealTimers();
  }
});

it("does not rebuild unrelated plugin rows when a row menu opens or closes", async () => {
  const renderRow = vi.fn(
    (_: SidebarRow, Default: ReactElement | null) => Default,
  );
  const registry = rowRegistry({
    version: 1,
    id: "observe",
    render: renderRow,
  });
  const h = fixture(undefined, "ready", undefined, undefined, registry);
  render(h.view("alpha"));
  await screen.findByRole("button", { name: "gamma" });
  renderRow.mockClear();
  const beta = screen.getByRole("button", { name: "beta" });
  beta.focus();
  fireEvent.keyDown(beta, { key: "ContextMenu" });
  const copyLink = await screen.findByRole("menuitem", { name: "Copy link" });
  copyLink.focus();
  expect(copyLink).toHaveFocus();
  expect(
    renderRow.mock.calls.map(([row]) => row.id).filter((id) => id !== "beta"),
  ).toEqual([]);
  renderRow.mockClear();
  fireEvent.keyDown(copyLink, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Actions for beta" })).toBeNull(),
  );
  await waitFor(() => expect(beta).toHaveFocus());
  expect(
    renderRow.mock.calls.map(([row]) => row.id).filter((id) => id !== "beta"),
  ).toEqual([]);
});

it("decorates live host rows and closes menus only when their row is hidden", async () => {
  const registry = rowRegistry({
    version: 1,
    id: "decorate",
    render: (row, Default) =>
      row.channel.lastActivityAt === 1 ? null : row.id === "beta" ? (
        <div data-decoration="beta">
          {Default}
          <span>Plugin detail</span>
        </div>
      ) : (
        Default
      ),
  });
  const h = fixture(undefined, "ready", undefined, undefined, registry);
  render(h.view("beta"));
  const beta = await screen.findByRole("button", { name: "beta" });
  expect(beta).toHaveAttribute("aria-current", "page");
  expect(beta.closest("[data-decoration]")).toHaveTextContent("Plugin detail");
  expect(
    screen.getByRole("button", { name: "alpha" }).closest("[data-decoration]"),
  ).toBeNull();
  beta.focus();
  expect(beta).toHaveFocus();
  fireEvent.click(beta);
  expect(h.navigator.open).toHaveBeenCalled();
  fireEvent.keyDown(beta, { key: "ContextMenu" });
  const copyLink = await screen.findByRole("menuitem", { name: "Copy link" });
  copyLink.focus();
  expect(copyLink).toHaveFocus();

  h.publish("alpha", { lastActivityAt: 1 });
  expect(screen.queryByRole("button", { name: "alpha" })).toBeNull();
  expect(screen.getByRole("menu", { name: "Actions for beta" })).toBeVisible();
  expect(copyLink).toHaveFocus();

  h.publish("beta", { lastActivityAt: 1 });
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  await waitFor(() =>
    expect(screen.queryByRole("menu", { name: "Actions for beta" })).toBeNull(),
  );
  await waitFor(() =>
    expect(
      screen.getByLabelText("Channels", { selector: "summary" }),
    ).toHaveFocus(),
  );

  h.publish("beta", { lastActivityAt: 0 });
  expect(await screen.findByRole("button", { name: "beta" })).toBeVisible();
  expect(screen.queryByRole("menu", { name: "Actions for beta" })).toBeNull();
});

it.each(["enable", "disable"] as const)(
  "preserves host row identity and focus on renderer %s",
  async (transition) => {
    const registry = rowRegistry({
      version: 1,
      id: "unchanged",
      render: (_, Default) => Default,
    });
    if (transition === "enable") registry.disable();
    const h = fixture(undefined, "ready", undefined, undefined, registry);
    render(h.view("alpha"));
    const alpha = await screen.findByRole("button", { name: "alpha" });
    alpha.focus();
    expect(alpha).toHaveFocus();

    act(() => registry[transition]());

    expect(screen.getByRole("button", { name: "alpha" })).toBe(alpha);
    expect(alpha).toHaveFocus();
  },
);

it.each([
  {
    focused: "alpha",
    hidden: ["alpha"],
    destination: "beta",
    activate: true,
  },
  { focused: "beta", hidden: ["beta"], destination: "gamma" },
  { focused: "gamma", hidden: ["gamma"], destination: "beta" },
  {
    focused: "beta",
    hidden: ["alpha", "beta", "gamma"],
    destination: "Channels",
  },
  {
    focused: "beta",
    hidden: ["beta"],
    destination: "alpha",
    moveFocus: true,
  },
])(
  "recovers focus from plugin-hidden $focused to $destination (hidden: $hidden)",
  async ({ focused, hidden, destination, moveFocus, activate }) => {
    const registry = rowRegistry({
      version: 1,
      id: "live-hide",
      render: (row, Default) => {
        if (activate)
          return hidden.includes(row.id) ? null : <div>{Default}</div>;
        return row.channel.lastActivityAt === 1 ? null : Default;
      },
    });
    if (activate) registry.disable();
    const h = fixture(undefined, "ready", undefined, undefined, registry);
    render(h.view("alpha"));
    const row = await screen.findByRole("button", { name: focused });
    row.focus();
    expect(row).toHaveFocus();

    await act(async () => {
      if (activate) registry.enable();
      else for (const id of hidden) h.publish(id, { lastActivityAt: 1 });
      if (moveFocus) screen.getByRole("button", { name: "alpha" }).focus();
    });

    expect(screen.queryByRole("button", { name: focused })).toBeNull();
    const target =
      destination === "Channels"
        ? screen.getByLabelText("Channels", { selector: "summary" })
        : screen.getByRole("button", { name: destination });
    expect(target).toHaveFocus();
  },
);

it.each([
  { change: "star", collapsed: false },
  { change: "assignment", collapsed: false },
  { change: "star", collapsed: true },
  { change: "assignment", collapsed: true },
])(
  "recovers focus after external $change relocation (collapsed: $collapsed)",
  async ({ change, collapsed }) => {
    let saved: SidebarPreferences = {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    };
    const preferences = createSidebarPreferencesStore({
      available: true,
      read: async () => saved,
    });
    await preferences.queries.ensure();
    const h = fixture(preferences.queries);
    try {
      const sectionKey = change === "star" ? "starred" : "group:work";
      if (collapsed)
        writeView(h.session.scope, "channel-sidebar", {
          collapsed: [sectionKey],
          scrollTop: 0,
        });
      const mounted = render(h.view("alpha"));
      const beta = await screen.findByRole("button", { name: "beta" });
      beta.focus();
      expect(beta).toHaveFocus();

      saved = {
        ...saved,
        ...(change === "star"
          ? { starred: ["beta"] }
          : { assignments: { beta: "work" } }),
      };
      await act(() => preferences.queries.refresh());

      const relocated = mounted.container.querySelector(
        'button[data-channel-id="beta"]',
      );
      expect(relocated?.closest("[data-sidebar-section]")).toHaveAttribute(
        "data-sidebar-section",
        sectionKey,
      );
      if (collapsed) {
        expect(relocated?.closest("[hidden][inert]")).not.toBeNull();
        expect(screen.getByRole("button", { name: "gamma" })).toHaveFocus();
      } else expect(relocated).toHaveFocus();
    } finally {
      preferences.dispose();
    }
  },
);

it("can replace or hide a chosen row without changing its siblings", async () => {
  const registry = rowRegistry({
    version: 1,
    id: "replace",
    render: (row, Default) =>
      row.id === "beta" ? (
        <span>Replacement animation</span>
      ) : row.id === "gamma" ? null : (
        Default
      ),
  });
  const h = fixture(undefined, "ready", undefined, undefined, registry);
  render(h.view("alpha"));
  expect(await screen.findByText("Replacement animation")).toBeVisible();
  expect(screen.queryByRole("button", { name: "beta" })).toBeNull();
  expect(screen.queryByRole("button", { name: "gamma" })).toBeNull();
  expect(screen.getByRole("button", { name: "alpha" })).toBeVisible();
  act(() => registry.disable());
  expect(await screen.findByRole("button", { name: "beta" })).toBeVisible();
  expect(screen.getByRole("button", { name: "gamma" })).toBeVisible();
  expect(screen.queryByText("Replacement animation")).toBeNull();
});

it.each(["enable", "disable", "update"] as const)(
  "contains a hook-calling row callback on %s without losing the sidebar",
  async (transition) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = rowRegistry({
      version: 1,
      id: "hook-callback",
      render: function useBrokenRow(row, Default) {
        if (row.id !== "beta" || row.channel.lastActivityAt === 1)
          return Default;
        // biome-ignore lint/correctness/useHookAtTopLevel: Exercise a plugin violating the callback contract.
        const [detail] = useState("Plugin detail");
        return (
          <div>
            {Default}
            <span>{detail}</span>
          </div>
        );
      },
    });
    if (transition === "enable") registry.disable();
    try {
      const h = fixture(undefined, "ready", undefined, undefined, registry);
      render(h.view("beta"));
      const alpha = await screen.findByRole("button", { name: "alpha" });
      expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      if (transition === "update") h.publish("beta", { lastActivityAt: 1 });
      else act(() => registry[transition]());
      expect(screen.getByRole("button", { name: "beta" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(screen.getByRole("button", { name: "alpha" })).toBe(alpha);
      expect(screen.getByRole("button", { name: "gamma" })).toBeVisible();
      expect(screen.queryByText("Plugin detail")).toBeNull();
    } finally {
      error.mockRestore();
    }
  },
);

function BrokenRow(): never {
  throw new Error("broken child");
}

it.each(["callback", "child", "invalid"] as const)(
  "falls back to the live host row for a %s failure only",
  async (failure) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = rowRegistry({
      version: 1,
      id: "broken",
      render: (row, Default) => {
        if (row.id !== "beta")
          return <div data-decoration="healthy">{Default}</div>;
        if (row.channel.lastActivityAt === 1)
          return <div data-decoration="recovered">{Default}</div>;
        if (failure === "callback") throw new Error("broken callback");
        return failure === "child" ? <BrokenRow /> : ({} as never);
      },
    });
    try {
      const h = fixture(undefined, "ready", undefined, undefined, registry);
      render(h.view("beta"));
      const beta = await screen.findByRole("button", { name: "beta" });
      expect(beta).toHaveAttribute("aria-current", "page");
      expect(beta.closest("[data-decoration]")).toBeNull();
      expect(
        screen
          .getByRole("button", { name: "alpha" })
          .closest("[data-decoration]"),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "gamma" })).toBeVisible();
      beta.focus();
      h.publish("beta", { lastActivityAt: 2 });
      if (failure !== "child") {
        expect(screen.getByRole("button", { name: "beta" })).toBe(beta);
        expect(beta).toHaveFocus();
      }
      h.publish("beta", { lastActivityAt: 1 });
      expect(
        screen
          .getByRole("button", { name: "beta" })
          .closest("[data-decoration]"),
      ).toHaveAttribute("data-decoration", "recovered");

      screen.getByRole("button", { name: "beta" }).focus();
      await act(async () => h.publish("beta", { lastActivityAt: 3 }));
      const fallback = screen.getByRole("button", { name: "beta" });
      expect(fallback.closest("[data-decoration]")).toBeNull();
      expect(fallback).toHaveFocus();

      await act(async () => h.publish("beta", { lastActivityAt: 1 }));
      screen.getByRole("button", { name: "beta" }).focus();
      const alpha = screen.getByRole("button", { name: "alpha" });
      await act(async () => {
        h.publish("beta", { lastActivityAt: 4 });
        alpha.focus();
      });
      expect(alpha).toHaveFocus();
    } finally {
      error.mockRestore();
    }
  },
);

it("composes two plugins around the preceding result", async () => {
  const registry = rowRegistry(
    {
      version: 1,
      id: "first",
      render: (_, Default) => <div data-layer="inner">{Default}</div>,
    },
    {
      version: 1,
      id: "second",
      render: (_, Default) => <div data-layer="outer">{Default}</div>,
    },
  );
  const h = fixture(undefined, "ready", undefined, undefined, registry);
  render(h.view("alpha"));
  const alpha = await screen.findByRole("button", { name: "alpha" });
  expect(alpha.closest('[data-layer="inner"]')?.parentElement).toHaveAttribute(
    "data-layer",
    "outer",
  );
});

it.each([
  { sectionKey: "channels", preferenceKey: "channels", label: "Channels" },
  { sectionKey: "group:work", preferenceKey: "section:work", label: "Work" },
])(
  "persists a plugin sort for $sectionKey across disable and re-enable",
  async ({ sectionKey, preferenceKey, label }) => {
    const registry = rowRegistry({
      version: 1,
      id: "order",
      sortModes: [
        {
          id: "reverse",
          label: "Reverse name",
          compare: (a, b) => b.label.localeCompare(a.label),
        },
      ],
    });
    let sort: Record<string, SidebarSortMode> = {};
    const writeSort = vi.fn(async (key: string, mode: SidebarSortMode) => {
      sort = { ...sort, [key]: mode };
      return sort;
    });
    const prefs = createSidebarPreferencesStore({
      available: true,
      read: async () => ({
        sections:
          sectionKey === "channels"
            ? []
            : [{ id: "work", name: "Work", order: 0 }],
        assignments:
          sectionKey === "channels"
            ? {}
            : { alpha: "work", beta: "work", gamma: "work" },
        starred: [],
        muted: [],
        sort,
      }),
      writeSort,
    });
    const h = fixture(prefs.queries, "ready", undefined, undefined, registry);
    const user = userEvent.setup();
    try {
      const mounted = render(h.view("alpha"));
      await screen.findByRole("button", { name: "gamma" });
      const order = () =>
        [
          ...document.querySelectorAll(
            `[data-sidebar-section="${sectionKey}"] [data-channel-id]`,
          ),
        ].map((el) => el.getAttribute("data-channel-id"));
      expect(order()).toEqual(["alpha", "beta", "gamma"]);
      await user.click(
        screen.getByRole("button", { name: `More actions for ${label}` }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
      fireEvent.click(
        await screen.findByRole("menuitemradio", { name: "Reverse name" }),
      );
      await waitFor(() => expect(order()).toEqual(["gamma", "beta", "alpha"]));
      expect(writeSort).toHaveBeenCalledWith(
        preferenceKey,
        "plugin:fixture0/order/reverse",
        sectionKey === "channels" ? [] : ["work"],
        expect.any(AbortSignal),
      );
      mounted.unmount();
      render(h.view("alpha"));
      await waitFor(() => expect(order()).toEqual(["gamma", "beta", "alpha"]));
      act(() => registry.disable());
      await waitFor(() => expect(order()).toEqual(["alpha", "beta", "gamma"]));
      expect(sort[preferenceKey]).toBe("plugin:fixture0/order/reverse");
      await user.click(
        screen.getByRole("button", { name: `More actions for ${label}` }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
      expect(
        screen.queryByRole("menuitemradio", { name: "Reverse name" }),
      ).toBeNull();
      act(() => registry.enable());
      await waitFor(() => expect(order()).toEqual(["gamma", "beta", "alpha"]));
      expect(writeSort).toHaveBeenCalledOnce();
    } finally {
      prefs.dispose();
    }
  },
);

it.each(["throw", "non-finite"] as const)(
  "retains the section roster and host order when a comparator returns %s",
  async (failure) => {
    const registry = rowRegistry({
      version: 1,
      id: "order",
      sortModes: [
        {
          id: "broken",
          label: "Broken sort",
          compare: (a, b) => {
            if (failure === "throw") throw new Error("broken sort");
            return a.id === "gamma" || b.id === "gamma"
              ? NaN
              : b.label.localeCompare(a.label);
          },
        },
      ],
    });
    const prefs = createSidebarPreferencesStore({
      available: true,
      read: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        sort: { channels: "plugin:fixture0/order/broken" },
      }),
      writeSort: async () => ({ channels: "plugin:fixture0/order/broken" }),
    });
    const h = fixture(prefs.queries, "ready", undefined, undefined, registry);
    try {
      render(h.view("alpha"));
      await screen.findByRole("button", { name: "gamma" });
      expect(
        [
          ...document.querySelectorAll(
            '[data-sidebar-section="channels"] [data-channel-id]',
          ),
        ].map((el) => el.getAttribute("data-channel-id")),
      ).toEqual(["alpha", "beta", "gamma"]);
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("button", { name: "More actions for Channels" }),
      );
      await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
      expect(
        await screen.findByRole("menuitemradio", { name: "Broken sort" }),
      ).toHaveAttribute("aria-checked", "true");
    } finally {
      prefs.dispose();
    }
  },
);

it("supplies DM identity and live channel metadata without replacing its host row", async () => {
  const registry = rowRegistry({
    version: 1,
    id: "details",
    render: (row, Default) =>
      row.kind === "dm" ? (
        <div data-dm-decoration={row.id}>
          {Default}
          <span>Activity {row.channel.lastActivityAt ?? "unknown"}</span>
        </div>
      ) : (
        Default
      ),
  });
  const h = fixture(
    undefined,
    "ready",
    [
      { id: "alpha", name: "alpha", channelType: "stream" },
      {
        id: "dm",
        name: "Alice",
        channelType: "dm",
        visibility: "private",
        lastActivityAt: 12,
      },
    ],
    undefined,
    registry,
  );
  render(h.view("dm"));
  const dm = await screen.findByRole("button", { name: "Alice" });
  expect(dm).toHaveAttribute("aria-current", "page");
  expect(dm.closest("[data-dm-decoration]")).toHaveAttribute(
    "data-dm-decoration",
    "dm",
  );
  expect(screen.getByText("Activity 12")).toBeVisible();
  h.publish("dm", { lastActivityAt: 24 });
  expect(await screen.findByText("Activity 24")).toBeVisible();
  expect(
    screen
      .getByRole("button", { name: "alpha" })
      .closest("[data-dm-decoration]"),
  ).toBeNull();
});

it("updates decorated unread data and a selected unread sort without rewriting preferences", async () => {
  const renderRow = vi.fn((row: SidebarRow, Default: ReactElement | null) => (
    <div
      data-unread-row={row.id}
      data-observed-count={row.unread.observedCount ?? "unknown"}
    >
      {Default}
    </div>
  ));
  const registry = rowRegistry({
    version: 1,
    id: "unread",
    render: renderRow,
    sortModes: [
      {
        id: "unread",
        label: "Unread first",
        compare: (a, b) =>
          (b.unread.observedCount ?? 0) - (a.unread.observedCount ?? 0),
      },
    ],
  });
  const writeSort = vi.fn(async (key: string, mode: SidebarSortMode) => ({
    [key]: mode,
  }));
  const prefs = createSidebarPreferencesStore({
    available: true,
    read: async () => ({
      sections: [],
      assignments: {},
      starred: [],
      muted: [],
      sort: {},
    }),
    writeSort,
  });
  const h = fixture(prefs.queries, "ready", undefined, undefined, registry);
  const original = h.session.unread;
  const snapshots = new Map(
    ["alpha", "beta", "gamma"].map((id) => [
      id,
      original.snapshot({ kind: "channel", channelId: id }),
    ]),
  );
  const listeners = new Map<string, Set<() => void>>();
  h.session.unread = {
    ...original,
    snapshot: (target) =>
      target.kind === "channel"
        ? (snapshots.get(target.channelId) ?? original.snapshot(target))
        : original.snapshot(target),
    subscribe: (target, listener) => {
      if (target.kind !== "channel")
        return original.subscribe(target, listener);
      const set = listeners.get(target.channelId) ?? new Set();
      listeners.set(target.channelId, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
  };
  const publish = (count: number | null) =>
    act(() => {
      const previous = snapshots.get("beta");
      assert(previous);
      snapshots.set("beta", {
        ...previous,
        observedCount: count,
        attentionCount: count,
        coverage: count === null ? "unknown" : "observed",
        freshness: count === null ? "unknown" : "observed",
      });
      for (const listener of listeners.get("beta") ?? []) listener();
    });
  const order = () =>
    [
      ...document.querySelectorAll(
        '[data-sidebar-section="channels"] [data-channel-id]',
      ),
    ].map((el) => el.getAttribute("data-channel-id"));
  try {
    render(h.view("alpha"));
    await screen.findByRole("button", { name: "gamma" });
    expect(document.querySelector('[data-unread-row="beta"]')).toHaveAttribute(
      "data-observed-count",
      "unknown",
    );
    renderRow.mockClear();
    publish(2);
    expect(document.querySelector('[data-unread-row="beta"]')).toHaveAttribute(
      "data-observed-count",
      "2",
    );
    expect(renderRow.mock.calls.map(([row]) => row.id)).toEqual(["beta"]);
    expect(order()).toEqual(["alpha", "beta", "gamma"]);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "More actions for Channels" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Sort" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Unread first" }),
    );
    await waitFor(() => expect(order()).toEqual(["beta", "alpha", "gamma"]));
    expect(writeSort).toHaveBeenCalledOnce();
    publish(null);
    await waitFor(() => expect(order()).toEqual(["alpha", "beta", "gamma"]));
    publish(3);
    await waitFor(() => expect(order()).toEqual(["beta", "alpha", "gamma"]));
    expect(document.querySelector('[data-unread-row="beta"]')).toHaveAttribute(
      "data-observed-count",
      "3",
    );
    expect(writeSort).toHaveBeenCalledOnce();
  } finally {
    prefs.dispose();
  }
});
