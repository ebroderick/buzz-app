import { expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { PluginRuntime } from "../../plugins/runtime";
import { PagesService } from "../pages/service";
import { PanelsService } from "./service";
import { ConversationService } from "../conversation/service";
import { SettingsCardsService } from "../settings/service";
import { ShortcutsService } from "../shortcuts/service";
import { provideRelay } from "../relay/service";
import { provideNavigation } from "../navigation/service";
import { emptySync } from "../communities/known-communities";
import * as channelsPlugin from "../../bundled/channels";
import * as githubPlugin from "../../bundled/github";
import { flush } from "../relay/testing";
import type { PluginInfo } from "../../plugins/types";

const plugin = (id: string): PluginInfo => ({
  manifest: { id, name: id, apiVersion: 1 },
  enabled: true,
  source: "bundled",
  revision: "one",
  previous: null,
  reloadable: false,
  error: null,
});
it("independently unloads panels without removing the page or shared data", async () => {
  const root = new Context();
  const runtime = new PluginRuntime(root, async (info) =>
    info.manifest.id === "channels" ? channelsPlugin : githubPlugin,
  );
  const pages = new PagesService(root),
    panels = new PanelsService(root);
  new ConversationService(root);
  new SettingsCardsService(root);
  // Channels owns the New conversation and Archive chat shortcuts.
  new ShortcutsService(root);
  // Channels adds agent teams; GitHub registers tools and an Attention source.
  root.provide("agents", {
    subscribe: () => () => {},
    snapshot: () => undefined,
    addTool: () => {},
    addAttentionSource: () => {},
  });
  root.provide("communityReader", {
    subscribe: () => () => {},
    snapshot: () => ({
      status: "unavailable",
      relayAvailable: false,
      profile: { name: "", picture: "" },
      memberships: [],
      selected: null,
      sync: emptySync(),
    }),
  });
  // Channels hands community membership to its page for auto-join settings.
  root.provide("adminAccess", { membership: undefined });
  // GitHub reads through gh where the host can run it; here it cannot.
  root.provide("host", {});
  provideNavigation(root);
  const relay = provideRelay(root);
  const desired = (ids: string[]) => ids.map(plugin);
  try {
    runtime.reconcile(desired(["channels", "github"]));
    await flush();
    expect(pages.snapshot()).toHaveLength(1);
    expect(panels.resolve("https://github.com/block/buzz/pull/23")?.title).toBe(
      "GitHub",
    );
    expect(
      panels.resolve("https://github.com/block/buzz/pull/23")?.deferUntilShown,
    ).toBe(true);
    const channelPanels = panels
      .snapshot()
      .filter((panel) => panel.pluginId === "channels");
    expect(channelPanels.length).toBeGreaterThan(0);
    const queries = relay.snapshot().session;
    runtime.reconcile(desired(["channels"]));
    await flush();
    expect(panels.snapshot()).toEqual(channelPanels);
    expect(pages.snapshot()).toHaveLength(1);
    expect(relay.snapshot().session).toBe(queries);
    runtime.reconcile(desired(["channels", "github"]));
    await flush();
    expect(
      panels.resolve("https://github.com/block/buzz/pull/23"),
    ).toBeDefined();
    runtime.reconcile(desired(["github"]));
    await flush();
    expect(pages.snapshot()).toHaveLength(0);
    expect(
      panels.snapshot().some((panel) => panel.pluginId === "channels"),
    ).toBe(false);
    expect(
      panels.resolve("https://github.com/block/buzz/pull/23"),
    ).toBeDefined();
    expect(relay.snapshot().session).toBe(queries);
  } finally {
    await runtime.dispose();
    await root.fiber.dispose();
  }
});

it("skips faulty matchers, resolves by order then key, and removes disposed contributions", async () => {
  const root = new Context();
  let active = false;
  const listeners = new Set<() => void>();
  root.provide("pluginStatus", {
    isActive: () => active,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const panels = new PanelsService(root);
  const scope = root.extend({ pluginOwner: { id: "test", revision: "one" } });
  const component = () => null;
  const fiber = scope.plugin((ctx) => {
    ctx.panels.register({
      id: "broken",
      title: "Broken",
      matches: () => {
        throw new Error("bad matcher");
      },
      component,
    });
    // Registered first, yet the catch-all band loses to every default-band match.
    ctx.panels.register({
      id: "fallback",
      title: "Fallback",
      matches: () => true,
      order: 100,
      component,
    });
    ctx.panels.register({
      id: "zeta",
      title: "Zeta",
      matches: (target) => target.startsWith("buzz:"),
      component,
    });
    // Same band as zeta, registered later: the key decides, not registration.
    ctx.panels.register({
      id: "alpha",
      title: "Alpha",
      matches: (target) => target.startsWith("buzz:"),
      component,
    });
    // A throwing order counts as the default band rather than being skipped.
    ctx.panels.register({
      id: "shaky",
      title: "Shaky",
      matches: (target) => target.startsWith("shaky:"),
      order: () => {
        throw new Error("bad order");
      },
      component,
    });
    // One registration, specific on threads and a catch-all elsewhere.
    ctx.panels.register({
      id: "threads",
      title: "Threads",
      matches: () => true,
      order: (target) => (target.startsWith("buzz:thread") ? -10 : 100),
      component,
    });
  });
  await fiber.await();
  expect(panels.resolve("buzz:object")).toBeUndefined();
  active = true;
  for (const listener of listeners) listener();
  expect(panels.resolve("buzz:object")?.id).toBe("alpha");
  expect(panels.resolve("buzz:thread/1")?.id).toBe("threads");
  expect(panels.resolve("shaky:1")?.id).toBe("shaky");
  // Two catch-alls tie at 100; the key breaks it.
  expect(panels.resolve("https://example.org/")?.id).toBe("fallback");
  await fiber.dispose();
  expect(panels.resolve("buzz:object")).toBeUndefined();
  await root.fiber.dispose();
});

it("keeps the specific panel ahead of a catch-all after it is disabled and re-enabled", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  const component = () => null;
  const browser = root
    .extend({ pluginOwner: { id: "browser", revision: "one" } })
    .plugin((ctx) => {
      ctx.panels.register({
        id: "site",
        title: "Site",
        matches: (target) => target.startsWith("https://"),
        order: 100,
        component,
      });
    });
  const github = (revision: string) =>
    root.extend({ pluginOwner: { id: "github", revision } }).plugin((ctx) => {
      ctx.panels.register({
        id: "github",
        title: "GitHub",
        matches: (target) => target.startsWith("https://github.com/"),
        component,
      });
    });
  const pull = "https://github.com/block/buzz/pull/23";
  const site = "https://example.org/";
  const first = github("one");
  await Promise.all([browser.await(), first.await()]);
  expect(panels.snapshot().map((panel) => panel.key)).toEqual([
    "browser/site",
    "github/github",
  ]);
  expect(panels.resolve(pull)?.key).toBe("github/github");
  expect(panels.resolve(site)?.key).toBe("browser/site");
  await first.dispose();
  expect(panels.resolve(pull)?.key).toBe("browser/site");
  const second = github("two");
  await second.await();
  expect(panels.snapshot().map((panel) => panel.key)).toEqual([
    "browser/site",
    "github/github",
  ]);
  expect(panels.resolve(pull)?.key).toBe("github/github");
  expect(panels.resolve(pull)?.revision).toBe("two");
  expect(panels.resolve(site)?.key).toBe("browser/site");
  await second.dispose();
  await browser.dispose();
  await root.fiber.dispose();
});

it("validates and freezes launcher metadata without changing target resolution", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  const scope = root.extend({
    pluginOwner: { id: "launchers", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    const base = {
      id: "notes",
      title: "Notes",
      matches: () => false,
      component: () => null,
    };
    for (const launcher of [
      null,
      {},
      { icon: "", target: "" },
      { icon: "/icon.png", target: 1 },
    ]) {
      expect(() => ctx.panels.register({ ...base, launcher } as never)).toThrow(
        "launcher",
      );
    }
    for (const channelPlacement of [null, "left", "", 42, {}]) {
      expect(() =>
        ctx.panels.register({ ...base, channelPlacement } as never),
      ).toThrow("placement");
    }
    for (const order of [null, "100", {}, true]) {
      expect(() => ctx.panels.register({ ...base, order } as never)).toThrow(
        "order",
      );
    }
    for (const deferUntilShown of [null, "true", 1, {}]) {
      expect(() =>
        ctx.panels.register({ ...base, deferUntilShown } as never),
      ).toThrow("deferUntilShown");
    }
    for (const channelMenu of [
      null,
      {},
      { label: "", eligible: () => true },
      { label: "Usage", eligible: true },
    ]) {
      expect(() =>
        ctx.panels.register({ ...base, channelMenu } as never),
      ).toThrow("channel menu");
    }
    const launcher = { icon: "/icon.png", target: "" };
    const channelMenu = { label: "Usage", eligible: () => true };
    ctx.panels.register({ ...base, launcher, channelMenu });
    launcher.icon = "/mutated.png";
    channelMenu.label = "mutated";
  });
  await fiber.await();
  expect(panels.snapshot()[0]?.launcher).toEqual({
    icon: "/icon.png",
    target: "",
  });
  expect(Object.isFrozen(panels.snapshot()[0]?.launcher)).toBe(true);
  expect(panels.snapshot()[0]?.channelMenu?.label).toBe("Usage");
  expect(Object.isFrozen(panels.snapshot()[0]?.channelMenu)).toBe(true);
  expect(panels.resolve("")).toBeUndefined();
  await fiber.dispose();
  expect(panels.snapshot()).toEqual([]);
  await root.fiber.dispose();
});

it("opens a requested target only through a page showing its channel", async () => {
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const panels = new PanelsService(root);
  await root
    .extend({ pluginOwner: { id: "apps", revision: "one" } })
    .plugin((ctx) => {
      ctx.panels.register({
        id: "app",
        title: "App",
        matches: (target) => target.startsWith("https://app.example/"),
        component: () => null,
      });
    })
    .await();
  const request = { target: "https://app.example/", channelId: "c1" };
  // No page shows a conversation.
  expect(panels.requestOpen(request)).toBe(false);
  const seen: unknown[] = [];
  const stop = panels.handleOpenRequests((next) => {
    seen.push(next);
    return next.channelId === "c1";
  });
  expect(panels.requestOpen(request)).toBe(true);
  expect(panels.requestOpen({ ...request, channelId: "c2" })).toBe(false);
  // A target no panel handles never reaches the page.
  expect(
    panels.requestOpen({ ...request, target: "https://other.example/" }),
  ).toBe(false);
  expect(seen).toHaveLength(2);
  stop();
  expect(panels.requestOpen(request)).toBe(false);
});
