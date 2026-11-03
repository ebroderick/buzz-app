// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelList } from "../../features/relay/contracts";
import {
  SIDEBAR_REVEAL_BUDGET_MS,
  useSidebarStartup,
  type SidebarStartupSession,
} from "./useSidebarStartup";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function fixture() {
  let resolve!: () => void;
  const unread = new Promise<void>((done) => {
    resolve = done;
  });
  let live: ReturnType<SidebarStartupSession["live"]["snapshot"]> = {
    status: "unavailable",
    routes: [],
    roster: { state: "pending" },
    heads: [],
  };
  const listeners = new Set<() => void>();
  const session: SidebarStartupSession = {
    live: {
      snapshot: () => live,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    unread: { ensure: vi.fn(() => unread) },
  };
  return {
    session,
    resolve,
    names(state: "verified" | "error" = "verified") {
      live = { ...live, roster: { state } };
      for (const listener of listeners) listener();
    },
    heads() {
      live = { ...live, heads: [...live.heads] };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}
const list: ChannelList = {
  status: "ready",
  channels: [{ id: "one", name: "One" }],
  activityStatus: "loading",
};
const preferences = {
  status: "ready",
  data: {
    sections: [],
    assignments: {},
    starred: [],
    muted: [],
    sort: { channels: "recent" },
  },
} as const;
function View({
  session,
  value = list,
  prefs = preferences,
}: {
  session: SidebarStartupSession;
  value?: ChannelList;
  prefs?: Parameters<typeof useSidebarStartup>[2];
}) {
  const state = useSidebarStartup(session, value, prefs);
  return (
    <div>
      {state.ready
        ? value.channels.map(({ id, name }) => (
            <button type="button" key={id}>
              {name}
            </button>
          ))
        : "Loading"}
      <span data-testid="updating">{String(state.updating)}</span>
    </div>
  );
}

it.each(["recent", "plugin:example.plugin/rows/oldest"] as const)(
  "reveals once after names, saved preferences, unread and %s activity settle in any order",
  async (mode) => {
    const selected = {
      ...preferences,
      data: { ...preferences.data, sort: { channels: mode } },
    };
    const h = fixture();
    const view = render(
      <StrictMode>
        <View session={h.session} prefs={{ status: "loading" }} />
      </StrictMode>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => {
      h.resolve();
    });
    act(() => h.names());
    view.rerender(
      <StrictMode>
        <View session={h.session} prefs={selected} />
      </StrictMode>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <StrictMode>
        <View
          session={h.session}
          value={{ ...list, activityStatus: "ready" }}
          prefs={selected}
        />
      </StrictMode>,
    );
    expect(screen.getByRole("button", { name: "One" })).toBeVisible();
    expect(screen.getByTestId("updating")).toHaveTextContent("false");
    // A later refresh never blanks navigation, nor retains revoked rows.
    view.rerender(
      <StrictMode>
        <View
          session={h.session}
          value={{ ...list, channels: [], activityStatus: "loading" }}
          prefs={{ status: "loading" }}
        />
      </StrictMode>,
    );
    expect(screen.queryByText("Loading", { exact: true })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  },
);

it("does not render again when only live heads change", () => {
  const h = fixture();
  let renders = 0;
  function Counted() {
    renders += 1;
    useSidebarStartup(h.session, list, preferences);
    return null;
  }
  render(<Counted />);
  const before = renders;
  act(() => h.heads());
  expect(renders).toBe(before);
  act(() => h.names());
  expect(renders).toBe(before + 1);
});

it("caps cold presentation waiting after authorization without needing optional reads to finish", async () => {
  vi.useFakeTimers();
  const h = fixture();
  const view = render(
    <View
      session={h.session}
      value={{ ...list, status: "loading" }}
      prefs={{ status: "loading" }}
    />,
  );
  await act(async () => {
    vi.advanceTimersByTime(5000);
  });
  expect(h.session.unread.ensure).not.toHaveBeenCalled();
  expect(screen.queryByRole("button")).toBeNull();
  view.rerender(<View session={h.session} prefs={{ status: "loading" }} />);
  await act(async () => {
    vi.advanceTimersByTime(SIDEBAR_REVEAL_BUDGET_MS - 1);
  });
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.getByRole("button")).toBeVisible();
  expect(screen.getByTestId("updating")).toHaveTextContent("true");
});

it("does not wait for activity in A–Z or treat failed preferences as an endless load", async () => {
  const h = fixture();
  h.names();
  h.resolve();
  await act(async () => {
    render(
      <View
        session={h.session}
        prefs={{ status: "error", error: "offline" }}
      />,
    );
  });
  expect(screen.getByRole("button")).toBeVisible();
});

it("retains warm presentation but not another session's rows or readiness; unmount removes subscribers", async () => {
  const h = fixture();
  h.names();
  h.resolve();
  const view = render(
    <View session={h.session} value={{ ...list, activityStatus: "ready" }} />,
  );
  await act(async () => {});
  expect(screen.getByRole("button")).toBeVisible();
  view.unmount();
  expect(h.listeners.size).toBe(0);
  const warm = render(
    <View session={h.session} value={{ ...list, activityStatus: "ready" }} />,
  );
  expect(screen.getByRole("button")).toBeVisible();
  expect(screen.getByTestId("updating")).toHaveTextContent("false");
  warm.unmount();
  const replacement = fixture();
  render(<View session={replacement.session} />);
  expect(screen.queryByRole("button")).toBeNull();
});

it("settles failed optional reads without an endless loading notice", async () => {
  const h = fixture();
  h.names("error");
  vi.mocked(h.session.unread.ensure).mockRejectedValue(new Error("offline"));
  await act(async () => {
    render(
      <View session={h.session} value={{ ...list, activityStatus: "error" }} />,
    );
  });
  expect(screen.getByRole("button")).toBeVisible();
  expect(screen.getByTestId("updating")).toHaveTextContent("false");
});

it("retains unread settlement after page exit without revealing a replacement session", async () => {
  vi.useFakeTimers();
  const h = fixture();
  h.names();
  const view = render(
    <View session={h.session} value={{ ...list, activityStatus: "ready" }} />,
  );
  await act(async () => vi.advanceTimersByTime(SIDEBAR_REVEAL_BUDGET_MS));
  expect(screen.getByTestId("updating")).toHaveTextContent("true");
  view.unmount();
  const replacement = fixture();
  const other = render(<View session={replacement.session} />);
  await act(async () => h.resolve());
  expect(screen.queryByRole("button")).toBeNull();
  other.unmount();
  render(
    <View session={h.session} value={{ ...list, activityStatus: "ready" }} />,
  );
  expect(screen.getByRole("button")).toBeVisible();
  expect(screen.getByTestId("updating")).toHaveTextContent("false");
});
