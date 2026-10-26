import { byteSize } from "./budget";
import {
  channelJoinRole,
  channelTtl,
  channelVisibility,
} from "./channel-details-protocol";
import { huddleParent } from "../huddle/lifecycle";
import { soloLabels } from "../solo/labels";
import { objectBody } from "./body";
import { newer, hasTag, tag, type RelayEvent } from "./events";
import type { ChannelSummary } from "./contracts";
import { channelIdentity } from "./channel-labels";

const names = new WeakMap<RelayEvent, string | undefined>();
/** Display name from signed channel metadata; the content body overrides the tag. */
export function metadataName(event: RelayEvent): string | undefined {
  if (names.has(event)) return names.get(event);
  const body = objectBody(event.content);
  const name =
    typeof body?.name === "string" && body.name
      ? body.name
      : tag(event, "name") || undefined;
  names.set(event, name);
  return name;
}

const noMembers: readonly string[] = Object.freeze([]);

/** A Solo chat: a stream carrying the Solo label. Never access. */
export function soloChannelMetadata(event: RelayEvent): boolean {
  return (
    tag(event, "t") === "stream" && soloLabels(channelIdentity(event).labels)
  );
}

/** Explicit signed public metadata: readable and joinable by any viewer. */
export function openMetadata(event: RelayEvent): boolean {
  return (
    event.tags.some(([name]) => name === "public") &&
    !event.tags.some(([name]) => name === "private" || name === "hidden") &&
    !event.tags.some(([name, value]) => name === "t" && value === "dm")
  );
}

/** NIP-29 discovery: relay-authored replaceable metadata (39000) and rosters (39002). */
export class DiscoveryState {
  private denied = new Set<string>();
  /** Denied only because a complete read omitted them; a later one can list them again. */
  private absent = new Set<string>();
  /** Fresh public resolution can restore reading while membership remains denied. */
  private confirmedPreviews = new Set<string>();
  private suspended = new Set<string>();
  private complete = false;
  private cached = new Set<string>();
  accessRevision = 0;
  /** A scan that drops evidence cannot certify completeness. */
  overflowRevision = 0;
  private rosters = new Map<string, RelayEvent>();
  private metadata = new Map<string, RelayEvent>();
  private creations = new Map<string, RelayEvent>();
  /** Solo chats this device started whose signed metadata and roster have not
   * both arrived. Local display and intent only: never saved, never proof.
   * It stands in for access only until a signed roster decides it. */
  private starting = new Map<string, ChannelSummary>();
  private retainedBytes = 0;
  private rejectedVersions = new Map<
    string,
    Pick<RelayEvent, "id" | "created_at">
  >();
  constructor(
    readonly viewer: string,
    readonly relayAuthor: string,
    readonly maxBytes = 256 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new Error("Invalid discovery byte budget");
  }
  private store(
    map: Map<string, RelayEvent>,
    id: string,
    event: RelayEvent,
  ): boolean {
    const previous = map.get(id);
    const bytes =
      this.retainedBytes +
      byteSize(event) -
      (previous ? byteSize(previous) : 0);
    if (bytes > this.maxBytes) {
      this.overflowRevision++;
      return false;
    }
    map.set(id, event);
    this.retainedBytes = bytes;
    return true;
  }
  private olderThanRejected(event: RelayEvent, id: string): boolean {
    const rejected = this.rejectedVersions.get(`${event.kind}:${id}`);
    return (
      !!rejected &&
      (event.created_at < rejected.created_at ||
        (event.created_at === rejected.created_at && event.id > rejected.id))
    );
  }
  /** Returns whether visible state changed. Events from other authors are ignored, not trusted. */
  accept(event: RelayEvent, cached = false): boolean {
    if (event.kind === 9007) {
      const id = tag(event, "h");
      const metadata = id && this.metadata.get(id);
      if (!id || !metadata || !huddleCreation(event, metadata)) return false;
      if (this.creations.get(id)?.id === event.id) return false;
      return this.store(this.creations, id, event);
    }
    if (
      event.pubkey !== this.relayAuthor ||
      (event.kind !== 39000 && event.kind !== 39002)
    )
      return false;
    const id = tag(event, "d");
    if (!id) return false;
    const map = event.kind === 39002 ? this.rosters : this.metadata;
    const previous = map.get(id);
    const coordinate = `${event.kind}:${id}`;
    if (this.olderThanRejected(event, id)) return false;
    const next = newer(previous, event);
    const accessible = this.canAccess(id);
    if (next !== previous && !this.store(map, id, next)) {
      // Keep the version when its full body cannot fit. Older evidence cannot regrant access.
      if (previous)
        this.rejectedVersions.set(coordinate, {
          id: event.id,
          created_at: event.created_at,
        });
      if (
        previous &&
        (event.kind === 39002 || (!this.authorized(id) && !openMetadata(event)))
      )
        this.deny(id);
      return false;
    }
    if (next !== previous) this.rejectedVersions.delete(coordinate);
    // Only this version or a newer one confirms saved membership. An older
    // response must not promote a newer disk roster into write authority.
    const confirmed =
      event.kind === 39002 &&
      !cached &&
      (next !== previous || event.id === previous?.id) &&
      this.cached.delete(id);
    if (next === previous) return confirmed;
    if (event.kind === 39000 && !this.open(id))
      this.confirmedPreviews.delete(id);
    if (event.kind === 39002) {
      this.absent.delete(id);
      if (cached) this.cached.add(id);
      if (
        previous &&
        hasTag(previous, "p", this.viewer) &&
        !hasTag(event, "p", this.viewer)
      )
        this.denied.add(id);
      else if (hasTag(event, "p", this.viewer)) this.denied.delete(id);
      // A signed roster without the viewer ends the start it stood in for.
      if (!hasTag(event, "p", this.viewer)) this.starting.delete(id);
    } else if (previous && !this.rosters.has(id) && this.open(id))
      this.denied.delete(id);
    if (this.authorized(id) || (event.kind === 39000 && this.open(id)))
      this.suspended.delete(id);
    if (this.metadata.has(id) && this.authorized(id)) this.starting.delete(id);
    if (accessible && !this.canAccess(id)) this.accessRevision++;
    return true;
  }
  /** Lists a Solo chat this device is creating until the relay confirms it. */
  start(channel: ChannelSummary) {
    if (this.metadata.has(channel.id) || this.rosters.has(channel.id)) return;
    this.starting.set(channel.id, Object.freeze({ ...channel, pending: true }));
  }
  /** Returns whether a started chat was still awaiting confirmation. */
  abandon(id: string): boolean {
    return this.starting.delete(id);
  }
  isPending(id: string): boolean {
    return this.starting.has(id);
  }
  /** A started chat no signed roster has decided yet. */
  private undecided(id: string) {
    return this.starting.has(id) && !this.rosters.has(id);
  }
  deny(id: string) {
    // A read can race the chat's own creation; only abandon() or a signed
    // roster ends a start.
    if (this.undecided(id)) return;
    // A relay denial outranks an omission that a later read could undo.
    this.absent.delete(id);
    if (!this.canAccess(id) && !this.suspended.has(id)) return;
    this.accessRevision++;
    this.suspended.delete(id);
    this.confirmedPreviews.delete(id);
    this.denied.add(id);
  }
  /** A CLOSED preview is unreadable pending fresh evidence, not permanently denied. */
  suspend(id: string): boolean {
    if (this.authorized(id) || !this.get(id)?.readOnly) return false;
    this.suspended.add(id);
    this.accessRevision++;
    return true;
  }
  suspendedChannels(): string[] {
    return [...this.suspended];
  }
  resume(id: string, metadata?: RelayEvent): boolean {
    const resumed = this.suspended.delete(id);
    if (
      this.denied.has(id) &&
      metadata?.kind === 39000 &&
      metadata.pubkey === this.relayAuthor &&
      tag(metadata, "d") === id &&
      !this.olderThanRejected(metadata, id) &&
      openMetadata(metadata) &&
      newer(this.metadata.get(id), metadata)?.id === metadata.id
    ) {
      const changed = !this.confirmedPreviews.has(id);
      this.confirmedPreviews.add(id);
      return resumed || changed;
    }
    return resumed;
  }
  /** A complete viewer-scoped roster read proves absence: rosters it omitted no longer include the viewer. */
  rosterVersions(): ReadonlyMap<string, RelayEvent> {
    return new Map(this.rosters);
  }
  retain(
    ids: ReadonlySet<string>,
    started: ReadonlyMap<string, RelayEvent>,
  ): boolean {
    let changed = !this.complete;
    this.complete = true;
    // Keep the last signed version: an old replay cannot undo authoritative loss.
    // A NIP-CL pass reads system channels through their own opt-in filter
    // into the same complete set, so one absence rule covers them too.
    for (const [id, roster] of this.rosters) {
      if (!hasTag(roster, "p", this.viewer) || started.get(id) !== roster)
        continue;
      // A lagging read replica can omit a roster; a later complete read that
      // lists the same version again restores what omission alone revoked.
      if (ids.has(id)) {
        if (this.absent.delete(id)) this.denied.delete(id);
      } else if (!this.denied.has(id)) {
        this.denied.add(id);
        this.absent.add(id);
        changed = true;
      }
    }
    if (changed) this.accessRevision++;
    return changed;
  }
  denyAll() {
    this.accessRevision++;
    this.complete = true;
    this.starting.clear();
    this.absent.clear();
    this.confirmedPreviews.clear();
    for (const id of [...this.rosters.keys(), ...this.metadata.keys()])
      this.denied.add(id);
  }
  /** A restored snapshot grants local display only for known signed channels.
   * Close the unknown-access boundary before hydrating content. Fresh exact
   * resolution still grants omitted/capped channels; cache is not roster completeness. */
  restrictToKnown() {
    if (this.complete) return;
    this.complete = true;
    this.accessRevision++;
  }
  /** Unknown is not denied until a complete roster or local snapshot closes that boundary. */
  canAccess(id: string): boolean {
    if (this.undecided(id)) return true;
    if (this.suspended.has(id)) return false;
    if (this.denied.has(id))
      return this.confirmedPreviews.has(id) && this.open(id);
    const roster = this.rosters.get(id);
    if (roster && hasTag(roster, "p", this.viewer)) return true;
    return (
      this.open(id) || (!roster && !this.metadata.has(id) && !this.complete)
    );
  }
  /** Explicit signed public metadata grants reading, never membership. */
  private open(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && openMetadata(event);
  }
  canParticipate(id: string): boolean {
    if (this.undecided(id)) return true;
    const roster = this.rosters.get(id);
    return (
      this.canAccess(id) &&
      !this.denied.has(id) &&
      !this.cached.has(id) &&
      (roster
        ? hasTag(roster, "p", this.viewer)
        : !this.complete && !this.open(id))
    );
  }
  canWrite(id: string): boolean {
    return this.canParticipate(id) && this.viewerRole(id) !== "guest";
  }
  // Per signed roster event, so a large roster is not parsed, sorted and
  // scanned for the (fixed) viewer again on every `get`.
  private readonly parsed = new WeakMap<
    RelayEvent,
    { members: readonly string[]; viewerRole: ChannelSummary["viewerRole"] }
  >();
  private parse(roster: RelayEvent) {
    let parsed = this.parsed.get(roster);
    if (!parsed) {
      const entries = roster.tags.filter(
        ([key, value]) => key === "p" && value === this.viewer,
      );
      const role = entries.length === 1 ? entries[0]?.[3] : undefined;
      parsed = {
        members: Object.freeze(
          [
            ...new Set(
              roster.tags.flatMap(([name, value]) =>
                name === "p" && value && /^[0-9a-f]{64}$/.test(value)
                  ? [value]
                  : [],
              ),
            ),
          ].sort(),
        ),
        // A contradictory guest entry cannot restore writing through another role.
        viewerRole: entries.some((entry) => entry[3] === "guest")
          ? "guest"
          : ["owner", "admin", "member", "bot"].includes(role ?? "")
            ? (role as ChannelSummary["viewerRole"])
            : undefined,
      };
      this.parsed.set(roster, parsed);
    }
    return parsed;
  }
  private viewerRole(id: string): ChannelSummary["viewerRole"] {
    const roster = this.rosters.get(id);
    return roster && this.parse(roster).viewerRole;
  }
  authorized(id: string): boolean {
    const roster = this.rosters.get(id);
    return !this.denied.has(id) && !!roster && hasTag(roster, "p", this.viewer);
  }
  metadataVersion(id: string): RelayEvent | undefined {
    return this.metadata.get(id);
  }
  named(id: string): boolean {
    return this.metadata.has(id);
  }
  byteHeadroom(): number {
    return this.maxBytes - this.retainedBytes;
  }
  name(id: string): string {
    const event = this.metadata.get(id);
    return (event && metadataName(event)) || id.slice(0, 8);
  }
  /** NIP-29 `hidden` marks channels (DMs) that are members-only and absent from channel directories. */
  hidden(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && event.tags.some((entry) => entry[0] === "hidden");
  }
  isPrivate(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && event.tags.some(([name]) => name === "private");
  }
  /** Bare `auto_join` flag: present only while the relay actually auto-adds (open, unarchived). */
  autoJoin(id: string): boolean {
    const event = this.metadata.get(id);
    return !!event && event.tags.some(([name]) => name === "auto_join");
  }
  isSolo(id: string): boolean {
    if (this.starting.has(id)) return true;
    const event = this.metadata.get(id);
    return !!event && soloChannelMetadata(event);
  }
  get(id: string): ChannelSummary | undefined {
    const starting = this.starting.get(id);
    if (starting) return starting;
    if (!this.canAccess(id) || (!this.authorized(id) && !this.open(id))) return;
    const event = this.metadata.get(id);
    // The relay tags a system roster too, so a roster that arrives before its
    // metadata (the full pass reads names later) never lists as a channel.
    const roster = this.rosters.get(id);
    const viewerRole = this.authorized(id) ? this.viewerRole(id) : undefined;
    const type = this.isSolo(id)
      ? "solo"
      : event
        ? tag(event, "t")
        : roster && hasTag(roster, "t", "system")
          ? "system"
          : undefined;
    const channelType =
      type === "stream" ||
      type === "forum" ||
      type === "dm" ||
      type === "system" ||
      (type === "solo" && this.isSolo(id))
        ? type
        : undefined;
    const creation = this.creations.get(id);
    const huddle =
      event && creation && huddleCreation(creation, event)
        ? huddleParent(tag(creation, "about"))
        : undefined;
    const identity = event && channelIdentity(event);
    const ttlSeconds = event && channelTtl(event);
    // Legacy generated rooms lack creation proof. This is presentation only;
    // their parent still needs independent signed lifecycle evidence.
    const legacyHuddle =
      event &&
      channelType === "stream" &&
      channelVisibility(event) === "private" &&
      ttlSeconds !== undefined &&
      metadataName(event) === `huddle-${id.slice(0, 8)}`;
    return {
      id,
      ...(huddle || legacyHuddle ? { huddle: true as const } : {}),
      ...(huddle ? { parentChannelId: huddle } : {}),
      ...(!this.authorized(id) || this.cached.has(id) || viewerRole === "guest"
        ? { readOnly: true as const }
        : {}),
      ...(viewerRole ? { viewerRole } : {}),
      ...(this.cached.has(id) ? { cached: true as const } : {}),
      name: this.name(id),
      ...(event
        ? {
            visibility: channelVisibility(event),
            joinRole: channelJoinRole(event),
            description: tag(event, "about") ?? "",
          }
        : {}),
      members: roster ? this.parse(roster).members : noMembers,
      ...(this.hidden(id) ? { hidden: true } : {}),
      ...(this.isPrivate(id) ? { private: true } : {}),
      ...(this.autoJoin(id) ? { autoJoin: true } : {}),
      ...(channelType ? { channelType } : {}),
      ...(channelType === "solo" && event
        ? { updatedAt: event.created_at }
        : {}),
      ...(event && hasTag(event, "archived", "true") ? { archived: true } : {}),
      ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      ...(identity?.labels.length ? { labels: identity.labels } : {}),
      ...(identity?.creator ? { creator: identity.creator } : {}),
      ...(identity?.createdAt !== undefined
        ? { createdAt: identity.createdAt }
        : {}),
      ...(channelType === "dm"
        ? {
            participants: [
              ...new Set(
                roster?.tags.flatMap(([name, value]) =>
                  name === "p" &&
                  typeof value === "string" &&
                  value !== this.viewer &&
                  /^[0-9a-f]{64}$/.test(value)
                    ? [value]
                    : [],
                ),
              ),
            ].sort(),
          }
        : {}),
    };
  }
  clearCached() {
    for (const id of this.cached) {
      this.deny(id);
      // Clearing must allow a fresh identical signed roster to regrant access.
      for (const map of [this.rosters, this.metadata, this.creations]) {
        const event = map.get(id);
        if (event) this.retainedBytes -= byteSize(event);
        map.delete(id);
      }
    }
    this.cached.clear();
  }
  savedEvents(): RelayEvent[] {
    return [...this.rosters.entries()].flatMap(([id, roster]) => {
      if (!this.authorized(id) || this.cached.has(id)) return [];
      const metadata = this.metadata.get(id);
      const creation = this.creations.get(id);
      return metadata
        ? [roster, metadata, ...(creation ? [creation] : [])]
        : [roster];
    });
  }
  /** Every roster channel get() serves, system channels included. Membership,
   * not listing, decides what the device may keep. */
  readable(): ChannelSummary[] {
    return [
      ...new Set([
        ...[...this.rosters.keys()].filter((id) => this.authorized(id)),
        ...this.starting.keys(),
      ]),
    ].flatMap((id) => {
      const channel = this.get(id);
      return channel ? [channel] : [];
    });
  }
  /** The channel list. System channels (NIP-CL) hold app data, not
   * conversation: they stay readable through get() but never list here. */
  channels(
    readable: readonly ChannelSummary[] = this.readable(),
  ): ChannelSummary[] {
    return readable
      .filter((channel) => channel.channelType !== "system")
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }
}

/** A signed creation receipt must agree with the relay's immutable identity facts. */
export function huddleCreation(
  creation: RelayEvent,
  metadata: RelayEvent,
): boolean {
  const identity = channelIdentity(metadata);
  const coordinates = creation.tags.filter(([name]) => name === "h");
  return (
    creation.kind === 9007 &&
    coordinates.length === 1 &&
    coordinates[0]?.length === 2 &&
    coordinates[0]?.[1] === tag(metadata, "d") &&
    creation.pubkey === identity.creator &&
    tag(creation, "visibility") === "private" &&
    tag(creation, "channel_type") === "stream" &&
    !!huddleParent(tag(creation, "about"))
  );
}
