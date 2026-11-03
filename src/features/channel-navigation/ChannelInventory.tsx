import { revealCreatedChannel } from "./created-channel";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type ComponentProps,
} from "react";
import { ChannelLifecycleMenu } from "../../bundled/channels/ChannelLifecycleMenu";
import { lifecycleNoun } from "../../bundled/channels/ChannelLifecycleDialog";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";
import { inTeamInventory } from "./team-inventory";
import type { RelayData } from "../relay/service";
import type { Agents } from "../agents/service";
import type { RelaySession } from "../relay/session";
import { useChannelList } from "../relay/react";
import type { Navigation } from "../navigation/controller";
import type { OpenTarget } from "../navigation/targets";
import type {
  RegisteredSidebarSection,
  SidebarSections,
} from "./sidebar-sections-service";
import {
  sidebarRow,
  sidebarRowSortModes,
  sortSidebarRows,
  type SidebarRows,
  type RegisteredSidebarRows,
} from "./sidebar-rows-service";
import { useSidebarRowUnread } from "./useSidebarRowUnread";
import type { SidebarSortMode } from "../relay/sidebar-sort";
import type { SidebarFrame } from "./SidebarFrame";
import { Button } from "../../shared/design-system/ui/Button";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuSeparator,
} from "../../shared/design-system/ui/Menu";
import type { ChannelSummary } from "../relay/contracts";
import { useChannelRowMenu } from "../../bundled/channels/useChannelRowMenu";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { useRecoveryOwns } from "../relay/RecoveryNotice";
import { rosterRecovering } from "../relay/live-recovery";
import { clientMetrics } from "../developer/client-metrics";
import {
  BellIcon,
  BellSlashIcon,
  ChatCircleIcon,
  FolderSimpleIcon,
  MinusIcon,
  PlusIcon,
} from "../../shared/design-system/icons";
import { ChannelReadMenuItem } from "../../bundled/channels/ChannelReadMenuItem";
import { ChannelCopyLinkMenuItem } from "../../bundled/channels/ChannelCopyLinkMenuItem";
import { ChannelSidebarItem } from "../../bundled/channels/ChannelSidebarItem";
import { ChannelSidebarRows } from "./ChannelSidebarRows";
import { activeChannelRows } from "./active-channel-rows";
import type { UnreadDmPreview } from "../../bundled/channels/SidebarUnread";
import {
  ChannelSidebarDnd,
  DraggableChannel,
  DroppableSidebarSection,
} from "./ChannelSidebarDnd";
import { channelIcon } from "../channels/channel-icon";
import { SidebarGroupIcon } from "../../bundled/channels/SidebarGroupIcon";
import { CreateSidebarSection } from "../../bundled/channels/CreateSidebarSection";
import { useSidebarStartup } from "../../bundled/channels/useSidebarStartup";
import { useChannelLabels } from "../../bundled/channels/useChannelLabels";
import { useHiddenDms } from "../../bundled/channels/useHiddenDms";
import { useSidebarPreferences } from "../../bundled/channels/useSidebarPreferences";
import { useSidebarView } from "../../bundled/channels/useSidebarView";
import { useSidebarFilters } from "../../bundled/channels/useSidebarFilters";
import {
  sidebarSections,
  contributedSidebarSectionKey,
  isChannelSectionKey,
  isChannelDropSectionKey,
  orderContributedSidebarSections,
} from "../../bundled/channels/sidebar-sections";
import { activityTranscript } from "../../bundled/channels/working-agents";
import { SidebarContributionSection } from "./SidebarContributionSection";
import {
  ContributionBoundary,
  contributionKey,
} from "../conversation/ContributionBoundary";
import {
  CreateChannelDialog,
  type CreateChannelInput,
} from "../../bundled/channels/CreateChannelDialog";
import { writeView } from "../../shared/view-state";
import { useChannelReadAction } from "../../bundled/channels/useChannelReadAction";
import {
  type ChannelMenuSurface,
  useChannelNavigation,
} from "./ChannelNavigationState";
import { splitPartition } from "../relay/partition";
import styles from "../../bundled/channels/Channels.module.css";
import { avatarMedia } from "../../shared/avatar-source";
import { useBestieConversation } from "../../app/shell/bestie-context";

/** The sidebar entry selected by a destination, excluding nested message state. */
export function sidebarEntryLocation(target: OpenTarget) {
  return target.kind === "conversation"
    ? `conversation:${target.channelId}`
    : target.kind === "page"
      ? `page:${target.pluginId}/${target.pageId}:${JSON.stringify(target.route?.params ?? null)}`
      : target.kind;
}

type Inventory = {
  sidebar: ReturnType<typeof useSidebarView>;
  dmPreviews: ReadonlyMap<string, UnreadDmPreview>;
  frame: Pick<ComponentProps<typeof SidebarFrame>, "busy" | "launchPending">;
  before: ReactNode;
  content: ReactNode;
  after: ReactNode;
  dialogs: ReactNode;
};

const noSubscription = () => () => {};
const emptyContributions: readonly RegisteredSidebarSection[] = [];
const noSidebarSections = () => emptyContributions;
const emptyRowContributions: readonly RegisteredSidebarRows[] = [];
const noSidebarRows = () => emptyRowContributions;
const noPendingPlugins = () => true;
const emptySidebarSections: SidebarSections = {
  version: 1,
  snapshot: noSidebarSections,
  subscribe: noSubscription,
  register: () => {},
};

/** Channel data, actions and notices; the primary sidebar owns their framing. */
export function ChannelInventory({
  relay,
  navigator,
  agents,
  target,
  queries,
  cached,
  layoutReady = true,
  connectionError,
  scope,
  viewer,
  sidebarSections: contributedSections,
  sidebarRows: contributedRows,
  render,
}: {
  relay: RelayData;
  navigator: Navigation;
  agents?: Agents | undefined;
  target: OpenTarget;
  queries: RelaySession;
  cached: boolean;
  /** Other inventories sharing this viewport must settle before restoring it. */
  layoutReady?: boolean;
  connectionError?: string | undefined;
  scope: string;
  viewer?: string | undefined;
  sidebarSections?: SidebarSections | undefined;
  sidebarRows?: SidebarRows | undefined;
  render(inventory: Inventory): ReactNode;
}) {
  const contributions = useSyncExternalStore(
    contributedSections?.subscribe ?? noSubscription,
    contributedSections?.snapshot ?? noSidebarSections,
    contributedSections?.snapshot ?? noSidebarSections,
  );
  const rowContributions = useSyncExternalStore(
    contributedRows?.subscribe ?? noSubscription,
    contributedRows?.snapshot ?? noSidebarRows,
    contributedRows?.snapshot ?? noSidebarRows,
  );
  const rowSortModes = useMemo(
    () => sidebarRowSortModes(rowContributions),
    [rowContributions],
  );
  const pluginsSettled = useSyncExternalStore(
    contributedRows?.subscribe ?? noSubscription,
    contributedRows?.settled ?? noPendingPlugins,
    contributedRows?.settled ?? noPendingPlugins,
  );
  const list = useChannelList(queries.channels);
  const rosterRecovers = useRecoveryOwns(queries, (live) =>
    rosterRecovering(live.roster),
  );
  const preferences = useSidebarPreferences(queries.sidebarPreferences);
  const sortModesReady =
    pluginsSettled ||
    Object.values(preferences.data?.sort ?? {}).every(
      (mode) =>
        !mode.startsWith("plugin:") ||
        rowSortModes.some((available) => available.id === mode),
    );
  const startup = useSidebarStartup(queries, list, preferences, sortModesReady);
  const [activityErrorDismissed, setActivityErrorDismissed] = useState(false);
  useEffect(() => {
    if (list.activityStatus !== "error") setActivityErrorDismissed(false);
  }, [list.activityStatus]);
  const handoff = useChannelNavigation();
  const mute = handoff?.session === queries ? handoff.mute : undefined;
  const readAction = useChannelReadAction();
  const readWrite = readAction.state;
  const [rowFocus, setRowFocus] = useState<string>();
  const pluginHiddenRows = useRef(new Set<string>());
  const kitState = useSyncExternalStore(
    queries.channelKit.subscribe,
    queries.channelKit.snapshot,
  );
  const hiddenDms = useHiddenDms(scope, queries, list);
  const promotedDm = useBestieConversation(queries);
  // Promotion is presentation, not hiding. Clear an earlier local removal so
  // releasing this destination restores the ordinary DM row.
  const showDm = hiddenDms.show;
  useEffect(() => {
    if (promotedDm) showDm([promotedDm]);
  }, [promotedDm, showDm]);
  const lifecycle = queries.channelLifecycle;
  const dmVisibility = useSyncExternalStore(
    lifecycle.subscribe,
    lifecycle.snapshot,
    lifecycle.snapshot,
  );
  const visibilityRequest = useRef<AbortController | undefined>(undefined);
  // Roster commits join an in-flight refresh; only unmount or a new lifecycle
  // cancels it, so live discovery cannot restart its retry budget.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new lifecycle retires the previous refresh signal.
  useEffect(() => {
    const request = new AbortController();
    visibilityRequest.current = request;
    return () => request.abort();
  }, [lifecycle]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed roster refresh also refreshes per-viewer visibility.
  useEffect(() => {
    if (list.status === "ready")
      void lifecycle.refreshVisibility(visibilityRequest.current?.signal);
  }, [lifecycle, list.asOf, list.status]);
  const lifecycleFocus = useRef<string | undefined>(undefined);
  const lifecycleTrigger = useRef<HTMLElement | undefined>(undefined);
  const sidebar = useSidebarView(
    scope,
    layoutReady &&
      startup.ready &&
      list.status === "ready" &&
      (preferences.status !== "loading" || !!preferences.cached),
    // The sidebar entry a destination selects, not its message or thread.
    // A target for another workspace is not a destination in this sidebar.
    "scope" in target &&
      target.scope &&
      (target.scope.viewer !== viewer ||
        target.scope.communityOrigin !== scope.slice(0, -(viewer.length + 1)))
      ? undefined
      : sidebarEntryLocation(target),
  );
  const { channels, profiles: dmProfiles } = useChannelLabels(
    list.channels,
    queries.profiles,
    queries.names,
  );
  const unreadDmPreviews = useMemo(() => {
    const previews = new Map<string, UnreadDmPreview>();
    for (const channel of channels) {
      if (channel.channelType !== "dm" || channel.participants?.length !== 1)
        continue;
      const profile = dmProfiles.get(channel.participants[0] ?? "");
      previews.set(channel.id, {
        name: channel.name,
        src: avatarMedia(profile?.picture, queries.media),
        isAgent: profile?.isAgent,
      });
    }
    return previews;
  }, [channels, dmProfiles, queries]);
  const workingIds = useSyncExternalStore(
    queries.agentActivity.subscribeWorking,
    queries.agentActivity.workingSnapshot,
    queries.agentActivity.workingSnapshot,
  );
  const workingChannels = useMemo(
    () => new Set<string>(JSON.parse(workingIds)),
    [workingIds],
  );
  const lifecycleDialog = handoff?.lifecycleDialog;
  const composingMessage =
    target.kind === "page" &&
    target.pluginId === "buzz.channels" &&
    target.route?.params === "new-message";
  const preparingDm = composingMessage ? handoff?.preparingDm : undefined;
  const sidebarChannels = useMemo(
    () =>
      channels.filter(
        (channel) =>
          channel.id !== promotedDm &&
          !channel.huddle &&
          !channel.metadataPending &&
          inTeamInventory(channel) &&
          (!preparingDm ||
            preparingDm.existing.has(channel.id) ||
            channel.channelType !== "dm" ||
            channel.members?.length !== preparingDm.members.size ||
            !channel.members.every((member) =>
              preparingDm.members.has(member),
            )),
      ),
    [channels, preparingDm, promotedDm],
  );
  const current = channels.find(
    (channel) =>
      channel.id ===
      (target.kind === "conversation" ? target.channelId : undefined),
  );
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const createChannelTrigger = useRef<HTMLButtonElement>(null);
  const removedRowFocus = useRef<
    { channelId: string; target: HTMLElement } | undefined
  >(undefined);
  const pendingCreate = useRef<ChannelSummary | undefined>(undefined);
  const [creatingSection, setCreatingSection] = useState(false);
  const createSectionTrigger = useRef<HTMLButtonElement>(null);
  const [creatingFor, setCreatingFor] = useState<{
    channel: ChannelSummary;
    surface?: ChannelMenuSurface;
    position?: "first";
  }>();

  const createOrigin = creatingFor?.surface?.signal;
  useLayoutEffect(() => {
    if (!createOrigin) return;
    const retire = () =>
      setCreatingFor((previous) =>
        previous?.surface?.signal === createOrigin ? undefined : previous,
      );
    if (createOrigin.aborted) retire();
    else createOrigin.addEventListener("abort", retire, { once: true });
    return () => createOrigin.removeEventListener("abort", retire);
  }, [createOrigin]);

  const [initialGroup, setInitialGroup] = useState("");
  const [initialStarred, setInitialStarred] = useState(false);
  const setupNotices = useSyncExternalStore(
    queries.channelCreation.subscribe,
    queries.channelCreation.notices,
    queries.channelCreation.notices,
  );
  useEffect(() => {
    if (list.status === "ready") {
      queries.channelKit.ensure();
      void queries.unread.ensure();
    }
  }, [queries, list.status]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const chooseLifecycle = (
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
  ) => {
    // Let the existing context menu restore focus before opening confirmation.
    requestAnimationFrame(() => {
      if (mounted.current) handoff?.openLifecycle(channel, action);
    });
  };
  useLayoutEffect(() => {
    if (!lifecycleFocus.current || lifecycleDialog) return;
    const id = lifecycleFocus.current;
    lifecycleFocus.current = undefined;
    const trigger = lifecycleTrigger.current;
    lifecycleTrigger.current = undefined;
    // The pending operation is nonmodal; keep focus where the user moved it.
    if (
      document.activeElement &&
      document.activeElement !== document.body &&
      !document.activeElement.closest("[inert]")
    )
      return;
    if (trigger?.isConnected && !trigger.closest("[inert]")) {
      trigger.focus({ preventScroll: true });
      return;
    }
    const rows = activeChannelRows(sidebar.list.current);
    const row =
      rows.find(
        (row) => row.dataset.channelId === id && row.getClientRects().length,
      ) ?? rows.find((row) => row.getClientRects().length);
    (
      row ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
  }, [lifecycleDialog, sidebar.list]);
  const select = useCallback(
    (id: string) => {
      const parts = splitPartition(scope);
      if (!viewer || !parts || relay.snapshot().session !== queries) return;
      clientMetrics.channelIntent(id, window.event);
      writeView(scope, "selected-channel", id);
      void navigator.open({
        version: 1,
        kind: "conversation",
        channelId: id,
        scope: { viewer, communityOrigin: parts.communityOrigin },
      });
    },
    [navigator, relay, queries, scope, viewer],
  );
  const openActivityMessage = useCallback(
    (
      channelId: string,
      messageId: string | undefined,
      threadRootId?: string,
    ) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      const trigger =
        activeChannelRows(sidebar.list.current).find(
          (row) => row.dataset.channelId === channelId,
        ) ?? null;
      const result = navigator.open({
        version: 1,
        kind: "conversation",
        channelId,
        ...(messageId ? { messageId } : {}),
        ...(threadRootId ? { threadRootId } : {}),
        scope: {
          viewer,
          communityOrigin: scope.slice(0, -(viewer.length + 1)),
        },
      });
      const { attempt } = navigator.snapshot();
      const target = attempt.entry.target;
      if (
        handoff &&
        messageId &&
        target.kind === "conversation" &&
        target.channelId === channelId &&
        target.messageId === messageId
      ) {
        const intent = {
          channelId,
          messageId,
          trigger,
          entryId: attempt.entry.id,
          signal: attempt.signal,
        };
        handoff.activityThread.current = intent;
        void result.then(() => {
          if (handoff.activityThread.current === intent)
            handoff.activityThread.current = undefined;
        });
      }
    },
    [viewer, relay, queries, handoff, sidebar.list, navigator, scope],
  );
  const openActivityThread = useCallback(
    (channelId: string, rootId: string) =>
      openActivityMessage(channelId, rootId, rootId),
    [openActivityMessage],
  );
  const openWorkingAgent = useCallback(
    (channelId: string, _agent: string, messageId: string | undefined) => {
      const root =
        messageId &&
        queries.channels
          .list()
          .channels.find((channel) => channel.id === channelId)?.channelType !==
          "solo" &&
        queries.channels
          .window(channelId)
          .rows.some((row) => row.id === messageId && !row.threadRootId);
      openActivityMessage(channelId, messageId, root ? messageId : undefined);
    },
    [queries, openActivityMessage],
  );
  const openAgentActivity = useCallback(
    (channelId: string, agent: string, messageId: string | undefined) => {
      if (!viewer || relay.snapshot().session !== queries) return;
      const transcript = activityTranscript(
        queries.channels,
        channelId,
        messageId,
      );
      const intent = {
        channelId,
        agent,
        trigger:
          activeChannelRows(sidebar.list.current).find(
            (row) => row.dataset.channelId === channelId,
          ) ?? null,
        ...(transcript && { transcript }),
      };
      if (handoff) handoff.activityAgent.current = intent;
      void navigator
        .open({
          version: 1,
          kind: "conversation",
          channelId,
          scope: {
            viewer,
            communityOrigin: scope.slice(0, -(viewer.length + 1)),
          },
        })
        .then((result) => {
          if (
            result.status !== "opened" &&
            handoff?.activityAgent.current === intent
          )
            handoff.activityAgent.current = undefined;
        });
    },
    [viewer, relay, queries, handoff, sidebar.list, navigator, scope],
  );
  const createChannel = async (input: CreateChannelInput) => {
    const id = await queries.channelCreation.create(input);
    if (mounted.current)
      revealCreatedChannel(relay, queries, navigator, input, id, (key) =>
        sidebar.toggle(key, true),
      );
  };
  const sections = useMemo(
    () =>
      startup.ready
        ? sidebarSections(
            sidebarChannels,
            preferences.data,
            new Set([...hiddenDms.hiddenIds, ...dmVisibility.hidden]),
          )
        : [],
    [
      startup.ready,
      sidebarChannels,
      preferences.data,
      hiddenDms.hiddenIds,
      dmVisibility.hidden,
    ],
  );
  const sectionSort = useCallback(
    (key: string): SidebarSortMode => {
      const saved =
        preferences.data?.sort?.[
          key.startsWith("group:") ? `section:${key.slice(6)}` : key
        ];
      return saved &&
        (saved === "recent" || rowSortModes.some((mode) => mode.id === saved))
        ? saved
        : "alpha";
    },
    [preferences.data, rowSortModes],
  );
  const rowUnread = useSidebarRowUnread(
    queries.unread,
    JSON.stringify(
      sections.flatMap((section) =>
        rowSortModes.some((mode) => mode.id === sectionSort(section.key))
          ? section.rows.map((channel) => channel.id)
          : [],
      ),
    ),
  );
  const sortedSections = useMemo(
    () =>
      rowSortModes.length
        ? sections.map((section) => {
            const mode = rowSortModes.find(
              (mode) => mode.id === sectionSort(section.key),
            );
            if (!mode) return section;
            const candidates = section.rows.map((channel) => ({
              channel,
              data: sidebarRow(
                channel,
                section.key,
                rowUnread.get(channel.id) ??
                  queries.unread.snapshot({
                    kind: "channel",
                    channelId: channel.id,
                  }),
              ),
            }));
            const sorted = sortSidebarRows(
              candidates,
              mode,
              ({ data }) => data,
            );
            return sorted === candidates
              ? section
              : { ...section, rows: sorted.map(({ channel }) => channel) };
          })
        : sections,
    [sections, rowSortModes, sectionSort, rowUnread, queries.unread],
  );
  const filteredSections = useSidebarFilters(
    sortedSections,
    Object.fromEntries(
      Object.entries(preferences.data?.filters ?? {}).map(([key, mode]) => [
        key.startsWith("section:") ? `group:${key.slice(8)}` : key,
        mode,
      ]),
    ),
    current?.id,
    queries.unread,
    Object.fromEntries(
      Object.entries(preferences.data?.activeWindowSeconds ?? {}).map(
        ([key, seconds]) => [
          key.startsWith("section:") ? `group:${key.slice(8)}` : key,
          seconds,
        ],
      ),
    ),
    list.activityStatus === "ready",
  );
  const firstChannelSection = filteredSections.find(({ key }) =>
    isChannelSectionKey(key),
  )?.key;
  // Menu dismissal may run before a moved row mounts at its new placement.
  // Only an actual filter exclusion should return focus to a section summary.
  const hiddenRowSections = useRef(new Map<string, string>());
  useLayoutEffect(() => {
    hiddenRowSections.current = new Map(
      filteredSections.flatMap((section) =>
        section.hiddenRows.map(({ id }) => [id, section.key] as const),
      ),
    );
  }, [filteredSections]);
  const channelSectionKey = useCallback(
    (channelId: string) => {
      const data = queries.sidebarPreferences.snapshot().data;
      const sectionId = data?.assignments[channelId];
      const channel = queries.channels
        .list()
        .channels.find((row) => row.id === channelId);
      return data?.starred.includes(channelId)
        ? "starred"
        : sectionId
          ? `group:${sectionId}`
          : channel?.channelType === "dm"
            ? "dms"
            : "channels";
    },
    [queries],
  );
  const focusChannelPlacement = (channelId: string) => {
    sidebar.toggle(channelSectionKey(channelId), true);
    setRowFocus(channelId);
  };
  const moveChannel = (
    channelId: string,
    operation: () => Promise<unknown>,
    surface?: ChannelMenuSurface,
  ) => {
    const saving = operation(); // Publishes optimistic placement synchronously.
    if (surface) {
      surface.close();
      surface.focus();
    } else {
      closeRowMenu();
      focusChannelPlacement(channelId);
    }
    void saving.catch(() => {
      // The session exposes retry even after page/menu unmount. Restore a row
      // focus lost to rollback, but never steal focus from another control.
      if (
        !surface &&
        sidebar.list.current?.isConnected &&
        document.activeElement === document.body
      )
        focusChannelPlacement(channelId);
    });
  };
  const assignGroup = (
    channelId: string,
    sectionId?: string,
    surface?: ChannelMenuSurface,
  ) =>
    moveChannel(
      channelId,
      () => preferences.assign(channelId, sectionId),
      surface,
    );
  const setChannelStar = (
    channelId: string,
    starred: boolean,
    surface?: ChannelMenuSurface,
  ) =>
    moveChannel(
      channelId,
      () => preferences.setStar(channelId, starred),
      surface,
    );
  const placementWritable =
    preferences.writable && preferences.starWritable && !!preferences.data;
  // Group drags land on the placement drop targets, so they need both writers.
  const orderWritable = placementWritable && preferences.sectionOrderWritable;
  const groupIds = preferences.data?.sections.map(({ id }) => id) ?? [];
  // Saved order uses the same section keys as collapse and drag.
  const orderedContributions = orderContributedSidebarSections(
    contributions.map((entry) => ({
      key: contributedSidebarSectionKey(entry.key),
      entry,
    })),
    sidebar.contributionOrder,
  ).map(({ entry }) => entry);
  const reorderContributions = (sectionKey: string, overKey: string) => {
    const ids = orderedContributions.map(({ key }) =>
      contributedSidebarSectionKey(key),
    );
    const from = ids.indexOf(sectionKey);
    const to = ids.indexOf(overKey);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sectionKey);
    const activeKeys = new Set(ids);
    const seenSavedKeys = new Set<string>();
    const order: string[] = [];
    let nextActive = 0;
    for (const savedKey of sidebar.contributionOrder) {
      if (!activeKeys.has(savedKey)) {
        order.push(savedKey);
        continue;
      }
      if (seenSavedKeys.has(savedKey)) continue;
      seenSavedKeys.add(savedKey);
      order.push(ids[nextActive++] ?? savedKey);
    }
    order.push(...ids.slice(nextActive));
    sidebar.setContributionOrder(order);
  };
  const moveGroup = (sectionId: string, to: number) => {
    const ids = groupIds.filter((id) => id !== sectionId);
    ids.splice(to, 0, sectionId);
    void preferences.reorderSections(sectionId, ids).catch(() => {});
  };
  const setSectionSort = (key: string, mode: SidebarSortMode) => {
    void preferences
      .setSort(
        key.startsWith("group:") ? `section:${key.slice(6)}` : key,
        mode,
        preferences.data?.sections.map((section) => section.id) ?? [],
      )
      .catch(() => {});
  };
  const setSectionFilter = (
    key: string,
    mode: "all" | "unreads" | "active",
    activeWindowSeconds?: number | null,
  ) => {
    return preferences.setFilter(
      key.startsWith("group:") ? `section:${key.slice(6)}` : key,
      mode,
      preferences.data?.sections.map((section) => section.id) ?? [],
      undefined,
      activeWindowSeconds,
    );
  };
  // Compose actual items here; menu availability is their count, not the policy
  // of any one action. Sibling actions keep their own eligibility checks.
  const rowActions = (
    channel: ChannelSummary,
    sectionKey: string,
    surface?: ChannelMenuSurface,
  ) => {
    const actions: ReactNode[] = [];
    if (placementWritable && channel.channelType !== "forum") {
      const currentSectionId = sectionKey.startsWith("group:")
        ? sectionKey.slice("group:".length)
        : undefined;
      const starred = sectionKey === "starred";
      const movingDm = channel.channelType === "dm";
      actions.push(
        <MenuSubmenu key="move-channel">
          <MenuSubmenuTrigger>
            <MenuIcon>
              <FolderSimpleIcon size={14} />
            </MenuIcon>
            {movingDm ? "Move conversation" : "Move channel"}
          </MenuSubmenuTrigger>
          <MenuSubmenuPopup
            aria-label={`Move ${channel.name} to section`}
            // The root restores by channel identity after relocation;
            // a nested popup must not refocus its retired trigger.
            finalFocus={false}
          >
            <MenuGroup>
              <MenuGroupLabel>Move to…</MenuGroupLabel>
            </MenuGroup>
            <MenuRadioGroup
              value={
                starred
                  ? "starred"
                  : currentSectionId
                    ? `group:${currentSectionId}`
                    : movingDm
                      ? "dms"
                      : "channels"
              }
              onValueChange={(destination) => {
                if (destination === "starred")
                  void setChannelStar(channel.id, !starred, surface);
                else {
                  const groupId = destination.startsWith("group:")
                    ? destination.slice("group:".length)
                    : undefined;
                  void assignGroup(
                    channel.id,
                    groupId === currentSectionId ? undefined : groupId,
                    surface,
                  );
                }
              }}
            >
              <MenuRadioItem value="starred" closeOnClick={false}>
                <MenuIcon>★</MenuIcon>
                Starred
              </MenuRadioItem>
              {preferences.data?.sections.map((group) => (
                <MenuRadioItem
                  key={group.id}
                  value={`group:${group.id}`}
                  closeOnClick={false}
                >
                  <MenuIcon>
                    {group.icon ? (
                      <SidebarGroupIcon icon={group.icon} session={queries} />
                    ) : (
                      <FolderSimpleIcon size={14} />
                    )}
                  </MenuIcon>
                  {group.name}
                </MenuRadioItem>
              ))}
              {movingDm && (
                <MenuRadioItem value="dms" closeOnClick={false}>
                  <MenuIcon>
                    <ChatCircleIcon size={14} />
                  </MenuIcon>
                  Direct messages
                </MenuRadioItem>
              )}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem
              disabled={!preferences.sectionCreationWritable}
              onClick={() => {
                if (surface) {
                  surface.close(() => false);
                  requestAnimationFrame(() => {
                    if (
                      mounted.current &&
                      !surface.signal?.aborted &&
                      queries.sidebarPreferences.sectionCreationWritable &&
                      relay.snapshot().session === queries
                    )
                      setCreatingFor({ channel, surface });
                  });
                } else pendingCreate.current = channel;
              }}
            >
              <MenuIcon>
                <PlusIcon size={14} />
              </MenuIcon>
              Create new…
            </MenuItem>
            {(starred || currentSectionId) && (
              <MenuItem
                closeOnClick={false}
                onClick={() => {
                  if (starred) void setChannelStar(channel.id, false, surface);
                  else void assignGroup(channel.id, undefined, surface);
                }}
              >
                <MenuIcon>
                  <MinusIcon size={14} />
                </MenuIcon>
                Remove from{" "}
                {sections.find((section) => section.key === sectionKey)?.title}
              </MenuItem>
            )}
          </MenuSubmenuPopup>
        </MenuSubmenu>,
      );
    }
    const muteable =
      queries.sidebarPreferences.muteWritable && !!preferences.data;
    const readable = queries.unread.sync().capability === "frontier-sync";
    if (muteable && mute) {
      const intent = mute.intents.get(channel.id);
      const muted = intent?.pending
        ? intent.muted
        : (preferences.data?.muted.includes(channel.id) ?? false);
      actions.push(
        <MenuItem
          key="mute"
          closeOnClick={false}
          disabled={surface?.pending ?? readWrite?.pending ?? false}
          onClick={() => changeMute(channel.id, channel.name, !muted, surface)}
        >
          <MenuIcon>
            {muted ? <BellIcon size={14} /> : <BellSlashIcon size={14} />}
          </MenuIcon>
          {muted ? "Unmute" : "Mute"}
        </MenuItem>,
      );
    }
    if (readable)
      actions.push(
        <ChannelReadMenuItem
          key="read"
          unread={queries.unread}
          channelId={channel.id}
          pending={surface?.pending ?? readWrite?.pending ?? false}
          run={(action) =>
            surface
              ? surface.runRead(action)
              : runReadAction(channel.id, action)
          }
        />,
      );
    actions.push(
      <ChannelCopyLinkMenuItem key="copy-link" channelId={channel.id} />,
    );
    if (!surface && !channel.archived) {
      actions.push(
        <ChannelLifecycleMenu
          key="lifecycle"
          separator={false}
          noun={lifecycleNoun(channel)}
          channelId={channel.id}
          lifecycle={lifecycle}
          disabled={!!lifecycleDialog}
          choose={(action) => chooseLifecycle(channel, action)}
        />,
      );
    }
    if (channel.channelType === "dm") {
      actions.push(
        <MenuItem
          key="remove-message"
          onClick={() => {
            if (surface) {
              hiddenDms.hide(channel.id);
              surface.close();
              surface.focus();
              return;
            }
            const trigger = activeChannelRows(sidebar.list.current).find(
              (row) => row.dataset.channelId === channel.id,
            );
            const section = trigger?.closest("[data-sidebar-section]");
            const rows = activeChannelRows(section);
            const index = rows.indexOf(trigger as HTMLButtonElement);
            const survivingSummary = [
              ...(sidebar.list.current?.querySelectorAll<HTMLElement>(
                "[data-sidebar-section] details > summary",
              ) ?? []),
            ].find((summary) => !section?.contains(summary));
            const target =
              rows[index + 1] ?? rows[index - 1] ?? survivingSummary;
            removedRowFocus.current = target
              ? { channelId: channel.id, target }
              : undefined;
            hiddenDms.hide(channel.id);
          }}
        >
          <MenuIcon>
            <MinusIcon size={14} />
          </MenuIcon>
          Remove from Team
        </MenuItem>,
      );
    }
    return actions;
  };
  const {
    rowMenu,
    open: openMenu,
    close: closeMenu,
  } = useChannelRowMenu(filteredSections, rowActions);
  const openRowMenu = useCallback(
    (channel: ChannelSummary, sectionKey: string, anchor?: HTMLElement) => {
      readAction.reset();
      removedRowFocus.current = undefined;
      openMenu(channel, sectionKey, anchor);
    },
    [openMenu, readAction.reset],
  );
  const closeRowMenu = useCallback(() => {
    readAction.reset();
    closeMenu();
  }, [closeMenu, readAction.reset]);
  const currentRowMenu = useRef(rowMenu);
  // Hidden-state callbacks run in child layout effects, before parent effects.
  currentRowMenu.current = rowMenu;
  const setRowHidden = useCallback(
    (id: string, hidden: boolean) => {
      if (hidden) {
        pluginHiddenRows.current.add(id);
        const menu = currentRowMenu.current;
        if (menu?.channelId === id) {
          const target = sidebar.list.current?.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(menu.sectionKey)}"] details > summary`,
          );
          removedRowFocus.current = target
            ? { channelId: id, target }
            : undefined;
          closeRowMenu();
        }
      } else pluginHiddenRows.current.delete(id);
    },
    [closeRowMenu, sidebar.list],
  );
  const muteRecovery = handoff?.muteRecovery;
  useLayoutEffect(() => {
    if (!muteRecovery) return;
    const callbacks = { focus: setRowFocus, closeMenu: closeRowMenu };
    muteRecovery.current = callbacks;
    return () => {
      if (muteRecovery.current === callbacks) muteRecovery.current = undefined;
    };
  }, [muteRecovery, closeRowMenu]);
  const rowMenuClosed = useCallback((channelId: string) => {
    if (pendingCreate.current?.id === channelId) {
      setCreatingFor({ channel: pendingCreate.current });
      pendingCreate.current = undefined;
    }
  }, []);
  const rowFocusTarget = useCallback(
    (channelId: string) => {
      const list = sidebar.list.current;
      const row = activeChannelRows(list).find(
        (candidate) => candidate.dataset.channelId === channelId,
      );
      if (row) return row;
      const sectionKey = hiddenRowSections.current.get(channelId);
      return sectionKey
        ? list?.querySelector<HTMLElement>(
            `[data-sidebar-section="${CSS.escape(sectionKey)}"] details > summary`,
          )
        : undefined;
    },
    [sidebar.list],
  );
  const rowMenuFinalFocus = useCallback(
    (channelId: string) =>
      pendingCreate.current
        ? false
        : removedRowFocus.current?.channelId === channelId
          ? removedRowFocus.current.target
          : (rowFocusTarget(channelId) ?? false),
    [rowFocusTarget],
  );
  useLayoutEffect(() => {
    if (!rowFocus) return;
    (
      rowFocusTarget(rowFocus) ??
      activeChannelRows(sidebar.list.current).find(
        (row) => row.getClientRects().length,
      ) ??
      sidebar.list.current
        ?.closest("aside")
        ?.querySelector<HTMLButtonElement>("button")
    )?.focus({ preventScroll: true });
    setRowFocus(undefined);
  }, [rowFocus, rowFocusTarget, sidebar.list]);
  const [groupFocus, setGroupFocus] = useState<string>();
  // Group recovery removes its focused notice; return focus to the group header.
  useLayoutEffect(() => {
    if (!groupFocus) return;
    (
      sidebar.list.current?.querySelector<HTMLElement>(
        `[data-sidebar-section="${CSS.escape(groupFocus)}"] details > summary`,
      ) ??
      sidebar.list.current?.querySelector<HTMLElement>(
        "[data-sidebar-section] details > summary",
      )
    )?.focus({ preventScroll: true });
    setGroupFocus(undefined);
  }, [groupFocus, sidebar.list]);
  const runReadAction = (channelId: string, action: () => Promise<unknown>) =>
    readAction.run(action, () => {
      setRowFocus(channelId);
      closeRowMenu();
    });
  const changeMute = (
    channelId: string,
    name: string,
    muted: boolean,
    surface?: ChannelMenuSurface,
  ) => {
    if (!mute) return;
    mute.change(channelId, name, muted);
    if (surface) {
      surface.close();
      surface.focus();
    } else {
      setRowFocus(channelId);
      closeRowMenu();
    }
  };
  // Publish presentation callbacks, not a second mutation owner. Header renders
  // these elements under its own MenuRoot; a portal here would lose that context.
  const menuActions = handoff?.menuActions;
  useLayoutEffect(() => {
    menuActions?.publish((channel, surface) => {
      if (cached || channel.cached || relay.snapshot().session !== queries)
        return [];
      const placement = sections.find((section) =>
        section.rows.some((row) => row.id === channel.id),
      );
      return rowActions(channel, placement?.key ?? "channels", surface);
    });
  });
  useLayoutEffect(() => () => menuActions?.publish(undefined), [menuActions]);
  const lifecycleCallbacks = handoff?.lifecycleCallbacks;
  // The shown rows nearest the confirmed channel: its own section's, then the
  // nearest expanded sections'. Captured while it is still listed: completion
  // can arrive after the roster has dropped it.
  const lifecycleNeighbors = useRef<{ id: string; ids: string[] }>(undefined);
  useLayoutEffect(() => {
    if (!lifecycleCallbacks) return;
    const dialogId = lifecycleDialog?.channel.id;
    if (!dialogId) lifecycleNeighbors.current = undefined;
    const at = filteredSections.findIndex((section) =>
      section.rows.some((row) => row.id === dialogId),
    );
    const placement = filteredSections[at];
    if (dialogId && placement) {
      const shown = (section: typeof placement) =>
        sidebar.collapsed.includes(section.key)
          ? []
          : section.rows
              .filter(
                (row) =>
                  row.id === dialogId || !pluginHiddenRows.current.has(row.id),
              )
              .map((row) => row.id);
      const own = shown(placement);
      const index = Math.max(own.indexOf(dialogId), 0);
      lifecycleNeighbors.current = {
        id: dialogId,
        ids: [
          ...own.slice(index + 1),
          ...own.slice(0, index).reverse(),
          ...filteredSections.slice(at + 1).flatMap(shown),
          ...filteredSections.slice(0, at).flatMap(shown).reverse(),
        ],
      };
    }
    lifecycleCallbacks.current = lifecycleDialog
      ? {
          close: () => {
            lifecycleFocus.current = lifecycleDialog.channel.id;
            lifecycleTrigger.current = lifecycleDialog.trigger?.isConnected
              ? lifecycleDialog.trigger
              : lifecycleDialog.focusFallback;
          },
          completed: () => {
            const id = lifecycleDialog.channel.id;
            lifecycleFocus.current = id;
            // Archive changes visibility, not access or the current destination.
            if (
              lifecycleDialog.action === "archive" ||
              lifecycleDialog.action === "unarchive"
            ) {
              lifecycleTrigger.current = lifecycleDialog.trigger?.isConnected
                ? lifecycleDialog.trigger
                : lifecycleDialog.focusFallback;
              return;
            }
            // Its neighbor takes its place, so the sidebar stays where it is.
            const listed = filteredSections
              .flatMap((section) => section.rows)
              .filter((row) => !pluginHiddenRows.current.has(row.id));
            const next =
              (lifecycleNeighbors.current?.id === id
                ? lifecycleNeighbors.current.ids
                : []
              ).find((neighbor) => listed.some((row) => row.id === neighbor)) ??
              listed.find((channel) => channel.id !== id)?.id;
            if (next) lifecycleFocus.current = next;
            // Confirmed access loss can already have removed current from the roster.
            if (
              (target.kind === "conversation"
                ? target.channelId
                : undefined) === id
            ) {
              if (next) select(next);
              else {
                writeView(scope, "selected-channel", undefined);
                void navigator.open({
                  version: 1,
                  kind: "page",
                  pluginId: "buzz.channels",
                  pageId: "channels",
                  route: { version: 1, params: "empty" },
                });
              }
            }
          },
        }
      : undefined;
  });
  useLayoutEffect(
    () => () => {
      if (lifecycleCallbacks) lifecycleCallbacks.current = undefined;
    },
    [lifecycleCallbacks],
  );
  return render({
    sidebar,
    dmPreviews: unreadDmPreviews,
    frame: {
      launchPending: connectionError
        ? undefined
        : !startup.ready ||
            (!cached && (list.status === "idle" || list.status === "loading"))
          ? "required"
          : cached || startup.updating
            ? "settling"
            : undefined,
      busy: preferences.status === "loading" || startup.updating || undefined,
    },
    before: (
      <>
        {/* The sidebar mounts the one automatic relay-recovery notice.
              Other failures need the user and keep their own message and Retry. */}
        {kitState.status === "error" && !kitState.transient && (
          <p role="alert">
            {kitState.error}{" "}
            <Button onClick={() => void queries.channelKit.refresh()}>
              Retry templates
            </Button>
          </p>
        )}
        {setupNotices.map((notice) => (
          <ToastNotice
            key={notice.id}
            title={`Channel setup couldn’t finish: ${notice.name}`}
            description={notice.error}
            tone="warning"
          >
            <Button
              size="sm"
              onClick={() => queries.channelCreation.dismissNotice(notice.id)}
            >
              Dismiss
            </Button>
          </ToastNotice>
        ))}
        {!cached && dmVisibility.status === "error" && (
          <div role="alert">
            Hidden conversations could not be refreshed.{" "}
            <Button
              onClick={() =>
                void lifecycle.refreshVisibility(
                  visibilityRequest.current?.signal,
                )
              }
            >
              Retry hidden conversations
            </Button>
          </div>
        )}
      </>
    ),
    content: (
      <>
        <ChannelSidebarDnd
          writable={placementWritable}
          onCreateSection={(channelId) => {
            const channel = sidebarChannels.find(({ id }) => id === channelId);
            // Finish releasing the pointer before giving the modal its focus.
            requestAnimationFrame(() => {
              if (
                mounted.current &&
                channel &&
                queries.sidebarPreferences.sectionCreationWritable
              )
                setCreatingFor({ channel, position: "first" });
            });
          }}
          onMove={(channelId, sectionKey) =>
            sectionKey === "starred"
              ? setChannelStar(channelId, true)
              : assignGroup(
                  channelId,
                  sectionKey.startsWith("group:")
                    ? sectionKey.slice("group:".length)
                    : undefined,
                )
          }
          onReorder={(sectionKey, overKey) =>
            sectionKey.startsWith("plugin:")
              ? reorderContributions(sectionKey, overKey)
              : moveGroup(
                  sectionKey.slice("group:".length),
                  groupIds.indexOf(overKey.slice("group:".length)),
                )
          }
          overlay={(id, group) => {
            if (group) {
              const section = sections.find(({ key }) => key === id);
              const contribution = section
                ? undefined
                : orderedContributions.find(
                    ({ key }) => contributedSidebarSectionKey(key) === id,
                  );
              const title = section?.title ?? contribution?.title;
              if (!title) return null;
              return (
                <div className={styles.channelDragOverlay}>
                  {section?.icon ? (
                    <SidebarGroupIcon icon={section.icon} session={queries} />
                  ) : contribution?.icon ? (
                    <ContributionBoundary
                      key={contributionKey(contribution)}
                      fallback={null}
                    >
                      {contribution.icon}
                    </ContributionBoundary>
                  ) : null}
                  <span>{title}</span>
                </div>
              );
            }
            const channel = sidebarChannels.find(
              (channel) => channel.id === id,
            );
            if (!channel) return null;
            const Icon = channelIcon(channel);
            return (
              <div className={styles.channelDragOverlay}>
                <Icon size={16} />
                <span>{channel.name}</span>
              </div>
            );
          }}
        >
          {filteredSections.map((section) => (
            <DroppableSidebarSection
              key={section.key}
              createSectionTarget={
                section.key === firstChannelSection &&
                preferences.sectionCreationWritable
              }
              groupIndex={groupIds.indexOf(section.key.slice("group:".length))}
              disabled={
                !placementWritable || !isChannelDropSectionKey(section.key)
              }
              reorderable={orderWritable && section.key.startsWith("group:")}
              move={
                orderWritable && section.key.startsWith("group:")
                  ? (() => {
                      const id = section.key.slice("group:".length);
                      const index = groupIds.indexOf(id);
                      return {
                        up:
                          index > 0
                            ? () => moveGroup(id, index - 1)
                            : undefined,
                        down:
                          index < groupIds.length - 1
                            ? () => moveGroup(id, index + 1)
                            : undefined,
                      };
                    })()
                  : undefined
              }
              sectionKey={section.key}
              title={section.title}
              icon={section.icon}
              session={queries}
              open={!sidebar.collapsed.includes(section.key)}
              onToggle={(open) => sidebar.toggle(section.key, open)}
              channelCount={section.allRows.length}
              filter={
                preferences.data
                  ? {
                      value:
                        preferences.data.filters?.[
                          section.key.startsWith("group:")
                            ? `section:${section.key.slice(6)}`
                            : section.key
                        ] ?? "all",
                      disabled: !preferences.filterWritable,
                      activeWindowSeconds:
                        preferences.data.activeWindowSeconds?.[
                          section.key.startsWith("group:")
                            ? `section:${section.key.slice(6)}`
                            : section.key
                        ],
                      change: (mode, seconds) =>
                        setSectionFilter(section.key, mode, seconds),
                      dismissError: () =>
                        preferences.dismissFilterError(
                          section.key.startsWith("group:")
                            ? `section:${section.key.slice(6)}`
                            : section.key,
                        ),
                    }
                  : undefined
              }
              channels={{
                rows: section.hiddenRows,
                selected: current?.id,
                select,
              }}
              onRemove={
                preferences.removeSectionWritable &&
                section.key.startsWith("group:")
                  ? async () => {
                      await preferences.removeSection(section.key.slice(6));
                      sidebar.toggle(section.key, true);
                    }
                  : undefined
              }
              onRename={
                preferences.sectionRenameWritable &&
                section.key.startsWith("group:")
                  ? async (name) => {
                      await preferences.renameSection(
                        section.key.slice(6),
                        name,
                      );
                    }
                  : undefined
              }
              removalFocus={() =>
                sidebar.list.current?.querySelector<HTMLButtonElement>(
                  '[data-sidebar-section="channels"] button',
                )
              }
              createChannel={
                section.key === "starred" || isChannelSectionKey(section.key)
                  ? {
                      available: queries.channelCreation.available,
                      open: (trigger) => {
                        createChannelTrigger.current = trigger;
                        setInitialStarred(section.key === "starred");
                        setInitialGroup(
                          section.key.startsWith("group:")
                            ? section.key.slice(6)
                            : "",
                        );
                        setCreateChannelOpen(true);
                      },
                    }
                  : undefined
              }
              createSection={
                section.key === "channels"
                  ? {
                      available: preferences.sectionCreationWritable,
                      open: (trigger) => {
                        createSectionTrigger.current = trigger;
                        requestAnimationFrame(() => {
                          if (mounted.current) setCreatingSection(true);
                        });
                      },
                    }
                  : undefined
              }
              newMessage={
                section.key === "dms"
                  ? () => {
                      if (viewer && relay.snapshot().session === queries)
                        void navigator.open({
                          version: 1,
                          kind: "page",
                          pluginId: "buzz.channels",
                          pageId: "channels",
                          scope: {
                            viewer,
                            communityOrigin: scope.slice(
                              0,
                              -(viewer.length + 1),
                            ),
                          },
                          route: { version: 1, params: "new-message" },
                        });
                    }
                  : undefined
              }
              sort={
                preferences.sortWritable
                  ? {
                      value: sectionSort(section.key),
                      modes: rowSortModes,
                      change: (mode) => setSectionSort(section.key, mode),
                    }
                  : undefined
              }
            >
              <ChannelSidebarRows
                open={!sidebar.collapsed.includes(section.key)}
              >
                {section.rows.map((channel) => {
                  const selected =
                    current?.id === channel.id ? current.id : undefined;
                  // Every row offers Copy link; build items only for the open
                  // menu. useChannelRowMenu closes a menu left with none.
                  const menuOpen =
                    rowMenu?.channelId === channel.id &&
                    rowMenu.sectionKey === section.key;
                  return (
                    <ChannelSidebarItem
                      profile={
                        channel.channelType === "dm" &&
                        channel.participants?.length === 1
                          ? dmProfiles.get(channel.participants[0] ?? "")
                          : undefined
                      }
                      key={channel.id}
                      channel={channel}
                      rowContributions={rowContributions}
                      onHiddenChange={setRowHidden}
                      session={queries}
                      working={workingChannels.has(channel.id)}
                      selected={composingMessage ? undefined : selected}
                      onSelect={select}
                      onOpenThread={openActivityThread}
                      onOpenWorkingAgent={openWorkingAgent}
                      onOpenAgentActivity={openAgentActivity}
                      menuEnabled
                      sectionKey={section.key}
                      selectFrame={
                        channel.channelType !== "dm" &&
                        isChannelDropSectionKey(section.key)
                          ? DraggableChannel
                          : undefined
                      }
                      onOpenMenu={openRowMenu}
                      menuOpen={menuOpen}
                      menuAnchor={menuOpen ? rowMenu.anchor : undefined}
                      menuContent={
                        menuOpen ? (
                          <>
                            {rowActions(channel, section.key)}
                            {readWrite?.pending && <p role="status">Saving…</p>}
                            {readWrite?.error && (
                              <p role="alert">{readWrite.error}</p>
                            )}
                          </>
                        ) : undefined
                      }
                      onCloseMenu={closeRowMenu}
                      onMenuClosed={rowMenuClosed}
                      menuFinalFocus={rowMenuFinalFocus}
                    />
                  );
                })}
              </ChannelSidebarRows>
            </DroppableSidebarSection>
          ))}
          {orderedContributions.map((entry, index) => {
            const sectionKey = contributedSidebarSectionKey(entry.key);
            const previousKey = orderedContributions[index - 1]?.key;
            const nextKey = orderedContributions[index + 1]?.key;
            const reorderable = contributions.length > 1;
            return (
              <SidebarContributionSection
                key={entry.key}
                entry={entry}
                registry={contributedSections ?? emptySidebarSections}
                navigator={navigator}
                target={target}
                open={!sidebar.collapsed.includes(sectionKey)}
                onToggle={(open) => sidebar.toggle(sectionKey, open)}
                groupIndex={index}
                reorderable={reorderable}
                onRowsCommitted={sidebar.retryReveal}
                move={
                  reorderable
                    ? {
                        ...(previousKey
                          ? {
                              up: () =>
                                reorderContributions(
                                  sectionKey,
                                  contributedSidebarSectionKey(previousKey),
                                ),
                            }
                          : {}),
                        ...(nextKey
                          ? {
                              down: () =>
                                reorderContributions(
                                  sectionKey,
                                  contributedSidebarSectionKey(nextKey),
                                ),
                            }
                          : {}),
                      }
                    : undefined
                }
              />
            );
          })}
        </ChannelSidebarDnd>
        {!startup.ready && (
          <p className={styles.empty} role="status">
            Loading your sidebar…
          </p>
        )}
        {list.status === "error" && !rosterRecovers && (
          <p role="alert" className={styles.empty}>
            {list.error}
          </p>
        )}
        {startup.ready && list.status === "ready" && !channels.length && (
          <p className={styles.empty}>No channels yet.</p>
        )}
      </>
    ),
    after: (
      <>
        {cached && connectionError && (
          <p className={styles.preferenceNotice} role="status">
            Offline · Showing saved conversations.
            <Button onClick={relay.retry}>Retry connection</Button>
          </p>
        )}
        {preferences.sortErrors?.map(({ group, mode, error }) => (
          <div key={group} className={styles.preferenceNotice} role="alert">
            <p>
              Couldn’t save the sort order for{" "}
              {sections.find(
                ({ key }) =>
                  key ===
                  (group.startsWith("section:")
                    ? `group:${group.slice(8)}`
                    : group),
              )?.title ?? "this section"}
              . {error}
            </p>
            <button type="button" onClick={() => setSectionSort(group, mode)}>
              Retry sort
            </button>
            <button
              type="button"
              onClick={() => preferences.dismissSortError(group)}
            >
              Dismiss
            </button>
          </div>
        ))}
        {preferences.filterErrors?.map(
          ({ group, mode, activeWindowSeconds, error }) => (
            <div key={group} className={styles.preferenceNotice} role="alert">
              <p>
                Couldn’t save the filter for{" "}
                {sections.find(
                  ({ key }) =>
                    key ===
                    (group.startsWith("section:")
                      ? `group:${group.slice(8)}`
                      : group),
                )?.title ?? "this section"}
                . {error}
              </p>
              <button
                type="button"
                onClick={() =>
                  void setSectionFilter(group, mode, activeWindowSeconds).catch(
                    () => {},
                  )
                }
              >
                Retry filter
              </button>
              <button
                type="button"
                onClick={() => preferences.dismissFilterError(group)}
              >
                Dismiss
              </button>
            </div>
          ),
        )}
        {preferences.orderError && (
          <div className={styles.preferenceNotice} role="alert">
            <p>
              Couldn’t save the move for{" "}
              {sections.find(
                ({ key }) =>
                  key === `group:${preferences.orderError?.sectionId}`,
              )?.title ?? "this section"}
              . {preferences.orderError.error}
            </p>
            <p>
              The previous placement is shown. A partial save may already exist
              on the relay.
            </p>
            {!preferences.sectionOrderWritable && (
              <p>
                Refresh saved sidebar preferences before retrying this move.
              </p>
            )}
            <button
              type="button"
              disabled={!preferences.sectionOrderWritable}
              onClick={() => {
                const failed = preferences.orderError;
                if (!failed) return;
                void preferences
                  .reorderSections(failed.sectionId, failed.sectionIds)
                  .catch(() => {});
                setGroupFocus(`group:${failed.sectionId}`);
              }}
            >
              Retry move
            </button>
            <button
              type="button"
              onClick={() => {
                const failed = preferences.orderError;
                preferences.dismissOrderError();
                if (failed) setGroupFocus(`group:${failed.sectionId}`);
              }}
            >
              Dismiss
            </button>
          </div>
        )}
        {preferences.moves
          ?.filter((move) => !move.pending)
          .map((move) => (
            <div key={move.id} className={styles.preferenceNotice} role="alert">
              <p>
                Couldn’t save the move for{" "}
                {channels.find(({ id }) => id === move.channelId)?.name ??
                  "this channel"}
                . {move.error}
              </p>
              <p>
                The previous placement is shown. A partial save may already
                exist on the relay.
              </p>
              {!preferences.writable && (
                <p>
                  Refresh saved sidebar preferences before retrying this move.
                </p>
              )}
              <button
                type="button"
                disabled={!preferences.writable}
                onClick={() =>
                  moveChannel(move.channelId, () =>
                    preferences.retryMove(move.channelId),
                  )
                }
              >
                Retry move
              </button>
              <button
                type="button"
                onClick={() => {
                  preferences.dismissMoveError(move.channelId);
                  focusChannelPlacement(move.channelId);
                }}
              >
                Dismiss
              </button>
            </div>
          ))}
        {!cached &&
        startup.ready &&
        preferences.status === "error" &&
        !preferences.transient ? (
          <ToastNotice
            title="Saved sidebar preferences couldn’t refresh"
            description="Your conversations are still available."
            tone="warning"
          >
            <Button type="button" size="sm" onClick={preferences.reload}>
              Retry
            </Button>
          </ToastNotice>
        ) : !cached && startup.ready && preferences.status === "unsupported" ? (
          <p className={styles.preferenceNotice} role="status">
            Saved groups and stars aren’t supported by this host yet.
          </p>
        ) : null}
        {list.activityStatus === "error" && !activityErrorDismissed && (
          <ToastNotice
            title="Couldn’t refresh recent activity"
            description="Activity filters and Recent sorting may be out of date."
            tone="warning"
            onDismiss={() => setActivityErrorDismissed(true)}
          >
            <Button
              type="button"
              size="sm"
              onClick={() => queries.channels.refreshList?.()}
            >
              Retry
            </Button>
          </ToastNotice>
        )}
      </>
    ),
    dialogs: (
      <>
        {creatingSection && (
          <CreateSidebarSection
            writable={preferences.sectionCreationWritable}
            refreshing={preferences.status === "loading"}
            retry={preferences.reload}
            finalFocus={createSectionTrigger}
            close={() => setCreatingSection(false)}
            create={async (section) => {
              if (!queries.sidebarPreferences.sectionCreationWritable)
                return false;
              await preferences.createSection(section);
              sidebar.toggle(`group:${section.id}`, true);
              setCreatingSection(false);
              return true;
            }}
          />
        )}
        {creatingFor && !creatingFor.surface?.signal?.aborted && (
          <CreateSidebarSection
            channelName={creatingFor.channel.name}
            writable={preferences.sectionCreationWritable}
            refreshing={preferences.status === "loading"}
            retry={preferences.reload}
            create={(section) => {
              // The modal can outlive the snapshot that admitted its menu. Check
              // the live gate before handing its draft to the optimistic store.
              if (
                creatingFor.surface?.signal?.aborted ||
                !queries.sidebarPreferences.sectionCreationWritable
              )
                return false;
              moveChannel(
                creatingFor.channel.id,
                () =>
                  preferences.createAndAssign(creatingFor.channel.id, {
                    ...section,
                    ...(creatingFor.position
                      ? { position: creatingFor.position }
                      : {}),
                  }),
                creatingFor.surface,
              );
              setCreatingFor(undefined);
              return true;
            }}
            close={() => {
              if (creatingFor.surface) creatingFor.surface.focus();
              else focusChannelPlacement(creatingFor.channel.id);
              setCreatingFor(undefined);
            }}
          />
        )}
        <CreateChannelDialog
          open={createChannelOpen}
          onOpenChange={setCreateChannelOpen}
          onCreate={createChannel}
          finalFocus={createChannelTrigger}
          session={queries}
          agents={agents}
          destinations={preferences.data?.sections ?? []}
          initialGroup={initialGroup}
          initialStarred={initialStarred}
          groupsReady={preferences.writable}
        />
      </>
    ),
  });
}
