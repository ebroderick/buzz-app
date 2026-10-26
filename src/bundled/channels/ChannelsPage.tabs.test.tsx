import { createNavigationController } from "../../features/navigation/controller";
import { createMemoryHistory } from "../../features/navigation/history";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import closeRequest from "../../../src-tauri/src/close-request.js?raw";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  Panels,
  PanelOpenRequest,
  RegisteredPanel,
} from "../../features/panels/service";
import type { PageNavigation } from "../../features/navigation/service";
import {
  createRelaySession,
  type RelaySession,
} from "../../features/relay/session";
import type { RelayData } from "../../features/relay/service";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import {
  keypair,
  metadata,
  roster,
  signed,
} from "../../features/relay/testing";
import { writeView } from "../../shared/view-state";
import type { Navigation } from "../../features/navigation/controller";
import { useChannelTabState } from "./useChannelTabState";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { SOLO_LABEL } from "../../features/solo/labels";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { ChannelsPage } from "./ChannelsPage";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { BrowserHostView } from "../../features/browser/BrowserHostView";
import { BrowserSessions } from "../../features/browser/sessions";
import type { BrowserPlatform } from "../../features/browser/platform";

composerDOMFixture();

const owners: ReturnType<typeof createRelaySession>[] = [];
beforeEach(() => {
  // jsdom has no layout/ResizeObserver. Only geometry is substituted; the page,
  // composer, session, tab store and menu interaction are production owners.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
});
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  setThreadPlacementPreference("side");
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function page(
  type: "stream" | "solo" = "stream",
  navigator?: Navigation,
  routed = false,
  appComponent?: RegisteredPanel["component"],
  soloPreferences?: RelaySession["soloPreferences"],
) {
  const viewer = keypair(),
    authority = keypair();
  const channelId = "alpha";
  const events = [
    roster(authority, channelId, [viewer.pubkey]),
    metadata(
      authority,
      channelId,
      "Alpha",
      undefined,
      type === "solo"
        ? [["t", "stream"], ["private"], ["t", SOLO_LABEL]]
        : [["t", "stream"]],
    ),
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [["t", "stream"]]),
    roster(authority, "gamma", [viewer.pubkey]),
    metadata(authority, "gamma", "Gamma", undefined, [
      ["t", "stream"],
      ["private"],
      ["t", SOLO_LABEL],
    ]),
  ];
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const scope = `https://relay.test:${viewer.pubkey}`;
  const root = routed
    ? signed(viewer, {
        kind: 9,
        tags: [["h", channelId]],
        content: "Initiating thread",
      })
    : undefined;
  if (root) events.push(root);
  writeView(scope, "selected-channel", channelId);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope,
    viewer: viewer.pubkey,
    // The real session and its stores are frozen; a test may replace one.
    session: soloPreferences
      ? (Object.defineProperty(
          Object.create(owner.session),
          "soloPreferences",
          {
            value: soloPreferences,
          },
        ) as typeof owner.session)
      : owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const panel: RegisteredPanel = {
    id: "notes",
    key: "fixture:notes",
    pluginId: "fixture",
    revision: "1",
    title: "Notes",
    matches: () => false,
    channelPlacement: "tab",
    channelLauncher: ({ context, toggle }) => (
      <button type="button" onClick={() => toggle(context.channelId)}>
        Open notes
      </button>
    ),
    component: () => <input aria-label="Notes draft" />,
  };
  const app: RegisteredPanel = {
    id: "app",
    key: "fixture:app",
    pluginId: "fixture",
    revision: "1",
    title: "App",
    keepOpen: true,
    matches: (target) => target === "https://app.example/",
    component: appComponent ?? (() => <p>App content</p>),
  };
  const available = [panel, app];
  let handleOpen: ((request: PanelOpenRequest) => boolean) | undefined;
  const panels: Panels = {
    snapshot: () => available,
    subscribe: () => () => {},
    resolve: (target) => available.find((entry) => entry.matches(target)),
    register() {},
    requestOpen: (request) => handleOpen?.(request) ?? false,
    handleOpenRequests: (handler) => {
      handleOpen = handler;
      return () => {
        handleOpen = undefined;
      };
    },
  };
  const navigation: PageNavigation | undefined = root
    ? {
        entryId: "thread-visit",
        target: {
          version: 1,
          kind: "conversation",
          scope: {
            viewer: viewer.pubkey,
            communityOrigin: "https://relay.test",
          },
          channelId,
          messageId: root.id,
          threadRootId: root.id,
        },
        signal: new AbortController().signal,
        position: () => undefined,
        savePosition() {},
        forSession() {
          return this;
        },
        resolve: () => true,
        complete: () => true,
      }
    : undefined;
  render(
    <ToastProvider>
      <ChannelsPage
        relay={relay}
        panels={panels}
        navigator={
          navigator ??
          createNavigationController(createMemoryHistory()).navigation
        }
        navigation={navigation}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  const composer = await screen.findByRole("textbox", {
    name: type === "solo" ? "Message your agents" : "Message #Alpha",
    hidden: routed,
  });
  const open = () =>
    user.click(screen.getByRole("button", { name: "Open notes" }));
  return {
    user,
    composer,
    open,
    session: snapshot.session,
    scope,
    viewer: viewer.pubkey,
    panels,
    root: root?.id,
  };
}

it.each(["side", "main"] as const)(
  "agent-opened apps preserve their routed %s thread",
  async (pane) => {
    setThreadPlacementPreference(pane);
    const open = vi.fn(async () => ({ status: "opened" as const }));
    const h = await page(
      "stream",
      {
        open,
        snapshot: () => ({ entry: { id: "thread-visit" }, attempt: {} }),
      } as unknown as Navigation,
      true,
    );
    const root = h.root;
    if (!root) throw new Error("Routed thread root unavailable");
    const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
    await screen.findByRole("tab", { name: "Initiating thread" });
    act(() =>
      expect(
        h.panels.requestOpen({
          channelId: "alpha",
          rootId: root,
          target: "https://app.example/",
        }),
      ).toBe(true),
    );
    expect(screen.getByRole("tab", { name: "App" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(open).not.toHaveBeenCalled();
    expect(tabs.result.current.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "thread", messageId: root }),
      ]),
    );
    await h.user.click(screen.getByRole("button", { name: "Close App tab" }));
    const thread = screen.getByRole("tab", { name: "Initiating thread" });
    expect(thread).toHaveAttribute("aria-selected", "true");
    expect(open).not.toHaveBeenCalled();
  },
);

/** A page over `events` with no saved selection and no registered panels. */
function workspace(
  events: RelayEvent[],
  viewer = keypair(),
  authority = keypair(),
) {
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: authority.pubkey,
      media: () => undefined,
      query: async (filters) =>
        events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        ),
      writer: {
        sign: async (template) => signed(viewer, template),
        publish: async () => {},
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  owners.push(owner);
  const snapshot = {
    status: "ready" as const,
    generation: 1,
    scope: `https://relay.test:${viewer.pubkey}`,
    viewer: viewer.pubkey,
    session: owner.session,
  };
  const relay: RelayData = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  };
  const none: RegisteredPanel[] = [];
  const panels: Panels = {
    snapshot: () => none,
    subscribe: () => () => {},
    resolve: () => undefined,
    register() {},
    requestOpen: () => false,
    handleOpenRequests: () => () => {},
  };
  render(
    <ToastProvider>
      <ChannelsPage
        relay={relay}
        panels={panels}
        navigator={createNavigationController(createMemoryHistory()).navigation}
      />
    </ToastProvider>,
  );
  return { owner, viewer, authority };
}

it("opens the community's auto-join channel first when nothing is saved", async () => {
  const viewer = keypair(),
    authority = keypair();
  workspace(
    [
      roster(authority, "alpha", [viewer.pubkey]),
      metadata(authority, "alpha", "Alpha", undefined, [["t", "stream"]]),
      roster(authority, "beta", [viewer.pubkey]),
      metadata(authority, "beta", "Beta", undefined, [
        ["t", "stream"],
        ["auto_join"],
      ]),
    ],
    viewer,
    authority,
  );
  await screen.findByRole("textbox", { name: "Message #Beta" });
});

it("selects a default channel the relay adds after the page opened", async () => {
  const events: RelayEvent[] = [];
  const { owner, viewer, authority } = workspace(events);
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  // A 44100 membership hint resolves the channel through the same store entry.
  events.push(
    roster(authority, "beta", [viewer.pubkey]),
    metadata(authority, "beta", "Beta", undefined, [
      ["t", "stream"],
      ["auto_join"],
    ]),
  );
  await act(() => owner.session.channels.resolve?.(["beta"]));
  await screen.findByRole("textbox", { name: "Message #Beta" });
});

it("moving the last side app adopts its guest before the dock exit finishes", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 800, 500),
  );
  let finishExit = () => {};
  const finished = new Promise<void>((resolve) => {
    finishExit = resolve;
  });
  const originalAnimations = HTMLElement.prototype.getAnimations;
  const getAnimations = vi.fn(() => [{ finished }]);
  Object.defineProperty(HTMLElement.prototype, "getAnimations", {
    configurable: true,
    value: getAnimations,
  });
  const pages = new Map<string, string>();
  const attached = vi.fn(async (url: string) => {
    const id = `guest-${pages.size + 1}`;
    pages.set(id, url);
    return id;
  });
  const detached = vi.fn(async (id: string) => {
    pages.delete(id);
  });
  const observed: string[] = [];
  const platform: BrowserPlatform = {
    available: true,
    attach: attached,
    detach: detached,
    setBounds: async () => {},
    navigate: async (id, url) => {
      pages.set(id, url);
    },
    action: async () => {},
    status: async (id) => {
      const url = pages.get(id) ?? "";
      observed.push(url);
      return { url, title: "App", loading: false, error: null };
    },
  };
  const sessions = new BrowserSessions(platform);
  const App = () => (
    <BrowserHostView
      url="https://app.example/"
      storage="builderlab-apps"
      platform={platform}
      sessions={sessions}
    />
  );
  try {
    const h = await page("stream", undefined, false, App);
    act(() =>
      expect(
        h.panels.requestOpen({
          channelId: "alpha",
          target: "https://app.example/",
        }),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(attached).toHaveBeenCalledTimes(1));
    const address = screen.getByRole("textbox", { name: "Address" });
    await h.user.clear(address);
    await h.user.type(address, "https://app.example/second.html{Enter}");
    await vi.waitFor(() =>
      expect(observed).toContain("https://app.example/second.html"),
    );
    const source = document.querySelector("[data-panel-dock]");
    const sourceGuest = source
      ?.querySelector("[data-browser-session]")
      ?.getAttribute("data-browser-session");
    expect(sourceGuest).toBe("guest-1");
    screen.getByRole("tab", { name: "App" }).focus();
    await h.user.keyboard("{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}");
    const main = document.querySelector<HTMLElement>("[data-main-workspace]");
    if (!main) throw new Error("Main workspace unavailable");
    fireEvent.animationEnd(within(main).getByRole("tabpanel", { name: "App" }));
    await vi.waitFor(() =>
      expect(main.querySelector("[data-browser-session]")).not.toBeNull(),
    );
    expect(getAnimations).toHaveBeenCalled();
    expect(source).toHaveAttribute("data-closing");
    expect(main.querySelector("[data-browser-session]")).toHaveAttribute(
      "data-browser-session",
      sourceGuest,
    );
    expect(attached).toHaveBeenCalledTimes(1);
    expect(detached).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(
        within(main).getByRole("textbox", { name: "Address" }),
      ).toHaveValue("https://app.example/second.html"),
    );
    await act(async () => finishExit());
    expect(main.querySelector("[data-browser-session]")).toHaveAttribute(
      "data-browser-session",
      sourceGuest,
    );
    expect(attached).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => finishExit());
    if (originalAnimations)
      HTMLElement.prototype.getAnimations = originalAnimations;
    else Reflect.deleteProperty(HTMLElement.prototype, "getAnimations");
  }
});

const closeTabs = (tabEvent = "buzz:close-all-tabs") => {
  let handled = false;
  act(() => {
    handled =
      new Function(
        "window",
        "document",
        "Event",
        "tabEvent",
        `return eval(${JSON.stringify(closeRequest)})`,
      )(window, document, Event, tabEvent) === "handled";
  });
  return handled;
};

it("solo conversation bounds its hover surfaces inside its pane", async () => {
  const h = await page("solo");
  expect(h.composer.closest("[data-overlay-boundary]")).toBe(
    screen.getByRole("article", { name: "Conversation" }),
  );
});

it("solo composer retains side-tab cycling and close focus", async () => {
  const h = await page("solo");
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "b".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side"),
  );
  await h.open();
  const thread = screen.getByRole("tab", { name: "Thread · Alpha" });
  const notes = screen.getByRole("tab", { name: "Notes" });
  for (const [eventName, selected] of [
    ["buzz:next-tab", thread],
    ["buzz:previous-tab", notes],
  ] as const) {
    h.composer.focus();
    const event = new Event(eventName, { cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(selected).toHaveAttribute("aria-selected", "true");
  }
  h.composer.focus();
  expect(closeTabs("buzz:close-active-tab")).toBe(true);
  expect(notes).not.toBeInTheDocument();
  expect(thread).toHaveFocus();
});

it("leaves Shift+Escape (Mark all as read) to a side thread, closing it on Escape", async () => {
  const h = await page();
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "c".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side"),
  );
  const thread = await screen.findByRole("tab", { name: "Thread · Alpha" });
  expect(thread).toHaveAttribute("aria-selected", "true");
  const content = document.querySelector(
    `[id="${thread.getAttribute("aria-controls")}"] *`,
  );
  if (!content) throw new Error("The side thread has no content");
  fireEvent.keyDown(content, { key: "Escape", shiftKey: true });
  expect(thread).toBeInTheDocument();
  fireEvent.keyDown(content, { key: "Escape" });
  expect(thread).not.toBeInTheDocument();
});

it.each(["stream", "solo"] as const)(
  "the real %s page closes its side tabs by shortcut, preserves typing, and handles an empty repeat",
  async (type) => {
    const h = await page(type);
    await h.open();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    h.composer.focus();
    await h.user.keyboard("Keep typing");
    const modal = document.createElement("dialog");
    modal.open = true;
    document.body.append(modal);
    closeTabs();
    modal.remove();
    expect(
      screen.getByRole("tab", {
        name: "Notes",
      }),
    ).toBeInTheDocument();
    expect(closeTabs()).toBe(true);
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
    closeTabs();
    expect(h.composer).toHaveFocus();
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["stream", "solo"] as const)(
  "the real %s page returns focus when the menu's owning tab closes",
  async (type) => {
    const h = await page(type);
    await h.open();
    const notes = screen.getByRole("tab", {
      name: "Notes",
    });
    await h.user.pointer({ target: notes, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close all tabs" }),
    );
    expect(
      screen.queryByRole("tab", {
        name: "Notes",
      }),
    ).not.toBeInTheDocument();
    if (type === "stream")
      expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
    else
      expect(screen.getByRole("region", { name: "Chat Alpha" })).toHaveFocus();
  },
);

it("an empty tab menu returns keyboard focus to its surviving tab", async () => {
  const h = await page();
  const channel = within(
    screen.getByRole("tablist", { name: "Channel tabs" }),
  ).getByRole("tab", { name: "Alpha" });
  channel.focus();
  await h.user.keyboard("{Shift>}{F10}{/Shift}");
  const action = await screen.findByRole("menuitem", {
    name: "Close all tabs",
  });
  action.focus();
  await h.user.keyboard("{Enter}");
  expect(await screen.findByRole("tab", { name: "Alpha" })).toHaveFocus();
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});

it("the main tab's menu clears the real page's side tabs too", async () => {
  const h = await page();
  await h.open();
  const channel = within(
    screen.getByRole("tablist", { name: "Channel tabs" }),
  ).getByRole("tab", { name: "Alpha" });
  await h.user.pointer({ target: channel, keys: "[MouseRight]" });
  await h.user.click(
    await screen.findByRole("menuitem", { name: "Close all tabs" }),
  );
  expect(screen.queryByRole("tab", { name: "Notes" })).not.toBeInTheDocument();
  expect(channel).toHaveFocus();
});

it("close-all works while a main-pane thread covers the channel conversation", async () => {
  const h = await page();
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "a".repeat(64);
  act(() =>
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
  );
  expect(
    within(screen.getByRole("tablist", { name: "Channel tabs" })).getAllByRole(
      "tab",
    ),
  ).toHaveLength(2);
  expect(closeTabs()).toBe(true);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(screen.getByRole("tab", { name: "Alpha" })).toHaveFocus();
});

it.each([false, true])(
  "closing a side tab from the composer keeps typing and Enter there (another side tab=%s)",
  async (anotherTab) => {
    const h = await page();
    if (anotherTab) {
      const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
      const root = "b".repeat(64);
      act(() =>
        tabs.result.current.openThreadTab(
          "alpha",
          root,
          root,
          undefined,
          "side",
        ),
      );
    }
    await h.open();
    expect(screen.getByRole("tab", { name: "Notes" })).toBeInTheDocument();
    h.composer.focus();
    expect(closeTabs("buzz:close-active-tab")).toBe(true);
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("{Enter}");
    expect(
      screen.queryByRole("tab", { name: "Notes" }),
    ).not.toBeInTheDocument();
    expect(h.composer).toHaveFocus();
    await h.user.keyboard("Keep typing");
    expect(h.composer).toHaveTextContent("Keep typing");
  },
);

it.each(["side", "main"] as const)(
  "closing others from a %s tab keeps focus on it while the other pane's selected tab closes",
  async (kept) => {
    const h = await page();
    const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
    const root = "c".repeat(64);
    act(() =>
      tabs.result.current.openThreadTab("alpha", root, root, undefined, "main"),
    );
    await h.open();
    const main = within(screen.getByRole("tablist", { name: "Channel tabs" }));
    const thread = main.getAllByRole("tab")[1];
    if (!thread) throw new Error("missing main-pane thread tab");
    expect(thread).toHaveAttribute("aria-selected", "true");
    const target =
      kept === "side" ? screen.getByRole("tab", { name: "Notes" }) : thread;
    await h.user.pointer({ target, keys: "[MouseRight]" });
    await h.user.click(
      await screen.findByRole("menuitem", { name: "Close other tabs" }),
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(target).toBeInTheDocument();
    expect(target).toHaveAttribute("aria-selected", "true");
    expect(target).toHaveFocus();
  },
);

it("gives a Solo chat's side tab its own header actions, opening it in the main view", async () => {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const h = await page("stream", {
    open,
    snapshot: () => ({ entry: { id: "visit" }, attempt: {} }),
  } as unknown as Navigation);
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  expect(
    await screen.findByRole("button", { name: "Share access" }),
  ).toBeInTheDocument();
  await h.user.click(screen.getByRole("button", { name: "Chat actions" }));
  const menu = within(
    await screen.findByRole("menu", { name: "Chat actions" }),
  );
  expect(menu.getAllByRole("menuitem")[0]).toHaveTextContent(
    "Open in main view",
  );
  // No host beside another conversation can finish a conversion.
  expect(
    menu.queryByRole("menuitem", { name: "Convert to channel" }),
  ).toBeNull();
  await h.user.click(menu.getByRole("menuitem", { name: "Open in main view" }));
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope: {
        viewer: h.viewer,
        communityOrigin: h.scope.slice(0, -(h.viewer.length + 1)),
      },
      channelId: "gamma",
    }),
  );
  // A team channel's tab keeps the panel's own header.
  await h.user.click(screen.getByRole("tab", { name: "Beta" }));
  expect(screen.queryByRole("button", { name: "Chat actions" })).toBeNull();
});

it("keeps a side tab's failed move recoverable after switching tabs", async () => {
  const base = {
    status: "ready",
    data: {
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: {},
      starred: [],
      muted: [],
    },
  } as unknown as ReturnType<RelaySession["soloPreferences"]["snapshot"]>;
  let current = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const failed = {
    ...base,
    moves: [
      {
        id: 1,
        channelId: "gamma",
        destination: { sectionId: "work" },
        pending: false,
        error: "Relay unavailable",
      },
    ],
  } as unknown as typeof current;
  const retryMove = vi.fn(() => new Promise<never>(() => {}));
  const h = await page(
    "stream",
    {
      open: vi.fn(async () => ({ status: "opened" as const })),
      snapshot: () => ({ entry: { id: "visit" }, attempt: {} }),
    } as unknown as Navigation,
    false,
    undefined,
    {
      writable: true,
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      assign: vi.fn(async () => {
        publish(failed);
        throw new Error("Relay unavailable");
      }),
      retryMove,
    } as unknown as RelaySession["soloPreferences"],
  );
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  await h.user.click(
    await screen.findByRole("button", { name: "Chat actions" }),
  );
  (await screen.findByRole("menuitem", { name: "Move to" })).focus();
  await h.user.keyboard("{ArrowRight}");
  await h.user.click(await screen.findByRole("menuitem", { name: "Work" }));
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  // Gamma's toolbar unmounts, but the page still owns its recovery.
  await h.user.click(screen.getByRole("tab", { name: "Beta" }));
  expect(screen.queryByRole("button", { name: "Chat actions" })).toBeNull();
  expect(screen.getByText("Chat wasn’t moved")).toBeVisible();
  // Toasts own swipe gestures, so press their buttons without a pointer.
  fireEvent.click(screen.getByRole("button", { name: "Retry move" }));
  expect(retryMove).toHaveBeenCalledExactlyOnceWith("gamma");
  // Settled elsewhere, as by the sidebar's Dismiss, the move is no longer the
  // header's: a later failure it did not start raises no toast.
  act(() => publish(base));
  await vi.waitFor(() =>
    expect(screen.queryByText("Chat wasn’t moved")).toBeNull(),
  );
  act(() => publish(failed));
  expect(screen.queryByText("Chat wasn’t moved")).toBeNull();
});

it("keeps a newer header move recoverable after an earlier one succeeds", async () => {
  const base = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "home", name: "Home", order: 1 },
      ],
      assignments: {},
      starred: [],
      muted: [],
    },
  } as unknown as ReturnType<RelaySession["soloPreferences"]["snapshot"]>;
  let current = base;
  const listeners = new Set<() => void>();
  const publish = (next: typeof current) => {
    current = next;
    for (const listener of listeners) listener();
  };
  const move = (
    id: number,
    sectionId: string,
    state: { pending: true } | { pending: false; error: string },
  ) => ({ id, channelId: "gamma", destination: { sectionId }, ...state });
  const withMoves = (...moves: ReturnType<typeof move>[]) =>
    ({ ...base, moves }) as unknown as typeof current;
  // The store queues both writes; each settles only when the test says so.
  const settle: {
    resolve(): void;
    reject(error: Error): void;
  }[] = [];
  const queued: ReturnType<typeof move>[] = [];
  const assign = vi.fn(
    (_channelId: string, sectionId = "") =>
      new Promise<void>((resolve, reject) => {
        settle.push({ resolve, reject });
        queued.push(move(settle.length, sectionId, { pending: true }));
        publish(withMoves(...queued));
      }),
  );
  const h = await page(
    "stream",
    {
      open: vi.fn(async () => ({ status: "opened" as const })),
      snapshot: () => ({ entry: { id: "visit" }, attempt: {} }),
    } as unknown as Navigation,
    false,
    undefined,
    {
      writable: true,
      snapshot: () => current,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      assign,
      retryMove: vi.fn(() => new Promise<never>(() => {})),
    } as unknown as RelaySession["soloPreferences"],
  );
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:gamma", kind: "conversation", channelId: "gamma" },
    ]),
  );
  await h.user.click(await screen.findByRole("tab", { name: "Gamma" }));
  const moveTo = async (name: string) => {
    await h.user.click(
      await screen.findByRole("button", { name: "Chat actions" }),
    );
    (await screen.findByRole("menuitem", { name: "Move to" })).focus();
    await h.user.keyboard("{ArrowRight}");
    await h.user.click(await screen.findByRole("menuitem", { name }));
  };
  await moveTo("Work");
  await moveTo("Home");
  expect(settle).toHaveLength(2);
  // The earlier move succeeds while the newer one is still queued.
  await act(async () => {
    publish(withMoves(move(2, "home", { pending: true })));
    settle[0]?.resolve();
  });
  await act(async () => {
    publish(
      withMoves(
        move(2, "home", { pending: false, error: "Relay unavailable" }),
      ),
    );
    settle[1]?.reject(new Error("Relay unavailable"));
  });
  expect(await screen.findByText("Chat wasn’t moved")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry move" })).toBeVisible();
});

it("opens another conversation's tab in its channel, but not the current channel's threads", async () => {
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const h = await page("stream", {
    open,
    snapshot: () => ({ entry: { id: "visit" }, attempt: {} }),
  } as unknown as Navigation);
  const tabs = renderHook(() => useChannelTabState(h.session, "alpha"));
  const root = "d".repeat(64);
  act(() => {
    tabs.result.current.openThreadTab("alpha", root, root, undefined, "side");
    tabs.result.current.setTabs((items) => [
      ...items,
      { id: "conversation:beta", kind: "conversation", channelId: "beta" },
    ]);
  });
  const menu = async (name: string) => {
    await h.user.pointer({
      target: await screen.findByRole("tab", { name }),
      keys: "[MouseRight]",
    });
    return within(await screen.findByRole("menu"));
  };
  expect(
    (await menu("Thread · Alpha")).queryByRole("menuitem", {
      name: "Open in channel",
    }),
  ).not.toBeInTheDocument();
  await h.user.keyboard("{Escape}");
  await h.user.click(
    (await menu("Beta")).getByRole("menuitem", { name: "Open in channel" }),
  );
  const scope = {
    viewer: h.viewer,
    communityOrigin: h.scope.slice(0, -(h.viewer.length + 1)),
  };
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
    }),
  );
  // A tab whose id was taken keeps its root before a suffix in its own id.
  const other = "e".repeat(64);
  act(() =>
    tabs.result.current.setTabs((items) => [
      ...items,
      {
        id: `thread:beta:${other}:${crypto.randomUUID()}`,
        kind: "thread",
        channelId: "beta",
        messageId: other,
      },
    ]),
  );
  await h.user.click(
    (await menu("Thread · Beta")).getByRole("menuitem", {
      name: "Open in channel",
    }),
  );
  await vi.waitFor(() =>
    expect(open).toHaveBeenLastCalledWith({
      version: 1,
      kind: "conversation",
      scope,
      channelId: "beta",
      messageId: other,
      threadRootId: other,
    }),
  );
});
