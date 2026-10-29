import { retryRead } from "./read-retry";
import { channelRowKind, rowProfileIds, messagePreview } from "./membership";
import type { Outbox } from "./outbox";
import { MessageProjection } from "./message-projection";
import { createRelayProfiler, type RelayProfiler } from "./profiling";
import { isTransientFailure, ReadError, readErrorKind } from "./errors";
import type {
  ChannelReference,
  ChannelList,
  ChannelReadOptions,
  ChannelMessage,
  ChannelQueries,
  ChannelSummary,
  PublicChannelSearch,
  ChannelWindow,
} from "./contracts";
import { DiscoveryState, metadataName, openMetadata } from "./discovery";
import {
  channelIdentity,
  channelIdentityUnsupported,
  channelLabelTags,
  compareChannelAge,
} from "./channel-labels";
import { foldMessages } from "./fold";
import { eventDto, hasTag, newer, tag, type RelayEvent } from "./events";
import type { RelayReader, ReadOptions, Priority } from "./reader";
import type { ProfileDirectory } from "./profile-directory";
import {
  NOTICE_PAGE_SIZE,
  noticeFilter,
  parseWindow,
  WINDOW_KINDS,
  windowFilter,
  type WindowCursor,
} from "./window";
import { ByteLru, byteSize, listByteSize } from "./budget";
import type { HeadPersistence, SavedHead } from "./persistence";
import { createMediaPreparation, saveData } from "./media";
import { relayDebug } from "./debug";
import { clientMetrics } from "../developer/client-metrics";
import { MessageClock } from "./message-order";
import { yieldToHost } from "./yield";
import { MatchRank, matchRank } from "../search/match";

type Listener = () => void;
type WindowState = {
  projection: MessageProjection;
  traffic: Map<string, RelayEvent>;
  channelId: string;
  snapshot: ChannelWindow;
  cursor: WindowCursor | null;
  events: readonly RelayEvent[];
  atHead: boolean;
  /** Oldest point any page read reached, in created_at seconds; 0 once a read
   * reached the start. Only falls while the window lives: a catch-up head can
   * move `cursor` past rows the reader already has, and those must stay. */
  floor?: number | undefined;
  generation: number;
  controller?: AbortController | undefined;
  /** Rows came from IndexedDB and no relay read has replaced them. Freshness
   * cannot say this: a dropped socket also marks relay rows `cached`. */
  restored?: boolean;
  /** Channel rows held when the stream dropped, or read while it was down,
   * until a catch-up verifies or settles the window. The re-established stream
   * replays its last minutes before catch-up; those rows are newer than any
   * gap, not overlap with it. */
  kept?: Set<string> | undefined;
  /** Relay membership notices, read apart from the pages (see `fillNotices`). */
  notices: Map<string, RelayEvent>;
  /** Where the next older notice read starts: null once a read reached the
   * channel's start, undefined before the first read. */
  noticeCursor?: WindowCursor | null | undefined;
  /** A head read asked for the newest notices again. */
  noticeHead?: boolean | undefined;
  noticeRead?: { controller: AbortController; generation: number } | undefined;
};
type Head = {
  rows: readonly ChannelMessage[];
  cursor: WindowCursor | null;
  hasMore: boolean;
  events: readonly RelayEvent[];
  savedAt: number;
  cached: boolean;
  restored?: true;
};
export type ChannelStoreOptions = {
  profiling?: RelayProfiler;
  maxWindows?: number;
  unavailableReason?: string;
  prepared?: boolean;
  /** Local resume session has no network authority or writer. */
  cachedOnly?: boolean;
  /** Prioritize the previous conversation; other saved heads restore in background. */
  initialChannelId?: string | undefined;
  /** Warm every roster channel's head in the background before it is opened. */
  warm?: boolean;
  persistence?: HeadPersistence;
  maxDiscoveryBytes?: number;
  maxHeadBytes?: number;
  maxHeads?: number;
  maxHistoryRows?: number;
  maxHistoryBytes?: number;
  /** Public directory budget in whole pages; at most the default 20,000. */
  maxPublicDirectory?: number;
  /** Public directory page size, at most the default 500. */
  publicDirectoryPage?: number;
  now?: () => number;
  local?: Pick<Outbox, "snapshot" | "subscribe">;
  /** The session's send clock; rendered windows raise its channel watermarks. */
  clock?: MessageClock;
  notifyListener?: (listener: () => void) => void;
};
const EMPTY_ROWS: readonly ChannelMessage[] = Object.freeze([]);
/** Relay page size, separate from discovery's retained-entry budget. */
const DISCOVERY_LIMIT = 500;
/** Channels one creator-proof filter names. Each has one creation, so a limit
 * of twice this, the relay's maximum, leaves room for strays; a filter that
 * reaches it proves only the channels whose creation arrived. */
const CREATION_READ_CHANNELS = 250;
// Public channel metadata for name search, read a page at a time up to a
// bound; matches resolve exactly.
const PUBLIC_CHANNEL_PAGE = 500;
/** Rosters per member-count read: one can run to hundreds of KB. */
const MEMBER_COUNT_CHUNK = 10;
// One exact resolution can consume the reader's full response byte budget.
const PUBLIC_CHANNEL_RESERVE_BYTES = 8 * 1024 * 1024;
const PUBLIC_CHANNEL_DIRECTORY = 20_000;
/** One creator's channels with one label: a small answer, within one `resolve`. */
const LABELED_CHANNEL_PAGE = 100;
/** How long name search reuses the public channel metadata once read. Typing
 * reads it once; a channel created meanwhile shows up after this. */
const PUBLIC_CHANNEL_PAGE_TTL = 30_000;
/** Delta reads overlap clock/replica lag; full replacement repairs omissions. */
const PUBLIC_CHANNEL_OVERLAP = 120_000;
const PUBLIC_CHANNEL_RECONCILE = 5 * 60_000;
/** How long a channel link keeps a `withheld` answer before rechecking it. */
const REFERENCE_TTL = 5 * 60_000;
/** The least wait before a failed channel-link lookup is tried again. */
const REFERENCE_RETRY = 30_000;
/** Exact omission confirmations use the relay's explicit channel-ID cap. */
const DISCOVERY_CONFIRM_LIMIT = 128;
const UNAVAILABLE: ChannelList = Object.freeze({
  status: "unavailable",
  channels: Object.freeze([]),
});
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const isAbort = (error: unknown) => readErrorKind(error) === "cancelled";
/** An open channel name's match rank: the joined-channel rule (`matchRank`),
 * so "buzz community" finds "buzz-community"; an exact lookup names one. */
const publicRank = (name: string, needle: string, exact?: boolean) =>
  exact
    ? name.toLowerCase() === needle
      ? MatchRank.exact
      : undefined
    : matchRank(name, needle);
const FRESH_FOR = 60_000;
/** Pages a reconnect catch-up reads back from the head before it gives up on
 * reaching the rows the reader kept across the disconnect. */
const CATCH_UP_PAGES = 5;
/** Membership notices a window reads below its head. Past it, older pages show
 * without their notices. */
const MAX_NOTICES = 2000;
/** Relay query order: time descending, then ID ascending at ties. */
const newestFirst = (a: RelayEvent, b: RelayEvent) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);
/** Rows a page read can reach again, which notices are not. */
const rowIds = (state: WindowState) =>
  new Set(
    state.events
      .filter((event) => WINDOW_KINDS.includes(event.kind))
      .map((event) => event.id),
  );

/** Session-owned read model. Broad byte-bounded heads are separate from the small history LRU.
 * Preparing a head never mounts a timeline or evicts a subscribed history window. */
export function createChannelStore(
  transport:
    | (RelayReader & {
        viewer: string;
        relayAuthor: string;
        /** Explicit NIP-11 self; only it may attribute messages to others. */
        archiveAuthority?: string | undefined;
        media(url: string, size?: "small"): string | undefined;
        /** `ids` names the channels that lost access when known; omitted means any. */
        revokeAccess(commit: () => void, ids?: readonly string[]): void;
        /** A complete roster read applied. A replica can lag, so a channel it
         * left out may still list the viewer; `unlisted` asks the writer. */
        rosterComplete?(): void;
        visible(events: readonly RelayEvent[]): readonly RelayEvent[];
        /** Reverified, authorized disk evidence, before any restored rows become observable. */
        restored?(events: readonly RelayEvent[]): void;
        /** Returns true when session post-subscribe catch-up owns this demand. */
        demand?(channelId: string): boolean;
        rosterChanged?(strong?: boolean): void;
        /** The relay advertises NIP-CL; label lookups are refused without it. */
        channelIdentity?: true | undefined;
      })
    | null,
  directory: ProfileDirectory,
  options: ChannelStoreOptions = {},
) {
  // A fold reads the profile directory only through attested agent owners.
  // Keep the answers each fold received: a profile change that leaves them
  // all alone cannot change its rows.
  const foldOwners = new WeakMap<
    readonly ChannelMessage[],
    ReadonlyMap<string, string | undefined>
  >();
  const foldChannelMessages = (
    channelId: string,
    author: string,
    events: readonly import("./events").EventData[],
  ) => {
    const started = performance.now();
    const owners = new Map<string, string | undefined>();
    const rows = foldMessages(channelId, author, events, {
      signingAuthority: transport?.archiveAuthority,
      agentOwner: (pubkey) => {
        const owner = directory.queries.owner?.(pubkey);
        owners.set(pubkey, owner);
        return owner;
      },
    });
    foldOwners.set(rows, owners);
    clientMetrics.cpu("fold", performance.now() - started, events.length);
    return rows;
  };
  const ownersChanged = (
    owners: ReadonlyMap<string, string | undefined> | undefined,
  ) =>
    !owners ||
    [...owners].some(
      ([pubkey, owner]) => directory.queries.owner?.(pubkey) !== owner,
    );
  const {
    maxWindows = 3,
    unavailableReason,
    prepared = false,
    persistence,
    maxHeadBytes = 4 * 1024 * 1024,
    maxHeads = 64,
    maxHistoryRows = 2400,
    maxHistoryBytes = 8 * 1024 * 1024,
    maxPublicDirectory = PUBLIC_CHANNEL_DIRECTORY,
    publicDirectoryPage = PUBLIC_CHANNEL_PAGE,
    now = Date.now,
    local,
    clock = new MessageClock(),
    notifyListener = (listener: () => void) => listener(),
    profiling = createRelayProfiler(),
  } = options;
  if (!Number.isInteger(maxWindows) || maxWindows < 1)
    throw new Error("Invalid window capacity");
  if (
    !Number.isInteger(publicDirectoryPage) ||
    publicDirectoryPage < 1 ||
    publicDirectoryPage > PUBLIC_CHANNEL_PAGE ||
    !Number.isInteger(maxPublicDirectory) ||
    maxPublicDirectory % publicDirectoryPage !== 0 ||
    maxPublicDirectory < publicDirectoryPage ||
    maxPublicDirectory > PUBLIC_CHANNEL_DIRECTORY
  )
    throw new Error("Invalid public directory capacity");
  let disposed = false,
    epoch = 0,
    listBusy = false;
  let listAgain = false;
  // Epoch of the latest access revocation. When that revocation is what made a
  // full read stale, it interrupted rather than failed it: a pass is still owed.
  let revokedEpoch = 0;
  let strongListAgain = false;
  let listRetryAt = 0;
  type RosterRefresh = Readonly<{
    state: "idle" | "pending" | "verified" | "deferred" | "error";
    error?: string;
    /** Set with an error that a later retry can fix; see isTransientFailure. */
    transient?: true;
  }>;
  let rosterRefresh: RosterRefresh = Object.freeze({ state: "idle" });
  let list: ChannelList = transport
    ? Object.freeze({ status: "idle", channels: Object.freeze([]) })
    : unavailableReason
      ? Object.freeze({ ...UNAVAILABLE, error: unavailableReason })
      : UNAVAILABLE;
  let allowed: Set<string> | undefined;
  let coverage: "partial" | undefined;
  const discovery = transport
    ? new DiscoveryState(
        transport.viewer,
        transport.relayAuthor,
        options.maxDiscoveryBytes,
      )
    : null;
  // Restored metadata needs confirmation independently of roster progress/retries.
  const pendingMetadata = new Set<string>();
  const checkedMetadata = new Set<string>();
  const heads = new ByteLru<Head>(maxHeads, maxHeadBytes);
  const windows = new Map<string, WindowState>();
  const tails = new ByteLru<{
    events: readonly RelayEvent[];
    preview?: string | undefined;
  }>(64, 4 * 1024 * 1024);
  /** `byteSize` of a tail, without serializing its retained events again. */
  const tailBytes = (tail: NonNullable<ReturnType<typeof tails.peek>>) =>
    byteSize({ ...tail, events: [] }) - 2 + listByteSize(tail.events);
  let media = createMediaPreparation();
  const controllers = new Set<AbortController>();
  /** Stream drops seen; a catch-up compares it to learn one happened mid-fill. */
  let streamDrops = 0;
  /** The stream is down, or not yet up: a window reading its head now keeps
   * those rows for the catch-up to reach, as staleHeads() kept the windows
   * that existed at the drop. Establishing any channel clears it. */
  let dropped = true;
  const accessVersions = new Map<string, number>();
  const listListeners = new Set<Listener>();
  /** Directory pages and finished reads, for browsing. */
  const directoryListeners = new Set<Listener>();
  const windowListeners = new Map<string, Set<Listener>>();
  let intent: string | undefined = options.initialChannelId;
  let current: string | undefined;
  const mediaIntents: string[] = [];
  let hydration: Promise<void> | undefined;
  let revealHydration: (() => void) | undefined;
  let initialHydration = new Promise<void>((resolve) => {
    revealHydration = resolve;
  });
  let startup: Promise<void> | undefined;
  let discoveryObserved = false;
  // Profile bursts rewrite the whole startup record; save at most once per 500ms.
  let discoverySave: ReturnType<typeof setTimeout> | undefined;
  // Participant profiles in the last startup snapshot, by identity.
  let savedProfiles: ReadonlyMap<string, RelayEvent | undefined> = new Map();
  let preparing = false;
  let warming = false;
  const notify = (listeners: Iterable<Listener> | undefined) => {
    for (const listener of listeners ?? []) notifyListener(listener);
  };
  function subscribe(listeners: Set<Listener>, listener: Listener) {
    const callback = () => listener();
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }
  // A chat this device is starting is a Solo chat, not a temporary room, so
  // it lists and opens before its metadata arrives.
  function metadataPending(id: string) {
    return discovery &&
      !discovery.isPending(id) &&
      !discovery.metadataVersion(id) &&
      !checkedMetadata.has(id)
      ? true
      : undefined;
  }
  function setList(next: ChannelList, discoveryChanged = false) {
    const previous = new Map(
      list.channels.map((channel) => [channel.id, channel]),
    );
    const retained = new Set(next.channels.map((channel) => channel.id));
    for (const id of checkedMetadata)
      if (!retained.has(id)) checkedMetadata.delete(id);
    const channels = next.channels.map((channel) => {
      const pending = metadataPending(channel.id);
      const preview =
        messagePreview(windows.get(channel.id)?.snapshot.rows) ??
        tails.peek(channel.id)?.preview ??
        messagePreview(heads.peek(channel.id)?.rows);
      const old = previous.get(channel.id);
      return old &&
        old.name === channel.name &&
        old.description === channel.description &&
        old.metadataPending === pending &&
        old.visibility === channel.visibility &&
        old.joinRole === channel.joinRole &&
        old.viewerRole === channel.viewerRole &&
        old.preview === preview &&
        old.hidden === channel.hidden &&
        old.private === channel.private &&
        old.autoJoin === channel.autoJoin &&
        old.channelType === channel.channelType &&
        old.parentChannelId === channel.parentChannelId &&
        old.huddle === channel.huddle &&
        old.updatedAt === channel.updatedAt &&
        old.archived === channel.archived &&
        old.ttlSeconds === channel.ttlSeconds &&
        old.readOnly === channel.readOnly &&
        old.cached === channel.cached &&
        old.pending === channel.pending &&
        (old.members === channel.members ||
          (old.members?.length === channel.members?.length &&
            (old.members ?? []).every(
              (id, index) => id === channel.members?.[index],
            ))) &&
        (old.participants === channel.participants ||
          (old.participants?.length === channel.participants?.length &&
            (old.participants ?? []).every(
              (id, index) => id === channel.participants?.[index],
            )))
        ? old
        : Object.freeze({ ...channel, metadataPending: pending, preview });
    });
    const sameChannels =
      channels.length === list.channels.length &&
      channels.every((channel, index) => channel === list.channels[index]);
    if (
      !discoveryChanged &&
      sameChannels &&
      next.status === list.status &&
      next.coverage === list.coverage &&
      next.error === list.error &&
      next.asOf === list.asOf
    )
      return;
    list = Object.freeze({
      ...next,
      channels: sameChannels ? list.channels : Object.freeze(channels),
    });
    notify(listListeners);
  }
  function moveCursor(state: WindowState, cursor: WindowCursor | null) {
    state.cursor = cursor;
    state.floor = Math.min(state.floor ?? Infinity, cursor?.createdAt ?? 0);
  }
  function setWindow(state: WindowState, patch: Partial<ChannelWindow>) {
    let rows = patch.rows ?? state.snapshot.rows;
    if (authorized(state.channelId) && transport) {
      // Session reads (agents, search, previews) and the live tail can carry
      // rows from before the loaded history. Showing one leaves a gap that a
      // later page fills mid-list, where the timeline can neither anchor the
      // reader nor tell it from new arrivals. That page shows them instead.
      const floor =
        (patch.hasMore ?? state.snapshot.hasMore) ? state.floor : undefined;
      const combined = new Map(
        [...state.events, ...state.notices.values(), ...state.traffic.values()]
          .filter(
            (event) =>
              floor === undefined ||
              event.created_at >= floor ||
              !channelRowKind(event.kind),
          )
          .map((event) => [event.id, event as import("./events").EventData]),
      );
      const ids = new Set(combined.keys());
      for (const item of local?.snapshot() ?? [])
        if (
          [9, 40002, 40008].includes(item.event.kind) &&
          item.event.tags.some(
            (tag) => tag[0] === "h" && tag[1] === state.channelId,
          )
        )
          ids.add(item.event.id);
      const operations = (local?.snapshot() ?? []).filter((item) =>
        item.event.tags.some(
          (tag) =>
            (tag[0] === "h" && tag[1] === state.channelId) ||
            (tag[0] === "e" && ids.has(tag[1] ?? "")),
        ),
      );
      for (const item of operations) {
        if (
          item.delivery === "failed" &&
          ![9, 40002, 40008].includes(item.event.kind)
        )
          continue;
        combined.set(item.event.id, item.event);
      }
      rows = profiling.measure("view.reconcile", state.channelId, () =>
        state.projection.reconcile([...combined.values()], operations),
      );
    }
    const next = { ...state.snapshot, ...patch, rows };
    if (
      Object.entries(next).every(
        ([key, value]) => value === state.snapshot[key as keyof ChannelWindow],
      )
    )
      return;
    const previousPreview = messagePreview(state.snapshot.rows);
    if (rows.length && !state.snapshot.rows.length)
      clientMetrics.channelData(
        state.channelId,
        state.restored ? "disk" : "network",
      );
    state.snapshot = Object.freeze(next);
    notify(windowListeners.get(state.channelId));
    if (previousPreview !== messagePreview(rows)) setList(list);
  }
  const idleWindows = new Map<string, ChannelWindow>();
  function idleWindow(channelId: string): ChannelWindow {
    let snapshot = idleWindows.get(channelId);
    if (!snapshot) {
      snapshot = Object.freeze({
        channelId,
        status: "idle",
        rows: EMPTY_ROWS,
        hasMore: true,
        loadingOlder: false,
        error: undefined,
      });
      idleWindows.set(channelId, snapshot);
      if (idleWindows.size > 256)
        for (const id of idleWindows.keys()) {
          if (
            !windows.has(id) &&
            !windowListeners.has(id) &&
            id !== channelId
          ) {
            idleWindows.delete(id);
            break;
          }
        }
    }
    return snapshot;
  }
  function evict(state: WindowState) {
    windows.delete(state.channelId);
    state.generation++;
    state.controller?.abort();
    state.noticeRead?.controller.abort();
    state.events = [];
    state.notices.clear();
    state.floor = undefined;
    state.snapshot = idleWindow(state.channelId);
    notify(windowListeners.get(state.channelId));
  }
  function trim() {
    while (windows.size > maxWindows) {
      const oldest = [...windows.values()].find(
        (state) => !prepared || !windowListeners.get(state.channelId)?.size,
      );
      if (!oldest) break; // Never discard a mounted reader's anchor for speculation.
      evict(oldest);
    }
  }
  function touch(channelId: string): WindowState {
    let state = windows.get(channelId);
    if (state) {
      windows.delete(channelId);
      windows.set(channelId, state);
      return state;
    }
    state = {
      traffic: new Map(
        (tails.peek(channelId)?.events ?? []).map((event) => [event.id, event]),
      ),
      projection: new MessageProjection(
        channelId,
        transport?.relayAuthor ?? "",
        profiling,
        clock,
        transport?.archiveAuthority,
        directory.queries.owner,
      ),
      channelId,
      snapshot: idleWindow(channelId),
      cursor: null,
      events: [],
      notices: new Map(),
      atHead: true,
      generation: 0,
    };
    windows.set(channelId, state);
    trim();
    return state;
  }
  const authorized = (id: string) => discovery?.canAccess(id) ?? false;
  const canReadRemote = (id: string) =>
    !options.cachedOnly &&
    authorized(id) &&
    !discovery?.get(id)?.cached &&
    !discovery?.isPending(id);
  const live = (state: WindowState, generation: number) =>
    !disposed &&
    authorized(state.channelId) &&
    windows.get(state.channelId) === state &&
    state.generation === generation;
  function prepareMedia(channelId: string) {
    const previous = mediaIntents.indexOf(channelId);
    if (previous >= 0) mediaIntents.splice(previous, 1);
    mediaIntents.unshift(channelId);
    mediaIntents.length = Math.min(3, mediaIntents.length);
    const urls = mediaIntents.flatMap(avatarUrlsFor);
    relayDebug("media prepare", channelId.slice(0, 8), `${urls.length} urls`);
    media.prepare(urls);
  }
  /** Background head reads warm request-level avatars without displacing the
   * focused channel's intent window. */
  function prepareWarmMedia(channelId: string) {
    media.warm(avatarUrlsFor(channelId));
  }
  function avatarUrlsFor(id: string): string[] {
    const rows = heads.peek(id)?.rows ?? windows.get(id)?.snapshot.rows ?? [];
    const authors = rows.slice(-12).reverse().flatMap(rowProfileIds);
    return authors.flatMap((author) => {
      const picture = directory.queries.snapshot().get(author)?.picture;
      const url = picture && transport?.media(picture, "small");
      return url ? [url] : [];
    });
  }
  async function fetchProfiles(
    rows: readonly ChannelMessage[],
    warmChannelId?: string,
  ) {
    try {
      const ids = rows.flatMap(rowProfileIds);
      relayDebug("profiles warm", ids.length, "ids");
      await directory.ensure(ids, "background");
      if (!disposed && intent) prepareMedia(intent);
      // Profiles are the prerequisite for resolving a channel's avatar URLs.
      if (!disposed && warmChannelId) prepareWarmMedia(warmChannelId);
    } catch {
      // Names are optional for channel rendering. Missing profiles remain retryable.
    }
  }
  const patchFromHead = (head: Head): Partial<ChannelWindow> => ({
    status: "ready",
    rows: head.rows,
    hasMore: head.hasMore,
    loadingOlder: false,
    error: undefined,
    freshness: head.cached ? "cached" : "verified",
    historyLimited: false,
  });
  /** Show a head as the window's rows. Read while the stream is down, they
   * are what its catch-up must reach: the replay that precedes it is newer
   * than any gap, not overlap with it. The head replaces the rows, so it
   * replaces the snapshot too (a cached head adopted on revisit is re-read). */
  function adoptHead(state: WindowState, head: Head) {
    moveCursor(state, head.cursor);
    state.events = head.events;
    state.atHead = true;
    state.restored = head.restored === true;
    if (dropped) state.kept = rowIds(state);
    setWindow(state, patchFromHead(head));
    void fillNotices(state, true);
  }
  /** Read a window's membership notices newest first, down to the oldest page
   * read. Pages leave notices out (see `WINDOW_KINDS`), so the messages show
   * first and the notices between them follow. A head read asks for the newest
   * notices again; when those do not meet the notices held, the descent starts
   * over from them. A failed read only leaves notices out until the next page
   * or head read. */
  async function fillNotices(state: WindowState, head: boolean) {
    if (head) state.noticeHead = true;
    const reading = state.noticeRead;
    if (
      reading?.generation === state.generation &&
      !reading.controller.signal.aborted
    )
      return;
    reading?.controller.abort();
    if (!transport) return;
    const source = transport;
    const { channelId, generation } = state;
    const controller = new AbortController();
    const current = { controller, generation };
    state.noticeRead = current;
    controllers.add(controller);
    let top = false;
    try {
      while (live(state, generation) && canReadRemote(channelId)) {
        top = state.noticeHead === true || state.noticeCursor === undefined;
        let cursor: WindowCursor | null = null;
        if (!top) {
          const next = state.noticeCursor;
          if (
            !next ||
            next.createdAt < (state.floor ?? Infinity) ||
            state.notices.size >= MAX_NOTICES
          )
            break;
          cursor = next;
        }
        state.noticeHead = false;
        const events = await retryRead(
          (signal) =>
            source.read([noticeFilter(channelId, source.relayAuthor, cursor)], {
              signal,
            }),
          controller.signal,
        );
        if (!live(state, generation) || controller.signal.aborted) return;
        if (
          events.some(
            (event) =>
              event.kind !== 40099 ||
              event.pubkey !== source.relayAuthor ||
              !hasTag(event, "h", channelId),
          )
        )
          throw new Error("Membership notices are outside their channel");
        let known: RelayEvent | undefined;
        for (const event of state.notices.values())
          if (!known || newestFirst(event, known) < 0) known = event;
        for (const event of events) state.notices.set(event.id, event);
        const last = [...events].sort(newestFirst).at(-1);
        const next =
          last && events.length >= NOTICE_PAGE_SIZE
            ? { createdAt: last.created_at, eventId: last.id }
            : null;
        if (
          cursor &&
          next &&
          (next.createdAt > cursor.createdAt ||
            (next.createdAt === cursor.createdAt &&
              next.eventId <= cursor.eventId))
        )
          throw new Error("Membership notices did not advance");
        // A head read that reaches the notices held continues their descent.
        const met =
          known !== undefined &&
          last !== undefined &&
          (last.created_at < known.created_at ||
            events.some((event) => event.id === known?.id));
        if (!top || !next || !met || state.noticeCursor === undefined)
          state.noticeCursor = next;
        setWindow(state, {});
        // The page's name read ran before these rows existed.
        const added = new Set(events.map((event) => event.id));
        void fetchProfiles(
          state.snapshot.rows.filter((row) => added.has(row.id)),
        );
      }
    } catch (error) {
      // The next page read retries a failed head read from the top.
      if (top) state.noticeHead = true;
      if (!isAbort(error))
        relayDebug(
          "notices failed",
          channelId.slice(0, 8),
          readErrorKind(error),
        );
    } finally {
      controllers.delete(controller);
      if (state.noticeRead === current) state.noticeRead = undefined;
    }
  }
  function save(channelId: string, head: Head, previousProfiles?: string) {
    if (
      !persistence ||
      !discovery?.authorized(channelId) ||
      disposed ||
      heads.peek(channelId) !== head
    )
      return;
    const authors = new Set(head.rows.flatMap(rowProfileIds));
    const profiles = [...authors].flatMap((id) => {
      const event = directory.event(id);
      return event ? [event] : [];
    });
    const signature = profiles.map((event) => event.id).join(":");
    if (signature === previousProfiles) return signature;
    const record: SavedHead = {
      channelId,
      savedAt: head.savedAt,
      events: [...head.events],
      profiles,
    };
    void persistence.write(record).catch(() => {});
    return signature;
  }
  function denyChannel(channelId: string, error: unknown) {
    // A chat still starting is not there to deny yet; only a refused or
    // missing create ends it (see channelWrites.start).
    if (discovery?.isPending(channelId)) return;
    accessVersions.set(channelId, (accessVersions.get(channelId) ?? 0) + 1);
    discovery?.deny(channelId);
    allowed?.delete(channelId);
    transport?.revokeAccess(() => {
      heads.delete(channelId);
      tails.delete(channelId);
      const state = windows.get(channelId);
      if (state) {
        state.generation++;
        state.controller?.abort();
        state.noticeRead?.controller.abort();
        state.events = [];
        state.notices.clear();
        state.noticeCursor = undefined;
        state.floor = undefined;
        state.traffic.clear();
        setWindow(state, {
          status: "error",
          rows: EMPTY_ROWS,
          error: describe(error),
          loadingOlder: false,
        });
      }
      setList(
        {
          ...list,
          channels: Object.freeze(
            list.channels.filter((channel) => channel.id !== channelId),
          ),
        },
        true,
      );
      void persistence?.remove(channelId).catch(() => {});
      saveDiscovery();
    }, [channelId]);
  }
  async function readPage(
    channelId: string,
    cursor: WindowCursor | null,
    settings: ReadOptions,
  ) {
    if (!transport) throw new Error("Relay is unavailable");
    const source = transport;
    const read = (signal?: AbortSignal) =>
      source.read([windowFilter(channelId, cursor)], {
        ...settings,
        ...(signal ? { signal } : {}),
      });
    // Head reads belong to session recovery; only manual pagination needs a
    // finite retry owner here.
    const events = cursor
      ? await retryRead(read, settings.signal ?? new AbortController().signal)
      : await read();
    return {
      events,
      page: parseWindow(channelId, cursor, transport.relayAuthor, events),
    };
  }
  async function requestHead(
    channelId: string,
    priority: Priority,
  ): Promise<Head> {
    const generation = epoch;
    const startedAt = now();
    const accessVersion = accessVersions.get(channelId) ?? 0;
    const controller = new AbortController();
    controllers.add(controller);
    let head: Head;
    try {
      if (disposed || !transport || !canReadRemote(channelId))
        throw new DOMException("Stale request", "AbortError");
      const { events, page } = await readPage(channelId, null, {
        signal: controller.signal,
        priority,
      });
      if (
        disposed ||
        generation !== epoch ||
        accessVersion !== (accessVersions.get(channelId) ?? 0) ||
        !authorized(channelId)
      )
        throw new DOMException("Stale request", "AbortError");
      const retained = heads.peek(channelId);
      if (retained?.events === events) return retained;
      head = {
        rows: Object.freeze(
          foldChannelMessages(channelId, transport.relayAuthor, page.events),
        ),
        cursor: page.cursor,
        hasMore: page.hasMore,
        events,
        savedAt: now(),
        cached: false,
      };
      if (
        head.rows.length > maxHistoryRows ||
        byteSize(head.rows) > maxHistoryBytes
      )
        throw new Error("Channel head exceeds the read budget");
    } catch (error) {
      relayDebug("head failed", channelId.slice(0, 8), readErrorKind(error));
      if (
        !disposed &&
        generation === epoch &&
        accessVersion === (accessVersions.get(channelId) ?? 0) &&
        readErrorKind(error) === "denied"
      )
        denyChannel(channelId, error);
      throw error;
    } finally {
      controllers.delete(controller);
    }
    relayDebug(
      "head",
      channelId.slice(0, 8),
      `${head.rows.length} rows ${now() - startedAt}ms ${priority}`,
    );
    heads.set(channelId, head);
    setList(list);
    // Durable message warmth must not wait behind optional name enrichment.
    const savedProfiles =
      generation === epoch ? save(channelId, head) : undefined;
    void fetchProfiles(
      head.rows,
      priority === "background" && intent !== channelId ? channelId : undefined,
    ).then(() => {
      const current = heads.peek(channelId);
      if (generation === epoch && current?.events === head.events)
        save(channelId, current, savedProfiles);
    });
    if (intent === channelId) prepareMedia(channelId);
    return head;
  }
  async function loadPage(state: WindowState, cursor: WindowCursor | null) {
    if (!transport || !canReadRemote(state.channelId)) return;
    const generation = state.generation;
    const controller = new AbortController();
    state.controller = controller;
    // Shown rows wait on this head read; a seek must not treat it as the end.
    if (!cursor && state.snapshot.status === "ready")
      setWindow(state, { refreshing: true });
    try {
      if (prepared && !cursor) {
        const head = await requestHead(state.channelId, "foreground");
        if (!live(state, generation)) return;
        adoptHead(state, head);
        return;
      }
      const { page } = await readPage(state.channelId, cursor, {
        signal: controller.signal,
      });
      // A settled catch-up aborts an older read that has already resolved.
      if (!live(state, generation) || controller.signal.aborted) return;
      const combined = new Map(
        (cursor ? state.events : []).map((event) => [event.id, event]),
      );
      for (const event of page.events) combined.set(event.id, event);
      const retained = [...combined.values()];
      const rows = Object.freeze(
        foldChannelMessages(state.channelId, transport.relayAuthor, retained),
      );
      if (
        rows.length > maxHistoryRows ||
        byteSize(retained) > maxHistoryBytes
      ) {
        setWindow(state, {
          loadingOlder: false,
          historyLimited: true,
          error: undefined,
        });
        return;
      }
      state.events = retained;
      state.atHead = !cursor;
      moveCursor(state, page.cursor);
      state.restored = false;
      if (dropped && !cursor) state.kept = rowIds(state);
      setWindow(state, {
        status: "ready",
        rows,
        hasMore: page.hasMore && page.cursor !== null,
        loadingOlder: false,
        error: undefined,
        freshness: "verified",
      });
      void fillNotices(state, !cursor);
      void fetchProfiles(rows);
    } catch (error) {
      if (isAbort(error) || !live(state, generation)) return;
      // A denied revalidation must not keep exposing a cached head.
      const denied = readErrorKind(error) === "denied";
      if (denied) {
        denyChannel(state.channelId, error);
        return;
      }
      setWindow(
        state,
        cursor || state.snapshot.rows.length
          ? { loadingOlder: false, error: describe(error), freshness: "cached" }
          : {
              status: "error",
              rows: EMPTY_ROWS,
              loadingOlder: false,
              error: describe(error),
            },
      );
    } finally {
      if (state.controller === controller) state.controller = undefined;
      // Aborted reads end here too; a newer head read keeps the flag.
      if (
        !state.controller &&
        state.snapshot.refreshing &&
        !disposed &&
        windows.get(state.channelId) === state
      )
        setWindow(state, { refreshing: undefined });
    }
  }
  async function hydrate() {
    const reveal = revealHydration;
    if (!persistence || !transport) return;
    const generation = epoch;
    let records: SavedHead[];
    try {
      records = await persistence.read();
    } catch {
      return;
    }
    if (
      !records.some((record) => record.channelId === options.initialChannelId)
    )
      reveal?.();
    while (records.length) {
      const priorityIndex = records.findIndex(
        (record) => record.channelId === intent,
      );
      const [record] = records.splice(
        priorityIndex >= 0 ? priorityIndex : 0,
        1,
      );
      if (!record) break;
      const initial = record.channelId === options.initialChannelId;
      const accessVersion = accessVersions.get(record.channelId) ?? 0;
      if (disposed || generation !== epoch) return;
      if (
        !allowed?.has(record.channelId) ||
        heads.peek(record.channelId) ||
        !Number.isFinite(record.savedAt) ||
        record.savedAt > now() ||
        now() - record.savedAt > 86_400_000
      ) {
        if (initial) reveal?.();
        continue;
      }
      try {
        // Verify in channel-sized batches and yield between them; cache parsing never monopolizes startup.
        // Persisted input is untrusted even if an in-memory test object carries nostr-tools'
        // cached verification symbol. Reconstruct only wire fields before verification.
        const verifySaved = (value: unknown) =>
          eventDto(JSON.parse(JSON.stringify(value)));
        const events: RelayEvent[] = [];
        for (let index = 0; index < record.events.length; index += 8) {
          const started = performance.now();
          const batch = record.events.slice(index, index + 8).map(verifySaved);
          clientMetrics.cpu(
            "verify.restore",
            performance.now() - started,
            batch.length,
          );
          events.push(...batch);
          await yieldToHost();
          if (
            disposed ||
            generation !== epoch ||
            accessVersion !== (accessVersions.get(record.channelId) ?? 0) ||
            !allowed?.has(record.channelId)
          )
            return;
        }
        if (heads.peek(record.channelId)) continue;
        const accessibleEvents = transport.visible(events);
        const page = parseWindow(
          record.channelId,
          null,
          transport.relayAuthor,
          accessibleEvents,
        );
        const rows = Object.freeze(
          foldChannelMessages(
            record.channelId,
            transport.relayAuthor,
            page.events,
          ),
        );
        const head: Head = {
          rows,
          events: accessibleEvents,
          cursor: page.cursor,
          hasMore: page.hasMore,
          savedAt: record.savedAt,
          cached: true,
          restored: true,
        };
        const verifiedProfiles: RelayEvent[] = [];
        for (let index = 0; index < record.profiles.length; index += 8) {
          for (const value of record.profiles.slice(index, index + 8)) {
            const candidate = value as { pubkey?: string; id?: string };
            const existing =
              candidate?.pubkey && directory.event(candidate.pubkey);
            // Reuse an already verified object, never the raw record that merely claims its ID.
            verifiedProfiles.push(
              existing && existing.id === candidate.id
                ? existing
                : verifySaved(value),
            );
          }
          await yieldToHost();
          if (
            disposed ||
            generation !== epoch ||
            accessVersion !== (accessVersions.get(record.channelId) ?? 0) ||
            !allowed?.has(record.channelId)
          )
            return;
        }
        if (heads.peek(record.channelId)) continue;
        directory.accept(verifiedProfiles);
        // Profile subscribers can synchronously revoke/regrant or clear the
        // session. That callback is a boundary just like an awaited read.
        if (disposed || generation !== epoch) return;
        transport.restored?.(accessibleEvents);
        // Evidence subscribers can synchronously revoke access or clear caches too.
        if (disposed || generation !== epoch || !authorized(record.channelId))
          return;
        heads.set(record.channelId, head);
        const state = windows.get(record.channelId);
        if (
          state &&
          (state.snapshot.status === "idle" ||
            state.snapshot.status === "loading")
        )
          adoptHead(state, head);
      } catch {
        /* Corrupt or unsigned cache records cannot reach the read model. */
      } finally {
        if (initial) reveal?.();
      }
      await yieldToHost();
    }
  }
  function saveDiscovery() {
    clearTimeout(discoverySave);
    discoverySave = undefined;
    if (!persistence?.writeStartup || !discovery || !transport || disposed)
      return;
    savedProfiles = new Map(
      [
        ...new Set(
          discovery
            .channels()
            .filter((channel) => !channel.cached)
            .flatMap((channel) => channel.participants ?? []),
        ),
      ]
        .slice(0, 1024)
        .map((id) => [id, directory.event(id)]),
    );
    void persistence
      .writeStartup({
        discovery: {
          savedAt: now(),
          relayAuthor: transport.relayAuthor,
          events: discovery.savedEvents(),
          profiles: [...savedProfiles.values()].filter(
            (event) => event !== undefined,
          ),
        },
      })
      .catch(() => {});
  }
  async function restoreStartup() {
    if (!persistence?.readStartup || !transport || !discovery) return;
    const generation = epoch;
    try {
      const saved = (await persistence.readStartup())?.discovery;
      if (
        !saved ||
        saved.relayAuthor !== transport.relayAuthor ||
        !Number.isFinite(saved.savedAt) ||
        saved.savedAt > now() ||
        now() - saved.savedAt > 86_400_000 ||
        !Array.isArray(saved.events) ||
        byteSize(saved) > 8 * 1024 * 1024
      )
        return;
      const events: RelayEvent[] = [];
      for (let index = 0; index < saved.events.length; index += 12) {
        events.push(
          ...saved.events
            .slice(index, index + 12)
            .map((value) => eventDto(JSON.parse(JSON.stringify(value)))),
        );
        await yieldToHost();
        if (disposed || generation !== epoch || discoveryObserved) return;
      }
      const profiles: RelayEvent[] = [];
      if (Array.isArray(saved.profiles) && saved.profiles.length <= 1024) {
        for (let index = 0; index < saved.profiles.length; index += 12) {
          for (const value of saved.profiles.slice(index, index + 12)) {
            try {
              profiles.push(eventDto(JSON.parse(JSON.stringify(value))));
            } catch {
              /* A bad optional label cannot discard valid conversation history. */
            }
          }
          await yieldToHost();
          if (disposed || generation !== epoch || discoveryObserved) return;
        }
      }
      if (disposed || generation !== epoch || discoveryObserved) return;
      applyDiscovery(events, undefined, undefined, true);
      const participants = new Set(
        discovery.channels().flatMap((channel) => channel.participants ?? []),
      );
      directory.accept(
        profiles.filter(
          (event) => event.kind === 0 && participants.has(event.pubkey),
        ),
      );
      await (options.initialChannelId ? initialHydration : hydration);
    } catch {
      // Missing, corrupt or unavailable device storage never blocks fresh reads.
    }
  }
  // Background reads deduplicate metadata versions; strong resolution revisits proof.
  type CreationRead = { version: string; complete: boolean };
  const creationReads = new Map<string, CreationRead>();
  async function readCreations(
    events: readonly RelayEvent[],
    settings?: ChannelReadOptions,
  ) {
    if (!transport || !discovery || options.cachedOnly) return;
    const pending = new Map<string, CreationRead>();
    const wanted = events.flatMap((event) => {
      const id = tag(event, "d");
      const identity = channelIdentity(event);
      if (
        event.kind !== 39000 ||
        tag(event, "t") !== "stream" ||
        event.pubkey !== transport.relayAuthor ||
        !id ||
        discovery.metadataVersion(id)?.id !== event.id ||
        discovery.get(id)?.parentChannelId ||
        !identity.creator ||
        (settings?.consistency !== "strong" &&
          creationReads.get(id)?.version === event.id)
      )
        return [];
      const read = { version: event.id, complete: false };
      creationReads.set(id, read);
      pending.set(id, read);
      return [{ id, creator: identity.creator }];
    });
    if (!wanted.length) return;
    const creators = new Map(wanted.map(({ id, creator }) => [id, creator]));
    // One filter names many channels and their creators. Discovery accepts a
    // creation only from its own channel's creator, so a cross match is ignored.
    const filters = [];
    for (
      let offset = 0;
      offset < wanted.length;
      offset += CREATION_READ_CHANNELS
    ) {
      const chunk = wanted.slice(offset, offset + CREATION_READ_CHANNELS);
      filters.push({
        kinds: [9007],
        ...(settings?.consistency ? { consistency: settings.consistency } : {}),
        authors: [...new Set(chunk.map(({ creator }) => creator))],
        "#h": chunk.map(({ id }) => id),
        limit: 2 * chunk.length,
      });
    }
    const generation = epoch;
    const controller = new AbortController();
    controllers.add(controller);
    const reader = transport;
    return (async () => {
      // The shared reader accepts at most four filters per request.
      for (let offset = 0; offset < filters.length; offset += 4) {
        const receipts = await reader.read(filters.slice(offset, offset + 4), {
          priority:
            settings?.consistency === "strong"
              ? (settings.priority ?? "foreground")
              : "background",
          signal: settings?.signal
            ? AbortSignal.any([settings.signal, controller.signal])
            : controller.signal,
        });
        settings?.signal?.throwIfAborted();
        if (disposed || generation !== epoch || controller.signal.aborted)
          throw new DOMException("Stale creation resolution", "AbortError");
        const creations = receipts.filter((event) => event.kind === 9007);
        const proved = new Set(
          creations.flatMap((event) => {
            const coordinates = event.tags.filter(([name]) => name === "h");
            const id =
              coordinates.length === 1 && coordinates[0]?.length === 2
                ? coordinates[0][1]
                : undefined;
            return id && event.pubkey === creators.get(id) ? [id] : [];
          }),
        );
        for (const filter of filters.slice(offset, offset + 4)) {
          // A filter cut at its limit may have left a channel's creation out.
          const cut =
            creations.filter((event) =>
              event.tags.some(
                ([name, id]) => name === "h" && filter["#h"].includes(id ?? ""),
              ),
            ).length >= filter.limit;
          for (const id of filter["#h"]) {
            const read = pending.get(id);
            if (
              read &&
              creationReads.get(id) === read &&
              (!cut || proved.has(id))
            )
              read.complete = true;
            else if (read && creationReads.get(id) === read)
              creationReads.delete(id);
          }
        }
        applyDiscovery(creations);
      }
    })()
      .catch((error) => {
        // Unavailable proof leaves an ordinary channel. A later metadata refresh
        // may retry; never turn a failed proof read into loss of channel access.
        for (const [id, read] of pending)
          if (!read.complete && creationReads.get(id) === read)
            creationReads.delete(id);
        throw error;
      })
      .finally(() => controllers.delete(controller));
  }
  function applyDiscovery(
    events: readonly RelayEvent[],
    complete?: ReadonlySet<string>,
    started?: ReadonlyMap<string, RelayEvent>,
    cached = false,
    readProof = true,
  ) {
    if (disposed || !transport || !discovery) return;
    if (!cached) discoveryObserved = true;
    started ??= discovery.rosterVersions();
    const accessRevision = discovery.accessRevision;
    const overflowRevision = discovery.overflowRevision;
    if (cached) discovery.restrictToKnown();
    const starting = [...windows.keys()].filter((id) =>
      discovery.isPending(id),
    );
    let discoveryChanged = false;
    for (const event of events) {
      discoveryChanged = discovery.accept(event, cached) || discoveryChanged;
      if (event.kind === 39000) {
        const id = tag(event, "d");
        if (id && discovery.metadataVersion(id)?.id === event.id) {
          if (cached) pendingMetadata.add(id);
          else pendingMetadata.delete(id);
        }
      }
    }
    if (discovery.overflowRevision !== overflowRevision) {
      coverage = "partial";
      complete = undefined;
    }
    // Only a complete viewer-scoped roster read proves absence; capped reads and live traffic never revoke by omission.
    if (complete) {
      discovery.retain(complete, started);
      coverage = undefined;
    }
    const confirmed = list.channels.filter(
      (channel) =>
        channel.cached &&
        !discovery.get(channel.id)?.cached &&
        discovery.canAccess(channel.id),
    );
    const readable = discovery.readable();
    const channels = Object.freeze(discovery.channels(readable));
    // A system channel never lists but stays readable: its saved history is
    // kept and restored like any other channel's.
    const nextAllowed = new Set(readable.map((channel) => channel.id));
    const known = new Set([
      ...(allowed ?? []),
      ...windows.keys(),
      ...heads.keys(),
      ...tails.keys(),
    ]);
    for (const id of known)
      if (!authorized(id)) {
        accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
        void persistence?.remove(id).catch(() => {});
      }
    allowed = nextAllowed;
    let appliedEpoch = epoch;
    const commit = () => {
      for (const state of [...windows.values()])
        if (!authorized(state.channelId)) evict(state);
      for (const id of heads.keys()) if (!authorized(id)) heads.delete(id);
      for (const id of tails.keys()) if (!authorized(id)) tails.delete(id);
      if (complete) void persistence?.retain([...nextAllowed]).catch(() => {});
      appliedEpoch = epoch;
      setList(
        {
          status: "ready",
          channels,
          ...(coverage ? { coverage } : {}),
          asOf: now(),
        },
        discoveryChanged,
      );
    };
    // Commit the final channel list before any projection subscriber runs.
    // A session-only generic view can retain channels unknown to this store.
    if (discovery.accessRevision !== accessRevision)
      transport.revokeAccess(commit);
    else commit();
    // Discovery authorizes disk reuse, not speculative reads of the roster.
    // Network heads belong to explicit demand/intent and retained live catch-up.
    if (prepared && !hydration) {
      const reveal = revealHydration;
      hydration = hydrate().finally(() => reveal?.());
    }
    // A started chat the relay just confirmed now reads its history and live tail.
    for (const id of starting) {
      const state = windows.get(id);
      if (!state || discovery.isPending(id) || !authorized(id)) continue;
      setWindow(state, { status: "idle" });
      if (current === id) queries.ensure(id);
    }
    if (!cached) {
      saveDiscovery();
      for (const channel of confirmed) {
        // Disk rows were display-only during hydration. Fresh membership now
        // makes that verified evidence usable for explicit read intent too.
        const saved = heads.peek(channel.id);
        if (saved) transport.restored?.(saved.events);
        if (windows.has(channel.id)) queries.ensure(channel.id);
      }
    }
    if (!cached && !disposed && readProof)
      void readCreations(events).catch(() => {});
    return !disposed && appliedEpoch === epoch;
  }
  /** The viewer's signed rosters among `batch`, at most DISCOVERY_CONFIRM_LIMIT
   * ids, by one exact viewer-scoped read. */
  async function readListed(
    batch: readonly string[],
    strong: boolean,
    signal: AbortSignal,
  ) {
    if (!transport) throw new Error("Relay is unavailable");
    const events = await transport.read(
      [
        {
          kinds: [39002],
          ...(strong ? { consistency: "strong" as const } : {}),
          authors: [transport.relayAuthor],
          "#d": batch,
          "#p": [transport.viewer],
          limit: batch.length + 1,
        },
      ],
      { signal, fresh: true },
    );
    if (
      events.length > batch.length ||
      events.some(
        (event) =>
          event.kind !== 39002 ||
          event.pubkey !== transport.relayAuthor ||
          !hasTag(event, "p", transport.viewer) ||
          !batch.includes(tag(event, "d") ?? ""),
      )
    )
      throw new ReadError(
        "invalid-response",
        "Channel discovery confirmation exceeded its read budget",
      );
    return events;
  }
  /** Of `ids`, those the writer's signed rosters do not list the viewer in.
   * Reads only: it confirms an omission before irreversible cleanup. */
  async function unlisted(ids: readonly string[], signal: AbortSignal) {
    if (disposed || options.cachedOnly) throw new Error("Relay is unavailable");
    const listed = new Set<string>();
    for (let offset = 0; offset < ids.length; offset += DISCOVERY_CONFIRM_LIMIT)
      for (const event of await readListed(
        ids.slice(offset, offset + DISCOVERY_CONFIRM_LIMIT),
        true,
        signal,
      ))
        listed.add(tag(event, "d") ?? "");
    return ids.filter((id) => !listed.has(id));
  }
  /** Apply roster authority as soon as it succeeds; names are a separate,
   * optional read and cannot delay revocation or overwrite newer live grants. */
  async function discover(force = false, strong = false) {
    if (disposed || !transport || !discovery || options.cachedOnly) return;
    // Hints/establishment during a read require a later read. During a quota
    // pause they retain an obligation, not another request with a deadline.
    if (force) listAgain = true;
    if (strong) strongListAgain = true;
    if (!listBusy && performance.now() < listRetryAt) {
      // A newly mounted reader still needs a settled result for its retry.
      // Publish the existing error without bypassing the relay's cooldown.
      if (list.status === "error") setList(list, true);
      return;
    }
    if (
      listBusy ||
      (!listAgain &&
        list.status === "ready" &&
        rosterRefresh.state === "verified")
    )
      return;
    listAgain = false;
    // A post-write request queued behind an older pass must keep writer routing.
    const consistency = strongListAgain
      ? { consistency: "strong" as const }
      : {};
    strongListAgain = false;
    listRetryAt = 0;
    listBusy = true;
    rosterRefresh = Object.freeze({ state: "pending" });
    transport.rosterChanged?.(consistency.consistency === "strong");
    if (disposed) {
      listBusy = false;
      return;
    }
    coverage = "partial";
    if (list.status !== "ready")
      setList({ status: "loading", channels: list.channels, coverage });
    if (disposed) {
      listBusy = false;
      return;
    }
    let generation = epoch;
    let controller = new AbortController();
    controllers.add(controller);
    const started = discovery.rosterVersions();
    const overflowRevision = discovery.overflowRevision;
    let readingRoster = true;
    let denyAllOnFailure = true;
    let outcome: RosterRefresh = { state: "deferred" };
    try {
      const ids = new Set<string>();
      let scannedBytes = 0;
      const named = new Set<string | undefined>();
      let cursor: RelayEvent | undefined;
      let complete: Set<string> | undefined;
      let retainedComplete = false;
      let paged = false;
      // NIP-CL: the relay leaves system channels out of the `#p` roster read
      // below, so a NIP-CL pass also reads them through their opt-in filter.
      // Their ids join the same complete set, which proves their loss like any
      // other channel's. They apply with the first roster page, never before
      // it: applying commits the list as ready.
      let system: RelayEvent[] = [];
      if (transport.channelIdentity) {
        let systemCursor: RelayEvent | undefined;
        for (;;) {
          if (scannedBytes >= discovery.maxBytes)
            throw new ReadError(
              "invalid-response",
              "System channel discovery exceeded its read budget",
            );
          const rosters = await transport.read(
            [
              {
                kinds: [39002],
                ...consistency,
                "#p": [transport.viewer],
                "#t": ["system"],
                limit: DISCOVERY_LIMIT,
                ...(systemCursor
                  ? {
                      until: systemCursor.created_at,
                      before_id: systemCursor.id,
                    }
                  : {}),
              },
            ],
            { signal: controller.signal },
          );
          if (disposed || generation !== epoch) return;
          scannedBytes += listByteSize(rosters);
          const members = rosters
            .filter(
              (event) =>
                event.kind === 39002 &&
                event.pubkey === transport.relayAuthor &&
                hasTag(event, "p", transport.viewer) &&
                hasTag(event, "t", "system") &&
                tag(event, "d"),
            )
            .sort(
              (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
            );
          const last = members.at(-1);
          if (
            !members.every(
              (event) =>
                !systemCursor ||
                event.created_at < systemCursor.created_at ||
                (event.created_at === systemCursor.created_at &&
                  event.id > systemCursor.id),
            ) ||
            (rosters.length >= DISCOVERY_LIMIT && !last)
          )
            throw new ReadError(
              "invalid-response",
              "System channel discovery cursor did not advance",
            );
          for (const event of members) {
            const id = tag(event, "d");
            if (id) ids.add(id);
          }
          system.push(...members);
          if (rosters.length < DISCOVERY_LIMIT) break;
          systemCursor = last;
          // A roster can move ahead of this cursor mid-scan, as below, so a
          // paged system read needs the same omission confirmation.
          paged = true;
        }
      }
      // Bound scanned bytes as well as retained evidence, including repeated versions.
      for (;;) {
        const rosters = await transport.read(
          [
            {
              kinds: [39002],
              ...consistency,
              "#p": [transport.viewer],
              limit: DISCOVERY_LIMIT,
              ...(cursor
                ? { until: cursor.created_at, before_id: cursor.id }
                : {}),
            },
          ],
          { signal: controller.signal },
        );
        if (disposed || generation !== epoch) return;
        scannedBytes += listByteSize(rosters);
        const members = rosters
          .filter(
            (event) =>
              event.kind === 39002 &&
              event.pubkey === transport.relayAuthor &&
              hasTag(event, "p", transport.viewer) &&
              tag(event, "d"),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          );
        for (const event of members) {
          const id = tag(event, "d");
          if (id) ids.add(id);
        }
        for (const event of rosters)
          if (event.kind === 39000 && event.pubkey === transport.relayAuthor)
            named.add(tag(event, "d"));
        const last = members.at(-1);
        const advances =
          members.every(
            (event) =>
              !cursor ||
              event.created_at < cursor.created_at ||
              (event.created_at === cursor.created_at && event.id > cursor.id),
          ) &&
          (rosters.length < DISCOVERY_LIMIT || !!last);
        const shortPage = advances && rosters.length < DISCOVERY_LIMIT;
        const pageComplete = shortPage ? ids : undefined;
        const evidence = system.length ? [...system, ...rosters] : rosters;
        system = [];
        if (
          !applyDiscovery(
            evidence,
            pageComplete && !paged ? pageComplete : undefined,
            started,
          )
        )
          return;
        const overflowed = discovery.overflowRevision !== overflowRevision;
        if (overflowed) complete = undefined;
        if (disposed || (!shortPage && generation !== epoch)) return;
        if (!advances)
          throw new ReadError(
            "invalid-response",
            "Channel discovery cursor did not advance",
          );
        if (shortPage && !overflowed) {
          complete = ids;
          retainedComplete = !paged;
          break;
        }
        if (overflowed || scannedBytes >= discovery.maxBytes) break;
        cursor = last;
        paged = true;
      }
      if (complete && !retainedComplete) {
        denyAllOnFailure = false;
        const current = discovery.rosterVersions();
        const omitted = paged
          ? [...started].flatMap(([id, roster]) =>
              !complete?.has(id) &&
              current.get(id) === roster &&
              hasTag(roster, "p", transport.viewer) &&
              discovery.authorized(id)
                ? [id]
                : [],
            )
          : [];
        for (
          let offset = 0;
          offset < omitted.length;
          offset += DISCOVERY_CONFIRM_LIMIT
        ) {
          const confirmations = await readListed(
            omitted.slice(offset, offset + DISCOVERY_CONFIRM_LIMIT),
            consistency.consistency === "strong",
            controller.signal,
          );
          if (disposed || generation !== epoch) return;
          for (const event of confirmations) {
            const id = tag(event, "d");
            if (id) complete.add(id);
          }
          applyDiscovery(confirmations);
          if (disposed || generation !== epoch) return;
        }
        if (discovery.overflowRevision !== overflowRevision)
          complete = undefined;
        if (complete && !applyDiscovery([], complete, started)) return;
      }
      if (complete) transport.rosterComplete?.();
      const wanted = [...ids].filter(
        (id) =>
          discovery.authorized(id) &&
          !named.has(id) &&
          (force || pendingMetadata.has(id) || !discovery.named(id)),
      );
      generation = epoch;
      readingRoster = false;
      denyAllOnFailure = false;
      // Applying our own complete roster can invalidate the original request.
      // Metadata gets a fresh cancellation owner, never another completeness set.
      controllers.delete(controller);
      controller = new AbortController();
      controllers.add(controller);
      for (let offset = 0; offset < wanted.length; offset += DISCOVERY_LIMIT) {
        const metadata = await transport.read(
          [
            {
              kinds: [39000],
              ...consistency,
              "#d": wanted.slice(offset, offset + DISCOVERY_LIMIT),
              limit: DISCOVERY_LIMIT,
            },
          ],
          { signal: controller.signal },
        );
        if (disposed || generation !== epoch) return;
        for (const id of wanted.slice(offset, offset + DISCOVERY_LIMIT))
          checkedMetadata.add(id);
        applyDiscovery(metadata);
        if (disposed || generation !== epoch) return;
      }
      if (!disposed && generation === epoch) outcome = { state: "verified" };
    } catch (error) {
      if (disposed || generation !== epoch) return;
      outcome = isAbort(error)
        ? { state: "deferred" }
        : {
            state: "error",
            error: describe(error),
            ...(isTransientFailure(error) ? { transient: true as const } : {}),
          };
      if (error instanceof ReadError && error.retryAfterMs !== undefined)
        listRetryAt = performance.now() + error.retryAfterMs;
      if (denyAllOnFailure && readErrorKind(error) === "denied") {
        discovery.denyAll();
        transport.revokeAccess(() => {
          for (const id of allowed ?? [])
            accessVersions.set(id, (accessVersions.get(id) ?? 0) + 1);
          allowed = new Set();
          for (const state of [...windows.values()]) evict(state);
          heads.clear();
          tails.clear();
          clearTimeout(discoverySave);
          discoverySave = undefined;
          void persistence?.clear().catch(() => {});
          setList({
            status: "error",
            channels: Object.freeze([]),
            coverage: "partial",
            error: describe(error),
          });
        });
      } else {
        // Failed names do not discard successful membership authority.
        if (!readingRoster) applyDiscovery([]);
        setList({ ...list, status: "error", error: describe(error) });
      }
    } finally {
      // Failure or interruption has not fulfilled the writer requirement, even
      // after roster authority landed. Restore it before a queued pass starts.
      if (
        !disposed &&
        consistency.consistency === "strong" &&
        outcome.state !== "verified"
      )
        strongListAgain = true;
      controllers.delete(controller);
      if (!disposed && readingRoster) {
        coverage = "partial";
        setList({ ...list, coverage });
      }
      listBusy = false;
      if (!disposed) {
        rosterRefresh = Object.freeze(outcome);
        // Stale work cannot consume a newer hint or certify freshness. A failed
        // read waits for deliberate retry/a later hint instead of draining work.
        if (
          (listAgain || (generation !== epoch && revokedEpoch === epoch)) &&
          outcome.state !== "error"
        )
          void discover(true);
        else transport.rosterChanged?.();
        if (outcome.state === "verified")
          for (const id of windows.keys()) revalidateCached(id);
      }
    }
  }
  /** Resolve only returned/demanded nonmember channels, through the verified reader.
   *
   * Search, channel-writes.ts `refresh`, findLabeled, and session.ts membership
   * hints rely on these properties. The create-channel path guards them with real-store tests
   * in channel-writes.test.ts rather than through this store's own suite:
   * - The id filter keeps every channel the store does not yet authorize, so a
   *   just-created channel is confirmed by one exact `#d` read instead of the
   *   full viewer-roster rediscovery. Skipping such ids would send every create
   *   back through the full pass. Session hints route held channels to the full
   *   pass because this filter skips them (including unarchive triggers). See
   *   "admits a created ... channel through the store's exact read without
   *   rediscovering the roster". A member addition to a joined channel is
   *   confirmed by `refreshRoster` below, not by widening this filter.
   * - Events apply through `applyDiscovery`, which always commits the list as
   *   `ready`. Only resolve into a list discovery has already made ready; on an
   *   idle, loading or error list this would publish a ready list holding just
   *   these channels and hide a failed initial discovery. See "creates a channel
   *   during initial discovery without committing a list of only that channel";
   *   its check that every ready snapshot carries the first page's channel is
   *   the canonical regression test.
   * - Every call is a fresh read that the reader never merges with an identical
   *   read in flight. The session coalesces hints across deliveries and skips
   *   ids it is already confirming; a full pass that starts later retires
   *   those confirmations, so a delayed grant cannot outlive the complete roster. */
  async function resolve(
    channelIds: readonly string[],
    settings?: ChannelReadOptions,
    unnamed = false,
  ) {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    // `unnamed` also reads an authorized channel whose metadata has not
    // arrived yet (the full pass applies rosters before it reads names):
    // a label lookup needs its creator and labels now, not after the pass.
    const ids = [...new Set(channelIds)].filter(
      (id) =>
        !discovery.authorized(id) ||
        discovery.get(id)?.cached ||
        !discovery.metadataVersion(id) ||
        (unnamed && !discovery.named(id)) ||
        (settings?.consistency === "strong" &&
          !discovery.get(id)?.parentChannelId),
    );
    if (!ids.length) return;
    if (ids.length > 128) throw new Error("Too many search result channels");
    const generation = epoch;
    const started = new Map(
      ids.map((id) => [id, discovery.metadataVersion(id)]),
    );
    const cachedRosters = discovery.rosterVersions();
    let events: readonly RelayEvent[];
    try {
      events = await transport.read(
        [
          {
            kinds: [39000],
            ...(settings?.consistency
              ? { consistency: settings.consistency }
              : {}),
            authors: [transport.relayAuthor],
            "#d": ids,
            limit: ids.length + 1,
          },
          {
            kinds: [39002],
            ...(settings?.consistency
              ? { consistency: settings.consistency }
              : {}),
            authors: [transport.relayAuthor],
            "#d": ids,
            "#p": [transport.viewer],
            limit: ids.length + 1,
          },
        ],
        { ...settings, fresh: true },
      );
    } catch (error) {
      const [id] = ids;
      if (
        !disposed &&
        generation === epoch &&
        !settings?.signal?.aborted &&
        ids.length === 1 &&
        id &&
        discovery.get(id)?.cached &&
        readErrorKind(error) === "denied"
      )
        denyChannel(id, error);
      throw error;
    }
    settings?.signal?.throwIfAborted();
    if (disposed || generation !== epoch)
      throw new DOMException("Stale channel resolution", "AbortError");
    if (
      [39000, 39002].some(
        (kind) =>
          events.filter((event) => event.kind === kind).length > ids.length,
      )
    )
      throw new Error("Channel discovery exceeded its read budget");
    // Successful verified lookup may restore the same public version after CLOSED.
    // Missing/failed evidence leaves a suspension recoverable rather than granting access.
    let resumed = false;
    for (const id of ids) {
      if (
        events.some(
          (event) =>
            event.pubkey === transport.relayAuthor &&
            tag(event, "d") === id &&
            (event.kind === 39000 ||
              (event.kind === 39002 && hasTag(event, "p", transport.viewer))),
        )
      )
        resumed =
          discovery.resume(
            id,
            events.find(
              (event) =>
                event.kind === 39000 &&
                event.pubkey === transport.relayAuthor &&
                tag(event, "d") === id,
            ),
          ) || resumed;
    }
    for (const id of ids) checkedMetadata.add(id);
    // A bounded exact roster fills omissions from capped discovery. Apply grants
    // before private metadata so a newly resolved member never transiently loses access.
    applyDiscovery(
      [
        ...events.filter((event) => event.kind === 39002),
        ...events.filter((event) => event.kind !== 39002),
      ],
      undefined,
      undefined,
      false,
      settings?.consistency !== "strong",
    );
    if (resumed) setList(list, true);
    // Exact viewer-scoped omission is complete for this ID, unlike a capped
    // global roster. Cached membership cannot fall back to public metadata.
    for (const id of ids) {
      if (
        discovery.get(id)?.cached &&
        discovery.rosterVersions().get(id) === cachedRosters.get(id) &&
        !events.some(
          (event) =>
            event.kind === 39002 &&
            event.pubkey === transport.relayAuthor &&
            tag(event, "d") === id &&
            hasTag(event, "p", transport.viewer),
        )
      )
        denyChannel(id, new Error("Conversation is unavailable"));
      // Missing evidence cannot keep an earlier public preview readable.
      if (
        !events.some(
          (event) =>
            event.kind === 39000 &&
            event.pubkey === transport.relayAuthor &&
            tag(event, "d") === id,
        )
      ) {
        if (
          (discovery.get(id)?.readOnly ||
            discovery.suspendedChannels().includes(id)) &&
          started.get(id) === discovery.metadataVersion(id)
        )
          denyChannel(id, new Error("Conversation is unavailable"));
      } else if (!discovery.named(id))
        throw new Error("Channel metadata capacity unavailable");
    }
    if (settings?.consistency === "strong")
      await readCreations(
        ids.flatMap((id) => {
          const current = discovery.metadataVersion(id);
          return current ? [current] : [];
        }),
        settings,
      );
  }
  /** Find active public channels the viewer has not joined, by name.
   * The relay has no metadata text search, so this keeps a bounded directory
   * of relay-signed 39000 metadata: periodic full reads and overlapping deltas
   * (shared while typing, see PUBLIC_CHANNEL_PAGE_TTL). It ranks locally and admits only
   * the best matches through `resolve`. Matches become readable
   * previews through `get`; they never enter `list()`. */
  let publicDirectory:
    | {
        generation: number;
        /** When the read finished; a pending read is always reused. */
        at?: number;
        started: number;
        fullAt: number;
        partial?: boolean;
        incremental: boolean;
        /** Exact resolution contradicted a candidate; replace this index. */
        reconcile?: boolean;
        /** The pages read so far, newest first. */
        events: RelayEvent[];
        /** Indexed once; prior candidates remain searchable during refresh. */
        previous?: Map<string, RelayEvent>;
        /** Settles when the next page lands or the read ends. */
        page: Promise<void>;
        read: Promise<{ partial: boolean }>;
        /** A refresh of a finished read, whose names it keeps meanwhile. */
        refresh: boolean;
        /** The finished read's open channels (the prior read's during a
         * refresh), newest metadata per channel. */
        open?: ReturnType<NonNullable<ChannelQueries["openDirectory"]>>;
        /** A first read's open channels so far, for browsing only. */
        pages?: ReturnType<NonNullable<ChannelQueries["openDirectory"]>>;
      }
    | undefined;
  const noOpenDirectory: ReturnType<
    NonNullable<ChannelQueries["openDirectory"]>
  > = Object.freeze([]);
  function latestPublicMetadata(
    events: readonly RelayEvent[],
    previous?: ReadonlyMap<string, RelayEvent>,
  ) {
    const latest = new Map(previous);
    for (const event of events) {
      const id = tag(event, "d");
      if (id) latest.set(id, newer(latest.get(id), event));
    }
    return latest;
  }
  type DirectoryChannel = ReturnType<
    NonNullable<ChannelQueries["openDirectory"]>
  >[number];
  function directoryChannel(
    id: string,
    event: RelayEvent,
  ): DirectoryChannel | undefined {
    const name = openMetadata(event) && metadataName(event);
    if (!name) return undefined;
    const type = tag(event, "t");
    return Object.freeze({
      id,
      name,
      ...(type === "stream" || type === "forum" ? { channelType: type } : {}),
      ...(tag(event, "about") ? { description: tag(event, "about") } : {}),
      ...(hasTag(event, "archived", "true") ? { archived: true as const } : {}),
    });
  }
  function openDirectoryChannels(events: readonly RelayEvent[]) {
    return Object.freeze(
      [...latestPublicMetadata(events).entries()].flatMap(([id, event]) => {
        const channel = directoryChannel(id, event);
        return channel ? [channel] : [];
      }),
    );
  }
  /** A first read's channels, folded a page at a time: each page projects
   * only its own events, in the order the relay sent them. */
  function directoryPages() {
    const latest = new Map<string, RelayEvent>();
    const channels = new Map<string, DirectoryChannel | undefined>();
    let folded = 0;
    return (events: readonly RelayEvent[]) => {
      for (const event of events.slice(folded)) {
        const id = tag(event, "d");
        if (!id) continue;
        const previous = latest.get(id);
        const next = newer(previous, event);
        if (next === previous) continue;
        latest.set(id, next);
        channels.set(id, directoryChannel(id, next));
      }
      folded = events.length;
      return Object.freeze(
        [...channels.values()].filter(
          (channel): channel is DirectoryChannel => !!channel,
        ),
      );
    };
  }
  /** All open channels' metadata, newest first, through the relay's
   * `(until, before_id)` cursor. One read serves every keystroke: a caller
   * that stops waiting leaves it running for the next one. */
  async function readPublicDirectory(
    relay: RelayReader & { relayAuthor: string },
    generation: number,
    signal: AbortSignal,
    events: RelayEvent[],
    landed: () => void,
    since?: number,
  ) {
    let cursor: { until: number; before_id: string } | undefined;
    for (;;) {
      const page = await relay.read(
        [
          {
            kinds: [39000],
            authors: [relay.relayAuthor],
            limit: publicDirectoryPage,
            ...(since !== undefined ? { since } : {}),
            ...cursor,
          },
        ],
        { signal, priority: "foreground", fresh: true },
      );
      signal.throwIfAborted();
      if (disposed || generation !== epoch)
        throw new DOMException("Stale channel search", "AbortError");
      events.push(
        ...page.filter(
          (event) => event.kind === 39000 && event.pubkey === relay.relayAuthor,
        ),
      );
      if (page.length < publicDirectoryPage) return { partial: false };
      if (events.length >= maxPublicDirectory) return { partial: true };
      landed();
      // Relay query order is time descending, then ID ascending (also at ties).
      const last = [...page]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .at(-1);
      if (
        !last ||
        (cursor &&
          (last.created_at > cursor.until ||
            (last.created_at === cursor.until && last.id <= cursor.before_id)))
      )
        throw new Error("Public channel search did not advance");
      cursor = { until: last.created_at, before_id: last.id };
    }
  }
  /** The shared directory read for this epoch: the one in flight, a
   * finished one still fresh, or a new full read or delta. Candidates only:
   * a page never grants access by itself. */
  function currentPublicDirectory(
    relay: RelayReader & { relayAuthor: string },
    generation: number,
  ): NonNullable<typeof publicDirectory> {
    if (
      publicDirectory?.generation !== generation ||
      (publicDirectory.at !== undefined &&
        (publicDirectory.reconcile ||
          now() < publicDirectory.started ||
          now() - publicDirectory.fullAt >= PUBLIC_CHANNEL_RECONCILE ||
          now() - publicDirectory.at >= PUBLIC_CHANNEL_PAGE_TTL))
    ) {
      const controller = new AbortController();
      controllers.add(controller);
      // A refresh keeps naming the prior read's channels until it completes;
      // mounted `#name` links do not blink off while the pages are in flight.
      const prior =
        publicDirectory?.generation === generation
          ? publicDirectory
          : undefined;
      const events: RelayEvent[] = [];
      const started = now();
      const incremental =
        prior?.at !== undefined &&
        prior.partial === false &&
        !prior.reconcile &&
        started >= prior.started &&
        started - prior.fullAt < PUBLIC_CHANNEL_RECONCILE;
      const since = incremental
        ? Math.max(
            0,
            Math.floor((prior.started - PUBLIC_CHANNEL_OVERLAP) / 1000),
          )
        : undefined;
      let land = () => {};
      const next = () => new Promise<void>((settle) => (land = settle));
      const fold = directoryPages();
      const read = (since?: number) =>
        readPublicDirectory(
          relay,
          generation,
          controller.signal,
          events,
          () => {
            const landed = land;
            entry.page = next();
            landed();
            // A first read shows its channels a page at a time, so browsing
            // starts on the first page; a refresh keeps the prior ones whole.
            // Only browsing hears pages: name references wait for the end.
            if (!entry.refresh) {
              entry.pages = fold(events);
              notify(directoryListeners);
            }
          },
          since,
        );
      const entry: NonNullable<typeof publicDirectory> = {
        generation,
        refresh: !!prior?.open,
        started,
        fullAt: incremental ? prior.fullAt : started,
        incremental,
        events,
        ...(prior ? { previous: latestPublicMetadata(prior.events) } : {}),
        page: next(),
        read: read(since).then((result) => {
          if (incremental) {
            const merged = [
              ...latestPublicMetadata(events, entry.previous).values(),
            ];
            if (result.partial || merged.length > maxPublicDirectory) {
              // An incomplete delta cannot advance a complete directory.
              entry.incremental = false;
              entry.fullAt = started;
              events.length = 0;
              return read();
            }
            events.splice(0, events.length, ...merged);
          }
          return result;
        }),
        ...(prior?.open ? { open: prior.open } : {}),
      };
      publicDirectory = entry;
      // A failed read is not reused: the expired prior entry comes back, so
      // its names survive and the next keystroke starts again.
      void entry.read.then(
        ({ partial }) => {
          controllers.delete(controller);
          entry.at = now();
          entry.partial = partial;
          delete entry.previous;
          delete entry.pages;
          // Name references in mounted rows read the directory through the
          // list subscription; the list itself is unchanged.
          entry.open = openDirectoryChannels(entry.events);
          notify(listListeners);
          notify(directoryListeners);
          land();
        },
        () => {
          controllers.delete(controller);
          if (publicDirectory === entry) {
            publicDirectory = prior;
            if (entry.pages) notify(directoryListeners);
          }
          land();
        },
      );
    }
    return publicDirectory;
  }
  /** Read the whole open-channel directory, for browsing. Shares the search
   * read; `openDirectory` then names its channels. Never resolves them. */
  async function readDirectory(
    settings?: { signal?: AbortSignal | undefined },
    recover = true,
  ): Promise<{ partial: boolean }> {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    if (list.status !== "ready")
      throw new Error("Channel list is not ready for channel browsing");
    const generation = epoch;
    const signal = settings?.signal;
    signal?.throwIfAborted();
    const read = currentPublicDirectory(transport, generation).read;
    const stale = new DOMException("Stale channel directory", "AbortError");
    try {
      const result = await (signal
        ? Promise.race([
            read,
            new Promise<never>((_, reject) =>
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              }),
            ),
          ])
        : read);
      if (disposed || generation !== epoch) throw stale;
      return result;
    } catch (error) {
      // An access change since this read began voids whatever it settled
      // with. One restarts it, as searchPublic does; further changes and
      // network failures keep the caller's retry.
      if (
        recover &&
        !disposed &&
        !signal?.aborted &&
        generation !== epoch &&
        revokedEpoch === epoch
      )
        return readDirectory(settings, false);
      throw error;
    }
  }
  /** Recent member counts, by channel, for this epoch. */
  let memberCounts:
    | { generation: number; counts: Map<string, { count: number; at: number }> }
    | undefined;
  /** How many members each open channel has, for browsing. Joined channels
   * answer from their roster; others read the relay-signed roster, which an
   * open channel publishes to anyone. Display only: never grants access. */
  async function readMemberCounts(
    channelIds: readonly string[],
    settings?: { signal?: AbortSignal | undefined },
  ): Promise<{
    counts: ReadonlyMap<string, number>;
    failed: readonly string[];
  }> {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    const relay = transport;
    const generation = epoch;
    if (memberCounts?.generation !== generation)
      memberCounts = { generation, counts: new Map() };
    const { counts } = memberCounts;
    const answer = new Map<string, number>();
    const missing: string[] = [];
    for (const id of new Set(channelIds)) {
      const members = discovery.authorized(id)
        ? discovery.get(id)?.members?.length
        : undefined;
      const known = counts.get(id);
      if (members !== undefined) answer.set(id, members);
      else if (known && now() - known.at < REFERENCE_TTL)
        answer.set(id, known.count);
      else missing.push(id);
    }
    // A roster can run to hundreds of KB, so reads stay small and run side
    // by side. Each keeps what it found even when another fails.
    const failed: string[] = [];
    const chunks: string[][] = [];
    for (let start = 0; start < missing.length; start += MEMBER_COUNT_CHUNK)
      chunks.push(missing.slice(start, start + MEMBER_COUNT_CHUNK));
    const read = async (ids: string[]) => {
      const events = await relay.read(
        [
          {
            kinds: [39002],
            authors: [relay.relayAuthor],
            "#d": ids,
            limit: ids.length,
          },
        ],
        {
          ...(settings?.signal ? { signal: settings.signal } : {}),
          // On screen now, so it doesn't queue behind background lookups.
          priority: "foreground",
          fresh: true,
        },
      );
      if (settings?.signal?.aborted || disposed || generation !== epoch) return;
      const latest = new Map<string, RelayEvent>();
      for (const event of events) {
        const id = tag(event, "d");
        if (
          event.kind === 39002 &&
          event.pubkey === relay.relayAuthor &&
          id &&
          ids.includes(id)
        )
          latest.set(id, newer(latest.get(id), event));
      }
      for (const [id, event] of latest) {
        const count = new Set(
          event.tags.flatMap(([name, value]) =>
            name === "p" && value ? [value] : [],
          ),
        ).size;
        counts.set(id, { count, at: now() });
        answer.set(id, count);
      }
    };
    await Promise.all(
      chunks.map((ids) => read(ids).catch(() => failed.push(...ids))),
    );
    settings?.signal?.throwIfAborted();
    if (disposed || generation !== epoch)
      throw new DOMException("Stale member counts", "AbortError");
    return { counts: answer, failed };
  }
  async function searchPublic(
    query: string,
    settings?: ReadOptions & {
      limit?: number;
      exact?: boolean;
      progress?: ((found: PublicChannelSearch) => void) | undefined;
    },
    recover = true,
  ): Promise<PublicChannelSearch> {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    if (!needle) return { channels: [], partial: false };
    if (list.status !== "ready")
      throw new Error("Channel list is not ready for channel search");
    const generation = epoch;
    // Candidates only: `resolve` below re-reads each match, so a reused page
    // never grants access by itself.
    const entry = currentPublicDirectory(transport, generation);
    const signal = settings?.signal;
    const limit = settings?.limit ?? 8;
    const resolved = new Set<string>();
    const refreshRequired = new ReadError(
      "unavailable",
      "Public channel directory changed during search",
    );
    // Ranks the pages read so far. Exact resolution, not a page, owns access:
    // it re-reads the signed metadata and the viewer roster for each match
    // before granting a preview. The final answer re-reads every match; pages
    // in flight resolve at most `limit` channels in all and leave every
    // search in flight, and one that joins later (`in:team data` runs two),
    // one response byte budget for its final answer, so a long read
    // cannot fill discovery or crowd out a better match on a later page.
    const answer = async (final: boolean, readSignal?: AbortSignal) => {
      // Saved names are candidates only: each match still resolves freshly.
      // Only the new scan contributes to the final answer.
      const latest = latestPublicMetadata(
        entry.events,
        !final ? entry.previous : undefined,
      );
      const candidates = [...latest.entries()]
        .flatMap(([id, event]) => {
          const name = metadataName(event);
          // Rank last: it is the costly check.
          const rank =
            name &&
            openMetadata(event) &&
            !event.tags.some(
              ([key, value]) => key === "archived" && value === "true",
            ) &&
            !discovery.authorized(id)
              ? publicRank(name, needle, settings?.exact)
              : undefined;
          return name && rank !== undefined ? [{ id, name, rank }] : [];
        })
        // Best match first before the cut, so an exact name is never dropped.
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        );
      const ids = candidates.slice(0, limit).map(({ id }) => id);
      const unresolved = final
        ? ids
        : ids
            .filter((id) => !resolved.has(id))
            .slice(
              0,
              discovery.byteHeadroom() - publicSearchReserve >=
                PUBLIC_CHANNEL_RESERVE_BYTES * 2
                ? Math.max(0, limit - resolved.size)
                : 0,
            );
      if (unresolved.length) {
        await resolve(
          unresolved,
          readSignal ? { ...settings, signal: readSignal } : settings,
        );
        const stale = new Set(
          unresolved.filter((id) => {
            const current = discovery.metadataVersion(id);
            const candidate = latest.get(id);
            return (
              !current ||
              !candidate ||
              !openMetadata(current) ||
              hasTag(current, "archived", "true") ||
              metadataName(current) !== metadataName(candidate)
            );
          }),
        );
        if (stale.size) {
          // Exact reads can beat directory pages. Retain their signed newer
          // versions, and never discard a newer page that landed meanwhile.
          const kept = latestPublicMetadata(entry.events);
          for (const id of stale) {
            const current = discovery.metadataVersion(id);
            const landed = kept.get(id);
            const candidate = latest.get(id);
            if (current) kept.set(id, newer(landed, newer(candidate, current)));
            else if (
              !landed ||
              !candidate ||
              newer(candidate, landed).id === candidate.id
            )
              kept.delete(id);
          }
          // Keep the in-flight array: subsequent pages append here.
          entry.events.splice(0, entry.events.length, ...kept.values());
          for (const id of stale) entry.previous?.delete(id);
          if (final && entry.incremental) {
            entry.reconcile = true;
            // Only the answer that found stale candidates needs to restart.
            // Avoid an unbounded tail that could consume discovery capacity.
            throw refreshRequired;
          }
        }
        for (const id of unresolved) resolved.add(id);
      }
      // A better match past the budget does not hide the rows already shown.
      return (final ? ids : candidates.map(({ id }) => id))
        .flatMap((id) => {
          const channel = resolved.has(id) && previewable(id);
          return channel &&
            publicRank(channel.name, needle, settings?.exact) !== undefined
            ? [channel]
            : [];
        })
        .slice(0, limit);
    };
    signal?.throwIfAborted();
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
    // A search that joins a read in flight ranks its landed pages at once.
    let page =
      entry.events.length || entry.previous?.size
        ? Promise.resolve()
        : entry.page;
    publicSearchReserve += PUBLIC_CHANNEL_RESERVE_BYTES;
    try {
      for (;;) {
        const result = await Promise.race([
          entry.read,
          page.then(() => undefined),
          aborted,
        ]);
        if (disposed || generation !== epoch)
          throw new DOMException("Stale channel search", "AbortError");
        if (result) {
          const channels = await answer(true);
          signal?.throwIfAborted();
          if (disposed || generation !== epoch)
            throw new DOMException("Stale channel search", "AbortError");
          recentPublic = { generation, ids: channels.map(({ id }) => id) };
          return { channels, partial: result.partial };
        }
        // A page that lands while this one is ranked wakes the next turn at once.
        page = entry.page;
        if (settings?.progress) {
          const provisional = new AbortController();
          try {
            const channels = await Promise.race([
              answer(false, provisional.signal).catch(() =>
                entry.read.then(() => undefined),
              ),
              entry.read.then(
                () => undefined,
                () => new Promise<never>(() => {}),
              ),
              aborted,
            ]);
            // A completed directory supersedes provisional work and its errors.
            if (!channels) continue;
            // Kept for the next keystroke too: its fallback would otherwise lose
            // these rows until its own first page resolves.
            if (generation === epoch)
              recentPublic = { generation, ids: channels.map(({ id }) => id) };
            signal?.throwIfAborted();
            settings.progress({ channels, partial: false });
          } finally {
            provisional.abort();
          }
        }
      }
    } catch (error) {
      if (
        !disposed &&
        !signal?.aborted &&
        (error === refreshRequired ||
          (isAbort(error) && generation !== epoch && revokedEpoch === epoch))
      ) {
        // One local invalidation restarts immediately. Further changes use
        // the existing retry owner; network failures keep its normal backoff.
        if (recover) return searchPublic(query, settings, false);
        throw refreshRequired;
      }
      throw error;
    } finally {
      publicSearchReserve -= PUBLIC_CHANNEL_RESERVE_BYTES;
    }
  }
  /** The post-join fallback's candidates: flagged, active, public, not joined;
   * in the list's own order (name, then id). */
  async function defaultChannels(settings?: ReadOptions) {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    if (list.status !== "ready")
      throw new Error("Channel list is not ready for channel search");
    const generation = epoch;
    // Candidates only: a join re-reads each one, so a reused page never
    // grants access by itself.
    const entry = currentPublicDirectory(transport, generation);
    const signal = settings?.signal;
    signal?.throwIfAborted();
    await new Promise<unknown>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      entry.read.then(resolve, reject);
    });
    if (disposed || generation !== epoch)
      throw new DOMException("Stale channel search", "AbortError");
    return [...latestPublicMetadata(entry.events).entries()]
      .filter(
        ([id, event]) =>
          openMetadata(event) &&
          !hasTag(event, "archived", "true") &&
          event.tags.some(([key]) => key === "auto_join") &&
          !discovery?.authorized(id),
      )
      .map(([id, event]) => ({ id, name: metadataName(event) ?? "" }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map(({ id }) => id);
  }
  /** NIP-CL lookup: the channels `creator` made with `label`, oldest first.
   * The page only names candidates; `resolve` re-reads each one before it
   * becomes readable through `get`. Matches never enter `list()`. */
  async function findLabeled(
    query: Readonly<{ creator: string; label: string }>,
    settings?: ChannelReadOptions,
  ): Promise<readonly ChannelSummary[]> {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    // An old relay ignores the label filter; "none found" would be a guess.
    if (!transport.channelIdentity) throw channelIdentityUnsupported();
    if (!/^[0-9a-f]{64}$/.test(query.creator))
      throw new Error("Choose a valid channel creator.");
    channelLabelTags([query.label]);
    const generation = epoch;
    const events = await transport.read(
      [
        {
          kinds: [39000],
          ...(settings?.consistency
            ? { consistency: settings.consistency }
            : {}),
          authors: [transport.relayAuthor],
          "#P": [query.creator],
          "#t": [query.label],
          limit: LABELED_CHANNEL_PAGE,
        },
      ],
      { ...settings, fresh: true },
    );
    settings?.signal?.throwIfAborted();
    if (disposed || generation !== epoch)
      throw new DOMException("Stale channel lookup", "AbortError");
    // Check the relay's answer: only relay-signed metadata whose creator and
    // labels match. A label alone proves nothing; the creator tag does.
    const ids = [
      ...new Set(
        events.flatMap((event) => {
          const id = tag(event, "d");
          const identity = channelIdentity(event);
          return event.kind === 39000 &&
            event.pubkey === transport.relayAuthor &&
            id &&
            identity.creator === query.creator &&
            identity.labels.includes(query.label)
            ? [id]
            : [];
        }),
      ),
    ];
    if (ids.length) await resolve(ids, settings, true);
    if (disposed || generation !== epoch)
      throw new DOMException("Stale channel lookup", "AbortError");
    return ids
      .flatMap((id) => {
        const channel = discovery.get(id);
        return channel &&
          channel.creator === query.creator &&
          channel.labels?.includes(query.label)
          ? [channel]
          : [];
      })
      .sort(compareChannelAge);
  }
  /** An open channel's current read-only preview, as name search admits it. */
  function previewable(id: string) {
    const channel = discovery?.get(id);
    return channel?.readOnly &&
      !discovery?.authorized(id) &&
      !channel.archived &&
      !channel.cached
      ? channel
      : undefined;
  }
  /** Metadata slots the final answers of the public searches in flight may
   * still need, `limit` each; pages ranked while they run admit only beyond
   * it and one more `limit`, for a search that joins the read later. */
  let publicSearchReserve = 0;
  /** The last search's channels (its answer, or the matches of the pages it
   * has read so far) that still match `query`, in search order. Callers
   * remount per keystroke, so the store, not a component, keeps the previous
   * answer while the next `searchPublic` runs. */
  let recentPublic: { generation: number; ids: readonly string[] } | undefined;
  function matchPublic(
    query: string,
    settings?: { exact?: boolean },
  ): readonly ChannelSummary[] {
    const needle = query.trim().toLowerCase().replace(/^#/, "");
    if (!needle || disposed || recentPublic?.generation !== epoch) return [];
    return recentPublic.ids
      .flatMap((id) => {
        const channel = previewable(id);
        const rank =
          channel && publicRank(channel.name, needle, settings?.exact);
        return channel && rank !== undefined ? [{ channel, rank }] : [];
      })
      .sort((a, b) => a.rank - b.rank)
      .map(({ channel }) => channel);
  }
  /** Re-read one authorized channel's relay-signed roster and merge it into the
   * ready list: one exact `#d` read of a single 39002, instead of the full
   * viewer-roster rediscovery, when an agent is added to a joined channel.
   *
   * This is a separate entry point because `resolve` deliberately skips ids the
   * store already authorizes: its exact read carries cached-denial semantics for
   * restored channels, which a member addition must not inherit. The agent-add
   * path in channel-writes.ts `refresh` guards this method with real-store tests
   * in channel-writes.test.ts; the merge itself is covered in store.test.ts.
   * - Only an id the store authorizes is read. Admitting a channel the list lacks
   *   is `resolve`'s job, and a denied id never regains access here: the method
   *   returns without a read, so cached denials stay as they were.
   * - The roster applies through `applyDiscovery`, which always commits the list
   *   as `ready`, so this rejects unless discovery has already made the list
   *   ready (the same guard `resolve` relies on; see its docstring).
   * - The read is viewer-scoped (`#p`), so the relay never answers with a roster
   *   this viewer is absent from. An omitted roster changes nothing: revocation
   *   by omission stays with the complete viewer-roster pass and live traffic. */
  async function refreshRoster(
    channelId: string,
    settings?: ChannelReadOptions,
  ) {
    if (disposed || !transport || !discovery || options.cachedOnly)
      throw new Error("Relay is unavailable");
    if (list.status !== "ready")
      throw new Error("Channel list is not ready for a roster refresh");
    if (!discovery.authorized(channelId)) return false;
    const generation = epoch;
    const events = await transport.read(
      [
        {
          kinds: [39002],
          ...(settings?.consistency
            ? { consistency: settings.consistency }
            : {}),
          authors: [transport.relayAuthor],
          "#d": [channelId],
          "#p": [transport.viewer],
          limit: 2,
        },
      ],
      { ...settings, fresh: true },
    );
    settings?.signal?.throwIfAborted();
    // A list that stopped being ready in flight needs the full pass to become
    // ready again; committing this roster now would hide that from the user.
    if (disposed || generation !== epoch || list.status !== "ready")
      throw new DOMException("Stale roster refresh", "AbortError");
    if (
      events.length > 1 ||
      events.some(
        (event) =>
          event.kind !== 39002 ||
          event.pubkey !== transport.relayAuthor ||
          tag(event, "d") !== channelId ||
          !hasTag(event, "p", transport.viewer),
      )
    )
      throw new ReadError(
        "invalid-response",
        "Channel roster refresh exceeded its read budget",
      );
    if (events.length) applyDiscovery(events);
    const roster = events[0];
    return (
      !!roster &&
      discovery.rosterVersions().get(channelId)?.id === roster.id &&
      discovery.authorized(channelId) &&
      !discovery.get(channelId)?.cached
    );
  }
  const cachedResolutions = new Set<string>();
  function revalidateCached(channelId: string) {
    if (
      disposed ||
      options.cachedOnly ||
      !discovery?.get(channelId)?.cached ||
      listBusy ||
      rosterRefresh.state === "idle" ||
      cachedResolutions.has(channelId)
    )
      return;
    const controller = new AbortController();
    controllers.add(controller);
    cachedResolutions.add(channelId);
    void resolve([channelId], { signal: controller.signal })
      .catch((error) => {
        const state = windows.get(channelId);
        if (
          !disposed &&
          !controller.signal.aborted &&
          state &&
          authorized(channelId)
        )
          setWindow(state, { error: describe(error) });
      })
      .finally(() => {
        controllers.delete(controller);
        cachedResolutions.delete(channelId);
      });
  }
  async function clearCache() {
    epoch++;
    creationReads.clear();
    hydration = undefined;
    revealHydration?.();
    initialHydration = new Promise<void>((resolve) => {
      revealHydration = resolve;
    });
    startup = Promise.resolve();
    discoveryObserved = true;
    discovery?.clearCached();
    warmCandidates.clear();
    warmEligible.clear();
    warmPreferred = [];
    media.dispose();
    media = createMediaPreparation();
    for (const controller of controllers) controller.abort();
    for (const state of [...windows.values()]) evict(state);
    heads.clear();
    tails.clear();
    if (discovery) setList({ ...list, channels: discovery.channels() });
    resetReferences();
    clearTimeout(discoverySave);
    discoverySave = undefined;
    await persistence?.clear().catch(() => {});
  }
  /** One background head read at a time; warm never competes with demand reads
   * for foreground slots and is dropped wholesale when the session resets. */
  let warmPreferred: readonly string[] = [];
  const warmCandidates = new Set<string>();
  // Eligibility outlives head-cache retention. Consuming a candidate (including
  // failure or yielding to demand) must not requeue it on the next preview update.
  let warmEligible = new Set<string>();
  function nextWarmId(): string | undefined {
    for (const channelId of warmPreferred)
      if (warmCandidates.has(channelId)) return channelId;
    let best: string | undefined;
    let bestSavedAt = -1;
    for (const channelId of warmCandidates) {
      const savedAt = heads.peek(channelId)?.savedAt ?? 0;
      if (savedAt > bestSavedAt) {
        best = channelId;
        bestSavedAt = savedAt;
      }
    }
    return best;
  }
  async function drainWarm() {
    if (warming || saveData()) return;
    warming = true;
    try {
      while (warmCandidates.size) {
        const generation = epoch;
        const channelId = nextWarmId();
        if (!channelId) break;
        warmCandidates.delete(channelId);
        if (disposed || generation !== epoch) {
          warmCandidates.clear();
          warmPreferred = [];
          return;
        }
        if (!transport || !authorized(channelId)) continue;
        if (windows.has(channelId)) continue; // An open channel is demand-owned.
        const head = heads.peek(channelId);
        if (head && !head.cached && now() - head.savedAt < FRESH_FOR) continue;
        await requestHead(channelId, "background").catch(() => {});
      }
    } finally {
      warming = false;
    }
  }
  /** Channel-link lookups. `withheld` keeps a lookup that admitted nothing (a
   * withheld answer, or a left channel still unreadable) for a while, and its
   * answer is shown while rechecked; failures back off. Both reset with the
   * epoch.
   * `demand` counts mounted links per channel; a timer rechecks them when
   * their answer expires or their backoff ends. */
  const references = {
    generation: -1,
    withheld: new Map<string, number>(),
    retryAt: new Map<string, number>(),
    queue: new Set<string>(),
    pending: new Set<string>(),
    scheduled: false,
  };
  const demand = new Map<string, number>();
  let referenceWake:
    | { at: number; timer: ReturnType<typeof setTimeout> }
    | undefined;
  function currentReferences() {
    if (references.generation !== epoch) {
      references.generation = epoch;
      references.withheld.clear();
      references.retryAt.clear();
      references.queue.clear();
      references.pending.clear();
      // A queued microtask from the old epoch drops its batch.
      references.scheduled = false;
    }
    return references;
  }
  /** Cache and access resets drop every answer. Mounted links still show the
   * old one until notified, and an in-flight lookup's reply is dropped, so
   * notify them and look their channels up again. */
  function resetReferences() {
    currentReferences();
    if (referenceWake) clearTimeout(referenceWake.timer);
    referenceWake = undefined;
    setList(list, true);
    for (const id of demand.keys()) lookUpReference(id);
    wakeReferences();
  }
  function describeReference(id: string): ChannelReference {
    const channel = discovery?.get(id);
    if (channel) {
      const joined = !!discovery && channel.members?.includes(discovery.viewer);
      return {
        state: "found",
        name: channel.name,
        ...(channel.description ? { description: channel.description } : {}),
        ...(channel.channelType ? { channelType: channel.channelType } : {}),
        private: !!channel.private,
        hidden: !!channel.hidden,
        archived: !!channel.archived,
        joined: !!joined,
        ...(channel.members?.length ? { members: channel.members.length } : {}),
      };
    }
    const state = currentReferences();
    const looking = state.queue.has(id) || state.pending.has(id);
    // A public channel the viewer has left: its signed open metadata stays
    // public even while discovery denies reading it as a member, until a
    // lookup confirms it is still open.
    const event = discovery?.metadataVersion(id);
    const name = event && openMetadata(event) && metadataName(event);
    if (event && name) {
      const type = tag(event, "t");
      const about = tag(event, "about");
      return {
        state: "found",
        name,
        ...(about ? { description: about } : {}),
        ...(type === "stream" || type === "forum" ? { channelType: type } : {}),
        private: false,
        hidden: false,
        archived: hasTag(event, "archived", "true"),
        joined: false,
        readable: false,
        ...(looking ? { looking: true as const } : {}),
      };
    }
    return state.withheld.has(id)
      ? { state: "withheld" }
      : looking
        ? { state: "looking" }
        : { state: "unknown" };
  }
  /** When a demanded reference may be looked up again: its withheld answer
   * expires, or its backoff ends. */
  function referenceDue(id: string) {
    const state = currentReferences();
    const checked = state.withheld.get(id);
    return Math.max(
      checked === undefined ? 0 : checked + REFERENCE_TTL,
      state.retryAt.get(id) ?? 0,
    );
  }
  /** One timer for the earliest demanded recheck. */
  function wakeReferences() {
    if (disposed) return;
    let at = Number.POSITIVE_INFINITY;
    for (const id of demand.keys()) {
      const due = referenceDue(id);
      if (due > now()) at = Math.min(at, due);
    }
    if (referenceWake && referenceWake.at <= at) return;
    if (referenceWake) clearTimeout(referenceWake.timer);
    referenceWake = undefined;
    if (at === Number.POSITIVE_INFINITY) return;
    referenceWake = {
      at,
      timer: setTimeout(() => {
        referenceWake = undefined;
        for (const id of demand.keys()) lookUpReference(id);
        wakeReferences();
      }, at - now()),
    };
  }
  function lookUpReference(id: string) {
    if (disposed || !transport || !discovery || options.cachedOnly) return;
    // Discovery's admission, not a found name, decides: a left channel's
    // messages need a fresh lookup.
    if (list.status !== "ready" || discovery.get(id)) return;
    const state = currentReferences();
    if (
      state.queue.has(id) ||
      state.pending.has(id) ||
      now() < referenceDue(id)
    )
      return;
    state.queue.add(id);
    if (state.scheduled) return;
    state.scheduled = true;
    // `state` is shared across epochs; this batch belongs to this one.
    const generation = epoch;
    queueMicrotask(() => {
      if (generation !== epoch) return;
      state.scheduled = false;
      const ids = [...state.queue];
      state.queue.clear();
      // `resolve` bounds one exact read to 128 channels.
      for (let start = 0; start < ids.length; start += 128) {
        const batch = ids.slice(start, start + 128);
        for (const id of batch) state.pending.add(id);
        resolve(batch, { priority: "background" }).then(
          () => {
            if (generation !== epoch) return;
            for (const id of batch) {
              state.pending.delete(id);
              state.retryAt.delete(id);
              if (discovery?.get(id)) state.withheld.delete(id);
              else state.withheld.set(id, now());
            }
            setList(list, true);
            wakeReferences();
          },
          (error: unknown) => {
            if (generation !== epoch) return;
            const wait = Math.max(
              REFERENCE_RETRY,
              error instanceof ReadError ? (error.retryAfterMs ?? 0) : 0,
            );
            for (const id of batch) {
              state.pending.delete(id);
              state.retryAt.set(id, now() + wait);
            }
            // Arm the retry first, so a throwing listener can't skip it.
            wakeReferences();
            // Its links stop waiting through the backoff.
            notify(listListeners);
          },
        );
      }
      // Their links now wait for these answers, once per batch and after the
      // reads start. A withheld answer stays on screen while it is rechecked.
      if (ids.some((id) => !state.withheld.has(id))) notify(listListeners);
    });
  }
  function referChannel(id: string) {
    demand.set(id, (demand.get(id) ?? 0) + 1);
    lookUpReference(id);
    // A link remounted during a backoff or a withheld answer's lifetime is
    // suppressed above; it still needs the wake-up at that deadline.
    wakeReferences();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (demand.get(id) ?? 1) - 1;
      if (count) demand.set(id, count);
      else demand.delete(id);
    };
  }
  function restore() {
    if (!prepared || !persistence?.readStartup) return Promise.resolve();
    startup ??= restoreStartup();
    return startup;
  }
  const queries: ChannelQueries = Object.freeze({
    list: () => list,
    get: (id: string) => {
      const channel = discovery?.get(id);
      return channel && { ...channel, metadataPending: metadataPending(id) };
    },
    start(channel: Parameters<NonNullable<ChannelQueries["start"]>>[0]) {
      if (disposed || !transport || !discovery) return;
      const createdAt = Math.floor(now() / 1000);
      discovery.start({
        id: channel.id,
        name: channel.name,
        channelType: "solo",
        members: Object.freeze(
          [...new Set([transport.viewer, ...channel.members])].sort(),
        ),
        labels: channel.labels,
        creator: transport.viewer,
        createdAt,
        updatedAt: createdAt,
        ...(channel.ttlSeconds !== undefined
          ? { ttlSeconds: channel.ttlSeconds }
          : {}),
      });
      setList({ ...list, channels: discovery.channels() }, true);
    },
    abandon(channelId: string) {
      if (!discovery?.abandon(channelId)) return;
      const state = windows.get(channelId);
      if (state && !authorized(channelId)) evict(state);
      setList({ ...list, channels: discovery.channels() }, true);
    },
    resolve,
    searchPublic,
    defaultChannels,
    findLabeled,
    matchPublic,
    readDirectory,
    readMemberCounts,
    directoryComplete: () =>
      publicDirectory?.generation === epoch &&
      (publicDirectory.refresh || publicDirectory.at !== undefined),
    openDirectory: () =>
      publicDirectory?.generation === epoch
        ? (publicDirectory.open ?? noOpenDirectory)
        : noOpenDirectory,
    browseDirectory: () =>
      publicDirectory?.generation === epoch
        ? (publicDirectory.pages ?? publicDirectory.open ?? noOpenDirectory)
        : noOpenDirectory,
    subscribeDirectory: (listener: Listener) =>
      subscribe(directoryListeners, listener),
    describe: describeReference,
    // A cached-only store never looks a reference up, so it offers no lookup.
    ...(options.cachedOnly ? {} : { refer: referChannel }),
    refreshRoster,
    subscribeList: (listener: Listener) => subscribe(listListeners, listener),
    window: (channelId: string) =>
      windows.get(channelId)?.snapshot ?? idleWindow(channelId),
    subscribeWindow(channelId: string, listener: Listener) {
      const listeners = windowListeners.get(channelId) ?? new Set<Listener>();
      windowListeners.set(channelId, listeners);
      const release = subscribe(listeners, listener);
      return () => {
        release();
        if (!listeners.size) windowListeners.delete(channelId);
        trim();
      };
    },
    ensureList() {
      if (!persistence?.readStartup) void discover();
      else void restore().then(() => discover());
    },
    refreshList(settings?: Pick<ChannelReadOptions, "consistency">) {
      const strong = settings?.consistency === "strong";
      if (!persistence?.readStartup) void discover(true, strong);
      else void restore().then(() => discover(true, strong));
    },
    /** Background roster warm. The caller supplies preferred ids (e.g. starred);
     * the rest follow by recency of their retained head, never-fetched last. */
    warm(preferred: readonly string[]) {
      if (disposed || !transport || list.status !== "ready") return;
      const starred = new Set(preferred);
      warmPreferred = preferred;
      const eligible = new Set(
        list.channels
          .filter((channel) => !channel.archived || starred.has(channel.id))
          .map((channel) => channel.id),
      );
      for (const id of warmCandidates)
        if (!eligible.has(id)) warmCandidates.delete(id);
      for (const id of eligible)
        if (!warmEligible.has(id)) warmCandidates.add(id);
      warmEligible = eligible;
      void drainWarm();
    },
    ensure(channelId: string) {
      if (disposed || !transport || !authorized(channelId)) return;
      intent = channelId;
      current = channelId;
      const state = touch(channelId);
      const retained = prepared ? heads.peek(channelId) : undefined;
      if (retained && ["idle", "error"].includes(state.snapshot.status))
        adoptHead(state, retained);
      if (discovery?.isPending(channelId)) {
        // A chat still starting has no history yet; its own sends show locally.
        if (state.snapshot.status === "idle")
          setWindow(state, { status: "ready", hasMore: false });
        return;
      }
      clientMetrics.channelEnsured(
        channelId,
        !state.snapshot.rows.length
          ? "network"
          : state.restored
            ? "disk"
            : "memory",
      );
      if (!canReadRemote(channelId)) {
        revalidateCached(channelId);
        return;
      }
      if (transport.demand?.(channelId)) return;
      if (
        state.snapshot.status !== "idle" &&
        state.snapshot.status !== "error"
      ) {
        if (prepared) {
          prepareMedia(channelId);
          const previous = heads.peek(channelId);
          // Revalidate a retained head on revisit after its freshness lease. Do not
          // replace a paged history reader with a new head merely because time passed.
          if (
            previous &&
            state.atHead &&
            !state.controller &&
            (previous.cached || now() - previous.savedAt >= FRESH_FOR)
          )
            void loadPage(state, null);
        }
        return;
      }
      const head = prepared ? heads.get(channelId) : undefined;
      if (head) {
        adoptHead(state, head);
        prepareMedia(channelId);
      }
      if (head && !head.cached && now() - head.savedAt < FRESH_FOR) return;
      if (!head) setWindow(state, { status: "loading", error: undefined });
      void loadPage(state, null);
    },
    prepare(channelId: string) {
      if (
        !prepared ||
        disposed ||
        !transport ||
        !allowed?.has(channelId) ||
        !canReadRemote(channelId)
      )
        return;
      intent = channelId;
      const head = heads.get(channelId);
      if (head) prepareMedia(channelId);
      if (
        saveData() ||
        preparing ||
        (head && !head.cached && now() - head.savedAt < FRESH_FOR)
      ) {
        relayDebug(
          "prepare skip",
          channelId.slice(0, 8),
          saveData()
            ? "save-data"
            : preparing
              ? "in-flight"
              : head
                ? head.cached
                  ? "cached-head"
                  : "fresh-head"
                : "no-head",
        );
        return;
      }
      relayDebug(
        "prepare fetch",
        channelId.slice(0, 8),
        head ? (head.cached ? "cached-head" : "stale-head") : "no-head",
      );
      // One speculative head, no backlog from crossing sidebar rows. Keep it
      // foreground so selecting this same request cannot inherit a host-side
      // background wait; the other reader slots remain available for demand.
      preparing = true;
      void requestHead(channelId, "foreground")
        .catch(() => {})
        .finally(() => {
          preparing = false;
        });
    },
    refresh(channelId: string) {
      if (disposed || !transport || !authorized(channelId)) return;
      const state = touch(channelId);
      if (!canReadRemote(channelId)) {
        revalidateCached(channelId);
        return;
      }
      if (transport.demand?.(channelId)) return;
      if (state.controller) return;
      if (!state.snapshot.rows.length)
        setWindow(state, { status: "loading", error: undefined });
      void loadPage(state, null);
    },
    loadOlder(channelId: string) {
      if (disposed || !transport) return;
      if (!canReadRemote(channelId)) {
        revalidateCached(channelId);
        return;
      }
      const state = windows.get(channelId);
      if (
        state?.snapshot.status !== "ready" ||
        !state.snapshot.hasMore ||
        state.snapshot.loadingOlder ||
        state.snapshot.historyLimited ||
        !state.cursor ||
        state.controller
      )
        return;
      setWindow(state, { loadingOlder: true, error: undefined });
      void loadPage(state, state.cursor);
    },
  });
  let previousLocal = new Map(
    (local?.snapshot() ?? []).map((item) => [item.event.id, item]),
  );
  // What each tail preview this listener computed depended on: its fold's
  // owner answers and which head events it included. Marks, not the events,
  // so a tail does not keep an evicted head alive.
  const previewFolds = new WeakMap<
    object,
    {
      owners: ReadonlyMap<string, string | undefined> | undefined;
      head: number | undefined;
    }
  >();
  const headMarks = new WeakMap<readonly RelayEvent[], number>();
  let headMark = 0;
  const markHead = (events: readonly RelayEvent[] | undefined) => {
    if (!events) return;
    const mark = headMarks.get(events) ?? ++headMark;
    headMarks.set(events, mark);
    return mark;
  };
  const unsubscribeProfiles = directory.queries.subscribe(() => {
    if (disposed || !transport) return;
    for (const [id, head] of heads.entries())
      if (ownersChanged(foldOwners.get(head.rows)))
        heads.replace(id, {
          ...head,
          rows: Object.freeze(
            foldChannelMessages(id, transport.relayAuthor, head.events),
          ),
        });
    for (const [id, tail] of tails.entries()) {
      const head = heads.peek(id)?.events;
      const folded = previewFolds.get(tail);
      if (folded?.head === markHead(head) && !ownersChanged(folded?.owners))
        continue;
      const rows = foldChannelMessages(id, transport.relayAuthor, [
        ...(head ?? []),
        ...tail.events,
      ]);
      const next = { ...tail, preview: messagePreview(rows) };
      previewFolds.set(next, {
        owners: foldOwners.get(rows),
        head: markHead(head),
      });
      tails.replace(id, next, tailBytes(next));
    }
    for (const state of windows.values()) setWindow(state, {});
    setList(list);
    // Only a saved participant's profile changes the startup snapshot.
    if (
      discoveryObserved &&
      !discoverySave &&
      [...savedProfiles].some(([id, event]) => directory.event(id) !== event)
    )
      discoverySave = setTimeout(saveDiscovery, 500);
  });
  const unsubscribeLocal = local?.subscribe(() => {
    if (disposed) return;
    const next = new Map(
      (local?.snapshot() ?? []).map((item) => [item.event.id, item]),
    );
    const changed = [...next.values()].filter((item) => {
      const old = previousLocal.get(item.event.id);
      return !old || old.delivery !== item.delivery || old.error !== item.error;
    });
    for (const [id, item] of previousLocal)
      if (!next.has(id)) changed.push(item);
    previousLocal = next;
    if (!changed.length) return;
    const channelIds = new Set(
      changed.flatMap((item) =>
        item.event.tags.flatMap(([name, value]) =>
          name === "h" && value !== undefined ? [value] : [],
        ),
      ),
    );
    for (const channelId of channelIds)
      if (
        authorized(channelId) &&
        !windows.has(channelId) &&
        changed.some(
          (item) =>
            next.has(item.event.id) &&
            item.delivery !== "seen" &&
            [9, 40002, 40008].includes(item.event.kind),
        )
      )
        touch(channelId);
    for (const state of windows.values()) {
      if (
        !channelIds.has(state.channelId) &&
        !changed.some((item) =>
          item.event.tags.some(
            (tag) =>
              tag[0] === "e" &&
              state.snapshot.rows.some((row) => row.id === tag[1]),
          ),
        )
      )
        continue;
      setWindow(state, {});
      const newMessages = changed.filter(
        (item) =>
          [9, 40002, 40008].includes(item.event.kind) &&
          item.delivery === "sending",
      );
      if (newMessages.length)
        void fetchProfiles(state.snapshot.rows.slice(-12));
    }
  });
  /** Verified traffic shares the same fold as reads and local intent. Window bounds remain read-owned. */
  function accept(events: readonly RelayEvent[]) {
    if (disposed || !transport) return;
    const generation = epoch;
    const changedChannels = new Set(
      events.flatMap((event) =>
        event.tags.flatMap(([name, value]) =>
          name === "h" && value !== undefined ? [value] : [],
        ),
      ),
    );
    for (const channelId of changedChannels) {
      if (!authorized(channelId)) continue;
      const merged = new Map(
        (tails.peek(channelId)?.events ?? []).map((event) => [event.id, event]),
      );
      for (const event of events)
        if (event.tags.some((tag) => tag[0] === "h" && tag[1] === channelId))
          merged.set(event.id, event);
      const retained = [...merged.values()]
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
        .slice(0, 256);
      const preview = windows.has(channelId)
        ? tails.peek(channelId)?.preview
        : messagePreview(
            foldChannelMessages(channelId, transport.relayAuthor, [
              ...new Map(
                [...(heads.peek(channelId)?.events ?? []), ...retained].map(
                  (event) => [event.id, event],
                ),
              ).values(),
            ]),
          );
      const tail = { events: retained, preview };
      tails.set(channelId, tail, tailBytes(tail));
    }
    for (const state of windows.values()) {
      if (disposed || generation !== epoch) return;
      if (!authorized(state.channelId)) continue;
      const ids = new Set(state.events.map((event) => event.id));
      const incomingIds = new Set(ids);
      const incoming: RelayEvent[] = [];
      let changed = true;
      while (changed && incomingIds.size < ids.size + events.length) {
        changed = false;
        for (const event of events) {
          if (
            incomingIds.has(event.id) ||
            !(
              channelRowKind(event.kind) ||
              [40003, 5, 9005, 7, 39005].includes(event.kind)
            )
          )
            continue;
          if (
            !event.tags.some(
              (tag) =>
                (tag[0] === "h" && tag[1] === state.channelId) ||
                (tag[0] === "e" && incomingIds.has(tag[1] ?? "")),
            )
          )
            continue;
          incoming.push(event);
          incomingIds.add(event.id);
          changed = true;
        }
      }
      if (!incoming.length) continue;
      const localIds = new Set(
        (local?.snapshot() ?? []).map((item) => item.event.id),
      );
      let retained = [...state.events, ...incoming];
      let limited = false;
      if (
        listByteSize(retained) > maxHistoryBytes ||
        retained.filter(
          (event) => channelRowKind(event.kind) && !localIds.has(event.id),
        ).length > maxHistoryRows
      ) {
        limited = true;
        const newest = retained
          .filter(
            (event) => channelRowKind(event.kind) && !localIds.has(event.id),
          )
          .sort(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, maxHistoryRows);
        const keep = new Set([...newest.map((event) => event.id), ...localIds]);
        retained = retained.filter(
          (event) =>
            keep.has(event.id) ||
            (!channelRowKind(event.kind) &&
              event.tags.some(
                (tag) => tag[0] === "e" && keep.has(tag[1] ?? ""),
              )),
        );
        while (retained.length && listByteSize(retained) > maxHistoryBytes)
          retained.splice(0, Math.max(1, Math.ceil(retained.length / 4)));
        const retainedIds = new Set(retained.map((event) => event.id));
        for (const id of state.traffic.keys())
          if (!retainedIds.has(id)) state.traffic.delete(id);
      }
      const retainedIds = new Set(retained.map((event) => event.id));
      for (const event of incoming)
        if (retainedIds.has(event.id)) state.traffic.set(event.id, event);
      state.events = retained;
      setWindow(state, limited ? { historyLimited: true } : {});
      if (disposed || generation !== epoch) return;
      void fetchProfiles(state.snapshot.rows.slice(-12));
    }
    for (const channelId of changedChannels) {
      const tail = tails.peek(channelId);
      const state = windows.get(channelId);
      if (tail && state) {
        const next = { ...tail, preview: messagePreview(state.snapshot.rows) };
        tails.set(channelId, next, tailBytes(next));
      }
    }
    setList(list);
  }
  /** Re-evaluate retained channel inputs at the session's access boundary, not
   * only the revoked channel: an auxiliary may reference several channels. */
  function purgeAccess(
    visible: (events: readonly RelayEvent[]) => readonly RelayEvent[],
  ) {
    const hadHydration = hydration !== undefined;
    epoch++;
    for (const [id, read] of creationReads)
      if (!read.complete || !authorized(id)) creationReads.delete(id);
    revokedEpoch = epoch;
    hydration = undefined;
    revealHydration?.();
    initialHydration = new Promise<void>((resolve) => {
      revealHydration = resolve;
    });
    for (const id of warmEligible)
      if (!authorized(id)) {
        warmEligible.delete(id);
        warmCandidates.delete(id);
      }
    media.dispose();
    media = createMediaPreparation();
    for (const controller of controllers) controller.abort();
    for (const [id, head] of heads.entries()) {
      if (!transport || !authorized(id)) {
        heads.delete(id);
        continue;
      }
      const events = visible(head.events);
      if (events.length !== head.events.length)
        heads.set(id, {
          ...head,
          events,
          rows: Object.freeze(
            foldChannelMessages(id, transport.relayAuthor, events),
          ),
        });
    }
    for (const [id, tail] of tails.entries()) {
      if (!transport || !authorized(id)) {
        tails.delete(id);
        continue;
      }
      const events = visible(tail.events);
      tails.set(id, {
        events,
        preview: messagePreview(
          foldChannelMessages(id, transport.relayAuthor, [
            ...(heads.peek(id)?.events ?? []),
            ...events,
          ]),
        ),
      });
    }
    for (const state of [...windows.values()]) {
      if (!authorized(state.channelId)) {
        state.generation++;
        state.controller?.abort();
        state.controller = undefined;
        state.events = [];
        state.notices.clear();
        state.noticeCursor = undefined;
        state.traffic.clear();
        setWindow(state, {
          rows: EMPTY_ROWS,
          loadingOlder: false,
          status: "idle",
        });
        continue;
      }
      state.generation++;
      state.controller?.abort();
      state.controller = undefined;
      state.events = visible([...state.events, ...state.traffic.values()]);
      state.notices = new Map(
        visible([...state.notices.values()]).map((event) => [event.id, event]),
      );
      state.traffic.clear();
      setWindow(state, {
        loadingOlder: false,
        status: state.events.length ? "ready" : "idle",
      });
    }
    // Disk heads also carry profile and cross-channel auxiliary evidence. Drop
    // this disposable cache conservatively; pending writes use separate storage.
    if (hadHydration) void persistence?.retain([]).catch(() => {});
    setList(list);
    resetReferences();
  }
  function dispose() {
    disposed = true;
    clearTimeout(discoverySave);
    if (referenceWake) clearTimeout(referenceWake.timer);
    referenceWake = undefined;
    unsubscribeLocal?.();
    unsubscribeProfiles();
    epoch++;
    creationReads.clear();
    media.dispose();
    for (const controller of controllers) controller.abort();
    for (const state of windows.values()) {
      state.generation++;
      state.controller?.abort();
    }
    windows.clear();
    heads.clear();
    tails.clear();
    persistence?.close();
  }
  return {
    queries,
    roster: () => rosterRefresh,
    /** A full roster read is still due: the last one did not verify, or a
     * retired exact confirmation left a strong read owed. */
    rosterOwed: () => rosterRefresh.state !== "verified" || strongListAgain,
    /** Preserve a retired exact confirmation's routing without scheduling work.
     * The next refresh/Retry owns dispatch and the existing cooldown. */
    requireStrongListRead() {
      if (!disposed) strongListAgain = true;
    },
    retryList() {
      if (rosterRefresh.state === "error" || rosterRefresh.state === "deferred")
        void discover(true);
    },
    restore,
    canAccess: authorized,
    canParticipate: (id: string) => discovery?.canParticipate(id) ?? false,
    canWrite: (id: string) => discovery?.canWrite(id) ?? false,
    unlisted,
    purgeAccess,
    denyChannel,
    suspendPreviews(ids: readonly string[]) {
      let changed = false;
      for (const id of ids)
        changed = (discovery?.suspend(id) ?? false) || changed;
      if (changed) transport?.revokeAccess(() => setList(list, true), ids);
    },
    suspendedPreviews: () => discovery?.suspendedChannels() ?? [],
    acceptDiscovery: applyDiscovery,
    accept,
    clearCache,
    dispose,
    /** A disconnected stream invalidates a head's freshness lease, not its content.
     * Inactive cached heads will revalidate when demanded, without an all-roster read.
     * The session drops its queued catch-ups with the stream, so an empty window
     * that only a queued catch-up marked loading becomes idle: the next ensure()
     * reads it again. Running reads settle their own windows when cancelled.
     * The rows held now are what the catch-up must reach; a second drop before
     * one completes keeps that snapshot, and a window reading its head before
     * the stream is back takes one from that read. */
    staleHeads() {
      streamDrops++;
      dropped = true;
      for (const [id, head] of heads.entries())
        heads.set(id, { ...head, cached: true });
      for (const state of windows.values()) {
        state.kept ??= rowIds(state);
        setWindow(state, {
          freshness: "cached",
          ...(state.snapshot.status === "loading" &&
          !state.snapshot.rows.length &&
          !state.controller
            ? { status: "idle" }
            : {}),
        });
      }
    },
    /** Revalidate only a retained reader after establishing the stream. An unopened
     * channel needs no eager HTTP head; its normal ensure() owns that finite handoff.
     * Live replay covers minutes, not a long disconnect, so the head may stop short
     * of the rows the reader kept across the drop: page back from it until one is
     * reached, merging each page as it lands. Past the page bound, or when a page
     * fails or is cancelled, the kept rows go and the window continues from the
     * pages read rather than showing a gap as history. */
    async catchUp(channelId: string) {
      const cached = heads.peek(channelId);
      if (cached) heads.set(channelId, { ...cached, cached: true });
      const retained = windows.get(channelId);
      if (!retained) return false;
      const epochAtStart = epoch;
      const generation = retained.generation;
      const valid = () => epoch === epochAtStart && live(retained, generation);
      if (!retained.snapshot.rows.length)
        setWindow(retained, { status: "loading", error: undefined });
      const kept = retained.kept ?? rowIds(retained);
      const dropsAtStart = streamDrops;
      /** What the reader keeps once this fill has settled continuity: nothing,
       * or every row when the stream dropped meanwhile (staleHeads() ran before
       * the page was observed, with this fill still open). */
      const keptAfter = () =>
        streamDrops === dropsAtStart ? undefined : rowIds(retained);
      type Page = Pick<Head, "events" | "cursor" | "hasMore">;
      let page: Page | undefined;
      let contiguous = true;
      /** The kept rows sit below a hole the pages read never closed. They go,
       * by exclusion so rows the stream delivered meanwhile stay, and the
       * window continues from the last page. */
      const settle = (last: Page) => {
        // An older read in flight continues from the cursor this replaces;
        // its rows would merge below the hole and move the floor past it.
        if (retained.snapshot.loadingOlder) retained.controller?.abort();
        retained.events = retained.events.filter(
          (event) => !kept.has(event.id),
        );
        for (const id of kept) retained.traffic.delete(id);
        retained.kept = keptAfter();
        retained.floor = undefined;
        retained.atHead = true;
        moveCursor(retained, last.cursor);
        setWindow(retained, {
          hasMore: last.hasMore,
          historyLimited: false,
          loadingOlder: false,
        });
      };
      const controller = new AbortController();
      controllers.add(controller);
      try {
        const priority = current === channelId ? "foreground" : "background";
        const head = await requestHead(channelId, priority);
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        retained.restored = false;
        accept(head.events);
        page = head;
        const reached = (last: Page) =>
          !last.hasMore ||
          last.events.some(
            (event) => channelRowKind(event.kind) && kept.has(event.id),
          );
        contiguous = !kept.size || reached(page);
        for (let pages = 0; !contiguous && page.cursor; pages++) {
          if (pages >= CATCH_UP_PAGES) {
            settle(page);
            break;
          }
          page = (
            await readPage(channelId, page.cursor, {
              signal: controller.signal,
              priority,
            })
          ).page;
          if (!valid())
            throw new DOMException("Stale live catch-up", "AbortError");
          accept(page.events);
          contiguous = reached(page);
        }
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        if (retained.atHead) moveCursor(retained, page.cursor);
        retained.kept = keptAfter();
        // Live replay covers minutes; notices from a longer drop come by read.
        void fillNotices(retained, true);
        // A drop mid-fill has marked the window cached; the stream is retrying.
        setWindow(retained, {
          ...(retained.atHead ? { hasMore: page.hasMore } : {}),
          status: "ready",
          freshness: streamDrops === dropsAtStart ? "verified" : "cached",
          error: undefined,
        });
        return true;
      } catch (error) {
        if (!valid())
          throw new DOMException("Stale live catch-up", "AbortError");
        // A denied head has purged in requestHead; a page denied after it must too.
        if (readErrorKind(error) === "denied") {
          denyChannel(channelId, error);
          throw error;
        }
        // An interrupted fill would show its open hole as history until the
        // next catch-up closes it. Settle on the pages that landed; a cancelled
        // read's stream drop has already marked the window cached.
        const interrupted = contiguous ? undefined : page;
        if (interrupted) settle(interrupted);
        if (!isAbort(error))
          setWindow(retained, {
            status: retained.snapshot.rows.length ? "ready" : "error",
            freshness: "cached",
            error: describe(error),
          });
        throw error;
      } finally {
        controllers.delete(controller);
      }
    },
    /** Also settles queued obligations refused before catchUp could dispatch. */
    catchUpFailed(channelId: string, error: unknown) {
      const state = windows.get(channelId);
      if (disposed || !state || !authorized(channelId) || isAbort(error))
        return;
      setWindow(state, {
        status: state.snapshot.rows.length ? "ready" : "error",
        freshness: "cached",
        error: describe(error),
      });
    },
    retainedChannels: () => [...windows.keys()],
    retainedEvent(id: string) {
      for (const state of windows.values()) {
        if (!authorized(state.channelId)) continue;
        const event = state.events.find((candidate) => candidate.id === id);
        if (event) return event;
      }
    },
    retainedEvents(): RelayEvent[] {
      return [...windows.values()].flatMap((state) =>
        authorized(state.channelId) ? [...state.events] : [],
      );
    },
    demandedChannels: () => [
      ...new Set([
        ...(current && windows.has(current) ? [current] : []),
        ...[...windows.keys()].reverse(),
      ]),
    ],
    /** A catch-up head read is queued: the rows wait to be revalidated, an
     * empty window is loading, and an earlier failure is no longer the answer.
     * catchUp settles it again. */
    catchUpQueued(channelId: string) {
      // The stream is up for this channel, whether or not a window is retained
      // to catch up: heads read from here on are not snapshotted.
      dropped = false;
      const head = heads.peek(channelId);
      if (head) heads.set(channelId, { ...head, cached: true });
      const state = windows.get(channelId);
      if (state)
        setWindow(state, {
          freshness: "cached",
          error: undefined,
          ...(state.snapshot.rows.length ? {} : { status: "loading" }),
        });
    },
    diagnostics: () => ({
      heads: heads.stats(),
      media: media.stats(),
      historyRows: [...windows.values()].reduce(
        (sum, state) => sum + state.snapshot.rows.length,
        0,
      ),
    }),
  };
}
