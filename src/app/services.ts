import { ArtifactStorageService } from "../features/artifact-storage/service";
import { provideArtifactStoreSync } from "../features/relay/artifact-store-sync";
import { createAdminAccess } from "../bundled/admin-access";
import { nativeRelayStaff } from "../features/relay-staff/native";
import { createLocalAgentActivity } from "../features/agents/local-activity";
// FOUNDATION: Compose the bundled distribution, plugin runtime, and services here.
import {
  createIdentity,
  nativeIdentityEnabled,
} from "../features/identity/service";
import { SettingsCardsService } from "../features/settings/service";
import { IdentityNamesService } from "../features/identity-names/service";
import { createLocalAgents } from "../features/agents/local";
import {
  FederatedIdentityService,
  onSignedIn,
} from "../features/federated-identity/service";
import { HostService } from "../features/host/service";
import { bindUnreadIndicator } from "../features/notifications/indicator-unread";
import { provideNavigation } from "../features/navigation/service";
import {
  bindDeepLinks,
  createRejectedLinks,
} from "../features/navigation/deep-links";
import { bindSearchUsage } from "../features/search/usage";
import { communityDestination } from "../features/communities/destination";
import { NotificationsService } from "../features/notifications/service";
import {
  bindMessageNotifications,
  notificationAuthorized,
} from "../features/notifications/messages";
import { AccountActionsService } from "../features/account-actions/service";
import { ShortcutsService } from "../features/shortcuts/service";
import { DecisionsService } from "../features/decisions/service";
import { AgentsService } from "../features/agents/service";
import { createShortcutBindings } from "../features/shortcuts/preferences";
import { ConversationService } from "../features/conversation/service";
import { createAppearance } from "../shared/theme/service";
import { createCommunities } from "../features/communities/service";
import { createInviteIntent } from "../features/communities/invite-intent";
import type { InviteLink } from "../features/communities/invite-link";
import { connectNativeTransport } from "../features/relay/native";
import { createUpdates } from "../features/updates/updates";
import { PanelsService } from "../features/panels/service";
import { Context } from "@deepseek-ai/cordis";
import { BrowserService } from "../features/browser/service";
import { PagesService } from "../features/pages/service";
import { SoloNavigationService } from "../features/channel-navigation/solo-navigation";
import { SidebarRowsService } from "../features/channel-navigation/sidebar-rows-service";
import { SidebarSectionsService } from "../features/channel-navigation/sidebar-sections-service";
import { SidebarScopeService } from "../features/channel-navigation/sidebar-scope-service";
import { bundledPlugins } from "../bundled";
import { bundledFederatedIdentity } from "../bundled/builderlab/oauth/first-run";
import { nativeBuilderlab } from "../bundled/builderlab/session";
import { conversationFeatures } from "./conversation-features";
import { PluginDevelopmentService } from "../features/plugin-development/service";
import { createPluginManager } from "../plugins/manager";
import {
  createPluginInstallCore,
  createPluginInstallRequests,
  createPluginInstallerService,
} from "../plugins/installer";
import { withTimeout } from "../plugins/timeout";
import { createExternalApps } from "../features/agents/external-connection";

export function createServices() {
  const appearance = createAppearance();
  const shortcutBindings = createShortcutBindings();
  const updates = createUpdates();
  const ctx = new Context();
  const externalApps = createExternalApps();
  ctx.provide("externalApps", externalApps);
  new HostService(ctx);
  const federatedIdentity = new FederatedIdentityService(ctx);
  // An FI build's Welcome calls the session as the Builderlab plugin's
  // bundled installation, which works whether or not the plugin has started.
  const firstRunFederatedIdentity = nativeBuilderlab()
    ? bundledFederatedIdentity(ctx)
    : undefined;
  const plugins = createPluginManager(ctx, {
    bundled: bundledPlugins,
    builtIn: conversationFeatures,
  });
  new PluginDevelopmentService(ctx, () => plugins);
  const localAgents = createLocalAgents();
  const localActivity = createLocalAgentActivity();
  const navigationHost = provideNavigation(ctx);
  const navigation = navigationHost.navigation;
  const browser = new BrowserService(ctx);
  const shortcuts = new ShortcutsService(ctx, undefined, shortcutBindings);
  const decisions = new DecisionsService(ctx);
  const pages = new PagesService(ctx);
  const sidebarSections = new SidebarSectionsService(ctx);
  const pluginInstallRequests = createPluginInstallRequests();
  const pluginInstallCore = createPluginInstallCore({
    plugins,
    requests: pluginInstallRequests,
    openPlugins: () =>
      navigation.open({ version: 1, kind: "settings", section: "plugins" }),
  });
  createPluginInstallerService(ctx, { core: pluginInstallCore });
  const sidebarScope = new SidebarScopeService(ctx);
  const sidebarRows = new SidebarRowsService(ctx);
  const panels = new PanelsService(ctx);
  const accountActions = new AccountActionsService(ctx);
  const conversation = new ConversationService(ctx);
  const settingsCards = new SettingsCardsService(ctx);
  const identityNames = new IdentityNamesService(ctx, localAgents.agents);
  const identity = nativeIdentityEnabled() ? createIdentity() : undefined;
  const communities = createCommunities(
    ctx,
    import.meta.env.VITE_BUZZ_LIVE === "1",
    identityNames,
    import.meta.env.VITE_BUZZ_OPEN_RELAY ?? "",
    localAgents.agents,
    identity?.ready,
    identity ? connectNativeTransport : undefined,
    localActivity.reader,
  );
  ctx.provide("communityReader", {
    snapshot: communities.snapshot,
    subscribe: communities.subscribe,
  });
  ctx.provide("knownCommunities", {
    snapshot: communities.snapshot,
    subscribe: communities.subscribe,
    pending: communities.pendingSync,
    apply: communities.applySync,
  });
  const relay = communities.relay;
  const artifactStorage = new ArtifactStorageService(ctx);
  provideArtifactStoreSync(ctx, artifactStorage);
  // Expose v2 only with the complete label/projection/frame/Destination/guard slice.
  new SoloNavigationService(ctx, relay, plugins);
  // The one recovery point for federated sign-in; see onSignedIn.
  ctx.effect(() =>
    onSignedIn(federatedIdentity, () => communities.reauthorize()),
  );
  const adminAccess = createAdminAccess(relay, communities, nativeRelayStaff());
  ctx.provide("adminAccess", adminAccess);
  ctx.effect(() => () => adminAccess.dispose());
  const agents = new AgentsService(
    ctx,
    communities,
    undefined,
    undefined,
    undefined,
    localActivity,
    decisions,
  );
  ctx.effect(() =>
    localAgents.bind({
      snapshot: agents.local,
      subscribe: agents.subscribe,
      refresh: () => agents.refresh(),
    }),
  );
  const notifications = new NotificationsService(
    ctx,
    navigation,
    undefined,
    undefined,
    (target) => notificationAuthorized(communities, target),
  );
  ctx.effect(() =>
    bindMessageNotifications(notifications, communities, localActivity.reader),
  );
  const inviteIntent = createInviteIntent();
  const invites = {
    ...inviteIntent,
    // With no code to claim, an existing membership just opens its community.
    open(invite: InviteLink, viewer: string) {
      const { memberships } = communities.snapshot();
      const id = communityDestination(invite.community).id;
      if (invite.code || !memberships.some((m) => m.id === id))
        return inviteIntent.open(invite, viewer);
      inviteIntent.clear();
      // Select now, not in the navigation effect, so a link read in the
      // meantime is not discarded as a community switch.
      communities.select(id);
      void navigation.open({
        version: 1,
        kind: "page",
        pluginId: "buzz.channels",
        pageId: "channels",
        scope: { viewer, communityOrigin: invite.community },
      });
    },
  };
  // OS deep links; a no-op in the browser build. Invite admission remains in
  // the join dialog, never in navigation or the native queue.
  const rejectedLinks = createRejectedLinks();
  const deepLinks = {
    ...navigationHost,
    invite: invites.open,
    authorize: externalApps.open,
    rejected: rejectedLinks.reject,
    accepted: () => rejectedLinks.clear(),
    // As the router decides: Inbox waits on startup and its own activation.
    inbox: {
      status: () =>
        plugins.startup() === "loading" ||
        plugins.snapshot().activation["buzz.inbox"]?.status === "starting"
          ? ("loading" as const)
          : pages.snapshot().some((page) => page.key === "buzz.inbox/inbox")
            ? ("on" as const)
            : ("off" as const),
      // Both producers emit mid-update: reconciliation before every plugin is
      // starting, activation before pages publish it. Read once both finish.
      subscribe(listener: () => void) {
        let queued = false;
        let stopped = false;
        const notify = () => {
          if (queued) return;
          queued = true;
          queueMicrotask(() => {
            queued = false;
            if (!stopped) listener();
          });
        };
        const stopPlugins = plugins.subscribe(notify);
        const stopPages = pages.subscribe(notify);
        return () => {
          stopped = true;
          stopPlugins();
          stopPages();
        };
      },
    },
  };
  ctx.effect(() => bindDeepLinks(deepLinks, communities));
  // Search ranks places by how often and how recently they were opened.
  ctx.effect(() =>
    bindSearchUsage(navigation, () => {
      const { selected, viewer } = communities.snapshot();
      return selected && viewer
        ? { viewer, communityOrigin: communityDestination(selected).url }
        : undefined;
    }),
  );
  if (notifications.indicator.available)
    ctx.effect(() =>
      bindUnreadIndicator(communities, notifications.indicator.setUnread, {
        allows: (target) => notifications.gated(target),
        subscribe: notifications.subscribeGates,
      }),
    );
  let disposal: Promise<void> | undefined;
  return {
    identity,
    browser,
    notifications,
    agentActivity: localActivity.reader,
    navigation,
    navigationHost,
    shortcuts,
    decisions,
    agents,
    accountActions,
    shortcutBindings,
    conversation,
    artifactStorage,
    settingsCards,
    adminAccess,
    pages,
    sidebarSections,
    pluginInstallRequests,
    sidebarScope,
    sidebarRows,
    panels,
    plugins,
    federatedIdentity,
    firstRunFederatedIdentity,
    relay,
    communities,
    invites,
    rejectedLinks,
    deepLinks,
    externalApps,
    appearance,
    updates,
    dispose() {
      identity?.dispose();
      appearance.dispose();
      updates.dispose();
      shortcutBindings.dispose();
      // Start root cancellation without waiting for plugin-owned cleanup. Cordis
      // starts sibling effects independently; the runtime still owns replacement
      // barriers. A timeout reports incomplete cleanup, never successful disposal.
      disposal ??= withTimeout(
        Promise.all([plugins.dispose(), ctx.fiber.dispose()]),
        "App cleanup timed out; restart the app",
      ).then(() => {});
      return disposal;
    },
  };
}

export type AppServices = ReturnType<typeof createServices>;
