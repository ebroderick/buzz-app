// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { FolderSimpleIcon, GlobeIcon } from "../shared/design-system/icons";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { createCommunityMembership } from "../bundled/moderation/membership";
import {
  SettingsCardsService,
  type SettingsCard,
  type SettingsCards,
} from "../features/settings/service";
import type { ClientSnapshot } from "../features/communities/service";
import type { DecisionsService } from "../features/decisions/service";
import type { RelayData } from "../features/relay/service";
import type { Contribution } from "../plugins/contributions";
import { createPluginInstallRequests } from "../plugins/installer";

afterEach(cleanup);
vi.mock("../bundled/icons", () => ({
  bundledIcons: new Map([
    ["buzz.channels", "/channels-icon.png"],
    ["example.helper", "/bundled-helper-icon.png"],
  ]),
}));
vi.mock("../bundled/readmes", () => ({
  bundledReadmes: new Map([
    [
      "buzz.channels",
      "# Channels\n\nHold conversations.\n\n## Getting started\n\n- Read [the spec](../mentions/README.md) or [the site](https://example.com).\n- <b>Raw</b> markup is dropped.\n",
    ],
    ["example.helper", "# Helper\n\nNot from Buzz.\n"],
  ]),
}));

// The shared sidebar's resize handle measures its panel.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

function registry(initial: Contribution<SettingsCard>[]) {
  let entries: readonly Contribution<SettingsCard>[] = initial;
  const listeners = new Set<() => void>();
  const cards: SettingsCards = {
    snapshot: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register() {},
    retainVisibility: () => () => {},
    has: (key) => entries.some((entry) => entry.key === key),
    visibility: (key) => entries.some((entry) => entry.key === key),
  };
  return {
    cards,
    set(next: Contribution<SettingsCard>[]) {
      entries = next;
      for (const listener of listeners) listener();
    },
  };
}
const card = (
  id: string,
  title: string,
  group?: string,
  section?: "administration",
): Contribution<SettingsCard> =>
  Object.freeze({
    id,
    title,
    ...(group ? { group } : {}),
    ...(section ? { section } : {}),
    key: `example/${id}`,
    pluginId: "example",
    revision: "one",
    component: ({ community }) => (
      <p>
        {title} body{community ? ` for ${community.name}` : ""}
      </p>
    ),
  });
// Built-in sections have their own tests; this file covers plugin card placement.
for (const [path, name] of [
  ["./NotificationSettings", "NotificationSettings"],
  ["./AppearanceSettings", "AppearanceSettings"],
  ["./ShortcutSettings", "ShortcutSettings"],
  ["./ProfileSettings", "ProfileSettings"],
  ["./AgentSettings", "AgentSettings"],
  ["./DeveloperSettings", "DeveloperSettings"],
  ["../features/updates/UpdateSettings", "UpdateSettings"],
] as const)
  vi.doMock(path, () => ({ [name]: () => null }));
const { Settings } = await import("./Settings");
const { SettingsSidebar } = await import("./SettingsSidebar");
const pluginState = {
  configuration: { status: "loading" },
  activation: {},
  busy: false,
  error: null,
  refreshError: null,
};
const communityState = {
  status: "ready",
  viewer: "ab".repeat(32),
  profile: { name: "Buzz User", picture: "" },
  memberships: [{ id: "primary", name: "Primary" }],
  selected: "primary",
  sync: { known: [], outbox: [] },
};
const disconnected = { status: "disconnected" };
const connecting = { status: "connecting" };
const relay = { subscribe: () => () => {}, snapshot: () => disconnected };
const host = {
  plugins: { subscribe: () => () => {}, snapshot: () => pluginState },
  communities: {
    retainPresentation: () => () => {},
    subscribe: () => () => {},
    snapshot: () => communityState,
    relay,
  },
} as unknown as Parameters<typeof Settings>[0];

it.each([false, true])("groups plugins (Essentials=%s)", async (essentials) => {
  const ready = {
    configuration: {
      status: "ready",
      externalPluginsPaused: false,
      catalog: {
        profile: "test",
        location: "test",
        plugins: [
          {
            manifest: {
              id: "buzz.voice-notes",
              name: "Voice Notes",
              apiVersion: 1,
              description: "Record voice notes and play them in conversations.",
              discovery: {
                category: "communication",
                ...(essentials ? { tags: ["  essentials  "] } : {}),
              },
            },
            source: "bundled",
            enabled: true,
            revision: "bundled",
            previous: null,
            reloadable: false,
            error: null,
          },
          {
            manifest: {
              id: "buzz.channels",
              name: "Channels",
              apiVersion: 1,
              description: "Navigate channels and hold conversations in Buzz.",
              discovery: {
                category: "communication",
                ...(essentials ? { tags: ["Essentials"] } : {}),
              },
            },
            source: "bundled",
            enabled: true,
            revision: "bundled",
            previous: null,
            reloadable: false,
            error: null,
          },
          {
            manifest: {
              id: "buzz.codex",
              name: "Codex",
              apiVersion: 1,
              description: "Run local Codex coding agents in Buzz.",
              discovery: {
                category: "agents",
                ...(essentials ? { tags: ["Essentials"] } : {}),
              },
            },
            source: "bundled",
            enabled: true,
            revision: "bundled",
            previous: null,
            reloadable: false,
            error: null,
          },
          {
            manifest: {
              id: "example.invoices",
              name: "Invoices",
              apiVersion: 1,
              description: "Reconcile invoices without leaving Buzz.",
              discovery: { category: "finance", tags: ["Essentials"] },
            },
            source: "external",
            enabled: false,
            revision: "one",
            previous: null,
            reloadable: true,
            error: null,
          },
        ],
      },
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  const { cards } = registry([]);
  ready.configuration.catalog.plugins.unshift({
    source: "bundled",
    enabled: true,
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
    manifest: {
      id: "example.messages",
      name: "Messages",
      apiVersion: 1,
      description: "Read messages.",
      discovery: { category: "communication" },
    },
  });
  render(
    <Settings
      {...host}
      cards={cards}
      plugins={
        {
          subscribe: () => () => {},
          snapshot: () => ready,
          change: vi.fn(async () => true),
          reload: vi.fn(async () => true),
          dismissError: vi.fn(),
        } as unknown as Parameters<typeof Settings>[0]["plugins"]
      }
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  const content = screen.getByRole("region", { name: "Manage plugins" });
  for (const tab of within(content).getAllByRole("tab")) {
    const panel = document.getElementById(
      tab.getAttribute("aria-controls") ?? "",
    );
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab.id);
  }
  expect(
    within(content)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["Communication3 plugins", "Agents1 plugin", "Other1 plugin"]);
  const communication = within(content)
    .getByRole("heading", {
      name: /^Communication/,
    })
    .closest('[role="region"]');
  expect(communication).not.toBeNull();
  const categoryGroup = communication?.querySelector(".buzz-settings-group");
  expect(categoryGroup).not.toBeNull();
  expect(categoryGroup?.children).toHaveLength(3);
  for (const row of Array.from(categoryGroup?.children ?? [])) {
    expect(row.querySelector("article")).not.toBeNull();
  }
  expect(
    within(communication as HTMLElement)
      .getAllByRole("article")
      .map((row) =>
        within(row)
          .getByRole("button", { name: /^View .* details$/ })
          .getAttribute("aria-label"),
      ),
  ).toEqual(
    essentials
      ? [
          "View Channels details",
          "View Voice Notes details",
          "View Messages details",
        ]
      : [
          "View Channels details",
          "View Messages details",
          "View Voice Notes details",
        ],
  );
  expect(within(content).getAllByRole("article")).toHaveLength(5);
  expect(
    within(content).getByText("Channels", { exact: true }),
  ).toHaveTextContent(/^Channels$/);
  expect(
    within(content).queryAllByRole("img", { name: "Essential" }),
  ).toHaveLength(essentials ? 3 : 0);
  expect(
    within(content).queryByText("Essential", {
      selector: "span:not(.sr-only)",
    }),
  ).toBeNull();
  if (essentials) {
    const name = within(content).getByText("Voice Notes");
    const marker = within(name.parentElement as HTMLElement).getByRole("img", {
      name: "Essential",
    });
    expect(marker.previousElementSibling?.tagName.toLowerCase()).toBe("svg");
  }
  expect(
    within(content).queryAllByRole("region", { name: "Essentials" }),
  ).toHaveLength(0);
  expect(
    within(content).queryByRole("button", { name: "Disable Channels" }),
  ).toBeNull();
  expect(
    within(content).getByRole("button", {
      name: "Disable Voice Notes",
    }),
  ).toBeEnabled();
  expect(content).toHaveTextContent(
    "Navigate channels and hold conversations in Buzz.",
  );
  expect(content).toHaveTextContent("Run local Codex coding agents in Buzz.");
  expect(
    within(content).getByRole("button", { name: "View Voice Notes details" }),
  ).toHaveAttribute("data-enabled", "true");
  expect(
    within(content).getByRole("button", { name: "View Voice Notes details" }),
  ).toHaveAccessibleDescription(
    `Record voice notes and play them in conversations.${essentials ? " Essential" : ""}`,
  );
  expect(
    within(content).getByRole("button", { name: "View Invoices details" }),
  ).toHaveAttribute("data-enabled", "false");

  const other = within(content)
    .getByRole("heading", { name: /^Other/ })
    .closest('[role="region"]');
  expect(other).not.toBeNull();
  expect(within(other as HTMLElement).getByText("Invoices")).toBeVisible();
  expect(
    within(other as HTMLElement).getByText(
      "Reconcile invoices without leaving Buzz.",
    ),
  ).toBeVisible();
  expect(
    within(other as HTMLElement).getByRole("button", {
      name: "Enable Invoices",
    }),
  ).toBeVisible();
  expect(
    within(content).queryByRole("heading", { name: "Finance" }),
  ).toBeNull();
  expect(
    within(content).queryByRole("button", {
      name: "Essentials only",
    }),
  ).toBeNull();

  fireEvent.click(within(content).getByRole("tab", { name: "Essentials" }));
  expect(within(content).queryAllByRole("article")).toHaveLength(
    essentials ? 3 : 0,
  );
  await waitFor(() =>
    expect(within(content).queryByText("Invoices")).toBeNull(),
  );
  const search = within(content).getByRole("searchbox", {
    name: "Search plugins",
  });
  fireEvent.change(search, { target: { value: "  BUZZ.CODEX  " } });
  expect(within(content).queryAllByRole("article")).toHaveLength(
    essentials ? 1 : 0,
  );
  if (essentials) expect(within(content).getByText("Codex")).toBeVisible();

  fireEvent.click(within(content).getByRole("tab", { name: "All plugins" }));
  expect(within(content).getAllByRole("article")).toHaveLength(1);
  fireEvent.change(search, { target: { value: "Reconcile" } });
  expect(within(content).getAllByRole("article")).toHaveLength(1);
  await waitFor(() =>
    expect(within(content).getByText("Invoices")).toBeVisible(),
  );
  fireEvent.change(search, { target: { value: "no-match" } });
  expect(within(content).queryAllByRole("article")).toHaveLength(0);
  expect(within(content).getByText("No plugins match")).toBeVisible();
  const clearFilters = within(content).getByRole("button", {
    name: "Clear filters",
  });
  clearFilters.focus();
  fireEvent.click(clearFilters);
  expect(search).toHaveValue("");
  expect(search).toHaveFocus();
  expect(within(content).getAllByRole("article")).toHaveLength(5);

  fireEvent.click(
    within(content).getByRole("button", { name: "View Voice Notes details" }),
  );
  fireEvent.change(search, { target: { value: "Invoices" } });
  expect(
    within(content).queryByRole("button", { name: "View Voice Notes details" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close plugin details" }));
  expect(content).toHaveFocus();
  expect(search).toHaveValue("Invoices");
});

it("opens each plugin's existing metadata and controls in a detail aside", () => {
  const { cards } = registry([]);
  const snapshot = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: {
        profile: "test",
        location: "test",
        plugins: [
          {
            manifest: {
              id: "buzz.channels",
              name: "Channels",
              apiVersion: 1 as const,
              discovery: { tags: ["messaging", "  Essentials  "] },
            },
            source: "bundled" as const,
            enabled: true,
            revision: "bundled",
            previous: null,
            reloadable: false,
            error: null,
          },
          {
            manifest: {
              id: "example.helper",
              name: "External helper",
              apiVersion: 1 as const,
              discovery: { tags: ["tasks"] },
            },
            source: "external" as const,
            enabled: true,
            revision: "abc123",
            previous: null,
            hasSignature: true,
            publisher: "publisher-public-key",
            reloadable: true,
            error: null,
          },
        ],
      },
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  const plugins = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    change: vi.fn(),
    reload: vi.fn(),
    dismissError: vi.fn(),
  } as unknown as Parameters<typeof Settings>[0]["plugins"];

  render(<Settings {...host} cards={cards} plugins={plugins} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));

  const bundledCard = screen.getByRole("button", {
    name: "View Channels details",
  });
  const artwork = bundledCard.querySelector("img");
  expect(artwork).toHaveAttribute("src", "/channels-icon.png");
  if (!artwork) throw new Error("Expected bundled plugin artwork");
  fireEvent.error(artwork);
  expect(bundledCard.querySelector("img")).toBeNull();
  expect(bundledCard.querySelectorAll("svg")).toHaveLength(3);
  expect(within(bundledCard).queryByText("Buzz")).toBeNull();
  expect(
    within(bundledCard).getByText("Channels").nextElementSibling,
  ).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("button", { name: "Disable Channels" })).toBeNull();
  const rowRequired = screen.getByRole("button", { name: "Required" });
  expect(rowRequired).toBeDisabled();
  expect(rowRequired).toHaveAttribute("data-variant", "outline");
  expect(rowRequired).toHaveAttribute("data-size", "sm");
  expect(screen.queryByText("buzz.channels")).toBeNull();

  fireEvent.click(bundledCard);
  const bundled = screen.getByRole("complementary", {
    name: "Channels details",
  });
  expect(bundled.parentElement).toContainElement(
    screen.getByRole("navigation", { name: "Settings sections" }),
  );
  expect(within(bundled).queryByText("Buzz")).toBeNull();
  expect(within(bundled).getByText("buzz.channels")).toBeVisible();
  expect(within(bundled).queryByText("Signature")).toBeNull();
  const badge = within(bundled).getByText("Made by Buzz");
  expect(badge).toBeVisible();
  expect(badge.parentElement?.parentElement).toContainElement(
    within(bundled).getByRole("heading", { name: "Channels" }),
  );
  expect(badge.nextElementSibling).toHaveTextContent("Essentials");
  expect(badge.nextElementSibling).toHaveAttribute("class", badge.className);
  expect(within(bundled).getByText("messaging")).not.toHaveAttribute(
    "data-essential",
  );
  expect(within(bundled).getByText("messaging")).toBeVisible();
  expect(
    within(bundled).getByText("messaging").closest("tr"),
  ).toHaveTextContent("Tags");
  expect(badge.parentElement).not.toContainElement(
    within(bundled).getByText("messaging"),
  );
  expect(within(bundled).queryByText("Installed")).toBeNull();
  const required = within(bundled).getByRole("button", { name: "Required" });
  expect(required).toBeDisabled();
  expect(required).toHaveAttribute("data-variant", "outline");
  expect(required).toHaveAttribute("data-size", "sm");
  fireEvent.click(required);
  expect(plugins.change).not.toHaveBeenCalled();
  const details = within(bundled).getByRole("table", { name: "Details" });
  expect(
    within(details)
      .getAllByRole("rowheader")
      .map((cell) => cell.textContent),
  ).toEqual(["Identifier", "Plugin API", "Tags"]);
  expect(
    within(details).getByRole("cell", { name: "buzz.channels" }),
  ).toBeVisible();

  fireEvent.click(
    within(bundled).getByRole("button", { name: "Close plugin details" }),
  );
  expect(bundledCard).toHaveFocus();
  expect(
    screen.queryByRole("complementary", { name: "Channels details" }),
  ).toBeNull();

  const externalCard = screen.getByRole("button", {
    name: "View External helper details",
  });
  const externalAuthor = within(externalCard).getByText("publisher-public-key");
  expect(externalCard.querySelector("img")).toBeNull();
  expect(externalAuthor.parentElement?.querySelector("svg")).toBeNull();
  const rowAction = screen.getByRole("button", {
    name: "Disable External helper",
  });
  expect(rowAction).toHaveAttribute("data-variant", "subtle");
  expect(rowAction).toHaveAttribute("data-size", "sm");
  expect(externalCard).not.toContainElement(rowAction);
  fireEvent.click(rowAction);
  expect(plugins.change).toHaveBeenCalledWith("disable", "example.helper");
  expect(
    screen.queryByRole("complementary", { name: "External helper details" }),
  ).toBeNull();
  fireEvent.click(externalCard);
  const external = screen.getByRole("complementary", {
    name: "External helper details",
  });
  const disable = within(external).getByRole("button", { name: "Disable" });
  expect(within(external).queryByText("Enabled")).toBeNull();
  expect(
    within(external).queryByRole("heading", { name: "Status" }),
  ).toBeNull();
  expect(disable).toHaveAttribute("data-variant", "subtle");
  expect(disable).toHaveAttribute("data-size", "sm");
  expect(within(external).queryByRole("switch")).toBeNull();
  vi.mocked(plugins.change).mockClear();
  fireEvent.click(disable);
  expect(plugins.change).toHaveBeenCalledWith("disable", "example.helper");
  for (const value of ["example.helper", "abc123", "Signed"])
    expect(within(external).getByText(value)).toBeVisible();
  expect(within(external).getAllByText("publisher-public-key")).toHaveLength(2);
  expect(within(external).getByText("Installed")).toBeVisible();
  expect(within(external).queryByText("Made by Buzz")).toBeNull();
  expect(within(external).getByText("tasks")).toBeVisible();
  expect(within(external).queryByText("Essentials")).toBeNull();

  fireEvent.keyDown(external, { key: "Escape" });
  expect(externalCard).toHaveFocus();
  expect(
    screen.queryByRole("complementary", { name: "External helper details" }),
  ).toBeNull();

  const helper = snapshot.configuration.catalog.plugins[1];
  if (!helper) throw new Error("Expected External helper fixture");
  helper.enabled = false;
  fireEvent.click(externalCard);
  const enable = within(
    screen.getByRole("complementary", { name: "External helper details" }),
  ).getByRole("button", { name: "Enable" });
  expect(enable).toHaveAttribute("data-variant", "prominent");
  expect(enable).toHaveAttribute("data-size", "sm");
  const rowEnable = screen.getByRole("button", {
    name: "Enable External helper",
  });
  expect(rowEnable).toHaveAttribute("data-variant", "prominent");
  fireEvent.click(rowEnable);
  expect(plugins.change).toHaveBeenLastCalledWith("enable", "example.helper");
  fireEvent.click(enable);
  expect(plugins.change).toHaveBeenLastCalledWith("enable", "example.helper");
  fireEvent.keyDown(enable, { key: "Escape" });
  helper.publisher = "";
  snapshot.busy = true;
  fireEvent.click(externalCard);
  expect(within(externalCard).queryByText("publisher-public-key")).toBeNull();
  expect(screen.queryByText("Unknown author")).toBeNull();
  const pending = within(
    screen.getByRole("complementary", { name: "External helper details" }),
  ).getByRole("button", { name: "Enable" });
  expect(pending).toHaveAttribute("aria-disabled", "true");
  expect(pending).toHaveAttribute("data-variant", "prominent");
  vi.mocked(plugins.change).mockClear();
  fireEvent.click(pending);
  const pendingRow = screen.getByRole("button", {
    name: "Enable External helper",
  });
  expect(pendingRow).toHaveAttribute("aria-disabled", "true");
  expect(pendingRow).toHaveAttribute("data-variant", "prominent");
  fireEvent.click(pendingRow);
  expect(plugins.change).not.toHaveBeenCalled();
});

// These fixtures exercise catalog updates through the same subscription as the host.
function reviewPluginFixture(
  extra: Partial<Parameters<typeof Settings>[0]> = {},
) {
  const listeners = new Set<() => void>();
  const external = {
    manifest: {
      id: "example.external",
      name: "Zebra external",
      apiVersion: 1,
      discovery: { category: "agents", tags: ["Essentials"] },
    },
    source: "external",
    enabled: true,
    revision: "current",
    previous: null as string | null,
    reloadable: true,
    error: null as string | null,
  };
  let snapshot = {
    configuration: {
      status: "ready",
      externalPluginsPaused: false,
      catalog: {
        profile: "test",
        location: "test",
        plugins: [
          {
            ...external,
            manifest: {
              ...external.manifest,
              id: "buzz.alphabet",
              name: "Alphabet bundled",
              discovery: { category: "agents", tags: [] },
            },
            source: "bundled",
          },
          external,
        ],
      },
    },
    activation: {} as Record<
      string,
      { revision: string; error: string | null }
    >,
    busy: false,
    error: null,
    refreshError: null,
  };
  const publish = () => {
    snapshot = { ...snapshot };
    for (const listener of listeners) listener();
  };
  const manager = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => snapshot,
    change: vi.fn(async (action: string, id: string) => {
      if (action === "remove") {
        snapshot.configuration = {
          ...snapshot.configuration,
          catalog: {
            ...snapshot.configuration.catalog,
            plugins: snapshot.configuration.catalog.plugins.filter(
              (plugin) => plugin.manifest.id !== id,
            ),
          },
        };
        publish();
      }
    }),
  } as unknown as Parameters<typeof Settings>[0]["plugins"];
  const { cards } = registry([]);
  render(<Settings {...host} cards={cards} plugins={manager} {...extra} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  return { external, snapshot, publish, manager };
}

it("keeps bundled plugins free of manual-plugin menus in rows and details", () => {
  reviewPluginFixture();
  expect(
    screen.queryByRole("button", { name: "More actions for Alphabet bundled" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "More actions for Zebra external" }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "View Alphabet bundled details" }),
  );
  const pane = screen.getByRole("complementary", {
    name: "Alphabet bundled details",
  });
  expect(
    within(pane).queryByRole("button", { name: "More plugin actions" }),
  ).toBeNull();
  expect(within(pane).queryByText("Review access")).toBeNull();
});

it("confirms rollback from either menu and retains failures for retry", async () => {
  const user = userEvent.setup();
  const { external, manager } = reviewPluginFixture();
  external.previous = "previous";
  await user.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  await user.click(screen.getByRole("button", { name: "More plugin actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Roll back" }));
  const dialog = await screen.findByRole("alertdialog", {
    name: "Roll back Zebra external?",
  });
  expect(manager.change).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(manager.change).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "More plugin actions" }),
  ).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Close plugin details" }),
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Zebra external" }),
  );
  await user.click(await screen.findByRole("menuitem", { name: "Roll back" }));
  vi.mocked(manager.change).mockResolvedValueOnce(false);
  await user.click(screen.getByRole("button", { name: "Roll back" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Plugin rollback wasn’t confirmed",
  );
  vi.mocked(manager.change).mockResolvedValueOnce(true);
  await user.click(screen.getByRole("button", { name: "Roll back" }));
  expect(manager.change).toHaveBeenLastCalledWith(
    "rollback",
    external.manifest.id,
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("sorts Essentials first and names alphabetically", () => {
  const { snapshot, publish, external } = reviewPluginFixture();
  const bundled = snapshot.configuration.catalog.plugins[0];
  if (!bundled) throw new Error("Missing bundled fixture");
  const essential = {
    ...bundled,
    manifest: {
      ...bundled.manifest,
      name: "Codex",
      discovery: { ...bundled.manifest.discovery, tags: ["Essentials"] },
    },
  };
  snapshot.configuration.catalog = {
    ...snapshot.configuration.catalog,
    plugins: [
      essential,
      external,
      {
        ...bundled,
        manifest: {
          ...bundled.manifest,
          id: "block.builderlab",
          name: "Builderlab",
        },
      },
      {
        ...essential,
        manifest: { ...essential.manifest, id: "buzz.goose", name: "Goose" },
      },
    ],
  };
  act(publish);
  const group = screen.getByRole("region", { name: "Agents4plugins" });
  expect(
    within(group)
      .getAllByRole("button", { name: /^View .* details$/ })
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([
    "View Codex details",
    "View Goose details",
    "View Builderlab details",
    "View Zebra external details",
  ]);
});

it("features bundled Core plugins once, preserving filters, colors and controls", async () => {
  const { snapshot, publish, manager, external } = reviewPluginFixture();
  const bundled = snapshot.configuration.catalog.plugins[0];
  if (!bundled) throw new Error("Missing bundled fixture");
  const core = (
    [
      ["buzz.profiles", "Profiles", "people-and-communities"],
      ["buzz.agents", "Agents", "agents"],
      ["buzz.channels", "Channels", "communication"],
    ] as const
  ).map(([id, name, category]) => ({
    ...bundled,
    manifest: {
      ...bundled.manifest,
      id,
      name,
      description: "A Core plugin.",
      discovery: { category, tags: [" Core ", "Essentials"] },
    },
  }));
  snapshot.configuration.catalog = {
    ...snapshot.configuration.catalog,
    plugins: [
      ...core,
      {
        ...external,
        manifest: {
          ...external.manifest,
          discovery: { category: "agents", tags: ["Core"] },
        },
      },
    ],
  };
  act(publish);
  let content = screen.getByRole("tabpanel");
  const featured = screen.getByRole("region", { name: "Core plugins" });
  await waitFor(() => expect(featured).toBeVisible());
  expect(content).not.toContainElement(featured);
  const tabs = screen.getByRole("tablist", { name: "Plugin filters" });
  expect(
    featured.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    tabs.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(featured)
      .getAllByRole("button", { name: /^View .* details$/ })
      .map((b) => b.getAttribute("aria-label")),
  ).toEqual([
    "View Channels details",
    "View Agents details",
    "View Profiles details",
  ]);
  expect(
    screen.getAllByRole("button", { name: "View Agents details" }),
  ).toHaveLength(1);
  expect(within(featured).queryByText("Zebra external")).toBeNull();
  const trigger = within(featured).getByRole("button", {
    name: "View Agents details",
  });
  expect(trigger).toHaveAccessibleDescription("A Core plugin. Essential");
  expect(trigger.querySelector("[data-category]")).toHaveAttribute(
    "data-category",
    "agents",
  );
  fireEvent.click(trigger);
  expect(
    screen.getByRole("complementary", { name: "Agents details" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close plugin details" }));
  expect(trigger).toHaveFocus();
  fireEvent.click(
    within(featured).getByRole("button", { name: "Disable Agents" }),
  );
  expect(manager.change).toHaveBeenCalledWith("disable", "buzz.agents");
  expect(
    within(featured).getByRole("button", { name: "Required" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("tab", { name: "Essentials" }));
  content = screen.getByRole("tabpanel");
  expect(within(featured).queryAllByRole("article")).toHaveLength(3);
  expect(within(content).queryAllByRole("article")).toHaveLength(0);
  const search = screen.getByRole("searchbox", { name: "Search plugins" });
  fireEvent.change(search, { target: { value: "Profiles" } });
  expect(within(content).queryAllByRole("article")).toHaveLength(0);
  expect(within(featured).queryAllByRole("article")).toHaveLength(3);
  expect(
    within(featured).getByRole("button", { name: "View Profiles details" }),
  ).toBeVisible();
  fireEvent.change(search, { target: { value: "no-match" } });
  expect(within(content).getByText("No other plugins match")).toBeVisible();
  expect(within(featured).queryAllByRole("article")).toHaveLength(3);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "Close plugin details" }));
  expect(trigger).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  content = screen.getByRole("tabpanel");
  snapshot.configuration.catalog = {
    ...snapshot.configuration.catalog,
    plugins: core,
  };
  act(publish);
  expect(within(content).getByText("No other plugins")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

it("omits filter tab semantics when the catalog is unavailable", () => {
  const { cards } = registry([]);
  render(<Settings {...host} cards={cards} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  expect(screen.queryByRole("tablist", { name: "Plugin filters" })).toBeNull();
  expect(screen.queryByRole("tabpanel", { hidden: true })).toBeNull();
});

it("keeps external Essentials tags from granting curated markers or priority", () => {
  reviewPluginFixture();
  const group = screen.getByRole("region", { name: "Agents2plugins" });
  expect(
    within(group)
      .getAllByRole("button", { name: /^View .* details$/ })
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(["View Alphabet bundled details", "View Zebra external details"]);
  expect(within(group).queryByRole("img", { name: "Essential" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  const details = screen.getByRole("complementary", {
    name: "Zebra external details",
  });
  expect(details.querySelector("[data-essential]")).toBeNull();
  expect(
    within(details).getByText("Essentials").closest("tr"),
  ).toHaveTextContent("Tags");
});

it("shows persistent failures without announcing them again when filtering", () => {
  const fixture = reviewPluginFixture();
  act(() => {
    fixture.external.error = "Could not load plugin";
    fixture.publish();
  });
  expect(screen.getByText("Could not load plugin")).toBeVisible();
  const search = screen.getByRole("searchbox", { name: "Search plugins" });
  fireEvent.change(search, { target: { value: "Alphabet" } });
  fireEvent.change(search, { target: { value: "Zebra" } });
  expect(screen.getByText("Could not load plugin")).toBeVisible();
  expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  act(() => {
    fixture.external.error = null;
    fixture.snapshot.activation[fixture.external.manifest.id] = {
      revision: "current",
      error: "Activation failed",
    };
    fixture.publish();
  });
  expect(screen.getByText("Activation failed")).toBeVisible();
  act(() => {
    fixture.external.revision = "next";
    fixture.publish();
  });
  expect(screen.queryByText("Activation failed")).toBeNull();
});

it.each(["row", "pane"])(
  "announces an activation failure once after Enable from the %s, without replaying it on search",
  async (source) => {
    const fixture = reviewPluginFixture();
    act(() => {
      fixture.external.enabled = false;
      fixture.publish();
    });
    if (source === "pane")
      fireEvent.click(
        screen.getByRole("button", { name: "View Zebra external details" }),
      );
    const alert = screen.getByRole("alert");
    expect(alert).toBeEmptyDOMElement();
    fireEvent.click(
      source === "row"
        ? screen.getByRole("button", { name: "Enable Zebra external" })
        : within(
            screen.getByRole("complementary", {
              name: "Zebra external details",
            }),
          ).getByRole("button", { name: "Enable" }),
    );
    expect(fixture.manager.change).toHaveBeenCalledWith(
      "enable",
      "example.external",
    );
    act(() => {
      fixture.external.enabled = true;
      fixture.snapshot.activation[fixture.external.manifest.id] = {
        revision: "old",
        error: "Old activation failure",
      };
      fixture.publish();
    });
    expect(alert).toBeEmptyDOMElement();
    act(() => {
      fixture.snapshot.activation[fixture.external.manifest.id] = {
        revision: "current",
        error: "Activation failed",
      };
      fixture.publish();
    });
    expect(screen.getAllByRole("alert")).toEqual([alert]);
    expect(alert).toHaveTextContent("Zebra external: Activation failed");
    const mutations = vi.fn();
    const observer = new MutationObserver(mutations);
    observer.observe(alert, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    try {
      const user = userEvent.setup();
      const search = screen.getByRole("searchbox", { name: "Search plugins" });
      await user.type(search, "Alphabet");
      await user.clear(search);
      expect(screen.getByRole("alert")).toBe(alert);
      expect(mutations).not.toHaveBeenCalled();
    } finally {
      observer.disconnect();
    }
    act(() => {
      fixture.external.revision = "next";
      fixture.publish();
    });
    expect(alert).toBeEmptyDOMElement();
  },
);

it("keeps a rejected plugin deletion open for retry", async () => {
  const user = userEvent.setup();
  const fixture = reviewPluginFixture();
  vi.mocked(fixture.manager.change).mockResolvedValueOnce(false);
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  await user.click(screen.getByRole("button", { name: "More plugin actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete plugin" }));
  const confirmation = screen.getByRole("alertdialog");
  expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
    "Plugin deletion wasn’t confirmed",
  );
  expect(
    within(confirmation).getByRole("button", { name: "Delete plugin" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("complementary", {
      name: "Zebra external details",
      hidden: true,
    }),
  ).toBeInTheDocument();
});

it("returns focus to the Plugins section when the selected plugin is deleted", async () => {
  const user = userEvent.setup();
  const fixture = reviewPluginFixture();
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  const details = screen.getByRole("complementary", {
    name: "Zebra external details",
  });
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  const remove = screen.getByRole("button", { name: "More plugin actions" });
  expect(details).toContainElement(remove);
  remove.focus();
  await user.click(remove);
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(fixture.manager.change).not.toHaveBeenCalledWith(
    "remove",
    "example.external",
  );
  const confirmation = screen.getByRole("alertdialog", {
    name: "Delete Zebra external?",
  });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await user.click(remove);
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete plugin" }));
  expect(fixture.manager.change).toHaveBeenCalledWith(
    "remove",
    "example.external",
  );
  await waitFor(() => {
    expect(
      screen.queryByRole("complementary", { name: "Zebra external details" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Manage plugins" }),
    ).toHaveFocus();
  });
});

it("uses contributed icons in community and account navigation", () => {
  const { cards } = registry([
    { ...card("groups", "Personal groups"), icon: FolderSimpleIcon },
    { ...card("hosted", "Hosted communities", "Communities"), icon: GlobeIcon },
    card("other", "Other settings"),
  ]);
  render(<Settings {...host} cards={cards} />);
  expect(
    screen
      .getByRole("button", { name: "Personal groups" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-folder");
  expect(
    screen
      .getByRole("button", { name: "Hosted communities" })
      .querySelector("svg"),
  ).toHaveClass("tabler-icon-world");
  expect(
    screen.getByRole("button", { name: "Other settings" }).querySelector("svg"),
  ).toHaveClass("tabler-icon-message-circle");
});

it("keeps grouped cards available without a selected community", () => {
  const { cards } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
    { ...card("mobile", "Pair mobile"), personal: true },
  ]);
  const noCommunityState = { ...communityState, selected: null };
  render(
    <Settings
      {...host}
      communities={
        {
          retainPresentation: () => () => {},
          subscribe: () => () => {},
          snapshot: () => noCommunityState,
          relay,
        } as unknown as Parameters<typeof Settings>[0]["communities"]
      }
      cards={cards}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("Communities");
  expect(nav).toHaveTextContent("Personal space");
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Personal groups" })).toBeNull();
  // Personal-space pairing collects its own address and has no community.
  fireEvent.click(screen.getByRole("button", { name: "Pair mobile" }));
  expect(screen.getByText("Pair mobile body")).toBeVisible();
});

it("shows administration only within a selected community", () => {
  const membership = card(
    "membership",
    "Membership",
    undefined,
    "administration",
  );
  const { cards } = registry([membership]);
  const view = render(<Settings {...host} cards={cards} />);
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("primary.example");
  expect(nav).toHaveTextContent("Community admin");
  fireEvent.click(screen.getByRole("button", { name: "Membership" }));
  expect(screen.getByText("Membership body for Primary")).toBeVisible();

  const noCommunityState = { ...communityState, selected: null };
  const noCommunity = {
    retainPresentation: () => () => {},
    subscribe: () => () => {},
    snapshot: () => noCommunityState,
    relay,
  } as unknown as Parameters<typeof Settings>[0]["communities"];
  view.rerender(<Settings {...host} communities={noCommunity} cards={cards} />);
  expect(nav).not.toHaveTextContent("Community admin");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  expect(screen.queryByText("Membership body")).toBeNull();
});

it("opens Manage plugins from the Decisions API hint", async () => {
  const user = userEvent.setup();
  const { cards } = registry([]);
  const providers: never[] = [];
  const decisions = {
    backend: () => undefined,
    providers: () => providers,
    subscribe: () => () => {},
    setBackend: vi.fn(),
  } as unknown as DecisionsService;
  const onSection = vi.fn();
  const view = (section: string) => (
    <Settings
      {...host}
      cards={cards}
      decisions={decisions}
      navigation={
        {
          target: { version: 1, kind: "settings", section },
          complete: () => true,
        } as never
      }
      onSection={onSection}
    />
  );
  const { rerender } = render(view("decisions"));
  const section = await screen.findByRole("region", { name: "Decisions API" });
  await user.click(
    within(section).getByRole("button", { name: "Manage plugins" }),
  );
  expect(onSection).toHaveBeenCalledExactlyOnceWith("plugins");
  // The link is hidden with its section, so focus moves into the one it opened.
  rerender(view("plugins"));
  expect(screen.getByRole("region", { name: "Manage plugins" })).toHaveFocus();
});

it("gives contributed cards their own community sections and retires removed cards", async () => {
  const { cards, set } = registry([
    card("hosted", "Hosted communities", "Communities"),
    card("groups", "Personal groups"),
  ]);
  const complete = vi.fn(() => true);
  const onSection = vi.fn();
  render(
    <Settings
      {...host}
      cards={cards}
      navigation={
        {
          target: {
            version: 1,
            kind: "settings",
            section: "example/hosted",
          },
          complete,
        } as never
      }
      onSection={onSection}
    />,
  );
  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).toHaveTextContent("primary.example");
  expect(nav).toHaveTextContent("Communities");
  expect(await screen.findByText("Hosted communities body")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Hosted communities" }),
  ).toHaveAttribute("aria-current", "page");
  expect(screen.queryByText("Personal groups body")).toBeNull();
  expect(complete).toHaveBeenLastCalledWith({ status: "opened" });

  act(() => set([card("groups", "Personal groups")]));
  await waitFor(() => expect(onSection).toHaveBeenLastCalledWith("profile"));
  expect(screen.queryByText("Hosted communities body")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(nav).not.toHaveTextContent("Hosted communities");
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
});

it("keeps same-id community cards from different plugins distinct", () => {
  const { cards } = registry([
    card("groups", "Example groups"),
    {
      ...card("groups", "Other groups"),
      key: "other/groups",
      pluginId: "other",
    },
  ]);
  render(<Settings {...host} cards={cards} />);
  fireEvent.click(screen.getByRole("button", { name: "Other groups" }));
  expect(screen.getByText("Other groups body for Primary")).toBeVisible();
  expect(screen.queryByText("Example groups body for Primary")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Example groups" }),
  ).not.toHaveAttribute("aria-current");
});

it("keeps Community admin hidden after applying a verified ordinary-member roster", async () => {
  const viewer = "a".repeat(64);
  const relayAuthor = "f".repeat(64);
  let resolveRoster!: (events: unknown[]) => void;
  const roster = new Promise<unknown[]>((resolve) => {
    resolveRoster = resolve;
  });
  const membership = createCommunityMembership({
    snapshot: () => ({
      status: "ready",
      generation: 1,
      scope: `https://primary.example:${viewer}`,
      viewer,
      session: {
        relayAuthor,
        read: () => roster,
        profiles: { ensure: vi.fn(async () => {}) },
      },
    }),
    subscribe: () => () => {},
  } as unknown as RelayData);
  const root = new Context();
  root.provide("pluginStatus", {
    isActive: () => true,
    subscribe: () => () => {},
  });
  const cards = new SettingsCardsService(root);
  const scope = root.extend({
    pluginOwner: { id: "moderation", revision: "one" },
  });
  const fiber = scope.plugin((ctx) => {
    ctx.settingsCards.register({
      id: "membership",
      title: "Membership",
      section: "administration",
      visibility: {
        snapshot: () => {
          const state = membership.snapshot();
          return (
            state.status === "ready" &&
            (state.role === "owner" || state.role === "admin")
          );
        },
        subscribe: membership.subscribe,
        ensure: membership.ensure,
      },
      component: () => <p>Membership body</p>,
    });
  });
  await fiber.await();
  render(<Settings {...host} cards={cards} />);
  expect(membership.snapshot().status).toBe("loading");

  resolveRoster([
    {
      id: "1".repeat(64),
      kind: 13534,
      pubkey: relayAuthor,
      created_at: 1,
      content: "",
      sig: "",
      tags: [["member", viewer, "member"]],
    },
  ]);
  await waitFor(() =>
    expect(membership.snapshot()).toMatchObject({
      status: "ready",
      role: "member",
      refreshing: false,
    }),
  );

  const nav = screen.getByRole("navigation", { name: "Settings sections" });
  expect(nav).not.toHaveTextContent("Community admin");
  expect(screen.queryByRole("button", { name: "Membership" })).toBeNull();
  await fiber.dispose();
  membership.dispose();
  await root.fiber.dispose();
});

it.each(["primary", null])(
  "presents the same Settings groups in both navigations (%s)",
  (selected) => {
    const { cards } = registry([
      card("groups", "Example groups"),
      card("membership", "Membership", undefined, "administration"),
      card("hosted", "Hosted communities", "Communities"),
    ]);
    const state = { ...communityState, selected };
    const connection = { scope: "settings-parity-test" };
    const communities = {
      retainPresentation: () => () => {},
      subscribe: () => () => {},
      snapshot: () => state,
      relay: {
        subscribe: () => () => {},
        snapshot: () => connection,
      },
    } as unknown as Parameters<typeof Settings>[0]["communities"];
    render(<Settings {...host} communities={communities} cards={cards} />);
    render(
      <nav aria-label="Settings sections">
        <SettingsSidebar
          cards={cards}
          communities={communities}
          onSection={() => {}}
        />
      </nav>,
    );
    const [standalone, shell] = screen.getAllByRole("navigation", {
      name: "Settings sections",
    });
    const outline = (nav: HTMLElement) =>
      [...nav.querySelectorAll("section")].map((group) => [
        group.querySelector("h2")?.textContent,
        [...group.querySelectorAll("button")].map(
          (button) => button.textContent,
        ),
        [...group.querySelectorAll("button[aria-current]")].map(
          (button) => button.textContent,
        ),
      ]);
    expect(outline(standalone as HTMLElement)).toEqual(
      outline(shell as HTMLElement),
    );
    expect(outline(standalone as HTMLElement).map(([label]) => label)).toEqual([
      ...(selected
        ? [undefined, "Community", "Community admin"]
        : ["Personal space"]),
      "Buzz",
      "Plugins",
      "Communities",
    ]);
    // Existing presentations differ only in the contributed-group icon.
    const hosted = (nav: HTMLElement) =>
      within(nav).getByRole("button", { name: "Hosted communities" });
    expect(hosted(standalone as HTMLElement).querySelector("svg")).toBeNull();
    expect(hosted(shell as HTMLElement).querySelector("svg")).not.toBeNull();
  },
);

it("renders a bundled plugin's README below its status, never an external one's", () => {
  const { cards } = registry([]);
  const plugin = (source: "bundled" | "external") => ({
    manifest: {
      id: source === "bundled" ? "buzz.channels" : "example.helper",
      name: source === "bundled" ? "Channels" : "Helper",
      apiVersion: 1 as const,
      description: "One-line description.",
    },
    source,
    enabled: true,
    revision: source,
    previous: null,
    reloadable: false,
    error: null,
  });
  const snapshot = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: {
        profile: "test",
        location: "test",
        plugins: [plugin("bundled"), plugin("external")],
      },
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  const plugins = {
    subscribe: () => () => {},
    snapshot: () => snapshot,
    change: vi.fn(),
    reload: vi.fn(),
    dismissError: vi.fn(),
  } as unknown as Parameters<typeof Settings>[0]["plugins"];

  render(<Settings {...host} cards={cards} plugins={plugins} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  fireEvent.click(
    screen.getByRole("button", { name: "View Channels details" }),
  );
  const bundled = screen.getByRole("complementary", {
    name: "Channels details",
  });
  const about = within(bundled).getByRole("region", {
    name: "Channels README",
  });
  expect(
    within(bundled)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(["Getting started", "Details"]);
  // The title is not repeated; the summary stays beneath the author badge.
  expect(within(bundled).getAllByText("Channels")).toHaveLength(1);
  const summary = within(bundled).getByText("One-line description.");
  expect(summary).toBeVisible();
  expect(summary.parentElement).toContainElement(
    within(bundled).getByText("Made by Buzz"),
  );
  expect(within(about).getByText("Hold conversations.")).toBeVisible();
  expect(
    within(about).getByRole("heading", { name: "Getting started", level: 3 }),
  ).toBeVisible();
  expect(within(about).getByRole("link", { name: "the site" })).toHaveAttribute(
    "href",
    "https://example.com/",
  );
  expect(within(about).queryByRole("link", { name: "the spec" })).toBeNull();
  expect(about).toHaveTextContent("Read the spec or the site.");
  expect(about).toHaveTextContent("Raw markup is dropped.");
  expect(about.querySelector("b")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "View Helper details" }));
  const external = screen.getByRole("complementary", {
    name: "Helper details",
  });
  expect(within(external).queryByRole("heading", { name: "About" })).toBeNull();
  expect(within(external).queryByText("Not from Buzz.")).toBeNull();
  expect(within(external).getByText("One-line description.")).toBeVisible();
});

it("keeps related plugins out of the pane even when tags overlap", () => {
  const { cards } = registry([]);
  const plugin = (
    id: string,
    name: string,
    category: string,
    tags: string[],
    source: "bundled" | "external" = "bundled",
  ) => ({
    manifest: {
      id,
      name,
      apiVersion: 1 as const,
      discovery: { category, tags },
    },
    source,
    enabled: true,
    revision: id,
    previous: null,
    reloadable: false,
    error: null,
  });
  const snapshot = {
    configuration: {
      status: "ready" as const,
      externalPluginsPaused: false,
      catalog: {
        profile: "test",
        location: "test",
        plugins: [
          plugin("buzz.profiles", "Profiles", "people-and-communities", [
            "people",
          ]),
          plugin("buzz.todos", "Todos", "productivity", ["tasks"]),
          plugin("buzz.mentions", "Mentions", "communication", [
            "messaging",
            "people",
          ]),
          plugin("buzz.channels", "Channels", "communication", ["messaging"]),
          plugin(
            "example.helper",
            "Helper",
            "communication",
            ["messaging"],
            "external",
          ),
        ],
      },
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  const plugins = {
    imports: {
      checkFolder: vi.fn(async () => "updated"),
      previewFolder: vi.fn(),
      folder: vi.fn(),
      files: vi.fn(),
      git: vi.fn(),
      discard: vi.fn(),
    },
    subscribe: () => () => {},
    snapshot: () => snapshot,
    change: vi.fn(),
    reload: vi.fn(),
    dismissError: vi.fn(),
  } as unknown as Parameters<typeof Settings>[0]["plugins"];
  const related = (name: string) => {
    const pane = screen.getByRole("complementary", { name: `${name} details` });
    const section = within(pane)
      .queryByRole("heading", { name: "Related plugins" })
      ?.closest("section");
    return section
      ? within(section as HTMLElement)
          .getAllByRole("button")
          .map((button) => button.textContent)
      : [];
  };

  render(<Settings {...host} cards={cards} plugins={plugins} />);
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  const header = screen
    .getByRole("heading", { name: "Manage plugins" })
    .closest("[data-buzz-ui]");
  expect(header).toContainElement(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(
    screen.getByRole("button", { name: "View Channels details" }),
  );
  expect(related("Channels")).toEqual([]);

  fireEvent.click(
    screen.getByRole("button", { name: "View Mentions details" }),
  );
  expect(related("Mentions")).toEqual([]);
  expect(
    screen.getByRole("button", { name: "View Mentions details" }),
  ).toHaveAttribute("aria-expanded", "true");

  fireEvent.click(screen.getByRole("button", { name: "View Todos details" }));
  expect(related("Todos")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "View Helper details" }));
  expect(related("Helper")).toEqual([]);
});

it("retains departure confirmation until local cleanup settles", async () => {
  let client: ClientSnapshot = {
    ...communityState,
    status: "ready",
    relayAvailable: true,
  };
  const listeners = new Set<() => void>();
  let finish!: () => void;
  const cleanupFinished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const leave = vi.fn(async () => {
    client = { ...client, selected: null, memberships: [] };
    for (const listener of listeners) listener();
    await cleanupFinished;
    return [];
  });
  const { cards } = registry([]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <Settings
        {...host}
        cards={cards}
        communities={{
          ...host.communities,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          snapshot: () => client,
          leave,
        }}
      />
    </ToastProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Leave or remove" }));
  await user.click(
    screen.getByRole("button", { name: "Remove from this device" }),
  );
  try {
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Remove from this device",
      }),
    );
    await waitFor(() => expect(leave).toHaveBeenCalledOnce());
    expect(client.memberships).toEqual([]);
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    ).toBeDisabled();
  } finally {
    await act(async () => finish());
  }
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.getByRole("button", { name: "Profile" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(screen.queryByRole("button", { name: "Leave or remove" })).toBeNull();
  expect(
    screen.getByText(
      "Primary — https://primary.example was removed from this device. Your membership wasn’t changed. You can add it again later.",
    ),
  ).toBeVisible();
});

it("focuses details on open and restores the row after Escape", () => {
  reviewPluginFixture();
  const row = screen.getByRole("button", {
    name: "View Zebra external details",
  });
  row.focus();
  fireEvent.click(row);
  expect(
    screen.getByRole("button", { name: "Close plugin details" }),
  ).toHaveFocus();
  fireEvent.keyDown(
    screen.getByRole("complementary", { name: "Zebra external details" }),
    { key: "Escape" },
  );
  expect(
    screen.queryByRole("complementary", { name: "Zebra external details" }),
  ).toBeNull();
  expect(row).toHaveFocus();
});

it("keeps navigation focus when returning to Plugins after viewing details", () => {
  reviewPluginFixture();
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Profile" }));
  const plugins = screen.getByRole("button", { name: "Manage plugins" });
  plugins.focus();
  fireEvent.click(plugins);
  expect(
    screen.queryByRole("complementary", { name: "Zebra external details" }),
  ).toBeNull();
  expect(plugins).toHaveFocus();
});

it("announces the selected plugin's failure only once", () => {
  const fixture = reviewPluginFixture();
  fixture.external.error = "Activation failed";
  fixture.publish();
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent("Activation failed");
  expect(screen.getAllByText("Activation failed")).toHaveLength(2);
});

it("describes plugin rows with their supporting copy, publisher and curated marker", () => {
  const fixture = reviewPluginFixture();
  Object.assign(fixture.external.manifest, {
    description: "Works with agents",
  });
  Object.assign(fixture.external, { publisher: "publisher-key" });
  const bundled = fixture.snapshot.configuration.catalog.plugins[0];
  if (!bundled) throw new Error("Missing bundled fixture");
  bundled.manifest.discovery.tags = ["essentials"];
  act(() => fixture.publish());
  expect(
    screen.getByRole("button", { name: "View Zebra external details" }),
  ).toHaveAccessibleDescription("Works with agents publisher-key");
  expect(
    screen.getByRole("button", { name: "View Alphabet bundled details" }),
  ).toHaveAccessibleDescription("Essential");
});

it("restores the Plugins region when the closed detail row was filtered out", () => {
  reviewPluginFixture();
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "Search plugins" }), {
    target: { value: "Alphabet" },
  });
  fireEvent.keyDown(
    screen.getByRole("complementary", { name: "Zebra external details" }),
    {
      key: "Escape",
    },
  );
  expect(screen.getByRole("region", { name: "Manage plugins" })).toHaveFocus();
});

it("announces a new action failure while inspecting another failed plugin", () => {
  const fixture = reviewPluginFixture();
  const bundled = fixture.snapshot.configuration.catalog.plugins[0];
  if (!bundled) throw new Error("Missing bundled fixture");
  bundled.error = "Bundled plugin failed";
  fixture.external.enabled = false;
  act(fixture.publish);
  fireEvent.click(
    screen.getByRole("button", { name: "View Alphabet bundled details" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Alphabet bundled: Bundled plugin failed",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Enable Zebra external" }),
  );
  act(() => {
    fixture.external.enabled = true;
    fixture.snapshot.activation[fixture.external.manifest.id] = {
      revision: "current",
      error: "New activation failure",
    };
    fixture.publish();
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Zebra external: New activation failure",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "View Alphabet bundled details" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Alphabet bundled: Bundled plugin failed",
  );
});

it("restores a selected row remounted by clearing search", async () => {
  reviewPluginFixture();
  const user = userEvent.setup();
  const original = screen.getByRole("button", {
    name: "View Zebra external details",
  });
  fireEvent.click(original);
  const search = screen.getByRole("searchbox", { name: "Search plugins" });
  await user.type(search, "Alphabet");
  expect(
    screen.queryByRole("button", { name: "View Zebra external details" }),
  ).toBeNull();
  await waitFor(() => expect(original).not.toBeInTheDocument());
  await user.clear(search);
  const restored = screen.getByRole("button", {
    name: "View Zebra external details",
  });
  fireEvent.click(screen.getByRole("button", { name: "Close plugin details" }));
  expect(restored).toHaveFocus();
});

it.each(["buzz.moderation", "buzz.relay-staff"])(
  "keeps %s details openable while access gates only Enable",
  async (id) => {
    const listeners = new Set<() => void>();
    let state: import("../bundled/admin-access").AdminAccessState = "checking";
    const release = vi.fn();
    const retry = vi.fn();
    const adminAccess = {
      subscribe(f: () => void) {
        listeners.add(f);
        return () => {
          listeners.delete(f);
        };
      },
      ensure: () => release,
      status: () => state,
      retry,
    };
    const f = reviewPluginFixture({ adminAccess });
    const restricted = {
      ...f.external,
      source: "bundled",
      enabled: false,
      manifest: { ...f.external.manifest, id, name: "Restricted plugin" },
    };
    act(() => {
      f.snapshot.configuration.catalog.plugins = [restricted];
      f.publish();
    });
    const user = userEvent.setup();
    const action = screen.getByRole("button", {
      name: "Enable Restricted plugin",
    });
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAttribute("data-variant", "outline");
    expect(action).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(action).toHaveAccessibleDescription("Checking access…");
    await user.hover(action);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Checking access…",
    );
    expect(action).toHaveAccessibleDescription(/Checking access…/);
    await user.unhover(action);
    await user.click(action);
    action.focus();
    await user.keyboard("{Enter}");
    expect(f.manager.change).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "View Restricted plugin details" }),
    );
    const pane = screen.getByRole("complementary", {
      name: "Restricted plugin details",
    });
    const enable = within(pane).getByRole("button", {
      name: "Enable",
    });
    expect(enable).toHaveAttribute("aria-disabled", "true");
    expect(enable).toHaveAttribute("data-variant", "outline");
    expect(enable).toHaveAccessibleDescription("Checking access…");
    expect(enable).toHaveAttribute("aria-describedby", "plugin-detail-access");
    await user.hover(enable);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Checking access…",
    );
    expect(enable).toHaveAccessibleDescription(/Checking access…/);
    await user.unhover(enable);
    for (const next of [
      "denied",
      "no-community",
      "unavailable",
      "error",
    ] as const) {
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      });
      const reason =
        next === "denied"
          ? id === "buzz.moderation"
            ? "Select a community where you’re an owner or admin."
            : "Select a community on a relay where you have staff access."
          : next === "no-community"
            ? "Select a community to check access."
            : next === "error"
              ? "Could not check access. Try again."
              : "Access is unavailable in this build or on this relay.";
      expect(document.getElementById("plugin-detail-access")).toHaveTextContent(
        reason,
      );
      expect(enable).toHaveAttribute(
        "aria-describedby",
        expect.stringContaining("plugin-detail-access"),
      );
      expect(enable).toHaveAccessibleName("Unavailable");
      expect(action).toHaveAccessibleName("Unavailable Restricted plugin");
      expect(enable).toHaveAttribute("aria-disabled", "true");
      expect(action).toHaveAttribute("aria-disabled", "true");
      await user.click(enable);
      expect(f.manager.change).not.toHaveBeenCalled();
    }
    await user.click(
      screen.getByRole("button", { name: "Check access again" }),
    );
    expect(retry).toHaveBeenCalledWith(id);
    expect(enable).toHaveFocus();
    act(() => {
      state = "checking";
      for (const listener of listeners) listener();
    });
    expect(enable).toHaveFocus();
    act(() => {
      state = "allowed";
      for (const listener of listeners) listener();
    });
    expect(within(pane).getByRole("button", { name: /^Enable$/ })).toBe(enable);
    expect(enable).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Enable Restricted plugin" }),
    ).toBe(action);
    expect(enable).not.toHaveAttribute("aria-disabled", "true");
    await user.click(enable);
    expect(f.manager.change).toHaveBeenCalledWith("enable", id);
    act(() => {
      restricted.enabled = true;
      state = "error";
      f.publish();
      for (const listener of listeners) listener();
    });
    const disable = within(pane).getByRole("button", {
      name: /^Disable$/,
    });
    expect(disable).not.toHaveAttribute("aria-disabled", "true");
    expect(
      screen.queryByRole("button", { name: "Check access again" }),
    ).toBeInTheDocument();
    expect(disable).toHaveAccessibleDescription(/Could not check access/);
    expect(
      within(pane).getByText("Unavailable", { exact: true }),
    ).toBeVisible();
    for (const next of [
      "checking",
      "denied",
      "no-community",
      "unavailable",
      "error",
    ] as const) {
      act(() => {
        state = next;
        for (const listener of listeners) listener();
      });
      expect(disable).toHaveAccessibleName("Disable");
      expect(disable).not.toHaveAttribute("aria-disabled", "true");
      expect(
        within(pane).getByText(
          next === "checking" ? "Checking…" : "Unavailable",
          { exact: true },
        ),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Disable Restricted plugin" }),
      ).not.toHaveAttribute("aria-disabled", "true");
    }
    await user.click(disable);
    expect(f.manager.change).toHaveBeenLastCalledWith("disable", id);
    disable.focus();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("complementary", {
        name: "Restricted plugin details",
      }),
    ).not.toBeInTheDocument();
    cleanup();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it("keeps identity independent of community profile and clears revealed keys on destination changes", async () => {
  const exportKey = vi.fn().mockResolvedValue("nsec-public-test-fixture");
  const { cards } = registry([]);
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <Settings
        {...host}
        cards={cards}
        identity={
          {
            exportKey,
            // No backup status: the row stays hidden.
            backup: {
              subscribe: () => () => {},
              snapshot: () => undefined,
              ready: () => new Promise(() => {}),
            },
          } as unknown as Parameters<typeof Settings>[0]["identity"]
        }
      />
    </ToastProvider>,
  );
  expect(exportKey).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Reveal private key" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Identity" }));
  await user.click(screen.getByRole("button", { name: "Reveal private key" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "nsec-public-test-fixture",
  );
  await user.click(screen.getByRole("button", { name: "Appearance" }));
  expect(screen.queryByLabelText("Private key (nsec)")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Identity" }));
  expect(screen.getByLabelText("Private key (nsec)")).toHaveValue(
    "••••••••••••••••",
  );
  expect(exportKey).toHaveBeenCalledTimes(1);
});

it("offers Retry beside a failed installed revision without changing saved state", () => {
  const fixture = reviewPluginFixture();
  const retryPlugin = vi.fn(() => true);
  Object.assign(fixture.manager, { retryPlugin });
  Object.assign(fixture.snapshot.activation, {
    [fixture.external.manifest.id]: {
      revision: "current",
      status: "failed",
      error: "Temporary startup failure",
    },
  });
  act(fixture.publish);
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  const pane = screen.getByRole("complementary", {
    name: "Zebra external details",
  });
  const retry = within(pane).getByRole("button", {
    name: /^Retry$/,
  });
  expect(retry.parentElement).toContainElement(
    within(pane).getByText("Temporary startup failure"),
  );
  fireEvent.click(retry);
  expect(retryPlugin).toHaveBeenCalledExactlyOnceWith(
    fixture.external.manifest.id,
  );
  expect(fixture.manager.change).not.toHaveBeenCalled();
  expect(within(pane).queryByRole("button", { name: "Reload" })).toBeNull();
  Object.assign(fixture.snapshot.activation, {
    [fixture.external.manifest.id]: {
      revision: "current",
      status: "starting",
      error: null,
    },
  });
  act(fixture.publish);
  expect(within(pane).queryByRole("button", { name: /^Retry$/ })).toBeNull();
});

it("retains both local drafts across section navigation but retires them with their account or community", async () => {
  const priorNative = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", {
    configurable: true,
    value: true,
  });
  try {
    const { cards } = registry([]);
    let snapshot: ClientSnapshot = {
      ...communityState,
      status: "ready",
      relayAvailable: false,
    };
    const communities = {
      ...host.communities,
      snapshot: () => snapshot,
    };
    const view = render(
      <Settings {...host} cards={cards} communities={communities} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Local settings" }));
    await user.type(screen.getByLabelText("Display name"), "Unsaved name");
    await user.type(
      screen.getByLabelText("Repositories folder"),
      "/unsaved/repos",
    );
    await user.click(screen.getByRole("button", { name: "Profile" }));
    expect(screen.queryByRole("region", { name: "Local settings" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Local settings" }));
    expect(screen.getByLabelText("Display name")).toHaveValue("Unsaved name");
    expect(screen.getByLabelText("Repositories folder")).toHaveValue(
      "/unsaved/repos",
    );
    snapshot = {
      ...snapshot,
      selected: "https://other.example",
      memberships: [{ id: "https://other.example", name: "Other" }],
    };
    view.rerender(
      <Settings {...host} cards={cards} communities={communities} />,
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("");
    expect(screen.getByLabelText("Repositories folder")).toHaveValue("");
    await user.type(screen.getByLabelText("Display name"), "Other draft");
    await user.type(
      screen.getByLabelText("Repositories folder"),
      "/other/draft",
    );
    snapshot = { ...snapshot, viewer: "cd".repeat(32) };
    view.rerender(
      <Settings {...host} cards={cards} communities={communities} />,
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("");
    expect(screen.getByLabelText("Repositories folder")).toHaveValue("");
  } finally {
    if (priorNative) Object.defineProperty(globalThis, "isTauri", priorNative);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

it("allows Add to install while an independent folder check is pending, including pane remount", async () => {
  let finish!: (revision: string) => void;
  const fixture = reviewPluginFixture();
  const checkFolder = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const preview = {
    token: "add",
    source: "/new",
    commit: null,
    warnings: [],
    candidates: [
      {
        path: "dist",
        revision: "new",
        manifest: {
          id: "example.new",
          name: "New plugin",
          apiVersion: 1 as const,
        },
      },
    ],
  };
  const folder = vi.fn(async () => preview);
  const discard = vi.fn(async () => {});
  const installImport = vi.fn(async () => true);
  Object.assign(fixture.external, {
    updateSource: { root: "/plugins", path: "dist" },
  });
  Object.assign(fixture.manager, {
    imports: { checkFolder, folder, discard },
    installImport,
  });
  act(fixture.publish);
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  await waitFor(() => expect(checkFolder).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a plugin" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Browse plugin folder" }),
  );
  await within(dialog).findByRole("button", { name: "Install plugin" });
  fixture.external.revision = "cli-reloaded";
  act(fixture.publish);
  await act(async () => finish("current"));
  expect(discard).not.toHaveBeenCalled();
  fireEvent.click(
    within(dialog).getByRole("switch", { name: "Enable plugin" }),
  );
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Install plugin" }),
  );
  await waitFor(() =>
    expect(installImport).toHaveBeenCalledExactlyOnceWith("add", "dist"),
  );
});

const pinned = "0123456789abcdef0123456789abcdef01234567";
const managedPolicy = (...states: ("missing" | "current" | "outdated")[]) => ({
  status: "ready" as const,
  path: "/data/managed-plugins.json",
  source: "Example Org",
  problems: [],
  plugins: states.map((state, index) => ({
    id:
      index === 0 && state !== "missing"
        ? "example.external"
        : `example.managed${index}`,
    repository: "https://example.com/plugins",
    reference: "v1",
    commit: pinned,
    path: "dist",
    state,
  })),
});

it("recommends managed plugins in Settings and points to them from navigation", async () => {
  const git = vi.fn(async () => ({
    token: "managed",
    source: "https://example.com/plugins",
    commit: pinned,
    warnings: [],
    candidates: [
      {
        path: "dist",
        revision: "new",
        manifest: {
          id: "example.managed0",
          name: "Managed",
          apiVersion: 1 as const,
        },
      },
    ],
  }));
  const fixture = reviewPluginFixture({
    communities: {
      ...host.communities,
      relay: { subscribe: () => () => {}, snapshot: () => connecting },
    } as never,
  });
  Object.assign(fixture.manager, {
    imports: { git, discard: vi.fn(async () => {}) },
    installImport: vi.fn(async () => true),
  });
  Object.assign(fixture.snapshot.configuration, {
    managed: managedPolicy("missing"),
  });
  act(fixture.publish);
  expect(
    screen.getByRole("button", { name: /Manage plugins/ }),
  ).toHaveTextContent("1 recommended plugin");
  const group = screen.getByRole("region", {
    name: "Recommended by Example Org",
  });
  fireEvent.click(
    within(group).getByRole("button", {
      name: "Review and install example.managed0",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Review plugin access",
  });
  await within(dialog).findByRole("button", { name: "Install plugin" });
  expect(git).toHaveBeenCalledWith(
    "https://example.com/plugins",
    "v1",
    undefined,
    pinned,
  );
});

it("marks installed managed plugins and keeps the badge only for pending work", () => {
  const fixture = reviewPluginFixture();
  Object.assign(fixture.snapshot.configuration, {
    managed: managedPolicy("current"),
  });
  act(fixture.publish);
  expect(
    screen.getByRole("button", { name: /Manage plugins/ }),
  ).not.toHaveTextContent("recommended");
  expect(screen.queryByRole("region", { name: /Recommended by/ })).toBeNull();
  const row = screen.getByRole("button", {
    name: "View Zebra external details",
  });
  expect(row).toHaveAccessibleDescription(/Managed by Example Org/);
  fireEvent.click(row);
  expect(
    within(
      screen.getByRole("complementary", { name: "Zebra external details" }),
    ).getByText("Managed by Example Org"),
  ).toBeVisible();
});

it("offers Review update for a managed plugin whose pinned commit changed", () => {
  const fixture = reviewPluginFixture();
  Object.assign(fixture.manager, {
    imports: { git: vi.fn(), discard: vi.fn() },
  });
  Object.assign(fixture.snapshot.configuration, {
    managed: managedPolicy("outdated"),
  });
  act(fixture.publish);
  expect(
    screen.getByRole("button", { name: /Manage plugins/ }),
  ).toHaveTextContent("1 recommended plugin");
  expect(
    screen.getByRole("button", { name: "Review update example.external" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "View Zebra external details" }),
  ).toHaveAccessibleDescription(/Managed by Example Org/);
});

it("hides managed recommendations where plugins cannot be imported", () => {
  const fixture = reviewPluginFixture();
  Object.assign(fixture.snapshot.configuration, {
    managed: managedPolicy("missing"),
  });
  act(fixture.publish);
  expect(screen.queryByRole("region", { name: /Recommended by/ })).toBeNull();
});

it("routes a managed plugin's updates through the managed review instead of the reference tip", async () => {
  const manifest = {
    id: "example.external",
    name: "Zebra external",
    apiVersion: 1 as const,
  };
  const git = vi.fn(async () => ({
    token: "pinned",
    source: "https://example.com/plugins",
    commit: pinned,
    warnings: [],
    candidates: [{ path: "dist", revision: "pinned-revision", manifest }],
  }));
  const checkGit = vi.fn(async () => {
    throw new Error("the reference tip must not be checked");
  });
  const fixture = reviewPluginFixture({
    communities: {
      ...host.communities,
      relay: { subscribe: () => () => {}, snapshot: () => connecting },
    } as never,
  });
  const external = fixture.snapshot.configuration.catalog.plugins[1];
  Object.assign(external as object, {
    updateSource: {
      repository: "https://example.com/plugins",
      reference: "v1",
      path: "dist",
    },
  });
  Object.assign(fixture.manager, {
    imports: { git, checkGit, discard: vi.fn(async () => {}) },
    installImport: vi.fn(async () => true),
  });
  Object.assign(fixture.snapshot.configuration, {
    managed: managedPolicy("outdated"),
  });
  act(fixture.publish);
  fireEvent.click(
    screen.getByRole("button", { name: "View Zebra external details" }),
  );
  const details = screen.getByRole("complementary", {
    name: "Zebra external details",
  });
  expect(
    within(details).getByText(/Example Org recommends a different version/),
  ).toBeVisible();
  expect(
    within(details).queryByRole("button", {
      name: /Check for updates|^Update/,
    }),
  ).toBeNull();
  fireEvent.click(
    within(details).getByRole("button", { name: "Review update" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Update Zebra external",
  });
  await within(dialog).findByRole("button", { name: "Update" });
  expect(git).toHaveBeenCalledWith(
    "https://example.com/plugins",
    "v1",
    undefined,
    pinned,
  );
  expect(checkGit).not.toHaveBeenCalled();
});

function installRequestFixture(imports: object | undefined) {
  const { cards } = registry([]);
  const snapshot = {
    configuration: {
      status: "ready",
      externalPluginsPaused: false,
      catalog: { profile: "test", location: "test", plugins: [] },
    },
    activation: {},
    busy: false,
    error: null,
    refreshError: null,
  };
  const plugins = {
    imports,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    change: vi.fn(async () => true),
    dismissError: vi.fn(),
  } as unknown as Parameters<typeof Settings>[0]["plugins"];
  const requests = createPluginInstallRequests();
  return { cards, plugins, requests };
}
const market = { id: "example.market", name: "Market" };

const requestedSource = {
  repository: "https://example.com/plugins.git",
  reference: "v1",
};

it("opens a requested plugin source in Plugins and cancels it when Settings closes", async () => {
  const { cards, plugins, requests } = installRequestFixture({
    git: vi.fn(),
    discard: vi.fn(async () => {}),
  });
  const view = render(
    <Settings
      {...host}
      cards={cards}
      plugins={plugins}
      installRequests={requests}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  const outcome = requests.request(requestedSource, market);
  const dialog = await screen.findByRole("dialog", { name: "Add a plugin" });
  expect(within(dialog).getByLabelText("Git or GitHub repository")).toHaveValue(
    "https://example.com/plugins.git",
  );
  expect(dialog).toHaveTextContent("Opened from Market (example.market).");
  view.unmount();
  await expect(outcome).resolves.toBe("cancelled");
  expect(requests.snapshot()).toBeUndefined();
});

it("cancels a request nobody claimed when Settings closes", async () => {
  const { cards, plugins, requests } = installRequestFixture(undefined);
  const view = render(
    <Settings
      {...host}
      cards={cards}
      plugins={plugins}
      installRequests={requests}
    />,
  );
  const outcome = requests.request(requestedSource, market);
  expect(requests.snapshot()).toBeDefined();
  view.unmount();
  await expect(outcome).resolves.toBe("cancelled");
});

it("refuses a plugin request while the add dialog is open", async () => {
  const { cards, plugins, requests } = installRequestFixture({
    git: vi.fn(),
    discard: vi.fn(async () => {}),
  });
  render(
    <Settings
      {...host}
      cards={cards}
      plugins={plugins}
      installRequests={requests}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage plugins" }));
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  await screen.findByRole("dialog", { name: "Add a plugin" });
  await expect(requests.request(requestedSource, market)).resolves.toBe(
    "unavailable",
  );
});

it("leaves a confirmed install's request to the install when Settings closes", async () => {
  const { cards, plugins, requests } = installRequestFixture(undefined);
  const view = render(
    <Settings
      {...host}
      cards={cards}
      plugins={plugins}
      installRequests={requests}
    />,
  );
  const outcome = requests.request(requestedSource, market);
  const id = requests.snapshot()?.id ?? 0;
  expect(requests.claim(id)).toBe(true);
  const unconfirm = requests.confirm(id);
  view.unmount();
  await Promise.resolve();
  expect(requests.snapshot()?.id).toBe(id);
  requests.settle(id, "installed");
  unconfirm();
  await expect(outcome).resolves.toBe("installed");
});
