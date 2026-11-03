import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { finalizeEvent, nip44 } from "nostr-tools";
import { connectNativeTransport } from "./native";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { keypair, nativeSignatureChecks } from "./testing";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair();
const relay = keypair();
const community = "https://packaged.test";
const signal = new AbortController().signal;
const key = nip44.v2.utils.getConversationKey(viewer.secret, viewer.pubkey);
const records = new Map<string, ReturnType<typeof finalizeEvent>>();
const defaultValue = (coordinate: string) =>
  coordinate === "channel-sections"
    ? { version: 1, sections: [], assignments: {} }
    : coordinate === "channel-sort" || coordinate === "channel-filter"
      ? { version: 1, groups: {} }
      : { version: 1, channels: {} };
function signedRecord(
  coordinate: string,
  value: unknown,
  created_at = 1_700_000_000,
) {
  return finalizeEvent(
    {
      kind: 30078,
      created_at,
      tags: [
        ["d", coordinate],
        ["t", coordinate],
      ],
      content: nip44.v2.encrypt(JSON.stringify(value), key),
    },
    viewer.secret,
  );
}
function decode(events: ReturnType<typeof finalizeEvent>[]) {
  const result: Record<string, unknown> = {};
  const seen = new Set<string>();
  for (const event of events) {
    const coordinate = event.tags.find(([name]) => name === "d")?.[1];
    if (
      event.kind !== 30078 ||
      event.pubkey !== viewer.pubkey ||
      !coordinate ||
      seen.has(coordinate) ||
      ![
        "channel-sections",
        "channel-stars",
        "channel-mutes",
        "channel-sort",
        "channel-filter",
        "main-agent",
      ].includes(coordinate)
    )
      throw new Error("Invalid sidebar record");
    seen.add(coordinate);
    result[coordinate] = JSON.parse(nip44.v2.decrypt(event.content, key));
  }
  return result;
}
beforeEach(() => {
  records.clear();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "identity_restore") return viewer.pubkey;
      if (command === "relay_verify_signatures")
        return nativeSignatureChecks(args);
      if (command === "relay_sign")
        return finalizeEvent(
          (args as { event: Parameters<typeof finalizeEvent>[0] }).event,
          viewer.secret,
        );
      if (command === "relay_decode_sidebar")
        return decode(
          (args as { events: ReturnType<typeof finalizeEvent>[] }).events,
        );
      if (command === "relay_sign_sidebar") {
        const { coordinate, payload, createdAt } = args as {
          coordinate: string;
          payload: unknown;
          createdAt: number;
        };
        return signedRecord(coordinate, payload, createdAt);
      }
      if (command === "relay_http") {
        const request = args as { path: string; body: string | null };
        if (request.path === "/")
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ self: relay.pubkey }),
          };
        if (request.path === "/query") {
          const filters = JSON.parse(request.body ?? "[]") as {
            "#d": string[];
            consistency?: string;
          }[];
          expect(
            filters.every(
              (filter) =>
                filter.consistency === "strong" ||
                filter.consistency === undefined,
            ),
          ).toBe(true);
          const events = filters.flatMap((filter) =>
            filter["#d"].flatMap((coordinate) =>
              records.has(coordinate) ? [records.get(coordinate)] : [],
            ),
          );
          return { status: 200, headers: {}, body: JSON.stringify(events) };
        }
        if (request.path === "/events") {
          const event = JSON.parse(request.body ?? "null") as ReturnType<
            typeof finalizeEvent
          >;
          const coordinate = event.tags[0]?.[1] ?? "";
          records.set(coordinate, event);
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              accepted: true,
              event_id: event.id,
              message: "",
            }),
          };
        }
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
});

it("decodes four self-encrypted coordinates through the narrow IPC command", async () => {
  for (const coordinate of [
    "channel-sections",
    "channel-stars",
    "channel-mutes",
    "channel-sort",
  ])
    records.set(coordinate, signedRecord(coordinate, defaultValue(coordinate)));
  const transport = await connectNativeTransport(community);
  const result = await transport.decodeSidebarPreferences?.(
    [...records.values()],
    signal,
  );
  expect(result).toMatchObject({
    sections: [],
    starred: [],
    muted: [],
    sort: {},
  });
  expect(invoke).toHaveBeenCalledWith("relay_decode_sidebar", {
    events: [...records.values()],
  });
  // Main also grants purpose-bound channel recipes (kind 30078); sidebar writes stay on narrow IPC.
  expect(transport.writer?.kinds).toContain(30078);
});

it("clears a deleted agent from an account with no record without writing one", async () => {
  const transport = await connectNativeTransport(community);
  expect(
    await transport.clearMainAgent?.("a".repeat(64), signal),
  ).toBeUndefined();
  // Still no record: never choosing a Bestie isn't saving none.
  expect(await transport.readMainAgent?.(signal)).toBeUndefined();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
});

it("leaves a saved none alone when clearing a deleted agent", async () => {
  const transport = await connectNativeTransport(community);
  await transport.writeMainAgent?.(null, signal);
  const signed = () =>
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar")
      .length;
  const before = signed();
  expect(
    await transport.clearMainAgent?.("a".repeat(64), signal),
  ).toBeUndefined();
  expect(signed()).toBe(before);
  expect(await transport.readMainAgent?.(signal)).toBeNull();
});

it("saves and reads back the account's main agent", async () => {
  const transport = await connectNativeTransport(community);
  expect(await transport.readMainAgent?.(signal)).toBeUndefined();
  await transport.writeMainAgent?.("a".repeat(64), signal);
  expect(await transport.readMainAgent?.(signal)).toBe("a".repeat(64));
  const signedBeforeMismatch = vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "relay_sign_sidebar").length;
  expect(await transport.clearMainAgent?.("b".repeat(64), signal)).toBe(
    "a".repeat(64),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar"),
  ).toHaveLength(signedBeforeMismatch);
  expect(await transport.readMainAgent?.(signal)).toBe("a".repeat(64));
  expect(
    await transport.clearMainAgent?.("a".repeat(64), signal),
  ).toBeUndefined();
  // A cleared choice leaves a record of none, read as null.
  expect(await transport.readMainAgent?.(signal)).toBeNull();
  await transport.writeMainAgent?.("a".repeat(64), signal);
  await transport.writeMainAgent?.(null, signal);
  expect(await transport.readMainAgent?.(signal)).toBeNull();
  expect(invoke).toHaveBeenCalledWith(
    "relay_sign_sidebar",
    expect.objectContaining({ payload: { version: 1, agent: null } }),
  );
  await expect(
    transport.writeMainAgent?.("A".repeat(64), signal),
  ).rejects.toThrow("Invalid main agent intent");
  records.set("main-agent", signedRecord("main-agent", { version: 2 }));
  await expect(transport.readMainAgent?.(signal)).rejects.toThrow(
    "Invalid main agent record",
  );
});

it("reads a main agent record of none as null, and replaces it", async () => {
  const transport = await connectNativeTransport(community);
  records.set(
    "main-agent",
    signedRecord("main-agent", { version: 1, agent: null }),
  );
  expect(await transport.readMainAgent?.(signal)).toBeNull();
  await transport.writeMainAgent?.("b".repeat(64), signal);
  expect(await transport.readMainAgent?.(signal)).toBe("b".repeat(64));
});

it("saves none as the account's main agent, and reads it back as none, not as no record", async () => {
  const transport = await connectNativeTransport(community);
  // Never saved: no record.
  expect(await transport.readMainAgent?.(signal)).toBeUndefined();
  await transport.writeMainAgent?.("a".repeat(64), signal);
  await transport.writeMainAgent?.(null, signal);
  expect(await transport.readMainAgent?.(signal)).toBeNull();
  await transport.writeMainAgent?.("b".repeat(64), signal);
  expect(await transport.readMainAgent?.(signal)).toBe("b".repeat(64));
});

it("saves none on an account with no record, so it reads back as none", async () => {
  const transport = await connectNativeTransport(community);
  expect(await transport.readMainAgent?.(signal)).toBeUndefined();
  await transport.writeMainAgent?.(null, signal);
  expect(await transport.readMainAgent?.(signal)).toBeNull();
});

it("prepends a drag-created section through native encrypted readback", async () => {
  const transport = await connectNativeTransport(community);
  const existing = "11111111-1111-1111-1111-111111111111";
  const id = "22222222-2222-2222-2222-222222222222";
  await transport.writeSidebarAssignment?.(
    { channelId: "c1", createSection: { id: existing, name: "Work" } },
    signal,
  );
  const groups = await transport.writeSidebarAssignment?.(
    {
      channelId: "c1",
      createSection: { id, name: "Launch", position: "first" },
    },
    signal,
  );
  expect(groups?.sections.map(({ id }) => id)).toEqual([id, existing]);
  expect(groups?.assignments).toEqual({ c1: id });
});

it("creates a section, moves a channel, stars, mutes and sorts with encrypted readback", async () => {
  const transport = await connectNativeTransport(community);
  const id = "12345678-1234-1234-1234-123456789abc";
  const groups = await transport.writeSidebarAssignment?.(
    { channelId: "c1", createSection: { id, name: "Work" } },
    signal,
  );
  expect(groups?.assignments).toEqual({ c1: id });
  expect(groups?.sections).toEqual([{ id, name: "Work", order: 0 }]);
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: true },
      signal,
    ),
  ).toEqual(["c1"]);
  expect(
    await transport.writeSidebarMute?.(
      { channelId: "c1", muted: true },
      signal,
    ),
  ).toEqual(["c1"]);
  expect(
    await transport.writeSidebarSort?.(`section:${id}`, "recent", [id], signal),
  ).toEqual({ [`section:${id}`]: "recent" });
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: false },
      signal,
    ),
  ).toEqual([]);
  expect(
    await transport.writeSidebarMute?.(
      { channelId: "c1", muted: false },
      signal,
    ),
  ).toEqual([]);
  const starRecord = records.get("channel-stars");
  expect(starRecord).toBeDefined();
  const star = decode(starRecord ? [starRecord] : [])["channel-stars"] as {
    channels: Record<string, { starred: boolean }>;
  };
  expect(star.channels.c1?.starred).toBe(false); // tombstone retained
  expect(
    await transport.writeSidebarSort?.(`section:${id}`, "alpha", [id], signal),
  ).toEqual({});
  expect(
    await transport.writeSidebarAssignment?.({ channelId: "c1" }, signal),
  ).toMatchObject({ assignments: {} });
  expect(records.size).toBe(4);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar"),
  ).toHaveLength(8);
});

it("does not report a competing write as saved", async () => {
  const transport = await connectNativeTransport(community);
  let queryCount = 0;
  const original = vi.mocked(invoke).getMockImplementation();
  expect(original).toBeDefined();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (
      command === "relay_http" &&
      (args as { path?: string }).path === "/query" &&
      ++queryCount === 2
    )
      records.set(
        "channel-stars",
        signedRecord(
          "channel-stars",
          { version: 1, channels: {} },
          1_700_000_011,
        ),
      );
    return original?.(command, args);
  });
  await expect(
    transport.writeSidebarStar?.({ channelId: "c1", starred: true }, signal),
  ).rejects.toThrow("Sidebar stars changed on another device");
});

it("fails closed on unreadable heads and never signs or publishes them", async () => {
  records.set(
    "channel-stars",
    signedRecord("channel-stars", { version: 2, channels: {} }),
  );
  const transport = await connectNativeTransport(community);
  await expect(
    transport.writeSidebarStar?.({ channelId: "c1", starred: true }, signal),
  ).rejects.toThrow("Unsupported sidebar stars");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
  expect(
    records.get("channel-stars") &&
      decode([
        records.get("channel-stars") as ReturnType<typeof finalizeEvent>,
      ])["channel-stars"],
  ).toMatchObject({ version: 2 });
});

it("does not sign a redundant intent or continue after cancellation", async () => {
  const transport = await connectNativeTransport(community);
  expect(
    await transport.writeSidebarStar?.(
      { channelId: "c1", starred: false },
      signal,
    ),
  ).toEqual([]);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.writeSidebarStar?.(
      { channelId: "c1", starred: true },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
});

it("native writers update authoritative registers and preserve unrelated tombstones", async () => {
  const stamp = (v: unknown) => [2_000_000_000_000, "1111111111111111", v];
  const meta = {
    v: 1,
    s: {
      work: { name: stamp("Work"), order: stamp(40), live: stamp(true) },
      deleted: { name: stamp("Deleted"), live: stamp(false) },
    },
    a: { c1: stamp("work"), old: stamp(null) },
  };
  records.set(
    "channel-sections",
    signedRecord("channel-sections", {
      version: 1,
      sections: [{ id: "wrong", name: "Stale", order: 0 }],
      assignments: {},
      meta,
    }),
  );
  records.set(
    "channel-sort",
    signedRecord("channel-sort", {
      version: 1,
      groups: {},
      meta: { v: 1, g: { channels: stamp("recent"), forums: stamp(null) } },
    }),
  );
  const transport = await connectNativeTransport(community);
  expect(
    await transport.writeSidebarAssignment?.(
      { channelId: "c2", sectionId: "work" },
      signal,
    ),
  ).toEqual({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { c1: "work", c2: "work" },
  });
  const saved = decode([...records.values()])["channel-sections"];
  expect(saved).toMatchObject({
    meta: {
      s: meta.s,
      a: {
        old: meta.a.old,
        c2: [
          2_000_000_000_001,
          expect.stringMatching(/^[0-9a-f]{16}$/),
          "work",
        ],
      },
    },
    sections: [{ id: "work", name: "Work", order: 0 }],
  });
  expect(
    await transport.writeSidebarSort?.("channels", "alpha", [], signal),
  ).toEqual({});
  const sort = decode([...records.values()])["channel-sort"];
  expect(sort).toEqual({
    version: 1,
    groups: {},
    meta: {
      v: 1,
      g: {
        channels: [
          2_000_000_000_001,
          expect.stringMatching(/^[0-9a-f]{16}$/),
          null,
        ],
        forums: stamp(null),
      },
    },
  });
});

it("reads all coordinates with oversized deleted-section text but refuses to rewrite it", async () => {
  const reg = (value: unknown) => [100, "1111111111111111", value];
  const sections = {
    version: 1,
    sections: [{ id: "stale", name: "Stale", order: 0 }],
    assignments: { c2: "stale" },
    meta: {
      v: 1,
      s: {
        work: { name: reg("Work"), order: reg(0), live: reg(true) },
        dead: {
          name: reg("x".repeat(257)),
          icon: reg("i".repeat(129)),
          live: reg(false),
        },
      },
      a: { c1: reg("work"), c2: reg("dead") },
    },
  };
  for (const [coordinate, value] of Object.entries({
    "channel-sections": sections,
    "channel-stars": {
      version: 1,
      channels: { c1: { starred: true, updatedAt: 1 } },
    },
    "channel-mutes": {
      version: 1,
      channels: { c2: { muted: true, updatedAt: 1 } },
    },
    "channel-sort": { version: 1, groups: { channels: "recent" } },
  }))
    records.set(coordinate, signedRecord(coordinate, value));
  const before = [...records.values()];
  const transport = await connectNativeTransport(community);
  expect(await transport.decodeSidebarPreferences?.(before, signal)).toEqual({
    sections: [{ id: "work", name: "Work", order: 0 }],
    assignments: { c1: "work" },
    starred: ["c1"],
    muted: ["c2"],
    sort: { channels: "recent" },
  });
  await expect(
    transport.writeSidebarAssignment?.(
      { channelId: "c3", sectionId: "work" },
      signal,
    ),
  ).rejects.toThrow("Invalid sidebar register");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(([command]) => command === "relay_sign_sidebar"),
  ).toBe(false);
  expect([...records.values()]).toEqual(before);
});

it.each([false, true])(
  "appends a native section after canonical imported orders (metadata=%s)",
  async (metadata) => {
    const reg = (value: unknown) => [100, "1111111111111111", value];
    records.set(
      "channel-sections",
      signedRecord("channel-sections", {
        version: 1,
        sections: [{ id: "work", name: "Work", order: 0.5 }],
        assignments: {},
        ...(metadata
          ? {
              meta: {
                v: 1,
                s: {
                  work: { name: reg("Work"), order: reg(40), live: reg(true) },
                },
                a: {},
              },
            }
          : {}),
      }),
    );
    const transport = await connectNativeTransport(community);
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(
      await transport.writeSidebarAssignment?.(
        { channelId: "c1", createSection: { id, name: "New" } },
        signal,
      ),
    ).toEqual({
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id, name: "New", order: 1 },
      ],
      assignments: { c1: id },
    });
    const saved = decode([...records.values()])["channel-sections"];
    expect(saved).toMatchObject({
      meta: {
        s: {
          work: {
            order: [expect.any(Number), expect.any(String), metadata ? 40 : 1],
          },
          [id]: {
            order: [expect.any(Number), expect.any(String), metadata ? 41 : 2],
          },
        },
      },
    });
  },
);

it.each([
  { assignment: undefined, oversized: false },
  { assignment: null, oversized: false },
  { assignment: "dead", oversized: false },
  { assignment: undefined, oversized: true },
  { assignment: null, oversized: true },
  { assignment: "dead", oversized: true },
])(
  "Unstar clears only stars when assignment is already clear: %j",
  async ({ assignment, oversized }) => {
    const reg = (value: unknown) => [100, "1111111111111111", value];
    const sections = signedRecord("channel-sections", {
      version: 1,
      sections: [{ id: "stale", name: "Stale", order: 0 }],
      assignments: { c1: "stale" },
      meta: {
        v: 1,
        s: {
          work: { name: reg("Work"), live: reg(true), order: reg(0) },
          dead: {
            name: reg(oversized ? "x".repeat(257) : "Deleted"),
            live: reg(false),
          },
        },
        a: {
          ...(assignment === undefined ? {} : { c1: reg(assignment) }),
          c2: reg("work"),
        },
      },
    });
    records.set("channel-sections", sections);
    records.set(
      "channel-stars",
      signedRecord("channel-stars", {
        version: 1,
        channels: {
          c1: { starred: true, updatedAt: 1 },
          c2: { starred: true, updatedAt: 1 },
        },
      }),
    );
    const transport = await connectNativeTransport(community);
    const owner = createSidebarPreferencesStore({
      read: async () => {
        const data = await transport.decodeSidebarPreferences?.(
          [...records.values()],
          signal,
        );
        if (!data) throw new Error("Sidebar decode unavailable");
        return data;
      },
      available: true,
      write: transport.writeSidebarAssignment,
      writeStar: transport.writeSidebarStar,
    });
    try {
      const preferences = owner.queries;
      await preferences.ensure();
      expect(preferences.snapshot().data?.starred).toEqual(["c1", "c2"]);
      await expect(preferences.setStar("c1", false)).resolves.toEqual(["c2"]);
      expect(preferences.snapshot().data).toMatchObject({
        starred: ["c2"],
        sections: [{ id: "work", name: "Work", order: 0 }],
        assignments: { c2: "work" },
      });
      expect(records.get("channel-sections")).toBe(sections);
      expect(decode([...records.values()])["channel-stars"]).toMatchObject({
        channels: { c1: { starred: false }, c2: { starred: true } },
      });
      const signing = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "relay_sign_sidebar");
      expect(signing).toEqual([
        [
          "relay_sign_sidebar",
          expect.objectContaining({ coordinate: "channel-stars" }),
        ],
      ]);
      const queries = vi
        .mocked(invoke)
        .mock.calls.filter(
          ([command, args]) =>
            command === "relay_http" &&
            (args as { path: string }).path === "/query",
        )
        .flatMap(([, args]) => JSON.parse((args as { body: string }).body));
      expect(queries).toContainEqual(
        expect.objectContaining({
          "#d": ["channel-sections"],
          consistency: "strong",
        }),
      );
    } finally {
      owner.dispose();
    }
  },
);

it("removes only the section register and preserves unrelated sections and channel records", async () => {
  const transport = await connectNativeTransport(community);
  const id = "12345678-1234-1234-1234-123456789abc";
  const other = "22345678-1234-1234-1234-123456789abc";
  await transport.writeSidebarAssignment?.(
    { channelId: "c1", createSection: { id, name: "Work" } },
    signal,
  );
  await transport.writeSidebarAssignment?.(
    { channelId: "c2", createSection: { id: other, name: "Other" } },
    signal,
  );
  const removed = await transport.removeSidebarSection?.(id, signal);
  expect(removed).toEqual({
    sections: [{ id: other, name: "Other", order: 0 }],
    assignments: { c2: other },
  });
  expect(await transport.removeSidebarSection?.(id, signal)).toEqual(removed);
  expect([...records.keys()].every((key) => key === "channel-sections")).toBe(
    true,
  );
});

it("rejects invalid sidebar intents before native reads or signing", async () => {
  const transport = await connectNativeTransport(community);
  vi.mocked(invoke).mockClear();
  for (const channelId of [" ", "x".repeat(257)]) {
    await expect(
      transport.writeSidebarStar?.({ channelId, starred: true }, signal),
    ).rejects.toThrow("Invalid sidebar star intent");
    await expect(
      transport.writeSidebarMute?.({ channelId, muted: true }, signal),
    ).rejects.toThrow("Invalid sidebar mute intent");
    await expect(
      transport.writeSidebarAssignment?.({ channelId }, signal),
    ).rejects.toThrow("Invalid sidebar assignment intent");
  }
  await expect(
    transport.writeSidebarAssignment?.(
      { channelId: "c", createSection: { id: "invalid", name: "Work" } },
      signal,
    ),
  ).rejects.toThrow("Invalid sidebar assignment intent");
  await expect(
    transport.writeSidebarSort?.("section:missing", "recent", [], signal),
  ).rejects.toThrow("Invalid sidebar sort intent");
  expect(invoke).not.toHaveBeenCalled();
});

it("removes a section through native signing and readback without touching other coordinates", async () => {
  records.set(
    "channel-sections",
    signedRecord("channel-sections", {
      version: 1,
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "later", name: "Later", order: 1 },
      ],
      assignments: { alpha: "work", beta: "later" },
      preserved: "value",
    }),
  );
  const stars = signedRecord("channel-stars", {
    version: 1,
    channels: { alpha: { starred: true, updatedAt: 1 } },
  });
  records.set("channel-stars", stars);
  const transport = await connectNativeTransport(community);
  if (!transport.removeSidebarSection)
    throw new Error("Missing removal writer");
  expect(await transport.removeSidebarSection("work", signal)).toEqual({
    sections: [{ id: "later", name: "Later", order: 0 }],
    assignments: { beta: "later" },
  });
  expect(records.get("channel-stars")).toBe(stars);
  const head = records.get("channel-sections");
  if (!head) throw new Error("Missing sections head");
  const saved = decode([head])["channel-sections"] as {
    meta: { s: { work: { live: unknown[] } }; a: { alpha: unknown[] } };
    preserved: string;
  };
  expect(saved.meta.s.work.live[2]).toBe(false);
  expect(saved.meta.a.alpha[2]).toBeNull();
  expect(saved.preserved).toBe("value");
});

it("reorders sections through native signing and readback, never rewriting a satisfied order", async () => {
  records.set(
    "channel-sections",
    signedRecord("channel-sections", {
      version: 1,
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "later", name: "Later", order: 1 },
      ],
      assignments: { alpha: "work" },
      preserved: "value",
    }),
  );
  const transport = await connectNativeTransport(community);
  if (!transport.writeSidebarSectionOrder)
    throw new Error("Missing section order writer");
  await expect(
    transport.writeSidebarSectionOrder(["work", "work"], signal),
  ).rejects.toThrow("Invalid sidebar section order intent");
  expect(await transport.writeSidebarSectionOrder(["later"], signal)).toEqual({
    sections: [
      { id: "later", name: "Later", order: 0 },
      { id: "work", name: "Work", order: 1 },
    ],
    assignments: { alpha: "work" },
  });
  const head = records.get("channel-sections");
  if (!head) throw new Error("Missing sections head");
  expect(
    (decode([head])["channel-sections"] as { preserved: string }).preserved,
  ).toBe("value");
  vi.mocked(invoke).mockClear();
  await transport.writeSidebarSectionOrder(["later", "work"], signal);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar"),
  ).toEqual([]);
  expect(records.get("channel-sections")).toBe(head);
});

it("renames a section through native signing, preserving its order and assignments", async () => {
  records.set(
    "channel-sections",
    signedRecord("channel-sections", {
      version: 1,
      sections: [
        { id: "work", name: "Work", order: 0 },
        { id: "later", name: "Later", order: 1 },
      ],
      assignments: { alpha: "work" },
      preserved: "value",
    }),
  );
  const transport = await connectNativeTransport(community);
  if (!transport.renameSidebarSection)
    throw new Error("Missing section rename writer");
  await expect(
    transport.renameSidebarSection({ sectionId: "work", name: " " }, signal),
  ).rejects.toThrow("Invalid sidebar section rename intent");
  await expect(
    transport.renameSidebarSection({ sectionId: "gone", name: "X" }, signal),
  ).rejects.toThrow("no longer exists");
  expect(
    await transport.renameSidebarSection(
      { sectionId: "work", name: " Projects " },
      signal,
    ),
  ).toEqual({
    sections: [
      { id: "work", name: "Projects", order: 0 },
      { id: "later", name: "Later", order: 1 },
    ],
    assignments: { alpha: "work" },
  });
  const head = records.get("channel-sections");
  if (!head) throw new Error("Missing sections head");
  expect(
    (decode([head])["channel-sections"] as { preserved: string }).preserved,
  ).toBe("value");
  vi.mocked(invoke).mockClear();
  await transport.renameSidebarSection(
    { sectionId: "work", name: "Projects" },
    signal,
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "relay_sign_sidebar"),
  ).toEqual([]);
  expect(records.get("channel-sections")).toBe(head);
});

it("does not report a section order overwritten before readback as saved", async () => {
  const transport = await connectNativeTransport(community);
  await transport.writeSidebarAssignment?.(
    {
      channelId: "c1",
      createSection: { id: "11111111-1111-1111-1111-111111111111", name: "A" },
    },
    signal,
  );
  await transport.writeSidebarAssignment?.(
    {
      channelId: "c2",
      createSection: { id: "22222222-2222-2222-2222-222222222222", name: "B" },
    },
    signal,
  );
  const stale = records.get("channel-sections");
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original?.(command, args);
    // Another device restores the previous order right after this publication.
    if (
      command === "relay_http" &&
      (args as { path?: string }).path === "/events" &&
      stale
    )
      records.set("channel-sections", stale);
    return result;
  });
  await expect(
    transport.writeSidebarSectionOrder?.(
      [
        "22222222-2222-2222-2222-222222222222",
        "11111111-1111-1111-1111-111111111111",
      ],
      signal,
    ),
  ).rejects.toThrow("Sidebar groups changed on another device");
});

it.each([
  { live: ["c", "b", "a"], conflict: true },
  { live: ["b", "c", "a"], conflict: true },
  { live: ["b", "a", "c"], conflict: false },
  { live: ["b", "c"], conflict: false },
])(
  "confirms the full live order after concurrent changes: $live",
  async ({ live, conflict }) => {
    const sections = (ids: string[]) =>
      ids.map((id, order) => ({ id, name: id.toUpperCase(), order }));
    records.set(
      "channel-sections",
      signedRecord("channel-sections", {
        version: 1,
        sections: sections(["a", "b"]),
        assignments: {},
      }),
    );
    const transport = await connectNativeTransport(community);
    const original = vi.mocked(invoke).getMockImplementation();
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const result = await original?.(command, args);
      if (
        command === "relay_http" &&
        (args as { path?: string }).path === "/events"
      )
        records.set(
          "channel-sections",
          signedRecord("channel-sections", {
            version: 1,
            sections: sections(live),
            assignments: {},
          }),
        );
      return result;
    });
    if (!transport.writeSidebarSectionOrder)
      throw new Error("Missing section order writer");
    const write = transport.writeSidebarSectionOrder(["b", "a"], signal);
    if (conflict)
      await expect(write).rejects.toThrow(
        "Sidebar groups changed on another device",
      );
    else
      await expect(write).resolves.toEqual({
        sections: sections(live),
        assignments: {},
      });
  },
);

it.each(["channels", "section:work"])(
  "confirms native plugin sort choices for %s through encrypted readback",
  async (group) => {
    const transport = await connectNativeTransport(community);
    await transport.writeSidebarSort?.("forums", "recent", [], signal);
    for (const mode of [
      "plugin:example.plugin/rows/reverse",
      "plugin:example.plugin/rows/other",
      "recent",
      "alpha",
    ] as const) {
      await expect(
        transport.writeSidebarSort?.(group, mode, ["work"], signal),
      ).resolves.toEqual(
        mode === "alpha"
          ? { forums: "recent" }
          : { forums: "recent", [group]: mode },
      );
    }
  },
);

it("uses the native filter signer and confirmed writer without changing sort", async () => {
  const transport = await connectNativeTransport(community);
  await transport.writeSidebarSort?.("channels", "recent", [], signal);
  const sort = records.get("channel-sort");
  expect(
    await transport.writeSidebarFilter?.(
      "section:work",
      "unreads",
      ["work"],
      signal,
    ),
  ).toEqual({
    filters: { "section:work": "unreads" },
    activeWindowSeconds: {},
  });
  expect(
    await transport.writeSidebarFilter?.(
      "channels",
      "active",
      ["work"],
      signal,
      7 * 86400,
    ),
  ).toEqual({
    filters: { "section:work": "unreads", channels: "active" },
    activeWindowSeconds: { channels: 7 * 86400 },
  });
  expect(
    await transport.writeSidebarFilter?.(
      "section:work",
      "all",
      ["work"],
      signal,
    ),
  ).toEqual({
    filters: { channels: "active" },
    activeWindowSeconds: { channels: 7 * 86400 },
  });
  expect(records.get("channel-sort")).toEqual(sort);
  const record = records.get("channel-filter");
  expect(record).toBeDefined();
  expect(decode(record ? [record] : [])["channel-filter"]).toMatchObject({
    meta: {
      g: { "section:work": [expect.any(Number), expect.any(String), null] },
    },
  });
  await expect(
    transport.writeSidebarFilter?.("section:missing", "active", [], signal),
  ).rejects.toThrow("Invalid sidebar filter intent");
});

it("rejects a same-mode native readback with a conflicting duration", async () => {
  const transport = await connectNativeTransport(community);
  records.set(
    "channel-filter",
    signedRecord("channel-filter", {
      version: 1,
      groups: { channels: "active" },
    }),
  );
  const original = vi.mocked(invoke).getMockImplementation();
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const result = await original?.(command, args);
    if (
      command === "relay_http" &&
      (args as { path: string }).path === "/events"
    )
      records.set(
        "channel-filter",
        signedRecord(
          "channel-filter",
          {
            version: 1,
            groups: { channels: "active" },
            activeWindowSeconds: { channels: 90 * 86400 },
          },
          2_000_000_000,
        ),
      );
    return result;
  });
  await expect(
    transport.writeSidebarFilter?.("channels", "active", [], signal, 7 * 86400),
  ).rejects.toThrow("changed on another device");
  const before = vi.mocked(invoke).mock.calls.length;
  await expect(
    transport.writeSidebarFilter?.("channels", "active", [], signal, 86401),
  ).rejects.toThrow("Invalid sidebar filter intent");
  expect(vi.mocked(invoke).mock.calls).toHaveLength(before);
});

it("creates an empty Team section and confirms retry without touching placements or stars", async () => {
  records.set(
    "channel-sections",
    signedRecord("channel-sections", {
      version: 1,
      sections: [{ id: "work", name: "Work", order: 0 }],
      assignments: { alpha: "work" },
    }),
  );
  const transport = await connectNativeTransport(community);
  if (!transport.writeSidebarAssignment)
    throw new Error("Missing sidebar writer");
  const intent = {
    createSection: {
      id: "12345678-1234-1234-1234-123456789abc",
      name: " Launch ",
    },
  };
  const created = await transport.writeSidebarAssignment(intent, signal);
  expect(created.assignments).toEqual({ alpha: "work" });
  expect(created.sections.at(-1)).toMatchObject({
    id: intent.createSection.id,
    name: "Launch",
  });
  const head = records.get("channel-sections");
  expect(await transport.writeSidebarAssignment(intent, signal)).toEqual(
    created,
  );
  expect(records.get("channel-sections")).toBe(head);
  expect(records.has("channel-stars")).toBe(false);
});
