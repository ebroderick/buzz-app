import { SEARCH_DEBOUNCE_MS } from "../../shared/search-debounce";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { createRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { type Filter, matchFilter } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import {
  bindNames,
  type IdentityNames,
} from "../../features/identity-names/service";
import { createAgentDirectory } from "../../features/identity-names/testing";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { eventDto } from "../../features/relay/events";
import { ReadError } from "../../features/relay/errors";
import {
  keypair,
  message,
  metadata,
  profile,
  roster,
  scriptedTransport,
  signed,
} from "../../features/relay/testing";
import type { LiveCallbacks } from "../../features/relay/live";
import type { AppServices } from "../services";
import { SearchResults } from "./SearchResults";
import { useSearchSettings } from "./SearchSettings";
import {
  readSearchUsage,
  recordChoice,
  recordVisit,
} from "../../features/search/usage";
import { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { clearViewScope, writeView } from "../../shared/view-state";

// jsdom lacks scrollIntoView; the palette reveals its typed-text selection.
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

it("keeps a joined private Guest channel in recents without calling it public or unjoined", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "guest", "Private updates", 1700000000, [["private"]]),
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", "guest"],
        ["p", viewer.pubkey, "", "guest"],
      ],
    }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query: async (filters) =>
      discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      ),
  });
  const props = {
    session: owner.session,
    onQueryChange() {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: vi.fn(),
  };
  try {
    const mounted = render(<SearchResults {...props} query="" />);
    const recent = await screen.findByRole("group", {
      name: "Recent activity",
    });
    expect(
      within(recent).getByRole("option", { name: /Private updates/ }),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} query="Private" />);
    expect(
      await screen.findByRole("option", { name: /Private updates/ }),
    ).toHaveTextContent("Conversation");
    expect(
      screen.queryByText("Public channel · not joined"),
    ).not.toBeInTheDocument();
    expect(owner.session.channels.get?.("guest")).toMatchObject({
      readOnly: true,
      viewerRole: "guest",
      visibility: "private",
    });
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens with a conversation action and recent channels in activity order", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "older", "older", 1700000000),
    roster(relay, "older", [viewer.pubkey]),
    metadata(relay, "latest", "latest", 1700000100),
    roster(relay, "latest", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query=""
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="older"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    const action = await screen.findByRole("option", {
      name: /Search in older/,
    });
    const recent = within(
      screen.getByRole("group", { name: "Recent activity" }),
    );
    const [first, second] = recent.getAllByRole("option");
    expect(first).toHaveTextContent("latest");
    expect(second).toHaveTextContent("older");
    fireEvent.click(action);
    expect(changeScope).toHaveBeenCalledExactlyOnceWith("older");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("ranks typed channel names and selects the best one for Enter", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  // Weak matches come first in list order and exceed the eight-row limit.
  const names = [
    ...Array.from({ length: 8 }, (_, index) => `xlar-${index}`),
    "the-lar",
    "lar-crew",
    "lar",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="xlar-0"
        onScopeChange={() => {}}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(8),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .slice(0, 4)
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^lar/),
      expect.stringMatching(/^lar-crew/),
      expect.stringMatching(/^the-lar/),
      expect.stringMatching(/^xlar-/),
    ]);
    // The scope action follows named results, so it is not selected first.
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.indexOf("This conversation")).toBeGreaterThan(
      groups.indexOf("Channels"),
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      within(channels).getAllByRole("option")[0]?.id,
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("lar");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("fuzzy-matches channel names after substring matches, word starts first", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "big-grape",
    "buzz-github-prs",
    "debug-pr",
    "general",
    "ops-bgp",
  ];
  const discovery = names.flatMap((name, index) => [
    metadata(relay, name, name, 1700000000 + index),
    roster(relay, name, [viewer.pubkey]),
  ]);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="bgp"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    // The substring match leads. Initials ("b"uzz-"g"ithub-"p"rs) come next,
    // then names that merely hold the letters in order. "general" has no "b".
    await waitFor(() =>
      expect(
        within(channels)
          .getAllByRole("option")
          .map((option) => option.textContent?.split(/[A-Z]/)[0]),
      ).toEqual([
        "ops-bgp",
        "buzz-github-prs",
        expect.stringMatching(/^(big-grape|debug-pr)$/),
        expect.stringMatching(/^(big-grape|debug-pr)$/),
      ]),
    );
    // The matched letters are underlined, and only those letters.
    const marks = (name: string) =>
      [
        ...within(channels)
          .getByRole("option", { name: new RegExp(`^${name}`) })
          .querySelectorAll("mark"),
      ].map((mark) => mark.textContent);
    expect(marks("ops-bgp")).toEqual(["bgp"]);
    expect(marks("buzz-github-prs")).toEqual(["b", "g", "p"]);
    expect(marks("debug-pr")).toEqual(["b", "g", "p"]);
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("ops-bgp");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("leads with the group holding the best match and ranks archived channels after live ties", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "space", "team-workspace", 1700000000),
    roster(relay, "space", [viewer.pubkey]),
    signed(relay, {
      kind: 39000,
      created_at: 1700000001,
      content: "",
      tags: [
        ["d", "old"],
        ["t", "stream"],
        ["name", "work-old"],
        ["archived", "true"],
      ],
    }),
    roster(relay, "old", [viewer.pubkey]),
    metadata(relay, "log", "work-log", 1700000002),
    roster(relay, "log", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    },
  });
  const work = vi.fn();
  const page = (label: string, run = () => {}) => ({
    key: label,
    label,
    icon: ChatCircleIcon,
    run,
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="work"
        onQueryChange={() => {}}
        input={createRef()}
        // PageSearch ranks pages before they arrive here.
        pages={[page("Work", work), page("Workflows")]}
        openConversation={() => {}}
      />,
    );
    const channels = await screen.findByRole("group", { name: "Channels" });
    await waitFor(() =>
      expect(within(channels).getAllByRole("option")).toHaveLength(3),
    );
    expect(
      within(channels)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([
      expect.stringMatching(/^work-log/),
      expect.stringMatching(/^work-old/),
      expect.stringMatching(/^team-workspace/),
    ]);
    const groups = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(groups.slice(0, 2)).toEqual(["Pages", "Channels"]);
    const pages = screen.getByRole("group", { name: "Pages" });
    expect(
      within(pages)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Work", "Workflows"]);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(work).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows the real read failure, retains conversation choices, and retries to an exact message", async () => {
  vi.useFakeTimers();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "wes-crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      // Message search is scripted; the People directory finds nobody.
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wes-cr"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9], // The real reader canonicalizes set order.
        search: "wes-cr",
        search_mode: "prefix",
        limit: 20,
      },
    ]);
    await act(async () =>
      request.fail(
        new ReadError("invalid-response", "Relay response was invalid"),
      ),
    );
    expect(
      screen.getByText(
        /Message search couldn’t finish: Relay response was invalid/,
      ),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: /wes-crew/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry messages" }));
    expect(screen.queryByText(/Message search couldn’t finish/)).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    const hit = message(viewer, "crew", "wes-crew exact message", 1700000001);
    await act(async () => wire.next().respond([hit]));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    // Typed text selects the first result; the late message sits below it.
    expect(
      screen.getByRole("option", { name: /^wes-crew(?! exact)/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", { name: /wes-crew exact message/ }),
    ).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("scopes conversation search at the relay and discards out-of-scope hits", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const changeScope = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        onScopeChange={changeScope}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "scope",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
      },
    ]);
    await act(async () =>
      request.respond([
        message(viewer, "crew", "scope match", 1700000001),
        message(viewer, "other", "scope elsewhere", 1700000002),
      ]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /scope elsewhere/ }),
    ).toBeNull();
    // A relay without `buzz-search-sort` would rank "Most recent" anyway.
    expect(screen.queryByRole("button", { name: "Sort messages" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /Remove .* search scope/ }),
    );
    expect(changeScope).toHaveBeenCalledExactlyOnceWith();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers more messages in overall search when the first page shows none", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      // Message reads are scripted; the people directory finds no one.
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="scope"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // A full page of hits in conversations search does not show.
    const first = wire.next();
    await act(async () =>
      first.respond(
        Array.from({ length: 20 }, (_, i) =>
          message(viewer, "unknown", `scope hidden ${i}`, 1700000100 - i),
        ),
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: "Show more messages" }));
    const second = wire.next();
    expect(second.filters).toEqual([
      expect.objectContaining({ search: "scope", page: 2 }),
    ]);
    await act(async () =>
      second.respond([message(viewer, "crew", "scope match", 1700000001)]),
    );
    expect(screen.getByRole("option", { name: /scope match/ })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Show more messages" }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("sorts a conversation newest first across pages and restarts paging when the order changes", async () => {
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    metadata(relay, "other", "other"),
    roster(relay, "other", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    searchSort: true,
    query(filters, signal) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const request = async () => {
    await waitFor(() => expect(wire.pending).toHaveLength(1));
    return wire.next();
  };
  const hits = (count: number, newest: number) =>
    Array.from({ length: count }, (_, n) =>
      message(viewer, "crew", `sortword ${newest - n}`, newest - n),
    );
  const rows = () =>
    within(screen.getByRole("listbox", { name: "Search results" }))
      .getAllByRole("option")
      .map((option) => option.textContent);
  const scoped = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    scopedChannelId: "crew",
    onScopeChange: () => {},
    openConversation: () => {},
  };
  const text = {
    kinds: [40002, 40008, 9],
    search: "sortword",
    search_mode: "prefix",
    limit: 20,
    "#h": ["crew"],
  };
  try {
    const mounted = render(<SearchResults {...scoped} query="sortword" />);
    const relevance = await request();
    expect(relevance.filters).toEqual([text]);
    await act(async () => relevance.respond(hits(20, 1700000020)));
    expect(screen.getByRole("group", { name: "Most relevant" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Sort messages" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Most relevant" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Most recent" }));
    const first = await request();
    expect(first.filters).toEqual([{ ...text, search_sort: "newest" }]);
    const page1 = hits(20, 1700000100);
    const tail = page1.pop();
    assert(tail);
    // Order two signed hits instead of searching random hashes for a lower id.
    const [tie, last] = [
      tail,
      message(viewer, "crew", "sortword tie", tail.created_at),
    ].sort((a, b) => (a.id < b.id ? -1 : 1));
    assert(tie && last);
    page1.push(last);
    await act(async () => first.respond(page1));
    expect(screen.getByRole("group", { name: "Most recent" })).toBeVisible();
    expect(rows().at(-1)).toMatch(/Show more messages/);

    fireEvent.click(screen.getByRole("option", { name: /Show more messages/ }));
    const failed = await request();
    expect(failed.filters).toEqual([
      { ...text, search_sort: "newest", page: 2 },
    ]);
    await act(async () =>
      failed.fail(
        new ReadError("invalid-response", "Relay response was invalid"),
      ),
    );
    expect(
      screen.getByText(
        "More messages couldn’t load: Relay response was invalid",
      ),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /Show more messages/ }));
    const second = await request();
    expect(second.filters).toEqual([
      { ...text, search_sort: "newest", page: 2 },
    ]);
    // Offsets drift: a repeat, a backdated tie that sorts before it by id,
    // and an out-of-scope hit.
    const older = hits(2, last.created_at - 1);
    await act(async () =>
      second.respond([
        last,
        tie,
        message(viewer, "other", "sortword elsewhere", 1700000200),
        ...older,
      ]),
    );
    expect(screen.queryByText(/More messages couldn’t load/)).toBeNull();
    const ordered = [...page1, tie, ...older].sort(
      (a, b) =>
        b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    expect(rows()).toHaveLength(ordered.length);
    for (const [index, row] of rows().entries())
      expect(row).toContain(ordered[index]?.content);

    // Without text the relay reads newest-first history; there is no choice.
    mounted.rerender(<SearchResults {...scoped} query="before:2026-10-01" />);
    const history = await request();
    expect(history.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        limit: 20,
        "#h": ["crew"],
        until: expect.any(Number),
      },
    ]);
    await act(async () => history.respond(hits(1, 1700000001)));
    expect(screen.getByRole("group", { name: "Most recent" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sort messages" })).toBeNull();

    mounted.rerender(<SearchResults {...scoped} query="sortword" />);
    const resumed = await request();
    expect(resumed.filters).toEqual([{ ...text, search_sort: "newest" }]);
    await act(async () => resumed.respond(hits(20, 1700000100)));

    // Global search has no sort control, so it keeps relevance.
    const { scopedChannelId: _, ...unscoped } = scoped;
    mounted.rerender(<SearchResults {...unscoped} query="sortword" />);
    const global = await request();
    const { "#h": __, ...unscopedText } = text;
    expect(global.filters).toEqual([unscopedText]);
    await act(async () => global.respond(hits(1, 1700000001)));
    expect(screen.getByRole("group", { name: "Most relevant" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Sort messages" })).toBeNull();

    mounted.rerender(<SearchResults {...scoped} query="sortword" />);
    const rescoped = await request();
    expect(rescoped.filters).toEqual([{ ...text, search_sort: "newest" }]);
    await act(async () => rescoped.respond(hits(20, 1700000100)));
    fireEvent.click(screen.getByRole("button", { name: "Sort messages" }));
    fireEvent.click(
      await screen.findByRole("menuitemradio", { name: "Most relevant" }),
    );
    const reset = await request();
    expect(reset.filters).toEqual([text]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["metadata", "denial"])(
  "does not resurrect displayed public hits after %s loss and regrant",
  async (loss) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const hit = message(viewer, "open", "crew public result", 1700000000);
    let live: LiveCallbacks | undefined;
    const metadata = (privateChannel: boolean, created_at: number) =>
      signed(relay, {
        kind: 39000,
        created_at,
        content: "",
        tags: [
          ["d", "open"],
          ["name", "Public"],
          [privateChannel ? "private" : "public"],
        ],
      });
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.search)
          ? [hit]
          : filters.some((filter) => filter.kinds?.includes(39000))
            ? [metadata(false, 1700000000)]
            : [];
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, retry() {}, dispose() {} };
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(
        screen.getByRole("option", { name: /crew public result/ }),
      ).toBeVisible();
      const before = owner.session.channels.list();
      act(() => {
        if (loss === "denial")
          live?.denied("open", "restricted: not a channel member");
        else live?.receive([metadata(true, 1700000001)]);
        const denied = owner.session.channels.list();
        expect(denied).not.toBe(before);
        expect(denied.channels).toBe(before.channels);
        live?.receive([metadata(false, 1700000002)]);
      });
      expect(
        screen.queryByRole("option", { name: /crew public result/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not reveal a revoked public hit queued before React commits its result", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const hit = message(viewer, "open", "crew queued result", 1700000000);
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live: LiveCallbacks | undefined;
  const publicEvent = (created_at: number) =>
    signed(relay, {
      kind: 39000,
      created_at,
      content: "",
      tags: [["d", "open"], ["public"]],
    });
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        filters.some((filter) => filter.kinds?.includes(39000))
          ? [publicEvent(1700000000)]
          : [],
      );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      wire.next().respond([hit]);
      // Drain the finite reader and palette's promise callback, without a React commit.
      await vi.advanceTimersByTimeAsync(0);
      live?.denied("open", "restricted: not a channel member");
      live?.receive([publicEvent(1700000001)]);
    });
    expect(
      screen.queryByRole("option", { name: /crew queued result/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["", "Crew"])(
  "explains cold conversation loading without redundant banners (query=%s)",
  async (query) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "crew", "Crew"),
      roster(relay, "crew", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      query(filters, signal) {
        return filters.some((filter) => filter.kinds?.includes(39002))
          ? wire.transport.query(filters, signal)
          : Promise.resolve(discovery);
      },
    });
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[
            {
              key: "settings",
              label: "Settings",
              icon: ChatCircleIcon,
              run() {},
            },
          ]}
          openConversation={() => {}}
        />,
      );
      const pending = wire.next();
      expect(owner.session.channels.list().status).toBe("loading");
      if (query)
        expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      else
        expect(screen.queryByRole("option", { name: /Settings/ })).toBeNull();
      if (query) {
        expect(screen.getByText("Loading joined conversations…")).toBeVisible();
        expect(screen.queryByText("Loading recent conversations…")).toBeNull();
      } else {
        expect(screen.getByText("Loading recent conversations…")).toBeVisible();
        expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      }
      await act(async () => pending.respond(discovery));
      expect(await screen.findByRole("option", { name: /Crew/ })).toBeVisible();
      expect(screen.queryByText("Loading joined conversations…")).toBeNull();
      if (query)
        expect(screen.getByRole("option", { name: /Settings/ })).toBeVisible();
      else
        expect(screen.queryByRole("option", { name: /Settings/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("does not announce conversation enrichment over retained search choices", () => {
  const owner = createRelaySession(null);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      list: () => list,
      ensureList() {},
    },
  };
  const list = {
    status: "loading" as const,
    channels: [{ id: "crew", name: "Crew", channelType: "stream" as const }],
  };
  try {
    render(
      <SearchResults
        session={session}
        query="Crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: /Crew/ })).toBeVisible();
    expect(screen.queryByText("Loading joined conversations…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["stream", "forum", "solo"] as const)(
  "finds joined archived %s channels by name without putting them in Recent activity",
  async (channelType) => {
    const relay = keypair(),
      viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      signed(relay, {
        kind: 39000,
        created_at: 1700000000,
        content: "",
        tags: [
          ["d", "archive"],
          ["t", channelType === "solo" ? "stream" : channelType],
          ...(channelType === "solo" ? [["private"], ["t", "buzz.solo"]] : []),
          ["name", "Past project"],
          ["archived", "true"],
        ],
      }),
      roster(relay, "archive", [viewer.pubkey]),
      metadata(relay, "active", "Current project"),
      roster(relay, "active", [viewer.pubkey]),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        return discovery.filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        );
      },
    });
    const open = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: open,
    };
    try {
      const mounted = render(<SearchResults {...props} query="" />);
      await screen.findByRole("option", { name: /Current project/ });
      expect(owner.session.channels.get?.("archive")?.channelType).toBe(
        channelType,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
      mounted.rerender(<SearchResults {...props} query="Past" />);
      fireEvent.click(
        await screen.findByRole("option", {
          name: /Past project/,
        }),
      );
      expect(
        screen.getByText(
          channelType === "solo"
            ? "Archived chat"
            : "Archived channel · 1 member",
        ),
      ).toBeTruthy();
      expect(open).toHaveBeenCalledExactlyOnceWith("archive");
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  { channelType: "stream", readOnly: true },
  { channelType: "forum", readOnly: true },
  { channelType: "solo", readOnly: true },
  { channelType: "dm" },
] as const)(
  "does not surface archived nonmember or non-channel destinations: %j",
  (state) => {
    const owner = createRelaySession(null);
    const snapshot = {
      status: "ready" as const,
      channels: [
        {
          id: "excluded",
          name: "Past project",
          archived: true as const,
          ...state,
        },
      ],
    };
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        list: () => snapshot,
        ensureList() {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="Past"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      expect(screen.queryByRole("option", { name: /Past project/ })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("shows each channel result's member count, reading an unjoined channel's roster for display only", async () => {
  const relay = keypair();
  const viewer = keypair();
  const [first, second, third] = [keypair(), keypair(), keypair()];
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey, first.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [first.pubkey, second.pubkey, third.pubkey]),
    metadata(relay, "solo-room", "crew-solo", 1700000000, open),
    roster(relay, "solo-room", [second.pubkey]),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const group = () => within(screen.getByRole("group", { name: "Channels" }));
    await waitFor(() =>
      expect(
        group()
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Conversation · 2 members"),
        expect.stringContaining("Public channel · not joined · 3 members"),
        expect.stringContaining("Public channel · not joined · 1 member"),
      ]),
    );
    // The joined row counts the roster it carries; only unjoined rows read,
    // without the viewer filter, so their rosters stay out of discovery.
    expect(reads).toContainEqual([
      {
        kinds: [39002],
        authors: [relay.pubkey],
        "#d": ["lobby", "solo-room"],
        limit: 2,
      },
    ]);
    expect(owner.session.channels.get?.("lobby")?.members).toEqual([]);
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds active public channels the viewer has not joined without adding them to the joined list", async () => {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "crew-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
    metadata(relay, "secret", "crew-secret", 1700000000, [
      ["private", ""],
      ["t", "stream"],
    ]),
    metadata(relay, "old", "crew-old", 1700000000, [
      ...open,
      ["archived", "true"],
    ]),
    metadata(relay, "dm", "crew-dm", 1700000000, [
      ["public", ""],
      ["hidden", ""],
      ["t", "dm"],
    ]),
    // Only relay-signed metadata is channel authority.
    metadata(other, "forged", "crew-forged", 1700000000, open),
  ];
  const reads: unknown[] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      reads.push(filters);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(lobby).toHaveTextContent("Public channel · not joined");
    const group = within(screen.getByRole("group", { name: "Channels" }));
    expect(
      group.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      expect.stringContaining("crew-chat"),
      expect.stringContaining("crew-lobby"),
    ]);
    for (const hidden of ["crew-secret", "crew-old", "crew-dm", "crew-forged"])
      expect(
        screen.queryByRole("option", { name: new RegExp(hidden) }),
      ).toBeNull();
    // The match resolved through exact signed metadata and the viewer roster.
    expect(reads).toContainEqual([
      expect.objectContaining({ kinds: [39000], "#d": ["lobby"] }),
      expect.objectContaining({
        kinds: [39002],
        "#d": ["lobby"],
        "#p": [viewer.pubkey],
      }),
    ]);
    expect(owner.session.channels.get?.("lobby")).toMatchObject({
      readOnly: true,
      name: "crew-lobby",
    });
    expect(
      owner.session.channels.list().channels.map((channel) => channel.id),
    ).toEqual(["joined"]);
    fireEvent.click(lobby);
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([false, true])(
  "delays People feedback with existing rows=%s and clears it on completion",
  async (populated) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair(),
      person = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    const t = peopleSession(
      owner.session,
      populated ? [{ pubkey: person.pubkey, name: "Crew person" }] : [],
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const people = vi.fn(async (query?: string) => {
      if (populated && query === "cre")
        return {
          people: [{ pubkey: person.pubkey, name: "Crew person" }],
          hasMore: false,
        };
      await held;
      return { people: [], hasMore: false };
    });
    const session = {
      ...t.session,
      directMessages: { ...t.session.directMessages, people },
    };
    try {
      const props = {
        session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openConversation: () => {},
      };
      const view = render(
        <SearchResults
          session={session}
          query={populated ? "cre" : "crew"}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      if (populated) {
        await act(async () => vi.advanceTimersByTimeAsync(300));
        expect(screen.getByRole("group", { name: "People" })).toHaveTextContent(
          "Crew person",
        );
        view.rerender(<SearchResults {...props} query="crew" />);
      }
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(people).toHaveBeenCalledTimes(populated ? 2 : 1);
      expect(screen.queryByText("· Searching…")).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      const group = screen.getByRole("group", { name: "People" });
      expect(
        within(group).getByRole("heading", { name: "People" }),
      ).toHaveTextContent("People · Searching…");
      expect(within(group).queryAllByRole("option")).toHaveLength(
        populated ? 1 : 0,
      );
      expect(group.querySelector(".search-palette-group-empty")).toBeNull();
      if (populated) expect(group).not.toHaveAttribute("aria-busy");
      else expect(group).toHaveAttribute("aria-busy", "true");
      expect(screen.getByRole("status")).toHaveTextContent("Searching people…");
      await act(async () => release());
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each([false, true])(
  "delays message heading feedback in scoped=%s search",
  async (scoped) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readPage = vi.fn(async () => {
      await held;
      return { events: [], relayCount: 0 };
    });
    const channel = {
      id: "crew",
      name: "Crew",
      channelType: "stream" as const,
    };
    const session = {
      ...owner.session,
      readPage,
      channels: {
        ...owner.session.channels,
        get: () => channel,
        resolve: async () => {},
      },
    };
    try {
      render(
        <SearchResults
          session={session}
          query="crew"
          scopedChannelId={scoped ? "crew" : undefined}
          onQueryChange={() => {}}
          input={createRef()}
          pages={
            scoped
              ? []
              : [
                  {
                    key: "page:crew",
                    label: "Crew page",
                    icon: ChatCircleIcon,
                    run: () => {},
                  },
                ]
          }
          openConversation={() => {}}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(999));
      expect(readPage).toHaveBeenCalledOnce();
      expect(screen.queryByRole("group", { name: "Most relevant" })).toBeNull();
      expect(
        screen.queryByText("No matching messages in accessible conversations."),
      ).toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      const group = screen.getByRole("group", { name: "Most relevant" });
      expect(within(group).getByText("· Searching…")).toBeVisible();
      expect(group.querySelector(".search-palette-group-empty")).toBeNull();
      if (!scoped)
        expect(screen.getByRole("group", { name: "Pages" })).toBeVisible();
      await act(async () => release());
      expect(screen.queryByRole("status")).toBeNull();
      if (scoped)
        expect(
          screen.getByText("No matching messages in accessible conversations."),
        ).toBeVisible();
      else
        expect(
          screen.queryByRole("group", { name: "Most relevant" }),
        ).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["crew after:", "crew from:"])(
  "announces no hidden result lookups behind the %s picker",
  async (query) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const searchPublic = vi.fn(async () => {
      await held;
      return { channels: [], partial: false };
    });
    const readPage = vi.fn(async () => {
      await held;
      return { events: [], relayCount: 0 };
    });
    const session = {
      ...owner.session,
      readPage,
      channels: { ...owner.session.channels, searchPublic },
    };
    try {
      render(
        <SearchResults
          session={session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(searchPublic).toHaveBeenCalled();
      expect(
        screen.getByRole("group", {
          name: query.endsWith("after:") ? "Dates" : "People",
        }),
      ).toBeVisible();
      expect(screen.queryByText(/· Searching…/)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      release();
      cleanup();
      owner.dispose();
    }
  },
);

it.each([false, true])(
  "freezes the announcement with simultaneous sources=%s",
  async (simultaneous) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: async () => [],
    });
    let releaseChannels!: () => void, releasePeople!: () => void;
    const channelsHeld = new Promise<void>((resolve) => {
      releaseChannels = resolve;
    });
    const peopleHeld = new Promise<void>((resolve) => {
      releasePeople = resolve;
    });
    const t = peopleSession(owner.session);
    const session = {
      ...t.session,
      channels: {
        ...t.session.channels,
        searchPublic: async () => {
          await channelsHeld;
          return { channels: [], partial: false };
        },
      },
      directMessages: {
        ...t.session.directMessages,
        people: async (query?: string) => {
          if (simultaneous || query === "crew") await peopleHeld;
          return { people: [], hasMore: false };
        },
      },
    };
    const props = {
      session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: () => {},
    };
    try {
      const view = render(<SearchResults {...props} query="cre" />);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      const expected = simultaneous
        ? "Searching channels and people…"
        : "Searching channels…";
      expect(screen.getByRole("status")).toHaveTextContent(expected);
      if (!simultaneous) {
        view.rerender(<SearchResults {...props} query="crew" />);
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(
          within(screen.getByRole("group", { name: "People" })).getByText(
            "· Searching…",
          ),
        ).toBeVisible();
        expect(screen.getByRole("status")).toHaveTextContent(expected);
      }
      await act(async () => releaseChannels());
      expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
      expect(screen.getByRole("status")).toHaveTextContent(expected);
      await act(async () => releasePeople());
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      releaseChannels();
      releasePeople();
      cleanup();
      owner.dispose();
    }
  },
);

it("shows a delayed Channels group only while an empty directory read is pending", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  const searchPublic = vi.fn(async () => {
    await held;
    return { channels: [], partial: false };
  });
  const session = {
    ...owner.session,
    channels: { ...owner.session.channels, searchPublic },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(searchPublic).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    const group = screen.getByRole("group", { name: "Channels" });
    expect(within(group).getByText("· Searching…")).toBeVisible();
    expect(within(group).queryByRole("option")).toBeNull();
    expect(group).not.toHaveTextContent("No matching results.");
    expect(
      within(group).getByRole("heading", { name: "Channels" }),
    ).toHaveTextContent("Channels · Searching…");
    expect(group.querySelector(".search-palette-group-empty")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("listbox")).not.toContainElement(
      screen.getByRole("status"),
    );
    expect(screen.getByRole("status")).toHaveClass("sr-only");
    await act(async () => release());
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("keeps a selected person and the delayed notice when channel results stream in", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    person = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  const t = peopleSession(owner.session, [
    { pubkey: person.pubkey, name: "Crew member" },
  ]);
  const channel = {
    id: "crew",
    name: "crew",
    readOnly: true as const,
    channelType: "stream" as const,
  };
  let progress!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const searchPublic: NonNullable<
    typeof owner.session.channels.searchPublic
  > = async (_query, options) => {
    progress = () =>
      options?.progress?.({ channels: [channel], partial: false });
    await held;
    return { channels: [channel], partial: false };
  };
  const session = {
    ...t.session,
    channels: {
      ...t.session.channels,
      searchPublic,
      get: (id: string) =>
        id === channel.id ? channel : t.session.channels.get?.(id),
    },
  };
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const field = screen.getByRole("combobox", { name: "Search Buzz" });
    const personRow = within(
      screen.getByRole("group", { name: "People" }),
    ).getByRole("option");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(personRow).toHaveAttribute("aria-selected", "true");
    const status = screen.getByRole("status");
    expect(
      within(screen.getByRole("group", { name: "Channels" })).queryByRole(
        "option",
      ),
    ).toBeNull();
    await act(async () => progress());
    const channels = screen.getByRole("group", { name: "Channels" });
    expect(
      within(channels).getByRole("option", { name: /^crew/ }),
    ).toBeVisible();
    expect(within(channels).getByText("· Searching…")).toBeVisible();
    expect(screen.getByRole("status")).toBe(status);
    expect(
      screen
        .getAllByRole("group")
        .slice(0, 2)
        .map((group) => group.getAttribute("aria-label")),
    ).toEqual(["Channels", "People"]);
    expect(personRow).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(field, { key: "Enter" });
    await act(async () => {});
    expect(t.open).toHaveBeenCalledExactlyOnceWith(
      [person.pubkey],
      expect.any(AbortSignal),
    );
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("started-dm");
    await act(async () => release());
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(channels).queryByText("· Searching…")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it.each(["finish", "fail"])(
  "shows open channels from the first directory page while older pages load, and keeps them when they %s",
  async (outcome) => {
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const open = (id: string) =>
      metadata(relay, id, id, 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]);
    // A full first page, so the directory read goes on to an older one.
    const discovery = [
      open("crew-lobby"),
      ...Array.from({ length: 499 }, (_, i) => open(`extra-${i}`)),
    ];
    let older!: (failed: boolean) => void;
    const held = new Promise<boolean>((resolve) => (older = resolve));
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.before_id !== undefined)) {
          if (await held) throw new Error("Relay read failed (500)");
          return [];
        }
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    try {
      vi.useFakeTimers();
      const props = {
        session: owner.session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openConversation: () => {},
      };
      const mounted = render(<SearchResults {...props} query="crew" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(
        screen.getByRole("option", { name: /crew-lobby/ }),
      ).toHaveTextContent("Public channel · not joined");
      // The read's feedback waits a second; its rows do not.
      expect(screen.queryByRole("status")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByRole("status")).toHaveTextContent(
        "Searching channels…",
      );
      const channels = screen.getByRole("group", { name: "Channels" });
      const notice = within(channels).getByText("· Searching…");
      expect(notice.closest("h2")).toHaveTextContent("Channels · Searching…");
      expect(notice).toHaveAttribute("aria-hidden", "true");
      expect(channels.querySelector(".search-palette-group-empty")).toBeNull();
      expect(within(channels).getAllByRole("option")).toHaveLength(1);
      expect(
        within(channels).getByRole("option").compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_PRECEDING,
      ).toBeTruthy();
      expect(screen.getByRole("listbox")).not.toContainElement(
        screen.getByRole("status"),
      );
      // Narrowing the query while older pages load keeps the row.
      mounted.rerender(<SearchResults {...props} query="crew-l" />);
      expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "Searching channels…",
      );
      older(outcome === "fail");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
      });
      expect(screen.queryByRole("status")).toBeNull();
      expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
      if (outcome === "fail")
        expect(
          screen.getByText(/Public channel search couldn’t finish/),
        ).toBeVisible();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("keeps the open-channel search notice silent when the directory answers within a second", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  // The match's exact resolution is the warm directory's one round trip.
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter["#d"])) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option", { name: /crew-lobby/ })).toBeNull();
    expect(screen.queryByText("Searching channels…")).toBeNull();
    await act(async () => resolved());
    expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.queryByText("Searching channels…")).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens the open channel that lands after an early Enter, without first saying nothing matched", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter["#d"])) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option")).toBeNull();
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter for an open channel over a message that lands first, and for a message once channels settle empty", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "general", "general"),
    roster(relay, "general", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      if (filters.some((filter) => filter["#d"]?.includes("lobby"))) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation,
    };
    const mounted = render(<SearchResults {...props} query="crew" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () =>
      wire
        .next()
        .respond([message(viewer, "general", "crew news", 1700000001)]),
    );
    expect(screen.getByRole("option", { name: /crew news/ })).toBeVisible();
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
    // With no channel to wait for, Enter waits for message search instead.
    mounted.rerender(<SearchResults {...props} query="news" />);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(openConversation).toHaveBeenCalledOnce();
    const news = message(viewer, "general", "news", 1700000002);
    await act(async () => wire.next().respond([news]));
    expect(openConversation).toHaveBeenLastCalledWith("general", news.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens an open channel from the first directory page after an early Enter, while older pages load", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = (id: string) =>
    metadata(relay, id, id, 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]);
  // A full first page, so the directory read goes on to an older one.
  const discovery = [
    open("crew-lobby"),
    ...Array.from({ length: 499 }, (_, i) => open(`extra-${i}`)),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (filters.some((filter) => filter.before_id !== undefined))
        return new Promise(() => {});
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // Neither the older directory page nor message search has answered.
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("crew-lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter on the scope action for an open channel, and scopes once chosen or settled", async () => {
  vi.useFakeTimers();
  const relay = keypair();
  const viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "general", "general"),
    roster(relay, "general", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
    roster(relay, "lobby", [keypair().pubkey]),
  ];
  let resolved!: () => void;
  const held = new Promise<void>((release) => (resolved = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters, signal) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return wire.transport.query(filters, signal);
      if (filters.some((filter) => filter["#d"]?.includes("lobby"))) await held;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  const changeScope = vi.fn();
  const enter = (key = "Enter") =>
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key,
    });
  try {
    const props = {
      session: owner.session,
      onQueryChange: () => {},
      input: createRef<HTMLInputElement>(),
      pages: [],
      currentChannelId: "general",
      onScopeChange: changeScope,
      openConversation,
    };
    const mounted = render(<SearchResults {...props} query="crew" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(screen.getByRole("option")).toHaveTextContent("Search in general");
    enter();
    expect(changeScope).not.toHaveBeenCalled();
    await act(async () => resolved());
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
    await act(async () => wire.next().respond([]));
    // While message search is still pending, an arrow key chooses the
    // scope action for Enter.
    mounted.rerender(<SearchResults {...props} query="nope" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    enter("ArrowDown");
    enter();
    expect(changeScope).toHaveBeenCalledExactlyOnceWith("general");
    // Once the lookups settle, Enter on it scopes without an arrow key.
    await act(async () => wire.next().respond([]));
    enter();
    expect(changeScope).toHaveBeenCalledTimes(2);
    expect(openConversation).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["alone", undefined],
  ["and the scope action", "general"],
])(
  "holds an early Enter for an open channel over Show more messages %s",
  async (_, currentChannelId) => {
    vi.useFakeTimers();
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "general", "general"),
      roster(relay, "general", [viewer.pubkey]),
      metadata(relay, "lobby", "crew-lobby", 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]),
      roster(relay, "lobby", [keypair().pubkey]),
    ];
    let resolved!: () => void;
    const held = new Promise<void>((release) => (resolved = release));
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters, signal) {
        if (
          filters.some(
            (filter) =>
              filter.search !== undefined && !filter.kinds?.includes(0),
          )
        )
          return wire.transport.query(filters, signal);
        if (filters.some((filter) => filter["#d"]?.includes("lobby")))
          await held;
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    const openConversation = vi.fn();
    const changeScope = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef<HTMLInputElement>()}
          pages={[]}
          currentChannelId={currentChannelId}
          onScopeChange={changeScope}
          openConversation={openConversation}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      // A full page of hits in conversations search does not show.
      await act(async () =>
        wire
          .next()
          .respond(
            Array.from({ length: 20 }, (_, i) =>
              message(viewer, "unknown", `crew hidden ${i}`, 1700000100 - i),
            ),
          ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(
        screen.getByRole("option", { name: "Show more messages" }),
      ).toBeVisible();
      fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
        key: "Enter",
      });
      expect(wire.pending).toHaveLength(0);
      expect(changeScope).not.toHaveBeenCalled();
      await act(async () => resolved());
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
      expect(wire.pending).toHaveLength(0);
      expect(changeScope).not.toHaveBeenCalled();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each(["a click that does not focus the row", "its shortcut"])(
  "drops a held Enter when the scope action is chosen by %s",
  async (way) => {
    vi.useFakeTimers();
    const relay = keypair();
    const viewer = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const discovery = [
      metadata(relay, "general", "general"),
      roster(relay, "general", [viewer.pubkey]),
      metadata(relay, "lobby", "crew-lobby", 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]),
      roster(relay, "lobby", [keypair().pubkey]),
    ];
    let resolved!: () => void;
    const held = new Promise<void>((release) => (resolved = release));
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters, signal) {
        if (
          filters.some(
            (filter) =>
              filter.search !== undefined && !filter.kinds?.includes(0),
          )
        )
          return wire.transport.query(filters, signal);
        if (filters.some((filter) => filter["#d"]?.includes("lobby")))
          await held;
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    const openConversation = vi.fn();
    const changeScope = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query="crew"
          onQueryChange={() => {}}
          input={createRef<HTMLInputElement>()}
          pages={[]}
          currentChannelId="general"
          onScopeChange={changeScope}
          openConversation={openConversation}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      const field = screen.getByRole("combobox", { name: "Search Buzz" });
      const scope = screen.getByRole("option");
      expect(scope).toHaveTextContent("Search in general");
      fireEvent.keyDown(field, { key: "Enter" });
      expect(changeScope).not.toHaveBeenCalled();
      if (way === "its shortcut")
        fireEvent.keyDown(field, {
          key: "!",
          code: "Digit1",
          shiftKey: true,
          ctrlKey: true,
        });
      else fireEvent.click(scope);
      expect(scope).not.toHaveFocus();
      expect(changeScope).toHaveBeenCalledExactlyOnceWith("general");
      await act(async () => resolved());
      await act(async () => wire.next().respond([]));
      expect(screen.getByRole("option", { name: /crew-lobby/ })).toBeVisible();
      expect(openConversation).not.toHaveBeenCalled();
      expect(changeScope).toHaveBeenCalledOnce();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("returns keyboard focus to search when channel lookup retries, through repeated failure and recovery", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    metadata(relay, "joined", "other-chat", 1700000000, open),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "lobby", "crew-lobby", 1700000000, open),
    roster(relay, "lobby", [other.pubkey]),
  ];
  let failures = 2;
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      // Only the public-channel page read fails; exact lookups still succeed.
      if (
        failures > 0 &&
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        !filters.some((filter) => filter.kinds?.includes(39002))
      ) {
        failures--;
        return Promise.reject(new Error("Relay read timed out"));
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="crew"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    for (let attempt = 0; attempt < 2; attempt++) {
      const retry = await screen.findByRole("button", {
        name: "Retry channels",
      });
      retry.focus();
      fireEvent.click(retry);
      expect(
        screen.queryByRole("button", { name: "Retry channels" }),
      ).toBeNull();
      expect(input).toHaveFocus();
    }
    const lobby = await screen.findByRole("option", { name: /crew-lobby/ });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(lobby).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("lobby");
  } finally {
    cleanup();
    owner.dispose();
  }
});

function usageSession(
  names: readonly string[],
  publicNames: readonly string[] = [],
) {
  const relay = keypair();
  const viewer = keypair();
  const other = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const open = [
    ["public", ""],
    ["t", "stream"],
  ];
  const discovery = [
    ...names.flatMap((name, index) => [
      metadata(relay, name, name, 1700000000 + index),
      roster(relay, name, [viewer.pubkey]),
    ]),
    ...publicNames.flatMap((name) => [
      metadata(relay, name, name, 1700000000, open),
      roster(relay, name, [other.pubkey]),
    ]),
  ];
  return createRelaySession({
    ...wire.transport,
    query(filters) {
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
}

const usage = `wss://relay.example:${"a".repeat(64)}`;
const optionNames = (group: string) =>
  within(screen.getByRole("group", { name: group }))
    .getAllByRole("option")
    .map((option) => option.textContent?.split(/Conversation|Public/)[0]);

it("puts the earlier choice for typed text first, unless another name is exact", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const owner = usageSession(["work", "team-work", "workshop"]);
  const open = vi.fn();
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLElement>(),
    pages: [],
    openConversation: open,
    usageScope: usage,
  };
  try {
    const { rerender } = render(<SearchResults {...props} query="wor" />);
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual([
        "team-work",
        "work",
        "workshop",
      ]),
    );
    const combobox = screen.getByRole("combobox", { name: "Search Buzz" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("team-work");
    // Typing a channel's whole name opens that channel.
    rerender(<SearchResults {...props} query="work" />);
    expect(optionNames("Channels")).toEqual(["work", "team-work", "workshop"]);
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(open).toHaveBeenLastCalledWith("work");
    // Each choice is remembered for the text that led to it.
    const remembered = readSearchUsage(usage);
    const all = new Set(["channel:work", "channel:team-work"]);
    expect(remembered.pick("work", all)).toBe("channel:work");
    expect(remembered.pick("wor", all)).toBe("channel:team-work");
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("puts a remembered public channel first, even past eight joined matches", async () => {
  localStorage.clear();
  recordChoice(usage, "wo", "channel:team-work");
  const joined = Array.from({ length: 8 }, (_, n) => `work-${n + 1}`);
  const owner = usageSession(joined, ["team-work"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wo"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run() {},
          },
        ]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // The group leads because of the remembered row, so that row leads it.
    await waitFor(() => expect(optionNames("Channels")[0]).toBe("team-work"));
    expect(optionNames("Channels")).toHaveLength(8);
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("lets frequent visits lift a match past a slightly better one, not a much better one", async () => {
  localStorage.clear();
  for (let visit = 0; visit < 20; visit++) {
    recordVisit(usage, "channel:the-lar");
    recordVisit(usage, "channel:xlarx");
  }
  const owner = usageSession(["xlarx", "the-lar", "lar-crew"]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="lar"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    // Word start beats prefix with usage; a busy substring match does not.
    await waitFor(() =>
      expect(optionNames("Channels")).toEqual(["the-lar", "lar-crew", "xlarx"]),
    );
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("keeps the remembered choice selected when a better match arrives late", async () => {
  localStorage.clear();
  recordChoice(usage, "wor", "Workflows");
  const owner = usageSession([], ["wor"]);
  const workflows = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="wor"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[
          {
            key: "Workflows",
            label: "Workflows",
            icon: ChatCircleIcon,
            run: workflows,
          },
        ]}
        openConversation={() => {}}
        usageScope={usage}
      />,
    );
    const page = screen.getByRole("option", { name: "Workflows" });
    expect(page).toHaveAttribute("aria-selected", "true");
    // The relay's exact public match leads its group above Pages, later.
    await screen.findByRole("option", { name: /^wor/ });
    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.getAttribute("aria-label"))
        .slice(0, 2),
    ).toEqual(["Channels", "Pages"]);
    expect(page).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(workflows).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it("translates combined operators into a single server-ranked scoped read and opens the match", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew from:@alice after:2024-01-15 before:2024-02-01"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={open}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    // The exact open-channel lookup settles before the in: channel resolves.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const users = wire.next();
    expect(users.filters).toEqual([
      { kinds: [0], search: "alice", search_mode: "prefix", limit: 40 },
    ]);
    await act(async () =>
      users.respond([profile(alice, { display_name: "Alice" })]),
    );
    const request = wire.next();
    expect(request.filters).toEqual([
      {
        kinds: [40002, 40008, 9],
        search: "deploy",
        search_mode: "prefix",
        limit: 20,
        "#h": ["crew"],
        authors: [alice.pubkey],
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
        until: Math.floor(new Date(2024, 1, 1).getTime() / 1000) - 1,
      },
    ]);
    const hit = message(alice, "crew", "deploy matched", 1700000001);
    await act(async () => request.respond([hit]));
    fireEvent.click(screen.getByRole("option", { name: /deploy matched/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("does not read messages for punctuation-only operands after normalization", async () => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: vi.fn(),
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: vi.fn(),
  };
  try {
    const view = render(<SearchResults {...props} query="in:#" />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="from:. " />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 240)));
    expect(reads).toHaveLength(0);
    view.rerender(<SearchResults {...props} query="in:# after:2024-01-15" />);
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(reads[0]).toEqual([
      expect.objectContaining({
        since: Math.floor(new Date(2024, 0, 15).getTime() / 1000),
      }),
    ]);
    expect(reads[0]?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

/** Message searches (not people or channel lookups) a session sends. */
const isMessageSearch = (filters: readonly Filter[]) =>
  filters.some(
    (filter) => filter.search !== undefined && !!filter.kinds?.includes(9),
  );

it("reads no message search until the last word has three characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const searches: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (isMessageSearch(filters as Filter[]))
        searches.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="ab" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText("Type at least 3 characters to search messages."),
    ).toBeVisible();
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();

    // The relay prefix-matches the last word, so completed words before it
    // do not make a short one searchable.
    view.rerender(<SearchResults {...props} query="project pl" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText(
        "Type at least 3 characters in the last word to search messages.",
      ),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="project pla" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toEqual([
      [expect.objectContaining({ search: "project pla" })],
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("an in: operator does not lower the message search minimum", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const searches: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (isMessageSearch(filters as Filter[])) {
        searches.push(filters as Filter[]);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="in:#crew ab" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toHaveLength(0);
    expect(
      screen.getByText("Type at least 3 characters to search messages."),
    ).toBeVisible();

    view.rerender(<SearchResults {...props} query="in:#crew abc" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searches).toEqual([
      [
        {
          kinds: [40002, 40008, 9],
          search: "abc",
          search_mode: "prefix",
          limit: 20,
          "#h": ["crew"],
        },
      ],
    ]);
    expect(
      screen.queryByText("Type at least 3 characters to search messages."),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("looks up an author by name only from two characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const searchProfiles = vi.fn(async () => []);
  const props = {
    session: { ...owner.session, searchProfiles } as typeof owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="from:@a" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searchProfiles).not.toHaveBeenCalled();
    // No lookup ran, so the picker asks for more text rather than reporting none.
    expect(
      screen.getByText("Type at least 2 characters to search people."),
    ).toBeVisible();
    expect(screen.queryByText(/No matching people/)).toBeNull();
    view.rerender(<SearchResults {...props} query="from:@al" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(searchProfiles).toHaveBeenCalledExactlyOnceWith(
      "al",
      expect.objectContaining({ limit: 40 }),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("searches the people directory only from two characters", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const people = vi.fn(async () => ({ people: [], hasMore: false }));
  const props = {
    session: {
      ...owner.session,
      directMessages: { ...owner.session.directMessages, people },
    } as typeof owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="a" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(people).not.toHaveBeenCalled();
    view.rerender(<SearchResults {...props} query="al" />);
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(people).toHaveBeenCalledExactlyOnceWith(
      "al",
      1,
      expect.any(AbortSignal),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("still looks up a one-character channel named by in:", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [metadata(relay, "x", "x", 1700000000, [["public", ""]])];
  const owner = createRelaySession({
    ...wire.transport,
    query: async (filters) =>
      discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      ),
  });
  const source = owner.session.channels.searchPublic;
  assert.exists(source);
  const searchPublic = vi.fn(source);
  try {
    render(
      <SearchResults
        session={{
          ...owner.session,
          channels: { ...owner.session.channels, searchPublic },
        }}
        query="in:#x"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(searchPublic).toHaveBeenCalledWith(
        "x",
        expect.objectContaining({ exact: true }),
      ),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("runs operator-only date and author searches without a text predicate", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const channel = "crew";
  const before = message(alice, channel, "before the cutoff", 1700000001);
  const after = message(alice, channel, "after the cutoff", 1800000001);
  const discovery = [
    metadata(relay, channel, "Wes"),
    roster(relay, channel, [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(alice, { display_name: "Alice" })]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve(
          [before, after].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(
      <SearchResults
        {...props}
        query="before:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /before the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /after the cutoff/ }),
    ).toBeNull();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({
        "#h": [channel],
        until: Math.floor(new Date(2026, 9, 1).getTime() / 1000) - 1,
      }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
    mounted.rerender(
      <SearchResults
        {...props}
        query="after:2026-10-01"
        scopedChannelId={channel}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /before the cutoff/ }),
    ).toBeNull();
    mounted.rerender(<SearchResults {...props} query="from:alice " />);
    expect(
      await screen.findByRole("option", { name: /after the cutoff/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [alice.pubkey] }),
    ]);
    expect(reads.at(-1)?.[0]).not.toHaveProperty("search");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:ba", "from:@ba"])(
  "%s opens the same prefix picker and never reads messages before identity selection",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      human = keypair();
    const reads: Filter[][] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(human, { display_name: "Baxen" })]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const people = within(screen.getByRole("group", { name: "People" }));
      const choice = await people.findByRole("option", { name: /Baxen/ });
      expect(reads).toHaveLength(0);
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${human.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("requests a bounded prefix page before declaring a short name absent", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      }
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(await screen.findByRole("option", { name: /Wes/ })).toBeVisible();
    expect(reads).toContainEqual([
      { kinds: [0], search: "we", search_mode: "prefix", limit: 40 },
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["from:we"])(
  "%s retains a confirmed channel member when global prefix lookup fails",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      wes = keypair();
    const channel = "crew";
    const discovery = [
      metadata(relay, channel, "crew"),
      roster(relay, channel, [viewer.pubkey, wes.pubkey]),
    ];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.search === "we"))
          return Promise.reject(new Error("prefix lookup unavailable"));
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([profile(wes, { display_name: "Wes" })]);
        return Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          scopedChannelId={channel}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const choice = await within(
        screen.getByRole("group", { name: "People" }),
      ).findByRole("option", { name: /Wes/ });
      fireEvent.click(choice);
      expect(change).toHaveBeenCalledWith(`from:${wes.pubkey} `);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("distinguishes an unavailable global author lookup from no matching people", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:@we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByText(
        "People search is unavailable. Try a longer name.",
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers a bounded from:@ picker with distinct identities and selects an exact author", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(first, { display_name: "Baxen" }),
          profile(second, { display_name: "Baxen" }),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(second, "crew", "chosen author", 1700000010),
        ]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const change = vi.fn();
  try {
    const mounted = render(
      <SearchResults
        session={owner.session}
        query="from:@baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    expect(await people.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query="from:baxen"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const ambiguous = within(
      await screen.findByRole("group", { name: "People" }),
    );
    expect(await ambiguous.findAllByRole("option")).toHaveLength(2);
    expect(reads).toHaveLength(0);
    fireEvent.click(ambiguous.getAllByRole("option")[1] as HTMLElement);
    expect(change).toHaveBeenCalledWith(`from:${second.pubkey} `);
    mounted.rerender(
      <SearchResults
        session={owner.session}
        query={`from:${second.pubkey} `}
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /chosen author/ }),
    ).toBeVisible();
    expect(reads.at(-1)).toEqual([
      expect.objectContaining({ authors: [second.pubkey] }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds and resolves authors by name words, sending the relay the typed accents", async () => {
  const relay = keypair(),
    viewer = keypair(),
    zoe = keypair(),
    other = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ];
  const reads: Filter[][] = [];
  const searches: string[] = [];
  const people = [
    profile(zoe, { display_name: "Zoë" }),
    profile(other, { display_name: "Mary Zoë" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      const search = filters.find((filter) => filter.kinds?.includes(0))
        ?.search as string | undefined;
      if (search !== undefined) {
        searches.push(search);
        // Like the relay's `simple` text index: lowercase word prefixes,
        // with no accent folding.
        return Promise.resolve(
          people.filter((event) =>
            String(JSON.parse(event.content).display_name)
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .some((word) => word.startsWith(search)),
          ),
        );
      }
      if (filters.some((filter) => filter.kinds?.includes(9))) {
        reads.push(filters as Filter[]);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  const props = {
    session: owner.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:@Zoë" />);
    const group = within(screen.getByRole("group", { name: "People" }));
    // The exact name first, then a later word that matches.
    await waitFor(() =>
      expect(
        group.getAllByRole("option").map((option) => option.textContent),
      ).toEqual([
        expect.stringContaining("Zoë"),
        expect.stringContaining("Mary Zoë"),
      ]),
    );
    mounted.rerender(<SearchResults {...props} query="from:Zoë " />);
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [zoe.pubkey] }),
      ]),
    );
    // Folding is local only; the relay sees what the user typed.
    expect(searches.length).toBeGreaterThan(0);
    expect(searches.every((search) => search === "zoë")).toBe(true);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("prioritizes people, separates agents, shows profile avatars, and excludes archived identities", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair(),
    agent = keypair(),
    archived = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, {
            display_name: "Algo Agent",
            is_agent: true,
            picture: "https://example.com/agent.png",
          }),
          profile(archived, { display_name: "Archived", is_agent: true }),
          profile(human, {
            display_name: "Alice",
            picture: "https://example.com/human.png",
          }),
        ]);
      return Promise.resolve([]);
    },
  });
  const known = { status: "ready" as const, archived: [archived.pubkey] };
  const session = {
    ...owner.session,
    archives: {
      ...owner.session.archives,
      state: (key: string) =>
        key === archived.pubkey ? ("archived" as const) : ("active" as const),
      snapshot: () => known,
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:@al"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(screen.getByRole("group", { name: "People" }));
    const person = await people.findByRole("option", { name: /Alice/ });
    expect(person).toBeVisible();
    expect(
      person.querySelector('img[src="https://example.com/human.png"]'),
    ).not.toBeNull();
    const agents = within(screen.getByRole("group", { name: "Agents" }));
    const choice = await agents.findByRole("option", { name: /Agent/ });
    expect(choice).toBeVisible();
    expect(
      choice.querySelector('img[src="https://example.com/agent.png"]'),
    ).not.toBeNull();
    expect(agents.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /Archived/ })).toBeNull();
    expect(
      [...document.querySelectorAll('[role="option"]')].indexOf(person),
    ).toBeLessThan(
      [...document.querySelectorAll('[role="option"]')].indexOf(choice),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens the identity picker for bare from: without an unfiltered message read", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Alice" })]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(screen.getByRole("group", { name: "People" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Most relevant" })).toBeNull();
    expect(reads).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  "from:baxen deploy",
  "from:@baxen ",
  "deploy from:baxen after:2024-01-15",
])(
  "resolves a completed ambiguous %s without losing surrounding query text",
  async (query) => {
    const relay = keypair(),
      viewer = keypair(),
      first = keypair(),
      second = keypair();
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(first, { display_name: "Baxen" }),
            profile(second, { display_name: "Baxen" }),
          ]);
        return Promise.resolve([]);
      },
    });
    const change = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={change}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />,
      );
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(2);
      fireEvent.click(people.getAllByRole("option")[1] as HTMLElement);
      expect(change).toHaveBeenCalledWith(
        query.replace(/from:@?baxen/i, `from:${second.pubkey}`),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

// A full first page can hide an exact namesake past the cap.
const alexSession = (
  exact: ReturnType<typeof keypair>,
  page: readonly ReturnType<typeof profile>[],
) => {
  const relay = keypair(),
    viewer = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(exact, { display_name: "Alex" }),
          ...page,
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  return { owner, reads };
};
const alexandras = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    profile(keypair(), { display_name: `Alexandra ${index}` }),
  );

it.each([
  ["a full prefix page", () => alexandras(39), 12],
  ["exact namesakes", () => [profile(keypair(), { display_name: "Alex" })], 2],
])(
  "asks which author a completed from: name means with %s",
  async (_, page, shown) => {
    const exact = keypair();
    const { owner, reads } = alexSession(exact, page());
    const change = vi.fn();
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: () => {},
    };
    try {
      const mounted = render(<SearchResults {...props} query="from:Alex " />);
      const people = within(
        await screen.findByRole("group", { name: "People" }),
      );
      expect(await people.findAllByRole("option")).toHaveLength(shown);
      // The picker follows the resolver's completed lookup.
      expect(reads).toEqual([]);
      fireEvent.click(
        people.getByRole("option", {
          name: new RegExp(exact.pubkey.slice(0, 12)),
        }),
      );
      expect(change).toHaveBeenCalledWith(`from:${exact.pubkey} `);
      mounted.rerender(
        <SearchResults {...props} query={`from:${exact.pubkey} `} />,
      );
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [exact.pubkey] }),
        ]),
      );
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves one exact from: name in a partial prefix page", async () => {
  const exact = keypair();
  const { owner, reads } = alexSession(exact, alexandras(38));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:Alex "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(reads.at(-1)).toEqual([
        expect.objectContaining({ authors: [exact.pubkey] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["resolves it", false],
  ["reports a profile namesake as ambiguous", true],
])("completing an agent's own name with Space %s", async (_, namesake) => {
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          profile(agent, { display_name: "Legacy Bee" }),
          ...(namesake ? [profile(human, { display_name: "Jose" })] : []),
        ]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: agent.pubkey, name: "José", managed: true }],
    selectable: [{ pubkey: agent.pubkey, name: "José", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  const props = {
    session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="from:jose" />);
    // The picker offers the agent by its own name.
    expect(
      await within(
        await screen.findByRole("group", { name: "Agents" }),
      ).findByRole("option"),
    ).toBeVisible();
    mounted.rerender(<SearchResults {...props} query="from:jose " />);
    if (!namesake) {
      await waitFor(() =>
        expect(reads.at(-1)).toEqual([
          expect.objectContaining({ authors: [agent.pubkey] }),
        ]),
      );
    } else {
      // Both keys are offered; neither is searched silently.
      await waitFor(() =>
        expect(
          within(screen.getByRole("group", { name: "People" })).getAllByRole(
            "option",
          ),
        ).toHaveLength(1),
      );
      expect(
        within(screen.getByRole("group", { name: "Agents" })).getAllByRole(
          "option",
        ),
      ).toHaveLength(1);
      expect(reads).toEqual([]);
    }
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("adds a late shared agent without another keystroke or prefix read", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    agent = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query() {
      return [];
    },
  });
  const reads = vi.fn(async () => []);
  const source = owner.session.agentChoices;
  const listeners = new Set<() => void>();
  let choices = source.snapshot();
  const session = {
    ...owner.session,
    read: reads,
    searchProfiles: reads,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="from:late"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
    act(() => {
      choices = {
        ...choices,
        identities: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
        selectable: [
          { pubkey: agent.pubkey, name: "Late Agent", managed: false },
        ],
      };
      for (const listener of listeners) listener();
    });
    expect(
      within(screen.getByRole("group", { name: "Agents" })).getByRole(
        "option",
        { name: /Late Agent/ },
      ),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  ["from:alice", "from:bob", ""],
  [
    "deploy in:crew after:2026-10-01 from:alice",
    "deploy in:crew after:2026-10-01 from:bob",
    "deploy in:crew after:2026-10-01 ",
  ],
])(
  "replaces author chip in %s without leaking or restoring its filter",
  async (initial, typed, remaining) => {
    const relay = keypair(),
      viewer = keypair(),
      alice = keypair(),
      bob = keypair();
    const reads: Filter[][] = [];
    const changes: string[] = [];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query(filters) {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          return Promise.resolve([
            profile(alice, { display_name: "Alice" }),
            profile(bob, { display_name: "Bob" }),
          ]);
        if (filters.some((filter) => filter.kinds?.includes(9)))
          reads.push(filters as Filter[]);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
          ].filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        );
      },
    });
    function Search() {
      const [query, setQuery] = useState(initial);
      return (
        <SearchResults
          session={owner.session}
          query={query}
          onQueryChange={(next) => {
            changes.push(next);
            setQuery(next);
          }}
          input={createRef()}
          pages={[]}
          openConversation={() => {}}
        />
      );
    }
    try {
      render(<Search />);
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Alice/ },
        ),
      );
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      expect(
        screen.getByRole("button", { name: "Remove author Alice" }),
      ).toBeVisible();
      fireEvent.change(input, {
        target: { value: typed },
      });
      fireEvent.click(
        await within(screen.getByRole("group", { name: "People" })).findByRole(
          "option",
          { name: /Bob/ },
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Remove author Alice" }),
      ).toBeNull();
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      await waitFor(() =>
        expect(reads.at(-1)?.[0]).toMatchObject({ authors: [bob.pubkey] }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Remove author Bob" }),
      );
      expect(input).toHaveValue(remaining);
      expect((input as HTMLInputElement).value).not.toContain(alice.pubkey);
      expect((input as HTMLInputElement).value).not.toContain(bob.pubkey);
      expect(changes.at(-1)).toBe(remaining);
      if (remaining) {
        await waitFor(() =>
          expect(reads.at(-1)?.[0]).not.toHaveProperty("authors"),
        );
      }
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("renders from:<author chip> without exposing the signed operand in the input", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(human, { display_name: "Wes" })]);
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      return Promise.resolve([]);
    },
  });
  function Search() {
    const [query, setQuery] = useState("from:@wes");
    return (
      <SearchResults
        session={owner.session}
        query={query}
        onQueryChange={setQuery}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />
    );
  }
  try {
    render(<Search />);
    fireEvent.click(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    );
    const chip = screen.getByRole("button", { name: "Remove author Wes" });
    expect(chip).toHaveTextContent("from:@Wes");
    expect(chip).toHaveAttribute("title", npubEncode(human.pubkey));
    const input = screen.getByRole("combobox", { name: "Search Buzz" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(chip.closest(".search-field")).toContainElement(input);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "before:" } });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Dates" })).getByRole("option", {
        name: /Yesterday/,
      }),
    );
    expect(chip).toBeVisible();
    expect((input as HTMLInputElement).value).toMatch(
      /^before:\d{4}-\d{2}-\d{2} ?$/,
    );
    expect((input as HTMLInputElement).value).not.toContain(human.pubkey);
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({ authors: [human.pubkey] }),
    );
    fireEvent.change(input, { target: { value: "deploy" } });
    expect(input).toHaveValue("deploy");
    expect(chip).toBeVisible();
    await waitFor(() =>
      expect(reads.at(-1)?.[0]).toMatchObject({
        authors: [human.pubkey],
        search: "deploy",
      }),
    );
    fireEvent.click(chip);
    expect(
      screen.queryByRole("button", { name: "Remove author Wes" }),
    ).toBeNull();
    expect(input).toHaveValue("deploy");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps both exact authors selectable ahead of a crowded prefix page", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  const prefixes = Array.from({ length: 12 }, () => keypair());
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(9)))
        reads.push(filters as Filter[]);
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...prefixes.map((person, index) =>
            profile(person, { display_name: `Samantha ${index}` }),
          ),
          profile(first, { display_name: "Sam" }),
          profile(second, { display_name: "Sam" }),
        ]);
      return Promise.resolve([]);
    },
  });
  const change = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:sam deploy"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const people = within(await screen.findByRole("group", { name: "People" }));
    await waitFor(() => expect(people.getAllByRole("option")).toHaveLength(12));
    for (const pubkey of [first.pubkey, second.pubkey]) {
      expect(
        people.getByRole("option", { name: new RegExp(pubkey.slice(0, 12)) }),
      ).toBeVisible();
    }
    expect(reads).toHaveLength(0);
    fireEvent.click(
      people.getByRole("option", {
        name: new RegExp(second.pubkey.slice(0, 12)),
      }),
    );
    expect(change).toHaveBeenCalledExactlyOnceWith(
      `from:${second.pubkey} deploy`,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a person visible when agent candidates exceed the picker cap", async () => {
  const relay = keypair(),
    viewer = keypair(),
    human = keypair();
  const agents = Array.from({ length: 12 }, () => keypair());
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([
          ...agents.map((agent) =>
            profile(agent, { display_name: "Algo Agent", is_agent: true }),
          ),
          profile(human, { display_name: "Alice" }),
        ]);
      return Promise.resolve([]);
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="from:al"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Alice/ },
      ),
    ).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(12);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("retains a member of the in: channel when global author lookup fails", async () => {
  const relay = keypair(),
    viewer = keypair(),
    wes = keypair();
  const discovery = [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey, wes.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query(filters) {
      if (filters.some((filter) => filter.search === "we"))
        return Promise.reject(new Error("prefix lookup unavailable"));
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return Promise.resolve([profile(wes, { display_name: "Wes" })]);
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="in:#crew from:we"
        onQueryChange={vi.fn()}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await within(screen.getByRole("group", { name: "People" })).findByRole(
        "option",
        { name: /Wes/ },
      ),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows only the requested date suggestions and inserts local calendar dates", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 5, 12));
  try {
    render(
      <SearchResults
        session={owner.session}
        query="after:"
        onQueryChange={change}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const dates = within(screen.getByRole("group", { name: "Dates" }));
    expect(
      dates.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Today2026-10-05",
      "Yesterday2026-10-04",
      "This week2026-10-05",
      "Last week2026-09-28",
      "This month2026-10-01",
    ]);
    fireEvent.click(dates.getByRole("option", { name: /Last week/ }));
    expect(change).toHaveBeenCalledWith("after:2026-09-28 ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("offers during: periods and an on: calendar that insert local dates", async () => {
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const change = vi.fn();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12));
  try {
    const props = {
      session: owner.session,
      onQueryChange: change,
      input: createRef<HTMLInputElement>(),
      pages: [],
      openConversation: () => {},
    };
    const view = render(<SearchResults {...props} query="deploy during:" />);
    const dates = within(screen.getByRole("group", { name: "Dates" }));
    expect(
      dates.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "Today2026-10-07",
      "Yesterday2026-10-06",
      "This week2026-10-05",
      "This month2026-10",
      "This year2026",
    ]);
    fireEvent.click(dates.getByRole("option", { name: /This week/ }));
    // There is no week period, so the week starts after its Monday.
    expect(change).toHaveBeenLastCalledWith("deploy after:2026-10-05 ");
    fireEvent.click(dates.getByRole("option", { name: /This year/ }));
    expect(change).toHaveBeenLastCalledWith("deploy during:2026 ");
    view.rerender(<SearchResults {...props} query="deploy on:" />);
    expect(screen.queryByRole("group", { name: "Dates" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /October 14th, 2026/ }));
    expect(change).toHaveBeenLastCalledWith("deploy on:2026-10-14 ");
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("picks an in: channel from the joined channels and an in:@ person like from:@", async () => {
  const relay = keypair(),
    viewer = keypair(),
    baxen = keypair();
  const { owner } = operatorSession(viewer, relay, [
    metadata(relay, "bugs", "buzz-bugs"),
    roster(relay, "bugs", [viewer.pubkey]),
    metadata(relay, "builds", "builds"),
    roster(relay, "builds", [viewer.pubkey]),
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
    profile(baxen, { display_name: "Baxen" }),
  ]);
  const session = {
    ...owner.session,
    searchProfiles: async () => [
      eventDto(profile(baxen, { display_name: "Baxen" })),
    ],
  };
  const change = vi.fn();
  const props = {
    session,
    onQueryChange: change,
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const view = render(<SearchResults {...props} query="deploy in:#bu" />);
    const channels = within(
      await screen.findByRole("group", { name: "Channels" }),
    );
    await waitFor(() =>
      expect(
        channels.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["builds" + "Channel", "buzz-bugs" + "Channel"]),
    );
    fireEvent.click(channels.getByRole("option", { name: /buzz-bugs/ }));
    expect(change).toHaveBeenLastCalledWith("deploy in:#buzz-bugs ");
    view.rerender(<SearchResults {...props} query="in:#" />);
    expect(
      await within(
        await screen.findByRole("group", { name: "Channels" }),
      ).findAllByRole("option"),
    ).toHaveLength(3);
    view.rerender(<SearchResults {...props} query="deploy in:@bax" />);
    const people = within(await screen.findByRole("group", { name: "People" }));
    fireEvent.click(await people.findByRole("option", { name: /Baxen/ }));
    expect(change).toHaveBeenLastCalledWith(`deploy in:@${baxen.pubkey} `);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows only messages once text sits beside an operator", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "bugs", "buzz-bugs"),
      roster(relay, "bugs", [viewer.pubkey]),
      metadata(relay, "kr", "kalvin-reviewers"),
      roster(relay, "kr", [viewer.pubkey]),
    ],
    [message(viewer, "bugs", "kalvin found it", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="in:#buzz-bugs kalvin"
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /kalvin found it/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({ "#h": ["bugs"], search: "kalvin" }),
    ]);
    expect(screen.queryByRole("group", { name: "Channels" })).toBeNull();
    expect(
      screen.queryByRole("option", { name: /kalvin-reviewers/ }),
    ).toBeNull();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("never widens a search when a name or channel operator is unresolved", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const owner = createRelaySession({
    ...wire.transport,
    query(filters, signal) {
      if (filters.some((filter) => filter.search !== undefined))
        return wire.transport.query(filters, signal);
      return Promise.resolve(
        [
          metadata(relay, "crew", "crew"),
          roster(relay, "crew", [viewer.pubkey]),
        ].filter((event) =>
          filters.some((filter) => filter.kinds?.includes(event.kind)),
        ),
      );
    },
  });
  try {
    const { rerender } = render(
      <SearchResults
        session={owner.session}
        query="deploy from:@missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        scopedChannelId="crew"
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    const users = wire.next();
    expect(users.filters[0]?.kinds).toEqual([0]);
    await act(async () => users.respond([]));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
    for (const request of wire.pending.splice(0)) request.respond([]);
    rerender(
      <SearchResults
        session={owner.session}
        query="deploy in:#missing"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(
      wire.pending.filter((request) =>
        request.filters.some((filter) => filter.kinds?.includes(9)),
      ),
    ).toHaveLength(0);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each(["private", "missing"])(
  "revalidates a retained public preview before an in: search when metadata becomes %s",
  async (change) => {
    const relay = keypair(),
      viewer = keypair();
    const id = "12345678-1234-1234-1234-123456789abc";
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const publicMeta = metadata(relay, id, "Public", 1700000000, [
      ["public", ""],
    ]);
    const privateMeta = metadata(relay, id, "Private", 1700000001, [
      ["private", ""],
    ]);
    let current = publicMeta;
    let revoked = false;
    const scopedReads: Filter[][] = [];
    let exactReads = 0;
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) {
          scopedReads.push(filters as Filter[]);
          return [message(viewer, id, "stale secret hit", 1700000002)];
        }
        if (filters.some((filter) => filter["#d"]?.includes(id))) {
          exactReads++;
          return revoked
            ? change === "missing"
              ? []
              : [current]
            : [publicMeta];
        }
        return [publicMeta].filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    try {
      const props = {
        session: owner.session,
        onQueryChange: () => {},
        input: createRef<HTMLInputElement>(),
        pages: [],
        openConversation: () => {},
      };
      const mounted = render(<SearchResults {...props} query="Public" />);
      await screen.findByRole("option", {
        name: /Public channel · not joined/,
      });
      expect(owner.session.channels.get?.(id)?.readOnly).toBe(true);
      const beforeRevalidation = exactReads;
      scopedReads.length = 0;
      vi.useFakeTimers();
      current = privateMeta;
      revoked = true;
      mounted.rerender(<SearchResults {...props} query={`secret in:${id}`} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(exactReads).toBeGreaterThan(beforeRevalidation);
      expect(scopedReads).toHaveLength(0);
      expect(owner.session.channels.get?.(id)).toBeUndefined();
      expect(
        screen.queryByRole("option", { name: /stale secret hit/ }),
      ).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves an exact public name beyond eight preceding substring matches and reports page coverage", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const names = [
    "a-dev",
    "b-dev",
    "c-dev",
    "d-dev",
    "android-dev",
    "backend-dev",
    "core-dev",
    "data-dev",
    "dev",
  ];
  const discovery = names.map((name) =>
    metadata(relay, name, name, 1700000000, [
      ["public", ""],
      ["t", "stream"],
    ]),
  );
  // A partial directory means an exact-name miss outside it cannot be declared exhaustive.
  for (let i = 0; i < 491; i++)
    discovery.push(
      metadata(relay, `extra-${i}`, `extra-${i}`, 1700000000, [
        ["public", ""],
        ["t", "stream"],
      ]),
    );
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "dev", "deploy found", 1700000001)];
      }
      // The directory is one full page: nothing is older than its cursor.
      if (filters.some((filter) => filter.before_id !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // Reaching the store's read bound takes 20,000 signed events; report it here.
  const searchPublic = owner.session.channels.searchPublic;
  assert.exists(searchPublic);
  const session = {
    ...owner.session,
    channels: {
      ...owner.session.channels,
      searchPublic: async (...args: Parameters<typeof searchPublic>) => ({
        ...(await searchPublic(...args)),
        partial: true,
      }),
    },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.objectContaining({ "#h": ["dev"], search: "deploy" }),
    ]);
    expect(
      screen.getByText("Only the newest open channels were searched."),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a pending in: lookup pending, then retries its failure and resumes scoped search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dev", "dev", 1700000000, [["public", ""]]),
  ];
  let failLookup!: (error: Error) => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const pending = new Promise<typeof discovery>((_resolve, reject) => {
    failLookup = reject;
  });
  let failures = 1;
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return Promise.resolve([
          message(viewer, "dev", "deploy found", 1700000001),
        ]);
      }
      if (
        filters.some(
          (filter) => filter.kinds?.includes(39000) && !filter["#d"],
        ) &&
        failures-- > 0
      ) {
        lookupStarted();
        return pending;
      }
      return Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await started;
    expect(
      screen.queryByText("No matching messages in accessible conversations."),
    ).toBeNull();
    await act(async () => failLookup(new Error("network down")));
    expect(
      await screen.findByText(
        /Public channel search couldn’t finish: network down/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Message search is unavailable.")).toBeVisible();
    expect(reads).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
    expect(
      await screen.findByRole("option", { name: /deploy found/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dev"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("shows a pending in: channel lookup beside Most relevant", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: async () => [],
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookupStarted = false;
  const searchPublic = vi.fn(async (query: string) => {
    if (query === "dev") {
      lookupStarted = true;
      await held;
    }
    return { channels: [], partial: false };
  });
  const readPage = vi.fn(async () => ({ events: [], relayCount: 0 }));
  const session = {
    ...owner.session,
    readPage,
    channels: { ...owner.session.channels, searchPublic },
  };
  try {
    render(
      <SearchResults
        session={session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    for (let step = 0; step < 100 && !lookupStarted; step++)
      await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(lookupStarted).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    const group = screen.getByRole("group", { name: "Most relevant" });
    expect(
      within(group).getByRole("heading", { name: "Most relevant" }),
    ).toHaveTextContent("Most relevant · Searching…");
    expect(group.querySelector(".search-palette-group-empty")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Searching messages…");
    expect(readPage).not.toHaveBeenCalled();
    await act(async () => release());
    expect(screen.queryByText(/· Searching…/)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter while an in: channel is still being found", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dev", "dev", 1700000000, [["public", ""]]),
  ];
  const found = message(viewer, "dev", "deploy found", 1700000001);
  let listRead!: () => void;
  const listStarted = new Promise<void>((resolve) => (listRead = resolve));
  let releaseList!: () => void;
  const listHeld = new Promise<void>((release) => (releaseList = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [found];
      // The joined list must load before the in: channel can resolve.
      if (filters.some((filter) => filter.kinds?.includes(39002))) {
        listRead();
        await listHeld;
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#dev "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    await listStarted;
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    await act(async () => releaseList());
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("dev", found.id),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("holds an early Enter while the joined list is still loading", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "engineering", "engineering"),
    roster(relay, "engineering", [viewer.pubkey]),
  ];
  const reads: Promise<unknown>[] = [];
  let listRead!: () => void;
  const listStarted = new Promise<void>((resolve) => (listRead = resolve));
  let releaseList!: () => void;
  const listHeld = new Promise<void>((release) => (releaseList = release));
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(39002))) {
        listRead();
        await listHeld;
      }
      const read = Promise.resolve(
        discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        ),
      );
      reads.push(read);
      return read;
    },
  });
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="eng"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    await listStarted;
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    // Message search and the people lookup settle empty before the list.
    expect(
      await screen.findByText(
        "No matching messages in accessible conversations.",
      ),
    ).toBeVisible();
    await act(async () => {
      await Promise.all(reads);
    });
    expect(screen.getByText("Loading joined conversations…")).toBeVisible();
    await act(async () => releaseList());
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("engineering"),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("matches an in: operator against the rendered DM participant label", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { name: "Alice" }),
  ];
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(alice, "dm", "deploy to Alice", 1700000001)];
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:alice "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy to Alice/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([expect.objectContaining({ "#h": ["dm"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("treats bare in:# as no channel operator", async () => {
  const relay = keypair(),
    viewer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) {
        reads.push(filters as Filter[]);
        return [message(viewer, "crew", "hello world", 1700000001)];
      }
      return [
        metadata(relay, "crew", "crew"),
        roster(relay, "crew", [viewer.pubkey]),
      ].filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="hello in:# "
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /hello world/ }),
    ).toBeVisible();
    expect(reads).toContainEqual([
      expect.not.objectContaining({ "#h": expect.anything() }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([true, false])(
  "only shows relay-attested workflow ownership in ranked search (relay signer: %s), keeping from: signer-based",
  async (relaySigned) => {
    vi.useFakeTimers();
    const relay = keypair(),
      viewer = keypair(),
      workflowOwner = keypair();
    const signer = relaySigned ? relay : keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const owner = createRelaySession({
      ...wire.transport,
      archiveAuthority: relay.pubkey,
      query(filters, signal) {
        if (filters.some((filter) => filter.search !== undefined))
          return wire.transport.query(filters, signal);
        return Promise.resolve(
          [
            metadata(relay, "crew", "crew"),
            roster(relay, "crew", [viewer.pubkey]),
            profile(workflowOwner, { display_name: "Workflow owner" }),
            profile(signer, { display_name: "Actual signer" }),
          ].filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          ),
        );
      },
    });
    const open = vi.fn();
    try {
      render(
        <SearchResults
          session={owner.session}
          query={`deploy in:#crew from:${signer.pubkey} `}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={open}
        />,
      );
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      // The exact open-channel lookup settles before the in: channel resolves.
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      const request = wire.next();
      expect(request.filters[0]?.authors).toEqual([signer.pubkey]);
      const hit = eventDto(
        message(signer, "crew", "deploy automated", 1700000001, [
          ["buzz:workflow", "true"],
          ["buzz:workflow-owner", workflowOwner.pubkey],
        ]),
      );
      await act(async () => request.respond([hit]));
      const option = screen.getByRole("option", { name: /deploy automated/ });
      if (relaySigned) {
        expect(option).toHaveTextContent("Workflow · owned by Workflow owner");
      } else {
        expect(option).toHaveTextContent("Actual signer");
        expect(option).not.toHaveTextContent("Workflow");
      }
      fireEvent.click(option);
      expect(open).toHaveBeenCalledExactlyOnceWith("crew", hit.id);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

function peopleSession(
  session: ReturnType<typeof createRelaySession>["session"],
  directory: {
    pubkey: string;
    name: string;
    username?: string;
    isAgent?: true;
    ownerPubkey?: string;
  }[] = [],
  agents: readonly {
    pubkey: string;
    name: string;
    managed: boolean;
    messageable?: true;
  }[] = [],
) {
  const people = vi.fn(async (_query?: string) => ({
    people: directory,
    hasMore: false,
  }));
  const open = vi.fn(async (_pubkeys: readonly string[]) => "started-dm");
  const source = session.agentChoices;
  const choices = { ...source.snapshot(), identities: agents, selectable: [] };
  return {
    people,
    open,
    session: {
      ...session,
      directMessages: {
        ...session.directMessages,
        available: true,
        people,
        open,
      },
      agentChoices: {
        ...source,
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
        ensure: () => {},
      },
    } as typeof session,
  };
}

it("starts a hosted agent DM from search without local management", async () => {
  const relay = keypair(),
    viewer = keypair(),
    hosted = keypair();
  const owner = createRelaySession(
    scriptedTransport(viewer.pubkey, relay.pubkey).transport,
  );
  const t = peopleSession(
    owner.session,
    [],
    [
      {
        pubkey: hosted.pubkey,
        name: "Hosted helper",
        managed: false,
        messageable: true,
      },
    ],
  );
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="Hosted helper"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    fireEvent.click(
      await screen.findByRole("option", { name: /Hosted helper/ }),
    );
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledWith("started-dm"),
    );
    expect(t.open).toHaveBeenCalledWith(
      [hosted.pubkey],
      expect.any(AbortSignal),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps the directory's order for tied people, as New message does", async () => {
  const relay = keypair(),
    viewer = keypair(),
    park = keypair(),
    lee = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.kinds?.includes(0))
        ? [profile(lee, { display_name: "Kim Lee" })]
        : [];
    },
  });
  // The relay ranked Kim Park first. Kim Lee is also in the profile cache and
  // sorts first by name; neither may move the directory's order.
  const t = peopleSession(owner.session, [
    { pubkey: park.pubkey, name: "Kim Park" },
    { pubkey: lee.pubkey, name: "Kim Lee" },
  ]);
  try {
    render(
      <SearchResults
        session={t.session}
        query="kim"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await act(async () => owner.session.profiles.ensure([lee.pubkey]));
    const group = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(
        within(group)
          .getAllByRole("option")
          .map((row) => row.textContent?.match(/Kim (Park|Lee)/)?.[0]),
      ).toEqual(["Kim Park", "Kim Lee"]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("finds a person by username and starts a DM with them", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.kinds?.includes(0))
        ? [profile(alice, { display_name: "Alice Chen", name: "achen" })]
        : [];
    },
  });
  const t = peopleSession(owner.session);
  let started = (_id: string) => {};
  t.open.mockImplementationOnce(
    () => new Promise<string>((resolve) => (started = resolve)),
  );
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="achen"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    // A profile already loaded elsewhere, read through the real kind-0 fold.
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    await act(async () => owner.session.profiles.ensure([alice.pubkey]));
    const row = await within(
      await screen.findByRole("group", { name: "People" }),
    ).findByRole("option");
    expect(row).toHaveTextContent("Alice Chen");
    expect(row).toHaveTextContent("@achen · Start a direct message");
    expect(row).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(
      await screen.findByText("Opening your conversation with Alice Chen…"),
    ).toBeVisible();
    // A second choice while one is opening does not start another.
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => started("started-dm"));
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("started-dm"),
    );
    expect(t.open).toHaveBeenCalledExactlyOnceWith(
      [alice.pubkey],
      expect.any(AbortSignal),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("lets the newest choice win over a DM that is still opening", async () => {
  const relay = keypair(),
    viewer = keypair(),
    bob = keypair(),
    carol = keypair();
  const discovery = [
    metadata(relay, "chat", "ally-chat"),
    roster(relay, "chat", [viewer.pubkey]),
  ];
  // A full first page of hits, so search offers more messages.
  const hits = Array.from({ length: 20 }, (_, i) =>
    message(viewer, "chat", `ally note ${i}`, 1700000100 - i),
  );
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (
        filters.some(
          (filter) => filter.search !== undefined && !filter.kinds?.includes(0),
        )
      )
        return filters.some((filter) => filter.page === 2) ? [] : hits;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: bob.pubkey, name: "Ally Bob" },
    { pubkey: carol.pubkey, name: "Ally Carol" },
  ]);
  const held: ((id: string) => void)[] = [];
  const hold = () => new Promise<string>((resolve) => held.push(resolve));
  t.open
    .mockImplementationOnce(hold)
    .mockImplementationOnce(async () => "carol-dm")
    .mockImplementationOnce(hold)
    .mockImplementationOnce(hold)
    .mockImplementationOnce(hold);
  const signal = (call: number) =>
    (t.open.mock.calls[call] as unknown as [unknown, AbortSignal])[1];
  const openConversation = vi.fn();
  const onScopeChange = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="ally"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        currentChannelId="chat"
        onScopeChange={onScopeChange}
        openConversation={openConversation}
      />,
    );
    const people = await screen.findByRole("group", { name: "People" });
    const bobRow = await within(people).findByRole("option", {
      name: /Ally Bob/,
    });
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    // Another person replaces the open still under way.
    fireEvent.click(within(people).getByRole("option", { name: /Ally Carol/ }));
    expect(signal(0).aborted).toBe(true);
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("carol-dm"),
    );
    // So does a channel.
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("option", { name: /^ally-chat/ }));
    expect(signal(2).aborted).toBe(true);
    expect(openConversation).toHaveBeenLastCalledWith("chat");
    expect(
      screen.queryByText("Opening your conversation with Ally Bob…"),
    ).toBeNull();
    // So does searching in this conversation.
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("option", { name: /Search in ally-chat/ }),
    );
    expect(signal(3).aborted).toBe(true);
    expect(onScopeChange).toHaveBeenCalledExactlyOnceWith("chat");
    expect(
      screen.queryByText("Opening your conversation with Ally Bob…"),
    ).toBeNull();
    // So does showing more messages.
    fireEvent.click(bobRow);
    expect(
      await screen.findByText("Opening your conversation with Ally Bob…"),
    ).toBeVisible();
    fireEvent.click(
      await screen.findByRole("option", { name: "Show more messages" }),
    );
    expect(signal(4).aborted).toBe(true);
    expect(
      screen.queryByText("Opening your conversation with Ally Bob…"),
    ).toBeNull();
    // Opens that finish after being replaced go nowhere.
    await act(async () => {
      for (const resolve of held) resolve("bob-dm");
    });
    expect(openConversation).toHaveBeenCalledTimes(2);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("opens an existing DM from a person row and reports a failed start", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair(),
    bob = keypair();
  const discovery = [
    metadata(relay, "dm", "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, "dm", [viewer.pubkey, alice.pubkey]),
    profile(alice, { display_name: "Alice Chen", name: "ally" }),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  // Alice's cached profile names her DM; Bob is only in the directory.
  const t = peopleSession(owner.session, [
    { pubkey: bob.pubkey, name: "Ally Bob" },
  ]);
  t.open.mockRejectedValueOnce(new Error("Relay refused the DM."));
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={t.session}
        query="ally"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
      />,
    );
    const group = await screen.findByRole("group", { name: "People" });
    // The existing DM is the closer relationship, so it leads.
    await waitFor(() =>
      expect(
        within(group)
          .getAllByRole("option")
          .map((row) => row.querySelector(".text-subtle")?.textContent),
      ).toEqual(["@ally · Direct message", "Start a direct message"]),
    );
    fireEvent.click(within(group).getByRole("option", { name: /Alice Chen/ }));
    expect(openConversation).toHaveBeenCalledExactlyOnceWith("dm");
    expect(t.open).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("option", { name: /Ally Bob/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Relay refused the DM.",
    );
    expect(openConversation).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("lists directory people and managed agents, not agents this community cannot message", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    carol = keypair(),
    stray = keypair(),
    keeper = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query() {
      return [];
    },
  });
  const t = peopleSession(
    owner.session,
    [
      { pubkey: carol.pubkey, name: "Carol" },
      { pubkey: stray.pubkey, name: "Carl Bot", isAgent: true },
    ],
    [{ pubkey: keeper.pubkey, name: "Caretaker", managed: true }],
  );
  const props = {
    session: t.session,
    onQueryChange: () => {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: () => {},
  };
  try {
    const mounted = render(<SearchResults {...props} query="car" />);
    // The managed agent is known locally before the directory answers.
    expect(
      within(screen.getByRole("group", { name: "Agents" })).getByRole("option"),
    ).toHaveTextContent("Caretaker");
    expect(t.people).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    expect(t.people).toHaveBeenCalledExactlyOnceWith(
      "car",
      1,
      expect.any(AbortSignal),
    );
    expect(
      within(screen.getByRole("group", { name: "People" })).getByRole("option"),
    ).toHaveTextContent("Carol");
    expect(screen.queryByText("Carl Bot")).toBeNull();
    // `#` asks for a channel and an operator for messages: no people. Text
    // longer than the directory accepts reads nothing, so shows no error.
    for (const query of ["#car", "car in:general", `car ${"x".repeat(97)}`]) {
      mounted.rerender(<SearchResults {...props} query={query} />);
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(screen.queryByRole("group", { name: "People" })).toBeNull();
      expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
      expect(screen.queryByText(/search community people/)).toBeNull();
    }
    expect(t.people).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
  }
});
it("tells uncached directory namesakes apart before a DM opens", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair();
  // The default naming policy, as the bundled plugin registers it.
  const directory = createAgentDirectory();
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query() {
        return [];
      },
    },
    {
      identityNames: {
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [directory],
            subscribe: () => () => {},
          }),
      } as IdentityNames,
    },
  );
  const t = peopleSession(owner.session, [
    { pubkey: first.pubkey, name: "Namesake" },
    { pubkey: second.pubkey, name: "Namesake" },
  ]);
  try {
    render(
      <SearchResults
        session={t.session}
        query="namesake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const group = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(within(group).getAllByRole("option")).toHaveLength(2),
    );
    const labels = within(group)
      .getAllByRole("option")
      .map((row) => row.textContent);
    expect(new Set(labels).size).toBe(2);
    for (const key of [first.pubkey, second.pubkey])
      expect(
        labels.some((label) =>
          label?.includes(`Namesake · ${npubEncode(key).slice(-4)}`),
        ),
      ).toBe(true);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("uses readable owners before key suffixes for agent namesakes", async () => {
  const relay = keypair(),
    viewer = keypair(),
    first = keypair(),
    second = keypair(),
    secondOwner = keypair();
  // The default naming policy, as the bundled plugin registers it.
  const directory = createAgentDirectory();
  const owner = createRelaySession(
    {
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      async query(filters) {
        return filters.some((filter) => filter.kinds?.includes(0))
          ? [profile(secondOwner, { display_name: "Morgan" })]
          : [];
      },
    },
    {
      identityNames: {
        bind: (source) =>
          bindNames(source, {
            snapshot: () => [directory],
            subscribe: () => () => {},
          }),
      } as IdentityNames,
    },
  );
  const t = peopleSession(
    owner.session,
    [
      {
        pubkey: first.pubkey,
        name: "Namesake",
        isAgent: true,
        ownerPubkey: viewer.pubkey,
      },
      {
        pubkey: second.pubkey,
        name: "Namesake",
        isAgent: true,
        ownerPubkey: secondOwner.pubkey,
      },
    ],
    [
      { pubkey: first.pubkey, name: "Namesake", managed: true },
      { pubkey: second.pubkey, name: "Namesake", managed: true },
    ],
  );
  try {
    render(
      <SearchResults
        session={t.session}
        query="namesake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    const group = await screen.findByRole("group", { name: "Agents" });
    await waitFor(() =>
      expect(within(group).getAllByRole("option")).toHaveLength(2),
    );
    expect(
      await within(group).findByRole("option", {
        name: /^Morgan’s Namesake/,
      }),
    ).toBeVisible();
    expect(
      within(group).getByRole("option", {
        name: /^NamesakeStart a direct message$/,
      }),
    ).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});
it.each([true, false])(
  "leads with a new chat for the viewer's agents, then their chats, then their DMs (Solo=%s)",
  async (solo) => {
    const relay = keypair(),
      viewer = keypair(),
      mine = keypair(),
      fresh = keypair(),
      theirs = keypair();
    const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
    const dm = (id: string, member: string) => [
      metadata(relay, id, "opaque", 1700000000, [
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, id, [viewer.pubkey, member]),
    ];
    const chat = (id: string, name: string, at: number, member: string) => [
      metadata(relay, id, name, at, [
        ["t", "stream"],
        ["private"],
        ["t", "buzz.solo"],
      ]),
      roster(relay, id, [viewer.pubkey, member]),
    ];
    const discovery = [
      ...dm("mine-dm", mine.pubkey),
      ...dm("theirs-dm", theirs.pubkey),
      // Scout's chats match by their agent, not their names.
      ...chat("older-chat", "Fix the build", 1700000001, mine.pubkey),
      ...chat("newer-chat", "Plan the week", 1700000002, mine.pubkey),
      ...chat("other-chat", "Unrelated", 1700000003, theirs.pubkey),
      // A channel that matches as well as the agent does.
      metadata(relay, "scout-ops", "scout-ops"),
      roster(relay, "scout-ops", [viewer.pubkey]),
      profile(mine, { name: "Scout", is_agent: true }),
      profile(theirs, { name: "Scooter", is_agent: true }),
      profile(fresh, { name: "Scotia", is_agent: true }),
    ];
    const owner = createRelaySession({
      ...wire.transport,
      async query(filters) {
        if (filters.some((filter) => filter.search !== undefined)) return [];
        return discovery.filter((event) =>
          filters.some((filter) => matchFilter(filter as Filter, event)),
        );
      },
    });
    const source = owner.session.agentChoices;
    const choices = {
      ...source.snapshot(),
      identities: [
        { pubkey: mine.pubkey, name: "Scout", managed: true },
        { pubkey: fresh.pubkey, name: "Scotia", managed: true },
      ],
      selectable: [
        { pubkey: mine.pubkey, name: "Scout", managed: true },
        { pubkey: fresh.pubkey, name: "Scotia", managed: true },
      ],
    };
    const session = {
      ...owner.session,
      agentChoices: {
        ...source,
        snapshot: () => choices,
        subscribe: () => () => {},
        retain: () => () => {},
        ensure: () => {},
      },
    } as typeof owner.session;
    const openAgentSession = vi.fn();
    const openConversation = vi.fn();
    try {
      const mounted = render(
        <SearchResults
          session={session}
          query="sco"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={openConversation}
          {...(solo ? { openAgentSession } : {})}
        />,
      );
      const direct = within(
        await screen.findByRole("group", { name: "Direct messages" }),
      );
      expect(
        await direct.findByRole("option", { name: /Scooter/ }),
      ).toBeVisible();
      if (!solo) {
        expect(
          await direct.findByRole("option", { name: /Scout/ }),
        ).toBeVisible();
        // An agent without a DM still offers one, as before.
        const agents = within(
          await screen.findByRole("group", { name: "Agents" }),
        );
        expect(
          agents.getByRole("option", { name: /Scotia/ }),
        ).toHaveTextContent("Start a direct message");
        expect(agents.queryByRole("option", { name: /Scout/ })).toBeNull();
        return;
      }
      const agents = within(
        await screen.findByRole("group", { name: "Agents" }),
      );
      const choice = agents.getByRole("option", { name: /Scout/ });
      expect(choice).toHaveTextContent("New chat");
      // The chats with Scout follow, newest first; the DM comes later.
      const chats = within(await screen.findByRole("group", { name: "Chats" }));
      await waitFor(() =>
        expect(
          chats.getAllByRole("option").map((row) => row.textContent),
        ).toEqual([
          expect.stringContaining("Plan the week"),
          expect.stringContaining("Fix the build"),
        ]),
      );
      expect(chats.getAllByRole("option")[0]).toHaveTextContent(
        "Chat with Scout",
      );
      expect(
        await direct.findByRole("option", { name: /Scout/ }),
      ).toBeVisible();
      await screen.findByRole("group", { name: "Channels" });
      const options = screen.getAllByRole("option");
      expect(options[0]).toBe(choice);
      const at = (name: RegExp) =>
        options.findIndex((row) => name.test(row.textContent ?? ""));
      expect(at(/Plan the week/)).toBeLessThan(at(/scout-ops/));
      expect(at(/Fix the build/)).toBeLessThan(
        options.indexOf(direct.getByRole("option", { name: /Scout/ })),
      );
      // An agent with no DM yet starts a chat too, not a DM.
      expect(agents.getByRole("option", { name: /Scotia/ })).toHaveTextContent(
        "New chat",
      );
      expect(agents.queryByRole("option", { name: /Scooter/ })).toBeNull();
      fireEvent.click(choice);
      expect(openAgentSession).toHaveBeenCalledExactlyOnceWith(mine.pubkey);
      expect(openConversation).not.toHaveBeenCalled();
      // The DM gives way only to a New chat row that shows. "cout" finds
      // the DM by substring but not the agent, so the DM stays.
      mounted.rerender(
        <SearchResults
          session={session}
          query="cout"
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={openConversation}
          openAgentSession={openAgentSession}
        />,
      );
      expect(
        await within(
          await screen.findByRole("group", { name: "Direct messages" }),
        ).findByRole("option", { name: /Scout/ }),
      ).toBeVisible();
      expect(screen.queryByRole("group", { name: "Agents" })).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it.each([
  {
    name: "keeps an agent's new chat and chats ahead of a picked channel",
    // The viewer last chose this channel for the same text; Scout matches
    // only part of it, as "Scoo" and the "scoo" chat do.
    picked: "channel:scout-ops",
    exactName: "Scoo",
    groups: ["Agents", "Chats"],
    chats: ["Plan the week", "scoo"],
    first: /Scout.*New chat/,
  },
  {
    name: "puts exact names ahead of an agent's new chat",
    picked: undefined,
    exactName: "Sco",
    // Chats leads with its exact name; Channels and Direct messages have
    // exact names too, so they come before the partly matching agent.
    groups: ["Chats", "Channels", "Direct messages", "Agents"],
    chats: ["sco", "Plan the week"],
    first: /^sco/,
  },
])("$name", async ({ picked, exactName, groups, chats: chatOrder, first }) => {
  localStorage.clear();
  if (picked) recordChoice(usage, "sco", picked);
  const relay = keypair(),
    viewer = keypair(),
    mine = keypair(),
    human = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const lower = exactName.toLowerCase();
  const dm = (id: string, member: string) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, member]),
  ];
  const chat = (id: string, name: string, at: number, members: string[]) => [
    metadata(relay, id, name, at, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    roster(relay, id, [viewer.pubkey, ...members]),
  ];
  const discovery = [
    ...dm("mine-dm", mine.pubkey),
    ...dm("human-dm", human.pubkey),
    ...chat("agent-chat", "Plan the week", 1700000002, [mine.pubkey]),
    // A chat found by its name, not its agent.
    ...chat("named-chat", lower, 1700000003, []),
    metadata(relay, "scout-ops", "scout-ops"),
    roster(relay, "scout-ops", [viewer.pubkey]),
    metadata(relay, "named-channel", lower),
    roster(relay, "named-channel", [viewer.pubkey]),
    profile(mine, { name: "Scout", is_agent: true }),
    profile(human, { name: exactName }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
    selectable: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="sco"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        usageScope={usage}
        openConversation={vi.fn()}
        openAgentSession={vi.fn()}
      />,
    );
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    await direct.findByRole("option", {
      name: new RegExp(`^${exactName}(?!ut)`),
    });
    await direct.findByRole("option", { name: /Scout/ });
    await screen.findByRole("group", { name: "Channels" });
    await screen.findByRole("group", { name: "Agents" });
    const chats = within(await screen.findByRole("group", { name: "Chats" }));
    await waitFor(() =>
      expect(
        chats.getAllByRole("option").map((row) => row.textContent),
      ).toEqual(chatOrder.map((name) => expect.stringContaining(name))),
    );
    const labels = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(labels.slice(0, groups.length)).toEqual(groups);
    expect(screen.getAllByRole("option")[0]?.textContent).toMatch(first);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  {
    name: "keeps an exactly named chat ahead of an exact agent's many chats",
    named: "chat" as const,
    groups: ["Agents", "Chats"],
  },
  {
    name: "does not let an exact agent's chats claim an exact name",
    named: "channel" as const,
    // Channels has the exact name; the agent's chats only inherit it.
    groups: ["Agents", "Channels", "Chats"],
  },
])("$name", async ({ named, groups }) => {
  localStorage.clear();
  const relay = keypair(),
    viewer = keypair(),
    mine = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const chat = (id: string, name: string, at: number, members: string[]) => [
    metadata(relay, id, name, at, [
      ["t", "stream"],
      ["private"],
      ["t", "buzz.solo"],
    ]),
    roster(relay, id, [viewer.pubkey, ...members]),
  ];
  const discovery = [
    // More chats with the agent than the group shows, all newer.
    ...Array.from({ length: 9 }, (_, index) =>
      chat(`agent-chat-${index}`, `Task ${index}`, 1700000010 + index, [
        mine.pubkey,
      ]),
    ).flat(),
    ...(named === "chat"
      ? chat("named-chat", "scout", 1700000001, [])
      : [
          metadata(relay, "named-channel", "scout"),
          roster(relay, "named-channel", [viewer.pubkey]),
        ]),
    profile(mine, { name: "Scout", is_agent: true }),
  ];
  const owner = createRelaySession({
    ...wire.transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined)) return [];
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const source = owner.session.agentChoices;
  const choices = {
    ...source.snapshot(),
    identities: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
    selectable: [{ pubkey: mine.pubkey, name: "Scout", managed: true }],
  };
  const session = {
    ...owner.session,
    agentChoices: {
      ...source,
      snapshot: () => choices,
      subscribe: () => () => {},
      retain: () => () => {},
      ensure: () => {},
    },
  } as typeof owner.session;
  try {
    render(
      <SearchResults
        session={session}
        query="scout"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        usageScope={usage}
        openConversation={vi.fn()}
        openAgentSession={vi.fn()}
      />,
    );
    await screen.findByRole("group", { name: "Agents" });
    if (named === "channel")
      await screen.findByRole("group", { name: "Channels" });
    const chats = within(await screen.findByRole("group", { name: "Chats" }));
    await waitFor(() => expect(chats.getAllByRole("option")).toHaveLength(8));
    if (named === "chat")
      expect(chats.getAllByRole("option")[0]).toHaveTextContent(/^scout/);
    const labels = screen
      .getAllByRole("group")
      .map((group) => group.getAttribute("aria-label"));
    expect(labels.slice(0, groups.length)).toEqual(groups);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("preserves remembered page ranking when inline settings match", async () => {
  localStorage.clear();
  recordChoice(usage, "sound", "Ultrasound");
  const owner = usageSession(["sound-chat"]);
  const open = vi.fn();
  try {
    render(
      <SearchResults
        session={owner.session}
        query="sound"
        onQueryChange={() => {}}
        input={createRef()}
        usageScope={usage}
        openConversation={() => {}}
        pages={[
          {
            key: "Ultrasound",
            label: "Ultrasound",
            icon: ChatCircleIcon,
            run: open,
          },
        ]}
        inlineSettings={[
          {
            label: "Settings",
            destinations: [
              {
                key: "sound-setting",
                label: "Notifications",
                detail: "Sound",
                rank: 0,
                icon: ChatCircleIcon,
                content: <button type="button">Sound</button>,
                run: vi.fn(),
              },
            ],
          },
        ]}
      />,
    );
    await screen.findByRole("row", { name: /^sound-chat/ });
    const names = screen
      .getAllByRole("rowgroup")
      .map((group) => group.getAttribute("aria-label"));
    expect(names.indexOf("Pages")).toBeLessThan(names.indexOf("Channels"));
    expect(screen.getByRole("row", { name: "Ultrasound" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(open).toHaveBeenCalledOnce();
  } finally {
    cleanup();
    owner.dispose();
    localStorage.clear();
  }
});

it.each([
  ["buzz", "Channels", "buzz-dev", ["IdentityBuzz"]],
  ["buzz", "People", "Buzz Aldrin", ["IdentityBuzz"]],
  [
    "community",
    "Channels",
    "community-news",
    ["ProfileCommunity", "MembershipCommunity admin"],
  ],
  [
    "community",
    "People",
    "Community Lead",
    ["ProfileCommunity", "MembershipCommunity admin"],
  ],
  ["labs", "Channels", "labs-crew", ["ExperimentsLabs"]],
])(
  "leads %s with %s starting with it, ahead of sections found by their Settings group",
  async (query, group, name, sections) => {
    const relay = keypair(),
      viewer = keypair(),
      person = keypair();
    const discovery =
      group === "Channels"
        ? [
            metadata(relay, name, name, 1700000000),
            roster(relay, name, [viewer.pubkey]),
          ]
        : [profile(person, { display_name: name })];
    const owner = createRelaySession({
      ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
      query: (filters) =>
        Promise.resolve(
          discovery.filter((event) =>
            filters.some((filter) => matchFilter(filter as Filter, event)),
          ),
        ),
    });
    const t = peopleSession(owner.session);
    const cards = [
      {
        key: "buzz.moderation/membership",
        title: "Membership",
        section: "administration",
      },
      { key: "labs.tools/experiments", title: "Experiments", group: "Labs" },
    ].map((card) => ({
      ...card,
      id: card.key.split("/")[1] ?? "",
      pluginId: card.key.split("/")[0] ?? "",
      revision: "one",
      component: () => null,
    }));
    const settingsCards = {
      subscribe: () => () => {},
      snapshot: () => cards,
      retainVisibility: () => () => {},
    } as unknown as AppServices["settingsCards"];
    const client = {
      selected: "primary",
      memberships: [{ id: "primary", name: "Primary" }],
    };
    const communities = {
      subscribe: () => () => {},
      snapshot: () => client,
    } as unknown as AppServices["communities"];
    const openSection = vi.fn();
    const openConversation = vi.fn();
    function Palette({ query }: { query: string }) {
      const inlineSettings = useSearchSettings({
        query,
        settingsCards,
        communities,
        navigation: {} as AppServices["navigation"],
        close: () => {},
        openSection,
      });
      return (
        <SearchResults
          session={t.session}
          query={query}
          onQueryChange={() => {}}
          input={createRef()}
          pages={[]}
          openConversation={openConversation}
          inlineSettings={inlineSettings}
        />
      );
    }
    try {
      const view = render(<Palette query="" />);
      // The joined list and a profile seen elsewhere are known before the
      // text is typed, so the name match is there when the Settings rows are.
      await waitFor(() =>
        expect(owner.session.channels.list().status).toBe("ready"),
      );
      await act(async () => owner.session.profiles.ensure([person.pubkey]));
      view.rerender(<Palette query={query} />);
      const [lead] = within(
        screen.getByRole("group", { name: group }),
      ).getAllByRole("option");
      expect(lead).toHaveTextContent(name);
      // The group label still finds its sections, after the name match.
      expect(
        within(screen.getByRole("group", { name: "Settings" }))
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual(expect.arrayContaining(sections));
      const groups = screen
        .getAllByRole("group")
        .map((element) => element.getAttribute("aria-label"));
      expect(groups.indexOf(group)).toBeLessThan(groups.indexOf("Settings"));
      const input = screen.getByRole("combobox", { name: "Search Buzz" });
      expect(input).toHaveAttribute("aria-activedescendant", lead?.id);
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() =>
        expect(openConversation).toHaveBeenCalledExactlyOnceWith(
          group === "Channels" ? name : "started-dm",
        ),
      );
      if (group === "People")
        expect(t.open).toHaveBeenCalledExactlyOnceWith(
          [person.pubkey],
          expect.any(AbortSignal),
        );
      expect(openSection).not.toHaveBeenCalled();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("holds an early Enter for a person still being found over a section holding the letters only in order", async () => {
  const relay = keypair(),
    viewer = keypair(),
    person = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    query: () => Promise.resolve([]),
  });
  // Only the directory knows Champa Rao, so the People row lands when it
  // answers.
  const t = peopleSession(owner.session);
  let answer!: () => void;
  t.people.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = () =>
          resolve({
            people: [{ pubkey: person.pubkey, name: "Champa Rao" }],
            hasMore: false,
          });
      }),
  );
  const cards = [
    {
      key: "buzz.channels/templates",
      id: "templates",
      pluginId: "buzz.channels",
      title: "Channel templates",
      group: "App",
      revision: "one",
      component: () => null,
    },
  ];
  const settingsCards = {
    subscribe: () => () => {},
    snapshot: () => cards,
    retainVisibility: () => () => {},
  } as unknown as AppServices["settingsCards"];
  const openSection = vi.fn();
  const openConversation = vi.fn();
  // "wes" finds Software updates the same way, but in the shipped palette
  // plugin rows still take its early Enter: plugin descriptions hold most
  // names' letters in order. Of the bundled plugins, controls and a member's
  // sections, "champ" matched only Channel templates, so this Enter turns on
  // section matching alone.
  function Palette() {
    const inlineSettings = useSearchSettings({
      query: "champ",
      settingsCards,
      navigation: {} as AppServices["navigation"],
      close: () => {},
      openSection,
    });
    return (
      <SearchResults
        session={t.session}
        query="champ"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
        inlineSettings={inlineSettings}
      />
    );
  }
  try {
    render(<Palette />);
    await waitFor(() => expect(t.people).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Buzz" }), {
      key: "Enter",
    });
    expect(openSection).not.toHaveBeenCalled();
    expect(openConversation).not.toHaveBeenCalled();
    await act(async () => answer());
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("started-dm"),
    );
    expect(t.open).toHaveBeenCalledExactlyOnceWith(
      [person.pubkey],
      expect.any(AbortSignal),
    );
    expect(openSection).not.toHaveBeenCalled();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("excludes proven Huddles but keeps ordinary hits after mutable metadata changes", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let live: LiveCallbacks | undefined;
  const marker = (id: string, time: number) =>
    metadata(relay, id, id, time, [
      ["t", "stream"],
      ["private"],
      ["P", viewer.pubkey],
      [
        "about",
        "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
      ],
    ]);
  const discovery = [
    marker("hidden", 1700000000),
    signed(viewer, {
      kind: 9007,
      created_at: 1700000000,
      content: "",
      tags: [
        ["h", "hidden"],
        ["visibility", "private"],
        ["channel_type", "stream"],
        [
          "about",
          "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
        ],
      ],
    }),
    metadata(relay, "later", "later"),
    roster(relay, "hidden", [viewer.pubkey]),
    roster(relay, "later", [viewer.pubkey]),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      return filters.some((filter) => filter.search)
        ? [
            message(viewer, "hidden", "hidden match", 1700000001),
            message(viewer, "later", "later match", 1700000001),
          ]
        : discovery.filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
    },
    subscribe(callbacks) {
      live = callbacks;
      return { update() {}, retry() {}, dispose() {} };
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="match"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(screen.queryByRole("option", { name: /hidden match/ })).toBeNull();
    expect(screen.getByRole("option", { name: /later match/ })).toBeVisible();
    act(() => live?.receive([marker("later", 1700000002)]));
    expect(screen.getByRole("option", { name: /later match/ })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("withholds unknown metadata, then reveals unproven legacy rooms as ordinary destinations", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search))
        return [
          message(viewer, "room", "match private", 1700000001),
          message(viewer, "ordinary", "match ordinary", 1700000001),
        ];
      if (filters.some((filter) => filter.kinds?.includes(39000))) {
        await gate;
        return [
          metadata(relay, "room", "Room", 1700000000, [
            ["private"],
            [
              "about",
              "Buzz Huddle (buzz.huddles/v1)\nparent:00000000-0000-4000-8000-000000000001",
            ],
          ]),
          metadata(relay, "ordinary", "Ordinary"),
        ];
      }
      if (filters.some((filter) => filter.kinds?.includes(39002)))
        return [
          roster(relay, "room", [viewer.pubkey]),
          roster(relay, "ordinary", [viewer.pubkey]),
        ];
      return [];
    },
  });
  try {
    render(
      <SearchResults
        session={owner.session}
        query="match"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={() => {}}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    });
    expect(owner.session.channels.get?.("room")?.metadataPending).toBe(true);
    expect(
      screen.queryByRole("option", { name: /match private|match ordinary/ }),
    ).toBeNull();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("option", { name: /match private/ })).toBeVisible();
    expect(
      screen.getByRole("option", { name: /match ordinary/ }),
    ).toBeVisible();
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it("leaves sidebar-hidden DMs out of the rows but keeps their message hits", async () => {
  // The sidebar hides a DM on this device (Hide conversation) or by the
  // relay's DM visibility list. Search reads both, as the sidebar does.
  const scope = "search-hidden-dms";
  writeView(scope, "hidden-dms", [{ id: "local-dm" }]);
  const relay = keypair(),
    viewer = keypair();
  const dms = [
    { id: "local-dm", name: "Scotty", key: keypair() },
    { id: "relay-dm", name: "Scooby", key: keypair() },
    { id: "shown-dm", name: "Scott", key: keypair() },
  ];
  const discovery = dms.flatMap(({ id, key, name }) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, key.pubkey]),
    profile(key, { name }),
  ]);
  const hits = [
    message(viewer, "local-dm", "sco from local", 1700000001),
    message(viewer, "relay-dm", "sco from relay", 1700000001),
  ];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (filters.some((filter) => filter.search !== undefined))
        return filters.some((filter) => filter.kinds?.includes(0)) ? [] : hits;
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  const lifecycle = owner.session.channelLifecycle;
  const visibility = {
    ...lifecycle.snapshot(),
    status: "ready" as const,
    hidden: Object.freeze(["relay-dm"]),
  };
  // The confirmed open is what restores a hidden DM's sidebar row.
  const open = vi.fn(async () => "local-dm");
  const session = {
    ...owner.session,
    channelLifecycle: {
      ...lifecycle,
      snapshot: () => visibility,
      subscribe: () => () => {},
    },
    directMessages: {
      ...owner.session.directMessages,
      available: true,
      open,
    },
  } as typeof owner.session;
  const openConversation = vi.fn();
  try {
    render(
      <SearchResults
        session={session}
        query="sco"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={openConversation}
        sidebarScope={scope}
      />,
    );
    const direct = within(
      await screen.findByRole("group", { name: "Direct messages" }),
    );
    expect(
      await direct.findByRole("option", { name: /^Scott(?!y)/ }),
    ).toBeVisible();
    expect(direct.queryByRole("option", { name: /Scotty/ })).toBeNull();
    expect(direct.queryByRole("option", { name: /Scooby/ })).toBeNull();
    expect(
      await screen.findByRole("option", { name: /sco from local/ }),
    ).toBeVisible();
    expect(
      await screen.findByRole("option", { name: /sco from relay/ }),
    ).toBeVisible();
    // Choosing the person opens the locally hidden DM through the confirmed
    // open, not the plain shortcut that leaves its row hidden.
    const people = within(await screen.findByRole("group", { name: "People" }));
    fireEvent.click(await people.findByRole("option", { name: /Scotty/ }));
    await waitFor(() =>
      expect(openConversation).toHaveBeenCalledExactlyOnceWith("local-dm"),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      [dms[0]?.key.pubkey],
      expect.any(AbortSignal),
    );
    // When the sidebar restores the row, search follows without remounting.
    act(() => {
      writeView(scope, "hidden-dms", []);
    });
    expect(await direct.findByRole("option", { name: /Scotty/ })).toBeVisible();
  } finally {
    cleanup();
    owner.dispose();
    clearViewScope(scope);
  }
});

it("loads verified names for a settled search page in the background and shows them beside the detail", async () => {
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair(),
    newcomer = keypair();
  const reads: {
    subjects: readonly string[] | undefined;
    signal: AbortSignal | undefined;
    release: () => void;
  }[] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters, signal) {
      if (!filters.some((filter) => filter.kinds?.includes(30382))) return [];
      await new Promise<void>((release) =>
        reads.push({ subjects: filters[0]?.["#d"], signal, release }),
      );
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", "fname"],
              ["username", "fname"],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
              ["full_name", "Fake Name"],
            ],
          }),
        ),
      ];
    },
  });
  const t = peopleSession(owner.session);
  let settle = () => {};
  const page = new Promise<void>((release) => (settle = release));
  t.people.mockImplementation(async (query?: string) => {
    await page;
    return {
      people: [
        { pubkey: fake.pubkey, name: "Fake" },
        ...(query === "fake na"
          ? [{ pubkey: newcomer.pubkey, name: "Fake Na" }]
          : []),
      ],
      hasMore: false,
    };
  });
  const props = {
    session: t.session,
    onQueryChange() {},
    input: createRef<HTMLInputElement>(),
    pages: [],
    openConversation: vi.fn(),
  };
  try {
    const mounted = render(<SearchResults {...props} query="fake" />);
    await waitFor(() => expect(t.people).toHaveBeenCalled());
    // Nothing verified is read before the page settles.
    expect(reads).toHaveLength(0);
    await act(async () => settle());
    const people = await screen.findByRole("group", { name: "People" });
    await waitFor(() => expect(reads).toHaveLength(1));
    // The page shows its profile names while the verified read is held.
    expect(within(people).getByRole("option")).toHaveTextContent(
      "FakeStart a direct message",
    );
    expect(within(people).getByRole("option")).not.toHaveTextContent("Name");
    await act(async () => reads[0]?.release());
    await waitFor(() =>
      expect(within(people).getByRole("option")).toHaveTextContent(
        /fnameFake Name · Start a direct message$/,
      ),
    );
    // Refining the query keeps the row by its verified full name and does not
    // ask about someone already looked up.
    mounted.rerender(<SearchResults {...props} query="fake n" />);
    await waitFor(() =>
      expect(t.people).toHaveBeenLastCalledWith("fake n", 1, expect.anything()),
    );
    expect(within(people).getByRole("option")).toHaveTextContent("Fake Name");
    // A page with someone new asks only about them, and a newer query
    // cancels that held read.
    mounted.rerender(<SearchResults {...props} query="fake na" />);
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads[1]?.subjects).toEqual([newcomer.pubkey]);
    mounted.rerender(<SearchResults {...props} query="fake nam" />);
    await waitFor(() => expect(reads[1]?.signal?.aborted).toBe(true));
  } finally {
    for (const read of reads) read.release();
    cleanup();
    owner.dispose();
  }
});

it("reuses shared verified names and reads only the rest of a search page", async () => {
  const relay = keypair(),
    viewer = keypair(),
    known = keypair(),
    fake = keypair();
  const assertion = (subject: string, display: string, full: string) =>
    eventDto(
      signed(relay, {
        kind: 30382,
        created_at: 1_000_000,
        content: "",
        tags: [
          ["d", subject],
          ["p", subject],
          ["active", "true"],
          ["display_name", display],
          ["username", display],
          ["issuer_label", "Block"],
          ["verified_at", "1000000"],
          ["full_name", full],
        ],
      }),
    );
  const searched: (readonly string[] | undefined)[] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters) {
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter) return [];
      searched.push(filter["#d"]);
      // The relay fails this read: the page keeps its profile names.
      throw new ReadError("unavailable", "Relay unavailable");
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles(_filter, sink) {
          sink.event(assertion(known.pubkey, "fother", "Fake Other"));
          sink.eose();
          return () => {};
        },
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: known.pubkey, name: "Fake" },
    { pubkey: fake.pubkey, name: "Fake" },
  ]);
  try {
    void owner.session.profiles.ensure([known.pubkey]);
    await waitFor(() =>
      expect(
        owner.session.profiles.snapshot().get(known.pubkey)?.verified,
      ).toBeDefined(),
    );
    render(
      <SearchResults
        session={t.session}
        query="fake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={vi.fn()}
      />,
    );
    await waitFor(() => expect(searched).toEqual([[fake.pubkey]]));
    const people = await screen.findByRole("group", { name: "People" });
    // The shared directory names the known Fake without a search read.
    await waitFor(() =>
      expect(
        within(people)
          .getAllByRole("option")
          .map((row) => row.textContent),
      ).toEqual([
        // The exact profile name ranks first; the failed read keeps it.
        expect.stringMatching(/FakeStart a direct message$/),
        expect.stringMatching(/fotherFake Other · Start a direct message$/),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("keeps a row found by its profile name once a verified name replaces it, drops page names when discovery withdraws the authority, and checks again when it returns", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair(),
    other = keypair();
  const advertised = { pubkey: relay.pubkey, multipleIssuers: false };
  let discovery: typeof advertised | null = advertised,
    display = "fname",
    reads = 0;
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: advertised,
    readVerifiedProfileAuthority: async () => discovery && { ...discovery },
    async query(filters) {
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter?.["#d"]?.includes(fake.pubkey)) return [];
      reads++;
      // No optional full name: only the profile name matches "fake".
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000 + reads,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", display],
              ["username", display],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
            ],
          }),
        ),
      ];
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles: () => () => {},
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: fake.pubkey, name: "Fake" },
  ]);
  const settle = (ms: number) =>
    act(async () => vi.advanceTimersByTimeAsync(ms));
  const row = () =>
    within(screen.getByRole("group", { name: "People" })).getByRole("option");
  try {
    // Shared demand for someone else arms the discovery refresh.
    void owner.session.profiles.ensure([other.pubkey]);
    render(
      <SearchResults
        session={t.session}
        query="fake"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={vi.fn()}
      />,
    );
    await settle(SEARCH_DEBOUNCE_MS);
    await settle(0);
    expect(row()).toHaveTextContent(/fnameStart a direct message$/);
    discovery = null;
    await settle(5 * 60_000);
    await settle(1_000);
    expect(row()).toHaveTextContent(/FakeStart a direct message$/);
    // The same key, re-enabled, checks the page again instead of restoring
    // what the withdrawn authority checked.
    discovery = advertised;
    display = "knew";
    await settle(5 * 60_000);
    await settle(1_000);
    expect(row()).toHaveTextContent(/knewStart a direct message$/);
    expect(reads).toBe(2);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("labels a row by its verified name over a cached profile name without a naming policy", async () => {
  const relay = keypair(),
    viewer = keypair(),
    fake = keypair();
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    verifiedProfiles: { pubkey: relay.pubkey, multipleIssuers: false },
    async query(filters) {
      if (filters.some((filter) => filter.kinds?.includes(0)))
        return [
          eventDto(
            signed(fake, {
              kind: 0,
              created_at: 1_000_000,
              content: JSON.stringify({ name: "fak" }),
              tags: [],
            }),
          ),
        ];
      const filter = filters.find((item) => item.kinds?.includes(30382));
      if (!filter?.["#d"]?.includes(fake.pubkey)) return [];
      return [
        eventDto(
          signed(relay, {
            kind: 30382,
            created_at: 1_000_000,
            content: "",
            tags: [
              ["d", fake.pubkey],
              ["p", fake.pubkey],
              ["active", "true"],
              ["display_name", "fname"],
              ["username", "fname"],
              ["issuer_label", "Block"],
              ["verified_at", "1000000"],
            ],
          }),
        ),
      ];
    },
    subscribe(callbacks) {
      callbacks.state({ status: "connected", routes: [] });
      return {
        update() {},
        retry() {},
        dispose() {},
        syncVerifiedProfiles: () => () => {},
      };
    },
  });
  const t = peopleSession(owner.session, [
    { pubkey: fake.pubkey, name: "fak" },
  ]);
  try {
    // The shared profiles hold their kind-0 name but no verified name.
    void owner.session.profiles.ensure([fake.pubkey]);
    await waitFor(() =>
      expect(owner.session.profiles.snapshot().get(fake.pubkey)?.name).toBe(
        "fak",
      ),
    );
    render(
      <SearchResults
        session={t.session}
        query="fak"
        onQueryChange={() => {}}
        input={createRef()}
        pages={[]}
        openConversation={vi.fn()}
      />,
    );
    const people = await screen.findByRole("group", { name: "People" });
    await waitFor(() =>
      expect(within(people).getByRole("option")).toHaveTextContent(
        /fnameStart a direct message$/,
      ),
    );
    expect(owner.session.profiles.snapshot().get(fake.pubkey)?.verified).toBe(
      undefined,
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

/** A session over joined `discovery` whose searches answer `hits`, recording
 * every message read. */
function operatorSession(
  viewer: ReturnType<typeof keypair>,
  relay: ReturnType<typeof keypair>,
  discovery: ReturnType<typeof metadata>[],
  hits: ReturnType<typeof message>[] = [],
) {
  const reads: Filter[][] = [];
  const owner = createRelaySession({
    ...scriptedTransport(viewer.pubkey, relay.pubkey).transport,
    async query(filters) {
      if (
        filters.some(
          (filter) => filter.search !== undefined || filter.kinds?.includes(9),
        )
      ) {
        reads.push(filters as Filter[]);
        return hits;
      }
      return discovery.filter((event) =>
        filters.some((filter) => matchFilter(filter as Filter, event)),
      );
    },
  });
  return { owner, reads };
}

const operatorProps = {
  onQueryChange: () => {},
  input: createRef<HTMLInputElement>(),
  pages: [],
  openConversation: () => {},
};

it.each(["from:me", "deploy from:@ME in:#crew "])(
  "searches the viewer's own messages for %s without a people lookup",
  async (query) => {
    const relay = keypair(),
      viewer = keypair();
    const { owner, reads } = operatorSession(
      viewer,
      relay,
      [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
      [message(viewer, "crew", "deploy by me", 1700000001)],
    );
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          {...operatorProps}
        />,
      );
      expect(
        await screen.findByRole("option", { name: /deploy by me/ }),
      ).toBeVisible();
      expect(reads.flat()).toEqual([
        expect.objectContaining({ authors: [viewer.pubkey] }),
      ]);
      expect(screen.queryByText("Searching people…")).toBeNull();
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("resolves in:@person to the viewer's direct message with them", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair(),
    bob = keypair();
  const dm = (id: string, person: ReturnType<typeof keypair>) => [
    metadata(relay, id, "opaque", 1700000000, [
      ["t", "dm"],
      ["private", ""],
    ]),
    roster(relay, id, [viewer.pubkey, person.pubkey]),
  ];
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      ...dm("dm-alice", alice),
      ...dm("dm-bob", bob),
      profile(alice, { name: "Alice" }),
      profile(bob, { name: "Bob" }),
    ],
    [message(alice, "dm-alice", "deploy to Alice", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:@alice "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy to Alice/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({ "#h": ["dm-alice"] }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("resolves in:@me to the viewer's self-DM", async () => {
  const relay = keypair(),
    viewer = keypair(),
    alice = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "self", "opaque", 1700000000, [
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, "self", [viewer.pubkey]),
      metadata(relay, "dm-alice", "opaque", 1700000000, [
        ["t", "dm"],
        ["private", ""],
      ]),
      roster(relay, "dm-alice", [viewer.pubkey, alice.pubkey]),
    ],
    [message(viewer, "self", "deploy note to self", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:@me "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy note to self/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([expect.objectContaining({ "#h": ["self"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("prefers a live in: channel over an archived namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "old", "crew", 1700000000, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(relay, "old", [viewer.pubkey]),
      metadata(relay, "live", "crew"),
      roster(relay, "live", [viewer.pubkey]),
    ],
    [message(viewer, "live", "deploy live", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /deploy live/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([expect.objectContaining({ "#h": ["live"] })]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

const openChannel = [
  ["public", ""],
  ["t", "stream"],
];

it("prefers a live open in: channel over an archived joined namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [
      metadata(relay, "old", "crew", 1700000000, [
        ["t", "stream"],
        ["archived", "true"],
      ]),
      roster(relay, "old", [viewer.pubkey]),
      metadata(relay, "open", "crew", 1700000000, openChannel),
    ],
    [message(viewer, "open", "deploy open", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    await waitFor(() =>
      expect(reads.flat()).toEqual([
        expect.objectContaining({ "#h": ["open"] }),
      ]),
    );
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("refuses a joined in: channel with a live open namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "joined", "crew"),
    roster(relay, "joined", [viewer.pubkey]),
    metadata(relay, "open", "crew", 1700000000, openChannel),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="deploy in:#crew "
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByText(
        "More than one conversation is named “crew”. Search in that conversation instead.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("waits for the exact in: lookup before trusting one cached open namesake", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "team-a", "team", 1700000000, openChannel),
    metadata(relay, "team-b", "team", 1700000000, openChannel),
  ]);
  const searchPublic = owner.session.channels.searchPublic;
  assert.exists(searchPublic);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lookups = 0;
  try {
    owner.session.channels.ensureList();
    await waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
    // Both namesakes are previewable, but the cache holds only the first.
    const { channels } = await searchPublic("team", { exact: true });
    expect(channels).toHaveLength(2);
    const session = {
      ...owner.session,
      channels: {
        ...owner.session.channels,
        matchPublic: () => channels.slice(0, 1),
        searchPublic: async (...args: Parameters<typeof searchPublic>) => {
          if (args[1]?.exact) lookups++;
          await held;
          return searchPublic(...args);
        },
      },
    };
    vi.useFakeTimers();
    render(
      <SearchResults
        session={session}
        query="deploy in:#team "
        {...operatorProps}
      />,
    );
    // Past both debounces: a resolved channel would have started a read.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(lookups).toBe(1);
    expect(reads).toEqual([]);
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(
      screen.getByText(
        "More than one conversation is named “team”. Search in that conversation instead.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    release();
    cleanup();
    owner.dispose();
  }
});

it.each([
  [
    "deploy in:#crew ",
    "More than one conversation is named “crew”. Search in that conversation instead.",
  ],
  ["deploy in:@nobody ", "No conversation named “@nobody”."],
])("explains an unresolved %s and does not search", async (query, text) => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "one", "crew"),
    roster(relay, "one", [viewer.pubkey]),
    metadata(relay, "two", "crew"),
    roster(relay, "two", [viewer.pubkey]),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query={query}
        {...operatorProps}
      />,
    );
    // Past the debounce, with the joined list read: any search has started.
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(screen.getByText(text)).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("sends a phrase with exclusions as a full-text search", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "the rollback plan for prod", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query={'"rollback plan" -staging on:2023-11-14'}
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /rollback plan for prod/ }),
    ).toBeVisible();
    expect(reads.flat()).toEqual([
      expect.objectContaining({
        search: '"rollback plan" -staging',
        search_mode: "fulltext",
        since: Math.floor(new Date(2023, 10, 14).getTime() / 1000),
        until: Math.floor(new Date(2023, 10, 15).getTime() / 1000) - 1,
      }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it.each([
  '"rollback during:october from:me plan"',
  '"-staging"',
  '"OR"',
  'error:"connection refused"',
  'rollback"plan now"',
])(
  "searches the quoted phrase %s as text, not filters or exclusions",
  async (query) => {
    const relay = keypair(),
      viewer = keypair();
    const { owner, reads } = operatorSession(
      viewer,
      relay,
      [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
      [message(viewer, "crew", "quoted phrase hit", 1700000001)],
    );
    try {
      render(
        <SearchResults
          session={owner.session}
          query={query}
          {...operatorProps}
        />,
      );
      expect(
        await screen.findByRole("option", { name: /quoted phrase hit/ }),
      ).toBeVisible();
      // Plain text also searches people; only the message read is in scope.
      expect(
        reads.flat().filter((filter) => filter.kinds?.includes(9)),
      ).toEqual([
        {
          kinds: [40002, 40008, 9],
          search: query,
          search_mode: "fulltext",
          limit: 20,
        },
      ]);
    } finally {
      cleanup();
      owner.dispose();
    }
  },
);

it("keeps an author operator typed inside an open quote as phrase text", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "quoted author text", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query={'"rollback from:alex'}
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /quoted author text/ }),
    ).toBeVisible();
    expect(screen.queryByRole("group", { name: "People" })).toBeNull();
    expect(reads.flat().filter((filter) => filter.kinds?.includes(9))).toEqual([
      expect.objectContaining({
        search: '"rollback from:alex',
        search_mode: "prefix",
      }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("searches a double-hyphen command flag rather than refusing it as an exclusion", async () => {
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(
    viewer,
    relay,
    [metadata(relay, "crew", "crew"), roster(relay, "crew", [viewer.pubkey])],
    [message(viewer, "crew", "run it with --help", 1700000001)],
  );
  try {
    render(
      <SearchResults
        session={owner.session}
        query="--help"
        {...operatorProps}
      />,
    );
    expect(
      await screen.findByRole("option", { name: /run it with --help/ }),
    ).toBeVisible();
    expect(reads.flat().filter((filter) => filter.kinds?.includes(9))).toEqual([
      expect.objectContaining({ search: "--help", search_mode: "prefix" }),
    ]);
  } finally {
    cleanup();
    owner.dispose();
  }
});

it("asks for a search word when the text only excludes", async () => {
  vi.useFakeTimers();
  const relay = keypair(),
    viewer = keypair();
  const { owner, reads } = operatorSession(viewer, relay, [
    metadata(relay, "crew", "crew"),
    roster(relay, "crew", [viewer.pubkey]),
  ]);
  try {
    render(
      <SearchResults
        session={owner.session}
        query="-staging in:#crew "
        {...operatorProps}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2));
    expect(
      screen.getByText(
        "Add a word or “phrase” to search for alongside -exclusions.",
      ),
    ).toBeVisible();
    expect(reads).toEqual([]);
  } finally {
    cleanup();
    owner.dispose();
  }
});
