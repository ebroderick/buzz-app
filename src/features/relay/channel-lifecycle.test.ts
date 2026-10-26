import { followUpQueue } from "../messages/follow-up-queue";
import type { RelaySession } from "./session";
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "nostr-tools/utils";
import {
  afterEach,
  beforeEach,
  assert,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { ReadError } from "./errors";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools";
import { PublishRejected } from "./outbox";
import {
  createChannelLifecycle,
  ChannelLifecycleUnconfirmed,
} from "./channel-lifecycle";
import {
  lifecycleSettings,
  lifecycleTemplate,
  validateLifecycleTemplate,
} from "./channel-lifecycle-protocol";
import type { ReadFilter, RelayEvent } from "./events";
import type { ReadOptions } from "./reader";

const key = new Uint8Array(32).fill(2);
const relayKey = new Uint8Array(32).fill(3);
const agentKey = new Uint8Array(32).fill(4);
const other = getPublicKey(agentKey);
const viewer = getPublicKey(key);
const relayAuthor = getPublicKey(relayKey);
const id = "11111111-1111-4111-8111-111111111111";
const otherIds = [
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
/** How the shared reader rejects a job it retired or whose consumer aborted. */
const cancelled = () => new DOMException("Relay read cancelled", "AbortError");
function harness(role = "owner", type = "stream", owners = 1) {
  let timestamp = 100;
  const record = (kind: number, tags: string[][], content = "") =>
    finalizeEvent({ kind, tags, content, created_at: timestamp++ }, relayKey);
  const metadata = (archived = false, autoJoin = false) =>
    record(39000, [
      ["d", id],
      ["t", type],
      ["name", "fixture"],
      ...(archived ? [["archived", "true"]] : []),
      ...(autoJoin ? [["auto_join"]] : []),
    ]);
  const roles = (role: string) =>
    record(39001, [
      ["d", id],
      ...(role === "member" ? [] : [["p", viewer, role]]),
      ...(owners > 1 ? [["p", other, "owner"]] : []),
    ]);
  let events = [
    metadata(),
    roles(role),
    record(39002, [
      ["d", id],
      ["p", viewer, "", role],
      ["p", other, "", owners > 1 ? "owner" : "member"],
    ]),
  ];
  let visible: RelayEvent[] = [];
  let active = true;
  const read = vi.fn(
    async (filters: readonly ReadFilter[], _options?: ReadOptions) => {
      if (filters[0]?.kinds?.[0] === 30622) return visible;
      return events.filter((event) =>
        filters.some(
          (filter) =>
            filter.kinds?.includes(event.kind) &&
            (!filter.authors || filter.authors.includes(event.pubkey)) &&
            (!filter["#p"] ||
              event.tags.some(
                ([key, value]) =>
                  key === "p" && filter["#p"]?.includes(value ?? ""),
              )),
        ),
      );
    },
  );
  const sign = vi.fn(async (event: EventTemplate) =>
    finalizeEvent(structuredClone(event), key),
  );
  const publish = vi.fn(async (event: RelayEvent, _signal?: AbortSignal) => {
    if (event.kind === 9002)
      events = [
        metadata(
          event.tags.some(
            ([key, value]) => key === "archived" && value === "true",
          ),
          event.tags.some(
            ([key, value]) => key === "auto_join" && value === "true",
          ),
        ),
        ...events.filter((event) => event.kind !== 39000),
      ];
    if (event.kind === 9008)
      events = events.filter((event) => event.kind !== 39000);
    if (event.kind === 9022)
      events = events.map((entry) =>
        entry.kind === 39002
          ? record(
              39002,
              entry.tags.filter(
                ([key, value]) => key !== "p" || value !== viewer,
              ),
            )
          : entry,
      );
    if (event.kind === 41012)
      visible = [
        record(30622, [
          ["d", viewer],
          ["p", viewer],
          ["h", id],
        ]),
      ];
  });
  const removed = vi.fn();
  const acceptDiscovery = vi.fn();
  const owner = createChannelLifecycle({
    reader: { read },
    writer: { sign, publish },
    viewer,
    relayAuthor,
    canAccess: () => active,
    removed,
    acceptDiscovery,
  });
  return {
    owner,
    read,
    sign,
    publish,
    removed,
    acceptDiscovery,
    record,
    roles,
    metadata,
    setEvents: (value: RelayEvent[]) => {
      events = value;
    },
    getEvents: () => events,
    setVisible: (value: RelayEvent[]) => {
      visible = value;
    },
    deny: () => {
      active = false;
    },
  };
}
function preview(tags: string[][] = [["public"]]) {
  const h = harness("member");
  const metadata = h.record(39000, [
    ["d", id],
    ["t", "stream"],
    ["name", "fixture"],
    ...tags,
  ]);
  const roster = (...members: string[]) =>
    h.record(39002, [["d", id], ...members.map((member) => ["p", member])]);
  h.setEvents([metadata, roster(other)]);
  // Nonmember previews never satisfy member-action access.
  h.deny();
  h.publish.mockImplementation(async (event: RelayEvent) => {
    if (event.kind === 9021) h.setEvents([metadata, roster(other, viewer)]);
  });
  return { ...h, metadata, roster };
}

describe("bounded visibility recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps loaded visibility quiet through a transient failure and success", async () => {
    const h = harness();
    h.setVisible([
      h.record(30622, [
        ["d", viewer],
        ["p", viewer],
        ["h", id],
      ]),
    ]);
    await h.owner.capability.refreshVisibility();
    h.read.mockClear();
    h.read.mockRejectedValueOnce(new TypeError("fetch failed"));
    const pending = h.owner.capability.refreshVisibility();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.capability.snapshot()).toEqual({
      status: "loading",
      hidden: [id],
    });
    await vi.advanceTimersByTimeAsync(749);
    expect(h.read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.owner.capability.snapshot()).toEqual({
      status: "ready",
      hidden: [id],
    });
    h.owner.dispose();
  });

  it("exhausts four reads, then surfaces an error a manual retry can clear", async () => {
    const h = harness();
    const lifecycle = h.owner.capability;
    h.read.mockRejectedValue(new ReadError("unavailable", "offline", 503));
    const pending = lifecycle.refreshVisibility();
    await vi.advanceTimersByTimeAsync(0);
    for (const [index, delay] of [750, 1500, 3000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.read).toHaveBeenCalledTimes(index + 1);
      expect(lifecycle.snapshot().status).toBe("loading");
      await vi.advanceTimersByTimeAsync(1);
    }
    await pending;
    expect(lifecycle.snapshot()).toEqual({
      status: "error",
      hidden: [],
      error: "offline",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.read).toHaveBeenCalledTimes(4);
    h.read.mockResolvedValue([]);
    await lifecycle.refreshVisibility();
    expect(lifecycle.snapshot().status).toBe("ready");
    h.owner.dispose();
  });

  it.each([
    new ReadError("denied", "denied", 403),
    new Error("Invalid DM visibility snapshot"),
  ])("surfaces permanent failure immediately: %s", async (error) => {
    const h = harness();
    h.read.mockRejectedValue(error);
    await h.owner.capability.refreshVisibility();
    expect(h.owner.capability.snapshot()).toMatchObject({
      status: "error",
      error: error.message,
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.read).toHaveBeenCalledOnce();
    h.owner.dispose();
  });

  it("coalesces concurrent triggers during reads and backoff", async () => {
    const h = harness();
    const gate = deferred<RelayEvent[]>();
    h.read.mockImplementationOnce(() => gate.promise);
    const first = h.owner.capability.refreshVisibility();
    const concurrent = h.owner.capability.refreshVisibility();
    expect(concurrent).toBe(first);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledOnce();
    gate.reject(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.capability.refreshVisibility()).toBe(first);
    await vi.advanceTimersByTimeAsync(750);
    await first;
    expect(h.read).toHaveBeenCalledTimes(2);
    h.owner.dispose();
  });

  it.each(["caller", "cancel", "clear", "dispose"] as const)(
    "%s cancels backoff without a terminal error or another read",
    async (action) => {
      const h = harness();
      const caller = new AbortController();
      h.read.mockRejectedValue(new TypeError("offline"));
      const pending = h.owner.capability.refreshVisibility(caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      if (action === "caller") caller.abort();
      else h.owner[action]();
      await pending;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.read).toHaveBeenCalledOnce();
      expect(h.owner.capability.snapshot()).not.toHaveProperty("error");
      h.owner.dispose();
    },
  );

  it("aborts an obsolete read and rejects its late response after a superseding request", async () => {
    const h = harness();
    const gate = deferred<RelayEvent[]>();
    const caller = new AbortController();
    h.read.mockImplementationOnce(() => gate.promise);
    const old = h.owner.capability.refreshVisibility(caller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const signal = h.read.mock.calls[0]?.[1]?.signal;
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await h.owner.capability.refreshVisibility();
    gate.resolve([
      h.record(30622, [
        ["d", viewer],
        ["p", viewer],
        ["h", id],
      ]),
    ]);
    await old;
    expect(h.owner.capability.snapshot()).toEqual({
      status: "ready",
      hidden: [],
    });
    h.owner.dispose();
  });

  it("retries a visibility read invalidated by an unrelated channel denial", async () => {
    const h = harness();
    h.read.mockImplementationOnce(
      (_filters, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(cancelled()),
            { once: true },
          );
        }),
    );
    const pending = h.owner.capability.refreshVisibility();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledOnce();
    h.owner.cancel([id]);
    await vi.advanceTimersByTimeAsync(750);
    await pending;
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.owner.capability.snapshot().status).toBe("ready");
    h.owner.dispose();
  });
});

it.each(["archive", "delete", "leave", "hide"] as const)(
  "confirms %s while ordinary reads still see pre-write state",
  async (action) => {
    const h = harness("owner", action === "hide" ? "dm" : "stream", 2);
    const replica = h.getEvents();
    const currentRead = h.read.getMockImplementation();
    assert(currentRead);
    h.read.mockImplementation(async (filters, options) => {
      if (filters.every((filter) => filter.consistency === "strong"))
        return currentRead(filters, options);
      if (filters[0]?.kinds?.[0] === 30622) return [];
      return replica.filter((event) =>
        filters.some((filter) => filter.kinds?.includes(event.kind)),
      );
    });
    try {
      await h.owner.capability.refreshVisibility();
      expect(h.read.mock.calls[0]?.[0][0]).not.toHaveProperty("consistency");
      await h.owner.capability.run(action, id);
      for (const [filters] of h.read.mock.calls.slice(1, 3))
        for (const filter of filters)
          expect(filter).not.toHaveProperty("consistency");
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.read.mock.calls.at(-1)?.[0][0]?.consistency).toBe("strong");
      if (action === "hide")
        expect(h.owner.capability.snapshot().hidden).toEqual([id]);
      else if (action === "archive")
        expect(h.acceptDiscovery).toHaveBeenCalledOnce();
      else expect(h.removed).toHaveBeenCalledExactlyOnceWith(id);
    } finally {
      h.owner.dispose();
    }
  },
);

describe("type and role boundaries", () => {
  it.each([
    ["owner", "stream", 1, true, true, false, false],
    ["owner", "stream", 2, true, true, true, false],
    ["admin", "forum", 1, true, false, true, false],
    ["member", "stream", 1, false, false, true, false],
    ["owner", "dm", 1, false, false, false, true],
  ] as const)(
    "%s %s with %s owner(s)",
    async (role, type, owners, canArchive, canDelete, canLeave, canHide) => {
      const h = harness(role, type, owners);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canArchive,
        canDelete,
        canLeave,
        canHide,
      });
      h.owner.dispose();
    },
  );
  it.each(
    [[], ["wss://relay.example"], ["", "owner"]].map((hints) => ({ hints })),
  )(
    "accepts membership hints %j without granting administrator authority",
    async ({ hints }) => {
      const h = harness("member");
      h.setEvents([
        ...h.getEvents().filter((event) => event.kind !== 39002),
        h.record(39002, [
          ["d", id],
          ["p", viewer, ...hints],
        ]),
      ]);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canUnarchive: false,
        canArchive: false,
        canDelete: false,
        canLeave: true,
      });
      h.owner.dispose();
    },
  );
  it.each(
    [
      [["p"]],
      [["p", "not-a-key"]],
      [["p", viewer, "", "owner", "unexpected"]],
      [
        ["p", viewer],
        ["p", viewer, "", "owner"],
      ],
    ].map((entries) => ({ entries })),
  )(
    "rejects malformed or duplicate member entries %j before signing",
    async ({ entries }) => {
      const h = harness();
      h.setEvents([
        ...h.getEvents().filter((event) => event.kind !== 39002),
        h.record(39002, [["d", id], ...entries]),
      ]);
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "Malformed",
      );
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("reads the type from the first t tag of a labeled channel", () => {
    const h = harness();
    // The relay writes the type first, then labels, the creator and the
    // creation time (NIP-CL).
    h.setEvents([
      h.record(39000, [
        ["d", id],
        ["t", "stream"],
        ["t", "workspace"],
        ["t", "team:core"],
        ["P", other],
        ["name", "fixture"],
        ["created_at", "100"],
      ]),
      ...h.getEvents().slice(1),
    ]);
    expect(
      lifecycleSettings(h.getEvents(), id, viewer, relayAuthor),
    ).toMatchObject({
      channelType: "stream",
      canArchive: true,
      canDelete: true,
    });
    h.setEvents([
      h.record(39000, [
        ["d", id],
        ["t", "stream", "extra"],
        ["t", "workspace"],
      ]),
      ...h.getEvents().slice(1),
    ]);
    expect(() =>
      lifecycleSettings(h.getEvents(), id, viewer, relayAuthor),
    ).toThrow("Malformed channel t state");
    h.owner.dispose();
  });
  it("validates the complete administrator record, not just the viewer's first match", () => {
    const h = harness();
    h.setEvents([
      h.metadata(),
      h.record(39001, [
        ["d", id],
        ["p", viewer, "owner"],
        ["p", other, "bogus"],
      ]),
      h.record(39002, [
        ["d", id],
        ["p", viewer],
        ["p", other],
      ]),
    ]);
    expect(() =>
      lifecycleSettings(h.getEvents(), id, viewer, relayAuthor),
    ).toThrow("Malformed");
  });
  it.each(["archive", "unarchive", "delete", "leave"] as const)(
    "cannot %s a DM",
    async (action) => {
      const h = harness("owner", "dm");
      await expect(h.owner.capability.run(action, id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("requires a complete trusted metadata/admin/member response", async () => {
    const h = harness();
    h.setEvents(h.getEvents().slice(0, 2));
    await expect(h.owner.capability.load(id)).rejects.toThrow(
      "could not be verified",
    );
    h.owner.dispose();
  });
  it("rejects a foreign author even with matching coordinates", async () => {
    const h = harness();
    h.setEvents([
      finalizeEvent(
        {
          kind: 39000,
          tags: [
            ["d", id],
            ["t", "stream"],
          ],
          content: "",
          created_at: 1000,
        },
        key,
      ),
      ...h.getEvents().slice(1),
    ]);
    // Deliberately bypass the fixture's author filtering to exercise the guard.
    h.read.mockResolvedValueOnce(h.getEvents());
    await expect(h.owner.capability.load(id)).rejects.toThrow("authority");
    h.owner.dispose();
  });
});

it.each(["archive", "unarchive", "delete", "leave", "hide"] as const)(
  "confirms %s without granting it to the message outbox",
  async (action) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const h = harness("owner", action === "hide" ? "dm" : "stream", 2);
      if (action === "unarchive")
        h.setEvents([h.metadata(true), ...h.getEvents().slice(1)]);
      await h.owner.capability.run(action, id);
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.sign.mock.calls[0]?.[0]).toEqual(lifecycleTemplate(action, id));
      if (action === "archive" || action === "unarchive")
        expect(h.acceptDiscovery).toHaveBeenCalledOnce();
      else if (action !== "hide") expect(h.removed).toHaveBeenCalledWith(id);
      else {
        expect(h.owner.capability.snapshot().hidden).toEqual([id]);
        expect(h.removed).not.toHaveBeenCalled();
      }
      if (action === "leave") {
        expect(
          h.getEvents().find((event) => event.kind === 39002)?.tags,
        ).toEqual([
          ["d", id],
          ["p", other, "", "owner"],
        ]);
        expect(h.read.mock.calls.at(-1)?.[0]).toEqual([
          {
            kinds: [39002],
            consistency: "strong",
            authors: [relayAuthor],
            "#d": [id],
            "#p": [viewer],
            limit: 1,
          },
        ]);
      }
      h.owner.dispose();
    } finally {
      clock.mockRestore();
    }
  },
);

it("rereads authority after signing; a removed admin cannot publish", async () => {
  const h = harness("admin");
  h.sign.mockImplementation(async (event) => {
    h.setEvents([
      h.metadata(),
      h.roles("member"),
      h.record(39002, [
        ["d", id],
        ["p", viewer],
        ["p", other],
      ]),
    ]);
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("archive", id)).rejects.toThrow(
    "no longer permitted",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("fences access loss during signing and rejects a changed timestamp", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (event) => {
    h.deny();
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "access unavailable",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
  const g = harness();
  g.sign.mockImplementationOnce(async (event) =>
    finalizeEvent({ ...event, created_at: event.created_at + 1 }, key),
  );
  await expect(g.owner.capability.run("delete", id)).rejects.toThrow(
    "Signer changed",
  );
  expect(g.publish).not.toHaveBeenCalled();
  g.owner.dispose();
});
it.each(["clear", "dispose", "cancel"] as const)(
  "%s stops an in-flight signer even when it ignores abort",
  async (action) => {
    const h = harness();
    const gate = deferred<void>();
    const started = deferred<void>();
    h.sign.mockImplementationOnce(async (event) => {
      started.resolve();
      await gate.promise;
      return finalizeEvent(event, key);
    });
    const run = h.owner.capability.run("delete", id);
    await started.promise;
    h.owner[action]();
    gate.resolve();
    await expect(run).rejects.toThrow();
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  },
);
it("two revocations elsewhere during one permission read reread instead of failing", async () => {
  const h = harness();
  const gates = [deferred<RelayEvent[]>(), deferred<RelayEvent[]>()];
  const started = [deferred<void>(), deferred<void>()];
  for (const [index, gate] of gates.entries())
    h.read.mockImplementationOnce(() => {
      started[index]?.resolve();
      return gate.promise;
    });
  const result = h.owner.capability.load(id);
  for (const [index, revoked] of otherIds.entries()) {
    await started[index]?.promise;
    // The session's fan-out for another channel: a scoped cancel, then the
    // shared reader retires every pending job.
    h.owner.cancel([revoked]);
    gates[index]?.reject(cancelled());
  }
  expect(await result).toMatchObject({ canArchive: true, canDelete: true });
  expect(h.read).toHaveBeenCalledTimes(3);
  for (const [filters, options] of h.read.mock.calls) {
    for (const filter of filters) expect(filter["#d"]).toEqual([id]);
    expect(options?.signal?.aborted).toBe(false);
  }
  h.owner.dispose();
});
it.each(["scoped cancel", "cancel", "clear", "dispose", "caller"] as const)(
  "%s during a permission read is final; nothing rereads",
  async (action) => {
    const h = harness();
    const gate = deferred<RelayEvent[]>();
    const started = deferred<void>();
    const caller = new AbortController();
    h.read.mockImplementationOnce((_filters, options) => {
      started.resolve();
      options?.signal?.addEventListener(
        "abort",
        () => gate.reject(cancelled()),
        {
          once: true,
        },
      );
      return gate.promise;
    });
    const result = h.owner.capability.load(id, caller.signal);
    await started.promise;
    if (action === "caller") caller.abort();
    else if (action === "scoped cancel") h.owner.cancel([id]);
    else h.owner[action]();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(h.read).toHaveBeenCalledOnce();
    h.owner.dispose();
  },
);
it("deleting one channel leaves another channel's permission read in flight", async () => {
  const h = harness();
  const [other] = otherIds;
  const currentRead = h.read.getMockImplementation();
  assert(currentRead);
  const gate = deferred<RelayEvent[]>();
  const started = deferred<void>();
  h.read.mockImplementation((filters, options) => {
    if (!filters.some((filter) => filter["#d"]?.includes(other)))
      return currentRead(filters, options);
    started.resolve();
    return gate.promise;
  });
  // As the session's denyChannel does for the channel that was removed.
  h.removed.mockImplementation(() => h.owner.cancel([id]));
  const pending = h.owner.capability.load(other);
  await started.promise;
  await h.owner.capability.run("delete", id);
  expect(h.removed).toHaveBeenCalledExactlyOnceWith(id);
  const [, options] =
    h.read.mock.calls.find(([filters]) =>
      filters.some((filter) => filter["#d"]?.includes(other)),
    ) ?? [];
  expect(options?.signal?.aborted).toBe(false);
  gate.resolve([]);
  await expect(pending).rejects.toThrow(
    "Current channel permissions could not be verified",
  );
  h.owner.dispose();
});
it("does not infer deletion from a failed confirmation read; retry can recover", async () => {
  const h = harness();
  h.publish.mockImplementationOnce(async () => {
    h.read.mockRejectedValueOnce(new Error("query failed"));
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "query failed",
  );
  expect(h.removed).not.toHaveBeenCalled();
  await h.owner.capability.run("delete", id);
  expect(h.removed).toHaveBeenCalledOnce();
  h.owner.dispose();
});
describe("Leave confirmation across access revocation", () => {
  it.each(["scoped", "global"])(
    "%s revocation preserves dispatched Leave and rereads retired confirmations",
    async (scope) => {
      const h = harness("member");
      const publish = h.publish.getMockImplementation();
      assert(publish);
      h.publish.mockImplementationOnce(async (event) => {
        await publish(event);
        h.deny();
        h.owner.cancel(scope === "scoped" ? [id] : undefined);
        h.read
          .mockRejectedValueOnce(cancelled())
          .mockRejectedValueOnce(cancelled());
      });
      try {
        await h.owner.capability.run("leave", id);
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.removed).toHaveBeenCalledExactlyOnceWith(id);
        expect(h.read).toHaveBeenCalledTimes(5);
        for (const [, options] of h.read.mock.calls)
          expect(options?.signal?.aborted).toBe(false);
      } finally {
        h.owner.dispose();
      }
    },
  );

  it.each(
    (["archive", "delete"] as const).flatMap((action) =>
      ["scoped", "global"].map((scope) => ({ action, scope })),
    ),
  )(
    "$scope revocation lets published $action confirm",
    async ({ action, scope }) => {
      const h = harness();
      const publish = h.publish.getMockImplementation();
      assert(publish);
      h.publish.mockImplementationOnce(async (event) => {
        await publish(event);
        h.owner.cancel(scope === "scoped" ? [id] : undefined);
      });
      try {
        await h.owner.capability.run(action, id);
        expect(h.read).toHaveBeenCalledTimes(3);
        expect(h.publish).toHaveBeenCalledOnce();
        if (action === "archive") {
          expect(h.acceptDiscovery).toHaveBeenCalledOnce();
          expect(h.removed).not.toHaveBeenCalled();
        } else {
          expect(h.acceptDiscovery).not.toHaveBeenCalled();
          expect(h.removed).toHaveBeenCalledExactlyOnceWith(id);
        }
      } finally {
        h.owner.dispose();
      }
    },
  );

  it.each(
    ["caller", "clear", "dispose", "deadline"].flatMap((stop) =>
      ["ACK", "readback"].map((phase) => ({ stop, phase })),
    ),
  )(
    "$stop still cancels Leave during $phase after revocation",
    async ({ stop, phase }) => {
      const h = harness("member");
      const caller = new AbortController();
      const deadline = new AbortController();
      const timeout = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(deadline.signal);
      const started = deferred<void>();
      const hold = (signal?: AbortSignal) => {
        assert(signal);
        signal.throwIfAborted();
        started.resolve();
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      };
      h.publish.mockImplementationOnce(async (_event, signal) => {
        h.owner.cancel([id]);
        if (phase === "ACK") await hold(signal);
        else
          h.read.mockImplementationOnce((_filters, options) =>
            hold(options?.signal),
          );
      });
      try {
        const rejected = expect(
          h.owner.capability.run("leave", id, caller.signal),
        ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
        await started.promise;
        if (stop === "caller") caller.abort();
        else if (stop === "deadline")
          deadline.abort(new DOMException("Timed out", "TimeoutError"));
        else if (stop === "clear") h.owner.clear();
        else h.owner.dispose();
        await rejected;
        expect(timeout).toHaveBeenCalledExactlyOnceWith(20_000);
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.read).toHaveBeenCalledTimes(phase === "ACK" ? 2 : 3);
        expect(h.removed).not.toHaveBeenCalled();
      } finally {
        timeout.mockRestore();
        h.owner.dispose();
      }
    },
  );

  it.each([
    { phase: "publication", error: new PublishRejected("Leave denied") },
    { phase: "publication", error: cancelled() },
    { phase: "readback", error: new ReadError("denied", "Read denied") },
    { phase: "readback", error: new Error("Read unavailable") },
  ])(
    "never turns $phase failure into success or republishes: $error.name",
    async ({ phase, error }) => {
      const h = harness("member");
      h.publish.mockImplementationOnce(async () => {
        h.owner.cancel([id]);
        if (phase === "publication") throw error;
        h.read.mockRejectedValueOnce(cancelled()).mockRejectedValueOnce(error);
      });
      try {
        const run = h.owner.capability.run("leave", id);
        await expect(run).rejects.toBeInstanceOf(
          error instanceof PublishRejected
            ? PublishRejected
            : ChannelLifecycleUnconfirmed,
        );
        await expect(run).rejects.toThrow(error.message);
        expect(h.read).toHaveBeenCalledTimes(phase === "publication" ? 2 : 4);
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.removed).not.toHaveBeenCalled();
      } finally {
        h.owner.dispose();
      }
    },
  );

  it("an unchanged roster after a retired read stays unconfirmed within the existing poll budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness("member");
    h.publish.mockImplementationOnce(async () => {
      h.owner.cancel([id]);
      h.read.mockRejectedValueOnce(cancelled());
    });
    try {
      const rejected = expect(
        h.owner.capability.run("leave", id),
      ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
      // The retired read is reread after a real macrotask the fake clock
      // does not drive; start the poll budget once that reread is issued.
      while (h.read.mock.calls.length < 4)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(2500);
      await rejected;
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.read).toHaveBeenCalledTimes(7);
      expect(h.removed).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
      vi.useRealTimers();
    }
  });

  it("revocation before Leave publication still cancels without sending", async () => {
    const h = harness("member");
    h.sign.mockImplementationOnce(async (template) => {
      h.owner.cancel([id]);
      return finalizeEvent(template, key);
    });
    try {
      await expect(h.owner.capability.run("leave", id)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(h.publish).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
  });
});

it("serializes destructive operations without automatic resubmission", async () => {
  const h = harness();
  const gate = deferred<void>();
  const started = deferred<void>();
  h.sign.mockImplementationOnce(async (event) => {
    started.resolve();
    await gate.promise;
    return finalizeEvent(event, key);
  });
  const run = h.owner.capability.run("delete", id);
  await started.promise;
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "in progress",
  );
  gate.resolve();
  await run;
  expect(h.publish).toHaveBeenCalledOnce();
  h.owner.dispose();
});
it("retains the last good visibility on failure and rejects stale snapshots", async () => {
  const h = harness("owner", "dm");
  const stale = h.record(30622, [
    ["d", viewer],
    ["p", viewer],
  ]);
  await h.owner.capability.run("hide", id);
  h.setVisible([stale]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot().hidden).toEqual([id]);
  h.read.mockRejectedValueOnce(new Error("offline"));
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "error",
    hidden: [id],
  });
  h.setVisible([
    h.record(30622, [
      ["d", viewer],
      ["p", viewer],
    ]),
  ]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "ready",
    hidden: [],
  });
  h.owner.dispose();
});
it("a clear cannot be repopulated by a late visibility response", async () => {
  const h = harness();
  const gate = deferred<RelayEvent[]>();
  h.read.mockImplementationOnce(() => gate.promise);
  const pending = h.owner.capability.refreshVisibility();
  h.owner.clear();
  gate.resolve([
    h.record(30622, [
      ["d", viewer],
      ["p", viewer],
      ["h", id],
    ]),
  ]);
  await pending;
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "idle",
    hidden: [],
  });
  h.owner.dispose();
});
it.each([
  {
    kind: 9002,
    tags: [
      ["h", id],
      ["name", "rename"],
    ],
  },
  {
    kind: 9022,
    tags: [
      ["h", id],
      ["p", other],
    ],
  },
  {
    kind: 9008,
    tags: [
      ["h", id],
      ["h", id],
    ],
  },
  { kind: 41012, tags: [["h", "not-a-channel"]] },
  { kind: 9, tags: [["h", id]] },
])("rejects expanded host authority %#", (changes) => {
  expect(() =>
    validateLifecycleTemplate({ content: "", created_at: 1, ...changes }),
  ).toThrow();
});
it("a signer cannot mutate the input in place to bypass command equality", async () => {
  const h = harness();
  h.sign.mockImplementationOnce(async (event) => {
    event.kind = 9022;
    return finalizeEvent(event, key);
  });
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "Signer changed",
  );
  expect(h.publish).not.toHaveBeenCalled();
  h.owner.dispose();
});

it("distinguishes a rejected publication from an uncertain delivery without replay", async () => {
  const h = harness();
  h.publish.mockRejectedValueOnce(new PublishRejected("permission revoked"));
  await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
    "permission revoked",
  );
  expect(h.removed).not.toHaveBeenCalled();
  h.publish.mockRejectedValueOnce(new Error("connection lost"));
  await expect(h.owner.capability.run("delete", id)).rejects.toBeInstanceOf(
    ChannelLifecycleUnconfirmed,
  );
  expect(h.publish).toHaveBeenCalledTimes(2);
  expect(h.removed).not.toHaveBeenCalled();
  h.owner.dispose();
});
it("an accepted command without side effects remains uncertain, never replayed", async () => {
  vi.useFakeTimers();
  const h = harness();
  try {
    h.publish.mockImplementationOnce(async () => {});
    const run = expect(
      h.owner.capability.run("delete", id),
    ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
    await vi.runAllTimersAsync();
    await run;
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.removed).not.toHaveBeenCalled();
  } finally {
    h.owner.dispose();
    vi.useRealTimers();
  }
});
it("session replacement during publication cannot apply a late completion", async () => {
  const h = harness();
  const started = deferred<void>();
  const gate = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const run = h.owner.capability.run("delete", id);
  await started.promise;
  h.owner.dispose();
  gate.resolve();
  await expect(run).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
  expect(h.removed).not.toHaveBeenCalled();
  expect(h.acceptDiscovery).not.toHaveBeenCalled();
});
it("retiring a caller during publication keeps the outcome uncertain without replay", async () => {
  const h = harness();
  const caller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<void>();
  h.publish.mockImplementationOnce(async () => {
    started.resolve();
    await gate.promise;
  });
  const result = expect(
    h.owner.capability.run("delete", id, caller.signal),
  ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
  await started.promise;
  caller.abort();
  gate.resolve();
  await result;
  expect(h.publish).toHaveBeenCalledOnce();
  expect(h.removed).not.toHaveBeenCalled();
  h.owner.dispose();
});
it.each(
  (["scoped cancel", "cancel", "clear", "dispose", "caller"] as const).flatMap(
    (stop) =>
      (
        [
          ["leave", "publication"],
          ["leave", "confirmation read"],
          ["delete", "publication"],
          ["delete", "confirmation read"],
          ["join", "confirmation read"],
          ["hide", "confirmation read"],
        ] as const
      ).map(([action, phase]) => [stop, action, phase] as const),
  ),
)("%s during a published %s's %s", async (stop, action, phase) => {
  const join = action === "join" ? preview() : undefined;
  const h = join ?? harness("owner", action === "hide" ? "dm" : "stream", 2);
  const caller = new AbortController();
  const started = deferred<void>();
  const gate = deferred<void>();
  if (phase === "publication") {
    const apply = h.publish.getMockImplementation();
    assert(apply);
    // The relay applies the command before it acknowledges it.
    h.publish.mockImplementationOnce(async (event) => {
      await apply(event);
      started.resolve();
      await gate.promise;
    });
  } else {
    const currentRead = h.read.getMockImplementation();
    assert(currentRead);
    let held = false;
    h.read.mockImplementation(async (filters, options) => {
      if (held || !filters.every((filter) => filter.consistency === "strong"))
        return currentRead(filters, options);
      held = true;
      started.resolve();
      await gate.promise;
      // The session retires every shared read when access changes.
      throw cancelled();
    });
  }
  const run = h.owner.capability.run(action, id, caller.signal);
  try {
    await started.promise;
    if (stop === "caller") caller.abort();
    else if (stop === "scoped cancel") h.owner.cancel([id]);
    else h.owner[stop]();
    let roster: RelayEvent | undefined;
    if (join) {
      // Revocation purges discovery, so a join may accept only a roster
      // read after it.
      roster = join.roster(other, viewer);
      join.setEvents([join.metadata, roster]);
    }
    gate.resolve();
    if (stop === "scoped cancel" || stop === "cancel") {
      // A published command outlives revocation, usually its own effect, and
      // still confirms.
      await run;
      if (roster)
        expect(h.acceptDiscovery).toHaveBeenCalledExactlyOnceWith([roster]);
      else if (action === "hide")
        expect(h.owner.capability.snapshot().hidden).toEqual([id]);
      else expect(h.removed).toHaveBeenCalledExactlyOnceWith(id);
    } else {
      await expect(run).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
      expect(h.removed).not.toHaveBeenCalled();
      expect(h.acceptDiscovery).not.toHaveBeenCalled();
      expect(h.owner.capability.snapshot().hidden).toEqual([]);
    }
    expect(h.publish).toHaveBeenCalledOnce();
  } finally {
    h.owner.dispose();
  }
});
it.each(["after a macrotask", "without a macrotask"] as const)(
  "a published leave whose confirmation reads are all retired %s is unconfirmed at the deadline",
  async (timing) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Node's native AbortSignal timer is not driven by Vitest's clock.
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), milliseconds);
        return controller.signal;
      });
    const h = harness("owner", "stream", 2);
    const currentRead = h.read.getMockImplementation();
    assert(currentRead);
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
    let retired = 0;
    let unyielded = 0;
    h.read.mockImplementation(async (filters, options) => {
      if (!filters.every((filter) => filter.consistency === "strong"))
        return currentRead(filters, options);
      retired++;
      // A reread that never yields starves the clock; fail it rather than
      // freeze the worker.
      if (++unyielded > 100) throw new Error("Reread without yielding");
      void turn().then(() => {
        unyielded = 0;
      });
      if (timing === "after a macrotask") await turn();
      throw cancelled();
    });
    let settled = false;
    const outcome = h.owner.capability
      .run("leave", id)
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(() => {
        settled = true;
      });
    // Retired reads are still being reread, so the leave is still pending.
    const rereading = async () => {
      const seen = retired;
      while (retired < seen + 2 && !settled) await turn();
      expect(settled).toBe(false);
    };
    try {
      await rereading();
      await vi.advanceTimersByTimeAsync(19_999);
      await rereading();
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(ChannelLifecycleUnconfirmed);
      expect(h.removed).not.toHaveBeenCalled();
      expect(h.publish).toHaveBeenCalledOnce();
    } finally {
      h.owner.dispose();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  },
);
it("reads exact relay-owned coordinates fresh both before sign and before publish", async () => {
  const h = harness();
  await h.owner.capability.run("delete", id);
  const expected = [39000, 39001, 39002].map((kind) => ({
    kinds: [kind],
    authors: [relayAuthor],
    "#d": [id],
    limit: 1,
  }));
  expect(h.read).toHaveBeenNthCalledWith(
    1,
    expected,
    expect.objectContaining({ fresh: true, priority: "foreground" }),
  );
  expect(h.read).toHaveBeenNthCalledWith(
    2,
    expected,
    expect.objectContaining({ fresh: true, priority: "foreground" }),
  );
  h.owner.dispose();
});
it.each([
  [
    ["d", other],
    ["p", viewer],
  ],
  [
    ["d", viewer],
    ["p", other],
  ],
  [
    ["d", viewer],
    ["p", viewer],
    ["h", "invalid"],
  ],
])("invalid DM visibility never hides a conversation %#", async (...tags) => {
  const h = harness("owner", "dm");
  h.setVisible([h.record(30622, tags)]);
  await h.owner.capability.refreshVisibility();
  expect(h.owner.capability.snapshot()).toMatchObject({
    status: "error",
    hidden: [],
  });
  h.owner.dispose();
});

function ownerTag(target = other, ownerKey = key, conditions = "") {
  const digest = createHash("sha256")
    .update(`nostr:agent-auth:${target}:${conditions}`)
    .digest();
  return [
    "auth",
    getPublicKey(ownerKey),
    conditions,
    bytesToHex(schnorr.sign(digest, ownerKey)),
  ];
}
function agentProfile(tags = [ownerTag()], created_at = 200) {
  return finalizeEvent(
    {
      kind: 0,
      created_at,
      tags,
      content: JSON.stringify({ name: "Agent", ownerPubkey: viewer }),
    },
    agentKey,
  );
}
function ownedAgent(role = "admin") {
  const h = harness(role, "stream", 2);
  h.setEvents([...h.getEvents(), agentProfile()]);
  return h;
}

describe("channel owner-agent Archive and Delete eligibility", () => {
  it.each(["admin", "member"])(
    "a %s owning an active owner-agent can archive and delete without gaining other roles",
    async (role) => {
      const h = ownedAgent(role);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canDelete: true,
        canArchive: true,
        canLeave: true,
        canHide: false,
      });
      h.read.mockClear();
      await h.owner.capability.run("delete", id);
      expect(h.sign).toHaveBeenCalledOnce();
      expect(h.publish).toHaveBeenCalledOnce();
      expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
        pubkey: viewer,
        kind: 9008,
        tags: [["h", id]],
      });
      const ownershipReads = h.read.mock.calls.filter(
        ([filters]) => filters[0]?.kinds?.[0] === 0,
      );
      expect(ownershipReads).toHaveLength(2);
      for (const [filters, options] of ownershipReads) {
        expect(filters).toEqual([{ kinds: [0], authors: [other], limit: 1 }]);
        expect(options).toMatchObject({ fresh: true, priority: "foreground" });
      }
      expect(h.removed).toHaveBeenCalledWith(id);
      h.owner.dispose();
    },
  );
  it("a member owning an owner-agent can archive and unarchive", async () => {
    const h = ownedAgent("member");
    await h.owner.capability.run("archive", id);
    expect(h.publish.mock.calls[0]?.[0]).toMatchObject({
      pubkey: viewer,
      kind: 9002,
      tags: [
        ["h", id],
        ["archived", "true"],
      ],
    });
    expect(await h.owner.capability.load(id)).toMatchObject({
      canArchive: false,
      canUnarchive: true,
      canDelete: false,
    });
    await h.owner.capability.run("unarchive", id);
    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.calls[1]?.[0]).toMatchObject({
      kind: 9002,
      tags: [
        ["h", id],
        ["archived", "false"],
      ],
    });
    h.owner.dispose();
  });
  it("a direct admin archives without owner-profile reads", async () => {
    const h = ownedAgent("admin");
    await h.owner.capability.run("archive", id);
    expect(h.publish).toHaveBeenCalledOnce();
    expect(
      h.read.mock.calls.some(([filters]) => filters[0]?.kinds?.[0] === 0),
    ).toBe(false);
    h.owner.dispose();
  });
  it("a member's Archive fails closed when the owner check fails", async () => {
    const h = ownedAgent("member");
    h.read.mockResolvedValueOnce(h.getEvents().filter((e) => e.kind !== 0));
    h.read.mockRejectedValueOnce(new Error("profile unavailable"));
    await expect(h.owner.capability.run("archive", id)).rejects.toThrow(
      "Archive check unavailable",
    );
    expect(h.sign).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each([
    ["missing profile", () => []],
    ["display owner only", () => [agentProfile([])]],
    ["foreign owner", () => [agentProfile([ownerTag(other, relayKey)])]],
    [
      "forged signature",
      () => [agentProfile([["auth", viewer, "", "0".repeat(128)]])],
    ],
    ["wrong target", () => [agentProfile([ownerTag(relayAuthor)])]],
    ["duplicate tags", () => [agentProfile([ownerTag(), ownerTag()])]],
    [
      "malformed conditions",
      () => [agentProfile([ownerTag(other, key, "kind=x")])],
    ],
    [
      "wrong kind condition",
      () => [agentProfile([ownerTag(other, key, "kind=9")])],
    ],
    [
      "exclusive lower bound",
      () => [agentProfile([ownerTag(other, key, "created_at>200")])],
    ],
    [
      "exclusive upper bound",
      () => [agentProfile([ownerTag(other, key, "created_at<200")])],
    ],
    [
      "newer profile without ownership evidence",
      () => [agentProfile(), agentProfile([], 201)],
    ],
  ] as const)("%s grants no Delete path", async (_name, profiles) => {
    const h = ownedAgent();
    h.setEvents([
      ...h.getEvents().filter((event) => event.kind !== 0),
      ...profiles(),
    ]);
    expect((await h.owner.capability.load(id)).canDelete).toBe(false);
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer permitted",
    );
    expect(h.sign).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each(["admin", "member"])(
    "owning a channel %s agent does not grant Delete",
    async (role) => {
      const h = ownedAgent();
      h.setEvents(
        h
          .getEvents()
          .map((event) =>
            event.kind === 39001
              ? h.record(39001, [
                  ["d", id],
                  ["p", viewer, "admin"],
                  ...(role === "admin" ? [["p", other, role]] : []),
                ])
              : event,
          ),
      );
      expect((await h.owner.capability.load(id)).canDelete).toBe(false);
      expect(
        h.read.mock.calls.some(([filters]) => filters[0]?.kinds?.[0] === 0),
      ).toBe(false);
      h.owner.dispose();
    },
  );
  it("does not bypass viewer membership", async () => {
    const h = ownedAgent("member");
    h.setEvents(
      h.getEvents().map((event) =>
        event.kind === 39002
          ? h.record(39002, [
              ["d", id],
              ["p", other],
            ])
          : event,
      ),
    );
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer a channel member",
    );
    expect(h.sign).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each(["before signing", "before publication"])(
    "rereads profile evidence %s",
    async (when) => {
      const h = ownedAgent();
      expect((await h.owner.capability.load(id)).canDelete).toBe(true);
      const replaceProfile = () =>
        h.setEvents(
          h
            .getEvents()
            .map((event) => (event.kind === 0 ? agentProfile([], 201) : event)),
        );
      if (when === "before signing") replaceProfile();
      else
        h.sign.mockImplementationOnce(async (event) => {
          replaceProfile();
          return finalizeEvent(event, key);
        });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).toHaveBeenCalledTimes(when === "before signing" ? 0 : 1);
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("rereads the agent's channel role after signing", async () => {
    const h = ownedAgent();
    h.sign.mockImplementationOnce(async (event) => {
      h.setEvents(
        h.getEvents().map((entry) =>
          entry.kind === 39001
            ? h.record(39001, [
                ["d", id],
                ["p", viewer, "admin"],
                ["p", other, "admin"],
              ])
            : entry,
        ),
      );
      return finalizeEvent(event, key);
    });
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer permitted",
    );
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it("rejects a profile response outside the requested owner coordinates", async () => {
    const h = ownedAgent();
    h.read.mockResolvedValueOnce(
      h.getEvents().filter((event) => event.kind !== 0),
    );
    h.read.mockResolvedValueOnce([
      finalizeEvent(
        { kind: 0, created_at: 200, tags: [ownerTag(viewer)], content: "" },
        key,
      ),
    ]);
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "Delete check unavailable",
    );
    expect(h.sign).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it("failed profile reads fail closed and a new load can recover", async () => {
    const h = ownedAgent();
    h.read.mockResolvedValueOnce(
      h.getEvents().filter((event) => event.kind !== 0),
    );
    h.read.mockRejectedValueOnce(new Error("profile unavailable"));
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "Delete check unavailable",
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect((await h.owner.capability.load(id)).canDelete).toBe(true);
    h.owner.dispose();
  });
  it.each(["admin", "member"])(
    "profile failure preserves %s base actions and offers a fresh check",
    async (role) => {
      const h = ownedAgent(role);
      h.read.mockResolvedValueOnce(h.getEvents().filter((e) => e.kind !== 0));
      h.read.mockRejectedValueOnce(new Error("profile unavailable"));
      expect(await h.owner.capability.load(id)).toMatchObject({
        canArchive: role === "admin",
        canLeave: true,
        canDelete: false,
        deleteUnavailable: true,
      });
      await h.owner.capability.run(role === "admin" ? "archive" : "leave", id);
      expect(h.publish).toHaveBeenCalledOnce();
      h.owner.dispose();
    },
  );
  it("the optional profile deadline preserves base actions", async () => {
    const h = ownedAgent();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const optional = new AbortController();
    timeout.mockImplementation((ms) =>
      ms === 5000 ? optional.signal : new AbortController().signal,
    );
    const started = deferred<void>();
    h.read.mockResolvedValueOnce(h.getEvents().filter((e) => e.kind !== 0));
    h.read.mockImplementationOnce(async (_filters, options) => {
      started.resolve();
      return new Promise((_, reject) =>
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true },
        ),
      );
    });
    try {
      const result = h.owner.capability.load(id);
      await started.promise;
      optional.abort(new DOMException("Timed out", "TimeoutError"));
      expect(await result).toMatchObject({
        canUnarchive: false,
        canArchive: true,
        canLeave: true,
        canDelete: false,
        deleteUnavailable: true,
      });
      // A new attempt gets a new deadline, not the already-aborted test signal.
      timeout.mockRestore();
      expect((await h.owner.capability.load(id)).canDelete).toBe(true);
    } finally {
      timeout.mockRestore();
      h.owner.dispose();
    }
  });
  it("a retired owner-profile read rereads rather than removing Delete", async () => {
    const h = ownedAgent();
    h.read.mockResolvedValueOnce(
      h.getEvents().filter((event) => event.kind !== 0),
    );
    h.read.mockRejectedValueOnce(cancelled());
    const settings = await h.owner.capability.load(id);
    expect(settings).toMatchObject({ canArchive: true, canDelete: true });
    expect(settings).not.toHaveProperty("deleteUnavailable");
    expect(h.read).toHaveBeenCalledTimes(4);
    h.owner.dispose();
  });
  it("profile provenance does not override a conflicting relay ownership decision", async () => {
    const h = ownedAgent();
    expect((await h.owner.capability.load(id)).canDelete).toBe(true);
    h.publish.mockRejectedValueOnce(
      new PublishRejected("Only the channel owner can delete"),
    );
    await expect(h.owner.capability.run("delete", id)).rejects.toBeInstanceOf(
      PublishRejected,
    );
    expect(h.removed).not.toHaveBeenCalled();
    expect(h.acceptDiscovery).not.toHaveBeenCalled();
    expect(h.publish).toHaveBeenCalledOnce();
    // A definitive denial does not poison the busy guard or automatically replay.
    await h.owner.capability.run("leave", id);
    expect(h.publish).toHaveBeenCalledTimes(2);
    h.owner.dispose();
  });
  it("accepts conditions satisfied by the profile, not the current clock or Delete kind", async () => {
    const h = ownedAgent();
    h.setEvents([
      ...h.getEvents().filter((e) => e.kind !== 0),
      agentProfile([
        ownerTag(other, key, "kind=0&created_at>199&created_at<201"),
      ]),
    ]);
    expect((await h.owner.capability.load(id)).canDelete).toBe(true);
    h.owner.dispose();
  });
  it.each(["clear", "dispose", "cancel", "caller", "access"] as const)(
    "%s fences an ownership read even if the reader ignores abort",
    async (action) => {
      const h = ownedAgent();
      const gate = deferred<RelayEvent[]>();
      const started = deferred<void>();
      const caller = new AbortController();
      h.read.mockResolvedValueOnce(
        h.getEvents().filter((event) => event.kind !== 0),
      );
      h.read.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const result = h.owner.capability.run("delete", id, caller.signal);
      await started.promise;
      if (action === "caller") caller.abort();
      else if (action === "access") h.deny();
      else h.owner[action]();
      gate.resolve([agentProfile()]);
      await expect(result).rejects.toThrow();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it("checks every co-owner in bounded exact-author batches", async () => {
    const h = ownedAgent("member");
    const others = [5, 6, 7, 8].map((seed) =>
      getPublicKey(new Uint8Array(32).fill(seed)),
    );
    h.setEvents([
      h.metadata(),
      h.record(39001, [
        ["d", id],
        ...[...others, other].map((pubkey) => ["p", pubkey, "owner"]),
      ]),
      h.record(39002, [
        ["d", id],
        ...[viewer, ...others, other].map((pubkey) => ["p", pubkey]),
      ]),
      agentProfile(),
    ]);
    expect((await h.owner.capability.load(id)).canDelete).toBe(true);
    expect(h.read.mock.calls.map(([filters]) => filters.length)).toEqual([
      3, 4, 1,
    ]);
    h.owner.dispose();
  });
  it("does not add profile reads to direct-owner or DM checks, or other commands", async () => {
    for (const type of ["stream", "dm"]) {
      const h = harness("owner", type, 2);
      await h.owner.capability.load(id);
      expect(h.read).toHaveBeenCalledOnce();
      h.owner.dispose();
    }
    for (const action of ["archive", "leave"] as const) {
      const h = ownedAgent();
      await h.owner.capability.run(action, id);
      expect(
        h.read.mock.calls.some(([filters]) => filters[0]?.kinds?.[0] === 0),
      ).toBe(false);
      h.owner.dispose();
    }
  });
});

describe("direct-owner and archived Delete boundaries", () => {
  it("does not bypass direct-owner membership", async () => {
    const h = harness();
    h.setEvents(
      h.getEvents().map((event) => {
        if (event.kind === 39001)
          return h.record(39001, [
            ["d", id],
            ["p", other, "owner"],
          ]);
        if (event.kind === 39002)
          return h.record(39002, [
            ["d", id],
            ["p", other],
          ]);
        return event;
      }),
    );
    await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
      "no longer a channel member",
    );
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    h.owner.dispose();
  });
  it.each(["before signing", "before publication"])(
    "rereads direct ownership %s",
    async (when) => {
      const h = harness("owner", "stream", 2);
      expect((await h.owner.capability.load(id)).canDelete).toBe(true);
      const demote = () =>
        h.setEvents(
          h
            .getEvents()
            .map((event) => (event.kind === 39001 ? h.roles("admin") : event)),
        );
      if (when === "before signing") demote();
      else
        h.sign.mockImplementationOnce(async (event) => {
          demote();
          return finalizeEvent(event, key);
        });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).toHaveBeenCalledTimes(when === "before signing" ? 0 : 1);
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it.each(["owner", "admin", "member"])(
    "archived %s cannot Delete until restored",
    async (role) => {
      const h = harness(role, "stream", 2);
      h.setEvents([...h.getEvents(), agentProfile()]);
      const metadata = (archived: boolean) =>
        h.setEvents(
          h
            .getEvents()
            .map((event) =>
              event.kind === 39000 ? h.metadata(archived) : event,
            ),
        );
      metadata(true);
      expect(await h.owner.capability.load(id)).toMatchObject({
        canDelete: false,
        // The member owns the channel's owner-agent, so it can restore.
        canUnarchive: true,
        canArchive: false,
        canLeave: true,
      });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).not.toHaveBeenCalled();
      metadata(false);
      expect((await h.owner.capability.load(id)).canDelete).toBe(true);
      h.owner.dispose();
    },
  );
  it.each(["owner", "admin"])(
    "archiving during signing prevents %s Delete publication",
    async (role) => {
      const h = ownedAgent(role);
      h.sign.mockImplementationOnce(async (event) => {
        h.setEvents(
          h
            .getEvents()
            .map((record) =>
              record.kind === 39000 ? h.metadata(true) : record,
            ),
        );
        return finalizeEvent(event, key);
      });
      await expect(h.owner.capability.run("delete", id)).rejects.toThrow(
        "no longer permitted",
      );
      expect(h.sign).toHaveBeenCalledOnce();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
  it.each(["clear", "dispose", "cancel", "caller", "access"] as const)(
    "%s fences permission reads even when the host ignores abort",
    async (action) => {
      const h = harness();
      const gate = deferred<RelayEvent[]>(),
        started = deferred<void>();
      const caller = new AbortController();
      h.read.mockImplementationOnce(() => {
        started.resolve();
        return gate.promise;
      });
      const result = h.owner.capability.run("delete", id, caller.signal);
      await started.promise;
      if (action === "caller") caller.abort();
      else if (action === "access") h.deny();
      else h.owner[action]();
      gate.resolve(h.getEvents());
      await expect(result).rejects.toThrow();
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      h.owner.dispose();
    },
  );
});

describe("Unarchive", () => {
  function archived(role = "owner", type = "stream") {
    const h = harness(role, type);
    h.setEvents([h.metadata(true), ...h.getEvents().slice(1)]);
    return h;
  }
  it.each(["owner", "admin", "member"])(
    "uses the viewer's own %s role",
    async (role) => {
      const h = archived(role);
      try {
        expect(await h.owner.capability.load(id)).toMatchObject({
          canArchive: false,
          canUnarchive: role !== "member",
          canDelete: false,
        });
        if (role === "member") {
          await expect(h.owner.capability.run("unarchive", id)).rejects.toThrow(
            "no longer permitted",
          );
          expect(h.sign).not.toHaveBeenCalled();
        } else {
          await h.owner.capability.run("unarchive", id);
          expect(h.sign.mock.calls[0]?.[0].tags).toEqual([
            ["h", id],
            ["archived", "false"],
          ]);
          expect(h.acceptDiscovery).toHaveBeenCalledOnce();
          expect(h.removed).not.toHaveBeenCalled();
          expect(await h.owner.capability.load(id)).toMatchObject({
            canArchive: true,
            canUnarchive: false,
          });
        }
        expect(
          h.read.mock.calls
            .flatMap(([filters]) => filters)
            .some((f) => f.kinds?.includes(0)),
        ).toBe(false);
      } finally {
        h.owner.dispose();
      }
    },
  );
  it.each(["stream", "forum", "dm"])(
    "restores only ordinary archived channels (%s)",
    async (type) => {
      const h = archived("admin", type);
      try {
        expect((await h.owner.capability.load(id)).canUnarchive).toBe(
          type !== "dm",
        );
        if (type === "dm") {
          await expect(h.owner.capability.run("unarchive", id)).rejects.toThrow(
            "no longer permitted",
          );
          expect(h.sign).not.toHaveBeenCalled();
        } else {
          await h.owner.capability.run("unarchive", id);
          expect(h.acceptDiscovery).toHaveBeenCalledOnce();
        }
      } finally {
        h.owner.dispose();
      }
    },
  );
  it.each(["role", "archive state", "signer"])(
    "rechecks %s before publication",
    async (change) => {
      const h = archived();
      try {
        h.sign.mockImplementationOnce(async (event) => {
          if (change === "role")
            h.setEvents([
              h.metadata(true),
              h.roles("member"),
              ...h.getEvents().slice(2),
            ]);
          if (change === "archive state")
            h.setEvents([h.metadata(false), ...h.getEvents().slice(1)]);
          if (change === "signer") event.tags[1] = ["archived", "true"];
          return finalizeEvent(event, key);
        });
        await expect(h.owner.capability.run("unarchive", id)).rejects.toThrow(
          change === "signer" ? "Signer changed" : "no longer permitted",
        );
        expect(h.publish).not.toHaveBeenCalled();
      } finally {
        h.owner.dispose();
      }
    },
  );
  it("accepts explicit false readback as well as the relay's omitted tag", async () => {
    const h = archived();
    try {
      h.publish.mockImplementationOnce(async () =>
        h.setEvents([
          h.record(39000, [
            ["d", id],
            ["t", "stream"],
            ["archived", "false"],
          ]),
          ...h.getEvents().slice(1),
        ]),
      );
      await h.owner.capability.run("unarchive", id);
      expect(h.acceptDiscovery).toHaveBeenCalledOnce();
      expect(h.removed).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
  });
  it.each(["missing", "archived", "malformed"])(
    "does not treat %s readback as restored",
    async (result) => {
      vi.useFakeTimers();
      const h = archived();
      try {
        h.publish.mockImplementationOnce(async () => {
          if (result === "missing") h.setEvents(h.getEvents().slice(1));
          if (result === "malformed")
            h.setEvents([
              h.record(39000, [
                ["d", id],
                ["archived", "unknown"],
              ]),
              ...h.getEvents().slice(1),
            ]);
        });
        const run = expect(
          h.owner.capability.run("unarchive", id),
        ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
        await vi.runAllTimersAsync();
        await run;
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.acceptDiscovery).not.toHaveBeenCalled();
        expect(h.removed).not.toHaveBeenCalled();
      } finally {
        h.owner.dispose();
        vi.useRealTimers();
      }
    },
  );
  it("keeps rejection retryable and uncertain delivery non-replayable", async () => {
    const h = archived();
    try {
      h.publish.mockRejectedValueOnce(
        new PublishRejected("permission revoked"),
      );
      await expect(
        h.owner.capability.run("unarchive", id),
      ).rejects.toBeInstanceOf(PublishRejected);
      h.publish.mockRejectedValueOnce(new Error("connection lost"));
      await expect(
        h.owner.capability.run("unarchive", id),
      ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
      expect(h.acceptDiscovery).not.toHaveBeenCalled();
      expect(h.removed).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
  });
  it.each([
    [
      ["archived", "false"],
      ["name", "rename"],
    ],
    [
      ["archived", "false"],
      ["archived", "true"],
    ],
    [["archived", "false", "extra"]],
    [["archived", "invalid"]],
    [["auto_join"]],
    [["auto_join", "maybe"]],
    [["auto_join", "true", "extra"]],
    [
      ["archived", "false"],
      ["auto_join", "true"],
    ],
    [["autojoin", "true"]],
  ])("does not broaden the metadata command: %j", (...tags) => {
    expect(() =>
      validateLifecycleTemplate({
        kind: 9002,
        content: "",
        created_at: 1,
        tags: [["h", id], ...tags],
      }),
    ).toThrow();
  });
});

describe("auto-join switch", () => {
  function publicStream(
    tags: string[][] = [["public"]],
    type = "stream",
    role = "member",
  ) {
    const h = harness(role, type);
    const metadata = (autoJoin: boolean) =>
      h.record(39000, [
        ["d", id],
        ["t", type],
        ["name", "fixture"],
        ...tags,
        ...(autoJoin ? [["auto_join"]] : []),
      ]);
    h.setEvents([metadata(false), ...h.getEvents().slice(1)]);
    h.publish.mockImplementation(async (event: RelayEvent) => {
      if (event.kind === 9002)
        h.setEvents([
          metadata(
            event.tags.some(
              ([key, value]) => key === "auto_join" && value === "true",
            ),
          ),
          ...h.getEvents().filter((event) => event.kind !== 39000),
        ]);
    });
    return { ...h, metadata };
  }

  it.each([
    ["auto-join-on", "true"],
    ["auto-join-off", "false"],
  ] as const)(
    "%s publishes the narrow 9002 and confirms the bare readback tag",
    async (action, value) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const h = publicStream();
      if (action === "auto-join-off")
        h.setEvents([h.metadata(true), ...h.getEvents().slice(1)]);
      try {
        await h.owner.capability.run(action, id);
        expect(h.sign.mock.calls[0]?.[0]).toEqual(
          lifecycleTemplate(action, id),
        );
        expect(h.sign.mock.calls[0]?.[0]?.tags).toEqual([
          ["h", id],
          ["auto_join", value],
        ]);
        expect(h.publish).toHaveBeenCalledOnce();
        expect(h.acceptDiscovery).toHaveBeenCalledOnce();
        expect(
          h.acceptDiscovery.mock.calls[0]?.[0]?.[0]?.tags.some(
            ([key]: string[]) => key === "auto_join",
          ),
        ).toBe(action === "auto-join-on");
        // Channel roles cannot show relay ownership: only signed metadata is read.
        for (const [filters] of h.read.mock.calls)
          expect(filters.map((filter) => filter.kinds)).toEqual([[39000]]);
      } finally {
        clock.mockRestore();
        h.owner.dispose();
      }
    },
  );

  it.each([
    [[["public"], ["private"]], "stream"],
    [[], "stream"],
    [[["public"], ["archived", "true"]], "stream"],
    [[["public"]], "forum"],
  ])(
    "refuses metadata %j on a %s channel before signing",
    async (tags, type) => {
      const h = publicStream(tags, type);
      try {
        await expect(
          h.owner.capability.run("auto-join-on", id),
        ).rejects.toThrow(
          "Only active public channels can auto-join new members.",
        );
        expect(h.sign).not.toHaveBeenCalled();
        expect(h.acceptDiscovery).not.toHaveBeenCalled();
      } finally {
        h.owner.dispose();
      }
    },
  );

  it("surfaces the relay's refusal and keeps an unconfirmed flag uncertain", async () => {
    const h = publicStream();
    try {
      h.publish.mockRejectedValueOnce(
        new PublishRejected("rejected", "invalid: actor not authorized"),
      );
      await expect(
        h.owner.capability.run("auto-join-on", id),
      ).rejects.toMatchObject({ reason: "invalid: actor not authorized" });
      // A relay that ignores the tag acks the write but never advertises it.
      h.publish.mockImplementationOnce(async () => {});
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = expect(
        h.owner.capability.run("auto-join-on", id),
      ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
      await vi.advanceTimersByTimeAsync(2500);
      await pending;
      expect(h.acceptDiscovery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      h.owner.dispose();
    }
  });
});

describe("caller publication guard", () => {
  function setup(action: "archive" | "unarchive") {
    const h = harness();
    if (action === "unarchive")
      h.setEvents([h.metadata(true), ...h.getEvents().slice(1)]);
    return h;
  }
  it.each(["archive", "unarchive"] as const)(
    "publishes no %s once the caller's guard turns false during signing",
    async (action) => {
      const h = setup(action);
      let eligible = true;
      const active = vi.fn(() => eligible);
      const sign = h.sign.getMockImplementation();
      assert(sign);
      h.sign.mockImplementationOnce(async (event) => {
        eligible = false;
        return sign(event);
      });
      try {
        const error = await h.owner.capability
          .run(action, id, undefined, active)
          .catch((error: unknown) => error);
        expect(error).toMatchObject({ name: "AbortError" });
        expect(error).not.toBeInstanceOf(ChannelLifecycleUnconfirmed);
        expect(active).toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
        // Nothing reached the relay, so a later eligible run is not blocked.
        await h.owner.capability.run(action, id);
        expect(h.publish).toHaveBeenCalledOnce();
      } finally {
        h.owner.dispose();
      }
    },
  );
  it("checks a true guard after re-authorization and publishes as before", async () => {
    const h = setup("archive");
    const active = vi.fn(() => true);
    try {
      await h.owner.capability.run("archive", id, undefined, active);
      expect(active).toHaveBeenCalledOnce();
      const [checked = 0] = active.mock.invocationCallOrder;
      const [published = 0] = h.publish.mock.invocationCallOrder;
      const reads = h.read.mock.invocationCallOrder.filter(
        (at) => at < published,
      );
      expect(checked).toBeGreaterThan(Math.max(...reads));
      expect(checked).toBeLessThan(published);
      expect(h.acceptDiscovery).toHaveBeenCalledOnce();
    } finally {
      h.owner.dispose();
    }
  });
});

describe("join from a public preview", () => {
  it("applies an existing membership without signing", async () => {
    const h = preview();
    h.setEvents([h.metadata, h.roster(viewer)]);
    try {
      await h.owner.capability.run("join", id);
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.publish).not.toHaveBeenCalled();
      expect(h.acceptDiscovery).toHaveBeenCalledOnce();
    } finally {
      h.owner.dispose();
    }
  });

  it.each([
    [[]],
    [[["public"], ["private"]]],
    [[["public"], ["hidden"]]],
    [[["public"], ["archived", "true"]]],
  ])("refuses metadata %j before signing", async (tags) => {
    const h = preview(tags);
    try {
      await expect(h.owner.capability.run("join", id)).rejects.toThrow(
        "This conversation can’t be joined right now.",
      );
      expect(h.sign).not.toHaveBeenCalled();
      expect(h.acceptDiscovery).not.toHaveBeenCalled();
    } finally {
      h.owner.dispose();
    }
  });

  it("reports an accepted but unconfirmed join, then a retry confirms it", async () => {
    const h = preview();
    h.publish.mockImplementationOnce(async () => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = expect(
        h.owner.capability.run("join", id),
      ).rejects.toBeInstanceOf(ChannelLifecycleUnconfirmed);
      await vi.advanceTimersByTimeAsync(2500);
      await pending;
      vi.useRealTimers();
      expect(h.acceptDiscovery).not.toHaveBeenCalled();
      await h.owner.capability.run("join", id);
      expect(h.publish).toHaveBeenCalledTimes(2);
      expect(h.acceptDiscovery).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      h.owner.dispose();
    }
  });
});

it("retires queued entries and waits only after confirmed removal, including pending validation", async () => {
  const h = harness();
  const deactivate = vi.fn();
  const gate = deferred<void>();
  const queue = followUpQueue({
    channels: {
      list: () => ({ channels: h.removed.mock.calls.length ? [] : [{ id }] }),
    },
    channelLifecycle: h.owner.capability,
    agentActivity: {
      activate: () => deactivate,
      subscribe: () => () => {},
      snapshot: () => ({ status: "unavailable", turns: [], local: [] }),
    },
  } as unknown as RelaySession);
  const publish = vi.fn(() => "queued");
  try {
    queue.submit({
      channelId: id,
      text: "first",
      recipients: [other],
      publish: () => "first",
    });
    queue.submit({
      channelId: id,
      text: "queued",
      recipients: [other],
      publish,
      beforeRelease: () => gate.promise,
    });
    queue.sendNow(queue.snapshot()[0]?.id ?? "missing");
    await h.owner.capability.run("delete", id);
    expect(queue.snapshot()).toEqual([]);
    expect(deactivate).toHaveBeenCalledOnce();
    gate.resolve();
    await gate.promise;
    expect(publish).not.toHaveBeenCalled();
  } finally {
    gate.resolve();
    h.owner.dispose();
  }
});
