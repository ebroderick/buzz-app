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
afterEach(() => localStorage.clear());

function harness({
  marker = "pending",
  joined = [],
  ids = ["general", "welcome"],
  partial = false,
  available = true,
  run = async () => {},
}: {
  /** `null` writes no marker. */
  marker?: "pending" | "done" | null;
  joined?: readonly string[];
  ids?: readonly string[];
  partial?: boolean;
  available?: boolean;
  run?: (action: string, id: string, signal?: AbortSignal) => Promise<void>;
} = {}) {
  if (marker) writeView(scope, "default-channels", marker);
  // The store's contract: candidates are the flagged channels the viewer has
  // not joined, so a join that succeeded stays out of the next run.
  const roster = new Set(joined);
  const defaultChannels = vi.fn(async () => ({
    ids: ids.filter((id) => !roster.has(id)),
    partial,
  }));
  const lifecycle = {
    available,
    run: vi.fn(async (action: string, id: string, signal?: AbortSignal) => {
      await run(action, id, signal);
      roster.add(id);
    }),
  };
  return {
    defaultChannels,
    lifecycle,
    marker: () => readView(scope, "default-channels", undefined),
    joins: () => lifecycle.run.mock.calls.map(([, id]) => id),
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

it("resumes after one join succeeded: the next run joins only what is still missing", async () => {
  let failing = true;
  const h = harness({
    run: async (_action, id) => {
      if (id === "welcome" && failing) throw new Error("connection lost");
    },
  });
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
  // #general's membership is kept, so the roster is no longer empty.
  expect(h.marker()).toBe("pending");
  failing = false;
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome", "welcome"]);
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
  [
    "an unconfirmed join",
    new ChannelLifecycleUnconfirmed(new Error("timeout")),
  ],
  // `lifecycle.run` is single-flight; a user-initiated action throws a plain
  // Error at the fallback, not a PublishRejected.
  [
    "a busy lifecycle owner",
    new Error("Another channel action is still in progress"),
  ],
])("tries every candidate but stays pending after %s", async (_case, error) => {
  const h = harness({
    run: async (_action, id) => {
      if (id === "general") throw error;
    },
  });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBe("pending");
});

it("a capped directory page joins what it found but stays pending", async () => {
  const h = harness({ partial: true });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBe("pending");
});

it("skips when channel actions are unavailable on this connection", async () => {
  const h = harness({ available: false });
  await h.ensure();
  expect(h.defaultChannels).not.toHaveBeenCalled();
  expect(h.marker()).toBe("pending");
});

it("an aborted run stops and leaves the marker for the next session", async () => {
  const controller = new AbortController();
  const h = harness({
    run: async (_action, _id, signal) => {
      controller.abort();
      throw signal?.reason;
    },
  });
  await h.ensure(controller.signal);
  expect(h.lifecycle.run).toHaveBeenCalledTimes(1);
  expect(h.marker()).toBe("pending");
});

it("the effect waits for a verified live roster on a live connection", async () => {
  let live = { roster: { state: "pending" } };
  const listeners = new Set<() => void>();
  const defaultChannels = vi.fn(async () => ({ ids: [], partial: false }));
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
