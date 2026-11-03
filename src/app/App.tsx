// FOUNDATION: Startup, navigation, contributed pages, and built-in Settings.
import { AgentAvatarArtworkProvider } from "../features/agents/AgentAvatarArtworkProvider";
import { Welcome } from "../features/identity/Welcome";
import { NewMenu } from "./shell/NewMenu";
import { PrimarySidebar } from "./shell/PrimarySidebar";
import { ChannelNavigationProvider } from "../features/channel-navigation/ChannelNavigationState";
import { AgentsContext } from "../features/agents/react";
import { ToastProvider } from "../shared/design-system/ui/Toast";
import { AlertDialog } from "../shared/design-system/ui/AlertDialog";
import { Button } from "../shared/design-system/ui/Button";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../shared/design-system/ui/LoadingRegion";
import { TypingDots } from "../shared/design-system/ui/TypingDots";
import {
  CloudOffIcon,
  LinkBreakIcon,
  LockIcon,
  WarningCircleIcon,
} from "../shared/design-system/icons";
import { ModalWindowDragProvider } from "../shared/design-system/ui/ModalWindowDrag";
import { modalWindowDragHandlers } from "./shell/title-bar";
import { isTauri } from "@tauri-apps/api/core";
import { Dialog } from "../shared/design-system/ui/Dialog";
import { UpdateNotice } from "../features/updates/UpdateNotice";
import { RejectedLinkNotice } from "../features/navigation/RejectedLinkNotice";
import { ExternalAuthorizationDialog } from "../features/agents/ExternalAuthorizationDialog";
import { MediaMenuDownloadNotice } from "../features/messages/MediaDownloadAction";
import { CreationReview } from "../bundled/agents/CreationReview";
import { UpdateReview } from "../bundled/agents/UpdateReview";
import { InterruptedNotice } from "../features/agents/InterruptedNotice";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { registerAppShortcuts } from "./shortcuts";
import type { AppServices } from "./services";
import { Settings } from "./Settings";
import { SettingsSidebar } from "./SettingsSidebar";
import { pendingManaged } from "../plugins/managed";
import { RecoveryScreen } from "./RecoveryScreen";
import { PageView } from "../features/pages/PageView";
import { OwnedContribution } from "../plugins/OwnedContribution";
import { SidebarFrame } from "../features/channel-navigation/SidebarFrame";
import { SidebarList } from "../features/channel-navigation/SidebarList";
import { useAppNavigation, type PendingSettingsDeparture } from "./navigation";
import { NavigationControls } from "./shell/NavigationControls";
import { registerNavigationShortcuts } from "./shortcuts";
import { AppShell } from "./shell/AppShell";
import {
  LaunchWindowControls,
  LoadingWindowHeader,
} from "./shell/LaunchWindowControls";
import { pagePresentation, shellPresentation } from "./shell/presentation";
import { usePanelLauncher } from "./shell/usePanelLauncher";
import { PanelLaunchers } from "./shell/PanelLaunchers";
import { PanelCard } from "../features/panels/PanelCard";
import { communityDestination } from "../features/communities/destination";
import { CommunityLanding } from "../features/communities/CommunityLanding";
import { LegacyCommunityImport } from "../features/communities/LegacyCommunityImport";
import {
  LaunchSignIn,
  SignInEnding,
} from "../features/federated-identity/LaunchSignIn";
import { launchVisible, setLaunchReady, subscribeLaunch } from "./launch";
import { AgentCompletionNotifications } from "../features/notifications/AgentCompletionNotifications";

export function App({ services }: { services: AppServices }) {
  const identity = services.identity;
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  useEffect(() => {
    if (!identity) return;
    const update = () => {
      const status = identity.snapshot().status;
      if (status === "missing" || status === "error") setLaunchReady(true);
      else if (status === "loading") setLaunchReady(false);
    };
    update();
    return identity.subscribe(update);
  }, [identity]);
  return (
    <AgentAvatarArtworkProvider>
      <ModalWindowDragProvider
        value={isTauri() ? modalWindowDragHandlers : undefined}
      >
        <LaunchWindowControls />
        {services.identity ? (
          <Welcome
            identity={services.identity}
            communities={services.communities}
            invites={services.invites}
            federatedIdentity={services.firstRunFederatedIdentity}
          >
            <LaunchSignIn identity={services.federatedIdentity}>
              <ConnectedApp services={services} />
              {!launching && (
                <LegacyCommunityImport communities={services.communities} />
              )}
            </LaunchSignIn>
          </Welcome>
        ) : (
          <ConnectedApp services={services} />
        )}
      </ModalWindowDragProvider>
    </AgentAvatarArtworkProvider>
  );
}

function ConnectedApp({ services }: { services: AppServices }) {
  return (
    <ToastProvider
      portalContainer={document.getElementById("buzz-toast-root") ?? undefined}
    >
      <AgentCompletionNotifications services={services} />
      <ConnectedAppContent services={services} />
    </ToastProvider>
  );
}

function ConnectedAppContent({ services }: { services: AppServices }) {
  const { plugins } = services;
  const [workspaceElement, setWorkspaceElement] =
    useState<HTMLDivElement | null>(null);
  const startup = useSyncExternalStore(plugins.subscribe, plugins.startup);
  const { configuration } = useSyncExternalStore(
    plugins.subscribe,
    plugins.snapshot,
  );
  const pluginRecommendations = pendingManaged(
    configuration.status === "ready" ? configuration.managed : undefined,
  ).length;
  const launching = useSyncExternalStore(subscribeLaunch, launchVisible);
  // Unsaved Profile edits turn a Settings dismissal into a discard prompt.
  const [settingsUnsaved, setSettingsUnsaved] = useState(false);
  const [confirmSettingsDiscard, setConfirmSettingsDiscard] = useState(false);
  const [departure, setDeparture] = useState<PendingSettingsDeparture | null>(
    null,
  );
  const route = useAppNavigation(services, departure);
  const settingsTraversal = useRef<((proceed: boolean) => void) | undefined>(
    undefined,
  );
  const discardSettings = useRef(false);
  const settingsEditorScope = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!settingsUnsaved) return;
    return services.navigationHost.guardDeparture((next, decide) => {
      if (discardSettings.current) {
        discardSettings.current = false;
        return false;
      }
      const current = services.navigation.snapshot().entry.target;
      // Settings sections share the mounted Profile editor. A different scope
      // or leaving the dialog would unmount it.
      if (
        next.kind === "settings" &&
        current.kind === "settings" &&
        JSON.stringify(next.scope) === JSON.stringify(current.scope)
      )
        return false;
      settingsTraversal.current = decide;
      setConfirmSettingsDiscard(true);
      return true;
    });
  }, [services, settingsUnsaved]);
  const keepSettings = () => {
    settingsTraversal.current?.(false);
    settingsTraversal.current = undefined;
    setConfirmSettingsDiscard(false);
  };
  const launcher = usePanelLauncher(services.panels, startup === "ready");
  const client = useSyncExternalStore(
    services.communities.subscribe,
    services.communities.snapshot,
  );
  const invite = useSyncExternalStore(
    services.invites.subscribe,
    services.invites.snapshot,
  );
  // A queued link cannot be presented under a different identity.
  useEffect(() => {
    if (invite && client.viewer && invite.viewer !== client.viewer)
      services.invites.clear();
  }, [invite, client.viewer, services.invites]);
  const connection = useSyncExternalStore(
    services.relay.subscribe,
    services.relay.snapshot,
  );
  const restoring = client.status === "loading" || !!connection.restoring;
  const settings = route.target.kind === "settings";
  // Someone without a community starts by joining one. Having had one this
  // run keeps the shell; Personal space with memberships is unchanged.
  const [hadCommunity, setHadCommunity] = useState(false);
  if (!hadCommunity && client.memberships.length > 0) setHadCommunity(true);
  const firstRun =
    !settings &&
    !hadCommunity &&
    startup !== "recovery" &&
    client.status === "ready" &&
    client.relayAvailable &&
    client.memberships.length === 0;
  // The prompt is stale once Settings ends another way or nothing is left to
  // discard, such as when a pending save is sent behind it.
  if (confirmSettingsDiscard && (!settings || !settingsUnsaved)) {
    settingsTraversal.current = undefined;
    setConfirmSettingsDiscard(false);
  }
  const settingsFocus = useRef<HTMLElement | null>(null);
  const wasSettings = useRef(false);
  const workspaceEntry = useRef<string | undefined>(undefined);
  const settingsReturnEntry = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!settings) workspaceEntry.current = route.state.entry.id;
    else if (!wasSettings.current)
      settingsReturnEntry.current = workspaceEntry.current;
    wasSettings.current = settings;
  }, [settings, route.state.entry.id]);
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      if (
        !wasSettings.current &&
        event.target instanceof HTMLElement &&
        !event.target.closest('[role="menu"], [role="dialog"]')
      )
        settingsFocus.current = event.target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);
  const retryFocus = useRef<string | undefined>(undefined);
  /** The visit whose Try again already failed once, for honest feedback. */
  const [retriedEntry, setRetriedEntry] = useState<string>();
  // A passive effect runs after the destination's own mount focus, so this
  // only fills in when focus would otherwise be left on the body.
  useEffect(() => {
    if (!retryFocus.current) return;
    if (retryFocus.current === route.state.attempt.id && !settings && restoring)
      return;
    if (
      retryFocus.current === route.state.attempt.id &&
      document.activeElement === document.body
    )
      document
        .getElementById(settings ? "settings-content" : "main-content")
        ?.focus({ preventScroll: true });
    retryFocus.current = undefined;
  }, [restoring, settings, route.state.attempt]);
  useEffect(() => {
    if (
      departure &&
      (departure.attempt !== route.state.attempt ||
        departure.viewer !== client.viewer ||
        (client.selected !== null && client.selected !== departure.communityId))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, route.state.attempt]);
  const terminal =
    startup === "recovery" ||
    route.state.status === "failed" ||
    (!route.state.ingress && !!route.failure);
  const launchReady =
    settings ||
    terminal ||
    firstRun ||
    (!restoring && startup !== "loading" && !route.waiting);
  useEffect(
    () => setLaunchReady(launchReady, terminal),
    [launchReady, terminal],
  );
  const select = route.select;
  useEffect(
    () =>
      registerAppShortcuts(
        services.shortcuts,
        services.appearance,
        () => {
          void services.navigation.open({ version: 1, kind: "settings" });
        },
        true,
      ),
    [services],
  );
  useEffect(
    () => registerNavigationShortcuts(services.shortcuts, services.navigation),
    [services],
  );
  const workspace = route.workspace;
  const presentation = workspace.page
    ? pagePresentation(workspace.page)
    : shellPresentation.settings;
  const selectedPanel = launcher.selected;
  const companion = selectedPanel && (
    <PanelCard
      key={launcher.openingId}
      ref={launcher.panelRef}
      panel={selectedPanel}
      target={launcher.target ?? ""}
      close={launcher.close}
    />
  );
  // A page that presents its own failure in place stays on screen.
  const failedPage = route.state.status === "failed" && !route.state.presented;
  // A kept timeout keeps only a page that is drawn. If the deadline passed
  // while the host drew its loading state instead, report it as the host's own
  // failure, so its card and Retry show. Loading that starts later over a kept
  // page stays a loading state.
  const drawsLoading =
    route.waiting || (!settings && (startup === "loading" || restoring));
  const keptTimeout =
    route.state.status === "failed" &&
    route.state.presented &&
    route.state.reason === "timeout"
      ? route.state.attempt
      : undefined;
  // By attempt id: a late address update replaces the attempt object, not it.
  const decidedTimeout = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (!keptTimeout || decidedTimeout.current === keptTimeout.id) return;
    decidedTimeout.current = keptTimeout.id;
    if (drawsLoading)
      services.navigationHost.complete(keptTimeout, {
        status: "failed",
        reason: "timeout",
      });
  }, [services, keptTimeout, drawsLoading]);
  const pageOwnsCompanion =
    !!workspace.page?.companion &&
    (settings
      ? !!workspace.request
      : !route.failure && !route.waiting && !failedPage);
  // A registration lookup does not admit the target's parameters and scope.
  const pageSidebarReady =
    startup === "ready" &&
    (settings
      ? !!workspace.request
      : !route.failure && !route.waiting && !failedPage);
  // Keep the parser launch surface through local bootstrap, not network refresh.
  if (!settings && restoring)
    return document.getElementById("buzz-launch") ? null : (
      <div className="buzz-launch" role="status" aria-label="Opening Buzz">
        <LoadingWindowHeader />
        <picture>
          <source
            media="(prefers-reduced-motion: reduce)"
            srcSet="/buzz-mark.svg"
          />
          <img src="/buzz-loading-mark.svg" alt="Buzz" width="72" height="72" />
        </picture>
      </div>
    );
  const selectCommunity = (id: string | null) => {
    const recovering =
      services.navigation.snapshot().ingress &&
      services.navigation.snapshot().retryable;
    services.communities.select(id);
    if (!recovering) select("buzz.channels/channels");
  };
  if (firstRun)
    return (
      <CommunityLanding
        communities={services.communities}
        federatedIdentity={services.federatedIdentity}
        invite={invite?.viewer === client.viewer ? invite : undefined}
        onInviteClose={services.invites.clear}
        settingsCards={services.settingsCards}
        onJoined={selectCommunity}
        onCreate={() =>
          void services.navigation.open({
            version: 1,
            kind: "settings",
            section: "block.builderlab/login",
          })
        }
      />
    );
  const openSettingsSection = (section: string) => {
    const client = services.communities.snapshot();
    void services.navigation.open({
      version: 1,
      kind: "settings",
      section,
      ...(client.viewer && client.selected
        ? {
            scope: {
              viewer: client.viewer,
              communityOrigin: communityDestination(client.selected).url,
            },
          }
        : { scope: null }),
    });
  };
  // As for pages, a timed-out reopen of the shown section keeps its editor.
  const settingsUnavailable =
    (!route.state.ingress && !!route.failure) || failedPage;
  const settingsBlocked = settingsUnavailable || route.waiting;
  const settingsScope =
    route.target.kind === "settings"
      ? JSON.stringify(route.target.scope)
      : undefined;
  // Preserve Settings' completion/focus state across admitted scope changes.
  // A blocked destination may retain only its own scope's dirty editor.
  if (settings && !settingsBlocked) settingsEditorScope.current = settingsScope;
  const failureReason = route.state.reason ?? route.failure;
  const failureKind =
    failureReason === "denied"
      ? "denied"
      : failureReason === "invalid-target" ||
          (route.state.ingress && !route.state.retryable)
        ? "link"
        : route.offline
          ? "offline"
          : "unavailable";
  // Only a timed-out or unavailable visit reopens by itself, and only while
  // the connection is still being retried.
  const keepTrying =
    route.reconnecting &&
    !route.state.ingress &&
    (failureReason === "timeout" || failureReason === "unavailable");
  const retryButton = (variant: "primary" | "quiet") => (
    <Button
      type="button"
      variant={variant}
      onClick={(event) => {
        const focused = event.currentTarget === document.activeElement;
        const before = services.navigation.snapshot().attempt.id;
        setRetriedEntry(route.state.entry.id);
        // Reopening against a refused connection would fail again at once.
        if (services.relay.snapshot().status === "error")
          services.relay.retry();
        route.retry();
        // Retry can remove this control and briefly unmount the
        // shell; hand focus to main only once it has fallen away.
        const after = services.navigation.snapshot().attempt.id;
        retryFocus.current = focused && after !== before ? after : undefined;
      }}
    >
      Try again
    </Button>
  );
  // The way out must lead elsewhere: Messages itself may be what failed. A
  // link or access failure, or a conversation, still leaves for Messages'
  // own default. Without one, the app's navigation remains the way out.
  const leaveForMessages =
    (failureKind === "link" ||
      failureKind === "denied" ||
      route.target.kind === "conversation" ||
      (route.selected !== "buzz.channels/channels" &&
        route.selected !== "home")) &&
    route.pages.some((page) => page.key === "buzz.channels/channels");
  const messagesButton = (variant: "primary" | "quiet") =>
    leaveForMessages ? (
      <Button
        type="button"
        variant={variant}
        onClick={() => select("buzz.channels/channels")}
      >
        Go to Messages
      </Button>
    ) : null;
  // A link or access failure returns to where the person came from; opened
  // cold, Messages is the nearest useful place. A rejected incoming link
  // never became a visit: it overlays the page still underneath, so
  // reopening that page is going back, and history Back would skip it.
  const leaveFailure =
    route.state.ingress || route.state.canGoBack ? (
      <Button
        type="button"
        variant="primary"
        onClick={() =>
          route.state.ingress
            ? void services.navigation.open(route.state.entry.target)
            : services.navigation.back()
        }
      >
        Go back
      </Button>
    ) : (
      messagesButton("primary")
    );
  const destinationFailure = (
    <div role="alert" className="page-status">
      {failureKind === "denied" ? (
        <EmptyState
          icon={<LockIcon />}
          title="You don’t have access to this"
          description="It belongs to another account or a community you haven’t joined."
          action={leaveFailure}
        />
      ) : failureKind === "link" ? (
        <EmptyState
          icon={<LinkBreakIcon />}
          title="This link doesn’t work"
          description="It may be incomplete or out of date. Ask whoever shared it for a new link."
          action={leaveFailure}
        />
      ) : failureKind === "offline" ? (
        <EmptyState
          icon={<CloudOffIcon />}
          title="Can’t connect"
          description={
            retriedEntry === route.state.entry.id
              ? keepTrying
                ? "Still can’t connect. We’ll keep trying."
                : "Still can’t connect. Check your connection, then try again."
              : keepTrying
                ? "Check your connection. We’ll keep trying."
                : "Check your connection, then try again."
          }
          action={
            <>
              {retryButton("primary")}
              {messagesButton("quiet")}
            </>
          }
        />
      ) : route.failure || failureReason === "not-found" ? (
        <EmptyState
          icon={<WarningCircleIcon />}
          title="This page isn’t available"
          description="It may have been removed, or you may need to update Buzz."
          action={
            <>
              {messagesButton("primary")}
              {retryButton(leaveForMessages ? "quiet" : "primary")}
            </>
          }
        />
      ) : (
        <EmptyState
          icon={<WarningCircleIcon />}
          title="This page isn’t available"
          description="It didn’t load this time. Try again in a moment."
          action={
            <>
              {retryButton("primary")}
              {messagesButton("quiet")}
            </>
          }
        />
      )}
    </div>
  );
  const opening = (
    <div className="page-status">
      <LoadingRegion
        pending
        label={
          <span className="page-status-label">
            <TypingDots />
            Loading…
          </span>
        }
      >
        {null}
      </LoadingRegion>
    </div>
  );
  return (
    <>
      <SignInEnding identity={services.federatedIdentity} />
      <ChannelNavigationProvider relay={services.relay}>
        <AgentsContext.Provider value={services.agents}>
          <AppShell
            creationInSidebar={!workspace.page?.sidebar}
            creationAction={(open, onOpenChange, triggerContainer) => (
              <NewMenu
                triggerContainer={triggerContainer}
                open={open}
                onOpenChange={onOpenChange}
                relay={services.relay}
                navigator={services.navigation}
                agents={services.agents}
              />
            )}
            workspaceRef={setWorkspaceElement}
            sidebar={(pageNavigation, creationAction) =>
              workspace.page?.sidebar && pageSidebarReady ? (
                <OwnedContribution
                  entry={workspace.page}
                  registry={services.pages}
                  resetIdentity={workspace.request}
                  fallback={
                    <div className="shell-sidebar-default">
                      <SidebarFrame label={`${workspace.page.title} sidebar`}>
                        <SidebarList>
                          <p role="alert">
                            This page’s sidebar is unavailable.
                          </p>
                          {pageNavigation}
                        </SidebarList>
                      </SidebarFrame>
                    </div>
                  }
                >
                  {(entry) => {
                    const Sidebar = entry.sidebar;
                    return Sidebar ? (
                      <Sidebar target={workspace.target}>
                        {pageNavigation}
                      </Sidebar>
                    ) : null;
                  }}
                </OwnedContribution>
              ) : workspace.page?.sidebar ? (
                <div className="shell-sidebar-default">
                  <SidebarFrame label="Page navigation">
                    <SidebarList>{pageNavigation}</SidebarList>
                  </SidebarFrame>
                </div>
              ) : (
                <PrimarySidebar
                  creationAction={creationAction}
                  federatedIdentity={services.federatedIdentity}
                  relay={services.relay}
                  navigator={services.navigation}
                  agents={services.agents}
                  chatIcons={services.conversation.chatIcons}
                  chatMenus={services.conversation.chatMenus}
                  sidebarSections={services.sidebarSections}
                  sidebarScope={services.sidebarScope}
                  sidebarRows={services.sidebarRows}
                  target={workspace.target}
                >
                  {pageNavigation}
                </PrimarySidebar>
              )
            }
            navigationControls={
              <NavigationControls navigation={services.navigation} />
            }
            onCommunitySelect={selectCommunity}
            // A scoped Settings target selects its community on the way.
            onOpenTarget={(target) => void services.navigation.open(target)}
            communities={services.communities}
            federatedIdentity={services.federatedIdentity}
            invite={invite?.viewer === client.viewer ? invite : undefined}
            onInviteClose={services.invites.clear}
            settingsCards={services.settingsCards}
            accountActions={services.accountActions}
            appearance={services.appearance}
            pluginRecommendations={pluginRecommendations}
            searchServices={services}
            launchers={
              <PanelLaunchers
                panels={launcher.available}
                selected={selectedPanel}
                launch={launcher.launch}
              />
            }
            companion={pageOwnsCompanion ? undefined : companion}
            pages={startup === "ready" ? route.pages : []}
            selected={workspace.selected}
            navigationAttempt={workspace.attempt}
            onSelect={select}
            tone={presentation.tone}
            workspace={
              startup === "ready" && workspace.page?.layout === "workspace"
            }
          >
            <UpdateNotice updates={services.updates} />
            <RejectedLinkNotice links={services.rejectedLinks} />
            <ExternalAuthorizationDialog
              connection={services.externalApps}
              agents={services.agents}
              communities={services.communities}
              relay={services.relay}
            />
            <InterruptedNotice agents={services.agents} />
            <MediaMenuDownloadNotice />
            <CreationReview agents={services.agents} />
            <UpdateReview agents={services.agents} />
            {!settings && startup === "recovery" ? (
              <RecoveryScreen plugins={plugins} />
            ) : !settings &&
              ((!route.state.ingress && route.failure) || failedPage) ? (
              destinationFailure
            ) : !settings && route.waiting ? (
              opening
            ) : startup === "loading" || restoring ? (
              settings ? null : (
                opening
              )
            ) : workspace.page ? (
              <PageView
                page={workspace.page}
                navigation={workspace.request}
                companion={pageOwnsCompanion ? companion : undefined}
                companionOpening={
                  pageOwnsCompanion ? launcher.opening : undefined
                }
              />
            ) : null}
          </AppShell>
          <Dialog
            // The inert launch surface would swallow the modal's initial focus.
            open={settings && !launching}
            title="Settings"
            visit
            closeLabel="Close Settings"
            size="expanded"
            container={workspaceElement}
            navigation={{
              label: "Settings sections",
              content: (
                <SettingsSidebar
                  cards={services.settingsCards}
                  communities={services.communities}
                  recommendations={pluginRecommendations}
                  {...(route.target.kind === "settings" && route.target.section
                    ? { selected: route.target.section }
                    : {})}
                  onSection={openSettingsSection}
                />
              ),
            }}
            onOpenChange={(open) => {
              if (open) return;
              if (settingsUnsaved) setConfirmSettingsDiscard(true);
              else route.leaveSettings();
            }}
            initialFocus={() => {
              // A destination that already focused a setting keeps it.
              const active = document.activeElement;
              return active instanceof HTMLElement &&
                document.getElementById("settings-content")?.contains(active)
                ? active
                : true;
            }}
            finalFocus={() => {
              // Only a return to the visit Settings covered restores the prior
              // focus; a destination opened from Settings starts at main.
              const returning =
                services.navigation.snapshot().entry.id ===
                settingsReturnEntry.current;
              return returning &&
                settingsFocus.current?.isConnected &&
                settingsFocus.current !== document.body
                ? settingsFocus.current
                : (document.getElementById("main-content") ?? false);
            }}
          >
            <div id="settings-content" className="h-full" tabIndex={-1}>
              {settingsUnavailable
                ? destinationFailure
                : route.waiting
                  ? opening
                  : null}
              {(!settingsBlocked ||
                (settingsUnsaved &&
                  settingsEditorScope.current === settingsScope)) && (
                <div
                  className="h-full"
                  hidden={settingsBlocked}
                  inert={settingsBlocked}
                >
                  <Settings
                    agents={services.agents}
                    decisions={services.decisions}
                    plugins={plugins}
                    cards={services.settingsCards}
                    adminAccess={services.adminAccess}
                    communities={services.communities}
                    identity={services.identity}
                    federatedIdentity={services.federatedIdentity}
                    appearance={services.appearance}
                    shortcuts={services.shortcuts}
                    shortcutBindings={services.shortcutBindings}
                    notifications={services.notifications}
                    updates={services.updates}
                    navigation={route.request}
                    installRequests={services.pluginInstallRequests}
                    navigationPane
                    onDeparturePending={(pending) => {
                      const client = services.communities.snapshot();
                      const attempt = route.state.attempt;
                      if (pending && client.viewer && client.selected)
                        setDeparture({
                          attempt,
                          viewer: client.viewer,
                          communityId: client.selected,
                        });
                      else if (!pending)
                        setDeparture((current) =>
                          current?.attempt === attempt ? null : current,
                        );
                    }}
                    onSection={openSettingsSection}
                    onPluginImportClosed={() =>
                      route.dismissPluginImport(route.request)
                    }
                    onProvider={route.setSettingsProvider}
                    onUnsavedChange={setSettingsUnsaved}
                  />
                </div>
              )}
            </div>
            {confirmSettingsDiscard && settings && settingsUnsaved && (
              <AlertDialog
                title="Discard changes?"
                description="Your profile has unsaved changes."
                onClose={keepSettings}
                actions={
                  <>
                    <Button onClick={keepSettings}>Keep editing</Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setConfirmSettingsDiscard(false);
                        const decide = settingsTraversal.current;
                        settingsTraversal.current = undefined;
                        if (decide) decide(true);
                        else {
                          discardSettings.current = true;
                          route.leaveSettings();
                        }
                      }}
                    >
                      Discard changes
                    </Button>
                  </>
                }
              />
            )}
          </Dialog>
        </AgentsContext.Provider>
      </ChannelNavigationProvider>
    </>
  );
}
