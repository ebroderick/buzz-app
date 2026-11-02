import { assert, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  WORKFLOW_CHANNEL_BATCH,
  WORKFLOW_DEFINITION_LIMIT,
} from "../workflows/queries";
import { byteSize } from "./budget";
import { tag, type RelayEvent } from "./events";
import { createRelaySession } from "./session";
import type { ChannelSummary } from "./contracts";
import type { ChannelStoreOptions } from "./store";
import { isRetryableRead } from "./read-retry";
import {
  flush,
  keypair,
  message,
  metadata,
  roster,
  scriptedTransport,
  signed,
} from "./testing";

const relay = keypair(),
  viewer = keypair();
const owners: ReturnType<typeof createRelaySession>[] = [];
let memberships: RelayEvent[];
const names = new Map<string, { name: string; event?: RelayEvent }>();
function named(id: string) {
  const entry = names.get(id);
  assert.exists(entry);
  entry.event ??= metadata(relay, id, entry.name);
  return entry.event;
}
// Preserve real page/capacity boundaries; sign metadata lazily when requested.
beforeAll(() => {
  memberships = Array.from({ length: 10_001 }, (_, i) => {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    names.set(id, { name: `Channel ${i}` });
    return roster(relay, id, [viewer.pubkey]);
  }).sort((a, b) => a.id.localeCompare(b.id));
}, 60_000);
afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose();
});
function setup(
  options: ChannelStoreOptions = {},
  relayInfo: { channelIdentity?: true } = {},
) {
  const wire = scriptedTransport(viewer.pubkey, relay.pubkey);
  let receive!: (events: readonly RelayEvent[]) => void;
  const owner = createRelaySession(
    {
      ...wire.transport,
      ...relayInfo,
      subscribe(callbacks) {
        receive = callbacks.receive;
        return { update() {}, retry() {}, dispose() {} };
      },
    },
    options,
  );
  owners.push(owner);
  const channels = owner.session.channels;
  const next = async (kind: number) => {
    await vi.waitFor(() => expect(wire.pending.length).toBeGreaterThan(0));
    const request = wire.next();
    expect(request.filters[0]?.kinds).toEqual([kind]);
    return request;
  };
  const settled = async (state = "verified") => {
    await vi.waitFor(() =>
      expect(owner.session.live.snapshot().roster.state).toBe(state),
    );
  };
  return {
    ...wire,
    ...owner,
    channels,
    next,
    settled,
    emit: (events: readonly RelayEvent[]) => receive(events),
    async rosters(count: number, exhaust = true) {
      for (
        let offset = 0;
        offset < count || (exhaust && offset === count);
        offset += 500
      ) {
        const request = await next(39002);
        const previous = memberships[offset - 1];
        expect(request.filters).toEqual([
          {
            kinds: [39002],
            "#p": [viewer.pubkey],
            limit: 500,
            ...(previous
              ? { until: previous.created_at, before_id: previous.id }
              : {}),
          },
        ]);
        request.respond(
          memberships.slice(offset, Math.min(offset + 500, count)),
        );
      }
    },
    async metadata(count: number) {
      const requested: string[] = [];
      for (let offset = 0; offset < count; offset += 500) {
        const request = await next(39000);
        const ids = request.filters[0]?.["#d"] ?? [];
        expect(ids).toHaveLength(Math.min(500, count - offset));
        expect(request.filters[0]?.limit).toBe(500);
        requested.push(...ids);
        request.respond(ids.map(named));
      }
      await settled();
      expect(new Set(requested).size).toBe(count);
    },
    async confirmOmitted(ids: readonly string[], events: RelayEvent[] = []) {
      const request = await next(39002);
      expect(request.filters).toEqual([
        {
          kinds: [39002],
          authors: [relay.pubkey],
          "#d": ids,
          "#p": [viewer.pubkey],
          limit: ids.length + 1,
        },
      ]);
      request.respond(events);
    },
  };
}

it("discovers and names 501 same-timestamp memberships, including a workflow on the second page", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(501);
  await h.metadata(501);
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.list().channels).toHaveLength(501);
  for (const channel of h.channels.list().channels)
    expect(channel.name).toBe(tag(named(channel.id), "name"));

  const last = memberships[500];
  assert.exists(last);
  const channelId = tag(last, "d");
  assert.exists(channelId);
  const workflow = signed(viewer, {
    kind: 30620,
    tags: [
      ["h", channelId],
      ["d", "11111111-1111-4111-8111-111111111111"],
    ],
    content:
      "name: Page two\nenabled: false\ntrigger:\n  on: message_posted\nsteps:\n  - id: send\n    action: send_message\n    text: Hi\n",
  });
  const found: string[] = [];
  const ids = h.channels.list().channels.map((channel) => channel.id);
  for (let offset = 0; offset < ids.length; offset += WORKFLOW_CHANNEL_BATCH) {
    const batch = ids.slice(offset, offset + WORKFLOW_CHANNEL_BATCH);
    const view = h.session.workflows.definitions(batch);
    try {
      const done = view.refresh();
      const request = await h.next(30620);
      expect(request.filters).toEqual([
        {
          kinds: [30620],
          "#h": [...batch].sort(),
          limit: WORKFLOW_DEFINITION_LIMIT,
        },
      ]);
      request.respond(batch.includes(channelId) ? [workflow] : []);
      await done;
      found.push(...view.snapshot().data.items.map((item) => item.channelId));
    } finally {
      view.dispose();
    }
  }
  expect(found).toEqual([channelId]);
  expect(h.pending).toHaveLength(0);
});

it.each([500, 1000])(
  "requires an exhaustion read after exactly %i memberships",
  async (count) => {
    const h = setup({ now: () => 1_000 });
    h.emit([roster(relay, "omitted", [viewer.pubkey])]);
    h.channels.ensureList();
    for (let offset = 0; offset < count; offset += 500)
      (await h.next(39002)).respond(memberships.slice(offset, offset + 500));
    const exhaustion = await h.next(39002);
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    expect(exhaustion.filters[0]).toMatchObject({
      until: memberships[count - 1]?.created_at,
      before_id: memberships[count - 1]?.id,
    });
    exhaustion.respond([]);
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(count);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(h.channels.list().channels).toHaveLength(count);
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(false);
    expect(h.pending).toHaveLength(0);
  },
);

it("confirms a scan-start membership that moved ahead of the cursor before reconciling omissions", async () => {
  const h = setup();
  const retained = message(viewer, "omitted", "Retained", 10);
  h.emit([roster(relay, "omitted", [viewer.pubkey], 1_699_999_999), retained]);
  const view = h.session.observe([{ kinds: [9], limit: 20 }]);
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([]);
  const fresh = roster(relay, "omitted", [viewer.pubkey], 1_700_000_001);
  await h.confirmOmitted(["omitted"], [fresh]);
  for (let i = 0; i < 2; i++) {
    const request = await h.next(39000);
    request.respond(
      (request.filters[0]?.["#d"] ?? []).flatMap((id) =>
        names.has(id) ? [named(id)] : [],
      ),
    );
  }
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.get?.("omitted")?.cached).toBeUndefined();
  expect(view.snapshot().events).toEqual([retained]);
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(true);
});

it.each(["failure", "cancelled", "repeated full page", "repeated short page"])(
  "preserves partial grants and omitted data after later-page %s, then retries from the beginning",
  async (failure) => {
    const h = setup();
    const retained = message(viewer, "omitted", "Retained", 10);
    h.emit([roster(relay, "omitted", [viewer.pubkey]), retained]);
    const view = h.session.observe([{ kinds: [9], limit: 20 }]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    const continuation = await h.next(39002);
    expect(h.channels.list().channels).toHaveLength(501);
    expect(h.channels.list().coverage).toBe("partial");
    if (failure === "failure") continuation.fail(new Error("offline"));
    else if (failure === "cancelled")
      continuation.fail(new DOMException("Cancelled", "AbortError"));
    else
      continuation.respond(
        memberships.slice(0, failure === "repeated full page" ? 500 : 1),
      );
    await h.settled(failure === "cancelled" ? "deferred" : "error");
    expect(h.channels.list().coverage).toBe("partial");
    expect(h.channels.list().channels).toHaveLength(501);
    expect(view.snapshot().events).toEqual([retained]);
    expect(h.pending).toHaveLength(0);

    h.channels.ensureList();
    await h.rosters(501);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(501);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(h.channels.list().channels).toHaveLength(501);
    expect(view.snapshot().events).toEqual([]);
  },
);

it.each(["failure", "cancelled"])(
  "preserves omitted data after exact confirmation %s, then retries deliberately",
  async (failure) => {
    const h = setup();
    const retained = message(viewer, "omitted", "Retained", 10);
    h.emit([roster(relay, "omitted", [viewer.pubkey]), retained]);
    const view = h.session.observe([{ kinds: [9], limit: 20 }]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    const confirmation = await h.next(39002);
    expect(confirmation.filters[0]).toMatchObject({
      authors: [relay.pubkey],
      "#d": ["omitted"],
      "#p": [viewer.pubkey],
      limit: 2,
    });
    if (failure === "cancelled")
      confirmation.fail(new DOMException("Cancelled", "AbortError"));
    else confirmation.fail(new Error("offline"));
    await h.settled(failure === "cancelled" ? "deferred" : "error");
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    expect(view.snapshot().events).toEqual([retained]);

    h.channels.ensureList();
    const restarted = await h.next(39002);
    expect(restarted.filters[0]?.before_id).toBeUndefined();
    restarted.respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    await h.confirmOmitted(["omitted"]);
    await h.metadata(500);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(false);
    expect(view.snapshot().events).toEqual([]);
  },
);

it("confirms omitted scan-start memberships in 128-channel batches", async () => {
  const h = setup();
  const omitted = Array.from({ length: 129 }, (_, index) => `omitted-${index}`);
  h.emit(omitted.map((id) => roster(relay, id, [viewer.pubkey])));
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([]);
  const first = await h.next(39002);
  const firstIds = first.filters[0]?.["#d"] ?? [];
  expect(first.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: 129,
  });
  expect(firstIds).toHaveLength(128);
  first.respond(
    firstIds.map((id) => roster(relay, id, [viewer.pubkey], 1_700_000_001)),
  );
  const second = await h.next(39002);
  const secondIds = second.filters[0]?.["#d"] ?? [];
  expect(second.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: 2,
  });
  expect(secondIds).toHaveLength(1);
  expect(new Set([...firstIds, ...secondIds])).toEqual(new Set(omitted));
  second.respond(
    secondIds.map((id) => roster(relay, id, [viewer.pubkey], 1_700_000_001)),
  );
  for (let i = 0; i < 2; i++) {
    const request = await h.next(39000);
    request.respond(
      (request.filters[0]?.["#d"] ?? []).flatMap((id) =>
        names.has(id) ? [named(id)] : [],
      ),
    );
  }
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
  expect(h.channels.list().channels).toHaveLength(629);
  expect(omitted.every((id) => h.channels.get?.(id))).toBe(true);
});

it("uses the scan-start roster versions when live grants arrive between pages", async () => {
  const h = setup();
  h.emit([
    roster(relay, "renewed", [viewer.pubkey], 10),
    roster(relay, "omitted", [viewer.pubkey], 10),
  ]);
  h.channels.ensureList();
  const first = await h.next(39002);
  h.emit([roster(relay, "renewed", [viewer.pubkey], 11)]);
  first.respond(memberships.slice(0, 500));
  const second = await h.next(39002);
  h.emit([roster(relay, "new-grant", [viewer.pubkey], 12)]);
  second.respond(memberships.slice(500, 501));
  await h.confirmOmitted(["omitted"]);
  const namesRead = await h.next(39000);
  expect(h.channels.list().channels.map((channel) => channel.id)).toEqual(
    expect.arrayContaining(["renewed", "new-grant"]),
  );
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(false);
  namesRead.respond([]);
  (await h.next(39000)).respond([]);
  await h.settled();
  expect(h.channels.list().channels).toHaveLength(503);
  expect(h.channels.list().coverage).toBeUndefined();
});

it.each(["cache clear", "disposal"])(
  "fences exact omission confirmation after %s",
  async (action) => {
    const h = setup();
    h.emit([roster(relay, "omitted", [viewer.pubkey])]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    (await h.next(39002)).respond([]);
    const confirmation = await h.next(39002);
    if (action === "cache clear") await h.clearCache();
    else h.dispose();
    expect(confirmation.signal?.aborted).toBe(true);
    confirmation.respond([
      roster(relay, "omitted", [viewer.pubkey], 1_700_000_001),
    ]);
    if (action === "cache clear")
      expect(h.channels.list().coverage).toBe("partial");
  },
);

it.each(["revocation", "cache clear"])(
  "fences a later page after %s and starts a fresh scan",
  async (action) => {
    const h = setup();
    h.emit([
      roster(relay, "omitted", [viewer.pubkey], 10),
      roster(relay, "revoked", [viewer.pubkey], 10),
    ]);
    h.channels.ensureList();
    (await h.next(39002)).respond(memberships.slice(0, 500));
    const late = await h.next(39002);
    if (action === "revocation") h.emit([roster(relay, "revoked", [], 11)]);
    else await h.clearCache();
    expect(late.signal?.aborted).toBe(true);
    const snapshot = h.channels.list();
    late.respond(memberships.slice(500, 501));
    if (action === "cache clear") h.channels.ensureList();
    const restarted = await h.next(39002);
    expect(restarted.filters[0]?.before_id).toBeUndefined();
    expect(h.channels.list().channels).toEqual(snapshot.channels);
    expect(h.channels.list().coverage).toBe("partial");
    expect(
      h.channels.list().channels.some((channel) => channel.id === "omitted"),
    ).toBe(true);
    restarted.respond([]);
    await h.settled();
    expect(h.channels.list().channels).toEqual([]);
  },
);

it("coalesces refresh hints during pagination into one new scan", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  const second = await h.next(39002);
  h.channels.refreshList?.();
  h.channels.refreshList?.();
  second.respond(memberships.slice(500, 501));
  for (let i = 0; i < 2; i++) (await h.next(39000)).respond([]);
  const refresh = await h.next(39002);
  expect(refresh.filters[0]?.before_id).toBeUndefined();
  refresh.respond([]);
  await h.settled();
  expect(h.pending).toHaveLength(0);
  expect(h.channels.list().channels).toEqual([]);
});

it("keeps membership and earlier names when a later metadata batch fails, then retries missing names", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(501);
  const first = await h.next(39000);
  const initial = first.filters[0]?.["#d"];
  assert.exists(initial);
  first.respond(initial.map(named));
  const second = await h.next(39000);
  const missing = second.filters[0]?.["#d"];
  assert.exists(missing);
  second.fail(new Error("Relay read failed (403)"));
  await h.settled("error");
  expect(h.channels.list().channels).toHaveLength(501);
  expect(h.channels.list().coverage).toBeUndefined();
  expect(
    h.channels
      .list()
      .channels.filter((channel) => channel.name.startsWith("Channel ")),
  ).toHaveLength(500);
  h.channels.ensureList();
  await h.rosters(501);
  const retry = await h.next(39000);
  expect(retry.filters[0]?.["#d"]).toEqual(missing);
  retry.respond(missing.map(named));
  await h.settled();
  expect(
    h.channels
      .list()
      .channels.every((channel) => channel.name.startsWith("Channel ")),
  ).toBe(true);
});

it.each([10_000, 10_001])(
  "reports retention coverage truthfully for %i memberships",
  async (count) => {
    const h = setup();
    h.channels.ensureList();
    await h.rosters(count);
    await h.metadata(count);
    expect(h.channels.list().channels).toHaveLength(count);
    expect(h.channels.list().coverage).toBeUndefined();
    expect(h.pending).toHaveLength(0);
  },
  60_000,
);

it("does not revoke omitted channels when retained bytes exhaust the budget", async () => {
  const omitted = roster(relay, "omitted", [viewer.pubkey]);
  const maxDiscoveryBytes =
    byteSize(omitted) +
    memberships
      .slice(0, 499)
      .reduce((bytes, event) => bytes + byteSize(event), 0);
  const h = setup({ maxDiscoveryBytes });
  h.emit([omitted]);
  h.channels.ensureList();
  await h.rosters(500, false);
  await h.metadata(499);
  expect(h.channels.list().coverage).toBe("partial");
  expect(h.channels.list().channels).toHaveLength(500);
  expect(
    h.channels.list().channels.some((channel) => channel.id === "omitted"),
  ).toBe(true);
});

it("keeps coverage partial when exact discovery overflows during omission confirmation", async () => {
  const maxDiscoveryBytes = memberships
    .slice(0, 1000)
    .reduce((bytes, event) => bytes + byteSize(event), 0);
  const h = setup({ maxDiscoveryBytes });
  h.emit(memberships.slice(0, 1000));
  expect(h.channels.list().channels).toHaveLength(1000);

  h.channels.ensureList();
  await h.rosters(976);
  const confirmation = await h.next(39002);
  const omitted = memberships
    .slice(976, 1000)
    .flatMap((event) => tag(event, "d") ?? []);
  const confirmationIds = confirmation.filters[0]?.["#d"] ?? [];
  expect(confirmation.filters[0]).toMatchObject({
    authors: [relay.pubkey],
    "#p": [viewer.pubkey],
    limit: omitted.length + 1,
  });
  expect(new Set(confirmationIds)).toEqual(new Set(omitted));

  const resolve = h.channels.resolve?.(["overflow"]);
  assert.exists(resolve);
  const exact = await h.next(39000);
  expect(exact.filters).toEqual([
    {
      kinds: [39000],
      authors: [relay.pubkey],
      "#d": ["overflow"],
      limit: 2,
    },
    {
      kinds: [39002],
      authors: [relay.pubkey],
      "#d": ["overflow"],
      "#p": [viewer.pubkey],
      limit: 2,
    },
  ]);
  exact.respond([roster(relay, "overflow", [viewer.pubkey])]);
  await resolve;
  expect(h.channels.list().coverage).toBe("partial");

  confirmation.respond([]);
  await h.metadata(976);
  expect(h.session.live.snapshot().roster.state).toBe("verified");
  expect(h.channels.list().coverage).toBe("partial");
  expect(
    h.channels.list().channels.some((channel) => channel.id === "overflow"),
  ).toBe(false);
  expect(h.channels.get?.("overflow")).toBeUndefined();
  expect(h.pending).toHaveLength(0);
});

it("marks metadata byte overflow as partial without discarding membership", async () => {
  const initial = [...names.keys()].slice(0, 500).map(named);
  const retained = new Set(initial.map((event) => tag(event, "d")));
  const member = memberships.find((event) => !retained.has(tag(event, "d")));
  assert.exists(member);
  const id = tag(member, "d");
  assert.exists(id);
  const maxDiscoveryBytes =
    byteSize(member) +
    initial.reduce((bytes, event) => bytes + byteSize(event), 0);
  const h = setup({ maxDiscoveryBytes });
  h.emit(initial);
  h.channels.ensureList();
  (await h.next(39002)).respond([member]);
  (await h.next(39000)).respond([named(id)]);
  await h.settled();
  expect(h.channels.list().channels).toMatchObject([
    { id, name: id.slice(0, 8) },
  ]);
  expect(h.channels.list().coverage).toBe("partial");
});

it("keeps final-page callback invalidation partial across later live traffic", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  const final = await h.next(39002);
  let cleared: Promise<void> | undefined;
  const stop = h.channels.subscribeList(() => {
    if (h.channels.list().coverage !== undefined) return;
    stop();
    cleared = h.clearCache();
  });
  final.respond(memberships.slice(500, 501));
  await h.settled("deferred");
  expect(cleared).toBeDefined();
  await cleared;
  expect(h.channels.list().coverage).toBe("partial");
  h.emit([roster(relay, "live", [viewer.pubkey])]);
  expect(h.channels.list().coverage).toBe("partial");
  expect(h.pending).toHaveLength(0);
  h.channels.ensureList();
  (await h.next(39002)).respond([]);
  await h.settled();
  expect(h.channels.list().coverage).toBeUndefined();
});

it("keeps a retry from a cancellation notification pending until the new scan finishes", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond([]);
  await h.settled();
  const stop = h.channels.subscribeList(() => {
    if (h.channels.list().coverage !== "partial") return;
    stop();
    h.channels.refreshList?.();
  });
  h.channels.refreshList?.();
  (await h.next(39002)).fail(new DOMException("Cancelled", "AbortError"));
  const retry = await h.next(39002);
  expect(h.session.live.snapshot().roster.state).toBe("pending");
  retry.respond([]);
  await h.settled();
  expect(h.pending).toHaveLength(0);
});

it("continues into an older timestamp after a full same-timestamp page", async () => {
  const h = setup();
  const older = memberships[500];
  assert.exists(older);
  const id = tag(older, "d");
  assert.exists(id);
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).respond([
    roster(relay, id, [viewer.pubkey], older.created_at - 1),
  ]);
  await h.metadata(501);
  expect(h.channels.list().channels).toHaveLength(501);
  expect(h.channels.list().coverage).toBeUndefined();
});

it.each([
  ["between pages", 1],
  ["before the first page", 0],
])(
  "resumes discovery after a live revocation interrupts it %s",
  async (_, pagesBefore) => {
    const h = setup();
    h.emit([roster(relay, "revoked", [viewer.pubkey], 10)]);
    h.channels.ensureList();
    for (let page = 0; page < pagesBefore; page++)
      (await h.next(39002)).respond(memberships.slice(0, 500));
    const interrupted = await h.next(39002);
    h.emit([roster(relay, "revoked", [], 11)]);
    expect(interrupted.signal?.aborted).toBe(true);
    await h.rosters(501);
    await h.metadata(501);
    expect(h.pending).toHaveLength(0);
    expect(h.channels.list().channels).toHaveLength(501);
    expect(h.channels.list().coverage).toBeUndefined();
  },
);

it("leaves a failed roster page in error without rereading", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  (await h.next(39002)).fail(new Error("Relay read failed (500)"));
  await h.settled("error");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
});

it("does not reread after dispose interrupts discovery", async () => {
  const h = setup();
  h.channels.ensureList();
  (await h.next(39002)).respond(memberships.slice(0, 500));
  const interrupted = await h.next(39002);
  h.dispose();
  expect(interrupted.signal?.aborted).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.pending).toHaveLength(0);
});

it("ranks public name matches before the cut and reuses one metadata page while typing", async () => {
  let clock = 1_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  expect(h.channels.list().status).toBe("ready");
  const id = (n: number) =>
    `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string) =>
    metadata(relay, id(n), name, 1_700_000_000, [["public"], ["t", "stream"]]);
  // Eight names that sort before "ops", which an alphabetical cut kept.
  const page = [
    ...Array.from({ length: 8 }, (_, n) => open(n, `aa-ops-${n}`)),
    open(8, "ops"),
  ];
  const search = async (query: string, reads: boolean) => {
    const done = h.channels.searchPublic?.(query);
    assert.exists(done);
    if (reads) {
      const request = await h.next(39000);
      expect(request.filters).toEqual([
        {
          kinds: [39000],
          authors: [relay.pubkey],
          limit: 500,
          ...(clock === 1_000_000 ? {} : { since: 880 }),
        },
      ]);
      request.respond(page);
    }
    const resolve = await h.next(39000);
    const ids = resolve.filters[0]?.["#d"] ?? [];
    resolve.respond(
      page.filter((event) => ids.includes(tag(event, "d") ?? "")),
    );
    return { ids, result: await done };
  };
  const first = await search("op", true);
  expect(first.ids).toHaveLength(8);
  expect(first.ids).toContain(id(8));
  expect(first.ids).not.toContain(id(7));
  expect(first.result.channels[0]?.name).toBe("ops");
  // A remounted caller reads the last answer back while the next search runs.
  expect(
    h.channels.matchPublic?.("ops").map((channel) => channel.name),
  ).toEqual(["ops", ...Array.from({ length: 7 }, (_, n) => `aa-ops-${n}`)]);
  expect(h.channels.matchPublic?.("ops", { exact: true })).toHaveLength(1);
  expect(h.channels.matchPublic?.("zzz")).toEqual([]);
  // The next keystroke filters the same page instead of reading it again.
  clock += 29_999;
  const second = await search("ops", false);
  expect(second.result.channels.map((channel) => channel.name)[0]).toBe("ops");
  expect(h.pending).toHaveLength(0);
  // After the reuse window, a new page is read.
  clock += 1;
  await search("ops", true);
  expect(h.pending).toHaveLength(0);
  // Clearing the cache forgets the last answer.
  await h.clearCache();
  expect(h.channels.matchPublic?.("ops")).toEqual([]);
});

it.each(["complete", "fail"])(
  "resolves saved candidates before an expired directory refresh can %s",
  async (outcome) => {
    let clock = 1_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const open = metadata(relay, "saved", "release-notes", 10, [["public"]]);
    // The earlier query returned nothing: matchPublic cannot supply the row.
    const warm = h.channels.searchPublic?.("zzz");
    (await h.next(39000)).respond([open]);
    await warm;
    clock += 5 * 60_000;
    const progress = vi.fn();
    const search = h.channels.searchPublic?.("release", { progress });
    assert.exists(search);
    const result = search.then(
      (found) => found,
      (error: unknown) => error,
    );
    const refresh = await h.next(39000);
    expect(refresh.filters[0]?.["#d"]).toBeUndefined();
    // The full directory remains gated. Only a fresh exact read admits a row.
    const exact = await h.next(39000);
    expect(exact.filters[0]?.["#d"]).toEqual(["saved"]);
    expect(progress).not.toHaveBeenCalled();
    exact.respond([open]);
    await vi.waitFor(() =>
      expect(progress).toHaveBeenCalledWith({
        channels: [expect.objectContaining({ id: "saved", readOnly: true })],
        partial: false,
      }),
    );
    expect(h.channels.list().channels).toEqual([]);
    if (outcome === "fail") {
      refresh.fail(new Error("offline"));
      expect(await result).toEqual(new Error("offline"));
      expect(h.channels.matchPublic?.("release")).toHaveLength(1);
    } else {
      // An omitted candidate does not survive in the authoritative final answer.
      refresh.respond([]);
      expect(await result).toEqual({ channels: [], partial: false });
      expect(h.channels.matchPublic?.("release")).toEqual([]);
    }
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["renamed", "private", "archived", "missing"])(
  "withholds a saved candidate that is now %s during directory refresh",
  async (change) => {
    let clock = 1_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const old = metadata(relay, "saved", "release-notes", 10, [["public"]]);
    const warm = h.channels.searchPublic?.("zzz");
    (await h.next(39000)).respond([old]);
    await warm;
    clock += 5 * 60_000;
    const progress = vi.fn();
    const search = h.channels.searchPublic?.("release", { progress });
    assert.exists(search);
    const result = search.catch((error: unknown) => error);
    const refresh = await h.next(39000);
    const exact = await h.next(39000);
    exact.respond(
      change === "missing"
        ? []
        : [
            metadata(
              relay,
              "saved",
              change === "renamed" ? "other-name" : "release-notes",
              11,
              change === "private"
                ? [["private"]]
                : [
                    ["public"],
                    ...(change === "archived" ? [["archived", "true"]] : []),
                  ],
            ),
          ],
    );
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    expect(progress).toHaveBeenLastCalledWith({ channels: [], partial: false });
    refresh.respond([]);
    expect(await result).toEqual({ channels: [], partial: false });
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["private", "missing"])(
  "immediately restarts an expired search when a previously admitted preview becomes %s",
  async (change) => {
    let clock = 1_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const old = metadata(relay, "old", "release-old", 10, [["public"]]);
    const warm = h.channels.searchPublic?.("release");
    (await h.next(39000)).respond([old]);
    (await h.next(39000)).respond([old]);
    await warm;
    expect(h.channels.get?.("old")?.readOnly).toBe(true);
    clock += 30_000;
    const search = h.channels.searchPublic?.("release", { progress() {} });
    assert.exists(search);
    const result = search.catch((error: unknown) => error);
    const refresh = await h.next(39000);
    (await h.next(39000)).respond(
      change === "missing"
        ? []
        : [metadata(relay, "old", "release-old", 11, [["private"]])],
    );
    // One local recovery bypasses network retry timers and uses fresh evidence.
    const current = metadata(relay, "new", "release-new", 12, [["public"]]);
    const retry = await h.next(39000);
    expect(retry.filters[0]?.since).toBeUndefined();
    expect(refresh.signal?.aborted).toBe(true);
    expect(h.channels.get?.("old")?.readOnly).not.toBe(true);
    retry.respond([current]);
    (await h.next(39000)).respond([current]);
    expect(await result).toMatchObject({
      channels: [{ id: "new" }],
      partial: false,
    });
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["second revocation", "caller cancellation"])(
  "bounds immediate recovery after %s",
  async (action) => {
    let clock = 1_700_000_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const first = metadata(relay, "first", "release-a", clock / 1000, [
      ["public"],
    ]);
    const second = metadata(relay, "second", "release-b", clock / 1000, [
      ["public"],
    ]);
    const warm = h.channels.searchPublic?.("release");
    (await h.next(39000)).respond([first, second]);
    (await h.next(39000)).respond([first, second]);
    await warm;
    clock += 30_000;
    const caller = new AbortController();
    const search = h.channels.searchPublic?.("release", {
      limit: 1,
      progress() {},
      signal: caller.signal,
    });
    assert.exists(search);
    const result = search.catch((error: unknown) => error);
    const original = await h.next(39000);
    (await h.next(39000)).respond([
      metadata(relay, "first", "release-a", clock / 1000, [["private"]]),
    ]);
    const recovery = await h.next(39000);
    expect(original.signal?.aborted).toBe(true);
    expect(recovery.filters[0]?.since).toBeUndefined();
    if (action === "caller cancellation") {
      caller.abort();
      expect(isRetryableRead(await result)).toBe(false);
      recovery.respond([]);
    } else {
      recovery.respond([second]);
      expect(h.channels.get?.("second")?.readOnly).toBe(true);
      (await h.next(39000)).respond([
        metadata(relay, "second", "release-b", clock / 1000, [["private"]]),
      ]);
      expect(await result).toMatchObject({ kind: "unavailable" });
    }
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["stalls", "fails"])(
  "finishes from the fresh directory when a saved-candidate read %s",
  async (failure) => {
    let clock = 1_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const old = metadata(relay, "old", "release-old", 10, [["public"]]);
    const warm = h.channels.searchPublic?.("zzz");
    (await h.next(39000)).respond([old]);
    await warm;
    clock += 5 * 60_000;
    const progress = vi.fn();
    const search = h.channels.searchPublic?.("release", { progress });
    assert.exists(search);
    const result = search.catch((error: unknown) => error);
    const refresh = await h.next(39000);
    const provisional = await h.next(39000);
    if (failure === "fails") provisional.fail(new Error("exact read failed"));
    const current = metadata(relay, "new", "release-new", 12, [["public"]]);
    refresh.respond([current]);
    const exact = await h.next(39000);
    expect(exact.filters[0]?.["#d"]).toEqual(["new"]);
    expect(provisional.signal?.aborted).toBe(true);
    exact.respond([current]);
    const found = await result;
    expect(found).toMatchObject({ channels: [{ id: "new" }], partial: false });
    // A late response cannot admit the superseded candidate or emit progress.
    provisional.respond([old]);
    expect(h.channels.get?.("old")).toBeUndefined();
    expect(progress).not.toHaveBeenCalled();
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["caller", "cache clear", "disposal"])(
  "does not retry a provisional search cancelled by %s",
  async (action) => {
    let clock = 1_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const old = metadata(relay, "old", "release-old", 10, [["public"]]);
    const warm = h.channels.searchPublic?.("zzz");
    (await h.next(39000)).respond([old]);
    await warm;
    clock += 30_000;
    const caller = new AbortController();
    const progress = vi.fn();
    const search = h.channels.searchPublic?.("release", {
      progress,
      signal: caller.signal,
    });
    assert.exists(search);
    const result = search.catch((error: unknown) => error);
    const refresh = await h.next(39000);
    const provisional = await h.next(39000);
    if (action === "caller") caller.abort();
    else if (action === "cache clear") await h.clearCache();
    else h.dispose();
    expect(isRetryableRead(await result)).toBe(false);
    expect(provisional.signal?.aborted).toBe(true);
    // A caller cancellation keeps the shared directory read for other queries.
    if (action === "caller") refresh.respond([]);
    else expect(refresh.signal?.aborted).toBe(true);
    expect(progress).not.toHaveBeenCalled();
    expect(h.pending).toHaveLength(0);
  },
);

it.each(["renamed", "archived"])(
  "uses a delivered %s delta when exact metadata arrives first",
  async (change) => {
    let clock = 1_700_000_000_000;
    const h = setup({ now: () => clock });
    h.channels.ensureList();
    await h.rosters(0);
    await h.settled();
    const old = metadata(relay, "x", "release-one", clock / 1000, [["public"]]);
    const keep = metadata(relay, "k", "release-keep", clock / 1000, [
      ["public"],
    ]);
    const warm = h.channels.searchPublic?.("zzz");
    (await h.next(39000)).respond([old, keep]);
    await warm;
    clock += 30_000;
    const current = metadata(
      relay,
      "x",
      change === "renamed" ? "release-two" : "release-one",
      clock / 1000,
      [["public"], ...(change === "archived" ? [["archived", "true"]] : [])],
    );
    const progress = vi.fn();
    const search = h.channels.searchPublic?.("release", { progress });
    const delta = await h.next(39000);
    expect(delta.filters[0]?.since).toBeDefined();
    (await h.next(39000)).respond([keep, current]);
    await vi.waitFor(() => expect(progress).toHaveBeenCalled());
    delta.respond([current]);
    const exact = await h.next(39000);
    expect(exact.filters[0]?.["#d"]).toBeDefined();
    exact.respond(
      [keep, current].filter((event) =>
        exact.filters[0]?.["#d"]?.includes(tag(event, "d") ?? ""),
      ),
    );
    const result = await search;
    expect(result).toMatchObject({
      channels:
        change === "renamed" ? [{ id: "k" }, { id: "x" }] : [{ id: "k" }],
      partial: false,
    });
    expect(h.pending).toHaveLength(0);
  },
);

it("preserves newer renamed metadata that arrives during a provisional full-scan lookup", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const old = metadata(relay, "release", "release-old", 10, [["public"]]);
  const current = metadata(relay, "release", "release-new", 11, [["public"]]);
  const { first } = openDirectory(h);
  const progress = vi.fn();
  const search = h.channels.searchPublic?.("release", { progress });
  (await h.next(39000)).respond([old, ...first.slice(0, 499)]);
  const older = await h.next(39000);
  const provisional = await h.next(39000);
  // Exact metadata changes while the next directory page is pending.
  provisional.respond([current]);
  await vi.waitFor(() => expect(progress).toHaveBeenCalled());
  older.respond([]);
  (await h.next(39000)).respond([current]);
  expect(await search).toMatchObject({
    channels: [{ id: "release", name: "release-new" }],
  });
  expect(h.channels.openDirectory?.()).toContainEqual({
    id: "release",
    name: "release-new",
  });
  expect(h.pending).toHaveLength(0);
});

it("merges incremental metadata and periodically replaces the full directory", async () => {
  const start = 1_700_000_000_000;
  let clock = start;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const open = (id: string, name: string, at: number, extra: string[][] = []) =>
    metadata(relay, id, name, at, [["public"], ...extra]);
  const read = async () => {
    const search = h.channels
      .searchPublic?.("zzz")
      .catch((error: unknown) => error);
    return { search, request: await h.next(39000) };
  };
  const first = await read();
  first.request.respond([
    open("renamed", "before", start / 1000),
    open("archived", "active", start / 1000),
    // A busy channel can have a timestamp ahead of the relay wall clock.
    open("future", "future", start / 1000 + 600),
  ]);
  await first.search;
  clock += 30_000;
  const delta = await read();
  expect(delta.request.filters[0]).toMatchObject({ since: start / 1000 - 120 });
  delta.request.respond([
    open("renamed", "after", start / 1000 + 1),
    open("archived", "active", start / 1000 + 2, [["archived", "true"]]),
    open("new", "new-channel", start / 1000 + 3),
  ]);
  expect(await delta.search).toEqual({ channels: [], partial: false });
  expect(h.channels.openDirectory?.()).toEqual([
    { id: "renamed", name: "after" },
    { id: "archived", name: "active", archived: true },
    { id: "future", name: "future" },
    { id: "new", name: "new-channel" },
  ]);
  clock += 30_000;
  const empty = await read();
  expect(empty.request.filters[0]?.since).toBe(start / 1000 + 30 - 120);
  empty.request.respond([]);
  await empty.search;
  expect(h.channels.openDirectory?.()).toHaveLength(4);
  clock = start + 5 * 60_000 - 1000;
  const recent = await read();
  expect(recent.request.filters[0]?.since).toBeDefined();
  recent.request.respond([]);
  await recent.search;
  clock = start + 5 * 60_000;
  const full = await read();
  expect(full.request.filters[0]?.since).toBeUndefined();
  full.request.respond([open("new", "new-channel", start / 1000 + 3)]);
  await full.search;
  expect(h.channels.openDirectory?.()).toEqual([
    { id: "new", name: "new-channel" },
  ]);
});

it("keeps the prior watermark and candidates after a failed delta continuation", async () => {
  const start = 1_700_000_000_000;
  let clock = start;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const old = metadata(relay, "old", "old", start / 1000, [["public"]]);
  const warm = h.channels.searchPublic?.("zzz");
  (await h.next(39000)).respond([old]);
  await warm;
  clock += 30_000;
  const { first } = openDirectory(h);
  const delta = h.channels.searchPublic?.("zzz");
  assert.exists(delta);
  const failed = delta.catch((error: unknown) => error);
  const page = await h.next(39000);
  const since = page.filters[0]?.since;
  page.respond(first);
  const continuation = await h.next(39000);
  expect(continuation.filters[0]).toMatchObject({
    since,
    before_id: expect.any(String),
  });
  continuation.fail(new Error("offline"));
  expect(await failed).toEqual(new Error("offline"));
  expect(h.channels.openDirectory?.()).toEqual([{ id: "old", name: "old" }]);
  clock += 30_000;
  const retry = h.channels.searchPublic?.("zzz");
  const request = await h.next(39000);
  expect(request.filters[0]?.since).toBe(since);
  request.respond([]);
  await retry;
  expect(h.channels.openDirectory?.()).toEqual([{ id: "old", name: "old" }]);
  // A wall-clock rollback cannot postpone refresh or advance a delta watermark.
  clock = start - 1;
  const full = h.channels.searchPublic?.("zzz");
  const replacement = await h.next(39000);
  expect(replacement.filters[0]?.since).toBeUndefined();
  replacement.respond([]);
  await full;
  expect(h.channels.openDirectory?.()).toEqual([]);
});

it("reconciles missing top matches so they cannot hide a valid ninth candidate", async () => {
  let clock = 1_700_000_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const stale = Array.from({ length: 8 }, (_, n) =>
    metadata(relay, `stale-${n}`, `release-${n}`, clock / 1000, [["public"]]),
  );
  const valid = metadata(relay, "valid", "release-valid", clock / 1000, [
    ["public"],
  ]);
  const warm = h.channels.searchPublic?.("zzz");
  (await h.next(39000)).respond([...stale, valid]);
  await warm;
  clock += 30_000;
  const search = h.channels.searchPublic?.("release");
  assert.exists(search);
  const result = search.catch((error: unknown) => error);
  (await h.next(39000)).respond([]);
  const exact = await h.next(39000);
  expect(exact.filters[0]?.["#d"]).toHaveLength(8);
  exact.respond([]);
  const full = await h.next(39000);
  expect(full.filters[0]?.since).toBeUndefined();
  full.respond([valid]);
  (await h.next(39000)).respond([valid]);
  expect(await result).toMatchObject({
    channels: [{ id: "valid" }],
    partial: false,
  });
  expect(h.channels.openDirectory?.()).toEqual([
    { id: "valid", name: "release-valid" },
  ]);
});

it("preserves newer saved metadata when a provisional exact read replays an older name", async () => {
  let clock = 1_700_000_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const old = metadata(relay, "renamed", "old-name", 10, [["public"]]);
  const current = metadata(relay, "renamed", "release-new", 11, [["public"]]);
  const warm = h.channels.searchPublic?.("zzz");
  (await h.next(39000)).respond([current]);
  await warm;
  clock += 30_000;
  const progress = vi.fn();
  const search = h.channels
    .searchPublic?.("release-new", { progress })
    .catch(() => undefined);
  const delta = await h.next(39000);
  (await h.next(39000)).respond([old]);
  await vi.waitFor(() => expect(progress).toHaveBeenCalled());
  expect(progress).toHaveBeenLastCalledWith({ channels: [], partial: false });
  delta.respond([]);
  // The newer saved name still nominates a candidate for a fresh final check.
  const exact = await h.next(39000);
  expect(exact.filters[0]?.["#d"]).toEqual(["renamed"]);
  exact.respond([current]);
  expect(await search).toMatchObject({
    channels: [{ id: "renamed", name: "release-new" }],
  });
  expect(h.channels.openDirectory?.()).toEqual([
    { id: "renamed", name: "release-new" },
  ]);
  expect(h.pending).toHaveLength(0);
});

it("reuses a full directory repaired by newer exact metadata", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const old = metadata(relay, "renamed", "release", 10, [["public"]]);
  const current = metadata(relay, "renamed", "shipping", 11, [["public"]]);
  const first = h.channels.searchPublic?.("release");
  (await h.next(39000)).respond([old]);
  (await h.next(39000)).respond([current]);
  expect(await first).toMatchObject({ channels: [] });
  const second = h.channels.searchPublic?.("shipping").catch(() => undefined);
  const exact = await h.next(39000);
  expect(exact.filters[0]?.["#d"]).toEqual(["renamed"]);
  exact.respond([current]);
  expect(await second).toMatchObject({ channels: [{ id: "renamed" }] });
  expect(h.pending).toHaveLength(0);
});

it("does not restart a verified concurrent answer when another delta answer is stale", async () => {
  let clock = 1_700_000_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const old = metadata(relay, "old", "release", 10, [["public"]]);
  const valid = metadata(relay, "valid", "shipping", 10, [["public"]]);
  const warm = h.channels.searchPublic?.("zzz");
  (await h.next(39000)).respond([old, valid]);
  await warm;
  clock += 30_000;
  const stale = h.channels.searchPublic?.("release").catch(() => undefined);
  const unaffected = h.channels
    .searchPublic?.("shipping")
    .catch(() => undefined);
  (await h.next(39000)).respond([]);
  const staleExact = await h.next(39000);
  const validExact = await h.next(39000);
  expect(staleExact.filters[0]?.["#d"]).toEqual(["old"]);
  expect(validExact.filters[0]?.["#d"]).toEqual(["valid"]);
  staleExact.respond([]);
  const recovery = await h.next(39000);
  expect(recovery.filters[0]?.since).toBeUndefined();
  // Keep the repair pending until the other answer finishes its exact read.
  validExact.respond([valid]);
  expect(await unaffected).toMatchObject({ channels: [{ id: "valid" }] });
  expect(h.pending).toHaveLength(0);
  recovery.respond([valid]);
  expect(await stale).toMatchObject({ channels: [] });
});

it("replaces the directory when an incremental merge would exceed its bound", async () => {
  let clock = 1_700_000_000_000;
  const h = setup({ now: () => clock, maxPublicDirectory: 500 });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  // Exercise the same signed merge boundary with a one-page memory budget.
  const events = Array.from({ length: 499 }, (_, n) =>
    metadata(relay, `bounded-${n}`, `entry-${n}`, clock / 1000, [["public"]]),
  ).sort((a, b) => a.id.localeCompare(b.id));
  const warm = h.channels.searchPublic?.("zzz");
  for (let offset = 0; offset < events.length; offset += 500)
    (await h.next(39000)).respond(events.slice(offset, offset + 500));
  expect(await warm).toEqual({ channels: [], partial: false });
  clock += 30_000;
  const delta = h.channels.searchPublic?.("zzz");
  const request = await h.next(39000);
  expect(request.filters[0]?.since).toBeDefined();
  request.respond([
    metadata(relay, "extra-1", "extra-1", clock / 1000, [["public"]]),
    metadata(relay, "extra-2", "extra-2", clock / 1000, [["public"]]),
  ]);
  const full = await h.next(39000);
  expect(full.filters[0]?.since).toBeUndefined();
  full.respond([]);
  expect(await delta).toEqual({ channels: [], partial: false });
  expect(h.channels.openDirectory?.()).toEqual([]);
});

it("finds public channels by the joined-channel name rule, not only by substring", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `11000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string) =>
    metadata(relay, id(n), name, 1_700_000_000, [["public"], ["t", "stream"]]);
  const page = [open(0, "buzz-community"), open(1, "release-notes")];
  const done = h.channels.searchPublic?.("buzz community");
  assert.exists(done);
  (await h.next(39000)).respond(page);
  const resolve = await h.next(39000);
  expect(resolve.filters[0]?.["#d"]).toEqual([id(0)]);
  resolve.respond(page.slice(0, 1));
  expect((await done)?.channels.map(({ name }) => name)).toEqual([
    "buzz-community",
  ]);
  expect(
    h.channels.matchPublic?.("buzz community").map(({ name }) => name),
  ).toEqual(["buzz-community"]);
  // An exact lookup still names one channel exactly.
  expect(h.channels.matchPublic?.("buzz community", { exact: true })).toEqual(
    [],
  );
  expect(h.pending).toHaveLength(0);
});

it("orders public matches by the shared ranks, best first", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `12000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string) =>
    metadata(relay, id(n), name, 1_700_000_000, [["public"], ["t", "stream"]]);
  const page = [
    open(0, "lobster-cat"),
    open(1, "buzz-community"),
    open(2, "abc-x"),
    open(3, "bc-thing"),
    open(4, "release-notes"),
  ];
  const done = h.channels.searchPublic?.("bc");
  assert.exists(done);
  (await h.next(39000)).respond(page);
  const resolve = await h.next(39000);
  const ids = resolve.filters[0]?.["#d"] ?? [];
  resolve.respond(page.filter((event) => ids.includes(tag(event, "d") ?? "")));
  // Prefix, substring, word runs, then letters merely in order.
  const order = ["bc-thing", "abc-x", "buzz-community", "lobster-cat"];
  expect((await done)?.channels.map(({ name }) => name)).toEqual(order);
  expect(h.channels.matchPublic?.("bc").map(({ name }) => name)).toEqual(order);
  expect(h.pending).toHaveLength(0);
});

it("reads the open directory for browsing with descriptions, sharing the search read", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `13000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const page = [
    metadata(relay, id(0), "design", 1_700_000_000, [
      ["public"],
      ["t", "stream"],
      ["about", "Critiques and crits"],
    ]),
    metadata(relay, id(1), "ops", 1_700_000_000, [["public"], ["t", "stream"]]),
  ];
  // A caller that stops waiting leaves the read for the next one.
  const gaveUp = new AbortController();
  const abandoned = h.channels.readDirectory?.({ signal: gaveUp.signal });
  assert.exists(abandoned);
  const request = await h.next(39000);
  gaveUp.abort();
  await expect(abandoned).rejects.toThrow();
  const done = h.channels.readDirectory?.();
  // A search while it runs joins the same read.
  const search = h.channels.searchPublic?.("zzz");
  request.respond(page);
  expect(await done).toEqual({ partial: false });
  expect(await search).toEqual({ channels: [], partial: false });
  expect(h.channels.openDirectory?.()).toEqual([
    {
      id: id(0),
      name: "design",
      description: "Critiques and crits",
      channelType: "stream",
    },
    { id: id(1), name: "ops", channelType: "stream" },
  ]);
  // Within the reuse window, browsing again reads nothing.
  expect(await h.channels.readDirectory?.()).toEqual({ partial: false });
  expect(h.pending).toHaveLength(0);
});

it("shows a first directory read's pages to browsing only, and names them for references once it finishes", async () => {
  const h = setup({ publicDirectoryPage: 2, maxPublicDirectory: 10 });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `13100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, at: number) =>
    metadata(relay, id(n), `open-${n}`, at, [["public"], ["t", "stream"]]);
  const list = vi.fn();
  const pages = vi.fn();
  const offList = h.channels.subscribeList(list);
  const offPages = h.channels.subscribeDirectory?.(pages);
  try {
    const done = h.channels.readDirectory?.();
    (await h.next(39000)).respond([
      open(0, 1_700_000_003),
      open(1, 1_700_000_002),
    ]);
    await vi.waitFor(() => expect(pages).toHaveBeenCalledTimes(1));
    // Browsing has the first page; references and the list hear nothing yet.
    expect(h.channels.browseDirectory?.()).toEqual([
      { id: id(0), name: "open-0", channelType: "stream" },
      { id: id(1), name: "open-1", channelType: "stream" },
    ]);
    expect(h.channels.openDirectory?.()).toEqual([]);
    expect(list).not.toHaveBeenCalled();
    (await h.next(39000)).respond([open(2, 1_700_000_001)]);
    expect(await done).toEqual({ partial: false });
    expect(list).toHaveBeenCalledTimes(1);
    expect(pages).toHaveBeenCalledTimes(2);
    const names = ["open-0", "open-1", "open-2"];
    expect(h.channels.openDirectory?.().map(({ name }) => name)).toEqual(names);
    expect(h.channels.browseDirectory?.().map(({ name }) => name)).toEqual(
      names,
    );
  } finally {
    offList();
    offPages?.();
  }
});

it("names the completed public directory's open channels for references, without reading", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (
    n: number,
    name: string,
    extra: string[][] = [],
    at = 1_700_000_000,
  ) =>
    metadata(relay, id(n), name, at, [["public"], ["t", "stream"], ...extra]);
  const page = [
    open(0, "release-notes", [], 1_700_000_100),
    open(1, "retired", [["archived", "true"]]),
    metadata(relay, id(2), "members-only", 1_700_000_000, [["private"]]),
    // The first channel's older name, after its rename: the newest wins.
    open(0, "notes"),
  ];
  const listChanged = vi.fn();
  h.channels.subscribeList(listChanged);
  expect(h.channels.openDirectory?.()).toEqual([]);
  const search = h.channels.searchPublic?.("zzz");
  assert.exists(search);
  // In flight: nothing is named yet.
  expect(h.channels.openDirectory?.()).toEqual([]);
  (await h.next(39000)).respond(page);
  expect(await search).toEqual({ channels: [], partial: false });
  await vi.waitFor(() => expect(listChanged).toHaveBeenCalled());
  const named = h.channels.openDirectory?.();
  expect(named).toEqual([
    { id: id(0), name: "release-notes", channelType: "stream" },
    { id: id(1), name: "retired", channelType: "stream", archived: true },
  ]);
  // The same array until a later read replaces it, so rows stay retained.
  expect(h.channels.openDirectory?.()).toBe(named);
  expect(h.pending).toHaveLength(0);
  await h.clearCache();
  expect(h.channels.openDirectory?.()).toEqual([]);
});

it("keeps the prior directory's names while a refresh reads, and when the refresh fails", async () => {
  let clock = 1_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string) =>
    metadata(relay, id(n), name, 1_700_000_000, [["public"], ["t", "stream"]]);
  const summary = (n: number, name: string) => ({
    id: id(n),
    name,
    channelType: "stream",
  });
  // A query nothing matches, so the directory read is the only request.
  const read = async () => {
    const search = h.channels.searchPublic?.("zzz");
    assert.exists(search);
    return { search, page: await h.next(39000) };
  };
  const first = await read();
  first.page.respond([open(0, "release-notes")]);
  await first.search;
  const named = h.channels.openDirectory?.();
  expect(named).toEqual([summary(0, "release-notes")]);
  // Past the reuse window the next keystroke reads again; the prior names
  // hold, by identity, until the new read completes.
  clock += 30_000;
  const second = await read();
  expect(h.channels.openDirectory?.()).toBe(named);
  second.page.respond([open(0, "release-notes"), open(1, "ops")]);
  await second.search;
  const grown = h.channels.openDirectory?.();
  expect(grown).toEqual([summary(0, "release-notes"), summary(1, "ops")]);
  // A failed refresh keeps the names that were valid a moment ago...
  clock += 30_000;
  const third = await read();
  expect(h.channels.openDirectory?.()).toBe(grown);
  third.page.fail(new Error("relay unavailable"));
  await expect(third.search).rejects.toThrow("relay unavailable");
  expect(h.channels.openDirectory?.()).toBe(grown);
  // ...and is not reused: the next keystroke reads again.
  clock += 5 * 60_000;
  const fourth = await read();
  expect(fourth.page.filters).toEqual([
    { kinds: [39000], authors: [relay.pubkey], limit: 500 },
  ]);
  fourth.page.respond([]);
  await fourth.search;
  expect(h.channels.openDirectory?.()).toEqual([]);
  expect(h.pending).toHaveLength(0);
});

it("reads every public metadata page, and a keystroke that gives up leaves the read for the next", async () => {
  let clock = 1_000_000;
  const h = setup({ now: () => clock });
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const id = (n: number) =>
    `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string, at: number) =>
    metadata(relay, id(n), name, at, [["public"], ["t", "stream"]]);
  // A full first page of newer channels, as the relay orders it.
  const recent = Array.from({ length: 500 }, (_, n) =>
    open(n, `recent-${n}`, 1_700_000_100),
  ).sort((a, b) => a.id.localeCompare(b.id));
  const older = open(500, "buzz-community", 1_700_000_000);
  const gaveUp = new AbortController();
  const first = h.channels.searchPublic?.("buzz-c", { signal: gaveUp.signal });
  assert.exists(first);
  const page = await h.next(39000);
  expect(page.filters).toEqual([
    { kinds: [39000], authors: [relay.pubkey], limit: 500 },
  ]);
  gaveUp.abort();
  await expect(first).rejects.toThrow();
  expect(page.signal?.aborted).toBe(false);
  // A read still running is reused however long it takes.
  clock += 60_000;
  const second = h.channels.searchPublic?.("buzz-com");
  assert.exists(second);
  page.respond(recent);
  const last = recent.at(-1);
  assert.exists(last);
  const next = await h.next(39000);
  expect(next.filters).toEqual([
    {
      kinds: [39000],
      authors: [relay.pubkey],
      limit: 500,
      until: last.created_at,
      before_id: last.id,
    },
  ]);
  next.respond([older]);
  const resolve = await h.next(39000);
  expect(resolve.filters[0]?.["#d"]).toEqual([id(500)]);
  resolve.respond([older]);
  const result = await second;
  expect(result.channels.map((channel) => channel.name)).toEqual([
    "buzz-community",
  ]);
  expect(result.partial).toBe(false);
  expect(h.pending).toHaveLength(0);
});

/** Two full open-channel directory pages: `nsec-backup-ux` leads the newer
 * one and the better-named `nsec-backup-older` the older. Directory pages and
 * match resolutions run side by side, so `take` picks a read by its `#d`. */
function openDirectory(h: ReturnType<typeof setup>) {
  const id = (n: number) =>
    `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const open = (n: number, name: string, at: number) =>
    metadata(relay, id(n), name, at, [["public"], ["t", "stream"]]);
  const filler = (from: number, at: number) =>
    Array.from({ length: 499 }, (_, n) =>
      open(from + n, `recent-${from + n}`, at),
    );
  const first = [
    open(0, "nsec-backup-ux", 1_700_000_200),
    ...filler(1, 1_700_000_200),
  ];
  const second = [
    open(500, "nsec-backup-older", 1_700_000_100),
    ...filler(501, 1_700_000_100),
  ];
  const all = [...first, ...second];
  const take = async (ids?: readonly string[]) => {
    let found: (typeof h.pending)[number] | undefined;
    await vi.waitFor(() => {
      found = h.pending.find(
        (request) =>
          JSON.stringify([...(request.filters[0]?.["#d"] ?? [])].sort()) ===
          JSON.stringify([...(ids ?? [])].sort()),
      );
      expect(found).toBeDefined();
    });
    assert.exists(found);
    h.pending.splice(h.pending.indexOf(found), 1);
    expect(found.filters[0]?.kinds).toEqual([39000]);
    return found;
  };
  const resolves = async (ids: readonly string[]) => {
    const request = await take(ids);
    request.respond(all.filter((event) => ids.includes(tag(event, "d") ?? "")));
  };
  const names = ({ channels }: { channels: readonly ChannelSummary[] }) =>
    channels.map((channel) => channel.name);
  return { id, first, second, take, resolves, names };
}

it("reports landed public pages' matches while the read goes on, to a search that joins it too", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const { id, first, second, take, resolves, names } = openDirectory(h);
  const typed: string[][] = [];
  const joined: string[][] = [];
  // One channel each: matches on pages in flight resolve within that budget.
  const done = h.channels.searchPublic?.("nsec-backup", {
    limit: 1,
    progress: (found) => typed.push(names(found)),
  });
  assert.exists(done);
  (await take()).respond(first);
  await resolves([id(0)]);
  await vi.waitFor(() => expect(typed).toEqual([["nsec-backup-ux"]]));
  // A keystroke that narrows the query keeps the row while the read goes on.
  expect(
    h.channels.matchPublic?.("nsec-backup-u").map((channel) => channel.name),
  ).toEqual(["nsec-backup-ux"]);
  // A later keystroke reuses the read and ranks its landed page at once.
  const later = h.channels.searchPublic?.("nsec-backup", {
    progress: (found) => joined.push(names(found)),
  });
  assert.exists(later);
  await resolves([id(0)]);
  await vi.waitFor(() => expect(joined).toEqual([["nsec-backup-ux"]]));
  (await take()).respond(second);
  // A better match past the budget waits for the final answer, which
  // re-reads every match it returns; until then the shown row stays.
  await resolves([id(500)]);
  await vi.waitFor(() =>
    expect(typed).toEqual([["nsec-backup-ux"], ["nsec-backup-ux"]]),
  );
  await vi.waitFor(() => expect(joined).toHaveLength(2));
  (await take()).respond([]);
  await resolves([id(500)]);
  await resolves([id(500), id(0)]);
  expect(names(await done)).toEqual(["nsec-backup-older"]);
  expect(names(await later)).toEqual(["nsec-backup-older", "nsec-backup-ux"]);
  expect(joined[1]).toEqual(["nsec-backup-older", "nsec-backup-ux"]);
  expect(h.pending).toHaveLength(0);
});

function retainedDiscoveryBytes(count: number) {
  return memberships.slice(0, count).reduce((bytes, event) => {
    const id = tag(event, "d");
    assert.exists(id);
    return bytes + byteSize(event) + byteSize(named(id));
  }, 0);
}

it("leaves a nearly full discovery room for the final public search answer", async () => {
  const h = setup({ maxDiscoveryBytes: retainedDiscoveryBytes(1023) + 512 });
  h.channels.ensureList();
  await h.rosters(1023);
  await h.metadata(1023);
  const { id, first, second, take, resolves, names } = openDirectory(h);
  const typed: string[][] = [];
  const done = h.channels.searchPublic?.("nsec-backup", {
    limit: 1,
    progress: (found) => typed.push(names(found)),
  });
  assert.exists(done);
  // The remaining bytes fit one final metadata record. Provisional records
  // cannot consume the budget for a better match on the next page.
  (await take()).respond(first);
  await vi.waitFor(() => expect(typed).toEqual([[]]));
  (await take()).respond(second);
  await vi.waitFor(() => expect(typed).toEqual([[], []]));
  (await take()).respond([]);
  await resolves([id(500)]);
  expect(names(await done)).toEqual(["nsec-backup-older"]);
  expect(h.pending).toHaveLength(0);
});

it("leaves room for the final answers of public searches that run side by side", async () => {
  const h = setup({ maxDiscoveryBytes: retainedDiscoveryBytes(1022) + 1024 });
  h.channels.ensureList();
  await h.rosters(1022);
  await h.metadata(1022);
  const { id, first, second, take, resolves, names } = openDirectory(h);
  const typed: string[][] = [];
  // Cmd-K's `in:recent-1 nsec-backup`: an exact lookup and a substring search
  // share the read, and each final answer needs its metadata byte budget.
  const found = h.channels.searchPublic?.("nsec-backup", {
    limit: 1,
    progress: (found) => typed.push(names(found)),
  });
  const scoped = h.channels.searchPublic?.("recent-1", {
    exact: true,
    limit: 1,
  });
  assert.exists(found);
  assert.exists(scoped);
  // Provisional metadata cannot consume the bytes for either final answer.
  (await take()).respond(first);
  await vi.waitFor(() => expect(typed).toEqual([[]]));
  (await take()).respond(second);
  await vi.waitFor(() => expect(typed).toEqual([[], []]));
  (await take()).respond([]);
  await resolves([id(500)]);
  await resolves([id(1)]);
  expect(names(await found)).toEqual(["nsec-backup-older"]);
  expect(names(await scoped)).toEqual(["recent-1"]);
  expect(h.pending).toHaveLength(0);
});

it("leaves room for the final answer of a public search that joins after a page lands", async () => {
  const h = setup({ maxDiscoveryBytes: retainedDiscoveryBytes(1022) + 1024 });
  h.channels.ensureList();
  await h.rosters(1022);
  await h.metadata(1022);
  const { id, first, second, take, resolves, names } = openDirectory(h);
  const typed: string[][] = [];
  const found = h.channels.searchPublic?.("nsec-backup", {
    limit: 1,
    progress: (found) => typed.push(names(found)),
  });
  assert.exists(found);
  // The byte budget stays available for this final answer and for an
  // exact lookup that can join the read later.
  (await take()).respond(first);
  await vi.waitFor(() => expect(typed).toEqual([[]]));
  // Editing `nsec-backup` to `in:recent-1 nsec-backup` starts only the lookup.
  const scoped = h.channels.searchPublic?.("recent-1", {
    exact: true,
    limit: 1,
  });
  assert.exists(scoped);
  (await take()).respond(second);
  await vi.waitFor(() => expect(typed).toEqual([[], []]));
  (await take()).respond([]);
  await resolves([id(500)]);
  await resolves([id(1)]);
  expect(names(await found)).toEqual(["nsec-backup-older"]);
  expect(names(await scoped)).toEqual(["recent-1"]);
  expect(h.pending).toHaveLength(0);
});

it("stops a public search between pages when its caller gives up", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const page = Array.from({ length: 500 }, (_, n) =>
    metadata(
      relay,
      `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      `recent-${n}`,
      1_700_000_000,
      [["public"], ["t", "stream"]],
    ),
  );
  const progress = vi.fn();
  const gaveUp = new AbortController();
  const done = h.channels.searchPublic?.("nsec", {
    signal: gaveUp.signal,
    progress,
  });
  assert.exists(done);
  (await h.next(39000)).respond(page);
  await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
  gaveUp.abort();
  await expect(done).rejects.toThrow();
  // The shared read goes on for the next keystroke.
  const next = await h.next(39000);
  expect(next.signal?.aborted).toBe(false);
  next.respond([]);
  await flush();
  expect(progress).toHaveBeenCalledOnce();
  expect(h.pending).toHaveLength(0);
});

it("refuses a label lookup without sending it when the relay does not advertise NIP-CL", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const sent = h.pending.length;
  await expect(
    h.channels.findLabeled?.({ creator: keypair().pubkey, label: "for-you" }),
  ).rejects.toThrow(/does not support channel labels/);
  expect(h.pending.length).toBe(sent);
});

it("finds one creator's labeled channels oldest first and admits only relay-proven matches", async () => {
  const h = setup({}, { channelIdentity: true });
  h.channels.ensureList();
  // A NIP-CL pass reads the viewer's system channels first.
  (await h.next(39002)).respond([]);
  await h.rosters(0);
  await h.settled();
  const creator = keypair().pubkey;
  const id = (n: number) =>
    `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const labeled = (
    n: number,
    extra: readonly string[][],
    author: typeof relay = relay,
  ) =>
    metadata(author, id(n), `labeled ${n}`, 1_700_000_000, [
      ["public"],
      ["t", "stream"],
      ...extra,
    ]);
  const page = [
    labeled(1, [
      ["t", "for-you"],
      ["P", creator],
      ["created_at", "200"],
    ]),
    labeled(2, [
      ["t", "for-you"],
      ["P", creator],
      ["created_at", "100"],
    ]),
    // No creation time ranks last; the relay returned it, so it still counts.
    labeled(3, [
      ["t", "for-you"],
      ["P", creator],
    ]),
    // Same creation time breaks the tie by channel ID.
    labeled(0, [
      ["t", "for-you"],
      ["P", creator],
      ["created_at", "200"],
    ]),
    // The relay's answer is checked: wrong creator, a type that only looks
    // like the label, and metadata signed by someone else are all dropped.
    labeled(4, [
      ["t", "for-you"],
      ["P", keypair().pubkey],
    ]),
    metadata(relay, id(5), "typed", 1_700_000_000, [
      ["public"],
      ["t", "for-you"],
      ["P", creator],
    ]),
    labeled(
      6,
      [
        ["t", "for-you"],
        ["P", creator],
      ],
      keypair(),
    ),
  ];
  const done = h.channels.findLabeled?.({ creator, label: "for-you" });
  assert.exists(done);
  const request = await h.next(39000);
  expect(request.filters).toEqual([
    {
      kinds: [39000],
      authors: [relay.pubkey],
      "#P": [creator],
      "#t": ["for-you"],
      limit: 100,
    },
  ]);
  request.respond(page);
  const resolve = await h.next(39000);
  const ids = resolve.filters[0]?.["#d"] ?? [];
  expect([...ids].sort()).toEqual([id(0), id(1), id(2), id(3)]);
  resolve.respond(page.filter((event) => ids.includes(tag(event, "d") ?? "")));
  const found = await done;
  expect(found.map((channel) => channel.id)).toEqual([
    id(2),
    id(0),
    id(1),
    id(3),
  ]);
  expect(found[0]).toMatchObject({
    labels: ["for-you"],
    creator,
    createdAt: 100,
  });
  expect(h.channels.get?.(id(2))?.labels).toEqual(["for-you"]);
  // Lookup admits channels for reading; it never adds them to the sidebar.
  const listed = h.channels.list();
  expect(
    listed.status === "ready" &&
      listed.channels.some((channel) => ids.includes(channel.id)),
  ).toBe(false);
  await expect(
    h.channels.findLabeled?.({ creator, label: "System" }),
  ).rejects.toThrow(/channel labels/);
  await expect(
    h.channels.findLabeled?.({ creator: "nope", label: "for-you" }),
  ).rejects.toThrow(/creator/);
});

it("finds a labeled system channel whose roster arrived before its metadata", async () => {
  const h = setup({}, { channelIdentity: true });
  h.channels.ensureList();
  const creator = keypair().pubkey;
  const id = "30000000-0000-4000-8000-000000000001";
  // The full pass reads the viewer's system rosters first, then names later.
  (await h.next(39002)).respond([
    signed(relay, {
      kind: 39002,
      content: "",
      tags: [
        ["d", id],
        ["t", "system"],
        ["p", viewer.pubkey],
      ],
    }),
  ]);
  await h.rosters(0);
  const names = await h.next(39000);
  expect(names.filters[0]?.["#d"]).toEqual([id]);
  // The roster alone admits the channel, so it already reads as system.
  expect(h.channels.get?.(id)?.channelType).toBe("system");
  const labeled = metadata(relay, id, "Records", 1_700_000_000, [
    ["private"],
    ["hidden"],
    ["t", "system"],
    ["t", "for-you"],
    ["P", creator],
  ]);
  const done = h.channels.findLabeled?.({ creator, label: "for-you" });
  assert.exists(done);
  const lookup = await h.next(39000);
  expect(lookup.filters[0]?.["#P"]).toEqual([creator]);
  lookup.respond([labeled]);
  // Answer an exact confirmation if the lookup sends one.
  const found = await Promise.race([
    done,
    h.next(39000).then((exact) => {
      exact.respond([labeled]);
      return done;
    }),
  ]);
  names.respond([labeled]);
  expect(found.map((channel) => channel.id)).toEqual([id]);
});

it("counts members in small side-by-side reads, keeping each read's answers when another fails", async () => {
  const h = setup();
  h.channels.ensureList();
  await h.rosters(0);
  await h.settled();
  const ids = Array.from(
    { length: 12 },
    (_, n) => `13200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  );
  const counted = h.channels.readMemberCounts?.(ids);
  const first = await h.next(39002);
  const second = await h.next(39002);
  // Ten rosters at most per read, and the second doesn't wait for the first.
  expect(first.filters[0]?.["#d"]).toEqual(ids.slice(0, 10));
  expect(second.filters[0]?.["#d"]).toEqual(ids.slice(10));
  second.fail(new Error("Relay response too large"));
  first.respond([roster(relay, ids[0] ?? "", [viewer.pubkey, relay.pubkey])]);
  const result = await counted;
  expect(result?.counts).toEqual(new Map([[ids[0], 2]]));
  expect(result?.failed).toEqual(ids.slice(10));
  // The answered count is kept; only the failed ids read again.
  const again = h.channels.readMemberCounts?.([ids[0] ?? "", ...ids.slice(10)]);
  const retry = await h.next(39002);
  expect(retry.filters[0]?.["#d"]).toEqual(ids.slice(10));
  retry.respond([]);
  expect((await again)?.counts).toEqual(new Map([[ids[0], 2]]));
  expect(h.pending).toHaveLength(0);
});

it("accepts only a directory page size that divides its budget", () => {
  for (const options of [
    { publicDirectoryPage: 0 },
    { publicDirectoryPage: 501 },
    { publicDirectoryPage: 2.5 },
    { publicDirectoryPage: 300, maxPublicDirectory: 1000 },
  ])
    expect(() => createRelaySession(null, options)).toThrow(
      "Invalid public directory capacity",
    );
  createRelaySession(null, {
    publicDirectoryPage: 10,
    maxPublicDirectory: 20,
  }).dispose();
});
