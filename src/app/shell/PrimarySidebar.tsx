import { soloNavigationFor } from "../../features/channel-navigation/solo-navigation";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { SoloRegions } from "../../features/channel-navigation/SoloRegions";
import { SoloInventory } from "../../features/channel-navigation/SoloInventory";
import { soloDraft } from "../../features/channel-navigation/routes";
import { RecoveryNotice } from "../../features/relay/RecoveryNotice";
import {
  ChannelInventory,
  sidebarEntryLocation,
} from "../../features/channel-navigation/ChannelInventory";
import { SidebarBoundary } from "../../features/channel-navigation/SidebarBoundary";
import { SidebarFrame } from "../../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../../features/channel-navigation/SidebarList";
import { SidebarSection } from "../../bundled/channels/SidebarSection";
import { ResizableSidebar } from "../../features/channel-navigation/ResizableSidebar";
import { SidebarUnread } from "../../bundled/channels/SidebarUnread";
import { Button } from "../../shared/design-system/ui/Button";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import type { Agents } from "../../features/agents/service";
import type { Navigation } from "../../features/navigation/controller";
import type { OpenTarget } from "../../features/navigation/targets";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { OwnedContribution } from "../../plugins/OwnedContribution";
import type {
  RegisteredSidebarRestriction,
  SidebarScope,
} from "../../features/channel-navigation/sidebar-scope-service";
import styles from "./PrimarySidebar.module.css";

import { useRelayConnection } from "../../features/relay/react";
import { relayPartition } from "../../features/relay/partition";
import { targetKey } from "../../features/navigation/targets";
import { readView, writeView } from "../../shared/view-state";
import type { ChannelList } from "../../features/relay/contracts";
import type { ContributionReader } from "../../features/conversation/contracts";
import type { ChatIcon, ChatMenu } from "../../features/conversation/service";
import type { SidebarRows } from "../../features/channel-navigation/sidebar-rows-service";
import type { SidebarSections } from "../../features/channel-navigation/sidebar-sections-service";
import { CommunitySignIn } from "../../features/federated-identity/CommunitySignIn";
import type { FederatedIdentity } from "../../features/federated-identity/service";

const noSubscription = () => () => {};

type Filter = "all" | "solo" | "team";
const filters = [
  { value: "all", label: "All", panelId: "sidebar-all" },
  { value: "solo", label: "Solo", panelId: "sidebar-solo" },
  { value: "team", label: "Team", panelId: "sidebar-team" },
] as const;

type Props = {
  federatedIdentity?: FederatedIdentity;
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  chatIcons?: ContributionReader<ChatIcon> | undefined;
  chatMenus?: ContributionReader<ChatMenu> | undefined;
  sidebarSections?: SidebarSections | undefined;
  /** A plugin restriction shows only Solo; the saved filter returns after. */
  sidebarScope?: SidebarScope | undefined;
  sidebarRows?: SidebarRows | undefined;
  target: OpenTarget;
  children: ReactNode;
  creationAction?: ReactNode;
};

/** Filters the navigation inventory without replacing the current conversation. */
export function PrimarySidebar(props: Props) {
  const connection = useRelayConnection(props.relay);
  const scope = connection.scope ?? "disconnected";
  return (
    <ScopedSidebar
      {...props}
      key={scope}
      scope={scope}
      connection={connection}
    />
  );
}

function ScopedSidebar({
  scope,
  connection,
  ...props
}: Props & {
  scope: string;
  connection: ReturnType<typeof useRelayConnection>;
}) {
  const attempt = useSyncExternalStore(
    props.navigator.subscribe,
    () => props.navigator.snapshot().attempt.id,
  );
  const [observedAttempt, setObservedAttempt] = useState(attempt);
  const [view, setView] = useState(() => {
    const saved = readView<{ filter?: unknown; location?: unknown } | null>(
      scope,
      "navigation-scope",
      null,
    );
    return {
      filter:
        saved?.filter === "solo"
          ? "solo"
          : saved?.filter === "team"
            ? "team"
            : ("all" as Filter),
      location:
        typeof saved?.location === "string" ? saved.location : undefined,
    };
  });
  const sidebarScope = props.sidebarScope;
  useEffect(
    () =>
      soloNavigationFor(connection.session)?.subscribeReveal(
        (_id, explicit) =>
          explicit &&
          // A restriction already shows Solo; keep the saved filter for after.
          !sidebarScope?.snapshot().length &&
          setView((current) =>
            current.filter === "team"
              ? { ...current, filter: "solo" }
              : current,
          ),
      ),
    [connection.session, sidebarScope],
  );
  const soloNavigation = soloNavigationFor(connection.session);
  // Select the title, not the snapshot: Solo regions are rebuilt on every message.
  const soloTitle = useSyncExternalStore(
    soloNavigation?.subscribe ?? noSubscription,
    () =>
      soloNavigation?.snapshot().regions.find((region) => region.source)
        ?.title ?? "Solo",
  );
  const target = props.target;
  const local =
    "scope" in target &&
    target.scope &&
    relayPartition(target.scope.communityOrigin, target.scope.viewer) === scope;
  // The conversation's own Solo label, not the opening page, says which
  // inventory owns it; an unlisted conversation waits until it is known.
  const channels = connection.session?.channels;
  const conversation = target.kind === "conversation" ? target.channelId : "";
  // Only the destination: the list is replaced on every message preview.
  const listedDestination = useSyncExternalStore(
    channels?.subscribeList ?? noSubscription,
    () => conversationDestination(channels?.list(), conversation),
  );
  const preferences = connection.session?.soloPreferences;
  const soloPreferences = useSyncExternalStore(
    preferences?.subscribe ?? noSubscription,
    () => preferences?.snapshot(),
  );
  // A cached startup session has no Solo capabilities yet; its unavailable
  // placeholders still change height when the live inventories arrive.
  const soloReady =
    (connection.status === "ready" || connection.status === "error") &&
    soloPreferences?.status !== "idle" &&
    soloPreferences?.status !== "loading";
  const destination = local
    ? target.kind === "conversation"
      ? listedDestination
      : target.kind === "page" && target.pluginId === "buzz.channels"
        ? soloDraft(target.route?.params)
          ? "solo"
          : "team"
        : undefined
    : undefined;
  const location = destination ? targetKey(target) : undefined;
  const sidebarLocation = destination
    ? sidebarEntryLocation(target)
    : undefined;
  const restriction = useSyncExternalStore(
    props.sidebarScope?.subscribe ?? noSubscription,
    () => props.sidebarScope?.snapshot()[0],
  );
  // A deliberate filter change leaves the pane alone; only a new destination reveals its inventory.
  if (attempt !== observedAttempt) setObservedAttempt(attempt);
  if (
    destination &&
    location &&
    (view.location !== location || attempt !== observedAttempt)
  ) {
    // A restriction keeps the saved filter for when it ends.
    setView({
      filter: view.filter === "all" || restriction ? view.filter : destination,
      location,
    });
  }
  useEffect(() => {
    writeView(scope, "navigation-scope", view);
  }, [scope, view]);
  const filter = restriction ? "solo" : view.filter;
  const setFilter = (filter: Filter) => setView({ filter, location });
  // Without the tabs there is no tab to label the panel.
  const panelId = restriction ? undefined : `sidebar-${filter}`;
  const header = (
    <>
      <div className={styles.sidebarControls}>
        <div className={styles.sidebarScope}>
          {restriction && props.sidebarScope ? (
            <RestrictionBanner
              entry={restriction}
              registry={props.sidebarScope}
            />
          ) : (
            <Tabs
              label="Navigation scope"
              variant="segmented"
              size="sm"
              value={filter}
              items={
                soloTitle === "Solo"
                  ? filters
                  : [
                      filters[0],
                      filters[2],
                      { ...filters[1], label: soloTitle },
                    ]
              }
              onValueChange={setFilter}
            />
          )}
        </div>
        {props.creationAction}
      </div>
      {props.children && !restriction && (
        <div className={styles.destinations}>{props.children}</div>
      )}
    </>
  );
  return (
    <SidebarBoundary
      key={`${scope}:${connection.generation}`}
      header={header}
      panelId={panelId}
    >
      {connection.session &&
      (connection.status === "ready" || connection.cached) ? (
        <ChannelInventory
          relay={props.relay}
          navigator={props.navigator}
          agents={props.agents}
          target={props.target}
          queries={connection.session}
          scope={scope}
          viewer={connection.viewer}
          sidebarSections={props.sidebarSections}
          sidebarRows={props.sidebarRows}
          cached={!!connection.cached}
          layoutReady={filter === "team" || soloReady}
          connectionError={connection.error}
          render={({
            sidebar,
            dmPreviews,
            frame,
            before,
            content,
            after,
            dialogs,
          }) => (
            <ResizableSidebar scope={scope} className="shell-sidebar">
              <SidebarFrame
                label="Sidebar"
                header={header}
                panelId={panelId}
                {...frame}
              >
                {/* Relay outages for every inventory recover through one
                    automatic owner; its notice is the single Retry. */}
                {!connection.cached && (
                  <RecoveryNotice recovery={connection.session.recovery} />
                )}
                <LiveSignIn
                  session={connection.session}
                  identity={props.federatedIdentity}
                />
                {before}
                <SidebarUnread listRef={sidebar.list} dmPreviews={dmPreviews}>
                  <section
                    aria-label={soloTitle}
                    className={styles.sidebarGroup}
                    hidden={filter === "team"}
                  >
                    <SoloInventory
                      key={`${scope}:${connection.generation}`}
                      session={connection.session}
                      scope={scope}
                      navigator={props.navigator}
                      target={props.target}
                      chatIcons={props.chatIcons}
                      chatMenus={props.chatMenus}
                      renderContents={(
                        ordinary,
                        ordinaryActions,
                        header,
                        creationTrigger,
                        pendingClick,
                        headerActions,
                      ) => (
                        <SoloRegions
                          key={`regions:${scope}:${connection.generation}`}
                          session={connection.session}
                          scope={scope}
                          navigator={props.navigator}
                          target={props.target}
                          sidebar={sidebar}
                          ordinary={ordinary}
                          ordinaryActions={ordinaryActions}
                          creationTrigger={creationTrigger}
                          pendingClick={pendingClick}
                          groupDisclosure={
                            filter === "all"
                              ? {
                                  sectionKey: "scope:solo",
                                  title: soloTitle,
                                  open:
                                    !sidebar.collapsed.includes("scope:solo"),
                                  onToggle: (open) =>
                                    sidebar.toggle("scope:solo", open),
                                }
                              : undefined
                          }
                          hidePrimaryHeading={filter === "solo"}
                          fallbackHeaderActions={headerActions}
                          fallback={
                            <>
                              {header}
                              {ordinary}
                            </>
                          }
                        />
                      )}
                    />
                  </section>
                  <div
                    className={styles.sidebarGroup}
                    hidden={filter === "solo"}
                  >
                    {filter === "all" ? (
                      <InventoryGroup
                        sidebar={sidebar}
                        sectionKey="scope:team"
                        title="Team"
                        ownsCurrent={destination === "team"}
                        location={sidebarLocation}
                      >
                        {content}
                      </InventoryGroup>
                    ) : (
                      content
                    )}
                  </div>
                </SidebarUnread>
                {after}
              </SidebarFrame>
              {dialogs}
            </ResizableSidebar>
          )}
        />
      ) : (
        <div className="shell-sidebar-default">
          <SidebarFrame
            label="Sidebar"
            header={header}
            panelId={panelId}
            launchPending={
              connection.status === "connecting" ? "required" : undefined
            }
          >
            <SidebarList>
              {/* A connection retrying by itself is still connecting; only a
                  settled failure asks for Try again, right beside its notice. */}
              <div className={styles.connectionStatus}>
                <p>
                  {connection.status === "connecting" || connection.retrying
                    ? "Connecting…"
                    : connection.denied
                      ? "You don’t have access to this community."
                      : connection.status === "error"
                        ? "Couldn’t load channels."
                        : "Choose a community to see channels."}
                </p>
                {connection.status === "error" && !connection.retrying && (
                  <>
                    <CommunitySignIn
                      identity={props.federatedIdentity}
                      error={connection.error}
                      retry={props.relay.retry}
                    />
                    <Button onClick={props.relay.retry}>Try again</Button>
                  </>
                )}
              </div>
            </SidebarList>
          </SidebarFrame>
        </div>
      )}
    </SidebarBoundary>
  );
}

function InventoryGroup({
  sidebar,
  sectionKey,
  title,
  ownsCurrent,
  location,
  children,
}: {
  sidebar: Parameters<typeof SoloRegions>[0]["sidebar"];
  sectionKey: string;
  title: string;
  ownsCurrent: boolean;
  location: string | undefined;
  children: ReactNode;
}) {
  const open = !sidebar.collapsed.includes(sectionKey);
  useLayoutEffect(
    () =>
      sidebar.beforeReveal((next) => {
        if (!ownsCurrent || next !== location || open) return true;
        sidebar.toggle(sectionKey, true);
        return false;
      }),
    [
      location,
      open,
      ownsCurrent,
      sectionKey,
      sidebar.beforeReveal,
      sidebar.toggle,
    ],
  );
  return (
    <SidebarSection
      sectionKey={sectionKey}
      title={title}
      open={open}
      onToggle={(next) => sidebar.toggle(sectionKey, next)}
      hideMoreActions
      persistentChevron
    >
      {children}
    </SidebarSection>
  );
}

/** A protected community can refuse after its channel list is shown: native
 * discovery hands back the transport before NIP-FI admission, so the refusal
 * arrives on the live socket. Its recovery reconnects only that socket. */
function LiveSignIn({
  session,
  identity,
}: {
  session: RelaySession;
  identity: FederatedIdentity | undefined;
}) {
  const live = useSyncExternalStore(
    session.live.subscribe,
    session.live.snapshot,
    session.live.snapshot,
  );
  if (live.status !== "error") return null;
  return (
    <CommunitySignIn
      identity={identity}
      error={live.error}
      retry={session.live.retry}
    />
  );
}

/** Unknown until the channel list can say; a channel outside it is Team's. */
function conversationDestination(list: ChannelList | undefined, id: string) {
  const channel = list?.channels.find((item) => item.id === id);
  if (!channel && list?.status !== "ready") return undefined;
  return channel?.channelType === "solo" ? "solo" : "team";
}

/** A plugin's banner, isolated so its failure keeps the sidebar working. */
function RestrictionBanner({
  entry,
  registry,
}: {
  entry: RegisteredSidebarRestriction;
  registry: SidebarScope;
}) {
  return (
    <OwnedContribution entry={entry} registry={registry} fallback={null}>
      {({ banner: Banner }) => <Banner />}
    </OwnedContribution>
  );
}
