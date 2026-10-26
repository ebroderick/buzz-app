import { useChannelHistoryFocus } from "./useChannelHistoryFocus";
import type { Conversation } from "../../features/conversation/service";
import { StartLinkedChat, canStartLinkedChat } from "./StartLinkedChat";
import {
  readLinkedChat,
  linkedDraftKey,
} from "../../features/solo/linked-chat";
import { EmptyState } from "../../shared/design-system/ui/EmptyState";
import { LoadingRegion } from "../../shared/design-system/ui/LoadingRegion";
import { TypingDots } from "../../shared/design-system/ui/TypingDots";
import {
  openProfileTranscript,
  profileActivityViewTarget,
} from "../../features/profiles/target";
import type { Agents } from "../../features/agents/service";
import { SoloDraft } from "../../features/solo/SoloDraft";
import { useChannelNavigation } from "../../features/channel-navigation/ChannelNavigationState";
import { soloSuccessor } from "../../features/channel-navigation/solo-successor";
import { historyPanel, useConversationTabs } from "./useConversationTabs";
import tabStyles from "./ChannelTabs.module.css";
import panelStyles from "../../features/panels/Panels.module.css";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useReturnHighlight } from "../../features/messages/use-return-highlight";
import { ChannelBody } from "./ChannelBody";
import {
  entryPane,
  panelTabId,
  rootOfTab,
  tabPane,
  useChannelTabState,
} from "./useChannelTabState";
import { ChannelMembersDialog } from "./ChannelMembersDialog";
import { ChannelMemberAvatars } from "./ChannelMemberAvatars";
import {
  soloDraft,
  soloDraftTarget,
} from "../../features/channel-navigation/routes";
import { WorkspaceControl } from "../../features/solo/WorkspaceControl";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { SoloHeading, SoloToolbar, useSoloMoveRecovery } from "./SoloHeading";
import { NewMessage } from "../../features/direct-messages/NewMessage";
import { Panel } from "../../shared/design-system/ui/Panel";
import { Button } from "../../shared/design-system/ui/Button";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import { ChannelJoinNotice } from "../../features/messages/ChannelJoinNotice";
import { ChannelLifecycleActions } from "./ChannelLifecycleActions";
import { lifecycleNoun } from "./ChannelLifecycleDialog";
import type { PageNavigation } from "../../features/navigation/service";
import type { Navigation } from "../../features/navigation/controller";
import { targetKey, type OpenTarget } from "../../features/navigation/targets";
import {
  buzzLinkTarget,
  isBuzzLink,
  parseBuzzLink,
} from "../../features/navigation/buzz-links";
import { useChatConversions } from "../../features/solo/conversion";
import { ConvertToChannel } from "../../features/solo/ConvertToChannel";
import { UnreadOptions } from "./UnreadBadge";
import type { ConversationExtensions } from "../../features/conversation/contracts";
import { LinkThreadTabContext } from "../../features/conversation/LinkLabelContext";
import { placeExactOpening } from "../../features/conversation/exact-opening";
import { flushSync } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  SidebarRightIcon,
  PlugIcon,
  CloudOffIcon,
  LockIcon,
  ChatCircleIcon,
  GearIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon } from "../../features/channels/channel-icon";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  useChannelList,
  useChannelRoster,
  useRelayConnection,
} from "../../features/relay/react";
import {
  panelOpening,
  type PanelOpening,
  type Panels,
} from "../../features/panels/service";
import { PanelWorkspace } from "../../features/panels/PanelWorkspace";
import { usePanelSplit } from "../../features/panels/usePanelSplit";
import { PanelDock } from "../../features/panels/PanelDock";
import { COMPANION_SPLIT, PanelFrame } from "../../features/panels/PanelFrame";
import { OutboxStatus } from "./OutboxStatus";
import { RelayTimings } from "./RelayTimings";
import { LiveStatus } from "./LiveStatus";
import {
  ConversationChannel,
  ConversationComposer,
} from "../../features/conversation/Conversation";
import { MessageManagementStatus } from "../../features/messages/MessageManagement";
import type {
  Attachment,
  ChannelSummary,
} from "../../features/relay/contracts";
import { readView, writeView } from "../../shared/view-state";
import { useChannelLabels } from "./useChannelLabels";
import { useDefaultChannels } from "../../features/channels/default-channels";
import { useComposerSent } from "./useComposerSent";
import { useSidebarPreferences } from "./useSidebarPreferences";
import { channelHasUnread } from "./useSidebarFilters";
import { inFieldOutsideComposer } from "./conversation-rows";
import styles from "./Channels.module.css";
import type { CommunityReader } from "../../features/communities/service";
import { avatarMedia } from "../../shared/avatar-source";

/** The open Solo conversation's Archive, published for the shortcut while its visit is live. */
export type ArchiveShortcut = {
  current?: { available(): boolean; run(): Promise<void> } | undefined;
};

/** The open conversation's Mark as read, published for the Escape shortcut while its visit is live. */
export type ReadShortcut = {
  current?: { available(): boolean; run(): Promise<void> } | undefined;
};

export function ChannelsPage({
  extensions,
  chatMenus,
  relay,
  panels,
  companion,
  navigation,
  navigator,
  agents,
  communities,
  archive,
  read,
}: {
  extensions?: ConversationExtensions | undefined;
  chatMenus?: Conversation["chatMenus"] | undefined;
  /** For adding a whole team of the owner's agents from the members dialog. */
  agents?: Agents | undefined;
  communities?: CommunityReader | undefined;
  relay: RelayData;
  navigation?: PageNavigation | undefined;
  navigator: Navigation;
  panels: Panels;
  /** The open Solo conversation's Archive, for the Archive chat shortcut. */
  archive?: ArchiveShortcut | undefined;
  /** The open conversation's Mark as read, for the Escape shortcut. */
  read?: ReadShortcut | undefined;
  companion?: ReactNode;
}) {
  const session = useRelayConnection(relay);
  const sessionNavigation = navigation?.forSession(relay, session);
  // An opening visit's deadline bounds Connecting; once it has settled, a
  // retrying connection is a failure that keeps trying, not a connection.
  // Each attempt republishes the connection, so reading it here stays current.
  const visitSettled = navigator.snapshot().status !== "opening";
  const presentedSession = useRef<
    | {
        scope: typeof session.scope;
        entryId: string;
      }
    | undefined
  >(undefined);
  // Rebuild read-only addresses within the same account/community, including
  // reconnects and deliberate resets. Old session callbacks still expire.
  const retireDetail = !!(
    navigation?.target.kind === "conversation" &&
    navigation.target.detail &&
    presentedSession.current?.entryId === navigation.entryId &&
    session.scope &&
    presentedSession.current.scope !== session.scope
  );
  useLayoutEffect(() => {
    if (retireDetail && navigation?.target.kind === "conversation") {
      const { detail: _detail, ...target } = navigation.target;
      navigation.resolve(target);
    } else if (session.status === "ready" && navigation) {
      presentedSession.current = {
        scope: session.scope,
        entryId: navigation.entryId,
      };
    }
  }, [navigation, retireDetail, session.status, session.scope]);
  useEffect(() => {
    if (!navigation || !sessionNavigation) return;
    if (session.status === "disconnected" && navigation.target.kind === "page")
      sessionNavigation.complete({ status: "opened" });
    // A connection that is retrying on its own keeps the visit pending; the
    // visit deadline bounds the wait and the host reopens it once connected.
    else if (session.status === "error" && !session.cached && !session.retrying)
      sessionNavigation.complete(
        // A refusal is explained in place, beside its own Try again.
        session.denied
          ? { status: "failed", reason: "denied", presented: true }
          : { status: "failed", reason: "unavailable" },
      );
  }, [
    navigation,
    sessionNavigation,
    session.status,
    session.cached,
    session.retrying,
    session.denied,
  ]);
  return (
    <section className={styles.root} aria-label="Channels">
      {session.status !== "ready" && !session.cached ? (
        <PanelFrame scope={session.scope} companion={companion}>
          {session.status === "disconnected" ? (
            <div className={styles.connect}>
              <div className={styles.connectIcon}>
                <PlugIcon size={30} />
              </div>
              <h1>Your channels, one conversation.</h1>
              <p>
                Use the community picker in the header to choose or add a
                community. Your profile and settings work without a community.
              </p>
            </div>
          ) : session.status === "error" && session.denied ? (
            <div role="alert" className={styles.failed}>
              <EmptyState
                icon={<LockIcon />}
                title="You don’t have access to this"
                description="It belongs to another account or a community you haven’t joined."
                action={
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => relay.retry()}
                  >
                    Try again
                  </Button>
                }
              />
            </div>
          ) : session.status === "error" &&
            (!session.retrying || visitSettled) ? (
            // Usually a failed visit's card covers this page, but a visit that
            // already opened from cached content keeps it: say so plainly.
            <div role="alert" className={styles.failed}>
              <EmptyState
                icon={<CloudOffIcon />}
                title="Can’t connect"
                description={
                  session.retrying
                    ? "Check your connection. We’ll keep trying."
                    : "Check your connection, then try again."
                }
                action={
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => relay.retry()}
                  >
                    Try again
                  </Button>
                }
              />
            </div>
          ) : (
            // Only real connection work animates.
            <div className={styles.connect}>
              <LoadingRegion
                pending
                label={
                  <span className={styles.connecting}>
                    <TypingDots />
                    Connecting…
                  </span>
                }
              >
                {null}
              </LoadingRegion>
            </div>
          )}
        </PanelFrame>
      ) : (
        <ChannelWorkspace
          chatMenus={chatMenus}
          extensions={extensions}
          key={`${session.scope ?? "disconnected"}:${session.generation}`}
          scope={session.scope ?? "disconnected"}
          cached={!!session.cached}
          queries={session.session}
          relay={relay}
          navigation={retireDetail ? undefined : sessionNavigation}
          navigator={navigator}
          viewer={session.viewer}
          panels={panels}
          archive={archive}
          read={read}
          companion={companion}
          agents={agents}
          communities={communities}
        />
      )}
    </section>
  );
}

/** Recent ordering reads activity, which the workspace's roster ignores. */
function LiveNewMessage(
  props: Omit<React.ComponentProps<typeof NewMessage>, "channels">,
) {
  const { channels } = useChannelList(props.session.channels);
  return <NewMessage {...props} channels={channels} />;
}

function ChannelWorkspace({
  extensions,
  chatMenus,
  queries,
  cached,
  relay,
  panels,
  scope,
  companion,
  navigation,
  navigator,
  viewer,
  agents,
  communities,
  archive,
  read,
}: {
  extensions?: ConversationExtensions | undefined;
  chatMenus?: Conversation["chatMenus"] | undefined;
  agents?: Agents | undefined;
  companion?: ReactNode;
  communities?: CommunityReader | undefined;
  scope: string;
  navigation?: PageNavigation | undefined;
  navigator: Navigation;
  viewer?: string | undefined;
  queries: RelaySession;
  cached: boolean;
  relay: RelayData;
  panels: Panels;
  archive?: ArchiveShortcut | undefined;
  read?: ReadShortcut | undefined;
}) {
  const composingMessage =
    navigation?.target.kind === "page" &&
    navigation.target.route?.params === "new-message";
  const draftTarget = navigation?.target;
  const draft = useMemo(
    () =>
      draftTarget?.kind === "page"
        ? soloDraft(draftTarget.route?.params)
        : undefined,
    [draftTarget],
  );
  // The draft consumes its source on creation. Keep this visit's source while
  // membership and first-send work settles; a later visit reads storage anew.
  const linkedSource = useMemo(
    () =>
      !navigation?.signal.aborted && draft?.linked
        ? readLinkedChat(scope, linkedDraftKey(draft.linked))
        : undefined,
    [draft?.linked, scope, navigation?.signal],
  );
  const list = useChannelRoster(queries.channels);
  const initialList = useRef(list);
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  useEffect(() => {
    // Initial channel discovery cancels in-flight reads as it settles access.
    // Start the optional catalog afterward so opening Messages cannot strand it.
    if (list.status === "ready") queries.channelKit.ensure();
  }, [queries, list.status]);
  const [joinNoticeHeight, setJoinNoticeHeight] = useState(0);
  const [contentReadyChannel, setContentReadyChannel] = useState<string>();
  const [composerFocus, setComposerFocus] = useState(0);
  const [trackSoloMove, soloMoveNotices] = useSoloMoveRecovery(queries);
  const historyContainer = useRef<HTMLElement>(null);
  // A visit applied by a header opening must not take that opening's focus.
  const [preservedVisit, setPreservedVisit] = useState<PageNavigation>();
  // A started join focuses the composer when membership makes it writable,
  // however that membership arrives. Opening another channel drops the intent.
  const [joiningChannel, setJoiningChannel] = useState<string>();
  const [membersChannel, setMembersChannel] = useState<string>();
  const membersTrigger = useRef<HTMLButtonElement>(null);
  const membersHeaderTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    void queries.emoji.ensure();
  }, [queries]);
  useEffect(() => {
    if (list.status === "ready") void queries.unread.ensure();
  }, [queries, list.status]);
  useDefaultChannels(queries, scope, cached);
  const available = useSyncExternalStore(
    panels.subscribe,
    panels.snapshot,
    panels.snapshot,
  );
  const [selected, setSelected] = useState<string | undefined>(() =>
    readView(scope, "selected-channel", undefined),
  );
  const handoff = useChannelNavigation();
  const clearPreparingDm = handoff?.clearPreparingDm;
  useEffect(() => {
    if (!composingMessage) clearPreparingDm?.();
    return () => clearPreparingDm?.();
  }, [composingMessage, clearPreparingDm]);
  const navigate = useCallback(
    (id: string) => {
      setSelected(id);
      writeView(scope, "selected-channel", id);
      if (navigator && viewer) {
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId: id,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
      }
    },
    [navigator, viewer, scope],
  );
  // A send or open that finishes behind the Settings modal must not navigate
  // away from Settings, which would discard its unsaved edits.
  const behindSettings = () =>
    navigator?.snapshot().entry.target.kind === "settings";
  // A Solo start that finishes behind Settings stays put; a fresh draft
  // replaces the submitted one so its prompt cannot be started again. The
  // replacement never claims focus for the visit's original request, which
  // would pull typing out of the modal into the hidden composer.
  const [retiredSoloDraft, setRetiredSoloDraft] = useState<{
    generation: number;
    signal: AbortSignal | undefined;
  }>({ generation: 0, signal: undefined });
  const select = useCallback(
    (id: string) => {
      navigate(id);
    },
    [navigate],
  );
  const threadTrigger = useRef<HTMLElement | null>(null);
  const [sent, setSent] = useState<{ channelId: string; id: string }>();
  const { channels, profiles } = useChannelLabels(
    list.channels.filter(
      (channel) =>
        // Wait for metadata so temporary rooms never flash as unnamed channels.
        !channel.huddle && !channel.metadataPending,
    ),
    queries.profiles,
    queries.names,
  );
  const metadataPending = list.channels.some(
    (channel) => channel.metadataPending,
  );
  const requestedChannel =
    navigation?.target.kind === "conversation"
      ? navigation.target.channelId
      : undefined;
  const [resolved, setResolved] = useState<{
    request: PageNavigation;
    available: boolean;
  }>();
  const joinedRequest = list.channels.some(
    (channel) => channel.id === requestedChannel,
  );
  useEffect(() => {
    // Let initial membership discovery settle before resolving an omitted target.
    // A premature exact lookup publishes a one-channel list and starts readers
    // that the completing full roster then invalidates.
    if (
      cached ||
      !requestedChannel ||
      !navigation ||
      joinedRequest ||
      list.status === "idle" ||
      list.status === "loading" ||
      !queries.channels.resolve
    )
      return;
    const controller = new AbortController();
    void queries.channels
      .resolve([requestedChannel], {
        signal: AbortSignal.any([controller.signal, navigation.signal]),
        priority: "foreground",
      })
      .then(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted)
          setResolved({ request: navigation, available: true });
      })
      .catch(() => {
        if (!controller.signal.aborted && !navigation.signal.aborted) {
          setResolved({ request: navigation, available: false });
          navigation.complete({ status: "failed", reason: "unavailable" });
        }
      });
    return () => controller.abort();
  }, [
    cached,
    requestedChannel,
    navigation,
    joinedRequest,
    queries,
    list.status,
  ]);
  const resolvingMembership =
    !!requestedChannel &&
    !joinedRequest &&
    !!queries.channels.resolve &&
    resolved?.request !== navigation;
  // Thread navigation revalidates access, but should not tear down the
  // already-visible preview in this channel while that lookup is pending.
  // Navigation can also briefly omit its request during the route handoff.
  const visiblePreview = useRef<{
    channelId: string;
    queries: RelaySession;
  }>(undefined);
  const previewAvailable =
    resolved?.request === navigation
      ? resolved?.available
      : !cached &&
        visiblePreview.current?.channelId === requestedChannel &&
        visiblePreview.current?.queries === queries;
  // Lifecycle completion must not reopen retained archived/hidden membership
  // through the mounted workspace's saved selection or first-channel fallback.
  const emptyDestination =
    !!draft ||
    (navigation?.target.kind === "page" &&
      navigation.target.route?.params === "empty");
  const requestedDestination = emptyDestination
    ? undefined
    : requestedChannel
      ? (channels.find((channel) => channel.id === requestedChannel) ??
        // Sidebar visibility is not access: retain a joined archived selection.
        list.channels.find((channel) => channel.id === requestedChannel) ??
        (previewAvailable
          ? queries.channels.get?.(requestedChannel)
          : undefined))
      : ((!navigation && !cached && visiblePreview.current?.queries === queries
          ? queries.channels.get?.(visiblePreview.current.channelId)
          : undefined) ??
        channels.find((channel) => channel.id === selected) ??
        // A new member lands in the community's default channel when it has one.
        channels.find(
          (channel) => channel.autoJoin && channel.channelType !== "solo",
        ) ??
        channels.find((item) => item.channelType !== "solo"));
  // Exact links and saved selections must respect the same Huddle-only entry point.
  const resolving =
    resolvingMembership ||
    (list.status !== "error" && !!requestedDestination?.metadataPending);
  const current =
    requestedDestination?.huddle || requestedDestination?.metadataPending
      ? undefined
      : requestedDestination;
  useLayoutEffect(() => {
    visiblePreview.current =
      current?.readOnly && !current.cached && !cached
        ? { channelId: current.id, queries }
        : undefined;
  });
  // Sidebar routing can update the same mounted page. Keep its saved default
  // aligned with the resolved conversation, not only page-local clicks.
  useEffect(() => {
    if (navigation?.target.kind !== "conversation" || !current) return;
    setSelected(current.id);
    writeView(scope, "selected-channel", current.id);
  }, [navigation?.target, current, scope]);
  useEffect(() => {
    if (!joiningChannel || !current) return;
    if (current.id !== joiningChannel) setJoiningChannel(undefined);
    else if (!current.readOnly || current.viewerRole === "guest") {
      setJoiningChannel(undefined);
      if (current.viewerRole === "guest")
        historyContainer.current?.focus({ preventScroll: true });
      else setComposerFocus((value) => value + 1);
    }
  }, [joiningChannel, current]);
  const CurrentChannelIcon = channelIcon(current);
  useEffect(() => {
    if (navigation?.signal.aborted) return;
    if (composingMessage || draft) {
      navigation?.complete({ status: "opened" });
      return;
    }
    if (
      !cached &&
      !resolving &&
      !current &&
      ((requestedChannel && list.status === "ready") ||
        (list.status === "error" &&
          // ensureList retries on mount, possibly after asynchronous cache restore.
          // Do not settle a new navigation using the previous attempt's error.
          list !== initialList.current &&
          metadataPending &&
          !emptyDestination))
    )
      navigation?.complete({ status: "failed", reason: "unavailable" });
    if (
      !requestedChannel &&
      !current &&
      list.status === "ready" &&
      (!metadataPending || emptyDestination)
    )
      navigation?.complete({ status: "opened" });
    if (!requestedChannel && current && navigation && viewer) {
      // Resolve the saved default within this attempt, keeping its caller and deadline.
      navigation.resolve({
        version: 1,
        kind: "conversation",
        channelId: current.id,
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
    }
  }, [
    cached,
    composingMessage,
    metadataPending,
    emptyDestination,
    draft,
    requestedChannel,
    resolving,
    current,
    list,
    navigation,
    viewer,
    scope,
  ]);
  const requestedMessage =
    navigation?.target.kind === "conversation"
      ? navigation.target.messageId
      : undefined;
  const requestedThread =
    navigation?.target.kind === "conversation"
      ? navigation.target.threadRootId
      : undefined;
  const membersRequested =
    navigation?.target.kind === "conversation" &&
    navigation.target.panel === "members";
  const membersOpen =
    (navigator ? membersRequested : membersChannel === current?.id) &&
    !!current &&
    current.channelType !== "solo";
  useLayoutEffect(() => {
    // Solo chats have no Members surface. Canonicalize an old/handwritten route
    // before a child reader can complete it, retaining its exact message address.
    if (
      !cached &&
      current &&
      !current.cached &&
      current.channelType === "solo" &&
      navigation?.target.kind === "conversation" &&
      navigation.target.panel === "members" &&
      !navigation.signal.aborted
    ) {
      const { panel: _panel, ...target } = navigation.target;
      navigation.resolve(target);
    }
  }, [cached, current, navigation]);
  const currentId = current?.id;
  useEffect(() => {
    setMembersChannel((id) => (id === currentId ? id : undefined));
  }, [currentId]);
  const setMembersOpen = (open: boolean) => {
    if (!navigator) {
      setMembersChannel(open ? currentId : undefined);
      return;
    }
    if (
      !navigation ||
      navigation.signal.aborted ||
      navigation.target.kind !== "conversation" ||
      navigation.target.channelId !== currentId ||
      navigator.snapshot().entry.id !== navigation.entryId
    )
      return;
    // Passive history retains Members; explicit dismissal retires its visit.
    // The guard above keeps cleanup from overwriting a routed handoff.
    const { panel: _panel, ...target } = navigation.target;
    if (open) void navigator.open({ ...target, panel: "members" });
    else navigator.dismiss([navigation.entryId], target);
  };
  const openMembers = (trigger: HTMLButtonElement) => {
    membersTrigger.current = trigger;
    setMembersOpen(true);
  };
  const committedVisit = useRef<{
    currentId: string | undefined;
    queries: RelaySession;
    channelType: string | undefined;
    archived: boolean;
  }>(undefined);
  const continuingVisit =
    committedVisit.current?.currentId === currentId &&
    committedVisit.current?.queries === queries;
  useLayoutEffect(() => {
    committedVisit.current = {
      currentId,
      queries,
      channelType: current?.channelType,
      archived: !!current?.archived,
    };
  }, [currentId, queries, current?.channelType, current?.archived]);
  const tabState = useChannelTabState(
    queries,
    currentId,
    "messages",
    navigator,
  );
  const { settings, setSettings, retireMenuEntries } = tabState;
  useEffect(() => {
    if (!currentId || composingMessage || draft) return;
    // Retire this visit's reveal intent without discarding a new-DM handoff.
    return () => {
      setSent((previous) =>
        previous?.channelId === currentId ? undefined : previous,
      );
    };
  }, [currentId, composingMessage, draft]);

  const conversions = useChatConversions(queries);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [conversion, setConversion] = useState<{
    channelId: string;
    navigation: PageNavigation | undefined;
    trigger: HTMLElement | null;
  }>();
  // Type changes are the result, not a new visit. Actual navigation retires the form.
  useEffect(() => {
    setConversion((previous) =>
      previous &&
      (previous.channelId !== currentId || previous.navigation !== navigation)
        ? undefined
        : previous,
    );
  }, [currentId, navigation]);
  const [settingsFocus, requestSettingsFocus] = useState(0);
  const showingSettings =
    tabState.paneOpen &&
    !!settings &&
    settings.channelId === currentId &&
    tabState.selected === "settings";
  const closeSettings = () => {
    setSettings(undefined);
    afterClose("settings");
  };
  // The Solo treatment: an agent conversation. In the owner's own chat it
  // also files into a project; the conversation scope owns composer policy.
  const solo = current?.channelType === "solo";
  // Solo has no main tab workspace; its threads open beside the chat.
  const threadPane = solo ? ("side" as const) : undefined;
  // Confirmations belong to this visit; a Solo conversation that leaves the
  // owner's view opens its nearest sidebar neighbor, or else a new draft,
  // rather than an empty page.
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
    trigger?: HTMLElement,
  ) => {
    const origin = navigation?.signal;
    const neighbors = handoff?.soloNeighbors.current?.(channel.id) ?? [];
    handoff?.openLifecycle(channel, action, trigger, origin, {
      close() {
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      },
      completed() {
        // Unarchive restores the open chat; every other action leaves it.
        if (action !== "unarchive" && !origin?.aborted && navigator)
          void navigator.open(
            soloSuccessor(
              scope,
              queries.channels.list().channels,
              neighbors,
              channel.id,
            ),
          );
      },
    });
  };
  // A Solo start that fails leaves its chat for New chat only while this
  // workspace still shows that chat.
  const showing = useRef(requestedChannel);
  const notify = useToastNotification();
  useLayoutEffect(() => {
    showing.current = requestedChannel;
  });
  useLayoutEffect(
    () => () => {
      showing.current = undefined;
    },
    [],
  );
  const chooseLatest = useRef(chooseLifecycle);
  useLayoutEffect(() => {
    chooseLatest.current = chooseLifecycle;
  });
  // Mail's Archive chord opens the same confirmation as the chat actions menu.
  const archivable =
    solo && !current?.readOnly && !current?.cached
      ? current?.archived
        ? undefined
        : current
      : undefined;
  const archivableLatest = useRef(archivable);
  useLayoutEffect(() => {
    archivableLatest.current = archivable;
  });
  const archivableId = archivable?.id;
  const lifecycle = queries.channelLifecycle;
  useLayoutEffect(() => {
    if (!archive || !archivableId || !lifecycle.available) return;
    const signal = navigation?.signal;
    const shortcut = {
      available: () => !signal?.aborted,
      // The menu's fresh permission read: no Archive where the menu has none.
      run: async () => {
        const trigger =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : undefined;
        const settings = await lifecycle
          .load(archivableId, signal)
          .catch(() => undefined);
        const channel = archivableLatest.current;
        if (
          settings?.canArchive &&
          archive.current === shortcut &&
          channel?.id === archivableId
        )
          chooseLatest.current(channel, "archive", trigger);
      },
    };
    archive.current = shortcut;
    return () => {
      if (archive.current === shortcut) archive.current = undefined;
    };
  }, [archive, archivableId, lifecycle, navigation]);
  // Escape marks the open conversation read, as its menu's Mark as read does:
  // the same read-sync gate and call, and a toast only for a failure.
  const notifyLatest = useRef(notify);
  useLayoutEffect(() => {
    notifyLatest.current = notify;
  });
  const readableId =
    !composingMessage && current && !current.readOnly && !current.cached
      ? current.id
      : undefined;
  useLayoutEffect(() => {
    if (!read || !readableId) return;
    const signal = navigation?.signal;
    const shortcut = {
      available: () =>
        !signal?.aborted &&
        queries.unread.sync().capability === "frontier-sync" &&
        channelHasUnread(queries.unread, readableId) &&
        !inFieldOutsideComposer(),
      run: async () => {
        try {
          await queries.unread.markChannelRead(readableId);
        } catch {
          notifyLatest.current("Couldn’t mark as read.", "error");
        }
      },
    };
    read.current = shortcut;
    return () => {
      if (read.current === shortcut) read.current = undefined;
    };
  }, [read, readableId, queries, navigation]);
  const onComposerSend = useComposerSent(currentId, setSent);
  const [exactOpening, setExactOpening] = useState<{
    request: PageNavigation;
    inTimeline: boolean;
    rootId?: string;
  }>();
  useEffect(() => {
    if (
      cached ||
      current?.cached ||
      !navigation ||
      !requestedMessage ||
      requestedThread === requestedMessage ||
      !currentId ||
      navigation.signal.aborted
    )
      return;
    let selected = false;
    const choose = () => {
      if (selected || navigation.signal.aborted) return;
      const window = queries.channels.window(currentId);
      if (window.status === "idle" || window.status === "loading") return;
      selected = true;
      // Freeze the presentation for this attempt. An isolated lookup or later
      // live event must not move an already-opened thread into the timeline.
      setExactOpening({
        request: navigation,
        ...placeExactOpening(window, requestedMessage),
      });
    };
    const stop = queries.channels.subscribeWindow(currentId, choose);
    choose();
    return stop;
  }, [
    cached,
    current?.cached,
    navigation,
    requestedMessage,
    requestedThread,
    currentId,
    queries,
  ]);
  // A live connection can still be confirming its restored membership. Keep
  // the pending intent; an exact reader cannot use display-only authority.
  const exact =
    cached || current?.cached
      ? undefined
      : navigation && requestedMessage && requestedThread === requestedMessage
        ? { request: navigation, inTimeline: false }
        : exactOpening?.request === navigation
          ? exactOpening
          : undefined;
  // The route addresses a thread; its tab owns presentation, the route only
  // selects it and supplies the reveal request.
  const routedThread = useMemo(
    () =>
      !cached &&
      current &&
      navigation &&
      requestedMessage &&
      exact &&
      !exact.inTimeline
        ? {
            channelId: current.id,
            messageId: requestedMessage,
            rootId: exact.rootId ?? requestedThread ?? requestedMessage,
            pane: threadPane,
            navigation,
          }
        : undefined,
    [
      cached,
      current,
      navigation,
      requestedMessage,
      requestedThread,
      exact,
      threadPane,
    ],
  );
  const conversationIcon = (item: (typeof channels)[number]) => {
    const person = item.participants?.[0];
    return (
      <ConversationIcon
        item={item}
        picture={person ? profiles.get(person)?.picture : undefined}
        media={queries.media}
      />
    );
  };
  const channelConversation = useRef<HTMLDivElement>(null);
  const highlightReturn = useReturnHighlight(channelConversation, currentId);
  const returnFocus = useRef<
    { trigger: HTMLElement; channelId: string | undefined } | undefined
  >(undefined);
  const visitPanel = useCallback(
    (entry: PanelOpening) => {
      const target = navigator?.snapshot().entry.target;
      if (!navigator || target?.kind !== "conversation") return;
      if (
        target.channelId === entry.channelId &&
        target.detail?.target === entry.target &&
        target.detail.rootId === entry.rootId
      )
        return;
      tabState.leaveVisit();
      void navigator.open({
        version: 1,
        kind: "conversation",
        scope: target.scope,
        channelId: entry.channelId,
        detail: {
          target: entry.target,
          ...(entry.rootId ? { rootId: entry.rootId } : {}),
        },
      });
    },
    [navigator, tabState.leaveVisit],
  );
  // Closing selects locally first. Retire the closed content while preserving
  // its surviving neighbour, including a panel beside a main-pane thread.
  const closeTarget = (
    pane: "main" | "side",
    entries = tabState.entries,
  ): OpenTarget | undefined => {
    const target = navigator?.snapshot().entry.target;
    if (target?.kind !== "conversation") return;
    const selected =
      pane === "main" ? tabState.getMainSelected() : tabState.getSelected();
    const detail = entries.find(
      (entry) => panelTabId(entry) === selected && historyPanel(entry),
    );
    const thread =
      tabState.tabs.find((tab) => tab.id === selected) ??
      (pane === "side"
        ? tabState.tabs.find((tab) => tab.id === tabState.getMainSelected())
        : undefined);
    return {
      version: 1,
      kind: "conversation",
      scope: target.scope,
      channelId:
        detail?.channelId ??
        (thread?.kind === "thread" ? thread.channelId : undefined) ??
        currentId ??
        target.channelId,
      ...(detail
        ? {
            detail: {
              target: detail.target,
              ...(detail.rootId ? { rootId: detail.rootId } : {}),
            },
          }
        : thread?.kind === "thread"
          ? {
              messageId: thread.messageId,
              threadRootId: rootOfTab(thread),
            }
          : {}),
    };
  };
  const keptTabReturn = useRef<{
    from: string;
    target: string;
    id: string;
    pane: "main" | "side";
  }>(undefined);
  const dismissContent = (
    visits: readonly string[],
    fallback: OpenTarget,
    pane: "main" | "side",
    entries = tabState.entries,
  ) => {
    keptTabReturn.current = undefined;
    if (!navigator) return;
    const keep =
      pane === "main" ? tabState.getMainSelected() : tabState.getSelected();
    const keptTab = tabState.tabs.find((tab) => tab.id === keep);
    const keptEntry = entries.find((entry) => panelTabId(entry) === keep);
    const current = navigator.snapshot().entry;
    if (
      keep !== undefined &&
      (keptTab ||
        keptEntry ||
        keep === "settings" ||
        (pane === "side" && tabState.sidePanel)) &&
      visits.includes(current.id) &&
      keptTab?.kind !== "thread" &&
      !(keptEntry && historyPanel(keptEntry))
    ) {
      // A local survivor has no routed address. Preserve it only for this
      // dismissal's matching return, never for unrelated later navigation.
      keptTabReturn.current = {
        from: current.id,
        target: targetKey(fallback),
        id: keep,
        pane,
      };
    }
    navigator.dismiss(visits, fallback);
  };
  const secondary = useConversationTabs({
    state: tabState,
    relay,
    session: queries,
    panels,
    current,
    scope,
    channels,
    profiles,
    conversationIcon,
    // A Solo chat beside another conversation keeps its own header actions.
    conversationToolbar: (channel, open) =>
      channel.channelType === "solo" && (
        <SoloToolbar
          chatMenus={chatMenus}
          key={channel.id}
          session={queries}
          scope={scope}
          channel={channel}
          navigator={navigator}
          signal={navigation?.signal}
          onOpen={open}
          onLifecycle={(action, trigger) =>
            handoff?.openLifecycle(channel, action, trigger, navigation?.signal)
          }
          onMove={(move) => trackSoloMove(channel.id, move)}
        />
      ),
    extensions,
    leadingIds: settings ? ["settings"] : [],
    threadId: routedThread?.messageId,
    mainPane: !solo,
    navigation: navigator,
    routed: routedThread,
    onVisitPanel: visitPanel,
    onCloseTabs: (tabs, entries, keep) => {
      const remaining = tabState.entries.filter(
        (entry) => panelTabId(entry) === keep,
      );
      const keptTab = tabState.tabs.find((tab) => tab.id === keep);
      const keptEntry = remaining[0];
      const pane = keptTab
        ? tabPane(keptTab)
        : keptEntry
          ? entryPane(tabState.mainEntries, keptEntry)
          : "main";
      const fallback = closeTarget(pane, remaining);
      if (!navigator || !fallback) return;
      const visits = [
        ...tabs.flatMap((tab) =>
          tab.kind === "thread"
            ? tabState.threadVisits(tab.channelId, rootOfTab(tab))
            : [],
        ),
        ...entries.flatMap((entry) =>
          historyPanel(entry)
            ? tabState.detailVisits(entry.channelId, entry.target)
            : [],
        ),
      ];
      dismissContent(
        visits,
        fallback,
        keep === "settings" ? "side" : pane,
        remaining,
      );
    },
    onClosePanel: (entry, remaining) => {
      if (!historyPanel(entry)) return;
      const pane = entryPane(tabState.mainEntries, entry);
      const fallback = closeTarget(pane, remaining);
      if (fallback)
        dismissContent(
          tabState.detailVisits(entry.channelId, entry.target),
          fallback,
          pane,
          remaining,
        );
    },
    onCloseThread: (tab, active, last) => {
      // X is explicit dismissal; Back/Forward never comes through this path.
      // Retire this tab's addressed visits, including ones behind the cursor.
      const fallback = closeTarget(tabPane(tab));
      if (navigator && fallback) {
        dismissContent(
          tabState.threadVisits(tab.channelId, rootOfTab(tab)),
          fallback,
          tabPane(tab),
        );
      }
      const trigger = threadTrigger.current;
      // While tabs remain, the opener takes focus only from within their pane.
      if (
        trigger &&
        (last ||
          trigger
            .closest("[data-panel-workspace], [data-main-workspace]")
            ?.hasAttribute(
              tabPane(tab) === "main"
                ? "data-main-workspace"
                : "data-panel-workspace",
            ))
      )
        returnFocus.current = { trigger, channelId: currentId };
      if (active && tab.channelId === currentId) highlightReturn(tab.rootId);
    },
    onRetryNavigation: () => void navigator?.retry(),
    onOpenDrawer: () => setSettings(undefined),
    continuingVisit,
    navigationSignal: navigation?.signal,
    isLive: () => !destination.current.navigation?.signal.aborted,
    openLink: (url) => openLink(url, { fromThread: true }),
    // A Solo conversation has no channel menu; its history takes focus instead.
    fallbackFocus: solo ? historyContainer : settingsTrigger,
    openMembers: () => setMembersOpen(true),
    eligible: (entry) =>
      !entry.panel.channelMenu ||
      !!(
        current &&
        current.id === entry.channelId &&
        !cached &&
        entry.panel.channelMenu.eligible(current, queries)
      ),
  });
  const focusConversation = useRef(false);
  const closeAllTabs = () => {
    if (!secondary.closeAllTabs()) return false;
    returnFocus.current = undefined;
    focusConversation.current = true;
    return true;
  };
  const focusKept = useRef<string>(undefined);
  const closeOtherTabs = (id: string) => {
    if (!secondary.closeOtherTabs(id)) return false;
    returnFocus.current = undefined;
    focusKept.current = id;
    return true;
  };
  const tabMenu = {
    key: JSON.stringify([scope, currentId]),
    closeAll: closeAllTabs,
    closeOthers: closeOtherTabs,
  };
  // The channel owns this command, including Solo chats without a main tab strip.
  useLayoutEffect(() => {
    const close = (event: Event) => {
      const workspace = historyContainer.current?.closest(
        "[data-channel-workspace]",
      );
      if (
        event.defaultPrevented ||
        !workspace?.isConnected ||
        workspace.closest('[hidden], [inert], [aria-hidden="true"]') ||
        !workspace.getClientRects().length ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      flushSync(() => {
        if (closeAllTabs()) event.preventDefault();
      });
    };
    window.addEventListener("buzz:close-all-tabs", close);
    return () => window.removeEventListener("buzz:close-all-tabs", close);
  });
  // The page's thread opener wins after the tab owner restores its fallback.
  useLayoutEffect(() => {
    if (focusConversation.current) {
      focusConversation.current = false;
      const focused = document.activeElement;
      // Keep typing in surviving content. A removed tab or closing context menu
      // needs a focus destination; clearing unrelated tabs does not.
      const preserved =
        focused instanceof HTMLElement &&
        focused !== document.body &&
        focused.isConnected &&
        !focused.closest(
          '[inert], [hidden], [aria-hidden="true"], [role="menu"]',
        );
      if (!preserved) {
        const target =
          channelConversation.current
            ?.closest("[data-main-workspace]")
            ?.querySelector<HTMLElement>(
              '[role="tab"][data-tab-value="conversation"]',
            ) ?? (solo ? historyContainer.current : settingsTrigger.current);
        target?.focus({ preventScroll: true });
      }
    }
    // A pane whose selected tab closed refocuses its new selection; the kept
    // tab, where the menu was, takes focus back.
    const kept = focusKept.current;
    if (kept !== undefined) {
      focusKept.current = undefined;
      historyContainer.current
        ?.closest("[data-channel-workspace]")
        ?.querySelector<HTMLElement>(
          `[role="tab"][data-tab-value="${CSS.escape(kept)}"]`,
        )
        ?.focus({ preventScroll: true });
    }
    const pending = returnFocus.current;
    if (!pending) return;
    if (pending.channelId !== currentId || !pending.trigger.isConnected) {
      returnFocus.current = undefined;
      return;
    }
    // The close commit gets one focus handoff, never a deferred request that
    // can override a later, unrelated tab selection.
    returnFocus.current = undefined;
    if (pending.trigger.closest('[inert], [hidden], [aria-hidden="true"]'))
      return;
    if (!document.querySelector('dialog[open], [aria-modal="true"]'))
      pending.trigger.focus({ preventScroll: true });
  });
  const {
    open,
    drawer,
    drawerContext,
    selectedTab,
    selectPanelTab,
    afterClose,
    panelTrigger,
    splitTrigger,
  } = secondary;
  useLayoutEffect(() => {
    // Navigation temporarily withdraws the old presentation while preparing
    // the next destination. That handoff must not dismiss saved thread tabs.
    if (!navigation || navigation.signal.aborted) return;
    if (draft || composingMessage) open(undefined);
    // Each visit is applied once: Back/Forward switch tabs, never close them,
    // and a closed tab is not reopened by a re-render of the same visit. A
    // message still resolving its placement waits rather than recording.
    if (routedThread || !requestedMessage || exact?.inTimeline) {
      const detail =
        navigation.target.kind === "conversation"
          ? navigation.target.detail
          : undefined;
      const kept = keptTabReturn.current;
      const retained =
        kept &&
        (kept.pane === "main"
          ? tabState.getMainSelected()
          : tabState.getSelected()) === kept.id;
      tabState.enterVisit(
        `${navigation.entryId}:${detail ? "detail" : routedThread ? "thread" : "channel"}`,
        detail ? undefined : routedThread,
        !!detail,
        detail && currentId
          ? { channelId: currentId, target: detail.target }
          : undefined,
      );
      if (detail && currentId) {
        const entry = panelOpening(
          panels,
          currentId,
          detail.target,
          detail.rootId,
        );
        if (entry && historyPanel(entry)) open(entry);
        else navigation.complete({ status: "failed", reason: "unavailable" });
      }
      if (kept && navigation.entryId !== kept.from) {
        keptTabReturn.current = undefined;
        if (retained && targetKey(navigation.target) === kept.target) {
          if (kept.pane === "main") tabState.selectMain(kept.id);
          else {
            tabState.select(kept.id);
            tabState.setPaneOpen(true);
          }
          focusKept.current = kept.id;
        }
      }
      if (navigation.focus === "preserve") setPreservedVisit(navigation);
    }
    const activity = handoff?.activityThread.current;
    if (
      activity &&
      activity.channelId === requestedChannel &&
      activity.messageId === requestedMessage &&
      activity.entryId === navigation?.entryId &&
      !activity.signal.aborted &&
      exact?.request === navigation
    ) {
      threadTrigger.current = activity.trigger;
      handoff.activityThread.current = undefined;
    }
    const activityAgent = handoff?.activityAgent.current;
    if (activityAgent && activityAgent.channelId === currentId) {
      const { transcript } = activityAgent;
      const target = profileActivityViewTarget(activityAgent.agent);
      const panel = target && panels.resolve(target);
      if (target && panel) {
        panelTrigger.current = activityAgent.trigger;
        const show = (next: string) => {
          open(
            {
              channelId: activityAgent.channelId,
              ...(transcript?.rootId && { rootId: transcript.rootId }),
              panel,
              target: next,
            },
            true,
          );
          return true;
        };
        // Only a known conversation asks for its transcript.
        if (transcript) openProfileTranscript(target, show);
        else show(target);
      }
      handoff.activityAgent.current = undefined;
    }
  }, [
    draft,
    composingMessage,
    requestedMessage,
    navigation,
    requestedChannel,
    open,
    handoff?.activityThread,
    exact?.request,
    exact?.inTimeline,
    routedThread,
    tabState.enterVisit,
    tabState.select,
    tabState.selectMain,
    tabState.setPaneOpen,
    tabState.getSelected,
    tabState.getMainSelected,
    handoff?.activityAgent,
    currentId,
    panels,
    panelTrigger,
  ]);
  // Menu panels belong to one visit. Retire only this visit's keyed entries.
  useEffect(() => {
    if (!currentId) return;
    return () => retireMenuEntries();
  }, [currentId, retireMenuEntries]);
  const mounted = useRef(false);
  const channel = useRef(current?.id);
  useLayoutEffect(() => {
    channel.current = current?.id;
  }, [current?.id]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openChannelThread = useCallback(
    (
      channelId: string,
      messageId: string,
      threadRootId: string,
      intent?: "reply",
    ) => {
      setSettings(undefined);
      threadTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      // Record where Back should return before this opening changes tabs.
      tabState.leaveVisit();
      // Retire transient details first; selecting the thread is the last word.
      open(undefined);
      // Every opening keeps existing work: a new thread adds a tab and an
      // open one is selected wherever it was placed.
      tabState.openThreadTab(
        channelId,
        messageId,
        threadRootId,
        intent,
        threadPane,
      );
      const target = navigator?.snapshot().entry.target;
      if (
        navigator &&
        viewer &&
        !(
          target?.kind === "conversation" &&
          target.channelId === channelId &&
          target.messageId === messageId &&
          target.threadRootId === threadRootId
        )
      )
        void navigator.open({
          version: 1,
          kind: "conversation",
          channelId,
          messageId,
          threadRootId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        });
    },
    [
      navigator,
      viewer,
      scope,
      open,
      setSettings,
      threadPane,
      tabState.openThreadTab,
      tabState.leaveVisit,
    ],
  );
  const openThread = useCallback(
    (messageId: string, threadRootId: string, intent?: "reply") => {
      if (currentId)
        openChannelThread(currentId, messageId, threadRootId, intent);
    },
    [currentId, openChannelThread],
  );
  // Closing a linked thread returns focus to its link, as an opened thread does.
  const openLinkedThread = useCallback(
    (channelId: string, messageId: string, rootId: string) => {
      const trigger =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (!secondary.openLinkedThread(channelId, messageId, rootId))
        return false;
      threadTrigger.current = trigger;
      return true;
    },
    [secondary.openLinkedThread],
  );
  const mediaReviewTrigger = useRef<HTMLElement | null>(null);
  const [mediaReview, setMediaReview] = useState<{
    channelId: string;
    channelName: string;
    messageId: string;
    attachment: Attachment;
    initialAttachments?: readonly Attachment[] | undefined;
    initialTime: number;
    hasComments: boolean;
    entryId?: string | undefined;
  }>();
  // The current destination may be an authorized public preview, which is
  // intentionally absent from the joined-channel list.
  const showingMediaReview = current?.archived
    ? undefined
    : mediaReviewForDestination(mediaReview, current?.id, navigation?.entryId);
  useEffect(() => {
    if (mediaReview && !showingMediaReview) setMediaReview(undefined);
  }, [mediaReview, showingMediaReview]);
  // Timeline rows are memoized; their callbacks read the shown destination at
  // call time so a new navigation request does not rerender every row.
  const destination = useRef({ current, navigation });
  useLayoutEffect(() => {
    destination.current = { current, navigation };
  }, [current, navigation]);
  const openMediaReview = useCallback(
    (
      messageId: string,
      attachment: Attachment,
      initialTime: number,
      hasComments = false,
      initialAttachments?: readonly Attachment[],
    ) => {
      const { current, navigation } = destination.current;
      if (!current) return;
      setSettings(undefined);
      mediaReviewTrigger.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMediaReview({
        channelId: current.id,
        channelName: current.name,
        messageId,
        attachment,
        initialTime,
        hasComments,
        initialAttachments,
        ...(navigation ? { entryId: navigation.entryId } : {}),
      });
    },
    [setSettings],
  );
  // Availability follows active contributions; dispatch still re-resolves at click time.
  const canOpenLink = useCallback(
    (target: string) =>
      available.some((candidate) => {
        try {
          return candidate.matches(target);
        } catch {
          return false;
        }
      }),
    [available],
  );
  const linkContext = useRef({
    channelId: currentId,
    routedThread: !!routedThread,
  });
  useLayoutEffect(() => {
    linkContext.current = {
      channelId: currentId,
      routedThread: !!routedThread,
    };
  }, [currentId, routedThread]);
  const openLink = useCallback(
    (
      url: string,
      {
        fromThread = false,
        returnFocus,
        rootId,
      }: {
        fromThread?: boolean;
        returnFocus?: HTMLElement | undefined;
        rootId?: string;
      } = {},
    ) => {
      const { current, navigation } = destination.current;
      const connection = relay.snapshot();
      if (
        !mounted.current ||
        channel.current !== current?.id ||
        connection.status !== "ready" ||
        connection.session !== queries ||
        navigation?.signal.aborted
      )
        return false;
      const parsed = parseBuzzLink(url);
      const linkedChat =
        parsed?.format === "legacy" &&
        !parsed.messageId &&
        queries.channels
          .list()
          .channels.find(
            (item) =>
              item.id === parsed.channelId &&
              item.channelType === "solo" &&
              !item.cached &&
              !item.readOnly &&
              !item.archived &&
              item.members?.includes(queries.viewer ?? ""),
          );
      if (linkedChat && linkedChat.id !== current?.id) {
        const id = `conversation:${linkedChat.id}`;
        tabState.setTabs((tabs) =>
          tabs.some((tab) => tab.id === id)
            ? tabs
            : [...tabs, { id, kind: "conversation", channelId: linkedChat.id }],
        );
        tabState.select(id);
        return true;
      }
      if (isBuzzLink(url) && navigator && viewer) {
        const target = buzzLinkTarget(url, {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        });
        // Internal panel targets also use buzz:. Only routable links belong
        // to the navigator; registered panels handle the remaining targets.
        if (target) {
          if (target.kind === "conversation" && target.messageId) {
            tabState.leaveVisit();
            threadTrigger.current =
              document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          }
          open(undefined);
          void navigator.open(target);
          return true;
        }
      }
      const { channelId, routedThread } = linkContext.current;
      const next = channelId && panelOpening(panels, channelId, url, rootId);
      if (next) {
        setSettings(undefined);
        panelTrigger.current =
          returnFocus ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null);
        // Thread-origin details cover the live thread instead of retiring it.
        if (!fromThread && routedThread && !historyPanel(next))
          select(channelId);
        open(next, fromThread);
        return true;
      }
      return false;
    },
    [
      panels,
      open,
      relay,
      queries,
      select,
      navigator,
      viewer,
      scope,
      setSettings,
      // The stable actions, not tabState: every tab change would otherwise
      // recreate openLink and re-render each memoized message row.
      tabState.setTabs,
      tabState.select,
      tabState.leaveVisit,
      panelTrigger,
    ],
  );
  // An agent's request to show something here opens as a link would.
  useEffect(
    () =>
      panels.handleOpenRequests(({ target, channelId, rootId }) =>
        channelId === linkContext.current.channelId
          ? openLink(target, rootId ? { rootId, fromThread: true } : {})
          : false,
      ),
    [panels, openLink],
  );
  const hasChannelPanel =
    !composingMessage &&
    !draft &&
    (settings || secondary.items.length > 0 || drawer.side);
  const hasPanel = companion || hasChannelPanel;
  const showingChannelPanel = tabState.paneOpen && hasChannelPanel;
  const showingPanel = companion || showingChannelPanel;
  // A plain channel visit reads its visible selected thread along with the
  // conversation that holds focus. A link to a message or thread, passive
  // restoration and another channel’s retained tab do not.
  const readingThread =
    showingChannelPanel &&
    !companion &&
    !requestedMessage &&
    !requestedThread &&
    !membersOpen &&
    !showingMediaReview &&
    (navigation?.focus ?? navigator?.snapshot().attempt.focus) !== "preserve" &&
    tabState.tabs.some(
      (tab) =>
        tab.kind === "thread" &&
        tab.id === selectedTab &&
        tab.channelId === currentId,
    );
  // While the companion is in the dock it keeps its width and bounds from
  // other pages; threads alone keep their own split.
  const split = usePanelSplit(
    scope,
    companion ? COMPANION_SPLIT.name : "channels",
    companion ? COMPANION_SPLIT.defaultWidth : undefined,
    companion ? COMPANION_SPLIT.min : undefined,
  );
  // A routed thread can mount behind a collapsed pane, where it cannot take
  // focus, or already be selected, so its pane does not move focus. Once its
  // tab shows, hand it focus nothing else took.
  const routedTab =
    routedThread && !membersOpen
      ? tabState.tabs.find(
          (tab) =>
            tab.kind === "thread" &&
            tab.channelId === routedThread.channelId &&
            tab.messageId === routedThread.messageId &&
            (tabPane(tab) === "main"
              ? tabState.mainSelected === tab.id
              : showingChannelPanel && !companion && selectedTab === tab.id),
        )?.id
      : undefined;
  const routedVisit = useRef<AbortSignal | string | undefined>(undefined);
  useLayoutEffect(() => {
    const visit = navigation?.signal ?? currentId;
    if (!routedTab || routedVisit.current === visit) return;
    routedVisit.current = visit;
    if (document.activeElement !== document.body) return;
    split.ref.current
      ?.querySelector<HTMLElement>(
        `[role="tab"][data-tab-value="${CSS.escape(routedTab)}"]`,
      )
      ?.focus({ preventScroll: true });
  }, [routedTab, navigation?.signal, currentId, split.ref]);
  useEffect(() => {
    // Only an explicit settings click moves focus; restoring a visit does not.
    if (settingsFocus)
      split.ref.current
        ?.querySelector<HTMLElement>(
          '[data-panel-workspace] [data-tab-value="settings"]',
        )
        ?.focus({ preventScroll: true });
  }, [settingsFocus, split.ref]);
  const settingsContent = (
    <ChannelSettingsPanel
      scope={scope}
      {...(current?.channelType !== "solo" ? { openMembers } : {})}
      key={settings?.id}
      setupTools={
        current &&
        handoff &&
        (!current.readOnly || current.viewerRole === "guest") &&
        current.channelType !== "dm" && (
          <ChannelLifecycleActions
            key={`${current.id}:${!!current.archived}`}
            channelId={current.id}
            lifecycle={queries.channelLifecycle}
            noun={lifecycleNoun(current)}
            choose={(action, trigger) =>
              handoff.openLifecycle(current, action, trigger)
            }
          />
        )
      }
      channel={current}
      details={queries.channelDetails}
      close={closeSettings}
    >
      <UnreadOptions session={queries} channelId={current?.id} />
      <LiveStatus
        live={queries.live}
        channelId={current?.id}
        partialRoster={list.coverage === "partial"}
        diagnostics
      />
      <p>
        {list.coverage === "partial" ? "Partial roster" : "Roster"} ·{" "}
        {channels.length} channels
      </p>
      <Button type="button" onClick={() => queries.channels.refreshList?.()}>
        Refresh channels
      </Button>
      {preferences.error && <p>Saved groups and stars: {preferences.error}</p>}
      {preferences.status !== "unsupported" && (
        <Button
          type="button"
          disabled={preferences.status === "loading"}
          onClick={preferences.reload}
        >
          Refresh groups and stars
        </Button>
      )}
      {current && (
        <Button
          type="button"
          onClick={() => queries.channels.refresh?.(current.id)}
        >
          Refresh messages
        </Button>
      )}
      {queries.outbox ? (
        <OutboxStatus
          outbox={queries.outbox}
          profiling={queries.profiling}
          memberAdditions={queries.memberAdditions}
        />
      ) : (
        <RelayTimings profiling={queries.profiling} />
      )}
    </ChannelSettingsPanel>
  );
  const focusArchivedHistory = useCallback(() => {
    const history = historyContainer.current;
    if (
      !currentId ||
      !queries.channels.get?.(currentId)?.archived ||
      !history?.isConnected ||
      history.closest("[inert]")
    )
      return;
    (
      history.querySelector<HTMLElement>("[data-message-scroller]") ?? history
    ).focus({ preventScroll: true });
  }, [currentId, queries.channels]);
  const channelNotice =
    !!current &&
    (current.archived ||
      (current.readOnly &&
        (!current.cached || current.viewerRole === "guest")));
  useChannelHistoryFocus(
    historyContainer,
    navigation,
    current?.viewerRole === "guest" &&
      !current.cached &&
      !membersOpen &&
      !showingMediaReview,
    contentReadyChannel === currentId,
  );
  // The conversation: full width for Solo, or the first main-pane tab.
  const body = (
    <>
      <MessageManagementStatus />
      <section
        data-channel-history
        aria-label={
          solo && current ? `Chat ${current.name}` : "Channel history"
        }
        tabIndex={-1}
        ref={historyContainer}
        className={`relative flex min-h-0 flex-col${current ? " flex-1" : ""}`}
      >
        {current ? (
          <ChannelBody
            onContentReady={setContentReadyChannel}
            viewer={viewer}
            key={current.id}
            cached={cached}
            // The composer below mounts TypingIndicator for members of a live channel.
            navigation={
              !requestedMessage || exact?.inTimeline ? navigation : undefined
            }
            onOpenThread={openThread}
            revealMessageId={
              sent?.channelId === current.id ? sent.id : undefined
            }
          />
        ) : (
          <div
            className={styles.empty}
            data-buzz-launch-pending={
              resolving && !navigation?.signal.aborted ? "required" : undefined
            }
          >
            {resolving
              ? "Checking conversation access…"
              : "Select a channel to read it."}
          </div>
        )}
        {current && channelNotice && (
          <ChannelJoinNotice
            key={`join:${current.id}`}
            ready={contentReadyChannel === current.id}
            channelId={current.id}
            archived={!!current.archived}
            place={solo ? "chat" : "channel"}
            guest={current.viewerRole === "guest"}
            joinRole={current.joinRole}
            lifecycle={queries.channelLifecycle}
            joinable={
              !current.archived &&
              (current.channelType === "stream" ||
                current.channelType === "forum" ||
                (current.channelType === "solo" &&
                  current.joinRole === "guest"))
            }
            onJoin={() => setJoiningChannel(current.id)}
            onHeightChange={setJoinNoticeHeight}
          />
        )}
      </section>
      {!cached && (
        <LiveStatus
          live={queries.live}
          recovery={queries.recovery}
          channelId={current?.id}
          partialRoster={list.coverage === "partial"}
          // Recovery removes the focused retry control. Hand focus on
          // explicitly; previews have no composer, so use their history.
          onRecovered={
            current
              ? () => {
                  if (channelNotice) {
                    const history = historyContainer.current;
                    const target =
                      history?.querySelector<HTMLElement>(
                        "[data-message-scroller]",
                      ) ?? history;
                    target?.focus({ preventScroll: true });
                  } else {
                    setComposerFocus((value) => value + 1);
                  }
                }
              : undefined
          }
        />
      )}
      {current &&
        !current.archived &&
        current.viewerRole !== "guest" &&
        (!current.readOnly || current.cached) && (
          <ConversationComposer
            key={`composer:${current.id}`}
            onFocusedRemoval={focusArchivedHistory}
            autoFocus={
              // Remote unarchive restores controls within the reader's current visit.
              !(continuingVisit && committedVisit.current?.archived) &&
              // Conversion remounts the body, but isn't a new conversation opening.
              // Its dialog hands off focus after closing and releasing modality.
              !(
                continuingVisit &&
                committedVisit.current?.channelType === "solo" &&
                current.channelType !== "solo"
              ) &&
              // The bound request arrives after the composer's first render.
              (navigation?.focus ?? navigator?.snapshot().attempt.focus) !==
                "preserve" &&
              !current.readOnly &&
              !requestedMessage &&
              !requestedThread &&
              !routedThread
            }
            trailingTool={
              solo ? (
                <WorkspaceControl session={queries} channelId={current.id} />
              ) : undefined
            }
            onSend={onComposerSend}
            focusRequest={composerFocus}
          />
        )}
    </>
  );
  const workspace = (
    <div
      data-channel-workspace={currentId ?? ""}
      data-reading-thread={readingThread ? "" : undefined}
      data-companion={companion ? "" : undefined}
      ref={split.ref}
      style={split.style}
      className={`${styles.board} ${panelStyles.splitMotion}`}
    >
      {current && membersOpen && (
        <ChannelMembersDialog
          key={current.id}
          session={queries}
          channelId={current.id}
          communities={communities}
          // Routed Members is a navigation visit; without a navigator it is local.
          visit={!!navigator}
          close={() => setMembersOpen(false)}
          trigger={
            membersTrigger.current?.isConnected
              ? membersTrigger
              : membersHeaderTrigger
          }
          canOpenLink={canOpenLink}
          {...(agents ? { agents } : {})}
          onOpenLink={(url, returnFocus) => openLink(url, { returnFocus })}
          onOpenConversation={
            navigator && viewer
              ? (id) => openLink(`buzz://channel/${encodeURIComponent(id)}`)
              : undefined
          }
        />
      )}
      <Panel
        as="article"
        aria-label="Conversation"
        data-overlay-boundary=""
        data-solo-focus-pane={solo ? "" : undefined}
      >
        <div
          className={`${styles.conversation}${solo ? ` ${styles.soloConversation}` : ""}`}
          style={
            {
              "--channel-preview-inset": channelNotice
                ? `calc(${joinNoticeHeight}px + var(--space-3))`
                : "0px",
            } as React.CSSProperties
          }
          data-attachment-drop-zone=""
        >
          {composingMessage ? (
            <LiveNewMessage
              host={{ relay, panels, navigation: navigator }}
              session={queries}
              scope={scope}
              extensions={extensions}
              onPreparing={(pubkeys) => handoff?.prepareDm(pubkeys)}
              onOpenThread={openChannelThread}
              onStarted={(channelId, id) => {
                handoff?.clearPreparingDm();
                if (behindSettings()) return;
                setSent({ channelId, id });
                select(channelId);
              }}
            />
          ) : draft?.linked && !linkedSource ? (
            <EmptyState
              icon={<ChatCircleIcon />}
              title="Draft unavailable"
              description="This linked chat draft is unavailable. Start again from its source."
            />
          ) : draft ? (
            <SoloDraft
              key={JSON.stringify([
                draft.project,
                draft.agent,
                draft.linked,
                retiredSoloDraft.generation,
              ])}
              linkedId={draft.linked}
              source={linkedSource}
              focusRequest={
                navigation?.focus === "preserve" ||
                (retiredSoloDraft.generation > 0 &&
                  retiredSoloDraft.signal === navigation?.signal)
                  ? 0
                  : (navigation?.signal ?? 0)
              }
              agent={draft.agent}
              projectId={draft.project}
              session={queries}
              scope={scope}
              extensions={extensions}
              onStarted={(channelId) => {
                if (!behindSettings()) select(channelId);
                else
                  setRetiredSoloDraft(({ generation }) => ({
                    generation: generation + 1,
                    signal: navigation?.signal,
                  }));
              }}
              onFailed={(channelId, message, retry) => {
                notify(
                  message,
                  "error",
                  retry
                    ? {
                        label: "Retry restoring message",
                        onClick: () => void retry(),
                        timeout: Infinity,
                      }
                    : undefined,
                );
                // A failure behind Settings must not navigate away from it.
                if (
                  showing.current === channelId &&
                  navigator &&
                  !behindSettings()
                )
                  void navigator.open(soloDraftTarget(scope, draft));
              }}
            />
          ) : (
            <>
              {current && solo ? (
                <SoloHeading
                  chatMenus={chatMenus}
                  key={`${current.id}:${navigation?.entryId ?? ""}`}
                  session={queries}
                  scope={scope}
                  channel={current}
                  navigator={navigator}
                  signal={navigation?.signal}
                  onConvert={(trigger) =>
                    setConversion({
                      channelId: current.id,
                      navigation,
                      trigger,
                    })
                  }
                  onLifecycle={(action, trigger) =>
                    chooseLifecycle(current, action, trigger)
                  }
                  onMove={(move) => trackSoloMove(current.id, move)}
                  paneToggle={
                    hasChannelPanel &&
                    !showingChannelPanel && (
                      <span className={panelStyles.paneToggle}>
                        <IconButton
                          hint="familiar"
                          ref={splitTrigger}
                          data-tab-pane-toggle=""
                          size="toolbar"
                          aria-label="Toggle tab pane"
                          title="Open tab pane"
                          aria-expanded={false}
                          icon={<SidebarRightIcon size="1rem" />}
                          onClick={() => tabState.setPaneOpen(true)}
                        />
                      </span>
                    )
                  }
                >
                  {drawer.launchers}
                </SoloHeading>
              ) : null}
              {solo ? (
                body
              ) : (
                <div className={styles.mainWorkspace}>
                  <PanelWorkspace
                    main
                    tabMenu={tabMenu}
                    drag={secondary.drag.main}
                    label="Channel tabs"
                    focusOnMount={false}
                    adoptSelection={preservedVisit}
                    value={secondary.selectedMain}
                    select={(id) =>
                      tabState.selectMain(
                        id === "conversation" ? undefined : id,
                      )
                    }
                    actions={
                      <>
                        {current && (
                          <IconButton
                            size="sm"
                            variant="avatar"
                            style={{
                              width: "auto",
                              minWidth: "var(--size-control-sm)",
                              paddingInline: "var(--space-1)",
                            }}
                            aria-label="Manage members"
                            title="Manage members"
                            aria-haspopup="dialog"
                            ref={membersHeaderTrigger}
                            aria-expanded={membersOpen}
                            onClick={(event) =>
                              openMembers(event.currentTarget)
                            }
                            icon={
                              <ChannelMemberAvatars
                                session={queries}
                                channelId={current.id}
                              />
                            }
                          />
                        )}
                        {drawer.launchers}
                        <ChannelHeaderMenu
                          startChat={
                            navigator &&
                            current &&
                            canStartLinkedChat(queries, current.id) ? (
                              <StartLinkedChat
                                session={queries}
                                navigation={navigator}
                                channelId={current.id}
                              />
                            ) : undefined
                          }
                          key={`channel-actions:${currentId ?? "empty"}`}
                          channel={current}
                          session={queries}
                          origin={navigation?.signal}
                          trigger={settingsTrigger}
                          finishConversion={
                            current && conversions.has(current.id)
                              ? () =>
                                  setConversion({
                                    channelId: current.id,
                                    navigation,
                                    trigger: settingsTrigger.current,
                                  })
                              : undefined
                          }
                          openDetails={() => {
                            drawer.close();
                            requestSettingsFocus((value) => value + 1);
                            setSettings({ channelId: currentId });
                          }}
                          menuPanels={
                            current && !cached
                              ? available.filter((panel) =>
                                  panel.channelMenu?.eligible(current, queries),
                                )
                              : []
                          }
                          openMenuPanel={(panel) => {
                            const connection = relay.snapshot();
                            const channel = queries.channels
                              .list()
                              .channels.find((item) => item.id === currentId);
                            if (
                              connection.status !== "ready" ||
                              connection.cached ||
                              connection.session !== queries ||
                              !drawerContext ||
                              drawerContext.channelId !== channel?.id ||
                              !channel ||
                              channel.cached ||
                              (channel.readOnly &&
                                channel.viewerRole !== "guest") ||
                              !channel.members?.includes(
                                queries.viewer ?? "",
                              ) ||
                              !panels.snapshot().includes(panel) ||
                              !panel.channelMenu?.eligible(channel, queries)
                            )
                              return;
                            drawer.close();
                            panelTrigger.current = settingsTrigger.current;
                            open(
                              {
                                panel,
                                channelId: channel.id,
                                target: channel.id,
                                channelContext: drawerContext,
                              },
                              true,
                            );
                          }}
                        />
                        {current && hasChannelPanel && !showingChannelPanel && (
                          <span className={panelStyles.paneToggle}>
                            <IconButton
                              hint="familiar"
                              ref={splitTrigger}
                              data-tab-pane-toggle=""
                              size="toolbar"
                              aria-label="Toggle tab pane"
                              title={
                                showingChannelPanel
                                  ? "Close tab pane"
                                  : "Open tab pane"
                              }
                              aria-expanded={!!showingChannelPanel}
                              onClick={() =>
                                tabState.setPaneOpen(!showingChannelPanel)
                              }
                              icon={
                                <SidebarRightIcon
                                  size="1rem"
                                  aria-hidden="true"
                                />
                              }
                            />
                          </span>
                        )}
                      </>
                    }
                    items={[
                      {
                        id: "conversation",
                        label: current?.name ?? "Channels",
                        icon: <CurrentChannelIcon size="1rem" />,
                        content: (
                          <div
                            ref={channelConversation}
                            className={styles.conversation}
                          >
                            {body}
                          </div>
                        ),
                      },
                      ...secondary.mainItems,
                    ]}
                  />
                </div>
              )}
              {drawer.content}
            </>
          )}
        </div>
      </Panel>
      {conversion &&
        conversion.channelId === currentId &&
        conversion.navigation === navigation && (
          <ConvertToChannel
            session={queries}
            id={conversion.channelId}
            signal={conversion.navigation?.signal}
            close={() => setConversion(undefined)}
            onConverted={() => {
              setComposerFocus((value) => value + 1);
            }}
            finalFocus={() =>
              conversion.navigation?.signal.aborted
                ? false
                : conversion.trigger?.isConnected
                  ? conversion.trigger
                  : (settingsTrigger.current ?? false)
            }
          />
        )}
      {secondary.drag.feedback}
      {secondary.hosts}
      <p role="status" className="sr-only">
        {secondary.announcement}
      </p>
      <PanelDock
        open={!!showingPanel && !showingMediaReview}
        keepMounted={
          tabState.entries.length > 0 || (!!hasPanel && !tabState.paneOpen)
        }
        className={styles.panelStack}
        resizeHandle={split.handle}
      >
        {hasPanel && !showingMediaReview && (
          <>
            {hasChannelPanel && (settings || secondary.items.length > 0) && (
              <div
                className={styles.retainedPanel}
                hidden={!!companion && !showingChannelPanel}
              >
                <PanelWorkspace
                  key={currentId}
                  actions={
                    <IconButton
                      hint="familiar"
                      data-tab-pane-toggle=""
                      data-highlight-expanded="false"
                      variant="subtle"
                      size="toolbar"
                      aria-label="Toggle tab pane"
                      title="Close tab pane"
                      aria-expanded={true}
                      onClick={secondary.closePane}
                      icon={<SidebarRightIcon size="1rem" aria-hidden="true" />}
                    />
                  }
                  tabMenu={tabMenu}
                  drag={secondary.drag.side}
                  value={selectedTab}
                  focusOnMount={
                    !membersOpen && (continuingVisit || !!routedThread)
                  }
                  select={selectPanelTab}
                  items={[
                    ...(settings
                      ? [
                          {
                            id: "settings",
                            label: "Channel settings",
                            icon: <GearIcon size="1rem" />,
                            close: closeSettings,
                            content: settingsContent,
                          },
                        ]
                      : []),
                    ...secondary.items,
                  ]}
                />
              </div>
            )}
            {hasChannelPanel && drawer.side && (
              <div
                className={styles.retainedPanel}
                hidden={
                  showingSettings || (!!companion && !showingChannelPanel)
                }
              >
                {drawer.side}
              </div>
            )}
            {companion && (
              <div key="companion" className={styles.companion}>
                {companion}
              </div>
            )}
          </>
        )}
      </PanelDock>
    </div>
  );
  return (
    // The review reads thread-tab links like the workspace.
    <LinkThreadTabContext value={openLinkedThread}>
      <ConversationChannel
        session={queries}
        scope={scope}
        extensions={extensions}
        channel={current}
        interactions={{
          onOpenLink: openLink,
          canOpenLink,
          onOpenMediaReview: openMediaReview,
        }}
        mediaReview={
          showingMediaReview && {
            ...showingMediaReview,
            restoreFocus: mediaReviewTrigger,
            close: () => setMediaReview(undefined),
          }
        }
      >
        {workspace}
      </ConversationChannel>
      {soloMoveNotices}
    </LinkThreadTabContext>
  );
}

export function mediaReviewForDestination<
  T extends { channelId: string; entryId?: string | undefined },
>(
  review: T | undefined,
  channelId: string | undefined,
  entryId: string | undefined,
): T | undefined {
  return review &&
    review.channelId === channelId &&
    (review.entryId === undefined || review.entryId === entryId)
    ? review
    : undefined;
}

/** A DM tab shows the other participant in a 1rem slot, so it asks for the
 * relay thumbnail message rows already loaded rather than the original. */
export function ConversationIcon({
  item,
  picture,
  media,
}: {
  item: Pick<ChannelSummary, "name" | "channelType" | "private">;
  picture: string | undefined;
  media: RelaySession["media"];
}) {
  const Icon = channelIcon(item);
  return item.channelType === "dm" ? (
    <span className={tabStyles.icon}>
      <Avatar
        alt=""
        fallback={item.name}
        size="fill"
        src={avatarMedia(picture, media)}
      />
    </span>
  ) : (
    <Icon size="1rem" />
  );
}
