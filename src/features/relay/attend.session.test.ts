import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "./session";
import type { RelayEvent } from "./events";
import type { LiveCallbacks } from "./live";
import { flush, keypair, scriptedTransport, signed } from "./testing";

const viewer = keypair(),
  relay = keypair(),
  other = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
const OPEN = "33333333-3333-4333-8333-333333333333";
const CLOSED = "44444444-4444-4444-8444-444444444444";

function harness() {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  const update =
    vi.fn<(ids: readonly string[], joined?: readonly string[]) => void>();
  let live!: LiveCallbacks;
  const owner = createRelaySession({
    ...wire.transport,
    scope: "https://one.example",
    subscribe(callbacks) {
      live = callbacks;
      return { update, retry() {}, dispose() {} };
    },
  });
  owners.push(owner);
  /** Connects, and the viewer's roster read finds no channel. */
  const discover = async () => {
    live.state({ status: "connected", routes: [] });
    live.established();
    await vi.waitFor(() => expect(wire.pending).toHaveLength(1));
    wire.next().respond([]);
    await vi.waitFor(() =>
      expect(owner.session.channels.list().status).toBe("ready"),
    );
  };
  /** Drops and restores the socket, and discovery reads the roster again. */
  const reconnect = async () => {
    live.state({ status: "retrying", routes: [] });
    live.state({ status: "connected", routes: [] });
    live.established();
    const roster = () =>
      wire.pending.findIndex(
        (entry) =>
          !entry.signal?.aborted &&
          !entry.filters.some((filter) => filter["#d"]),
      );
    await vi.waitFor(() => expect(roster()).not.toBe(-1));
    wire.pending.splice(roster(), 1)[0]?.respond([]);
    await flush();
  };
  /** Connects, with the roster read left unanswered. */
  const connect = () => {
    live.state({ status: "connected", routes: [] });
    live.established();
  };
  return {
    owner,
    wire,
    update,
    discover,
    reconnect,
    connect,
    receive: (events: readonly RelayEvent[]) => live.receive(events as never),
  };
}
/** The relay's signed metadata and roster of a channel only `other` is in. */
const channel = (
  id: string,
  visibility: "public" | "private",
  created_at = 10,
) => [
  signed(relay, {
    kind: 39000,
    content: "",
    created_at,
    tags: [["d", id], ["name", id.slice(0, 4)], [visibility]],
  }),
  signed(relay, {
    kind: 39002,
    content: "",
    created_at,
    tags: [
      ["d", id],
      ["p", other.pubkey],
    ],
  }),
];
const asks = (filters: readonly { "#d"?: readonly string[] }[], id: string) =>
  filters.some((filter) => filter["#d"]?.includes(id));

it("keeps an attended public channel live once its metadata is read, never a private one, and drops it when stopped", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  const stop = h.owner.session.attend([OPEN, CLOSED, "not a channel id"]);
  // Unknown until the relay's metadata is read, which waits for discovery:
  // a lookup must not stand in for it.
  await flush();
  expect(live()).not.toContain(OPEN);
  expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(false);
  await h.discover();
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  const read = h.wire.pending.find((entry) => asks(entry.filters, OPEN));
  read?.respond([
    ...channel(OPEN, "public"),
    ...channel(CLOSED, "private"),
  ] as RelayEvent[]);
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  await flush();
  // Live, though not joined or listed; a private channel the viewer is not
  // in is not live.
  expect(joined()).not.toContain(OPEN);
  expect(live()).not.toContain(CLOSED);
  expect(
    h.owner.session.channels.list().channels.map(({ id }) => id),
  ).not.toContain(OPEN);
  stop();
  expect(live()).not.toContain(OPEN);
});

it("says a channel is pending until its metadata is read, attended or not yet, and reads again what failed", async () => {
  const h = harness();
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  /** Answers the metadata read in flight, and takes it off the wire. */
  const answer = (
    respond: (entry: NonNullable<ReturnType<typeof lookup>>) => void,
  ) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    respond(entry);
  };
  // Unknown, it is pending before any `attend`, so a catch-up that starts
  // first waits too.
  expect(pending()).toBe(true);
  h.owner.session.attend([OPEN]);
  expect(pending()).toBe(true);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // A failed read leaves it pending, and a reconnect reads it again.
  answer((entry) => entry.fail(new Error("down")));
  await flush();
  expect(pending()).toBe(true);
  expect(lookup()).toBeUndefined();
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // So does a wait, with no reconnect.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    answer((entry) => entry.fail(new Error("down again")));
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  expect(pending()).toBe(true);
  answer((entry) => entry.respond(channel(OPEN, "public") as RelayEvent[]));
  await vi.waitFor(() => expect(pending()).toBe(false));
});

it("resolves the channels a read of every channel finds, of any kinds, once discovery is done", async () => {
  const h = harness();
  const read = () =>
    h.owner.session.read([{ kinds: [9, 7], since: 11, until: 20, limit: 16 }], {
      fresh: true,
      resolveChannels: true,
    });
  const message = signed(other, {
    kind: 9,
    content: "message",
    created_at: 15,
    tags: [["h", OPEN]],
  });
  const history = [
    message,
    signed(other, {
      kind: 7,
      content: "+",
      created_at: 16,
      tags: [
        ["h", OPEN],
        ["e", message.id],
      ],
    }),
  ] as RelayEvent[];
  await h.discover();
  const reading = read();
  await vi.waitFor(() =>
    expect(
      h.wire.pending.some((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(7)),
      ),
    ).toBe(true),
  );
  const index = h.wire.pending.findIndex((entry) =>
    entry.filters.some((filter) => filter.kinds?.includes(7)),
  );
  h.wire.pending.splice(index, 1)[0]?.respond(history);
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  const lookup = h.wire.pending.find((entry) => asks(entry.filters, OPEN));
  lookup?.respond(channel(OPEN, "public") as RelayEvent[]);
  expect((await reading).map(({ kind }) => kind).sort()).toEqual([7, 9]);
});

it.each([
  ["of chat, as any read of messages does, the viewer's own", [9], true],
  ["of other kinds too, only agents'", [9, 7], false],
] as const)(
  "counts a channel a read of every channel resolves %s",
  async (_, kinds, viewers) => {
    const h = harness();
    await h.discover();
    expect(h.owner.session.unattended(OPEN, false)).toBe(true);
    const reading = h.owner.session.read(
      [{ kinds: [...kinds], since: 11, until: 20, limit: 16 }],
      { fresh: true, resolveChannels: true },
    );
    const asked = () =>
      h.wire.pending.findIndex((entry) =>
        entry.filters.some((filter) => filter.kinds?.includes(9)),
      );
    await vi.waitFor(() => expect(asked()).not.toBe(-1));
    h.wire.pending.splice(asked(), 1)[0]?.respond([
      signed(other, {
        kind: 9,
        content: "message",
        created_at: 15,
        tags: [["h", OPEN]],
      }),
    ] as RelayEvent[]);
    await vi.waitFor(() =>
      expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
        true,
      ),
    );
    h.wire.pending
      .find((entry) => asks(entry.filters, OPEN))
      ?.respond(channel(OPEN, "public") as RelayEvent[]);
    expect(await reading).toHaveLength(1);
    // Not attended, so live says the same; catch-up reads tell them apart.
    expect(h.owner.session.unattended(OPEN, false)).toBe(viewers);
    expect(h.owner.session.unattended(OPEN, true)).toBe(viewers);
  },
);

it("counts an attended channel the viewer has not joined or opened as heard only for agents, live and read", async () => {
  const h = harness();
  const stop = h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() =>
    expect(h.wire.pending.some((entry) => asks(entry.filters, OPEN))).toBe(
      true,
    ),
  );
  h.wire.pending
    .find((entry) => asks(entry.filters, OPEN))
    ?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() =>
    expect(h.update.mock.lastCall?.[0] ?? []).toContain(OPEN),
  );
  expect(h.owner.session.unattended(OPEN, true)).toBe(false);
  // Its metadata came only from the attendance's lookup.
  expect(h.owner.session.unattended(OPEN, false)).toBe(false);
  // A channel no agent attends is heard as without attendance.
  expect(h.owner.session.unattended(CLOSED, true)).toBe(true);
  stop();
});

it("does not answer a read of every channel that resolves its channels before discovery, rather than drop what it cannot place", async () => {
  const h = harness();
  // Discovery has not succeeded: its roster read failed.
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().fail(new Error("down"));
  await vi.waitFor(() =>
    expect(h.owner.session.channels.list().status).not.toBe("ready"),
  );
  let settled = false;
  void h.owner.session
    .read([{ kinds: [7], since: 11, until: 20, limit: 16 }], {
      fresh: true,
      resolveChannels: true,
    })
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  const reads = () =>
    h.wire.pending.findIndex((entry) =>
      entry.filters.some((filter) => filter.kinds?.includes(7)),
    );
  await vi.waitFor(() => expect(reads()).not.toBe(-1));
  h.wire.pending.splice(reads(), 1)[0]?.respond([]);
  await flush();
  await flush();
  // It is tried again later, not answered empty.
  expect(settled).toBe(false);
});

it("reads again a channel found unreadable, holding it pending, and keeps it live once it turns public", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const answer = (events: readonly unknown[]) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    entry.respond(events as RelayEvent[]);
  };
  h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // Private, and the viewer is not in it: nothing it can read yet. It stays
  // pending, so catch-up keeps its checkpoint, and a reconnect reads it again.
  answer(channel(OPEN, "private"));
  await flush();
  expect(pending()).toBe(true);
  expect(lookup()).toBeUndefined();
  await h.reconnect();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  // So does a wait, with no reconnect: the relay may have no answer at all.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    answer([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending()).toBe(true);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(30_000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  expect(pending()).toBe(true);
  // Now public, by newer metadata: known, and live.
  answer(channel(OPEN, "public", 20));
  await vi.waitFor(() => expect(pending()).toBe(false));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
});

it("reads again a channel that newer metadata makes private, at once and then after a growing wait, and hears it once it is public again", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const pending = () => h.owner.session.attendPending(OPEN);
  const lookup = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  const answer = (events: readonly unknown[]) => {
    const entry = lookup();
    if (!entry) throw new Error("No metadata read");
    h.wire.pending.splice(h.wire.pending.indexOf(entry), 1);
    entry.respond(events as RelayEvent[]);
  };
  h.owner.session.attend([OPEN]);
  await h.discover();
  await vi.waitFor(() => expect(lookup()).toBeDefined());
  answer(channel(OPEN, "public"));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    // Newer metadata makes it private: it leaves the live routes, and its
    // metadata is read again at once.
    h.receive(channel(OPEN, "private", 20) as RelayEvent[]);
    await vi.advanceTimersByTimeAsync(0);
    expect(pending()).toBe(true);
    expect(live()).not.toContain(OPEN);
    expect(lookup()).toBeDefined();
    // Still private: read again after 30 s, then after 60 s.
    answer(channel(OPEN, "private", 20));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup()).toBeDefined();
    answer(channel(OPEN, "private", 20));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lookup()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(lookup()).toBeDefined();
    // Public again: known, and live.
    answer(channel(OPEN, "public", 30));
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(() => expect(pending()).toBe(false));
  await vi.waitFor(() => expect(live()).toContain(OPEN));
});

it("leaves to the live owner, which batches joined channels, whether an attended channel fits", async () => {
  const h = harness();
  const live = () => h.update.mock.lastCall?.[0] ?? [];
  const joined = () => h.update.mock.lastCall?.[1] ?? [];
  // 1,020 joined channels share one wire of up to 2,048, so a wire is free
  // for a public channel the viewer has not joined.
  const ids = Array.from({ length: 1_020 }, (_, i) => `joined-${i}`);
  h.connect();
  await vi.waitFor(() => expect(h.wire.pending).toHaveLength(1));
  h.wire.next().respond(
    ids.flatMap((id) => [
      signed(relay, {
        kind: 39000,
        content: "",
        created_at: 10,
        tags: [["d", id], ["name", id], ["private"]],
      }),
      signed(relay, {
        kind: 39002,
        content: "",
        created_at: 10,
        tags: [
          ["d", id],
          ["p", viewer.pubkey],
        ],
      }),
    ]) as RelayEvent[],
  );
  await vi.waitFor(() => expect(joined()).toHaveLength(1_020));
  h.owner.session.attend([OPEN]);
  const read = () =>
    h.wire.pending.find(
      (entry) => !entry.signal?.aborted && asks(entry.filters, OPEN),
    );
  await vi.waitFor(() => expect(read()).toBeDefined());
  read()?.respond(channel(OPEN, "public") as RelayEvent[]);
  await vi.waitFor(() => expect(live()).toContain(OPEN));
  expect(joined()).not.toContain(OPEN);
}, 30_000);

it("reads unknown attended channels one batch at a time, in the background lane", async () => {
  const h = harness();
  const ids = Array.from(
    { length: 257 },
    (_, i) => `attended-${i.toString().padStart(3, "0")}`,
  );
  const lookups = () =>
    h.wire.pending.filter(
      (entry) =>
        !entry.signal?.aborted && ids.some((id) => asks(entry.filters, id)),
    );
  await h.discover();
  h.owner.session.attend(ids);
  await vi.waitFor(() => expect(lookups()).toHaveLength(1));
  await flush();
  // Three batches, but only one background read at a time: the rest of the
  // reader stays free for what the owner opens.
  expect(lookups()).toHaveLength(1);
});
