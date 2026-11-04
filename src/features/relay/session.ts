import type { LocalAgentSource } from "../agents/local-activity";
// FOUNDATION: One relay session owns reads, local intent, delivery and shared views.
import { createSoloPreferences, soloGroups } from "./solo-preferences";
import { npubEncode } from "nostr-tools/nip19";
import { createMemberAdditions } from "../channel-members/operations";
import {
  addChannelMember,
  addChannelMembersAtOnce,
} from "../channel-members/members";
import type { LocalAgents } from "../agents/local";
import type { GitRead } from "../repos/git";
import { repoDestinations } from "../repos/destinations";
import { createAgentChoices, templateAgentChoices } from "../agents/choices";
import { parseLineup } from "../channel-templates/model";
import { createChannelKit } from "../channel-templates/capability";
import {
  createChannelSetup,
  setupWork,
  type ChannelCreationInput,
} from "../channel-templates/setup";
import { createPresence } from "../presence/presence";
import { createAgentMemories } from "../agents/memory";
import type { PresenceActivity } from "../presence/activity";
import { bindNames, type IdentityNames } from "../identity-names/service";
import { createMemberAdministration } from "../channel-members/administration";
import { createChannelLifecycle } from "./channel-lifecycle";
import { createChannelDetails } from "./channel-details";
import { canonicalDetailsName } from "./channel-details-protocol";
import { channelIdentityUnsupported } from "./channel-labels";
import { createWorkflows } from "../workflows/capability";
import { isWorkflowOperation } from "../workflows/protocol";
import {
  createRelayReader,
  type Priority,
  type ReadOptions,
  type RelayReader,
} from "./reader";
import { createAgentActivity } from "../agents/activity";
import { OBSERVER_KIND } from "../agents/observer";
import { createDirectMessages } from "./direct-messages";
import {
  type ProfileSearchOptions,
  createProfileSearch,
} from "./profile-search";
import { createChannelWrites } from "./channel-writes";
import { inventoryReader } from "../agents/inventory";
import {
  isOwnerInventoryFilter,
  readRelayLibrary,
} from "../agents/relay-library";
import { createAgentLibrary } from "../agents/library";
import { archiveHides, createIdentityArchives } from "./identity-archives";
import {
  createReadState,
  browserReadPublisherLock,
  type ReadPublisherLock,
} from "./read-state";
import {
  browserReadStateStorage,
  type ReadStateStorage,
} from "./read-state-storage";
import { createTyping } from "./typing";
import { validTypingTemplate } from "./typing-protocol";
import { workflowOwner } from "./workflow-attribution";
import { createUnread } from "./unread";
import type { SnapshotRead } from "../agents/agent-config-artifacts";

import { createInboxFeed } from "./inbox-feed";
import type {
  IncomingListener,
  IncomingMessage,
  LiveListener,
} from "./incoming";
import { objectBody } from "./body";
import { agentAudience } from "./audience";
import type { ChannelList, ChannelSummary } from "./contracts";
import { createChannelActivity } from "./channel-activity";
import { readSidebarPreferences } from "./sidebar-preferences";
import { createSidebarPreferencesStore } from "./sidebar-preferences-store";
import { createUserStatuses } from "./user-status";
import { createEmojiDirectory } from "./emoji-directory";
import { EMOJI_SET_KIND } from "./emoji";
import { createProfileDirectory } from "./profile-directory";
import { createChannelStore, type ChannelStoreOptions } from "./store";
import { MessageClock } from "./message-order";
import {
  UploadError,
  type UploadedAttachment,
  type UploadProgress,
} from "./attachments";
import { PRODUCT_FEEDBACK_KIND } from "./product-feedback";
import { attemptEnded } from "./withdraw";
import type { ReadTransport } from "./transport";
import type { LiveGlobal, LiveSnapshot, LiveSubscription } from "./live";
import {
  hasTag,
  type ReadFilter,
  type RelayEvent,
  type EventData,
} from "./events";
import { accessOnce, eventVisibility } from "./event-access";
import { isTransientFailure, ReadError, readErrorKind } from "./errors";
import {
  PublishRejected,
  browserOutboxStorage,
  createOutbox,
  type OutboxStorage,
  type OutgoingEvent,
} from "./outbox";
import { relayPartition, transportPartition } from "./partition";
import { browserThreadFollows } from "./thread-follows";
import { createMessages } from "./messages";
import { retryRead } from "./read-retry";
import { messageAuthor } from "./fold";
import { createThreadView } from "./threads";
import { ByteLru } from "./budget";
import { createRelayProfiler } from "./profiling";
import { liveRecoveryStatus } from "./live-recovery";
import {
  createRecovery,
  loadState,
  type RecoverySource,
  type RecoveryStatus,
} from "./recovery";
import { createReminders } from "./reminders";
import {
  ARTIFACT_REVISION_KIND,
  ARTIFACT_SYNC_MAX_VIEWS,
  type ArtifactSyncOwner,
  type ArtifactSyncView,
  createArtifactSyncView,
} from "./artifact-sync";
import {
  retainEvents,
  matchesEvent,
  projectEvents,
  type VisibleEvent,
} from "./projection";

export type EventViewSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  events: readonly VisibleEvent[];
  error?: string | undefined;
}>;

/** The live recovery tick re-reads the full channel list at most this often.
 * Membership notices carry joins and removals live; this read only backs up
 * changes the relay sends no notice for, such as a channel delete, a moderation
 * kick or DM, or a dropped fan-out. Any completed full read restarts it. */
export const ROSTER_BACKSTOP_INTERVAL = 15 * 60_000;

/** The live recovery tick repairs unread at most this often. The live stream
 * carries every unread change; this read only backs up what it can lose with
 * no signal: a channel the relay pruned from a batch, or a dropped fan-out. */
export const UNREAD_BACKSTOP_INTERVAL = 15 * 60_000;

/** A read of named authors' profiles only. Profiles do not depend on channels,
 * so no channel access change, including a denied channel list, can stale it. */
function isProfileFilter(filter: ReadFilter) {
  return (
    filter.kinds?.length === 1 &&
    filter.kinds[0] === 0 &&
    !!filter.authors?.length &&
    Object.keys(filter).every((key) =>
      ["kinds", "authors", "limit"].includes(key),
    )
  );
}

/** Every filter reads profiles only: see isProfileFilter. */
function isProfileRead(filters: readonly ReadFilter[]) {
  return filters.length > 0 && filters.every(isProfileFilter);
}

/** Compose once per relay/viewer. Plugins get one interface; the host owns disposal. */
export function createRelaySession(
  transport: ReadTransport | null,
  options: ChannelStoreOptions & {
    identityNames?: IdentityNames | undefined;
    agentChoices?: LocalAgents | undefined;
    localAgents?: LocalAgentSource | undefined;
    presenceActivity?: PresenceActivity;
    outboxStorage?: OutboxStorage;
    readStateStorage?: ReadStateStorage;
    readPublisherLock?: ReadPublisherLock;
    /** Overrides the 30-day read floor, for fixtures on a toy clock. */
    readStateFloor?: () => number;
    deliveryTimeoutMs?: number;
  } = {},
) {
  let closed = false;
  const lifetime = new AbortController();
  let uploadLifetime = new AbortController();
  function cancelUploads() {
    uploadLifetime.abort();
    uploadLifetime = new AbortController();
  }
  const profiling =
    options.profiling ?? transport?.profiling ?? createRelayProfiler();
  const requests = createRelayReader(transport, { profiling });
  // Finite public consumers have no recovery source. Internal roster, history,
  // catch-up and preference reads keep their existing coordinator and cooldowns.
  // The request scheduler retires in-flight reads on access and cache changes;
  // `retireBackoffs` applies the same rule to reads waiting out a backoff.
  const backoffs = new Map<
    AbortController,
    readonly ReadFilter[] | undefined
  >();
  function finiteRead<T>(
    filters: readonly ReadFilter[] | undefined,
    settings: ReadOptions | undefined,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([
      lifetime.signal,
      controller.signal,
      ...(settings?.signal ? [settings.signal] : []),
    ]);
    // Offline and cached-membership reads cannot recover by retrying.
    if (
      !transport ||
      options.cachedOnly ||
      filters?.some((filter) =>
        filter["#h"]?.some((id) => channels.queries.get?.(id)?.cached),
      )
    )
      return work(signal);
    return retryRead(async (signal) => {
      backoffs.delete(controller);
      try {
        return await work(signal);
      } catch (error) {
        backoffs.set(controller, filters);
        throw error;
      }
    }, signal).finally(() => backoffs.delete(controller));
  }
  /** Without `retired`, every backoff ends; filterless reads ignore `retired`. */
  function retireBackoffs(
    retired?: (filters: readonly ReadFilter[]) => boolean,
  ) {
    for (const [controller, filters] of backoffs)
      if (!retired || (filters && retired(filters))) controller.abort();
  }
  let revision = 0;
  let accessEpoch = 0;
  let cacheClearEpoch = 0;
  let cacheClearing = 0;
  // Access changes update every owned snapshot before invoking subscribers.
  // A subscriber of one projection may synchronously read any other projection.
  let revoking = 0;
  const notifications = new Set<() => void>();
  const notify = (listener: () => void) => {
    if (revoking) notifications.add(listener);
    else listener();
  };
  let canAccess: (id: string) => boolean = () => true;
  const typing = createTyping(
    transport?.viewer ?? "",
    (id) =>
      !closed &&
      channels.canParticipate(id) &&
      channels.queries.list().channels.some((channel) => channel.id === id),
    notify,
  );
  const recent = new ByteLru<{
    event: RelayEvent;
    revision: number;
    incoming?: "replay" | "live";
  }>(4096, 8 * 1024 * 1024);
  const observations = new Set<(events: readonly RelayEvent[]) => void>();
  const incomingListeners = new Set<IncomingListener>();
  const liveEventListeners = new Set<LiveListener>();
  const replayListeners = new Set<LiveListener>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const pendingConfirmation = new Set<string>();
  const refreshers = new Set<() => Promise<void>>();
  const views = new Map<() => void, (clear?: boolean) => void>();
  const threads = new Set<ReturnType<typeof createThreadView>>();
  const writer = transport?.writer;
  const clock = new MessageClock();
  const uploadAttachment = transport?.uploadAttachment;
  const writes =
    transport && writer
      ? createOutbox(
          transport.viewer,
          {
            ...writer,
            async sign(template, signal) {
              validateChannelWrite(template);
              validateMentionEvent(template);
              validateCanvasWrite(template);
              workflows.validate({
                ...template,
                id: "",
                pubkey: transport.viewer,
              });
              return writer.sign(template, signal);
            },
          },
          options.outboxStorage ??
            browserOutboxStorage(transportPartition(transport)),
          {
            ...(options.deliveryTimeoutMs
              ? { timeoutMs: options.deliveryTimeoutMs }
              : {}),
            profiling,
            clock,
            notifyListener: notify,
            onAccepted: (event, acknowledged) => {
              // Product feedback is accepted into a private sidecar, not queryable history.
              if (event.kind !== PRODUCT_FEEDBACK_KIND) confirm(event);
              // An `unknown` attempt waits for confirm() to read it back.
              if (acknowledged) acceptOwnActivity(event);
            },
            needsReceipt: isWorkflowOperation,
            onReceipt: (event, message) => workflows.receipt(event, message),
            // A chat this device is starting takes its events once the relay
            // has its create; its local agents hear its owner's messages now.
            // The start's own create and member adds never wait.
            holdPublish: (event) => {
              if (event.kind === 9007 || event.kind === 9000) return;
              const id = event.tags.find(([name]) => name === "h")?.[1];
              if (!id) return;
              const ready = channelWrites.starting(id);
              if (ready && event.kind === 9) hearStarting(event, id);
              return ready;
            },
            preparePublish: async (event, signal) => {
              validateChannelWrite(event);
              workflows.validate(event);
              if (event.kind === 40100) {
                const id = event.tags.find((t) => t[0] === "h")?.[1];
                if (!id) throw new Error("Canvas has no channel");
                await channelWrites.refreshMembership(id);
                signal.throwIfAborted();
                validateCanvasWrite(event);
              }
              const checkMentions = await prepareMentionPublication(
                event,
                signal,
              );
              return () => {
                validateChannelWrite(event);
                workflows.validate(event);
                validateCanvasWrite(event);
                checkMentions?.();
              };
            },
          },
        )
      : undefined;
  const rawLocal = () => writes?.local.snapshot() ?? [];
  let retainedChannelEvents: () => readonly RelayEvent[] = () => [];
  let retainedChannelEvent: (id: string) => RelayEvent | undefined = () =>
    undefined;
  function retainedThreadEvent(id: string) {
    for (const thread of threads) {
      if (!canAccess(thread.channelId)) continue;
      const event = thread.event(id);
      if (event) return event;
    }
  }
  function retainedThreadEvents() {
    return [...threads].flatMap((thread) =>
      canAccess(thread.channelId) ? thread.events() : [],
    );
  }
  function retainedEvent(id: string) {
    return retainedThreadEvent(id) ?? retainedChannelEvent(id);
  }
  const canReadRemote = (id: string) =>
    !options.cachedOnly && canAccess(id) && !channels.queries.get?.(id)?.cached;
  function visibility(events: readonly EventData[] = [], remote = false) {
    const evidence = new Map(
      [...rawLocal().map((item) => item.event), ...events].map((event) => [
        event.id,
        event,
      ]),
    );
    return eventVisibility(
      // Remote visibility filters one accept() batch and is never retained.
      // Remote access builds the channel's discovery summary: read it once.
      remote ? accessOnce(canReadRemote) : canAccess,
      // Retained view targets survive shared-cache eviction. They are evidence,
      // not an access grant: eventVisibility still checks every referenced target.
      (id) =>
        evidence.get(id) ??
        recent.peek(id)?.event ??
        retainedEvent(id) ??
        unread.event(id),
    );
  }
  const local = () => {
    const visible = visibility();
    return rawLocal().filter(
      (item) =>
        item.event.kind !== PRODUCT_FEEDBACK_KIND && visible(item.event),
    );
  };
  const localViews = writes
    ? { snapshot: local, subscribe: writes.local.subscribe }
    : undefined;
  /** A profile read survives a channel access change, never a full cache clear. */
  function profileReadSurvives(
    filters: readonly ReadFilter[],
    cleared: number,
  ) {
    return isProfileRead(filters) && cleared === cacheClearEpoch;
  }
  function revokeAccess(commit: () => void, ids?: readonly string[]) {
    revoking++;
    try {
      accessEpoch++;
      cancelUploads();
      // Lifecycle work is keyed by channel and rechecks access after every
      // read; with known ids, other channels' permission reads need not die.
      lifecycle.cancel(ids);
      details.cancel();
      memberAdministration.clear();
      typing.clear();
      // Saved owner inventory and profiles do not depend on channel access.
      // Preserve only those narrow reads; broad, mixed, ID and channel reads
      // must still retire.
      const retired = (filters: readonly ReadFilter[]) =>
        !filters.length ||
        filters.some(
          (filter) =>
            !isOwnerInventoryFilter(filter, transport?.viewer) &&
            !isProfileFilter(filter),
        );
      requests.invalidate(retired);
      retireBackoffs(retired);
      const visible = visibility();
      // Profiles (kind 0) are global: any community member can read any of
      // them, so losing a channel does not make a name private. They stay.
      const revoked = recent
        .entries()
        .flatMap(([id, { event }]) => (!visible(event) ? [id] : []));
      // Purge before notifying: callbacks must not be able to reseed denied data.
      for (const id of revoked) recent.delete(id);
      channels.purgeAccess((events) => events.filter(visibility(events)));
      writes?.purgeConfirmed(visible);
      emoji.clear();
      statuses.clear();
      activity.accessChanged();
      memories.clear();
      presence.clear();
      channelActivity.retain(canReadRemote);
      activityRosterKey = undefined;
      archives.clear();
      workflows.clear();
      for (const purge of views.values()) purge();
      // The relay reapplies access to a new sync; nothing held survives.
      for (const view of artifactSyncs) view.restart();
      commit();
      unread.purge();
      inboxFeed.purge();
    } finally {
      if (--revoking === 0) {
        const pending = [...notifications];
        notifications.clear();
        for (const listener of pending) notify(listener);
        for (const revoked of [...followRevocations]) revoked();
      }
    }
  }
  /** The channel of a failed or running timeline write: a message, reaction,
   * edit or deletion. Only membership decides whether these can be sent. Other
   * kinds, and workflow deletions, have their own owners or may target a
   * channel the viewer is not on (a create, an owner removing their agent), so
   * they are never stranded. */
  const contribution = (item: OutgoingEvent) =>
    (item.delivery === "failed" || item.delivery === "sending") &&
    [5, 7, 9, 40003].includes(item.event.kind) &&
    !isWorkflowOperation(item.event)
      ? item.event.tags.find(([name]) => name === "h")?.[1]
      : undefined;
  let sweeping = false;
  let sweepAgain = false;
  /** Leaving or removal strands a channel's failed writes: nothing can retry
   * or reach them, including ones an earlier session left. After a complete
   * roster read or a confirmed Leave or Delete, the writer confirms which
   * channels the viewer cannot participate in no longer list them: a
   * replica's omission can be lag, and a local denial (a 401 or a ban) is not
   * removal. Writes that had already failed go, unless retried since. One
   * running or retried after the writer was asked is swept again once its
   * attempt ends, even if it fails before the answer arrives, since the
   * viewer may have rejoined meanwhile.
   * Unconfirmed intent stays for a regrant. One writer read runs at a time;
   * a request or a cancelled read sweeps again after it. */
  function dropStrandedSends() {
    const outbox = writes?.outbox;
    if (!outbox) return;
    if (sweeping) {
      sweepAgain = true;
      return;
    }
    sweeping = true;
    // Restored sends can still be loading when the first roster read lands.
    void outbox
      .ready()
      .then(async () => {
        const items = outbox.snapshot();
        const ids = [
          ...new Set(
            items.flatMap((item) => {
              const id = contribution(item);
              return id && !channels.canParticipate(id) ? [id] : [];
            }),
          ),
        ];
        if (!ids.length) return;
        // The writer's answer covers only writes that had failed when asked.
        // A retry keeps the ID but replaces the record, so keep the records.
        const settled = new Set(
          items.filter((item) => item.delivery === "failed"),
        );
        const gone = await channels
          .unlisted(ids, lifetime.signal)
          .catch((error: unknown) => {
            // Access changes cancel this read and may strand more sends. Only
            // another change can cancel the rerun's read, so this cannot loop.
            if (
              readErrorKind(error) === "cancelled" &&
              !lifetime.signal.aborted
            )
              sweepAgain = true;
            throw error;
          });
        for (const item of outbox.snapshot()) {
          const channelId = contribution(item);
          if (
            !channelId ||
            !gone.includes(channelId) ||
            channels.canParticipate(channelId)
          )
            continue;
          const { id } = item.event;
          if (settled.has(item)) void outbox.dismiss(id).catch(() => {});
          else void attemptEnded(outbox, id).then(dropStrandedSends);
        }
      })
      .catch(() => {})
      .finally(() => {
        sweeping = false;
        if (!sweepAgain) return;
        sweepAgain = false;
        dropStrandedSends();
      });
  }
  /** Solo chats this device is starting; set once channel writes exist. */
  let startingChannel: (id: string) => Promise<void> | undefined = () =>
    undefined;
  // Keep ordinary reads on their existing promise chain; page metadata is opt-in.
  function readVerified(
    filters: readonly ReadFilter[],
    settings: ReadOptions | undefined,
    channelTraffic: true,
    beforeInbox: undefined,
    page: { withRelayCount: true },
  ): Promise<{ events: readonly RelayEvent[]; relayCount: number }>;
  function readVerified(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
    channelTraffic?: boolean,
    beforeInbox?: (
      events: readonly RelayEvent[],
      raw: readonly RelayEvent[],
    ) => void,
  ): Promise<readonly RelayEvent[]>;
  async function readVerified(
    filters: readonly ReadFilter[],
    settings?: ReadOptions,
    channelTraffic = true,
    beforeInbox?: (
      events: readonly RelayEvent[],
      raw: readonly RelayEvent[],
    ) => void,
    page?: { withRelayCount: true },
  ) {
    // A null session can never acquire a transport; retrying it cannot recover.
    if (!transport) throw new Error("Relay is disconnected");
    if (
      options.cachedOnly ||
      filters.some((filter) =>
        filter["#h"]?.some((id) => channels.queries.get?.(id)?.cached),
      )
    )
      throw new ReadError(
        "unavailable",
        "Reconnect to refresh conversation access.",
      );
    // A chat this device is still starting has nothing to read until the
    // relay has its create; reading sooner would be refused as a denial.
    const starts = [
      ...new Set(filters.flatMap((filter) => filter["#h"] ?? [])),
    ].flatMap((id) => {
      const start = startingChannel(id);
      // A start that made no chat has nothing to read; asking the relay
      // would only be refused as lost access.
      return start
        ? [
            start.catch(() => {
              throw new ReadError("unavailable", "This chat isn't available.");
            }),
          ]
        : [];
    });
    if (starts.length) {
      const aborted = settings?.signal;
      aborted?.throwIfAborted();
      let stop = () => {};
      await Promise.race([
        Promise.all(starts),
        ...(aborted
          ? [
              new Promise<void>((resolve) => {
                const done = () => resolve();
                aborted.addEventListener("abort", done, { once: true });
                stop = () => aborted.removeEventListener("abort", done);
              }),
            ]
          : []),
      ]).finally(() => stop());
      aborted?.throwIfAborted();
    }
    const epoch = accessEpoch;
    const cleared = cacheClearEpoch;
    let events: readonly RelayEvent[];
    try {
      events = await requests.reader.read(filters, settings);
    } catch (error) {
      // A single explicit channel has an unambiguous denial owner. A failed
      // broad/multi-channel read is not evidence that every channel was revoked.
      const ids = new Set(filters.flatMap((filter) => filter["#h"] ?? []));
      const [id] = ids;
      if (
        channelTraffic &&
        !closed &&
        epoch === accessEpoch &&
        readErrorKind(error) === "denied" &&
        ids.size === 1 &&
        id !== undefined &&
        filters.every((filter) => filter["#h"]?.length)
      )
        channels.denyChannel(id, error);
      throw error;
    }
    // A profile read stays valid across an access change; see isProfileFilter.
    if (
      closed ||
      (epoch !== accessEpoch && !profileReadSurvives(filters, cleared))
    )
      throw new DOMException("Stale relay read", "AbortError");
    const relayCount = events.length;
    // A broken or stale transport must not promote private sidecar events into
    // finite reads, retained views, or store discovery.
    events = events.filter((event) => event.kind !== PRODUCT_FEEDBACK_KIND);
    // Ranked global search needs channel authority before visibility filtering.
    // Store metadata reads use channelTraffic=false, so this cannot recurse.
    // So does a read of every channel that asks for it, of any kinds.
    const chat = (kind: number) => [9, 40002, 40008].includes(kind);
    const broad = !!settings?.resolveChannels;
    const resolves = (filter: ReadFilter, broad: boolean) =>
      (broad ||
        filter.search !== undefined ||
        !!filter.authors?.length ||
        filter.since !== undefined ||
        filter.until !== undefined) &&
      !filter["#h"]?.length &&
      !!filter.kinds?.length &&
      (broad || filter.kinds.every(chat));
    if (channelTraffic && filters.every((filter) => resolves(filter, broad))) {
      // A lookup may extend a discovered list, never stand in for it.
      if (broad && channels.queries.list().status !== "ready")
        throw new ReadError("unavailable", "Channels are not discovered yet.");
      const ids = [
        ...new Set(
          events.flatMap((event) => {
            const tags = event.tags.filter(([name]) => name === "h");
            return (broad || chat(event.kind)) &&
              tags.length === 1 &&
              tags[0]?.[1]
              ? [tags[0][1]]
              : [];
          }),
        ),
      ];
      // What only `resolveChannels` looks up is known for agents alone.
      if (!filters.every((filter) => resolves(filter, false))) {
        for (const id of ids)
          if (!channels.queries.get?.(id)) learnedForAgents.add(id);
      } else for (const id of ids) learnedForAgents.delete(id);
      await channels.queries.resolve?.(ids, settings);
      // A read of every channel keeps what visibility keeps below.
      if (!broad)
        events = events.filter((event) => {
          const destinations = event.tags.filter(([name]) => name === "h");
          const id = destinations[0]?.[1];
          return (
            destinations.length === 1 && !!id && !!channels.queries.get?.(id)
          );
        });
      settings?.signal?.throwIfAborted();
      if (closed || epoch !== accessEpoch)
        throw new DOMException("Stale relay search", "AbortError");
    }
    const visible = accept(
      events,
      channelTraffic,
      beforeInbox,
      settings?.signal,
    );
    // Discovery must see signed grants/removals even when their channel is
    // currently denied; only the store interprets roster completeness.
    const result = channelTraffic
      ? visible
      : events.filter(
          (event) =>
            [39000, 39002, 9007].includes(event.kind) ||
            visible.includes(event),
        );
    return page ? { events: result, relayCount } : result;
  }
  /** The relay's verified answer only: no projection, discovery or inbox. */
  async function relayRead(
    filters: readonly ReadFilter[],
    settings: ReadOptions,
  ): Promise<readonly RelayEvent[]> {
    if (options.cachedOnly)
      throw new ReadError(
        "unavailable",
        "Reconnect to refresh conversation access.",
      );
    const epoch = accessEpoch;
    const events = await requests.reader.read(filters, settings);
    if (closed || epoch !== accessEpoch)
      throw new DOMException("Stale relay read", "AbortError");
    return events.filter((event) => event.kind !== PRODUCT_FEEDBACK_KIND);
  }
  // Name-only profile search, when the relay has it. Like directory reads,
  // results stay out of the shared profile views: admitting a search page
  // could evict conversation profiles.
  const nameSearch = options.cachedOnly
    ? undefined
    : requests.reader.searchProfiles;
  const verified: RelayReader = {
    read: readVerified,
    ...(nameSearch
      ? {
          async searchProfiles(query, limit, page, settings) {
            const epoch = accessEpoch;
            const cleared = cacheClearEpoch;
            const events = await nameSearch(query, limit, page, settings);
            settings?.signal?.throwIfAborted();
            if (closed || epoch !== accessEpoch || cleared !== cacheClearEpoch)
              throw new DOMException("Stale profile search", "AbortError");
            return events;
          },
        }
      : {}),
  };
  const searchProfiles = createProfileSearch(verified);
  /** Directory reads bypass shared profile admission. Retry one access
   * invalidation here, where caller/cache/connection lifetimes are known. */
  function directoryRead<T>(
    settings: ReadOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const generation = liveGeneration;
    return finiteRead(undefined, settings, (signal) => {
      if (liveGeneration !== generation)
        throw new DOMException("Stale directory read", "AbortError");
      return directoryReadOnce({ ...settings, signal }, run);
    });
  }
  async function directoryReadOnce<T>(
    settings: ReadOptions | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const cleared = cacheClearEpoch;
    const generation = liveGeneration;
    for (let attempt = 0; ; attempt++) {
      const epoch = accessEpoch;
      try {
        const result = await run();
        settings?.signal?.throwIfAborted();
        if (
          closed ||
          epoch !== accessEpoch ||
          cleared !== cacheClearEpoch ||
          generation !== liveGeneration
        )
          throw new DOMException("Stale directory read", "AbortError");
        return result;
      } catch (error) {
        if (
          attempt > 0 ||
          readErrorKind(error) !== "cancelled" ||
          closed ||
          settings?.signal?.aborted ||
          epoch === accessEpoch ||
          cleared !== cacheClearEpoch ||
          generation !== liveGeneration
        )
          throw error;
      }
    }
  }
  function accept(
    events: readonly RelayEvent[],
    channelTraffic = true,
    beforeInbox?: (
      events: readonly RelayEvent[],
      raw: readonly RelayEvent[],
    ) => void,
    signal?: AbortSignal,
    incomingPhase?: "replay" | "live",
  ): readonly RelayEvent[] {
    if (closed) return [];
    // Authority precedes every projection, even in a batch containing both a
    // membership removal and message content. Store reads apply discovery at
    // their own completeness boundary instead.
    if (
      channelTraffic &&
      events.some((event) => [39000, 39002].includes(event.kind))
    )
      channels.acceptDiscovery(events);
    // Ephemeral typing and observer telemetry never enter retained content views.
    const visible = events
      .filter(
        (event) =>
          event.kind !== OBSERVER_KIND &&
          event.kind !== 20002 &&
          event.kind !== PRODUCT_FEEDBACK_KIND,
      )
      .filter(visibility(events, true));
    const epoch = accessEpoch;
    beforeInbox?.(visible, events);
    if (
      beforeInbox &&
      (closed || epoch !== accessEpoch || signal?.aborted || cacheClearing)
    )
      throw new DOMException("Stale Inbox read", "AbortError");
    typing.accept(visible);
    if (closed || epoch !== accessEpoch) return [];
    profiling.measure(
      "events.reconcile",
      events[0]?.id ?? "empty",
      () => {
        for (const event of visible) {
          const previous = recent.peek(event.id);
          // Replay can precede a fresh live copy. Keep alert receipt separate from content receipt.
          const incoming = [9, 40002, 40008].includes(event.kind)
            ? incomingPhase === "live" || previous?.incoming === "live"
              ? "live"
              : previous?.incoming === "replay" ||
                  (incomingPhase === "replay" &&
                    !previous &&
                    !unread.event(event.id))
                ? "replay"
                : undefined
            : undefined;
          recent.set(event.id, {
            event,
            revision: ++revision,
            ...(incoming ? { incoming } : {}),
          });
        }
        activity.messagesChanged(visible);
        if (closed || epoch !== accessEpoch) return;
        reads.accept(visible);
        unread.accept(visible);
        writes?.observe(visible);
        if (epoch !== accessEpoch) return;
        // A profile read's signal lets the directory publish its pages once.
        profiles.accept(visible, signal);
        if (epoch !== accessEpoch) return;
        emoji.accept(visible);
        if (epoch !== accessEpoch) return;
        statuses.accept(visible);
        if (epoch !== accessEpoch) return;
        if (channelTraffic) channels.accept(visible);
        for (const listener of observations) {
          if (closed || epoch !== accessEpoch) return;
          listener(visible);
        }
      },
      visible.length,
    );
    return visible;
  }
  /** The relay's ACK or read-back verifies an own send before any live echo. */
  function acceptOwnActivity(event: RelayEvent) {
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!cacheClearing && channelId && canReadRemote(channelId))
      channelActivity.accept([event]);
  }
  function confirm(event: RelayEvent, attempt = 0) {
    if (closed || (attempt === 0 && pendingConfirmation.has(event.id))) return;
    pendingConfirmation.add(event.id);
    void verified
      .read([{ ids: [event.id], limit: 1 }], {
        priority: attempt === 0 ? "foreground" : "background",
      })
      .catch(() => [])
      .then((events) => {
        if (closed) return;
        if (events.some(({ id }) => id === event.id)) acceptOwnActivity(event);
        const operation = writes?.outbox
          .snapshot()
          .find((item) => item.event.id === event.id);
        if (!operation || operation.delivery === "seen" || attempt >= 4) {
          pendingConfirmation.delete(event.id);
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          confirm(event, attempt + 1);
        }, [500, 1500, 4000, 10000][attempt]);
        timers.add(timer);
      });
  }
  const presence = createPresence(
    transport,
    options.presenceActivity,
    (status, signal) =>
      traffic?.publishPresence?.(status, signal) ?? Promise.resolve(false),
    notify,
  );
  const profiles = createProfileDirectory(
    verified,
    localViews,
    notify,
    transport &&
      (transport.verifiedProfiles || transport.readVerifiedProfileAuthority)
      ? {
          authority: transport.verifiedProfiles,
          refresh: transport.readVerifiedProfileAuthority?.bind(transport),
          subscribe: (filter, sink) =>
            traffic?.syncVerifiedProfiles?.(filter, sink),
        }
      : undefined,
  );
  const emoji = createEmojiDirectory(
    verified,
    notify,
    transport?.viewer,
    transport &&
      writer &&
      (!writer.kinds || writer.kinds.includes(EMOJI_SET_KIND))
      ? {
          writer,
          ...(uploadAttachment
            ? {
                async upload(file: File, signal: AbortSignal) {
                  const combined = AbortSignal.any([
                    signal,
                    lifetime.signal,
                    uploadLifetime.signal,
                  ]);
                  combined.throwIfAborted();
                  if (closed) throw new UploadError("denied");
                  const result = await uploadAttachment(file, combined);
                  combined.throwIfAborted();
                  if (closed) throw new UploadError("denied");
                  return result;
                },
              }
            : {}),
        }
      : undefined,
  );
  const statuses = createUserStatuses(
    verified,
    transport?.viewer,
    writer,
    notify,
    emoji.tags,
  );
  let memoryConnected = !transport?.subscribe;
  const memories = createAgentMemories(
    transport?.readAgentMemories,
    transport?.viewer ?? "",
    () => !closed && !revoking && !cacheClearing && memoryConnected,
    notify,
  );
  const agentLibrary = createAgentLibrary(
    transport
      ? inventoryReader(
          transport.readAgentLibrary ? requests.readAgentLibrary : undefined,
          (signal) =>
            readRelayLibrary(requests.reader, transport.viewer, signal),
        )
      : undefined,
    notify,
  );
  const archives = createIdentityArchives(
    requests.reader,
    transport?.archiveAuthority,
    notify,
    { writer: transport?.identityArchive, viewer: transport?.viewer },
  );
  const agentChoices = createAgentChoices({
    // Offline sessions keep their historical, never-matching agent scope.
    scope: transport ? transportPartition(transport) : "undefined:undefined",
    library: agentLibrary.queries,
    native: options.agentChoices,
    archives: archives.queries,
    signal: lifetime.signal,
  });
  const nameSource = {
    viewer: transport?.viewer,
    profiles: profiles.queries,
    agentLibrary: agentLibrary.queries,
    relayUrl: transport?.scope,
  };
  const identityNames =
    options.identityNames?.bind(nameSource) ?? bindNames(nameSource);
  const activity = createAgentActivity(
    !!transport?.agentActivity && !!transport.subscribe,
    (generation) => traffic?.observe?.(generation),
    (channel) => canAccess(channel),
    notify,
    (id) => recent.peek(id)?.event ?? retainedEvent(id),
    options.localAgents && transport
      ? { source: options.localAgents, scope: transportPartition(transport) }
      : undefined,
  );
  const channelActivity = createChannelActivity(
    transport?.channelActivity
      ? // A transient failure retries quietly before Recent shows its notice.
        (ids, signal) =>
          retryRead(
            (retrySignal) =>
              transport.channelActivity?.(ids, retrySignal) ??
              Promise.resolve([]),
            signal,
          )
      : undefined,
    notify,
  );
  /** When the last full channel-list read completed, whatever started it. */
  let rosterReadAt = 0;
  const channels = createChannelStore(
    transport
      ? {
          read: (filters, settings) => readVerified(filters, settings, false),
          viewer: transport.viewer,
          relayAuthor: transport.relayAuthor,
          archiveAuthority: transport.archiveAuthority,
          channelIdentity: transport.channelIdentity,
          media: (url, size) => transport.media(url, size),
          revokeAccess,
          rosterComplete: dropStrandedSends,
          visible: (events) => events.filter(visibility(events)),
          restored: (events) => unread.accept(events),
          demand: (channelId) => demandChannel(channelId),
          rosterChanged: (strong) => {
            if (channels.roster().state === "verified")
              rosterReadAt = Date.now();
            settleHintConfirmations(strong);
            publishLive();
          },
        }
      : null,
    profiles,
    {
      ...options,
      profiling,
      clock,
      notifyListener: notify,
      ...(localViews ? { local: localViews } : {}),
    },
  );
  canAccess = channels.canAccess;
  retainedChannelEvent = channels.retainedEvent;
  retainedChannelEvents = channels.retainedEvents;
  const repositories = repoDestinations(async (filters, signal) => {
    const bound = AbortSignal.any([signal, lifetime.signal]);
    bound.throwIfAborted();
    const events = await finiteRead(filters, { signal: bound }, (signal) =>
      requests.reader.read(filters, { signal }),
    );
    bound.throwIfAborted();
    // NIP-34/NIP-MP metadata is global; channel tags are associations, not ACLs.
    return events;
  });
  const details = createChannelDetails({
    reader: transport && !options.cachedOnly ? requests.reader : undefined,
    writer: transport?.channelDetails,
    labels: transport?.channelIdentity === true,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    canAccess: (id) => !closed && channels.canParticipate(id),
    acceptDiscovery: (events) => channels.acceptDiscovery(events),
  });
  const lifecycle = createChannelLifecycle({
    reader: transport && !options.cachedOnly ? requests.reader : undefined,
    writer: transport?.channelLifecycle,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    canAccess: (id) => !closed && channels.canParticipate(id),
    acceptDiscovery: (events) => channels.acceptDiscovery(events),
    removed: (id) => {
      channels.denyChannel(id, new Error("Channel is no longer available"));
      dropStrandedSends();
    },
  });
  const memberAdministration = createMemberAdministration({
    reader: transport && !options.cachedOnly ? requests.reader : undefined,
    writer: transport?.memberAdministration,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    canAccess: (id) =>
      !closed && !revoking && !cacheClearing && canReadRemote(id),
    acceptDiscovery: (events) => channels.acceptDiscovery(events),
  });
  const workflows = createWorkflows({
    reader: transport ? verified : undefined,
    viewer: transport?.viewer ?? "",
    outbox: writes?.outbox,
    local: localViews,
    host: transport?.workflows,
    relayHttpUrl: transport?.relayHttpUrl,
    canAccess: (channelId) => channels.canParticipate(channelId),
    notify,
  });
  let sourceChannelList = channels.queries.list();
  let activityChannelList: ChannelList = Object.freeze({
    ...sourceChannelList,
    activityStatus: channelActivity.status(),
  });
  let channelActivityRevision = channelActivity.revision();
  const projectedChannels = new WeakMap<ChannelSummary, ChannelSummary>();
  const channelQueries = Object.freeze({
    ...channels.queries,
    list() {
      const snapshot = channels.queries.list();
      const activityRevision = channelActivity.revision();
      if (
        snapshot === sourceChannelList &&
        activityRevision === channelActivityRevision
      )
        return activityChannelList;
      sourceChannelList = snapshot;
      channelActivityRevision = activityRevision;
      const projected = snapshot.channels.map((channel) => {
        const lastActivityAt = channelActivity.last(channel.id);
        if (!channelActivity.known(channel.id)) return channel;
        const previous = projectedChannels.get(channel);
        if (previous && previous.lastActivityAt === lastActivityAt)
          return previous;
        const next = Object.freeze({
          ...channel,
          lastActivityAt,
          activityKnown: true as const,
        });
        projectedChannels.set(channel, next);
        return next;
      });
      activityChannelList = Object.freeze({
        ...snapshot,
        activityStatus: channelActivity.status(),
        channels: projected.every(
          (channel, index) => channel === snapshot.channels[index],
        )
          ? snapshot.channels
          : Object.freeze(projected),
      });
      return activityChannelList;
    },
    subscribeList(listener: () => void) {
      const offChannels = channels.queries.subscribeList(listener);
      const offActivity = channelActivity.subscribe(listener);
      return () => {
        offChannels();
        offActivity();
      };
    },
  });
  const readScope = transport
    ? transportPartition(transport)
    : relayPartition("offline", "");
  const reads = createReadState({
    viewer: transport?.viewer ?? "",
    reader: requests.reader,
    host: transport?.readState,
    storage:
      options.readStateStorage ??
      browserReadStateStorage(readScope, transport?.viewer ?? ""),
    lock: options.readPublisherLock ?? browserReadPublisherLock(readScope),
    floor: options.readStateFloor,
    notify,
    broadcastName: transport?.readState
      ? `buzz-read-state:${readScope}`
      : undefined,
  });
  const unread = createUnread({
    profiles: profiles.queries,
    reads,
    channels: channels.queries,
    // Repair owns evidence only, not timeline/history ingestion. The shared
    // scheduler and verified transport stay shared; unread fences access epochs.
    reader: requests.reader,
    viewer: transport?.viewer ?? "",
    relayAuthor: transport?.relayAuthor ?? "",
    workflowAuthority: transport?.archiveAuthority,
    ...(transport?.archiveAuthority
      ? { signingAuthority: transport.archiveAuthority }
      : {}),
    notify,
    follows: browserThreadFollows(readScope),
  });
  const inboxFeed = createInboxFeed({
    // A withheld auxiliary event is not proof of an exhausted history page.
    // Fail closed at raw/admitted admission; do not relax reference visibility.
    reader: {
      read: (filters, settings) =>
        finiteRead(filters, settings, (signal) =>
          readVerified(
            filters,
            { ...settings, signal },
            true,
            (visible, raw) => {
              const admitted = new Set(visible.map((event) => event.id));
              if (
                raw.some(
                  (event) =>
                    [40003, 5, 9005].includes(event.kind) &&
                    !admitted.has(event.id),
                )
              )
                throw new Error(
                  "Inbox message updates could not be verified for current access. Retry inbox.",
                );
            },
          ),
        ),
    },
    retainedEvent: unread.event,
    retainedEditIds: unread.retainedEditIds,
    addressedRead: (filter, signal, prepare) =>
      finiteRead([filter], { signal }, (signal) =>
        readVerified([filter], { signal }, true, prepare),
      ),
    channels: channels.queries,
    viewer: transport?.viewer ?? "",
    notify,
  });
  let traffic: LiveSubscription | undefined;
  const artifactSyncs = new Set<ArtifactSyncOwner>();
  /** Channels `artifacts.follow` keeps live, each follow's own list. */
  const followed = new Set<readonly string[]>();
  /** Each follow's check, after an access change, for channels it lost. */
  const followRevocations = new Set<() => void>();
  /** Channels each `attend` keeps live for agents' watches, its own list. */
  const attended = new Set<readonly string[]>();
  /** The channels the live routes carry for the viewer: joined and opened,
   * as without any `attend`. */
  let viewerLive: ReadonlySet<string> = new Set();
  /** Channels the session knows only because agents' watches looked them
   * up: an attended channel's metadata read, or a read of every channel that
   * resolved channels the viewer's own reads would not. One leaves once the
   * viewer's traffic knows it too: joined, opened or looked up. */
  const learnedForAgents = new Set<string>();
  /** Attended channels read since the last wait ended, in flight or done.
   * One known again leaves it, so it is read at once if it is unknown again. */
  const attendChecked = new Set<string>();
  /** Attended channels whose metadata read is in flight. */
  const attendReading = new Set<string>();
  /** The first wait before an attended channel still unknown is read again,
   * and the most it grows to while channels stay unknown. */
  const ATTEND_RETRY_MS = 30_000;
  const ATTEND_RETRY_MAX_MS = 300_000;
  let attendDelay = ATTEND_RETRY_MS;
  /** One wait for every channel still unknown, so reads do not multiply. */
  let attendRetry: ReturnType<typeof setTimeout> | undefined;
  /** Forgets the reads made, and any wait for them, so channels still
   * unknown are read again; a reconnect or new `attend` also starts the wait
   * over from `ATTEND_RETRY_MS`. */
  const retryAttended = (restart = true) => {
    if (attendRetry) {
      clearTimeout(attendRetry);
      timers.delete(attendRetry);
      attendRetry = undefined;
    }
    attendChecked.clear();
    if (restart) attendDelay = ATTEND_RETRY_MS;
  };
  const retryAttendedLater = () => {
    if (closed || attendRetry) return;
    const delay = attendDelay;
    attendDelay = Math.min(delay * 2, ATTEND_RETRY_MAX_MS);
    attendRetry = setTimeout(() => {
      retryAttended(false);
      updateInterests();
    }, delay);
    timers.add(attendRetry);
  };
  /** Reads the metadata of attended channels not known. Only into a ready
   * list: a lookup may extend one, never stand in for initial discovery. A
   * channel still unknown after its read, because the read failed or found
   * nothing the viewer may read, is read again after a wait that doubles up
   * to `ATTEND_RETRY_MAX_MS`, or once discovery is after a reconnect: it may
   * have turned public since. So is one that becomes unknown again, as when
   * newer metadata makes it private. */
  const resolveAttended = () => {
    if (
      closed ||
      !channels.queries.resolve ||
      channels.queries.list().status !== "ready"
    )
      return;
    const unknown = [...new Set([...attended].flat())].filter(
      (id) => !channels.queries.get?.(id),
    );
    for (const id of attendChecked)
      if (channels.queries.get?.(id)) attendChecked.delete(id);
    if (!unknown.length) attendDelay = ATTEND_RETRY_MS;
    if (unknown.some((id) => attendChecked.has(id) && !attendReading.has(id)))
      retryAttendedLater();
    const fresh = unknown.filter((id) => !attendChecked.has(id));
    for (const id of fresh) {
      attendChecked.add(id);
      attendReading.add(id);
      learnedForAgents.add(id);
    }
    for (let start = 0; start < fresh.length; start += 128) {
      const batch = fresh.slice(start, start + 128);
      void channels.queries
        // In the background lane, so an interactive read never waits behind it.
        .resolve(batch, { signal: lifetime.signal, priority: "background" })
        .catch(() => {})
        .finally(() => {
          for (const id of batch) attendReading.delete(id);
          updateInterests();
        });
    }
  };
  const liveListeners = new Set<() => void>();
  let liveSnapshot: LiveSnapshot = Object.freeze({
    status: transport?.subscribe ? "connecting" : "unavailable",
    routes: Object.freeze([]),
  });
  type Catchup = {
    generation: number;
    state: "pending" | "verified" | "deferred" | "error";
    error?: string | undefined;
    transient?: boolean;
    retryAt?: number;
  };
  const catchups = new Map<string, Catchup>();
  let liveGeneration = 0;
  /** Suspended-preview metadata rechecks in flight. */
  let previewChecks = 0;
  type LiveView = LiveSnapshot &
    Readonly<{
      roster: ReturnType<typeof channels.roster>;
      heads: readonly Readonly<{
        channelId: string;
        state: "pending" | "verified" | "deferred" | "error";
        error?: string;
        transient?: true;
      }>[];
      /** Public previews closed by the relay, awaiting a metadata recheck. A
       * failed recheck keeps them suspended; recovery retries it. */
      previews?: "checking" | "suspended";
    }>;
  let liveView: LiveView = Object.freeze({
    ...liveSnapshot,
    roster: channels.roster(),
    heads: Object.freeze([]),
  });
  const publishLive = () => {
    if (closed) return;
    const suspended = channels.suspendedPreviews().length > 0;
    liveView = Object.freeze({
      ...liveSnapshot,
      ...(suspended
        ? {
            error: "Public preview access needs rechecking.",
          }
        : {}),
      roster: channels.roster(),
      heads: Object.freeze(
        [...catchups].map(([channelId, { state, error, transient }]) =>
          Object.freeze({
            channelId,
            state,
            ...(error ? { error } : {}),
            ...(error && transient ? { transient: true as const } : {}),
          }),
        ),
      ),
      ...(suspended
        ? { previews: previewChecks ? "checking" : "suspended" }
        : {}),
    });
    for (const listener of liveListeners) notify(listener);
  };
  const live = Object.freeze({
    snapshot: () => liveView,
    subscribe(listener: () => void) {
      liveListeners.add(listener);
      return () => {
        liveListeners.delete(listener);
      };
    },
    retry() {
      channels.retryList();
      revalidatePreviews(channels.suspendedPreviews());
      for (const id of channels.demandedChannels()) demandChannel(id);
      traffic?.retry();
    },
  });
  /** Hands the owner's signed message in a chat still starting to live
   * listeners (local agents) before the relay can echo it. Listeners drop the
   * later echo of the same event. */
  function hearStarting(event: RelayEvent, channelId: string) {
    if (closed) return;
    const batch = Object.freeze({ events: Object.freeze([event]), channelId });
    for (const listener of [...liveEventListeners, ...replayListeners]) {
      try {
        listener(batch);
      } catch (error) {
        console.error("Live listener failed", error);
      }
    }
  }
  function validateMentions(channelId: string, pubkeys: readonly string[]) {
    if (!pubkeys.length) return;
    const channel = channels.queries
      .list()
      .channels.find((item) => item.id === channelId);
    if (
      closed ||
      !channels.canWrite(channelId) ||
      !channel?.members ||
      channel.archived ||
      (transport?.subscribe && liveSnapshot.status !== "connected")
    )
      throw new Error("Refresh channel membership before mentioning anyone");
    if (pubkeys.some((key) => !channel.members?.includes(key)))
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  function validateCanvasWrite(event: Pick<EventData, "kind" | "tags">) {
    if (event.kind !== 40100) return;
    const id = event.tags.find((t) => t[0] === "h")?.[1];
    if (!id || closed || !channels.canWrite(id))
      throw new Error("Canvas access changed; your draft is kept");
  }
  /** Guest admission is rechecked for signed retries and after async preparation. */
  function validateChannelWrite(event: Pick<EventData, "kind" | "tags">) {
    // Membership commands have their own relay authorization, including a
    // Guest removing an owned agent. They are not channel contributions.
    if ([9000, 9001, 9022].includes(event.kind)) return;
    const id = event.tags.find(([key]) => key === "h")?.[1];
    if (!id || channels.queries.get?.(id)?.viewerRole !== "guest") return;
    // The relay permits a verified owner to edit/delete their agent's messages.
    const targets = event.tags.filter(([key]) => key === "e");
    if (
      (event.kind === 40003 || event.kind === 5) &&
      targets.length &&
      targets.every(([, target]) => {
        const original =
          local().find((item) => item.event.id === target)?.event ??
          recent.peek(target ?? "")?.event ??
          retainedEvent(target ?? "");
        return (
          original &&
          [9, 40002].includes(original.kind) &&
          original.tags.some(([key, value]) => key === "h" && value === id) &&
          profiles.queries.owner?.(
            messageAuthor(original, transport?.archiveAuthority),
          ) === transport?.viewer
        );
      })
    )
      return;
    throw new Error("You have read-only access to this channel.");
  }
  function validateMentionEvent(event: Pick<EventData, "kind" | "tags">) {
    if (event.kind !== 9) return;
    const recipients = event.tags.filter(([name]) => name === "p");
    if (!recipients.length) return;
    if (
      recipients.length > 32 ||
      recipients.some(
        (tag) => tag.length !== 2 || !/^[0-9a-f]{64}$/.test(tag[1] ?? ""),
      )
    )
      throw new Error("Invalid mention recipients");
    const destinations = event.tags.filter(([name]) => name === "h");
    if (destinations.length !== 1 || !destinations[0]?.[1])
      throw new Error("A channel is required");
    validateMentions(
      destinations[0][1],
      recipients.map((tag) => tag[1] ?? ""),
    );
  }
  async function prepareMentionPublication(
    event: RelayEvent,
    signal: AbortSignal,
  ) {
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    // A stream may have missed membership changes. Neither AUTH nor a cached
    // roster proves freshness; each attempt prepares outside the dispatch phase.
    const generation = liveGeneration;
    const epoch = accessEpoch;
    const cleared = cacheClearEpoch;
    try {
      await preflightMentions(event, signal);
    } catch (error) {
      throw new PublishRejected(
        error instanceof Error
          ? error.message
          : "Mention rejected before dispatch",
      );
    }
    return () => {
      if (
        closed ||
        generation !== liveGeneration ||
        epoch !== accessEpoch ||
        cleared !== cacheClearEpoch
      )
        throw new PublishRejected(
          "Channel membership changed during mention verification; retry",
        );
      try {
        validateMentionEvent(event);
      } catch (error) {
        throw new PublishRejected(
          error instanceof Error
            ? error.message
            : "Mention rejected before dispatch",
        );
      }
    };
  }
  async function preflightMentions(event: EventData, signal?: AbortSignal) {
    validateMentionEvent(event);
    if (event.kind !== 9 || !event.tags.some(([name]) => name === "p")) return;
    if (!transport) throw new Error("Relay is unavailable");
    const channelId = event.tags.find(([name]) => name === "h")?.[1];
    if (!channelId) throw new Error("A channel is required");
    const epoch = accessEpoch;
    const generation = liveGeneration;
    const cleared = cacheClearEpoch;
    const events = await requests.reader.read(
      [
        {
          kinds: [39002],
          consistency: "strong",
          authors: [transport.relayAuthor],
          "#d": [channelId],
          limit: 1,
        },
      ],
      { ...(signal ? { signal } : {}), priority: "foreground", fresh: true },
    );
    signal?.throwIfAborted();
    if (
      closed ||
      epoch !== accessEpoch ||
      generation !== liveGeneration ||
      cleared !== cacheClearEpoch
    )
      throw new Error(
        "Channel membership changed during mention verification; retry",
      );
    // Transport verifies signatures. Require positive evidence at this exact
    // authority/coordinate; an empty or failed read is unknown, never permission.
    const roster = events[0];
    const coordinates = roster?.tags.filter(([name]) => name === "d");
    if (
      events.length !== 1 ||
      !roster ||
      roster.kind !== 39002 ||
      roster.pubkey !== transport.relayAuthor ||
      !hasTag(roster, "d", channelId) ||
      coordinates?.length !== 1 ||
      coordinates[0]?.length !== 2
    )
      throw new Error(
        "Could not verify current channel membership; refresh and retry",
      );
    accept([roster]);
    validateMentionEvent(event); // A newer live removal beats an older read result.
    if (
      !hasTag(roster, "p", transport.viewer) ||
      event.tags.some(
        ([name, key]) => name === "p" && !hasTag(roster, "p", key ?? ""),
      )
    )
      throw new Error(
        "A selected recipient is no longer a channel member; remove them or refresh membership",
      );
  }
  const channelWrites = createChannelWrites(
    writes?.outbox,
    channels.queries,
    verified,
    lifetime.signal,
    writes?.local,
    async (id) => {
      if (!transport) return false;
      // Confirm only this viewer's exact creation receipt. Discovery may be
      // incomplete; this never admits the channel or grants content access.
      const events = await requests.reader.read(
        [
          {
            kinds: [9007],
            ids: [id],
            authors: [transport.viewer],
            limit: 1,
            consistency: "strong",
          },
        ],
        { signal: lifetime.signal, fresh: true },
      );
      return events.some(
        (event) =>
          event.id === id &&
          event.kind === 9007 &&
          event.pubkey === transport.viewer,
      );
    },
    {
      selectable: () =>
        agentChoices.snapshot().selectable.map((agent) => agent.pubkey),
      archived: (pubkey) =>
        archiveHides(archives.queries, pubkey, transport?.viewer),
    },
    transport?.relayAuthor,
    { read: (filters, settings) => readVerified(filters, settings, false) },
    transport?.channelIdentity === true,
  );
  startingChannel = (id) => channelWrites.starting(id);
  // Roster authority invalidates in-flight reads, including account-owned
  // preferences. Retry those once at the current epoch, never channel content
  // or a read cancelled by its caller/session/cache clear.
  const preferenceReader = {
    async read(filters: readonly ReadFilter[], settings?: ReadOptions) {
      const epoch = accessEpoch;
      const cleared = cacheClearEpoch;
      try {
        return await verified.read(filters, settings);
      } catch (error) {
        if (
          readErrorKind(error) !== "cancelled" ||
          lifetime.signal.aborted ||
          settings?.signal?.aborted ||
          epoch === accessEpoch ||
          cleared !== cacheClearEpoch ||
          !filters.every(
            (filter) =>
              filter.kinds?.length === 1 &&
              filter.kinds[0] === 30078 &&
              filter.authors?.length === 1 &&
              filter.authors[0] === transport?.viewer,
          )
        )
          throw error;
        return verified.read(filters, settings);
      }
    },
  };
  const channelKit = createChannelKit({
    host: transport?.channelKit,
    reader: preferenceReader,
    outbox: writes?.outbox,
    local: writes?.local,
    ready: writes?.ready,
    viewer: transport?.viewer ?? "",
    community: transport?.scope ?? "",
    signal: lifetime.signal,
    canWrite: (id) => !closed && channels.canWrite(id),
    canRead: (id) => !closed && channels.canParticipate(id),
    delivered: channelWrites.delivered,
  });
  const soloPreferences = createSoloPreferences(
    channelKit.capability,
    lifetime.signal,
  );
  const reminders =
    transport?.reminders && writer
      ? createReminders({
          viewer: transport.viewer,
          host: transport.reminders,
          query: (filters, signal) => transport.query(filters, signal),
          publish: (event, signal) => writer.publish(event, signal),
          signal: lifetime.signal,
        })
      : undefined;
  const mainAgent = (() => {
    const read = transport?.readMainAgent;
    const write = transport?.writeMainAgent;
    const clear = transport?.clearMainAgent;
    const bounded = (ms: number) =>
      AbortSignal.any([lifetime.signal, AbortSignal.timeout(ms)]);
    // One change at a time, so the last choice is the one confirmed.
    let writes = Promise.resolve();
    const queue = <T>(change: () => Promise<T>) => {
      const next = writes.then(change);
      writes = next.then(
        () => {},
        () => {},
      );
      return next;
    };
    return read && write
      ? Object.freeze({
          read: () => read(bounded(10_000)),
          write: (agent: string | null) =>
            queue(() => write(agent, bounded(20_000))),
          ...(clear
            ? {
                clear: (expected: string) =>
                  queue(() => clear(expected, bounded(20_000))),
              }
            : {}),
        })
      : undefined;
  })();
  const readPreferences = async (
    signal?: AbortSignal,
    consistency?: "strong",
  ) => {
    const decode = transport?.decodeSidebarPreferences;
    if (closed || !transport || !decode)
      throw new Error("Saved sidebar preferences are unavailable in this host");
    const combined = AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]);
    return readSidebarPreferences(
      preferenceReader,
      transport.viewer,
      decode,
      combined,
      consistency,
    );
  };
  const sidebarPreferences = createSidebarPreferencesStore({
    read: readPreferences,
    readAfterWrite: (signal) => readPreferences(signal, "strong"),
    available: !!transport?.decodeSidebarPreferences,
    write: (() => {
      const write = transport?.writeSidebarAssignment;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    writeStar: (() => {
      const write = transport?.writeSidebarStar;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    notify,
    writeMute: (() => {
      const write = transport?.writeSidebarMute;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    writeSort: (() => {
      const write = transport?.writeSidebarSort;
      return write
        ? (group, mode, sectionIds, signal) =>
            write(
              group,
              mode,
              sectionIds,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    persistence: options.persistence,
    removeSection: (() => {
      const write = transport?.removeSidebarSection;
      return write
        ? (sectionId, signal) =>
            write(
              sectionId,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    renameSection: (() => {
      const write = transport?.renameSidebarSection;
      return write
        ? (intent, signal) =>
            write(
              intent,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    writeOrder: (() => {
      const write = transport?.writeSidebarSectionOrder;
      return write
        ? (sectionIds, signal) =>
            write(
              sectionIds,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
            )
        : undefined;
    })(),
    writeFilter: (() => {
      const write = transport?.writeSidebarFilter;
      return write
        ? (group, mode, sectionIds, signal, activeWindowSeconds) =>
            write(
              group,
              mode,
              sectionIds,
              AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(20_000),
                signal,
              ]),
              activeWindowSeconds,
            )
        : undefined;
    })(),
  });
  let soloHead: string | undefined;
  const stopSoloGroups = channelKit.capability.subscribe(() => {
    const state = channelKit.capability.snapshot();
    if (state.status !== "ready") return;
    const nextSolo = soloGroups(state.entries)?.eventId;
    if (nextSolo !== soloHead) {
      soloHead = nextSolo;
      void soloPreferences.queries.refresh();
    }
  });
  type SetupNotice = Readonly<{ id: string; name: string; error: string }>;
  let setupNotices: readonly SetupNotice[] = [];
  const setupListeners = new Set<() => void>();
  const notifySetup = () =>
    setupListeners.forEach((listener) => {
      listener();
    });
  // Create's preflight has just read sidebar preferences. Placement re-reads
  // only once that read no longer stands (failed or cleared); another refresh
  // in flight leaves it writable. So placement normally projects before the
  // new channel first lists.
  const settledPreferences = async () => {
    if (!sidebarPreferences.queries.writable)
      await sidebarPreferences.queries.refresh();
  };
  const channelSetup =
    transport && writes && transport.channelKit
      ? createChannelSetup({
          scope: transportPartition(transport),
          outbox: writes.outbox,
          local: writes.local,
          signal: lifetime.signal,
          changed: notifySetup,
          create: (id, input, active) =>
            channelWrites.createChannel(
              id,
              input.name,
              input.visibility,
              input.description,
              input.ttlSeconds,
              active,
              { labels: input.labels, system: input.system },
            ),
          delivered: (id, active) =>
            channelWrites.delivered(
              id,
              active,
              false,
              !!active && !channelWrites.failed(id),
            ),
          confirm: async (id) => {
            await channelWrites.delivered(id, undefined, false, false);
            if (
              !(
                await verified.read(
                  [{ ids: [id], limit: 1, consistency: "strong" }],
                  { signal: lifetime.signal, fresh: true },
                )
              ).some((event) => event.id === id)
            )
              throw new Error("Setup is awaiting exact relay confirmation");
          },
          refresh: (id, member, input) =>
            channelWrites.refresh(id, { member, system: input.system }, false),
          canvasHead: async (id) => (await channelKit.canvas.read(id))?.id,
          async preflight(input) {
            if (
              !canonicalDetailsName(input.name) ||
              [...canonicalDetailsName(input.name)].length > 120 ||
              (input.description && [...input.description].length > 1000) ||
              !["open", "private"].includes(input.visibility) ||
              (input.ttlSeconds !== undefined &&
                (!Number.isInteger(input.ttlSeconds) ||
                  input.ttlSeconds <= 0 ||
                  input.ttlSeconds > 2_147_483_647))
            )
              throw new Error(
                "Check the channel name, description, privacy and duration before creating it",
              );
            if (!channelWrites.available)
              throw new Error("Channel creation is unavailable");
            const setup = input.setup;
            if (!setup) return;
            parseLineup({ ...setup, teamIds: [] });
            if (
              (setup.starred !== undefined &&
                typeof setup.starred !== "boolean") ||
              (setup.starred && !!setup.groupId) ||
              typeof setup.groupId !== "string" ||
              setup.groupId.length > 256 ||
              (setup.groupId !== "" && !setup.groupId.trim()) ||
              typeof setup.templateId !== "string" ||
              (setup.templateId !== "" &&
                !/^[a-zA-Z0-9_-]{1,128}$/.test(setup.templateId))
            )
              throw new Error("Invalid template or group selection");
            if (setup.canvas && !channelKit.canvas.available)
              throw new Error("Canvas writing is unavailable");
            if (setup.agents.length && !writes.outbox.supports(9000))
              throw new Error("Agent membership is unavailable");
            // These independent checks share the critical path, not a dependency.
            // Native teams never consume the legacy inventory as a fallback.
            await Promise.all([
              ...(setup.agents.length
                ? [agentChoices.refresh("templates")]
                : []),
              ...(setup.groupId || setup.starred
                ? [sidebarPreferences.queries.refresh()]
                : []),
            ]);
            lifetime.signal.throwIfAborted();
            if (setup.agents.length) {
              const choices = agentChoices.snapshot();
              if (choices.archives.status !== "ready")
                throw new Error(
                  "Agent archive state is unavailable; refresh before creating this lineup",
                );
              if (choices.templates.status !== "ready")
                throw new Error(
                  choices.templates.error ??
                    "Agent inventory is unavailable; refresh before creating this lineup",
                );
              // Re-read the shared selection after awaits; process status is not eligibility.
              const available = new Set(
                templateAgentChoices(choices, channels.queries.list()).map(
                  (a) => a.pubkey,
                ),
              );
              const unavailable = setup.agents.filter(
                (key) => !available.has(key),
              );
              if (unavailable.length)
                throw new Error(
                  `Selected agents are unavailable in this community: ${unavailable.map(npubEncode).join(", ")}. Refresh agents or remove them before creating the channel.`,
                );
            }
            if (setup.starred && !sidebarPreferences.queries.starWritable)
              throw new Error(
                "Starred placement is unavailable; refresh your sidebar before creating the channel",
              );
            if (setup.groupId) {
              const state = sidebarPreferences.queries.snapshot();
              if (
                !sidebarPreferences.queries.writable ||
                !state.data?.sections.some((g) => g.id === setup.groupId)
              )
                throw new Error(
                  "The destination group is unavailable; refresh your sidebar before creating the channel",
                );
            }
          },
          async star(id) {
            await settledPreferences();
            if (!sidebarPreferences.queries.starWritable)
              throw new Error(
                "Starred placement is unavailable; keep the partial channel and star it separately",
              );
            if (
              sidebarPreferences.queries.snapshot().data?.starred.includes(id)
            )
              return;
            await sidebarPreferences.queries.setStar(id, true);
          },
          async place(id, groupId) {
            await settledPreferences();
            const state = sidebarPreferences.queries.snapshot();
            if (
              !sidebarPreferences.queries.writable ||
              !state.data?.sections.some((g) => g.id === groupId)
            )
              throw new Error(
                "The destination group changed or is unavailable; keep the partial channel and choose its group separately",
              );
            if (state.data.assignments[id] === groupId) return;
            await sidebarPreferences.queries.assign(id, groupId);
          },
        })
      : undefined;
  // This session's last unconfirmed ordinary Create. Only an identical request
  // reuses it, so a retry cannot make a second channel; nothing restores it.
  let unconfirmed:
    | Readonly<{
        signature: string;
        id: string;
        operation: string;
        input: ChannelCreationInput;
      }>
    | undefined;
  const abandon = () => {
    const attempt = unconfirmed;
    unconfirmed = undefined;
    if (attempt) void writes?.outbox.dismiss(attempt.operation).catch(() => {});
  };
  const channelCreation = Object.freeze({
    available: channelWrites.available,
    subscribe: (listener: () => void) => {
      setupListeners.add(listener);
      return () => {
        setupListeners.delete(listener);
      };
    },
    notices: () => setupNotices,
    dismissNotice(id: string) {
      setupNotices = setupNotices.filter((item) => item.id !== id);
      notifySetup();
    },
    /** Drops an unconfirmed attempt once its form closes. */
    forget() {
      channelSetup?.forget();
      abandon();
    },
    async create(input: ChannelCreationInput) {
      input = { ...input, name: canonicalDetailsName(input.name) };
      if (!transport) throw new Error("The community connection changed.");
      // A relay without NIP-CL drops label tags and refuses system channels:
      // refuse before any new write. An identical attempt that was already
      // signed may still be retried below.
      const unsupported =
        (!!input.labels?.length || input.system === true) &&
        !transport.channelIdentity;
      await writes?.ready;
      if (channelSetup) {
        if (unsupported) throw channelIdentityUnsupported();
        const run = channelSetup.run(input, transport.viewer);
        let opened: string | undefined;
        void run.completion.catch((error) => {
          if (!opened || lifetime.signal.aborted) return;
          setupNotices = [
            ...setupNotices,
            { id: opened, name: input.name, error: String(error) },
          ];
          notifySetup();
        });
        opened = await run.admission;
        return opened;
      }
      if (setupWork(input.setup))
        throw new Error("Template setup is unavailable on this host");
      const normalized: ChannelCreationInput = {
        name: input.name,
        visibility: input.visibility,
        ...(input.description?.trim()
          ? { description: input.description.trim() }
          : {}),
        ...(input.ttlSeconds !== undefined
          ? { ttlSeconds: input.ttlSeconds }
          : {}),
        ...(input.labels?.length
          ? { labels: Object.freeze([...new Set(input.labels)]) }
          : {}),
        ...(input.system ? { system: true as const } : {}),
      };
      const signature = JSON.stringify(normalized);
      if (unconfirmed?.signature !== signature) {
        abandon();
        if (unsupported) throw channelIdentityUnsupported();
        const id = crypto.randomUUID();
        unconfirmed = {
          signature,
          id,
          input: Object.freeze(normalized),
          operation: channelWrites.createChannel(
            id,
            normalized.name,
            normalized.visibility,
            normalized.description,
            normalized.ttlSeconds,
            undefined,
            { labels: normalized.labels, system: normalized.system },
          ),
        };
      }
      const pending = unconfirmed;
      try {
        await channelWrites.delivered(
          pending.operation,
          () => !lifetime.signal.aborted,
          false,
          !channelWrites.failed(pending.operation),
        );
        await channelWrites.refresh(
          pending.id,
          { member: transport.viewer, system: pending.input.system },
          false,
        );
        await writes?.outbox.dismiss(pending.operation);
        if (unconfirmed === pending) unconfirmed = undefined;
        return pending.id;
      } catch (error) {
        if (channelWrites.failed(pending.operation)) {
          await channelWrites.discardFailed(pending.operation);
          if (unconfirmed === pending) unconfirmed = undefined;
        }
        throw error;
      }
    },
  });
  // A Solo chat admits people under its share rule; agents join by mention.
  const solo = (channelId: string) =>
    (
      session.channels.list().channels.find((item) => item.id === channelId) ??
      session.channels.get?.(channelId)
    )?.channelType === "solo";
  const memberAdditions = createMemberAdditions(
    lifetime.signal,
    async (channelId, pubkey, intent): Promise<void> => {
      await addChannelMember(
        session,
        channelId,
        pubkey,
        lifetime.signal,
        intent,
        writes?.local,
        solo(channelId),
      );
    },
    writes?.local,
    (channelId, pubkeys, intents) =>
      addChannelMembersAtOnce(
        session,
        channelId,
        pubkeys,
        intents,
        lifetime.signal,
        solo(channelId),
        undefined,
        writes?.local,
      ),
  );
  const recoverable = (
    subscribe: (listener: () => void) => () => void,
    status: () => RecoveryStatus,
    retry: () => void,
    reauthorize?: () => void,
  ): RecoverySource =>
    Object.freeze({
      subscribe,
      status,
      retry,
      ...(reauthorize ? { reauthorize } : {}),
    });
  // Background reads only. A failed read always retries; see recovery.ts.
  // The live source also owns the channel roster and suspended public
  // previews (live.retry retries both).
  const liveRecovery = recoverable(
    live.subscribe,
    () => liveRecoveryStatus(live.snapshot()),
    live.retry,
  );
  const recovery = transport
    ? createRecovery([
        liveRecovery,
        recoverable(
          channelKit.capability.subscribe,
          () => loadState(channelKit.capability.snapshot()),
          () => void channelKit.capability.refresh(),
          // A ready catalog may be revalidating under the old credentials.
          () => void channelKit.capability.refresh({ after: true }),
        ),
        recoverable(
          soloPreferences.queries.subscribe,
          () => loadState(soloPreferences.queries.snapshot()),
          () => void soloPreferences.queries.refresh(),
        ),
        recoverable(
          sidebarPreferences.queries.subscribe,
          () => loadState(sidebarPreferences.queries.snapshot()),
          () => void sidebarPreferences.queries.refresh(),
        ),
        // Visibility owns its quiet retries and exhausts without `transient`,
        // so this source only reports `busy`; its retry is not reached.
        recoverable(
          lifecycle.capability.subscribe,
          () => loadState(lifecycle.capability.snapshot()),
          () => void lifecycle.capability.refreshVisibility(),
        ),
      ])
    : undefined;
  // A live stream that connects again proves the relay answers: retry the
  // other failed reads now instead of waiting out their delay.
  let liveWasConnected = liveView.status === "connected";
  const stopLiveRecovery = live.subscribe(() => {
    const connected = live.snapshot().status === "connected";
    // The live layer owns its own reconnect recovery; retry the rest.
    if (connected && !liveWasConnected) recovery?.retryNow(liveRecovery);
    liveWasConnected = connected;
  });
  const session = Object.freeze({
    artifactIncremental: transport?.artifactIncremental,
    memberAdditions,
    presence,
    viewer: transport?.viewer,
    relayAuthor: transport?.relayAuthor,
    /** NIP-AP config artifacts: the relay's own verified answer, never merged
     * with live or local outgoing events or fed to any projection, and a
     * kind-45010 writer when the host has one. Each read starts fresh. */
    snapshotRead: transport
      ? (((filters, { signal }) =>
          relayRead(
            filters,
            signal ? { signal, fresh: true } : { fresh: true },
          )) satisfies SnapshotRead)
      : undefined,
    configArtifactWriter: transport?.configArtifacts,
    workflowAuthority: transport?.archiveAuthority,
    authorizeAgentLog: transport?.authorizeAgentLog,
    authorizeGit: transport?.authorizeGit,
    scope: readScope,
    /** Verified new live-route messages, after reconciliation. Never history or local intent. */
    subscribeIncoming(listener: IncomingListener) {
      if (closed) return () => {};
      incomingListeners.add(listener);
      return () => {
        incomingListeners.delete(listener);
      };
    },
    /** Keeps `channelIds` in the live routes while attended, for agents'
     * watches: a readable public channel the viewer has not joined too, whose
     * metadata is read first when unknown. It is not joined, listed or counted
     * unread, as an opened preview is not. Its events reach `subscribeLive`.
     * The live owner admits it after joined and opened channels; past its
     * capacity, it gets finite reads only. */
    attend(channelIds: readonly string[]): () => void {
      if (closed) return () => {};
      const ids = [
        ...new Set(
          channelIds.filter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id)),
        ),
      ];
      // Unread or refused before, it is read again, and soon.
      for (const id of ids) attendChecked.delete(id);
      attendDelay = ATTEND_RETRY_MS;
      attended.add(ids);
      updateInterests();
      return () => {
        if (attended.delete(ids)) updateInterests();
      };
    },
    /** Whether the session does not know `channelId`: a read of the channel
     * returns none of its events. True of a channel not attended yet, so a
     * read that runs before its `attend` waits for it as well, and of one
     * whose metadata read found nothing the viewer may read, until a later
     * read finds it. */
    attendPending(channelId: string): boolean {
      const channel = channels.queries.get?.(channelId);
      return !channel || !!channel.pending;
    },
    /** Whether an event of `channelId` reaches agents as it would with no
     * `attend` and no `resolveChannels` read: not from a channel the session
     * knows only from agents' lookups, nor, heard `live`, one the live routes
     * carry only because it is attended. */
    unattended(channelId: string, live: boolean): boolean {
      if (viewerLive.has(channelId)) return true;
      if (learnedForAgents.has(channelId)) return false;
      return !live || ![...attended].some((ids) => ids.includes(channelId));
    },
    /** Verified, access-filtered live-phase events of any kind, after reconciliation.
     * Never finite reads or local intent, except the viewer's own messages in
     * a Solo chat this device is starting: those arrive here before the relay
     * has them, and their echo follows (see `hearStarting`). Replay only with
     * `replay`: the
     * recent history each subscription sends again before it goes live, as after
     * a reconnect, marked `replay` on its batch. Includes the viewer's own echoes.
     * Overlapping routes and replays can deliver one event more than once;
     * listeners dedupe by id. */
    subscribeLive(listener: LiveListener, options?: { replay?: boolean }) {
      if (closed) return () => {};
      const listeners = options?.replay ? replayListeners : liveEventListeners;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    typing: {
      ...typing.capability,
      async send(
        channelId: string,
        threadRootId: string | undefined,
        signal: AbortSignal,
      ) {
        const available = () =>
          !closed &&
          !signal.aborted &&
          liveSnapshot.status === "connected" &&
          channels.canWrite(channelId) &&
          channels.queries
            .list()
            .channels.some(
              (channel) =>
                channel.id === channelId &&
                !channel.readOnly &&
                !channel.archived &&
                !channel.cached,
            );
        const publish = traffic?.publishTyping ?? traffic?.publish;
        if (!writer || !publish || !available()) return;
        const template = {
          kind: 20002,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["h", channelId],
            ...(threadRootId !== undefined
              ? [["e", threadRootId, "", "reply"]]
              : []),
          ],
        };
        if (!validTypingTemplate(template)) return;
        const epoch = accessEpoch,
          generation = liveGeneration;
        // A pulse waiting for signing or socket admission quickly becomes stale.
        const bounded = AbortSignal.any([
          signal,
          lifetime.signal,
          AbortSignal.timeout(1_000),
        ]);
        const event = await writer.sign(template, bounded);
        if (
          bounded.aborted ||
          !available() ||
          epoch !== accessEpoch ||
          generation !== liveGeneration
        )
          return;
        if (
          !validTypingTemplate(event) ||
          event.pubkey !== transport?.viewer ||
          event.created_at !== template.created_at ||
          JSON.stringify(event.tags) !== JSON.stringify(template.tags)
        )
          return;
        await publish(event, bounded);
      },
    },
    /** Says the viewer's `agents` are online or offline, on the live socket:
     * ephemeral, so nothing is queued or retried. The relay keeps only the
     * agents the viewer owns. False when this session can never send it. */
    async publishAgentPresence(
      status: "online" | "offline",
      agents: readonly string[],
      signal: AbortSignal,
    ) {
      if (!writer || !traffic?.publish) return false;
      if (closed) throw new Error("Agent presence needs a live connection");
      const event = await writer.sign(
        {
          kind: 20003,
          content: status,
          tags: agents.map((agent) => ["p", agent]),
          created_at: Math.floor(Date.now() / 1000),
        },
        signal,
      );
      await traffic.publish(event, signal);
      return true;
    },
    channelCreation,
    channelKit: channelKit.capability,
    canvas: channelKit.canvas,
    channelWrites,
    directMessages: createDirectMessages(
      transport,
      verified,
      channels.queries,
      writes?.outbox,
      writes?.local,
      lifetime.signal,
      {
        read: (filters, settings) =>
          directoryRead(settings, () =>
            requests.reader.read(filters, settings),
          ),
        ...(nameSearch
          ? {
              searchProfiles: (query, limit, page, settings) =>
                directoryRead(settings, () =>
                  nameSearch(query, limit, page, settings),
                ),
            }
          : {}),
      },
      searchProfiles,
      () => profiles.queries.verifiedAuthority?.(),
    ),
    unread: unread.capability,
    sidebarPreferences: sidebarPreferences.queries,
    /** The account's saved main agent, shared by every install. */
    mainAgent,
    soloPreferences: soloPreferences.queries,
    reminders: reminders?.capability,
    live,
    /** The one automatic retry owner for background reads. Undefined offline. */
    recovery,
    profiling,
    attachments:
      uploadAttachment && writes?.outbox.supports(9)
        ? Object.freeze({
            async upload(
              file: File,
              channelId: string,
              signal: AbortSignal,
              progress?: UploadProgress,
            ) {
              const combined = AbortSignal.any([
                signal,
                lifetime.signal,
                uploadLifetime.signal,
              ]);
              combined.throwIfAborted();
              if (!channelId || closed || !channels.canWrite(channelId))
                throw new UploadError("denied");
              const result = await uploadAttachment(file, combined, progress);
              combined.throwIfAborted();
              if (!channels.canWrite(channelId))
                throw new UploadError("denied");
              return result;
            },
            // A chat being started has no channel to check yet. Media access is
            // community-wide, not channel-scoped; its first send stays guarded.
            ...(writes.outbox.supports(9007)
              ? {
                  async uploadForNewChat(
                    file: File,
                    signal: AbortSignal,
                    progress?: UploadProgress,
                  ) {
                    const combined = AbortSignal.any([
                      signal,
                      lifetime.signal,
                      uploadLifetime.signal,
                    ]);
                    combined.throwIfAborted();
                    if (closed) throw new UploadError("denied");
                    const result = await uploadAttachment(
                      file,
                      combined,
                      progress,
                    );
                    combined.throwIfAborted();
                    if (closed) throw new UploadError("denied");
                    return result;
                  },
                }
              : {}),
          })
        : undefined,
    // Feedback text is private to the operator inbox; uploaded files retain
    // ordinary community-media access, matching Desktop's attachment path.
    feedbackUpload:
      uploadAttachment &&
      writes?.outbox.supports(PRODUCT_FEEDBACK_KIND) &&
      transport?.scope
        ? Object.freeze({
            origin: transport.scope,
            async upload(
              file: File,
              signal: AbortSignal,
            ): Promise<UploadedAttachment> {
              const combined = AbortSignal.any([signal, lifetime.signal]);
              combined.throwIfAborted();
              if (closed) throw new UploadError("denied");
              const result = await uploadAttachment(file, combined);
              combined.throwIfAborted();
              if (closed) throw new UploadError("denied");
              return result;
            },
          })
        : undefined,
    messages: Object.freeze({
      ...createMessages(
        writes?.outbox,
        transport?.viewer,
        (id) =>
          local().find((item) => item.event.id === id)?.event ??
          recent.peek(id)?.event ??
          retainedEvent(id),
        emoji.tags,
        validateMentions,
        (id, owner) =>
          !closed &&
          (channels.canWrite(id) ||
            // editOwnedAgent and messages.remove supply owner evidence;
            // validateChannelWrite rechecks it before signing and publication.
            (!!owner && channels.canParticipate(id))),
        transport?.scope,
        writer && (!writer.kinds || writer.kinds.includes(1984))
          ? async (template) => {
              if (closed) throw new Error("Relay session closed");
              const signal = AbortSignal.any([
                lifetime.signal,
                AbortSignal.timeout(10_000),
              ]);
              // Race each step so the deadline holds even if the writer ignores `signal`.
              const aborted = new Promise<never>((_, reject) => {
                const fail = () => reject(signal.reason);
                if (signal.aborted) fail();
                else signal.addEventListener("abort", fail, { once: true });
              });
              const signed = await Promise.race([
                writer.sign(template, signal),
                aborted,
              ]);
              signal.throwIfAborted();
              await Promise.race([writer.publish(signed, signal), aborted]);
            }
          : undefined,
        transport?.archiveAuthority,
        profiles.queries,
        (channelId) => {
          const channel = channels.queries
            .list()
            .channels.find((item) => item.id === channelId);
          return channel?.channelType === "dm" &&
            channel.members?.length === 2 &&
            transport?.viewer &&
            channel.members.includes(transport.viewer)
            ? channel.members.filter((key) => key !== transport.viewer)
            : [];
        },
        (id) => [
          ...new Map(
            [
              ...local().map((item) => item.event),
              ...recent.entries().map(([, item]) => item.event),
              ...retainedThreadEvents(),
              ...retainedChannelEvents(),
            ]
              .filter((event) =>
                event.tags.some(
                  ([name, value]) => name === "buzz:copy-of" && value === id,
                ),
              )
              .map((event) => [event.id, event]),
          ).values(),
        ],
      ),
      /** UI eligibility only; signing/publication recheck the same role proof. */
      canRetry(event: Pick<EventData, "kind" | "tags">) {
        const id = event.tags.find(([key]) => key === "h")?.[1];
        const channel = channels.queries
          .list()
          .channels.find((item) => item.id === id);
        if (
          closed ||
          !channel ||
          channel.archived ||
          channel.cached ||
          !channels.canParticipate(channel.id)
        )
          return false;
        try {
          validateChannelWrite(event);
          return true;
        } catch {
          return false;
        }
      },
    }),
    /** An owned bounded thread reader. Dispose on close; the session retains access/lifetime authority. */
    thread(
      channelId: string,
      messageId: string,
      options?: { exact?: boolean; priority?: Priority },
    ) {
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      if (!/^[0-9a-f]{64}$/.test(messageId))
        throw new Error("Thread needs a valid message ID");
      // Exact selection is available to an existing ordinary thread too; its
      // raw evidence keeps the same access, cap and atomic-admission checks.
      const targetReader: RelayReader = {
        async read(filters, settings) {
          if (!canReadRemote(channelId))
            throw new ReadError(
              "unavailable",
              "Reconnect to refresh conversation access.",
            );
          const epoch = accessEpoch;
          let events: readonly RelayEvent[];
          try {
            events = await requests.reader.read(filters, settings);
          } catch (error) {
            if (
              !closed &&
              epoch === accessEpoch &&
              readErrorKind(error) === "denied"
            )
              channels.denyChannel(channelId, error);
            throw error;
          }
          if (closed || epoch !== accessEpoch || !canReadRemote(channelId))
            throw new DOMException("Stale thread target", "AbortError");
          settings?.signal?.throwIfAborted();
          // A capped raw target/overlay read cannot establish a safe fold.
          if (
            !filters.some((filter) => filter.depth_limit) &&
            events.length >= 500
          )
            throw new Error("Selected message exceeded its evidence limit");
          // The thread owner admits the complete target fold atomically.
          return events.filter((event) => event.kind !== PRODUCT_FEEDBACK_KIND);
        },
      };
      const thread = createThreadView({
        channelId,
        messageId,
        relayAuthor: transport?.relayAuthor ?? "",
        signingAuthority: transport?.archiveAuthority,
        agentOwner: profiles.queries.owner,
        reader: options?.exact ? targetReader : verified,
        targetReader,
        admitTarget: (events) => accept(events, false),
        exact: options?.exact ?? false,
        priority: options?.priority,
        admit: options?.exact ? (events) => accept(events, false) : undefined,
        seed: recent.peek(messageId)?.event ?? retainedEvent(messageId),
        local: localViews,
        clock,
        canAccess: () => !closed && canAccess(channelId),
        canRefresh: () => !closed && canReadRemote(channelId),
        visible: (events) => events.filter(visibility(events)),
        notify,
        dropped: streamDropped,
      });
      threads.add(thread);
      thread.receive(recent.entries().map(([, item]) => item.event));
      observations.add(thread.receive);
      const unsubscribe = localViews?.subscribe(thread.localChanged);
      const unsubscribeOwner = profiles.queries.subscribe(thread.ownersChanged);
      const dispose = () => {
        thread.view.dispose();
        unsubscribe?.();
        unsubscribeOwner();
        observations.delete(thread.receive);
        threads.delete(thread);
        views.delete(dispose);
      };
      views.set(dispose, thread.purge);
      return { ...thread.view, dispose };
    },
    channels: channelQueries,
    names: identityNames,
    profiles: profiles.queries,
    emoji: emoji.queries,
    statuses: statuses.queries,
    agentLibrary: agentLibrary.queries,
    agentChoices,
    inboxFeed,
    workflows: workflows.capability,
    repositories,
    projectGit: transport?.projectGit
      ? {
          async read(input: GitRead, signal: AbortSignal) {
            const bound = AbortSignal.any([signal, lifetime.signal]);
            bound.throwIfAborted();
            const host = transport.projectGit;
            if (!host) throw new Error("Repository reads unavailable");
            const result = await host.read(input, bound);
            bound.throwIfAborted();
            return result;
          },
        }
      : undefined,
    channelLifecycle: lifecycle.capability,
    channelDetails: details.capability,
    memberAdministration: memberAdministration.capability,
    agentActivity: activity.queries,
    agentMemories: memories.capability,
    archives: archives.queries,
    media: (url: string, size?: "small") => transport?.media(url, size),
    /** A plugin may request writes from this same interface when the host supports them. */
    outbox: writes?.outbox,
    /** People by profile name only; see `createProfileSearch`. */
    searchProfiles: (query: string, settings: ProfileSearchOptions) =>
      finiteRead(undefined, settings, (signal) =>
        searchProfiles(query, { ...settings, signal }),
      ),
    /** A fresh verified remote page under the normal access guards, without
     * merging live observations or local outbox intent into paging evidence. */
    async readRemote(filters: readonly ReadFilter[], settings?: ReadOptions) {
      const epoch = accessEpoch;
      const signal = settings?.signal
        ? AbortSignal.any([settings.signal, lifetime.signal])
        : lifetime.signal;
      signal.throwIfAborted();
      const result = await finiteRead(
        filters,
        { ...settings, signal },
        (signal) => readVerified(filters, { ...settings, signal, fresh: true }),
      );
      signal.throwIfAborted();
      // Applying discovery can revoke access itself. As with read(), let
      // authority-only reads finish; mixed/content reads must remain fenced.
      const discoveryOnly =
        filters.length > 0 &&
        filters.every(
          (filter) =>
            !!filter.kinds?.length &&
            filter.kinds.every((kind) => [39000, 39002].includes(kind)),
        );
      if (closed || (epoch !== accessEpoch && !discoveryOnly))
        throw new DOMException("Stale relay read", "AbortError");
      return result;
    },
    async read(filters: readonly ReadFilter[], settings?: ReadOptions) {
      return (await session.readPage(filters, settings)).events;
    },
    /** Transport-page count precedes visibility filtering and local/live projection. */
    async readPage(
      filters: readonly ReadFilter[],
      settings?: ReadOptions,
    ): Promise<{ events: readonly VisibleEvent[]; relayCount: number }> {
      const began = revision;
      const epoch = accessEpoch;
      const cleared = cacheClearEpoch;
      const { events: result, relayCount } = await finiteRead(
        filters,
        settings,
        (signal) =>
          readVerified(filters, { ...settings, signal }, true, undefined, {
            withRelayCount: true,
          }),
      );
      // Applying discovery can itself revoke access. Let that authority-only
      // read, or a profile read, finish under current visibility;
      // content/search completions must still be fenced, including mixed
      // discovery + content requests.
      const discoveryOnly =
        filters.length > 0 &&
        filters.every(
          (filter) =>
            !!filter.kinds?.length &&
            filter.kinds.every((kind) => [39000, 39002].includes(kind)),
        );
      if (
        closed ||
        (epoch !== accessEpoch &&
          !discoveryOnly &&
          !profileReadSurvives(filters, cleared))
      )
        throw new DOMException("Stale relay read", "AbortError");
      const merged = new Map(result.map((event) => [event.id, event]));
      for (const [id, observation] of recent.entries()) {
        if (
          observation.revision > began &&
          filters.some((filter) => matchesEvent(observation.event, filter))
        )
          merged.set(id, observation.event);
      }
      const events = [...merged.values()];
      return {
        events: projectEvents(
          events.filter(visibility(events)),
          local(),
          filters,
        ),
        relayCount,
      };
    },
    /** Whether read() search filters may ask for `search_sort: "newest"`. */
    searchSort: transport?.searchSort === true,
    /** NIP-AR sync: an exact, kept-current set of current artifacts for a
     * filter that names its channels with `#h`. Status `unsupported` means
     * this relay has no sync; use read() with `artifact: "current"` instead.
     * Dispose with the plugin's scope. */
    artifacts: {
      sync(filter: unknown): ArtifactSyncView {
        if (closed || artifactSyncs.size >= ARTIFACT_SYNC_MAX_VIEWS)
          throw new Error("Artifact sync capacity unavailable");
        const view = createArtifactSyncView(
          filter,
          transport?.artifactSync && transport.subscribe
            ? (input, sink) => {
                // Live traffic can start after the plugin asks; retry until it does.
                if (traffic?.syncArtifacts)
                  return traffic.syncArtifacts(input, sink);
                queueMicrotask(() =>
                  sink.closed(
                    closed
                      ? "unsupported: relay session disposed"
                      : "disconnected: live connection not started",
                  ),
                );
                return () => {};
              }
            : undefined,
          Math.random,
          notify,
        );
        artifactSyncs.add(view);
        return {
          snapshot: view.snapshot,
          subscribe: view.subscribe,
          dispose() {
            artifactSyncs.delete(view);
            view.dispose();
          },
        };
      },
      /** Where there is no sync: each revision (45010) in `channelIds`, and
       * their relay-signed metadata and roster, which stay in the live routes
       * while followed, system channels too.
       * Replay included, so one saved while a route comes up still arrives.
       * Never a complete set; finite reads own catch-up. `revoked` hears the
       * followed channels an accepted access change took away, whose own
       * metadata and roster are no longer delivered. */
      follow(
        channelIds: readonly string[],
        listener: (events: readonly RelayEvent[]) => void,
        revoked?: (channelIds: readonly string[]) => void,
      ): () => void {
        if (closed) return () => {};
        const ids = [...new Set(channelIds)];
        const wanted = new Set(ids);
        const live: LiveListener = ({ events }) => {
          const matching = events.filter((event) =>
            // Its relay-signed metadata and roster too: an archive or a
            // removal ends what its config may be used for.
            event.kind === 39000 || event.kind === 39002
              ? event.pubkey === transport?.relayAuthor &&
                event.tags.some(
                  ([name, value]) => name === "d" && wanted.has(value ?? ""),
                )
              : event.kind === ARTIFACT_REVISION_KIND &&
                event.tags.some(
                  ([name, value]) => name === "h" && wanted.has(value ?? ""),
                ),
          );
          if (matching.length) listener(matching);
        };
        const lost = () => {
          const gone = ids.filter((id) => !canAccess(id));
          if (!gone.length) return;
          try {
            revoked?.(gone);
          } catch (error) {
            console.error("Follow revocation listener failed", error);
          }
        };
        followed.add(ids);
        replayListeners.add(live);
        followRevocations.add(lost);
        updateInterests();
        return () => {
          followed.delete(ids);
          replayListeners.delete(live);
          followRevocations.delete(lost);
          updateInterests();
        };
      },
    },
    /** An owned retained event view, not a replacement query snapshot. Limits bound
     * requests, not retained results. Ranked search/feed filters require read().
     * Subscribe, refresh and dispose with the plugin's scope. */
    observe(input: readonly ReadFilter[]) {
      if (
        input.some(
          (filter) =>
            filter.search !== undefined || filter.feed_types !== undefined,
        )
      )
        throw new Error(
          "Observed views do not support ranked search/feed filters; use session.read() instead",
        );
      if (closed || views.size >= 64)
        throw new Error("Relay view capacity unavailable");
      const filters: readonly ReadFilter[] = JSON.parse(JSON.stringify(input));
      let remote: readonly RelayEvent[] = retainEvents(
        recent.entries().flatMap(([, { event }]) => {
          return filters.some((filter) => matchesEvent(event, filter))
            ? [event]
            : [];
        }),
      );
      remote = remote.filter(visibility(remote));
      let snapshot: EventViewSnapshot = Object.freeze({
        status: "idle",
        events: projectEvents(remote, local(), filters),
      });
      let controller: AbortController | undefined;
      let disposed = false;
      const listeners = new Set<() => void>();
      const update = (patch: Partial<EventViewSnapshot> = {}) => {
        if (disposed) return;
        remote = remote.filter(visibility(remote));
        const events = projectEvents(remote, local(), filters, snapshot.events);
        const next = { ...snapshot, ...patch, events };
        if (
          next.events === snapshot.events &&
          next.status === snapshot.status &&
          next.error === snapshot.error
        )
          return;
        snapshot = Object.freeze(next);
        for (const listener of listeners) notify(listener);
      };
      const receive = (incoming: readonly RelayEvent[]) => {
        const matching = incoming.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
        if (!matching.length) {
          update();
          return;
        }
        const merged = new Map(remote.map((event) => [event.id, event]));
        for (const event of matching) merged.set(event.id, event);
        // Each owned view retains its own bounded evidence, independently of shared-cache eviction.
        remote = retainEvents([...merged.values()]);
        update();
      };
      observations.add(receive);
      const unsubscribe = writes?.local.subscribe(() => update());
      const dispose = () => {
        disposed = true;
        controller?.abort();
        unsubscribe?.();
        observations.delete(receive);
        listeners.clear();
        views.delete(dispose);
        refreshers.delete(view.refresh);
      };
      views.set(dispose, (clear = false) => {
        controller?.abort();
        controller = undefined;
        const visible = visibility(remote);
        remote = clear ? [] : remote.filter(visible);
        update({ status: "idle", error: undefined });
      });
      const view = {
        snapshot: () => snapshot,
        subscribe(listener: () => void) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async refresh() {
          if (disposed || closed || controller) return;
          const owned = new AbortController();
          controller = owned;
          update({ status: "loading", error: undefined });
          try {
            const events = await finiteRead(
              filters,
              { signal: owned.signal },
              (signal) => verified.read(filters, { signal }),
            );
            if (disposed || owned.signal.aborted) return;
            remote = retainEvents([...events, ...remote]);
            update({ status: "ready" });
          } catch (error) {
            if (!disposed && !owned.signal.aborted)
              update({ status: "error", error: String(error) });
          } finally {
            if (controller === owned) controller = undefined;
          }
        },
        dispose,
      };
      refreshers.add(view.refresh);
      return view;
    },
  });
  function revalidatePreviews(ids: readonly string[]) {
    if (!channels.queries.resolve) return;
    for (let start = 0; start < ids.length; start += 128) {
      previewChecks++;
      void channels.queries
        .resolve(ids.slice(start, start + 128), { signal: lifetime.signal })
        // A failed/cancelled lookup stays suspended until fresh signed
        // metadata arrives. Session recovery retries it; it is not a denial.
        .catch(() => {})
        .finally(() => {
          previewChecks--;
          publishLive();
        });
    }
    if (ids.length) publishLive();
  }
  /** Named member-added hints awaiting one exact read, the confirmation in
   * flight for each channel, and whether the running full pass inherited grants
   * from confirmations it superseded. Transports deliver one event per call, so
   * hints coalesce across deliveries until the next timer turn; a channel whose
   * confirmation is still pending is not read again, because resolve never
   * merges its fresh reads. */
  const hintQueue = new Set<string>();
  const hintReads = new Map<string, AbortController>();
  let rosterOwesGrants = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let rosterTimer: ReturnType<typeof setTimeout> | undefined;
  let strongRosterRefresh = false;
  function refreshRoster(strong = false) {
    if (closed) return;
    strongRosterRefresh ||= strong || hintQueue.size > 0 || hintReads.size > 0;
    // The full pass covers every grant still waiting for its exact read.
    rosterOwesGrants ||= hintQueue.size > 0;
    hintQueue.clear();
    if (rosterTimer) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      rosterTimer = undefined;
      const consistency = strongRosterRefresh
        ? { consistency: "strong" as const }
        : {};
      strongRosterRefresh = false;
      if (!closed) channels.queries.refreshList?.(consistency);
    }, 0);
    rosterTimer = timer;
    timers.add(timer);
  }
  const held = (id: string) => {
    const summary = channels.queries.get?.(id);
    return !!summary && !summary.cached && channels.canParticipate(id);
  };
  /** Retire every queued and in-flight exact confirmation. Retirement is
   * intentional, so unlike a failed lookup it schedules no fallback; the
   * superseding full pass, establishment or Retry owns recovery. */
  function retireHintConfirmations() {
    hintQueue.clear();
    for (const controller of new Set(hintReads.values())) controller.abort();
    hintReads.clear();
  }
  /** A cache clear, a disconnect or a list that leaves ready drops hints with
   * the rest of the session's reader work, before a queued batch's timer can
   * dispatch it into the new epoch. Transfer their writer requirement to the
   * store without scheduling work: a ready commit must not hide a failed
   * discovery, and the next establishment's full pass or Retry owns recovery. */
  function dropHintConfirmations() {
    if (hintQueue.size > 0 || hintReads.size > 0)
      channels.requireStrongListRead();
    rosterOwesGrants = false;
    retireHintConfirmations();
  }
  /** A full pass that starts after an exact read was issued supersedes that
   * confirmation: a delayed grant must not land on a roster a newer complete
   * read already settled. The pass inherits the grants it retired. A verified
   * roster settles them and a failed one keeps its error for deliberate Retry,
   * but a pass interrupted by a concurrent revocation ends deferred having
   * settled nothing, so it reruns instead of leaving those grants to Retry,
   * another hint or a reconnect. */
  function settleHintConfirmations(strong = false) {
    const { state } = channels.roster();
    if (state === "pending") {
      rosterOwesGrants ||= hintQueue.size > 0 || hintReads.size > 0;
      retireHintConfirmations();
      // A replica pass cannot settle the writer-backed confirmations it retired.
      if (rosterOwesGrants && !strong) refreshRoster(true);
    } else if (state === "deferred" && rosterOwesGrants) refreshRoster(true);
    else rosterOwesGrants = false;
  }
  const stopHintGuard = channels.queries.subscribeList(() => {
    if (channels.queries.list().status !== "ready") dropHintConfirmations();
  });
  function confirmMembershipHints(hints: readonly RelayEvent[]) {
    for (const hint of hints) {
      const destinations = hint.tags.filter(([name]) => name === "h");
      const id = destinations[0]?.[1];
      // Held channels include unarchive/re-add hints; resolve skips them.
      // An exact lookup may extend a ready list, never certify initial discovery.
      // A full pass already scheduled covers every grant in the same burst.
      if (
        hint.kind !== 44100 ||
        destinations.length !== 1 ||
        !id ||
        rosterTimer !== undefined ||
        channels.queries.list().status !== "ready" ||
        held(id)
      ) {
        refreshRoster(true);
        return;
      }
      hintQueue.add(id);
    }
    if (!hintQueue.size || hintTimer) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      hintTimer = undefined;
      confirmQueuedHints();
    }, 0);
    hintTimer = timer;
    timers.add(timer);
  }
  function confirmQueuedHints() {
    const wanted = [...hintQueue].filter((id) => !hintReads.has(id));
    hintQueue.clear();
    if (closed || !wanted.length) return;
    if (channels.queries.list().status !== "ready") {
      refreshRoster(true);
      return;
    }
    const cleared = cacheClearEpoch;
    const generation = liveGeneration;
    const current = () =>
      !closed && cleared === cacheClearEpoch && generation === liveGeneration;
    for (let start = 0; start < wanted.length; start += 128) {
      const batch = wanted.slice(start, start + 128);
      const controller = new AbortController();
      for (const id of batch) hintReads.set(id, controller);
      // Only a genuine lookup failure or a channel still not held falls back to
      // the full pass. A retired confirmation was superseded on purpose.
      const intact = () => current() && !controller.signal.aborted;
      void (
        channels.queries.resolve?.(batch, {
          consistency: "strong",
          signal: AbortSignal.any([lifetime.signal, controller.signal]),
        }) ?? Promise.resolve()
      )
        .then(() => {
          if (intact() && !batch.every(held)) refreshRoster(true);
        })
        .catch(() => {
          if (intact()) refreshRoster(true);
        })
        .finally(() => {
          for (const id of batch)
            if (hintReads.get(id) === controller) hintReads.delete(id);
          if (current()) publishLive();
        });
    }
  }
  const updateInterests = () => {
    if (closed) return;
    // A chat still starting has no membership on the relay yet, which would
    // refuse its live tail; it subscribes once the relay confirms it.
    const joined = [
      ...channels.queries
        .list()
        .channels.filter((channel) => !channel.cached && !channel.pending)
        .map((channel) => channel.id),
      // A followed system channel never lists, but `get` serves it.
      ...[...followed].flat().filter((id) => {
        const channel = channels.queries.get?.(id);
        return !!channel && !channel.cached && !channel.pending;
      }),
    ];
    const ids = [
      ...new Set([
        ...joined,
        ...channels.demandedChannels().filter((id) => {
          const channel = channels.queries.get?.(id);
          return (
            channels.canAccess(id) && !channel?.cached && !channel?.pending
          );
        }),
      ]),
    ];
    // Channels agents' watches listen to. The live owner counts its wires
    // and admits them: joined channels share batched wires, and opened ones,
    // ranked first by `prioritize`, keep theirs; the rest get finite reads.
    const listened = new Set(ids);
    viewerLive = listened;
    for (const id of listened) learnedForAgents.delete(id);
    ids.push(
      ...[...new Set([...attended].flat())].filter((id) => {
        const channel = channels.queries.get?.(id);
        return (
          !listened.has(id) &&
          !!channel &&
          channels.canAccess(id) &&
          !channel.cached &&
          !channel.pending
        );
      }),
    );
    resolveAttended();
    const wanted = new Set(ids);
    for (const id of catchups.keys()) if (!wanted.has(id)) catchups.delete(id);
    try {
      traffic?.prioritize?.(channels.demandedChannels());
      traffic?.update(ids, joined);
    } catch (error) {
      liveSnapshot = { ...liveSnapshot, status: "error", error: String(error) };
    }
    publishLive();
    warmRoster();
  };
  /** Warm every channel's head before it is opened: starred first, then the
   * rest by recency. The account preferences own the starred set, so warming
   * waits for them to settle; a slow read delays warmth, never demand loading. */
  const warmRoster = () => {
    if (closed || !options.warm) return;
    const prefs = sidebarPreferences.queries.snapshot();
    if (prefs.status === "idle" || prefs.status === "loading") return;
    channels.queries.warm?.(prefs.data?.starred ?? []);
  };
  const stopWarmPreferences = sidebarPreferences.queries.subscribe(warmRoster);
  // Starred-first warming needs the account preferences without waiting for
  // the sidebar page to mount and observe them.
  if (options.warm) void sidebarPreferences.queries.ensure();
  let refreshedGeneration = -1;
  /** When unread was last asked for a full repair: a connection's first
   * establishment, then the recovery tick's backstop. */
  let unreadRepairedAt = 0;
  const repairUnread = (covered = false) => {
    // A covered resume reads no snapshot, so it cannot replace the backstop.
    if (!covered) unreadRepairedAt = Date.now();
    unread.reconnect(covered);
  };
  /** Held profiles still need a full read: none has completed since the
   * session started or since the last one was asked for. */
  let profilesOwed = true;
  let profilesRead = 0;
  /** The full read each global route's establishment may skip. A continuous
   * replay sent every stored change since the last connection heard the
   * relay, so its read is skipped unless an earlier one is still owed. A cut
   * replay reads again; so does a route that fails or goes unreported, once
   * per connection. */
  const globalReads = {
    profiles: {
      generation: -1,
      owed: () => profilesOwed,
      read() {
        profilesOwed = true;
        const read = ++profilesRead;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!closed)
            void profiles.reconnect().then(
              () => {
                if (read === profilesRead) profilesOwed = false;
              },
              () => {},
            );
        }, 0);
        timers.add(timer);
      },
    },
    membership: {
      generation: -1,
      // Recovery retries a failed or deferred roster read on its own.
      owed: () => channels.rosterOwed(),
      read: () => refreshRoster(),
    },
  };
  /** `continuous` is undefined when the route failed or went unreported. */
  const settleGlobal = (
    route: keyof typeof globalReads,
    continuous?: boolean,
  ) => {
    const global = globalReads[route];
    if (continuous !== false && global.generation === liveGeneration) return;
    global.generation = liveGeneration;
    if (!continuous || global.owed()) global.read();
  };
  /** Per global route, the connection whose covered reads are settled. */
  const coveredGeneration = { profiles: -1, membership: -1 };
  /** The reads a global route's replay covers (statuses and emoji for
   * `profiles`; read state and reminders for `membership`), once per
   * connection. A continuous replay already delivered every change since the
   * last connection heard the relay, so each owner resumes the state the
   * drop interrupted; otherwise it reads again. Like `settleGlobal`, a cut
   * replay reads again even after an earlier report on this connection, and
   * `continuous` is undefined when the route failed or went unreported. */
  const settleCovered = (route: LiveGlobal["route"], continuous?: boolean) => {
    if (continuous !== false && coveredGeneration[route] === liveGeneration)
      return;
    coveredGeneration[route] = liveGeneration;
    const generation = liveGeneration;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (closed) return;
      if (route === "profiles") {
        if (continuous) {
          emoji.resume();
          statuses.resume();
        } else {
          emoji.reconnect();
          statuses.reconnect();
        }
        return;
      }
      repairUnread(continuous);
      // Only while this same connection is still up.
      if (generation === liveGeneration && memoryConnected)
        void (continuous ? reminders?.resume() : reminders?.recover());
    }, 0);
    timers.add(timer);
  };
  /** No route has been established since the stream dropped, or ever: a
   * thread view opened now reads while it is down. */
  let streamDropped = true;
  const catchupRunning = new Map<string, Catchup>();
  const catchupQueue = new Set<string>();
  const isChannelHead = (filters: readonly ReadFilter[], channelId: string) =>
    filters.some(
      (filter) =>
        filter["#h"]?.includes(channelId) &&
        // Unread evidence also contains this channel, but is not a timeline head.
        filter.top_level === true &&
        filter.until === undefined &&
        filter.depth_limit === undefined &&
        filter.kinds?.includes(9),
    );
  function demandChannel(channelId: string): boolean {
    if (closed) return false;
    updateInterests();
    const job = catchups.get(channelId);
    if (!job || job.generation !== liveGeneration || job.state === "verified")
      return false;
    if (job.retryAt && performance.now() < job.retryAt) {
      channels.catchUpFailed(channelId, job.error);
      return true;
    }
    if (job.state !== "pending") {
      job.state = "pending";
      job.error = undefined;
      channels.catchUpQueued(channelId);
      catchupQueue.add(channelId);
      publishLive();
    }
    if (catchupRunning.has(channelId))
      requests.promote((filters) => isChannelHead(filters, channelId));
    queueMicrotask(() => void catchUpNext());
    return true;
  }
  function catchUpNext() {
    if (closed) return;
    // One retained catch-up at a time. Only the selected channel can use a
    // second slot; background recovery never drains the roster in parallel.
    while (catchupQueue.size && catchupRunning.size < 2) {
      const demanded = channels.demandedChannels();
      const channelId = catchupRunning.size
        ? demanded
            .slice(0, 1)
            .find((id) => catchupQueue.has(id) && !catchupRunning.has(id))
        : (demanded.find((id) => catchupQueue.has(id)) ??
          catchupQueue.values().next().value);
      if (!channelId) return;
      catchupQueue.delete(channelId);
      const job = catchups.get(channelId);
      if (
        !job ||
        job.generation !== liveGeneration ||
        !channels.canAccess(channelId)
      )
        continue;
      catchupRunning.set(channelId, job);
      void catchUpChannel(channelId, job);
    }
  }
  async function catchUpChannel(channelId: string, job: Catchup) {
    const valid = () =>
      !closed &&
      job.generation === liveGeneration &&
      catchups.get(channelId) === job;
    try {
      // A pre-establishment finite read cannot satisfy the handoff obligation.
      requests.invalidate((filters) => isChannelHead(filters, channelId));
      const verified = await channels.catchUp(channelId);
      if (valid()) job.state = verified ? "verified" : "deferred";
    } catch (error) {
      if (!valid()) return;
      job.state = readErrorKind(error) === "cancelled" ? "deferred" : "error";
      job.error = job.state === "error" ? String(error) : undefined;
      job.transient = isTransientFailure(error);
      if (error instanceof ReadError && error.retryAfterMs !== undefined) {
        job.retryAt = performance.now() + error.retryAfterMs;
        // Keep lightweight obligations, not paced requests inside reader deadlines.
        for (const id of catchupQueue) {
          const queued = catchups.get(id);
          if (queued) {
            queued.state = "error";
            queued.error = job.error;
            queued.transient = job.transient;
            queued.retryAt = job.retryAt;
            channels.catchUpFailed(id, error);
          }
        }
        catchupQueue.clear();
      }
    } finally {
      if (catchupRunning.get(channelId) === job)
        catchupRunning.delete(channelId);
      publishLive();
      catchUpNext();
    }
  }
  traffic = transport?.subscribe?.({
    observer: (frame, generation) => activity.receive(frame, generation),
    receive(events, provenance) {
      if (closed) return;
      reminders?.receive(events);
      const candidates = new Set(
        provenance?.phase === "live" && provenance.channelId
          ? events
              .filter((event) => {
                const destinations = event.tags.filter(
                  ([name]) => name === "h",
                );
                return (
                  (event.kind === 9 ||
                    event.kind === 40002 ||
                    event.kind === 40008) &&
                  event.pubkey !== transport.viewer &&
                  destinations.length === 1 &&
                  destinations[0]?.[1] === provenance.channelId &&
                  (recent.peek(event.id)?.incoming === "replay" ||
                    (!recent.peek(event.id) && !unread.event(event.id))) &&
                  !rawLocal().some((item) => item.event.id === event.id)
                );
              })
              .map((event) => event.id)
          : [],
      );
      // Signed membership notifications are hints, not roster authority. Schedule
      // before visibility filtering, because a newly granted channel may be denied locally.
      confirmMembershipHints(
        events.filter(
          (event) =>
            [44100, 44101].includes(event.kind) &&
            event.pubkey === transport.relayAuthor &&
            event.tags.some(
              ([name, value]) => name === "p" && value === transport.viewer,
            ),
        ),
      );
      const epoch = accessEpoch;
      const generation = liveGeneration;
      const visible = accept(
        events,
        true,
        undefined,
        undefined,
        provenance?.channelId ? provenance.phase : undefined,
      );
      // Completion subscribers can synchronously clear, revoke or retire this
      // live delivery. Do not admit its remaining pulses into the new lifetime.
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        typing.accept(
          events.filter((event) => event.kind === 20002),
          true,
        );
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        activity.channelEvents(
          events.filter((event) => event.pubkey !== transport.viewer),
        );
      if (
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration &&
        liveSnapshot.status === "connected"
      )
        channelActivity.accept(visible);
      const replay = provenance?.phase === "replay";
      if (
        (provenance?.phase === "live" || replay) &&
        (replayListeners.size || (!replay && liveEventListeners.size)) &&
        visible.length &&
        !closed &&
        epoch === accessEpoch &&
        generation === liveGeneration
      ) {
        const batch = Object.freeze({
          events: Object.freeze([...visible]),
          ...(provenance?.channelId ? { channelId: provenance.channelId } : {}),
          ...(replay ? { replay: true as const } : {}),
        });
        for (const listener of replay
          ? [...replayListeners]
          : [...liveEventListeners, ...replayListeners]) {
          if (closed || epoch !== accessEpoch) break;
          try {
            listener(batch);
          } catch (error) {
            console.error("Live listener failed", error);
          }
        }
      }
      if (
        closed ||
        epoch !== accessEpoch ||
        !candidates.size ||
        !provenance?.channelId
      )
        return;
      const delivered = new Set<string>();
      const incoming: readonly IncomingMessage[] = Object.freeze(
        visible.flatMap((event) => {
          if (!candidates.has(event.id) || delivered.has(event.id)) return [];
          delivered.add(event.id);
          const body =
            event.kind === 40002 ? objectBody(event.content) : undefined;
          const content =
            typeof body?.content === "string" ? body.content : event.content;
          return [
            Object.freeze({
              channelId: provenance.channelId as string,
              messageId: event.id,
              createdAt: event.created_at,
              authorId: event.pubkey,
              workflowOwnerId: workflowOwner(event, transport.archiveAuthority),
              previewContent: content.slice(0, 4096),
              ...(agentAudience(event) ? { audience: "agents" as const } : {}),
            }),
          ];
        }),
      );
      if (!incoming.length) return;
      for (const listener of incomingListeners) {
        if (closed || epoch !== accessEpoch) return;
        listener(incoming);
      }
    },
    state(snapshot) {
      if (closed) return;
      memoryConnected = snapshot.status === "connected";
      activity.state(snapshot);
      presence.connected(snapshot.status === "connected");
      profiles.connected(snapshot.status === "connected");
      if (snapshot.status !== "connected") {
        typing.clear();
        memories.clear();
      }
      if (
        snapshot.status !== "connected" &&
        liveSnapshot.status === "connected"
      ) {
        liveGeneration++;
        // Reminder catch-up waits for the recovery read after re-establishment.
        reminders?.stale();
        retryAttended();
        channelActivity.cancel();
        activityRosterKey = undefined;
        catchups.clear();
        catchupQueue.clear();
        dropHintConfirmations();
        requests.invalidate();
        repositories.clearHomes();
        agentLibrary.clear();
        archives.stale();
        workflows.interrupt();
        streamDropped = true;
        channels.staleHeads();
        for (const thread of threads) thread.stale();
        unread.stale();
        inboxFeed.stale();
      }
      // Access-revoked CLOSED is a refresh hint, not signed archive/membership
      // authority. Aggregate snapshots repeat failures; only react to a new one.
      const revoked = (route: LiveSnapshot["routes"][number]) =>
        route.channelId &&
        route.status === "error" &&
        route.error === "restricted: channel access revoked";
      const previous = new Set(
        liveSnapshot.routes.filter(revoked).map((r) => r.id),
      );
      if (
        snapshot.routes.some(
          (route) => revoked(route) && !previous.has(route.id),
        )
      )
        refreshRoster();
      liveSnapshot = snapshot;
      // A global route that failed before it established proves nothing, so
      // the finite reads stand in for its replay on this connection.
      if (snapshot.status === "connected")
        for (const route of snapshot.routes)
          if (
            (route.id === "profiles" || route.id === "membership") &&
            route.status === "error"
          ) {
            settleGlobal(route.id);
            settleCovered(route.id);
          }
      // Suspend every affected preview before any recheck: one revocation can
      // cancel another read, but must never leave its old public grant readable.
      const previews = snapshot.routes
        .filter(
          (route) =>
            revoked(route) &&
            !previous.has(route.id) &&
            route.channelId &&
            !channels.canParticipate(route.channelId) &&
            channels.queries.get?.(route.channelId)?.readOnly,
        )
        .map((route) => route.channelId as string);
      channels.suspendPreviews(previews);
      revalidatePreviews(previews);
      publishLive();
    },
    established(channelId, global) {
      if (closed) return;
      streamDropped = false;
      if (!channelId) {
        const first = refreshedGeneration !== liveGeneration;
        // A host that reports no route (an older broker) leaves both reads
        // to this connection's first establishment, in any order.
        if (global) {
          settleGlobal(global.route, global.continuous);
          settleCovered(global.route, global.continuous);
        } else {
          settleGlobal("membership");
          settleGlobal("profiles");
          settleCovered("membership");
          settleCovered("profiles");
        }
        if (first) {
          refreshedGeneration = liveGeneration;
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed) {
              agentLibrary.reconnect();
              activityRosterKey = undefined;
              refreshChannelActivity();
              inboxFeed.reconnect();
              for (const refresh of refreshers) void refresh();
            }
          }, 0);
          timers.add(timer);
        }
        return;
      }
      for (const id of typeof channelId === "string"
        ? [channelId]
        : channelId) {
        if (!channels.canAccess(id)) continue;
        for (const thread of threads)
          if (thread.channelId === id) void thread.established();
        const job = {
          generation: liveGeneration,
          state: "pending" as "pending" | "verified" | "deferred" | "error",
          error: undefined as string | undefined,
        };
        channels.catchUpQueued(id);
        catchups.set(id, job);
        if (channels.retainedChannels().includes(id)) catchupQueue.add(id);
        else job.state = "deferred";
      }
      publishLive();
      queueMicrotask(() => void catchUpNext());
    },
    recover() {
      if (closed) return;
      if (
        channels.rosterOwed() ||
        Date.now() - rosterReadAt >= ROSTER_BACKSTOP_INTERVAL
      )
        refreshRoster();
      // A failed repair retries on the next tick, as the roster does.
      if (
        unread.owed() ||
        Date.now() - unreadRepairedAt >= UNREAD_BACKSTOP_INTERVAL
      )
        repairUnread();
    },
    denied(channelId, reason) {
      if (!closed) channels.denyChannel(channelId, new Error(reason));
    },
  });
  let activityRosterKey: string | undefined;
  const refreshChannelActivity = () => {
    if (closed || !transport?.channelActivity) return;
    const preferences = sidebarPreferences.queries.snapshot().data;
    if (
      !Object.values(preferences?.sort ?? {}).includes("recent") &&
      !Object.values(preferences?.filters ?? {}).includes("active")
    ) {
      channelActivity.cancel();
      activityRosterKey = undefined;
      return;
    }
    const roster = channels.queries.list();
    if (roster.status !== "ready") return;
    const ids = roster.channels
      .filter((channel) => !channel.cached)
      .map((channel) => channel.id)
      .sort();
    const key = ids.join("\0");
    if (key === activityRosterKey) return;
    activityRosterKey = key;
    void channelActivity.refresh(ids).catch(() => {
      if (activityRosterKey === key) activityRosterKey = undefined;
    });
  };
  const stopActivityRoster = channels.queries.subscribeList(
    refreshChannelActivity,
  );
  const stopActivityPreferences = sidebarPreferences.queries.subscribe(
    refreshChannelActivity,
  );
  const stopInterests = channels.queries.subscribeList(updateInterests);
  updateInterests();
  refreshChannelActivity();

  return {
    session,
    async restore() {
      await Promise.all([channels.restore(), sidebarPreferences.ready]);
    },
    async clearCache() {
      // Keep memory admission closed through asynchronous and overlapping purges.
      cacheClearing++;
      try {
        accessEpoch++;
        cancelUploads();
        cacheClearEpoch++;
        dropHintConfirmations();
        activity.clear();
        memories.clear();
        presence.clear();
        channelActivity.clear();
        activityRosterKey = undefined;
        typing.clear();
        sidebarPreferences.clear();
        soloPreferences.clear();
        channelKit.clear();
        lifecycle.clear();
        details.clear();
        memberAdministration.clear();
        // New windows must not yield to or receive errors from retired owners.
        catchups.clear();
        catchupQueue.clear();
        for (const clear of views.values()) clear(true);
        for (const view of artifactSyncs) view.restart();
        recent.clear();
        unread.clear();
        inboxFeed.clear();
        requests.invalidate();
        retireBackoffs();
        repositories.clearHomes();
        profiles.clear();
        emoji.clear();
        statuses.clear();
        agentLibrary.clear();
        archives.clear();
        workflows.clear();
        const results = await Promise.allSettled([channels.clearCache()]);
        updateInterests();
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      } finally {
        cacheClearing--;
      }
    },
    dispose() {
      stopSoloGroups();
      closed = true;
      stopLiveRecovery();
      recovery?.dispose();
      repositories.clearHomes();
      typing.dispose();
      lifetime.abort();
      activity.dispose();
      memories.dispose();
      presence.dispose();
      channelActivity.dispose();
      stopActivityRoster();
      stopActivityPreferences();
      sidebarPreferences.dispose();
      soloPreferences.dispose();
      // Before requests.dispose(): lifecycle rereads retired shared reads
      // until its own controllers abort.
      lifecycle.dispose();
      details.dispose();
      memberAdministration.dispose();
      stopInterests();
      stopHintGuard();
      stopWarmPreferences();
      for (const view of [...artifactSyncs]) view.dispose();
      artifactSyncs.clear();
      traffic?.dispose();
      liveListeners.clear();
      incomingListeners.clear();
      liveEventListeners.clear();
      replayListeners.clear();
      observations.clear();
      for (const timer of timers) clearTimeout(timer);
      for (const dispose of [...views.keys()]) dispose();
      unread.dispose();
      inboxFeed.dispose();
      writes?.dispose();
      requests.dispose();
      channels.dispose();
      profiles.dispose();
      emoji.dispose();
      statuses.dispose();
      workflows.dispose();
      identityNames.dispose();
      agentLibrary.dispose();
      archives.dispose();
    },
    retainedChannels: channels.retainedChannels,
    diagnostics: () => ({
      ...channels.diagnostics(),
      profiles: profiles.stats(),
    }),
  };
}
export type RelaySession = ReturnType<typeof createRelaySession>["session"];
