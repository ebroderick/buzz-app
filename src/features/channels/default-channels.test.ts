// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelList, ChannelSummary } from "../relay/contracts";
import { PublishRejected } from "../relay/outbox";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import { relayPartition } from "../relay/partition";
import { readView, writeView } from "../../shared/view-state";
import { ensureDefaultChannels, useDefaultChannels } from "./default-channels";

const viewer = "a".repeat(64);
const origin = "https://relay.test";
const scope = relayPartition(origin, viewer);
const general = { id: "general", name: "General" } as ChannelSummary;
afterEach(() => localStorage.clear());

function harness({
  marker,
  channels = [],
  ids = ["general", "welcome"],
  partial = false,
  available = true,
  run = async () => {},
}: {
  marker?: "done";
  channels?: readonly ChannelSummary[];
  ids?: readonly string[];
  partial?: boolean;
  available?: boolean;
  run?: (action: string, id: string, signal?: AbortSignal) => Promise<void>;
} = {}) {
  if (marker) writeView(scope, "default-channels", marker);
  const defaultChannels = vi.fn(async () => ({ ids, partial }));
  const lifecycle = { available, run: vi.fn(run) };
  const list: ChannelList = { status: "ready", channels };
  return {
    defaultChannels,
    lifecycle,
    marker: () => readView(scope, "default-channels", undefined),
    ensure: (signal = new AbortController().signal) =>
      ensureDefaultChannels({
        queries: { list: () => list, defaultChannels },
        lifecycle,
        scope,
        signal,
      }),
  };
}

it("joins each flagged channel the viewer lacks, in order, then marks the scope done", async () => {
  const h = harness();
  expect(h.marker()).toBeUndefined();
  await h.ensure();
  expect(
    h.lifecycle.run.mock.calls.map(([action, id]) => [action, id]),
  ).toEqual([
    ["join", "general"],
    ["join", "welcome"],
  ]);
  expect(h.marker()).toBe("done");
});

it("a done marker reads nothing and sends nothing", async () => {
  const h = harness({ marker: "done" });
  await h.ensure();
  expect(h.defaultChannels).not.toHaveBeenCalled();
  expect(h.lifecycle.run).not.toHaveBeenCalled();
});

it("a non-empty roster spends the one shot without a directory read", async () => {
  const h = harness({ channels: [general] });
  await h.ensure();
  expect(h.defaultChannels).not.toHaveBeenCalled();
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

it("tries every candidate but leaves the shot unspent after an unconfirmed join", async () => {
  const h = harness({
    run: async (_action, id) => {
      if (id === "general")
        throw new ChannelLifecycleUnconfirmed(new Error("timeout"));
    },
  });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBeUndefined();
});

it("a busy lifecycle owner is not a settled outcome: the next session retries", async () => {
  // `lifecycle.run` is single-flight; a user-initiated action throws a plain
  // Error at the fallback, not a PublishRejected.
  const h = harness({
    run: async (_action, id) => {
      if (id === "general")
        throw new Error("Another channel action is still in progress");
    },
  });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBeUndefined();
});

it("a capped directory page joins what it found but leaves the shot unspent", async () => {
  const h = harness({ partial: true });
  await h.ensure();
  expect(h.lifecycle.run).toHaveBeenCalledTimes(2);
  expect(h.marker()).toBeUndefined();
});

it("skips when channel actions are unavailable on this connection", async () => {
  const h = harness({ available: false });
  await h.ensure();
  expect(h.defaultChannels).not.toHaveBeenCalled();
  expect(h.marker()).toBeUndefined();
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
  expect(h.marker()).toBeUndefined();
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
