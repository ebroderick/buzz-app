// The agents service's relay, communities and native fakes, shared by its
// tests. `steps` records the order of cleanup steps the fakes take.
import { vi } from "vitest";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { LiveBatch, LiveListener } from "../relay/incoming";
import type { RelayData, RelaySnapshot } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type {
  AgentEventTemplate,
  AgentIdentity,
  AgentsNative,
  Membership,
  PortableAgents,
} from "./native";
import type { AgentCommunities } from "./service";

export const steps: string[] = [];
export const viewer = "a".repeat(64);
export const other = "b".repeat(64);
export const bot = "c".repeat(64);
export const sibling = "d".repeat(64);
export const channel = "0b8e2a3c-1d4f-4a5b-8c6d-7e8f9a0b1c2d";
/** A public channel the owner is in and the agent is not. */
export const lobby = "1c9f3b4d-2e5a-4b6c-9d7e-8f9a0b1c2d3e";
/** A public channel neither is in. */
export const plaza = "2d0a4c5e-3f6b-4c7d-8e8f-9a0b1c2d3e4f";
export const dm = "dm-with-bot";
export const groupDm = "dm-with-bot-and-other";
export const event = (id: string, patch: Partial<RelayEvent> = {}) =>
  ({
    id: id.padEnd(64, "0"),
    pubkey: other,
    kind: 9,
    created_at: 100,
    content: `hello ${id}`,
    tags: [["h", channel]],
    sig: "",
    ...patch,
  }) as unknown as RelayEvent;

export function fakeRelay(origin = "https://relay.example.test") {
  const live = new Set<LiveListener>();
  /** Listeners that asked for replayed history too. */
  const replays = new Set<LiveListener>();
  const changes = new Set<() => void>();
  const rosterChanges = new Set<() => void>();
  const attended = new Set<readonly string[]>();
  // The agent is in `channel`, `dm` and `groupDm`; `private` is the owner's
  // alone, and `dm-others` and `dm-unknown` are DMs it is not known to be in
  // (discovery emits an empty roster, never a missing one). `saved` has only a
  // roster loaded from disk, not yet confirmed by the relay. `lobby` is
  // public, and the agent is not in it.
  const rows: {
    id: string;
    name?: string;
    channelType?: "dm";
    visibility?: "public";
    members: string[];
    cached?: true;
  }[] = [
    { id: lobby, name: "lobby", visibility: "public", members: [viewer] },
    { id: channel, name: "general", members: [viewer, bot] },
    { id: "private", name: "private", members: [viewer] },
    { id: dm, channelType: "dm", members: [viewer, bot] },
    { id: groupDm, channelType: "dm", members: [viewer, other, bot] },
    { id: "dm-others", channelType: "dm", members: [viewer, other] },
    { id: "dm-unknown", channelType: "dm", members: [] },
    { id: "saved", name: "saved", members: [viewer, bot], cached: true },
  ];
  const archived = new Set<string>();
  const archives = {
    archived,
    /** The last read did not finish, as when its session closed. */
    unknown: false,
    /** The community has no archives at all. */
    unavailable: false,
    snapshot() {
      return { status: this.unavailable ? "unavailable" : "ready" };
    },
    get supported() {
      return !this.unavailable;
    },
    consent: vi.fn(
      async (_pubkey: string, _signal?: AbortSignal) =>
        ({ auth: ["auth"] }) as { auth: string[] } | null,
    ),
    ensure: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    state(pubkey: string) {
      if (this.unknown) return "unknown";
      return archived.has(pubkey) ? "archived" : "not-archived";
    },
    writable: true,
    request: vi.fn(async (action: string, pubkey: string) => {
      steps.push(action);
      if (action === "archive") archived.add(pubkey);
      else archived.delete(pubkey);
    }),
  };
  let status = "connected";
  /** Channels the session does not know yet, attended or not. */
  const pending = new Set<string>();
  /** Channels of the list live does not route. */
  const unrouted = new Set<string>();
  /** Channels it knows only from agents' lookups. */
  const learned = new Set<string>();
  const statuses = new Set<() => void>();
  /** The viewer's kind 30177 records the community returns. */
  const listed: RelayEvent[] = [];
  /** The events it stores, which catch-up reads. */
  const history: RelayEvent[] = [];
  /** Each agent's `core` memory as the community holds it. */
  const memories = new Map<string, string>();
  const session = {
    archives,
    agentChoices: { refresh: vi.fn(async () => {}) },
    agentMemories: {
      read: vi.fn(async (pubkey: string) => {
        const body = memories.get(pubkey);
        return {
          entries: body === undefined ? [] : [{ slug: "core", body }],
          partial: false,
        };
      }),
    },
    read: vi.fn(async (filters: readonly ReadFilter[]) => {
      // As the session's reader refuses it.
      if (
        filters.some((filter) => !filter.kinds?.length && !filter.ids?.length)
      )
        throw new Error("Relay reads need valid kinds or event IDs");
      // A catch-up read is bounded on both sides; it may ask for any kinds.
      // The session drops a channel's events until it knows the channel.
      return filters[0]?.kinds?.includes(9) ||
        (filters[0]?.since !== undefined && filters[0]?.until !== undefined)
        ? page(history, filters[0]).filter(
            ({ tags }) =>
              !tags.some(
                ([key, value]) => key === "h" && pending.has(value ?? ""),
              ),
          )
        : [...listed];
    }),
    readRemote: vi.fn(async (filters: readonly ReadFilter[]) => {
      const ids = filters[0]?.ids ?? [];
      return history.filter((event) => ids.includes(event.id));
    }),
    channelWrites: {
      starting: (_id: string): Promise<void> | undefined => undefined,
    },
    channels: {
      list: () => ({
        status: "ready",
        channels: rows.map((row) => ({ ...row })),
      }),
      subscribeList(listener: () => void) {
        rosterChanges.add(listener);
        return () => rosterChanges.delete(listener);
      },
      // Public, and neither the owner nor the agent is in it.
      get: (id: string) =>
        id === plaza
          ? {
              id,
              name: id,
              visibility: "public",
              readOnly: true,
              members: [other],
            }
          : undefined,
    },
    /** Each list of channels an `attend` keeps live, while it does. */
    attend: vi.fn((ids: readonly string[]) => {
      attended.add(ids);
      return () => attended.delete(ids);
    }),
    attendPending: (id: string) => pending.has(id),
    // The list's channels are the viewer's; attended ones live only for agents.
    unattended: (id: string, live: boolean) =>
      rows.some((row) => row.id === id) ||
      (!learned.has(id) &&
        (!live || ![...attended].some((ids) => ids.includes(id)))),
    live: {
      // Each channel of the list is live while connected, unless `unrouted`.
      snapshot: () => ({
        status,
        routes:
          status === "connected"
            ? rows
                .filter(({ id }) => !unrouted.has(id))
                .map(({ id }) => ({
                  id: `channel:${id}`,
                  channelId: id,
                  status: "live",
                  replay: "unknown",
                }))
            : [],
      }),
      subscribe(listener: () => void) {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
    },
    subscribeLive(listener: LiveListener, options?: { replay?: boolean }) {
      const listeners = options?.replay ? replays : live;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publishAgentPresence: vi.fn(
      async (
        _: "online" | "offline",
        __: readonly string[],
        ___: AbortSignal,
      ) => true,
    ),
  } as unknown as RelaySession;
  let snapshot: RelaySnapshot = {
    status: "ready",
    generation: 1,
    viewer,
    origin,
    scope: `${origin}:${viewer}`,
    session,
  };
  const connected_ = snapshot;
  return {
    relay: {
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      retry: vi.fn(),
    } as unknown as RelayData,
    /** Drops the connection, or restores it with a new session. */
    connect(connected: boolean) {
      snapshot = connected
        ? { ...connected_, session: { ...session } as RelaySession }
        : { status: "disconnected", generation: 2, session };
      for (const listener of changes) listener();
    },
    /** Restores the connection signed in as `next`, in a new session. */
    signIn(next: string) {
      snapshot = {
        ...connected_,
        viewer: next,
        scope: `${origin}:${next}`,
        session: { ...session } as RelaySession,
      };
      for (const listener of changes) listener();
    },
    /** Fails the connection, as a first connect that timed out does. */
    fail() {
      snapshot = { status: "error", generation: 4, session, error: "down" };
      for (const listener of changes) listener();
    },
    /** Replaces the session, as after the transport was lost. */
    reconnecting() {
      snapshot = { status: "connecting", generation: 3, session };
      for (const listener of changes) listener();
    },
    /** Drops and restores the socket inside the same session, as live.ts does. */
    recover() {
      for (const next of ["retrying", "connected"]) {
        status = next;
        for (const listener of statuses) listener();
      }
    },
    emit: (batch: LiveBatch) => {
      for (const listener of batch.replay ? replays : [...live, ...replays])
        listener(batch);
    },
    /** The relay confirms channel `id`'s roster, with these members. */
    confirm(id: string, members: string[]) {
      const index = rows.findIndex((row) => row.id === id);
      rows[index] = { id, name: id, members };
      for (const listener of rosterChanges) listener();
    },
    archives,
    attended,
    listed,
    unrouted,
    pending,
    learned,
    history,
    memories,
    session,
    presence: session.publishAgentPresence as ReturnType<
      typeof vi.fn<RelaySession["publishAgentPresence"]>
    >,
    origin,
  };
}
/** One page of `events` for `filter`, as the relay pages them: newest first,
 * ties by id ascending, below the `until`/`before_id` cursor. */
export function page(events: readonly RelayEvent[], filter: ReadFilter) {
  const until = filter.until ?? Number.MAX_SAFE_INTEGER;
  return events
    .filter(
      (event) =>
        (!filter.kinds || filter.kinds.includes(event.kind)) &&
        event.created_at >= (filter.since ?? 0) &&
        (event.created_at < until ||
          (event.created_at === until &&
            (filter.before_id === undefined || event.id > filter.before_id))) &&
        (!filter["#h"] ||
          event.tags.some(
            ([key, value]) => key === "h" && value === filter["#h"]?.[0],
          )),
    )
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1))
    .slice(0, filter.limit);
}

/** The viewer's joined communities, one selected; `open` connects any of them. */
export function fakeCommunities(...joined: ReturnType<typeof fakeRelay>[]) {
  let relays = joined;
  const changes = new Set<() => void>();
  let selected: string | null = relays[0]?.origin ?? null;
  return {
    communities: {
      snapshot: () => ({
        viewer,
        selected,
        memberships: relays.map(({ origin }) => ({ id: origin, name: origin })),
      }),
      subscribe: (listener: () => void) => {
        changes.add(listener);
        return () => changes.delete(listener);
      },
      open: vi.fn(
        (id: string) => relays.find((fake) => fake.origin === id)?.relay,
      ),
    } as unknown as AgentCommunities,
    select(next: string | null) {
      selected = next;
      for (const listener of changes) listener();
    },
    leave(origin: string) {
      relays = relays.filter((fake) => fake.origin !== origin);
      if (selected === origin) selected = null;
      for (const listener of changes) listener();
    },
  };
}

/** Agents whose removal from a community a copy of the app holds, shared by
 * every fake native over the same identities, as native's lock is. */
const removing = new WeakMap<AgentIdentity[], Set<string>>();
function held(identities: AgentIdentity[]) {
  const removals = removing.get(identities) ?? new Set<string>();
  removing.set(identities, removals);
  return removals;
}

export function fakeNative(identities: AgentIdentity[] = []) {
  let published = 0;
  const keys = [bot, sibling];
  const removals = held(identities);
  const wss = (relay: string) => relay.replace(/^https:/, "wss:");
  /** Its live row in the membership's community, as native finds it. */
  const at = ({ pubkey, relay }: Membership) =>
    identities.findIndex(
      (identity) =>
        identity.pubkey === pubkey &&
        identity.relay === wss(relay) &&
        !identity.deleted,
    );
  const edit = (member: Membership, patch: Partial<AgentIdentity>) => {
    const index = at(member);
    const identity = identities[index];
    if (identity) identities[index] = { ...identity, ...patch };
  };
  /** As native's `edit_all`: every community it is in. */
  const change = (pubkey: string, patch: Partial<AgentIdentity>) => {
    identities.forEach((identity, index) => {
      if (identity.pubkey === pubkey && !identity.deleted)
        identities[index] = { ...identity, ...patch };
    });
  };
  const native = {
    list: vi.fn(async () => [...identities]),
    create: vi.fn(async (_: string, __: string, type: string, name: string) => {
      const identity = {
        pubkey: keys.shift() as string,
        relay: "wss://relay.example.test",
        owner: viewer,
        type,
        name,
        deleted: false,
      };
      identities.push(identity);
      return identity;
    }),
    portable: vi.fn(
      async (): Promise<PortableAgents> => ({
        agents: [
          { source: "harness" as const, pubkey: bot, name: "Old", relay: "" },
          {
            source: "installed" as const,
            pubkey: sibling,
            name: "Older",
            relay: "",
          },
        ],
        teams: [],
        warnings: ["Could not read one store"],
      }),
    ),
    port: vi.fn(
      async (
        _: string,
        pubkey: string,
        destination: string,
        owner: string,
        type: string,
      ) => {
        const identity = {
          pubkey,
          relay: destination.replace(/^https:/, "wss:"),
          owner,
          type,
          name: "Older",
          deleted: false,
        };
        // As native does, under its lock every copy of the app shares: a
        // re-import replaces a deleted row and refuses a live one.
        const index = identities.findIndex((item) => item.pubkey === pubkey);
        if (index >= 0 && !identities[index]?.deleted)
          throw new Error("That agent is already here");
        if (index >= 0) identities.splice(index, 1);
        identities.push(identity);
        return { agent: identity, carry: { instructions: "Triage." } };
      },
    ),
    join: vi.fn(
      async (
        pubkey: string,
        from: string,
        destination: string,
        picture: string | undefined,
      ) => {
        const source = identities[at({ pubkey, relay: from })];
        if (!source) throw new Error("No such agent on this device");
        if (source.deleting) throw new Error(`${source.name} is being deleted`);
        const relay = wss(destination);
        if (at({ pubkey, relay }) >= 0)
          throw new Error(`${source.name} is already in that community`);
        const { picture: _, deleting: __, home: ___, ...rest } = source;
        const home = source.home ?? source.relay;
        const joined: AgentIdentity = {
          ...rest,
          // Back in its home, it is the home row again.
          ...(home !== relay && { home }),
          relay,
          ...(picture && { picture }),
          deleted: false,
        };
        // A deleted row there awaiting cleanup is taken back.
        const kept = identities.filter(
          (identity) => identity.pubkey !== pubkey || identity.relay !== relay,
        );
        identities.splice(0, identities.length, ...kept, joined);
        return joined;
      },
    ),
    rename: vi.fn(async (pubkey: string, name: string) => {
      change(pubkey, { name });
    }),
    setPicture: vi.fn(async (member: Membership, picture: string | null) => {
      const index = at(member);
      const { picture: _, ...identity } = identities[index] as AgentIdentity;
      identities[index] = picture ? { ...identity, picture } : identity;
    }),
    setType: vi.fn(async (pubkey: string, type: string) => {
      change(pubkey, { type });
    }),
    beginLeave: vi.fn(async (member: Membership) => {
      const stays = identities.some(
        (identity) =>
          identity.pubkey === member.pubkey &&
          identity.relay !== wss(member.relay) &&
          !identity.deleted &&
          !identity.deleting,
      );
      const row = identities[at(member)];
      if (!row) throw new Error("No such agent on this device");
      if (!stays && !row.deleting)
        throw new Error("Its last community goes only when it is deleted");
      steps.push("stop");
      edit(member, { deleting: true });
    }),
    beginDelete: vi.fn(async (pubkey: string) => {
      steps.push("stop");
      change(pubkey, { deleting: true });
    }),
    holdRemoval: vi.fn(async (member: Membership) => {
      const row = identities[at(member)];
      if (!row) throw new Error("No such agent on this device");
      if (!row.deleting)
        throw new Error(`${row.name} isn't being removed from that community`);
      if (removals.has(member.pubkey))
        throw new Error(
          `${row.name} is being removed in another copy of the app. Try again once it's done.`,
        );
      removals.add(member.pubkey);
    }),
    releaseRemoval: vi.fn(async (member: Membership) => {
      removals.delete(member.pubkey);
    }),
    remove: vi.fn(async (member: Membership) => {
      if (!removals.has(member.pubkey))
        throw new Error("Its removal isn't held by this app");
      steps.push("key");
      edit(member, { deleted: true });
    }),
    forget: vi.fn(async ({ pubkey, relay }: Membership) => {
      steps.push("forget");
      const index = identities.findIndex(
        (identity) =>
          identity.pubkey === pubkey &&
          identity.relay === wss(relay) &&
          identity.deleted,
      );
      if (index >= 0) identities.splice(index, 1);
    }),
    publish: vi.fn(
      async ({ pubkey }: Membership, template: AgentEventTemplate) =>
        event(`p${++published}`, {
          pubkey,
          kind: template.kind,
          content: template.content,
          tags: (template.tags ?? []).map((tag) => [...tag]),
        }),
    ),
    publishProfile: vi.fn(async (_: Membership) => {}),
    query: vi.fn<AgentsNative["query"]>(async () => []),
    searchProfiles: vi.fn(async () => undefined),
    upload: vi.fn(async () => ({ url: "", sha256: "", size: 0, type: "" })),
    media: vi.fn(async () => ({ path: "", type: "", size: 0 })),
    gitAuth: vi.fn(async () => ({ url: "", header: "" })),
    remember: vi.fn(async ({ pubkey }: Membership) =>
      event(`m${++published}`, { pubkey }),
    ),
    claim: vi.fn(async (_: string) => true),
    release: vi.fn(async (_: string) => {}),
    keepAwake: vi.fn(async (_: boolean) => {}),
  } satisfies AgentsNative;
  return native;
}
