// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelList } from "../relay/contracts";
import { PublishNotSent, PublishRejected } from "../relay/outbox";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import { relayPartition } from "../relay/partition";
import { readView, writeView } from "../../shared/view-state";
import { ensureDefaultChannels, useDefaultChannels } from "./default-channels";

const viewer = "a".repeat(64);
const origin = "https://relay.test";
const scope = relayPartition(origin, viewer);
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Every view-state write fails, as when storage is full. */
const storageFull = () =>
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage is full", "QuotaExceededError");
  });

function harness({
  marker = "pending",
  joined = [],
  ids = ["general", "welcome"],
  available = true,
  run = async () => {},
}: {
  /** `null` writes no marker. */
  marker?: "pending" | "done" | { owed: string[] } | null;
  joined?: readonly string[];
  ids?: readonly string[];
  available?: boolean;
  /** `publish` records a membership the relay applied even if `run` then
   * throws, as for an accepted join whose confirmation was lost. */
  run?: (
    action: string,
    id: string,
    signal: AbortSignal | undefined,
    publish: () => void,
  ) => Promise<void>;
} = {}) {
  if (marker) writeView(scope, "default-channels", marker);
  // The store's contract: candidates are the flagged channels the viewer has
  // not joined, so a join that succeeded stays out of the next run.
  const roster = new Set(joined);
  const defaultChannels = vi.fn(async () =>
    ids.filter((id) => !roster.has(id)),
  );
  const lifecycle = {
    available,
    run: vi.fn(async (action: string, id: string, signal?: AbortSignal) => {
      await run(action, id, signal, () => roster.add(id));
      roster.add(id);
    }),
  };
  return {
    defaultChannels,
    lifecycle,
    marker: () => readView(scope, "default-channels", undefined),
    joins: () => lifecycle.run.mock.calls.map(([, id]) => id),
    leave: (id: string) => roster.delete(id),
    ensure: (signal = new AbortController().signal) =>
      ensureDefaultChannels({
        queries: { defaultChannels },
        lifecycle,
        scope,
        signal,
      }),
  };
}

it("joins each flagged channel the viewer lacks, in order, then marks the scope done", async () => {
  const h = harness();
  await h.ensure();
  expect(
    h.lifecycle.run.mock.calls.map(([action, id]) => [action, id]),
  ).toEqual([
    ["join", "general"],
    ["join", "welcome"],
  ]);
  expect(h.marker()).toBe("done");
});

it.each([
  ["no marker (upgrade, another device, cleared storage)", null],
  ["a done marker", "done"],
] as const)(
  "%s reads nothing and sends nothing, even with an empty roster",
  async (_case, marker) => {
    const h = harness({ marker });
    await h.ensure();
    expect(h.defaultChannels).not.toHaveBeenCalled();
    expect(h.lifecycle.run).not.toHaveBeenCalled();
    expect(h.marker()).toBe(marker ?? undefined);
  },
);

it("resumes after one join succeeded: the next run joins only what is still owed", async () => {
  let failing = true;
  const h = harness({
    run: async (_action, id) => {
      if (id === "welcome" && failing) throw new Error("connection lost");
    },
  });
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toEqual({ owed: ["welcome"] });
  failing = false;
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome", "welcome"]);
  expect(h.marker()).toBe("done");
});

it("never owes a channel the claim already added, so leaving it stands", async () => {
  let unsent = true;
  // The claim added #general; adding #welcome failed there.
  const h = harness({
    joined: ["general"],
    run: async (_action, id) => {
      if (id === "welcome" && unsent)
        throw new PublishNotSent("rate-limited: slow down");
    },
  });
  await h.ensure();
  expect(h.joins()).toEqual(["welcome"]);
  expect(h.marker()).toEqual({ owed: ["welcome"] });
  h.leave("general");
  unsent = false;
  await h.ensure();
  expect(h.joins()).toEqual(["welcome", "welcome"]);
  expect(h.marker()).toBe("done");
});

it("drops an owed channel that is no longer missing without sending", async () => {
  const h = harness({ marker: { owed: ["welcome"] }, joined: ["welcome"] });
  await h.ensure();
  expect(h.lifecycle.run).not.toHaveBeenCalled();
  expect(h.marker()).toBe("done");
});

it("skips channels already joined and settles when none is missing", async () => {
  const h = harness({ joined: ["general", "welcome"] });
  await h.ensure();
  expect(h.lifecycle.run).not.toHaveBeenCalled();
  expect(h.marker()).toBe("done");
});

it("continues past a relay rejection and still settles", async () => {
  const h = harness({
    run: async (_action, id) => {
      if (id === "general")
        throw new PublishRejected("Rejected", "restricted: invite only");
    },
  });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBe("done");
});

it.each([
  [
    "a rate-limit refusal",
    new PublishRejected("Rejected", "rate-limited: slow down"),
  ],
  [
    "a rate-limit refusal without a reason",
    new PublishRejected("rate-limited: slow down"),
  ],
  [
    "a write that never left the device",
    new PublishNotSent("Relay asked the client to wait"),
  ],
  // `lifecycle.run` is single-flight; a user-initiated action throws a plain
  // Error at the fallback, not a PublishRejected.
  [
    "a busy lifecycle owner",
    new Error("Another channel action is still in progress"),
  ],
])(
  "tries every candidate but keeps one owed after %s",
  async (_case, error) => {
    const h = harness({
      run: async (_action, id) => {
        if (id === "general") throw error;
      },
    });
    await h.ensure();
    expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
    expect(h.marker()).toEqual({ owed: ["general"] });
  },
);

it("settles a join accepted but unconfirmed, so leaving it stands", async () => {
  const h = harness({
    run: async (_action, id, _signal, publish) => {
      if (id !== "general") return;
      publish();
      throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    },
  });
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toBe("done");
  h.leave("general");
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
});

it("settles a join cancelled after publishing, then stops", async () => {
  const controller = new AbortController();
  const h = harness({
    run: async (_action, id, signal, publish) => {
      if (id !== "general") return;
      publish();
      controller.abort();
      // The lifecycle owner reports any failure after publishing, an abort
      // included, as unconfirmed.
      throw new ChannelLifecycleUnconfirmed(signal?.reason);
    },
  });
  await h.ensure(controller.signal);
  expect(h.joins()).toEqual(["general"]);
  expect(h.marker()).toEqual({ owed: ["welcome"] });
  h.leave("general");
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toBe("done");
});

it("sends no join until the owed snapshot is stored", async () => {
  const h = harness();
  const full = storageFull();
  await h.ensure();
  await h.ensure();
  expect(h.defaultChannels).toHaveBeenCalledTimes(2);
  expect(h.lifecycle.run).not.toHaveBeenCalled();
  expect(h.marker()).toBe("pending");
  full.mockRestore();
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toBe("done");
});

it("forgets the marker when a join cannot be recorded, so leaving it stands", async () => {
  const h = harness({
    run: async (_action, id) => {
      if (id === "general") storageFull();
    },
  });
  await h.ensure();
  vi.restoreAllMocks();
  expect(h.joins()).toEqual(["general"]);
  expect(h.marker()).toBeUndefined();
  h.leave("general");
  await h.ensure();
  expect(h.joins()).toEqual(["general"]);
});

it("a capped directory page is final: a flagged channel past it is never owed", async () => {
  const h = harness({ ids: ["general"] });
  await h.ensure();
  expect(h.joins()).toEqual(["general"]);
  expect(h.marker()).toBe("done");
  await h.ensure();
  expect(h.defaultChannels).toHaveBeenCalledOnce();
});

it.each([
  ["pending", "pending"],
  ["an owed set", { owed: ["welcome"] }],
] as const)(
  "skips when channel actions are unavailable on this connection, keeping %s",
  async (_case, marker) => {
    const h = harness({
      marker: typeof marker === "string" ? marker : { owed: [...marker.owed] },
      available: false,
    });
    await h.ensure();
    expect(h.defaultChannels).not.toHaveBeenCalled();
    expect(h.marker()).toEqual(marker);
  },
);

it("a run cancelled before publishing stops and keeps what is still owed for the next session", async () => {
  const controller = new AbortController();
  const h = harness({
    run: async (_action, id, signal) => {
      if (id !== "welcome") return;
      controller.abort();
      throw signal?.reason;
    },
  });
  await h.ensure(controller.signal);
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toEqual({ owed: ["welcome"] });
});

it("the effect waits for a verified live roster on a live connection", async () => {
  let live = { roster: { state: "pending" } };
  const listeners = new Set<() => void>();
  const defaultChannels = vi.fn(async () => []);
  const list: ChannelList = { status: "ready", channels: [] };
  const session = {
    channels: {
      list: () => list,
      subscribeList: () => () => {},
      ensureList() {},
      defaultChannels,
    },
    channelLifecycle: { available: true, run: vi.fn() },
    live: {
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => live,
    },
  } as unknown as Parameters<typeof useDefaultChannels>[0];
  writeView(scope, "default-channels", "pending");
  const cached = renderHook(() => useDefaultChannels(session, scope, true));
  const connected = renderHook(() => useDefaultChannels(session, scope, false));
  expect(defaultChannels).not.toHaveBeenCalled();
  act(() => {
    live = { roster: { state: "verified" } };
    for (const listener of listeners) listener();
  });
  await vi.waitFor(() => expect(defaultChannels).toHaveBeenCalledOnce());
  await vi.waitFor(() =>
    expect(readView(scope, "default-channels", undefined)).toBe("done"),
  );
  cached.unmount();
  connected.unmount();
});
