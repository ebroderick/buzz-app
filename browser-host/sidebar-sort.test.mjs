import { expect, it, vi } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import {
  prepareSidebarSort,
  mutateSidebarSort,
  prepareSidebarFilter,
  mutateSidebarFilter,
} from "./sidebar-sort.mjs";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
import { editSidebarRecord } from "../src/features/relay/sidebar-registers.ts";
function harness() {
  const secret = generateSecretKey(),
    viewer = getPublicKey(secret);
  const key = nip44.v2.utils.getConversationKey(secret, viewer);
  return {
    secret,
    viewer,
    encrypt(blob, overrides = {}) {
      return finalizeEvent(
        {
          kind: 30078,
          created_at: 100,
          tags: [["d", "channel-sort"]],
          content: nip44.v2.encrypt(JSON.stringify(blob), key),
          ...overrides,
        },
        secret,
      );
    },
    decode(event) {
      return JSON.parse(nip44.v2.decrypt(event.content, key));
    },
  };
}
const intent = { group: "section:work", mode: "recent", sectionIds: ["work"] };
it.each([undefined, "alpha", "recent"])(
  "encrypts plugin choices from legacy %s without putting them in legacy sort fields and confirms reloads",
  async (initialMode) => {
    const h = harness();
    const mode = "plugin:example.plugin/rows/reverse";
    let head = h.encrypt({
      version: 1,
      groups: {
        dms: "recent",
        ...(initialMode ? { channels: initialMode } : {}),
      },
    });
    const publish = vi.fn(async (event) => {
      head = event;
    });
    const choose = (selected) =>
      mutateSidebarSort(
        { group: "channels", mode: selected, sectionIds: [] },
        h.secret,
        async () => [head],
        publish,
      );
    expect(await choose(mode)).toEqual({ channels: mode, dms: "recent" });
    expect(h.decode(head).groups).toEqual({ channels: "alpha", dms: "recent" });
    expect(h.decode(head).meta.g.channels[2]).toBe("alpha");
    expect(await choose(mode)).toEqual({ channels: mode, dms: "recent" });
    expect(publish).toHaveBeenCalledOnce();
    expect(await choose("alpha")).toEqual({ dms: "recent" });
    expect(publish).toHaveBeenCalledTimes(2);
  },
);
it.each(["dms", "channels"])(
  "confirms only the requested plugin sort when an older client changes %s",
  async (changedGroup) => {
    const h = harness();
    const mode = "plugin:example.plugin/rows/reverse";
    let head = prepareSidebarSort(
      [],
      { group: "dms", mode, sectionIds: [] },
      h.secret,
      100_000,
    ).event;
    const publish = vi.fn(async (event) => {
      const updated = editSidebarRecord(
        "channel-sort",
        h.decode(event),
        event.created_at,
        [[["g", changedGroup], "recent"]],
        event.created_at * 1000 + 1,
      );
      head = h.encrypt(updated, { created_at: event.created_at + 1 });
    });
    const saved = mutateSidebarSort(
      { group: "channels", mode, sectionIds: [] },
      h.secret,
      async () => [head],
      publish,
    );
    if (changedGroup === "dms")
      await expect(saved).resolves.toEqual({ channels: mode, dms: "recent" });
    else await expect(saved).rejects.toThrow("changed on another device");
    expect(publish).toHaveBeenCalledOnce();
    expect(
      projectSidebarPreferences(undefined, undefined, undefined, h.decode(head))
        .sort,
    ).toEqual(
      changedGroup === "dms"
        ? { channels: mode, dms: "recent" }
        : { channels: "recent", dms: mode },
    );
  },
);
it("preserves another device's plugin choice when the writer has a stale section list", async () => {
  const h = harness();
  const mode = "plugin:example.plugin/rows/reverse";
  let head = prepareSidebarSort(
    [],
    { group: "section:new", mode, sectionIds: ["new"] },
    h.secret,
    100_000,
  ).event;
  const saved = h.decode(head).pluginSort;
  expect(
    await mutateSidebarSort(
      { group: "channels", mode: "recent", sectionIds: [] },
      h.secret,
      async () => [head],
      async (event) => {
        head = event;
      },
    ),
  ).toEqual({ channels: "recent" });
  const current = h.decode(head);
  expect(current.pluginSort).toEqual(saved);
  expect(
    projectSidebarPreferences(undefined, undefined, undefined, current, ["new"])
      .sort,
  ).toEqual({ channels: "recent", "section:new": mode });
});
it("mutates only the selected register, imports recognized legacy modes, and encodes alpha as a tombstone", () => {
  const h = harness();
  const blob = {
    version: 1,
    future: { x: 1 },
    groups: {
      channels: "recent",
      "section:elsewhere": "recent",
      future: "next-mode",
    },
  };
  const draft = prepareSidebarSort([h.encrypt(blob)], intent, h.secret, 50_000);
  expect(verifyEvent(draft.event)).toBe(true);
  expect(draft.event.created_at).toBe(101);
  const saved = h.decode(draft.event);
  expect(saved.groups).toEqual({
    channels: "recent",
    "section:elsewhere": "recent",
    "section:work": "recent",
  });
  expect(saved.future).toEqual(blob.future);
  expect(saved.meta.g.channels).toEqual([
    100_000,
    "0000000000000000",
    "recent",
  ]);
  expect(saved.meta.g["section:work"]).toEqual([
    100_001,
    expect.stringMatching(/^[0-9a-f]{16}$/),
    "recent",
  ]);
  expect(draft.groups).toEqual({
    channels: "recent",
    "section:work": "recent",
  });
  const alpha = prepareSidebarSort(
    [draft.event],
    { ...intent, mode: "alpha" },
    h.secret,
    50_000,
  );
  const reset = h.decode(alpha.event);
  expect(reset.groups).toEqual({
    channels: "recent",
    "section:elsewhere": "recent",
  });
  expect(reset.meta.g["section:work"]).toEqual([
    100_002,
    saved.meta.g["section:work"][1],
    null,
  ]);
  expect(reset.meta.g.channels).toEqual(saved.meta.g.channels);
  expect(alpha.event.created_at).toBe(102);
  expect(
    prepareSidebarSort([alpha.event], { ...intent, mode: "alpha" }, h.secret)
      .event,
  ).toBeUndefined();
});
it("rejects invalid intent before reading, and ambiguous/untrusted/invalid heads before publishing", async () => {
  const h = harness(),
    other = harness();
  const read = vi.fn(),
    publish = vi.fn();
  for (const invalid of [
    null,
    {},
    { ...intent, group: "group:work" },
    { ...intent, mode: "unknown" },
    { ...intent, sectionIds: [" "] },
    { ...intent, extra: 1 },
  ]) {
    await expect(
      mutateSidebarSort(invalid, h.secret, read, publish),
    ).rejects.toThrow();
  }
  expect(read).not.toHaveBeenCalled();
  const valid = h.encrypt({ version: 1, groups: {} });
  for (const heads of [
    null,
    [valid, valid],
    [other.encrypt({ version: 1, groups: {} })],
    [{ ...JSON.parse(JSON.stringify(valid)), sig: "0".repeat(128) }],
    [h.encrypt({ version: 2, groups: {} })],
    [h.encrypt({ version: 1, groups: [] })],
    [h.encrypt({ version: 1, groups: {} }, { tags: [["d", "channel-stars"]] })],
    [h.encrypt({ version: 1, groups: {} }, { content: "not encrypted" })],
  ]) {
    await expect(
      mutateSidebarSort(intent, h.secret, async () => heads, publish),
    ).rejects.toThrow();
  }
  expect(publish).not.toHaveBeenCalled();
});
it("confirms newer unrelated choices, rejects a replaced intent, and never seeds after a failed read", async () => {
  const h = harness();
  let heads = [];
  const read = vi.fn(async () => heads);
  const publish = vi.fn(async () => {
    heads = [
      h.encrypt({
        version: 1,
        groups: { "section:work": "recent", forums: "recent" },
      }),
    ];
  });
  expect(await mutateSidebarSort(intent, h.secret, read, publish)).toEqual({
    "section:work": "recent",
    forums: "recent",
  });
  expect(read).toHaveBeenCalledTimes(2);
  await mutateSidebarSort(intent, h.secret, read, publish);
  expect(publish).toHaveBeenCalledOnce();
  heads = [];
  await expect(
    mutateSidebarSort(intent, h.secret, read, async () => {}),
  ).rejects.toThrow("changed on another device");
  await expect(
    mutateSidebarSort(
      intent,
      h.secret,
      async () => {
        throw new Error("offline");
      },
      publish,
    ),
  ).rejects.toThrow("offline");
  expect(publish).toHaveBeenCalledOnce();
});
it("whole-blob LWW can lose an intervening other-section save while both mutations succeed", async () => {
  const h = harness();
  let heads = [h.encrypt({ version: 1, groups: { starred: "recent" } })];
  const read = async () => heads;
  const publish = async (event) => {
    // Model replaceable-event ordering without a same-second ID tie.
    expect(event.created_at).toBeGreaterThan(heads[0].created_at);
    heads = [event];
  };
  const clock = vi.spyOn(Date, "now").mockReturnValue(200_000);
  try {
    const result = await mutateSidebarSort(
      { ...intent, group: "channels" },
      h.secret,
      read,
      async (event) => {
        // Device B saves and confirms after A's read but before A publishes.
        // B's clock is one second behind A's, so A's stale blob wins later.
        clock.mockReturnValue(199_000);
        await expect(
          mutateSidebarSort(
            { ...intent, group: "forums" },
            h.secret,
            read,
            publish,
          ),
        ).resolves.toEqual({ starred: "recent", forums: "recent" });
        expect(h.decode(heads[0]).groups).toEqual({
          starred: "recent",
          forums: "recent",
        });
        await publish(event);
      },
    );
    expect(result).toEqual({ starred: "recent", channels: "recent" });
    expect(h.decode(heads[0]).groups).toEqual({
      starred: "recent",
      channels: "recent",
    });
    expect(h.decode(heads[0]).meta.g.forums).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});
it("projection accepts full-length section keys, rejects over-budget data, and ignores unknown keys/modes", () => {
  const id = "x".repeat(256);
  expect(
    projectSidebarPreferences(
      undefined,
      undefined,
      undefined,
      {
        version: 1,
        groups: {
          [`section:${id}`]: "recent",
          channels: "recent",
          future: "recent",
          dms: "unknown",
        },
      },
      [id],
    ).sort,
  ).toEqual({ [`section:${id}`]: "recent", channels: "recent" });
  expect(() =>
    projectSidebarPreferences(undefined, undefined, undefined, {
      version: 1,
      groups: Object.fromEntries(
        Array.from({ length: 105 }, (_, i) => [`section:${i}`, "recent"]),
      ),
    }),
  ).toThrow("budget exceeded");
});

it("edits the authoritative metadata, preserves tombstones and confirms projected intent", async () => {
  const h = harness();
  const reg = (v) => [9_000_000_000_000, "1111111111111111", v];
  let head = h.encrypt({
    version: 1,
    groups: { channels: "recent" },
    meta: { v: 1, g: { channels: reg(null), forums: reg("recent") } },
  });
  const result = await mutateSidebarSort(
    { group: "channels", mode: "recent", sectionIds: [] },
    h.secret,
    async () => [head],
    async (event) => {
      head = event;
    },
  );
  expect(result).toEqual({ channels: "recent", forums: "recent" });
  expect(h.decode(head).meta.g.channels).toEqual([
    9_000_000_000_001,
    expect.stringMatching(/^[0-9a-f]{16}$/),
    "recent",
  ]);
  expect(h.decode(head).meta.g.forums).toEqual(reg("recent"));
  const publish = vi.fn();
  await expect(
    mutateSidebarSort(
      intent,
      h.secret,
      async () => [h.encrypt({ version: 1, groups: {}, meta: { v: 2 } })],
      publish,
    ),
  ).rejects.toThrow("metadata");
  expect(publish).not.toHaveBeenCalled();
});

it("stores independent filters, preserves other registers and tombstones All, and rejects untrusted filter heads", async () => {
  const h = harness();
  const choice = {
    group: "section:work",
    mode: "unreads",
    sectionIds: ["work"],
  };
  const draft = prepareSidebarFilter([], choice, h.secret, 100_000);
  expect(draft.groups).toEqual({ "section:work": "unreads" });
  expect(draft.event.tags).toEqual([
    ["d", "channel-filter"],
    ["t", "channel-filter"],
  ]);
  const other = prepareSidebarFilter(
    [draft.event],
    { ...choice, group: "channels", mode: "active" },
    h.secret,
  );
  const reset = prepareSidebarFilter(
    [other.event],
    { ...choice, mode: "all" },
    h.secret,
  );
  expect(reset.groups).toEqual({ channels: "active" });
  expect(h.decode(reset.event).meta.g["section:work"][2]).toBeNull();
  expect(h.decode(reset.event).meta.g.channels).toEqual(
    h.decode(other.event).meta.g.channels,
  );
  expect(
    prepareSidebarFilter([reset.event], { ...choice, mode: "all" }, h.secret)
      .event,
  ).toBeUndefined();
  expect(() =>
    prepareSidebarFilter(
      [h.encrypt({ version: 1, groups: {} })],
      choice,
      h.secret,
    ),
  ).toThrow("Invalid sidebar filter head");
  const invalid = h.encrypt(
    { version: 1, groups: { channels: "future" } },
    { tags: [["d", "channel-filter"]] },
  );
  expect(() => prepareSidebarFilter([invalid], choice, h.secret)).toThrow(
    "Invalid sidebar filter mode",
  );
  const read = vi.fn(async () => []),
    publish = vi.fn();
  await expect(
    mutateSidebarFilter({ ...choice, mode: "recent" }, h.secret, read, publish),
  ).rejects.toThrow("Invalid sidebar filter intent");
  expect(read).not.toHaveBeenCalled();
  await expect(
    mutateSidebarFilter(choice, h.secret, read, publish),
  ).rejects.toThrow("changed on another device");
  expect(publish).toHaveBeenCalledOnce();
});

it("atomically confirms custom windows, preserves other sections and clears removed-section durations", async () => {
  const h = harness();
  const choice = {
    group: "channels",
    mode: "active",
    sectionIds: ["work"],
    activeWindowSeconds: 7 * 86400,
  };
  const legacy = h.encrypt(
    {
      version: 1,
      groups: { channels: "active", "section:work": "unreads" },
      activeWindowSeconds: { "section:work": 14 * 86400 },
    },
    { tags: [["d", "channel-filter"]] },
  );
  const draft = prepareSidebarFilter([legacy], choice, h.secret);
  expect(h.decode(draft.event)).toMatchObject({
    groups: { channels: "active", "section:work": "unreads" },
    activeWindowSeconds: { channels: 7 * 86400, "section:work": 14 * 86400 },
  });
  expect(
    prepareSidebarFilter([draft.event], choice, h.secret).event,
  ).toBeUndefined();
  const result = await mutateSidebarFilter(
    choice,
    h.secret,
    vi
      .fn()
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([draft.event]),
    vi.fn(),
  );
  expect(result.activeWindowSeconds.channels).toBe(7 * 86400);
  // Same mode with the wrong window must fail readback confirmation.
  await expect(
    mutateSidebarFilter(choice, h.secret, async () => [legacy], vi.fn()),
  ).rejects.toThrow("changed on another device");
  const reset = prepareSidebarFilter(
    [draft.event],
    {
      ...choice,
      group: "section:work",
      mode: "all",
      activeWindowSeconds: null,
    },
    h.secret,
  );
  expect(h.decode(reset.event).activeWindowSeconds).toEqual({
    channels: 7 * 86400,
  });
  const restored = prepareSidebarFilter(
    [draft.event],
    { ...choice, activeWindowSeconds: 30 * 86400 },
    h.secret,
  );
  expect(h.decode(restored.event).activeWindowSeconds.channels).toBe(
    30 * 86400,
  );
  const read = vi.fn(async () => []);
  for (const value of [
    0,
    -86400,
    86401,
    86400.5,
    366 * 86400,
    "604800",
    null,
  ]) {
    await expect(
      mutateSidebarFilter(
        { ...choice, activeWindowSeconds: value },
        h.secret,
        read,
        vi.fn(),
      ),
    ).rejects.toThrow("Invalid sidebar filter intent");
  }
  expect(read).not.toHaveBeenCalled();
});
