// Installed fixture code only; app composition, manager, contributions and UI remain production.
import { soloRegionFixture } from "./solo-region-fixture";
import { companionPlugins } from "./companion-fixture";
import * as shortcutCounter from "../../examples/plugins/shortcut-counter/plugin.js";
import shortcutManifest from "../../examples/plugins/shortcut-counter/manifest.json";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { BundledPlugin } from "../../src/plugins/manager";
import type { Navigation } from "../../src/features/navigation/controller";
import type { PageProps } from "../../src/features/pages/service";
import type { PageNavigation } from "../../src/features/navigation/service";
import type { RelayData } from "../../src/features/relay/service";
import { PanelSubview } from "../../src/features/panels/PanelSubview";
import { FolderOpenIcon } from "../../src/shared/design-system/icons";
import type { PanelProps } from "../../src/features/panels/service";
import type { NotificationInput } from "../../src/features/notifications/service";

function DrillInFixture({ target, context }: PanelProps) {
  const [log, setLog] = useState(false);
  return (
    <>
      <p>Wrong match</p>
      <input aria-label="Panel draft" defaultValue="" />
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          context?.push?.(`${target}:detail`);
        }}
      >
        Open child detail
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.currentTarget.focus();
          setLog(true);
        }}
      >
        Open local log
      </button>
      {log && (
        <PanelSubview
          title="Fixture log"
          backLabel="Back to detail"
          onBack={() => setLog(false)}
        >
          <p>Log contents</p>
        </PanelSubview>
      )}
    </>
  );
}

declare global {
  interface Window {
    stalePanelClose?: () => void;
    fixtureNavigation?: Navigation;
    fixtureNotify?: (input: NotificationInput) => Promise<boolean>;
    fixturePageBroken?: boolean;
    fixtureSidebarWorkIconThrows?: boolean;
    fixtureSidebarRecovery?: boolean;
    delayFixture?: { started: boolean; release?: () => void };
    stopFixtureDependency?: () => Promise<void>;
    startFixtureDependency?: () => void;
    capturedPendingRequest?: PageNavigation | undefined;
    pendingMounted?: boolean;
    fixtureRelay?: RelayData;
    revocationProbe?: "complete" | "resolve";
    revocationAccepted?: boolean;
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    fixtureConnection: object;
  }
}
function PendingDestination({ navigation }: PageProps) {
  useEffect(() => {
    if (!navigation) return;
    window.capturedPendingRequest = navigation;
    window.pendingMounted = true;
    return () => {
      window.pendingMounted = false;
    };
  }, [navigation]);
  return <p>Pending provider destination</p>;
}
function Notes({ close, target }: PanelProps) {
  const [text, setText] = useState("");
  useEffect(() => {
    window.stalePanelClose = close;
  }, [close]);
  return (
    <label>
      Panel note ({target})
      <input
        aria-label="Panel note"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function Legacy() {
  const [text, setText] = useState("");
  return (
    <label>
      Legacy page draft
      <input
        aria-label="Legacy page draft"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  );
}
function RetryPage() {
  const [broken, setBroken] = useState(false);
  if (broken || window.fixturePageBroken)
    throw new Error("Fixture page render failure");
  return (
    <button type="button" onClick={() => setBroken(true)}>
      Break fixture page
    </button>
  );
}

function SidebarWorkIcon() {
  if (window.fixtureSidebarWorkIconThrows)
    throw new Error("Fixture sidebar icon failure");
  return <FolderOpenIcon aria-hidden="true" />;
}

export const fixturePlugins: readonly BundledPlugin[] = [
  soloRegionFixture,
  {
    manifest: {
      id: "fixture.provider",
      name: "Provider fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      inject: ["agents"],
      apply(ctx) {
        const state = { readiness: "ready" as const };
        ctx.agents.register({
          id: "sample",
          title: "Fixture provider",
          defaults: () => ({ config: {} }),
          provider: {
            snapshot: () => state,
            subscribe: () => () => {},
            check() {},
            DialogBody: ({ onClose }) => (
              <button type="button" onClick={onClose}>
                Done
              </button>
            ),
          },
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.sidebar-rows",
      name: "Host row fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      apply(ctx) {
        ctx.reflect.get("sidebarRows")?.register({
          version: 1,
          id: "rows",
          render: (row, Default) =>
            row.id === "beta" ? (
              <div data-plugin-row="decorated" title="Tracked by this plugin">
                {Default}
              </div>
            ) : (
              Default
            ),
          sortModes: [
            {
              id: "reverse",
              label: "Reverse name",
              compare: (a, b) => b.label.localeCompare(a.label),
            },
          ],
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.sidebar-sections",
      name: "Sidebar section fixture",
      apiVersion: 1,
    },
    module: {
      apply(ctx) {
        const rows = [
          {
            id: "work",
            label: "Queue",
            badge: "New",
            count: 2,
            status: "Active",
          },
        ];
        const listeners = new Set<() => void>();
        ctx.reflect.get("sidebarSections")?.register({
          version: 1,
          id: "work",
          title: "Workspace",
          icon: <SidebarWorkIcon />,
          rows: {
            snapshot: () => rows,
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
          select: () => ({
            version: 1,
            kind: "page",
            pluginId: "buzz.channels",
            pageId: "channels",
          }),
        });
        const reviewRows = [{ id: "review", label: "Review queue item" }];
        ctx.reflect.get("sidebarSections")?.register({
          version: 1,
          id: "review",
          title: "Review queue",
          icon: <FolderOpenIcon aria-hidden="true" />,
          rows: {
            snapshot: () => reviewRows,
            subscribe: () => () => {},
          },
          select: () => ({
            version: 1,
            kind: "page",
            pluginId: "buzz.channels",
            pageId: "channels",
          }),
        });
      },
    },
  },
  {
    manifest: {
      id: "fixture.page-placement",
      name: "Page placement fixture",
      apiVersion: 1,
    },
    enabledByDefault: false,
    module: {
      inject: ["pages"],
      apply(ctx) {
        for (const [id, title, placement] of [
          ["wide", "A deliberately long topbar destination", "topbar"],
          ["tool", "Toolbar destination", "toolbar"],
        ] as const)
          ctx.pages.register({
            id,
            title,
            placement,
            primary: true,
            component: () => <h1>{title}</h1>,
          });
        ctx.pages.register({
          id: "sidebar",
          title: "Sidebar playground",
          primary: true,
          component: () => <h1>Sidebar playground</h1>,
          sidebar: ({ target, children }) => {
            if (window.fixtureSidebarRecovery)
              throw new Error("Fixture page render failure");
            return (
              <div className="shell-sidebar-default">
                <aside
                  aria-label="Fixture sidebar"
                  className="flex h-full min-h-0 flex-col gap-3 bg-surface-panel p-3 text-standard"
                >
                  <p>
                    Target:{" "}
                    {target.kind === "page" ? target.pageId : target.kind}
                  </p>
                  <button type="button">Fixture sidebar action</button>
                  {children}
                </aside>
              </div>
            );
          },
        });
        if (window.fixtureSidebarRecovery)
          for (let index = 1; index <= 12; index += 1)
            ctx.pages.register({
              id: `recovery-${index}`,
              title: `Recovery entry ${String(index).padStart(2, "0")}`,
              primary: true,
              component: () => <h1>Recovery destination</h1>,
            });
      },
    },
  },
  {
    manifest: {
      id: "fixture.notifications",
      name: "Notification fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["notifications"],
      apply(ctx) {
        const producer = ctx.notifications.register({
          id: "updates",
          label: "Fixture updates",
        });
        window.fixtureNotify = producer.submit;
      },
    },
  },
  {
    manifest: {
      id: "fixture.dependency",
      name: "Dependency fixture",
      apiVersion: 1,
    },
    module: {
      apply(ctx) {
        const start = () =>
          ctx.plugin((child) => {
            child.provide("fixtureConnection", {});
          });
        let provider = start();
        window.stopFixtureDependency = async () => {
          await provider.dispose();
        };
        window.startFixtureDependency = () => {
          provider = start();
        };
      },
    },
  },
  {
    manifest: { id: "fixture.pending", name: "Pending fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "fixtureConnection", "relay"],
      apply(ctx) {
        window.fixtureRelay = ctx.relay;
        ctx.pages.register({
          id: "pending",
          title: "Pending fixture",
          primary: true,
          handlesNavigation: true,
          component: PendingDestination,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.session", name: "Session fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "relay", "conversation"],
      apply(ctx) {
        const relay = ctx.relay;
        window.fixtureRelay = relay;
        function SessionPage({ navigation }: PageProps) {
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const bound = navigation?.forSession(relay, connection);
          return connection.status === "ready" ? (
            <PendingDestination
              key={`${connection.scope}:${connection.generation}`}
              navigation={bound}
            />
          ) : (
            <p>Session pending reconnect</p>
          );
        }
        function ThreadFocusPage({ navigation }: PageProps) {
          const connection = useSyncExternalStore(
            relay.subscribe,
            relay.snapshot,
          );
          const Tabs = ctx.conversation.ui.Tabs;
          const target = navigation?.target;
          const threadId =
            target?.kind === "page" ? target.route?.params : undefined;
          useEffect(() => {
            navigation?.complete({ status: "opened" });
          }, [navigation]);
          if (
            connection.status !== "ready" ||
            !Tabs ||
            typeof threadId !== "string"
          )
            return null;
          return (
            <Tabs
              id="focus-fixture"
              session={connection.session}
              scope={connection.scope}
              label="Focus fixture"
            >
              {(open) => (
                <>
                  <input aria-label="Page draft" />
                  <button
                    type="button"
                    onClick={() => open({ channelId: "beta", threadId })}
                  >
                    Open cold thread
                  </button>
                </>
              )}
            </Tabs>
          );
        }
        ctx.pages.register({
          id: "thread-focus",
          title: "Thread focus fixture",
          primary: true,
          handlesNavigation: true,
          route: {
            version: 1,
            validate: (params) => typeof params === "string",
          },
          component: ThreadFocusPage,
        });
        ctx.pages.register({
          id: "session",
          title: "Session fixture",
          primary: true,
          handlesNavigation: true,
          component: SessionPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.delayed", name: "Delayed fixture", apiVersion: 1 },
    module: {
      inject: ["pages", "agents"],
      async apply(ctx) {
        const gate = window.delayFixture;
        if (gate)
          await new Promise<void>((resolve) => {
            gate.started = true;
            gate.release = resolve;
          });
        const state = { readiness: "ready" as const };
        ctx.agents.register({
          id: "provider",
          title: "Delayed provider",
          defaults: () => ({ config: {} }),
          provider: {
            snapshot: () => state,
            subscribe: () => () => {},
            check() {},
            DialogBody: () => <p>Delayed provider controls</p>,
          },
        });
        ctx.pages.register({
          id: "slow",
          title: "Delayed fixture",
          primary: true,
          component: () => <p>Delayed destination presented</p>,
        });
      },
    },
  },
  { manifest: { ...shortcutManifest, apiVersion: 1 }, module: shortcutCounter },
  {
    manifest: {
      id: "fixture.navigation",
      name: "Navigation fixture",
      apiVersion: 1,
    },
    module: {
      inject: ["pages", "navigation"],
      apply(ctx) {
        window.fixtureNavigation = ctx.navigation;
        // Run in the contribution notification itself, before React unmount cleanup.
        ctx.effect(() =>
          ctx.pages.subscribe(() => {
            const request = window.capturedPendingRequest;
            if (
              !request ||
              !window.revocationProbe ||
              ctx.pages
                .snapshot()
                .some((page) => page.key === "fixture.pending/pending")
            )
              return;
            window.revocationAccepted =
              window.revocationProbe === "complete"
                ? request.complete({ status: "opened" })
                : request.resolve({
                    version: 1,
                    kind: "settings",
                    section: "appearance",
                  });
            delete window.revocationProbe;
          }),
        );
        ctx.pages.register({
          id: "retry",
          title: "Retry fixture",
          primary: true,
          component: RetryPage,
        });
      },
    },
  },
  {
    manifest: { id: "fixture.notes", name: "Notes fixture", apiVersion: 1 },
    module: {
      inject: ["panels", "pages"],
      apply(ctx) {
        // Order -10 on purpose: a global resolve(target) launcher bug must hit this instead.
        ctx.panels.register({
          id: "catch-all",
          title: "Wrong panel",
          matches: () => true,
          order: -10,
          component: DrillInFixture,
        });
        ctx.panels.register({
          id: "notes",
          title: "Notes",
          matches: () => false,
          launcher: { icon: "/bestie.png", target: "not-an-agent-api" },
          component: Notes,
        });
        ctx.pages.register({
          id: "legacy",
          title: "Legacy",
          primary: true,
          component: Legacy,
        });
      },
    },
  },
  ...companionPlugins,
];
