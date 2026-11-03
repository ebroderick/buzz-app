import { assert, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import { createRelaySession } from "./session";
import { PublishRejected } from "./outbox";
import { ReadError } from "./errors";
import {
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";
import type { LiveCallbacks } from "./live";
import type { RelayEvent } from "./events";
import type { SidebarSortMode } from "./sidebar-sort";
function setup() {
  const viewer = keypair(),
    relay = keypair(),
    peer = keypair();
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let live!: LiveCallbacks;
  const pending: {
    ids: readonly string[];
    signal: AbortSignal;
    resolve(events: RelayEvent[]): void;
    reject(error: Error): void;
  }[] = [];
  const activity = vi.fn(
    (ids: readonly string[], signal: AbortSignal) =>
      new Promise<RelayEvent[]>((resolve, reject) =>
        pending.push({ ids, signal, resolve, reject }),
      ),
  );
  const publish = vi.fn(async (_event: RelayEvent) => {});
  const sort: Record<string, SidebarSortMode> = {};
  const filters: Record<string, "active" | "unreads"> = {};
  const owner = createRelaySession(
    {
      ...wire.transport,
      writer: {
        sign: async (template: EventTemplate) => signed(viewer, template),
        publish,
      },
      channelActivity: activity,
      decodeSidebarPreferences: async () => ({
        sections: [],
        assignments: {},
        starred: [],
        muted: [],
        sort: {},
      }),
      writeSidebarSort: async (group, mode) => {
        if (mode === "alpha") delete sort[group];
        else sort[group] = mode;
        return { ...sort };
      },
      writeSidebarFilter: async (group, mode) => {
        if (mode === "all") delete filters[group];
        else filters[group] = mode;
        return { filters: { ...filters }, activeWindowSeconds: {} };
      },
      subscribe(callbacks) {
        live = callbacks;
        return { update() {}, dispose() {}, retry() {} };
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  const channels = owner.session.channels;
  const preferences = owner.session.sidebarPreferences;
  async function initial(extra: readonly string[] = []) {
    channels.ensureList();
    wire
      .next()
      .respond([
        roster(relay, "alpha", [viewer.pubkey]),
        roster(relay, "beta", [viewer.pubkey]),
        metadata(relay, "alpha", "Alpha"),
        metadata(relay, "beta", "Beta"),
        ...extra.flatMap((id) => [
          roster(relay, id, [viewer.pubkey]),
          metadata(relay, id, id),
        ]),
      ]);
    await flush();
    const reading = preferences.ensure();
    await flush();
    wire.next().respond([]);
    await reading;
    live.state({ status: "connected", routes: [] });
  }
  return {
    owner,
    channels,
    preferences,
    pending,
    activity,
    publish,
    wire,
    viewer,
    relay,
    peer,
    live: () => live,
    initial,
  };
}
it("Active fetches activity independently of sort and shares Recent's demand lifetime", async () => {
  const h = setup();
  try {
    await h.initial();
    await h.preferences.setFilter("channels", "unreads", []);
    expect(h.activity).not.toHaveBeenCalled();
    await h.preferences.setFilter("channels", "active", []);
    expect(h.activity).toHaveBeenCalledOnce();
    const reading = take(h.pending);
    expect(reading.ids).toEqual(["alpha", "beta"]);
    await h.preferences.setSort("channels", "recent", []);
    await h.preferences.setFilter("channels", "all", []);
    expect(reading.signal.aborted).toBe(false);
    expect(h.activity).toHaveBeenCalledOnce();
    reading.resolve([message(h.peer, "beta", "recent activity", 100)]);
    await flush();
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBe(100);
    await h.preferences.setSort("channels", "alpha", []);
    await h.preferences.setFilter("channels", "active", []);
    expect(h.activity).toHaveBeenCalledTimes(2);
    const resumed = take(h.pending);
    await h.preferences.setFilter("channels", "all", []);
    expect(resumed.signal.aborted).toBe(true);
  } finally {
    h.owner.dispose();
  }
});
it.each(["recent", "plugin:example.plugin/rows/oldest"] as const)(
  "%s loads activity on demand, deduplicates reads, and projects verified live activity monotonically",
  async (mode) => {
    const h = setup();
    try {
      await h.initial();
      expect(h.activity).not.toHaveBeenCalled();
      await h.preferences.setSort("channels", mode, []);
      expect(h.activity).toHaveBeenCalledOnce();
      expect(h.channels.list().activityStatus).toBe("loading");
      expect(h.pending[0]?.ids).toEqual(["alpha", "beta"]);
      take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
      await flush();
      const first = h.channels.list();
      expect(first.activityStatus).toBe("ready");
      expect(first.channels.find((c) => c.id === "alpha")?.lastActivityAt).toBe(
        50,
      );
      expect(h.channels.list()).toBe(first);
      await h.preferences.setSort("dms", mode, []);
      expect(h.activity).toHaveBeenCalledOnce();
      h.live().receive([message(h.peer, "alpha", "new", 90)]);
      h.live().receive([
        message(h.peer, "alpha", "older", 70),
        signed(h.peer, {
          kind: 39000,
          created_at: 200,
          tags: [["d", "beta"]],
          content: "metadata is not activity",
        }),
      ]);
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBe(90);
      expect(
        h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);
// Own sends updated the row preview at once but moved it in Recent and Active
// only when the live socket echoed them.
it.each(["connected", "retrying"] as const)(
  "projects an own send the relay accepted while live is %s, before any echo",
  async (status) => {
    const h = setup();
    try {
      await h.initial();
      await h.preferences.setSort("channels", "recent", []);
      take(h.pending).resolve([message(h.peer, "alpha", "history", 50)]);
      await flush();
      h.live().state({ status, routes: [] });
      const beta = () =>
        h.channels.list().channels.find(({ id }) => id === "beta");
      expect(beta()?.lastActivityAt).toBeUndefined();
      h.owner.session.outbox?.send({
        kind: 9,
        content: "mine",
        tags: [["h", "beta"]],
      });
      await vi.waitFor(() => expect(h.publish).toHaveBeenCalledOnce());
      await flush();
      const sent = h.publish.mock.calls[0]?.[0];
      assert.exists(sent);
      expect(beta()?.lastActivityAt).toBe(sent.created_at);
      if (status !== "connected") return;
      const summary = beta();
      h.live().receive([sent]);
      expect(beta()).toBe(summary);
    } finally {
      h.owner.dispose();
    }
  },
);
it.each([
  ["refused", new PublishRejected("blocked"), "failed"],
  ["left unanswered", new Error("timed out"), "unknown"],
] as const)(
  "does not project an own send the relay %s",
  async (_outcome, error, delivery) => {
    const h = setup();
    try {
      await h.initial();
      h.publish.mockRejectedValueOnce(error);
      h.owner.session.outbox?.send({
        kind: 9,
        content: "mine",
        tags: [["h", "beta"]],
      });
      await vi.waitFor(() =>
        expect(h.owner.session.outbox?.snapshot()[0]?.delivery).toBe(delivery),
      );
      await flush();
      expect(
        h.channels.list().channels.find(({ id }) => id === "beta")
          ?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);
// A send left `unknown` updated its preview once a read proved it landed, but
// its row stayed put without a live echo.
it("projects an unanswered own send once its read-back returns it", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().state({ status: "retrying", routes: [] });
    h.publish.mockRejectedValueOnce(new Error("timed out"));
    h.owner.session.outbox?.send({
      kind: 9,
      content: "mine",
      tags: [["h", "beta"]],
    });
    await vi.waitFor(() =>
      expect(h.owner.session.outbox?.snapshot()[0]?.delivery).toBe("unknown"),
    );
    const sent = h.publish.mock.calls[0]?.[0];
    assert.exists(sent);
    const beta = () =>
      h.channels.list().channels.find(({ id }) => id === "beta");
    expect(beta()?.lastActivityAt).toBeUndefined();
    const readBack = await vi.waitFor(() => {
      const entry = h.wire.pending.find(({ filters }) =>
        filters.some((filter) => filter.ids?.includes(sent.id)),
      );
      assert.exists(entry);
      return entry;
    });
    readBack.respond([sent]);
    // The verified read completes delivery before confirm() sees its result.
    await vi.waitFor(() =>
      expect(h.owner.session.outbox?.snapshot()).toEqual([]),
    );
    await flush();
    expect(beta()?.lastActivityAt).toBe(sent.created_at);
  } finally {
    h.owner.dispose();
  }
});
it("keeps other channels' summaries when one channel's live activity advances", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "a1", 50)]);
    h.live().receive([message(h.peer, "beta", "b1", 60)]);
    const find = (id: string) =>
      h.channels.list().channels.find((channel) => channel.id === id);
    const alpha = find("alpha");
    const beta = find("beta");
    expect(beta?.lastActivityAt).toBe(60);
    h.live().receive([message(h.peer, "alpha", "a2", 90)]);
    expect(find("alpha")).not.toBe(alpha);
    expect(find("alpha")?.lastActivityAt).toBe(90);
    expect(find("beta")).toBe(beta);
  } finally {
    h.owner.dispose();
  }
});
it("retries failed Recent activity after an explicit roster refresh", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "last good", 50)]);
    await h.preferences.setSort("channels", "recent", []);
    take(h.pending).reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);

    h.channels.refreshList?.();
    h.wire
      .next()
      .respond([
        roster(h.relay, "alpha", [h.viewer.pubkey]),
        roster(h.relay, "beta", [h.viewer.pubkey]),
        metadata(h.relay, "alpha", "Alpha"),
        metadata(h.relay, "beta", "Beta"),
      ]);
    await flush();
    expect(h.activity).toHaveBeenCalledTimes(2);
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
    take(h.pending).resolve([
      message(h.peer, "alpha", "last good", 50),
      message(h.peer, "beta", "recovered", 100),
    ]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBe(100);
  } finally {
    h.owner.dispose();
  }
});
it("retries a transient activity failure quietly and reports a lasting one at once", async () => {
  const h = setup();
  try {
    await h.initial();
    vi.useFakeTimers();
    void h.preferences.setSort("channels", "recent", []);
    await vi.advanceTimersByTimeAsync(0);
    take(h.pending).reject(
      new ReadError("unavailable", "Relay read failed (502)"),
    );
    await vi.advanceTimersByTimeAsync(0);
    // No error while the quiet retry waits (at most the first 1 s delay).
    expect(h.channels.list().activityStatus).toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.activity).toHaveBeenCalledTimes(2);
    take(h.pending).resolve([message(h.peer, "beta", "recovered", 100)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "beta")?.lastActivityAt,
    ).toBe(100);

    // A denial cannot clear on retry: the sidebar reports it without a retry.
    void h.preferences.setSort("channels", "alpha", []);
    await vi.advanceTimersByTimeAsync(0);
    void h.preferences.setSort("channels", "recent", []);
    await vi.advanceTimersByTimeAsync(0);
    take(h.pending).reject(new ReadError("denied", "Relay read failed (403)"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.channels.list().activityStatus).toBe("error");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.activity).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
    h.owner.dispose();
  }
});
it("projects activity read before a later batch failed and leaves only unread channels unknown", async () => {
  const h = setup();
  try {
    const rooms = Array.from({ length: 127 }, (_, i) => `room-${1000 + i}`);
    await h.initial(rooms);
    await h.preferences.setSort("channels", "recent", []);
    const find = (id: string) =>
      h.channels.list().channels.find((c) => c.id === id);
    const first = take(h.pending);
    expect(first.ids).toEqual(["alpha", "beta", ...rooms.slice(0, 126)]);
    first.resolve([message(h.peer, "beta", "landed", 90)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(find("beta")?.activityKnown).toBeUndefined();
    const second = take(h.pending);
    expect(second.ids).toEqual(rooms.slice(126));
    second.reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(find("beta")?.lastActivityAt).toBe(90);
    expect(find("alpha")).toMatchObject({ activityKnown: true });
    expect(find(rooms[126] ?? "")?.activityKnown).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
it("retires failed activity only when the last Recent demand ends and recovers on re-entry", async () => {
  const h = setup();
  try {
    await h.initial();
    h.live().receive([message(h.peer, "alpha", "last good", 50)]);
    await h.preferences.setSort("channels", "recent", []);
    await h.preferences.setSort("dms", "recent", []);
    take(h.pending).reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");

    // Another section still needs Recent; its fresh failure must remain visible.
    await h.preferences.setSort("channels", "alpha", []);
    take(h.pending).reject(new Error("still offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    await h.preferences.setSort("dms", "alpha", []);
    expect(h.channels.list().activityStatus).toBe("idle");
    expect(h.preferences.snapshot().data?.sort).toEqual({});
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(50);
    expect(h.activity).toHaveBeenCalledTimes(2);

    await h.preferences.setSort("channels", "recent", []);
    expect(h.channels.list().activityStatus).toBe("loading");
    take(h.pending).reject(new Error("fresh failure"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    await h.preferences.setSort("channels", "alpha", []);
    expect(h.channels.list().activityStatus).toBe("idle");
    await h.preferences.setSort("channels", "recent", []);
    expect(h.activity).toHaveBeenCalledTimes(4);
    take(h.pending).resolve([message(h.peer, "alpha", "recovered", 120)]);
    await flush();
    expect(h.channels.list().activityStatus).toBe("ready");
    expect(
      h.channels.list().channels.find((c) => c.id === "alpha")?.lastActivityAt,
    ).toBe(120);
    expect(h.preferences.snapshot().data?.sort).toEqual({ channels: "recent" });
  } finally {
    h.owner.dispose();
  }
});
it.each(["recent", "plugin:example.plugin/rows/oldest"] as const)(
  "%s cancels only after the last section clears and refreshes unchanged rosters on re-entry",
  async (mode) => {
    const h = setup();
    try {
      await h.initial();
      await h.preferences.setSort("channels", mode, []);
      const retired = take(h.pending);
      await h.preferences.setSort("dms", mode, []);
      await h.preferences.setSort("channels", "alpha", []);
      expect(retired.signal.aborted).toBe(false);
      expect(h.activity).toHaveBeenCalledOnce();
      await h.preferences.setSort("dms", "alpha", []);
      expect(retired.signal.aborted).toBe(true);
      expect(h.channels.list().activityStatus).toBe("idle");
      // Ignoring transport cancellation must not let late history win. Live
      // activity remains valid even while every section is A–Z.
      retired.resolve([message(h.peer, "alpha", "retired history", 200)]);
      h.live().receive([message(h.peer, "alpha", "live", 90)]);
      await flush();
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBe(90);
      await h.preferences.setSort("channels", mode, []);
      expect(h.activity).toHaveBeenCalledTimes(2);
      const resumed = take(h.pending);
      expect(resumed.ids).toEqual(["alpha", "beta"]);
      resumed.resolve([message(h.peer, "alpha", "fresh history", 120)]);
      await flush();
      expect(h.channels.list().activityStatus).toBe("ready");
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBe(120);
      // Completed data stays useful, but a new demand lifetime still refreshes it.
      await h.preferences.setSort("channels", "alpha", []);
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBe(120);
      await h.preferences.setSort("channels", mode, []);
      expect(h.activity).toHaveBeenCalledTimes(3);
      take(h.pending).resolve([]);
      await flush();
    } finally {
      h.owner.dispose();
    }
  },
);
// Clearing every value on one channel's access loss flashed Recent sections to
// A–Z until the next read finished.
it("losing one channel keeps the others' activity while the roster rereads", async () => {
  const h = setup();
  try {
    await h.initial();
    await h.preferences.setSort("channels", "recent", []);
    take(h.pending).resolve([
      message(h.peer, "alpha", "a", 50),
      message(h.peer, "beta", "b", 60),
    ]);
    await flush();
    h.live().receive([
      roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
    ]);
    const find = (id: string) =>
      h.channels.list().channels.find((channel) => channel.id === id);
    expect(find("beta")?.lastActivityAt).toBe(60);
    expect(find("alpha")?.lastActivityAt).toBeUndefined();
  } finally {
    h.owner.dispose();
  }
});
it.each(["clear", "dispose", "revoke", "disconnect"] as const)(
  "%s fences activity reads and cannot leak late data into a new lifetime",
  async (action) => {
    const h = setup();
    try {
      await h.initial();
      await h.preferences.setSort("channels", "recent", []);
      const request = take(h.pending);
      if (action === "clear") await h.owner.clearCache();
      if (action === "dispose") h.owner.dispose();
      if (action === "revoke")
        h.live().receive([
          roster(h.relay, "alpha", [], Math.floor(Date.now() / 1000) + 1),
        ]);
      if (action === "disconnect")
        h.live().state({ status: "retrying", routes: [] });
      expect(request.signal.aborted).toBe(true);
      request.resolve([message(h.peer, "alpha", "retired", 100)]);
      await flush();
      expect(
        h.channels.list().channels.find((c) => c.id === "alpha")
          ?.lastActivityAt,
      ).toBeUndefined();
    } finally {
      h.owner.dispose();
    }
  },
);

function take<T>(pending: T[]): T {
  const next = pending.shift();
  assert.exists(next, "Expected a pending operation");
  return next;
}

it("projects authoritative empty activity through later loading and failed refreshes", async () => {
  const h = setup();
  try {
    await h.initial();
    await h.preferences.setFilter("channels", "active", []);
    take(h.pending).resolve([]);
    await flush();
    const quiet = () =>
      h.channels.list().channels.find(({ id }) => id === "beta");
    expect(quiet()).toMatchObject({ activityKnown: true });
    expect(quiet()?.lastActivityAt).toBeUndefined();
    await h.preferences.setFilter("channels", "all", []);
    await h.preferences.setFilter("channels", "active", []);
    expect(h.channels.list().activityStatus).toBe("loading");
    expect(quiet()?.activityKnown).toBe(true);
    take(h.pending).reject(new Error("offline"));
    await flush();
    expect(h.channels.list().activityStatus).toBe("error");
    expect(quiet()?.activityKnown).toBe(true);
  } finally {
    h.owner.dispose();
  }
});
