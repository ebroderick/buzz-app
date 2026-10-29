// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelList } from "../relay/contracts";
import { PublishNotSent, PublishRejected } from "../relay/outbox";
import { ChannelLifecycleUnconfirmed } from "../relay/channel-lifecycle";
import { relayPartition } from "../relay/partition";
import { clearView, readView, writeView } from "../../shared/view-state";
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

/** A held step: `opened` resolves once `open` is called. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

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
  /** The owner's work before publishing; when it returns, the join publishes
   * unless `active` declines, as in the lifecycle owner. `publish` records a
   * membership the relay applied even if `run` then throws, as for an accepted
   * join whose confirmation was lost. */
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
  const read = async () => ids.filter((id) => !roster.has(id));
  const defaultChannels = vi.fn(read);
  const lifecycle = {
    available,
    run: vi.fn(
      async (
        action: string,
        id: string,
        signal?: AbortSignal,
        active?: () => boolean,
      ) => {
        await run(action, id, signal, () => roster.add(id));
        if (active?.() === false)
          throw new DOMException("Channel action cancelled", "AbortError");
        roster.add(id);
      },
    ),
  };
  return {
    defaultChannels,
    /** The directory read `defaultChannels` answers with. */
    read,
    lifecycle,
    marker: () => readView(scope, "default-channels", undefined),
    members: () => [...roster],
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

it("a run cancelled while publishing leaves a successor's settlement standing", async () => {
  const old = new AbortController();
  const publishing = gate();
  const release = gate();
  const h = harness({
    run: async (_action, _id, signal, publish) => {
      if (signal !== old.signal) return;
      publish();
      publishing.open();
      await release.opened;
      throw new ChannelLifecycleUnconfirmed(old.signal.reason);
    },
  });
  const first = h.ensure(old.signal);
  try {
    await publishing.opened;
    expect(h.marker()).toEqual({ owed: ["general", "welcome"] });
    // The session is replaced while the old #general publish is in flight.
    old.abort();
    await h.ensure();
    expect(h.joins()).toEqual(["general", "welcome"]);
    expect(h.marker()).toBe("done");
  } finally {
    release.open();
  }
  await first;
  expect(h.marker()).toBe("done");
  h.leave("welcome");
  await h.ensure();
  expect(h.joins()).toEqual(["general", "welcome"]);
});

it("a late settlement keeps a successor's partial progress, so leaving either stands", async () => {
  const old = new AbortController();
  const publishing = gate();
  const release = gate();
  const h = harness({
    run: async (_action, id, signal, publish) => {
      if (signal === old.signal) {
        publishing.open();
        await release.opened;
        // The cancelled #general publish takes effect only now.
        publish();
        throw new ChannelLifecycleUnconfirmed(old.signal.reason);
      }
      // A failure before publishing keeps #general owed.
      if (id === "general")
        throw new Error("Unexpected channel state response");
    },
  });
  const first = h.ensure(old.signal);
  try {
    await publishing.opened;
    old.abort();
    await h.ensure();
    expect(h.joins()).toEqual(["general", "general", "welcome"]);
    expect(h.marker()).toEqual({ owed: ["general"] });
  } finally {
    release.open();
  }
  await first;
  expect(h.marker()).toBe("done");
  h.leave("general");
  h.leave("welcome");
  await h.ensure();
  expect(h.joins()).toEqual(["general", "general", "welcome"]);
});

it("keeps both runs' settlements when the successor stored the same owed set", async () => {
  const old = new AbortController();
  const publishing = gate();
  const releaseOld = gate();
  const joining = gate();
  const releaseNew = gate();
  const h = harness({
    run: async (_action, id, signal, publish) => {
      if (signal === old.signal) {
        publishing.open();
        await releaseOld.opened;
        publish();
        throw new ChannelLifecycleUnconfirmed(old.signal.reason);
      }
      if (id === "general")
        throw new Error("Unexpected channel state response");
      joining.open();
      await releaseNew.opened;
    },
  });
  const first = h.ensure(old.signal);
  let second: Promise<void> | undefined;
  try {
    await publishing.opened;
    old.abort();
    second = h.ensure();
    await joining.opened;
    // The successor rewrote the same owed set, then skipped #general.
    expect(h.marker()).toEqual({ owed: ["general", "welcome"] });
    releaseOld.open();
    await first;
    expect(h.marker()).toEqual({ owed: ["welcome"] });
  } finally {
    releaseOld.open();
    releaseNew.open();
  }
  await second;
  expect(h.marker()).toBe("done");
  h.leave("welcome");
  await h.ensure();
  expect(h.joins()).toEqual(["general", "general", "welcome"]);
});

it("does not join a channel the other run settled meanwhile, so leaving it stands", async () => {
  const old = new AbortController();
  const publishing = gate();
  const releaseOld = gate();
  const joining = gate();
  const releaseNew = gate();
  const h = harness({
    // #news stays owed after the others settle, so the successor reaches the
    // settled #welcome rather than stopping at `done`.
    ids: ["general", "welcome", "news"],
    run: async (_action, id, signal, publish) => {
      if (id === "general") {
        if (signal === old.signal)
          throw new Error("Unexpected channel state response");
        joining.open();
        await releaseNew.opened;
        return;
      }
      if (signal !== old.signal) return;
      publishing.open();
      await releaseOld.opened;
      publish();
      throw new ChannelLifecycleUnconfirmed(old.signal.reason);
    },
  });
  const first = h.ensure(old.signal);
  let second: Promise<void> | undefined;
  try {
    await publishing.opened;
    old.abort();
    second = h.ensure();
    await joining.opened;
    releaseOld.open();
    await first;
    expect(h.marker()).toEqual({ owed: ["general", "news"] });
    // The member leaves #welcome before the successor reaches it.
    h.leave("welcome");
  } finally {
    releaseOld.open();
    releaseNew.open();
  }
  await second;
  expect(h.joins()).toEqual(["general", "welcome", "general", "news"]);
  expect(h.marker()).toBe("done");
});

it("publishes nothing for a join held while signing once another window settled it, so leaving it stands", async () => {
  const held = new AbortController();
  const signing = gate();
  const signed = gate();
  const h = harness({
    ids: ["general"],
    run: async (_action, _id, signal) => {
      if (signal !== held.signal) return;
      signing.open();
      await signed.opened;
    },
  });
  const first = h.ensure(held.signal);
  try {
    await signing.opened;
    // Another window joins #general and marks done, then the member leaves.
    await h.ensure();
    expect(h.marker()).toBe("done");
    h.leave("general");
  } finally {
    signed.open();
  }
  await first;
  expect(h.joins()).toEqual(["general", "general"]);
  expect(h.members()).toEqual([]);
  expect(h.marker()).toBe("done");
});

it("a successor still joins what is owed when the other run settles during its directory read", async () => {
  const old = new AbortController();
  const publishing = gate();
  const release = gate();
  const reading = gate();
  const answer = gate();
  const h = harness({
    run: async (_action, _id, signal, publish) => {
      if (signal !== old.signal) return;
      publish();
      publishing.open();
      await release.opened;
      throw new ChannelLifecycleUnconfirmed(old.signal.reason);
    },
  });
  const first = h.ensure(old.signal);
  let second: Promise<void> | undefined;
  try {
    await publishing.opened;
    old.abort();
    h.defaultChannels.mockImplementationOnce(async () => {
      reading.open();
      await answer.opened;
      return h.read();
    });
    second = h.ensure();
    await reading.opened;
    release.open();
    await first;
    expect(h.marker()).toEqual({ owed: ["welcome"] });
  } finally {
    release.open();
    answer.open();
  }
  await second;
  expect(h.joins()).toEqual(["general", "welcome"]);
  expect(h.marker()).toBe("done");
});

it.each([
  ["done", "done"],
  ["nothing (cleared)", null],
  ["a new admission's pending", "pending"],
] as const)(
  "an owed set replaced by %s during the directory read stands",
  async (_case, marker) => {
    const answer = gate();
    const h = harness({ marker: { owed: ["general", "welcome"] } });
    h.defaultChannels.mockImplementationOnce(async () => {
      await answer.opened;
      return h.read();
    });
    const run = h.ensure();
    try {
      expect(h.defaultChannels).toHaveBeenCalledOnce();
      if (marker) writeView(scope, "default-channels", marker);
      else clearView(scope, "default-channels");
    } finally {
      answer.open();
    }
    await run;
    expect(h.lifecycle.run).not.toHaveBeenCalled();
    expect(h.marker()).toBe(marker ?? undefined);
  },
);

it("updates the record only under the scope's lock, so another window cannot interleave", async () => {
  const locks: string[] = [];
  let held: string | undefined;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (name: string, update: () => unknown) => {
        locks.push(name);
        held = name;
        try {
          return update();
        } finally {
          held = undefined;
        }
      },
    },
  });
  try {
    const h = harness({
      run: async (_action, id) => {
        if (id === "welcome") throw new Error("connection lost");
      },
    });
    const key = `buzz-view.v1:${JSON.stringify([scope, "default-channels"])}`;
    const setItem = Storage.prototype.setItem;
    const writes: (string | undefined)[] = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      name,
      value,
    ) {
      if (name === key) writes.push(held);
      setItem.call(this, name, value);
    });
    await h.ensure();
    expect(h.marker()).toEqual({ owed: ["welcome"] });
    // The snapshot and the #general settlement.
    const lock = `buzz-default-channels:${scope}`;
    expect(writes).toEqual([lock, lock]);
    expect(new Set(locks)).toEqual(new Set([lock]));
  } finally {
    Reflect.deleteProperty(navigator, "locks");
  }
});

it.each([
  ["the snapshot", 1],
  ["a settlement", 2],
] as const)(
  "%s reads the record once it holds the lock, keeping what another window settled while it waited",
  async (_case, request) => {
    const h = harness({ marker: { owed: ["general", "welcome"] } });
    let requests = 0;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        request: async (_name: string, update: () => unknown) => {
          // Another window held the lock first and settled #welcome.
          if (++requests === request)
            writeView(scope, "default-channels", { owed: ["general"] });
          return update();
        },
      },
    });
    try {
      await h.ensure();
      expect(h.joins()).toEqual(["general"]);
      expect(h.marker()).toBe("done");
    } finally {
      Reflect.deleteProperty(navigator, "locks");
    }
  },
);

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
