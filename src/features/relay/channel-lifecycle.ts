import { getEventHash } from "nostr-tools";
import { attestedOwner } from "../agents/owner-attestation";
import type { RelayReader } from "./reader";
import type { RelayWriter } from "./transport";
import { PublishRejected } from "./outbox";
import { isTransientFailure, readErrorKind } from "./errors";
import { retryRead } from "./read-retry";
import { yieldToHost } from "./yield";
import { hasTag, newer, type RelayEvent } from "./events";
import { openMetadata } from "./discovery";
import {
  channelTypeTag,
  DM_VISIBILITY_KIND,
  exactLifecycleTag,
  lifecycleChannelId,
  lifecycleRecord,
  lifecycleSettings,
  lifecycleTemplate,
  type ChannelLifecycleCommand,
  type ChannelLifecycleSettings,
} from "./channel-lifecycle-protocol";

/** No automatic or same-dialog retry after a request may have reached the relay. */
export class ChannelLifecycleUnconfirmed extends Error {
  constructor(reason: unknown) {
    super(
      `The request may have taken effect. Refresh channels before trying again. ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = "ChannelLifecycleUnconfirmed";
  }
}

export type DmVisibility = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  hidden: readonly string[];
  error?: string;
}>;
export interface ChannelLifecycleCapability {
  readonly available: boolean;
  load(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<ChannelLifecycleSettings>;
  run(
    action: ChannelLifecycleCommand,
    channelId: string,
    signal?: AbortSignal,
    /** Checked synchronously right before publishing; false publishes nothing. */
    active?: () => boolean,
  ): Promise<void>;
  snapshot(): DmVisibility;
  subscribe(listener: () => void): () => void;
  refreshVisibility(signal?: AbortSignal): Promise<void>;
  observeRemoval(listener: (channelId: string) => void): () => void;
}

export function createChannelLifecycle({
  reader,
  writer,
  viewer,
  relayAuthor,
  canAccess,
  acceptDiscovery,
  removed,
}: {
  reader?: RelayReader | undefined;
  writer?: RelayWriter | undefined;
  viewer: string;
  relayAuthor: string;
  canAccess(id: string): boolean;
  acceptDiscovery(events: readonly RelayEvent[]): void;
  removed(id: string): void;
}) {
  let closed = false;
  let busy = false;
  let epoch = 0;
  // Each in-flight operation and its scope; visibility reads have no channel.
  const controllers = new Map<AbortController, Scope>();
  const listeners = new Set<() => void>();
  const removalListeners = new Set<(channelId: string) => void>();
  let snapshot: DmVisibility = Object.freeze({
    status: "idle",
    hidden: Object.freeze([]),
  });
  let visibility: RelayEvent | undefined;
  let refresh: Promise<void> | undefined;
  let refreshSignal: AbortSignal | undefined;
  let refreshController: AbortController | undefined;
  const available = !!reader && !!writer;
  const emit = (next: DmVisibility) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  function assertAccess(id: string) {
    if (closed) throw new DOMException("Relay session closed", "AbortError");
    if (!canAccess(id))
      throw new Error("Channel access unavailable; refresh membership");
  }
  /** The channel an operation concerns, if any, and the caller's own signal.
   * A published command only confirms: access changes, often its own effect,
   * cannot stop it. The caller, deadline, clear and dispose still do. */
  type Scope = {
    id?: string | undefined;
    caller?: AbortSignal | undefined;
    published?: boolean;
  };
  async function owned<T>(
    scope: Scope,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (closed) throw new DOMException("Relay session closed", "AbortError");
    const controller = new AbortController();
    controllers.set(controller, scope);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
      ...(scope.caller ? [scope.caller] : []),
    ]);
    try {
      signal.throwIfAborted();
      return await work(signal);
    } finally {
      controllers.delete(controller);
    }
  }
  async function read(
    kinds: readonly number[],
    id: string,
    signal: AbortSignal,
    member = false,
    strong = false,
  ) {
    if (!reader)
      throw new Error("Channel actions are unavailable on this connection");
    const events = await reader.read(
      kinds.map((kind) => ({
        kinds: [kind],
        ...(strong ? { consistency: "strong" as const } : {}),
        authors: [relayAuthor],
        "#d": [id],
        limit: 1,
        ...(member ? { "#p": [viewer] } : {}),
      })),
      { signal, fresh: true, priority: "foreground" },
    );
    signal.throwIfAborted();
    if (events.some((event) => !kinds.includes(event.kind)))
      throw new Error("Unexpected channel state response");
    return events;
  }
  /** Any revocation, a published command's own included, retires shared
   * reads. That is not a failed attempt for this channel; read again under
   * the same deadline. A closed reader rejects without a macrotask, so yield
   * one first or the deadline could never fire. */
  async function reread<T>(signal: AbortSignal, attempt: () => Promise<T>) {
    for (;;) {
      try {
        return await attempt();
      } catch (error) {
        if (signal.aborted || readErrorKind(error) !== "cancelled") throw error;
      }
      await yieldToHost();
      signal.throwIfAborted();
    }
  }
  type OwnedAgentAction = "archive" | "unarchive" | "delete";
  async function load(
    id: string,
    signal: AbortSignal,
    // Which action needs owner-agent evidence; "any" checks for every action
    // the channel's state allows and false skips the optional profile reads.
    need: OwnedAgentAction | "any" | false = "any",
  ) {
    assertAccess(id);
    const events = await read([39000, 39001, 39002], id, signal);
    assertAccess(id);
    const settings = lifecycleSettings(events, id, viewer, relayAuthor);
    const metadata = lifecycleRecord(events, 39000, id, relayAuthor);
    const archived =
      !!metadata && exactLifecycleTag(metadata, "archived") === "true";
    // The relay lets an owner-agent's human archive, unarchive and delete like
    // a direct owner. Read profiles only when the action fits the archive state
    // and a direct role does not already grant it. Delete implies the rest.
    const action = need === "any" ? (archived ? "unarchive" : "delete") : need;
    const granted = {
      archive: settings.canArchive,
      unarchive: settings.canUnarchive,
      delete: settings.canDelete,
    };
    if (
      !reader ||
      !action ||
      settings.canHide ||
      archived !== (action === "unarchive") ||
      granted[action]
    )
      return settings;
    // lifecycleSettings validated every owner against the signed member roster.
    const owners =
      lifecycleRecord(events, 39001, id, relayAuthor)?.tags.flatMap(
        ([name, pubkey, role]) =>
          name === "p" && role === "owner" && pubkey ? [pubkey] : [],
      ) ?? [];
    if (!owners.length) return settings;
    // Bound the whole optional lookup, not each batch: it must not consume the
    // lifecycle deadline and erase independently established Archive/Leave.
    const profileSignal = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    try {
      for (let start = 0; start < owners.length; start += 4) {
        const batch = owners.slice(start, start + 4);
        const profiles = await retryRead(
          (signal) =>
            reader.read(
              batch.map((pubkey) => ({
                kinds: [0],
                authors: [pubkey],
                limit: 1,
              })),
              { signal, fresh: true, priority: "foreground" },
            ),
          profileSignal,
        );
        profileSignal.throwIfAborted();
        assertAccess(id);
        if (
          profiles.some(
            (event) => event.kind !== 0 || !batch.includes(event.pubkey),
          )
        )
          throw new Error("Unexpected channel owner profile response");
        for (const pubkey of batch) {
          const profile = profiles
            .filter((event) => event.pubkey === pubkey)
            .reduce<RelayEvent | undefined>(newer, undefined);
          // This verifies profile provenance, NOT the relay's persisted ownership
          // mapping. The viewer signs; the relay still authorizes every Delete.
          const owner = profile && (await attestedOwner(profile));
          profileSignal.throwIfAborted();
          assertAccess(id);
          if (owner === viewer)
            return Object.freeze({
              ...settings,
              canArchive: !archived,
              canUnarchive: archived,
              canDelete: !archived,
            });
        }
      }
      return settings;
    } catch (error) {
      // Optional read failures affect only owner-agent actions. Cancellation and
      // access loss still invalidate the whole result, including late replies
      // from an old session. An archived channel has no Delete to retry.
      signal.throwIfAborted();
      assertAccess(id);
      // A read the session retired, unlike the profile deadline, says nothing
      // about ownership; surface it so the caller reads again.
      if (!profileSignal.aborted && readErrorKind(error) === "cancelled")
        throw error;
      return archived
        ? settings
        : Object.freeze({ ...settings, deleteUnavailable: true });
    }
  }
  async function readVisibility(signal: AbortSignal, strong = false) {
    const events = await read(
      [DM_VISIBILITY_KIND],
      viewer,
      signal,
      true,
      strong,
    );
    const record = lifecycleRecord(
      events,
      DM_VISIBILITY_KIND,
      viewer,
      relayAuthor,
    );
    if (record) {
      if (exactLifecycleTag(record, "p") !== viewer || record.content !== "")
        throw new Error("Invalid DM visibility snapshot");
      const hidden = record.tags
        .filter(([key]) => key === "h")
        .map((entry) => {
          if (entry.length !== 2) throw new Error("Invalid hidden DM");
          return lifecycleChannelId(entry[1] ?? "");
        });
      if (newer(visibility, record) === record) {
        visibility = record;
        emit({ status: "ready", hidden: Object.freeze([...new Set(hidden)]) });
      }
    } else if (!visibility)
      emit({ status: "ready", hidden: Object.freeze([]) });
    if (snapshot.status !== "ready")
      emit({ status: "ready", hidden: snapshot.hidden });
    return snapshot.hidden;
  }
  const capability: ChannelLifecycleCapability = Object.freeze({
    available,
    observeRemoval(listener: (channelId: string) => void) {
      removalListeners.add(listener);
      return () => {
        removalListeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refreshVisibility(caller?: AbortSignal) {
      if (!reader || closed || caller?.aborted) return Promise.resolve();
      if (refresh && !refreshSignal?.aborted) return refresh;
      const started = epoch;
      const controller = new AbortController();
      refreshController = controller;
      const signal = AbortSignal.any([
        controller.signal,
        ...(caller ? [caller] : []),
      ]);
      refreshSignal = signal;
      emit({ status: "loading", hidden: snapshot.hidden });
      // Exhausted errors omit `transient`, so session recovery cannot restart
      // them. A read retired by another channel's access change (`cancelled`)
      // retries within the same budget.
      const operation = retryRead(
        async () => {
          await owned({ caller: signal }, readVisibility);
        },
        signal,
        isTransientFailure,
      )
        .catch((error: unknown) => {
          if (started === epoch && !closed && refresh === operation)
            emit({
              status: signal.aborted
                ? visibility
                  ? "ready"
                  : "idle"
                : "error",
              hidden: snapshot.hidden,
              ...(!signal.aborted
                ? {
                    error:
                      error instanceof Error ? error.message : String(error),
                  }
                : {}),
            });
        })
        .finally(() => {
          if (refresh === operation) {
            refresh = undefined;
            refreshController = undefined;
          }
        });
      refresh = operation;
      return operation;
    },
    async load(value: string, caller?: AbortSignal) {
      const id = lifecycleChannelId(value);
      return owned({ id, caller }, (signal) =>
        retryRead(() => reread(signal, () => load(id, signal)), signal),
      );
    },
    async run(
      action: ChannelLifecycleCommand,
      value: string,
      caller?: AbortSignal,
      active?: () => boolean,
    ) {
      if (!available || !writer)
        throw new Error("Channel actions are unavailable on this connection");
      if (busy) throw new Error("Another channel action is still in progress");
      const id = lifecycleChannelId(value);
      busy = true;
      const scope: Scope = { id, caller };
      try {
        await owned(scope, async (signal) => {
          // Joining starts from a nonmember preview, so membership-based
          // settings cannot authorize it. Fresh signed metadata must still
          // say public; a current roster entry means there is nothing to send.
          const joined = async () => {
            const [metadata, roster] = await Promise.all([
              read([39000], id, signal),
              read([39002], id, signal, true),
            ]);
            const channel = lifecycleRecord(metadata, 39000, id, relayAuthor);
            const membership = lifecycleRecord(roster, 39002, id, relayAuthor);
            if (membership && hasTag(membership, "p", viewer)) {
              acceptDiscovery(channel ? [channel, membership] : [membership]);
              return true;
            }
            if (
              !channel ||
              !openMetadata(channel) ||
              exactLifecycleTag(channel, "archived") === "true"
            )
              throw new Error("This conversation can’t be joined right now.");
            return false;
          };
          // The relay accepts the auto-join flag only from community owners
          // and admins, a role the channel's own records cannot show. Check
          // what signed metadata can: an active public stream channel.
          const flaggable = async () => {
            assertAccess(id);
            const metadata = await read([39000], id, signal);
            assertAccess(id);
            const channel = lifecycleRecord(metadata, 39000, id, relayAuthor);
            if (
              !channel ||
              !openMetadata(channel) ||
              exactLifecycleTag(channel, "archived") === "true" ||
              channelTypeTag(channel) !== "stream"
            )
              throw new Error(
                "Only active public channels can auto-join new members.",
              );
            return false;
          };
          const authorize = async () => {
            if (action === "join") return joined();
            if (action === "auto-join-on" || action === "auto-join-off")
              return flaggable();
            const settings = await load(
              id,
              signal,
              action === "archive" ||
                action === "unarchive" ||
                action === "delete"
                ? action
                : false,
            );
            if (settings.deleteUnavailable)
              throw new Error(
                `${action === "delete" ? "Delete" : "Archive"} check unavailable. Retry channel permissions.`,
              );
            const permitted = {
              archive: settings.canArchive,
              unarchive: settings.canUnarchive,
              delete: settings.canDelete,
              leave: settings.canLeave,
              hide: settings.canHide,
            }[action];
            if (!permitted)
              throw new Error(
                action === "leave" && settings.leaveReason
                  ? settings.leaveReason
                  : "This action is no longer permitted. Refresh channel permissions.",
              );
          };
          if (await authorize()) return;
          const template = lifecycleTemplate(action, id);
          const signed = await writer.sign(structuredClone(template), signal);
          signal.throwIfAborted();
          if (
            signed.pubkey !== viewer ||
            signed.kind !== template.kind ||
            signed.created_at !== template.created_at ||
            signed.content !== template.content ||
            JSON.stringify(signed.tags) !== JSON.stringify(template.tags) ||
            getEventHash(signed) !== signed.id
          )
            throw new Error("Signer changed the channel lifecycle command");
          if (await authorize()) return;
          signal.throwIfAborted();
          if (active?.() === false)
            throw new DOMException("Channel action cancelled", "AbortError");
          scope.published = true;
          await writer.publish(signed, signal);
          // An accepted write may precede its relay-owned side effects. Do not
          // optimistically revoke membership or confuse a failed read with absence.
          for (const delay of [0, 250, 750, 1500]) {
            signal.throwIfAborted();
            if (delay)
              await new Promise<void>((resolve, reject) => {
                const abort = () => {
                  clearTimeout(timer);
                  reject(signal.reason);
                };
                const timer = setTimeout(() => {
                  signal.removeEventListener("abort", abort);
                  resolve();
                }, delay);
                signal.addEventListener("abort", abort, { once: true });
              });
            if (action === "hide") {
              const hidden = await reread(signal, () =>
                readVisibility(signal, true),
              );
              if (hidden.includes(id)) return;
            } else if (action === "join") {
              const events = await reread(signal, () =>
                read([39002], id, signal, true, true),
              );
              const roster = lifecycleRecord(events, 39002, id, relayAuthor);
              if (roster && hasTag(roster, "p", viewer)) {
                acceptDiscovery([roster]);
                return;
              }
            } else {
              const kind = action === "leave" ? 39002 : 39000;
              const events = await reread(signal, () =>
                read([kind], id, signal, action === "leave", true),
              );
              const record = lifecycleRecord(events, kind, id, relayAuthor);
              if (action === "auto-join-on" || action === "auto-join-off") {
                // Readback is the bare effective-state tag, not the written value.
                if (
                  record &&
                  record.tags.some(([key]) => key === "auto_join") ===
                    (action === "auto-join-on")
                ) {
                  acceptDiscovery([record]);
                  return;
                }
              } else if (action === "archive" || action === "unarchive") {
                const archived =
                  record && exactLifecycleTag(record, "archived");
                // The relay omits the archived tag on active channels. Absence
                // of the whole record is never evidence of restoration.
                if (
                  record &&
                  (action === "archive"
                    ? archived === "true"
                    : archived === undefined || archived === "false")
                ) {
                  acceptDiscovery([record]);
                  return;
                }
              } else if (!record) {
                removed(id);
                for (const listener of removalListeners) listener(id);
                return;
              }
            }
          }
          throw new Error(
            "The relay accepted the request, but the change is not confirmed. Refresh channels before trying again.",
          );
        });
      } catch (error) {
        if (scope.published && !(error instanceof PublishRejected))
          throw new ChannelLifecycleUnconfirmed(error);
        throw error;
      } finally {
        busy = false;
      }
    },
  });
  return {
    capability,
    /** Abort unpublished work on `ids` and id-less visibility reads; without
     * `ids`, all unpublished work. */
    cancel(ids?: readonly string[]) {
      // A channel-scoped invalidation retires a read, not the viewer's whole
      // refresh. Its cancellation can retry within the existing budget.
      if (!ids) refreshController?.abort();
      for (const [controller, { id, published }] of controllers)
        if (!published && (!ids || id === undefined || ids.includes(id)))
          controller.abort();
    },
    clear() {
      epoch++;
      refreshController?.abort();
      for (const controller of controllers.keys()) controller.abort();
      refresh = undefined;
      visibility = undefined;
      emit({ status: "idle", hidden: Object.freeze([]) });
    },
    dispose() {
      closed = true;
      epoch++;
      refreshController?.abort();
      for (const controller of controllers.keys()) controller.abort();
      listeners.clear();
      removalListeners.clear();
    },
  };
}
