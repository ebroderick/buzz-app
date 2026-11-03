import { Context } from "@deepseek-ai/cordis";
import { expect, it } from "vitest";
import type { SidebarRowContribution } from "./sidebar-rows-service";
import { SidebarRowsService } from "./sidebar-rows-service";

it("orders active scopes by contribution key and removes registrations on disable and teardown", async () => {
  const root = new Context();
  const active = new Set(["z.plugin", "a.plugin"]);
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: (id: string) => active.has(id),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const registry = new SidebarRowsService(root);
  const value: SidebarRowContribution = {
    version: 1,
    id: "rows",
    render: (_, Default) => Default,
  };
  const fibers = ["z.plugin", "a.plugin"].map((id) =>
    root
      .extend({ pluginOwner: { id, revision: "one" } })
      .plugin((ctx) => ctx.reflect.get("sidebarRows")?.register(value)),
  );
  try {
    await Promise.all(fibers.map((fiber) => fiber.await()));
    expect(registry.snapshot().map((entry) => entry.key)).toEqual([
      "a.plugin/rows",
      "z.plugin/rows",
    ]);
    expect(registry.snapshot()).toBe(registry.snapshot());
    active.delete("a.plugin");
    for (const listener of listeners) listener();
    expect(registry.snapshot().map((entry) => entry.key)).toEqual([
      "z.plugin/rows",
    ]);
    await fibers[0]?.dispose();
    expect(registry.snapshot()).toEqual([]);
  } finally {
    await root.fiber.dispose();
  }
});

it.each([
  [
    "duplicate mode ids",
    "example.plugin",
    {
      sortModes: [
        { id: "one", label: "One", compare: (): number => 0 },
        { id: "one", label: "Two", compare: (): number => 0 },
      ],
    },
  ],
  [
    "blank label",
    "example.plugin",
    { sortModes: [{ id: "one", label: "  ", compare: (): number => 0 }] },
  ],
  [
    "non-function comparator",
    "example.plugin",
    { sortModes: [{ id: "one", label: "One", compare: null }] },
  ],
  ["non-function renderer", "example.plugin", { render: false }],
  [
    "incompatible owner id",
    "MixedCase",
    { sortModes: [{ id: "one", label: "One", compare: (): number => 0 }] },
  ],
] as const)(
  "rejects %s without publishing a partial contribution",
  async (_, owner, fields) => {
    const root = new Context();
    root.provide("pluginStatus", {
      isActive: () => true,
      subscribe: () => () => {},
    });
    const registry = new SidebarRowsService(root);
    let register = () => {};
    const fiber = root
      .extend({ pluginOwner: { id: owner, revision: "one" } })
      .plugin((ctx) => {
        register = () =>
          ctx.reflect.get("sidebarRows")?.register({
            version: 1,
            id: "rows",
            render: (_, Default) => Default,
            ...fields,
          } as SidebarRowContribution);
      });
    try {
      await fiber.await();
      expect(register).toThrow();
      expect(registry.snapshot()).toEqual([]);
    } finally {
      await root.fiber.dispose();
    }
  },
);
