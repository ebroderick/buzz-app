import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useSidebarView } from "../../src/bundled/channels/useSidebarView";
import { ChannelSidebarRow } from "../../src/bundled/channels/ChannelSidebarRow";
import { SidebarSection } from "../../src/bundled/channels/SidebarSection";
import { SidebarContributionSection } from "../../src/features/channel-navigation/SidebarContributionSection";
import { ChannelSidebarDnd } from "../../src/features/channel-navigation/ChannelSidebarDnd";
import type { Navigation } from "../../src/features/navigation/controller";
import type { OpenTarget } from "../../src/features/navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSectionRow,
  SidebarSections,
} from "../../src/features/channel-navigation/sidebar-sections-service";

// The real sidebar view hook over a plain list with real layout. The page
// controls when the hook is mounted, where it navigates, and when the
// current entry renders, as a roster or an exact lookup would.
type State = {
  mounted: boolean;
  at: string;
  rows: number[];
  relocated?: boolean;
};
const rows = (count: number) => Array.from({ length: count }, (_, i) => i);
const contributionTarget: OpenTarget = {
  version: 1,
  kind: "conversation",
  scope: {
    viewer: "a".repeat(64),
    communityOrigin: "wss://relay.example",
  },
  channelId: "late",
};
let contributionRows: readonly SidebarSectionRow[] = [];
const contributionListeners = new Set<() => void>();
const contribution: RegisteredSidebarSection = {
  version: 1,
  id: "late",
  title: "Late rows",
  icon: "★",
  rows: {
    snapshot: () => contributionRows,
    subscribe(listener) {
      contributionListeners.add(listener);
      return () => contributionListeners.delete(listener);
    },
  },
  select: () => contributionTarget,
  key: "fixture.sidebar/late",
  pluginId: "fixture.sidebar",
  revision: "one",
};
const registry: SidebarSections = {
  version: 1,
  snapshot: () => [contribution],
  subscribe: () => () => {},
  register: () => {},
};
const navigator = {
  open: async () => ({ status: "opened" as const }),
} as unknown as Navigation;
declare global {
  interface Window {
    sidebar: {
      update(next: Partial<State>): void;
      rows: typeof rows;
      publishContributionRows(next: readonly SidebarSectionRow[]): void;
    };
  }
}

function Sidebar({ at, rows }: Omit<State, "mounted">) {
  const view = useSidebarView("fixture", true, at);
  const target =
    at === "conversation:late"
      ? contributionTarget
      : ({ version: 1, kind: "home" } satisfies OpenTarget);
  return (
    <nav
      aria-label="Sidebar"
      ref={view.list}
      style={{ height: 200, overflowY: "auto", width: 200 }}
    >
      {rows.map((id) => (
        <div
          key={id}
          data-row={id}
          aria-current={at === `row:${id}` ? "page" : undefined}
          style={{ height: 40 }}
        >
          Row {id}
        </div>
      ))}
      <ChannelSidebarDnd
        writable={false}
        onMove={() => {}}
        onReorder={() => {}}
        overlay={() => null}
      >
        <SidebarContributionSection
          entry={contribution}
          registry={registry}
          navigator={navigator}
          target={target}
          open
          onToggle={() => {}}
          groupIndex={0}
          reorderable={false}
          move={undefined}
          onRowsCommitted={view.retryReveal}
        />
      </ChannelSidebarDnd>
    </nav>
  );
}

function Harness() {
  const [state, setState] = useState<State>({
    mounted: false,
    at: "row:0",
    rows: rows(50),
  });
  window.sidebar = {
    update: (next) => setState((state) => ({ ...state, ...next })),
    rows,
    publishContributionRows: (next) => {
      contributionRows = next;
      for (const listener of contributionListeners) listener();
    },
  };
  if (state.relocated !== undefined)
    return (
      <nav aria-label="Sidebar">
        {["channels", "starred"].map((section) => (
          <SidebarSection
            key={section}
            sectionKey={section}
            title={section === "channels" ? "Channels" : "Starred"}
            open={section === "channels"}
            onToggle={() => {}}
            hideMoreActions
          >
            {(section === "channels"
              ? state.relocated
                ? ["alpha", "gamma"]
                : ["alpha", "beta", "gamma"]
              : state.relocated
                ? ["beta"]
                : []
            ).map((id) => (
              <ChannelSidebarRow
                key={id}
                channel={{ id, name: id, channelType: "stream" }}
                icon={null}
                onSelect={() => {}}
                onPrepare={() => {}}
              />
            ))}
          </SidebarSection>
        ))}
      </nav>
    );
  return state.mounted ? <Sidebar at={state.at} rows={state.rows} /> : null;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Harness />);
