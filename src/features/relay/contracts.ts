import type { VerifiedProfile } from "./verified-profile";
import type { ReadFilter } from "./events";
import type { CustomEmoji } from "./emoji";
import type { ReadOptions } from "./reader";
import type { Delivery } from "./outbox";

export const MAX_ATTACHMENT_DURATION_SECONDS = 86_400;

export type MessageReaction = Readonly<{
  content: string;
  emoji?: CustomEmoji;
  /** Retain every event so toggling off removes duplicate reactions by one author. */
  events: readonly Readonly<{ id: string; authorId: string }>[];
}>;

/** Folded, read-only channel state. Rows are domain data, not wire events or presentation. */
export type ChannelSummary = Readonly<{
  id: string;
  name: string;
  /** Ordinary channel prose; session machine metadata is not a description. */
  description?: string | undefined;
  /** Initial classification is unresolved until the metadata read completes. */
  metadataPending?: boolean | undefined;
  /** Explicit signed visibility; absent means unknown, not public. */
  visibility?: "public" | "private" | undefined;
  /** Default for future participants; never an existing participant's role. */
  joinRole?: "member" | "guest" | undefined;
  /** Viewer role from the relay-signed roster, independent of admission defaults. */
  viewerRole?: "owner" | "admin" | "member" | "guest" | "bot" | undefined;
  preview?: string | undefined;
  /** Newest verified user-visible activity for sidebar ordering, in Unix
   * seconds. An own send counts once the relay accepts it. */
  lastActivityAt?: number | undefined;
  /** Activity has been observed or read successfully, including an empty result. */
  activityKnown?: true;
  /** Writing unavailable: public preview, cached membership, or a guest. */
  readOnly?: true;
  /** Downloaded membership is display-only pending current relay confirmation. */
  cached?: true;
  /** A Solo chat this device is starting; the relay has not confirmed it yet. */
  pending?: true;
  /** Members-only channel omitted from directories (NIP-29 `hidden`), such as a DM. */
  hidden?: true;
  /** Relay-authored metadata; absent while metadata is unavailable. */
  /** `system` (NIP-CL): access control for app data; never in list().
   * `solo`: a stream with the Solo label (`SOLO_LABEL`), regardless of visibility. */
  channelType?: "stream" | "forum" | "dm" | "solo" | "system";
  /** Relay-authored channel visibility; private channels use restricted presentation. */
  private?: true;
  /** Relay-advertised default: the relay joins new community members here. */
  autoJoin?: true;
  /** Presentation-only parent from signed channel metadata; never grants access. */
  parentChannelId?: string | undefined;
  /** Marked Huddle room; presented through its parent conversation, not the sidebar. */
  huddle?: true;
  /** Metadata update time used for stable work-history ordering. */
  updatedAt?: number;
  archived?: true;
  /** Signed metadata cleanup interval in seconds; absent means ongoing or unknown. */
  ttlSeconds?: number;
  /** Exact members from the relay-signed roster; absent means unknown. */
  members?: readonly string[];
  /** Relay-published NIP-CL labels. Any channel admin can set them: grouping, never trust. */
  labels?: readonly string[];
  /** Relay-written creator (NIP-CL `P`): the kind:9007 signer. Ownership can move later. */
  creator?: string;
  /** Relay-written creation time in Unix seconds; compare channel age with this. */
  createdAt?: number;
  /** Other DM members from the authorized roster; empty for a self-DM. */
  participants?: readonly string[];
}>;
export type Profile = Readonly<{
  /** Relay-signed name assertion; display only, never account access. */
  verified?: VerifiedProfile;
  name: string;
  /** The name is an identity fragment, not a name supplied by kind-0 content. */
  nameIsFallback?: true;
  /** The kind-0 `name` (handle), when `name` above is a different display name. */
  username?: string;
  picture?: string;
  about?: string;
  /** Self-declared NIP-05 identifier; not proof of DNS verification. */
  nip05?: string;
  /** Self-declared display hint, not proof of ownership, membership or authority. */
  isAgent?: true;
  /** Owner named by the profile auth tag; display metadata, never authorization. */
  ownerPubkey?: string;
}>;
export type Attachment = Readonly<{
  url: string;
  kind: "image" | "video" | "audio" | "file";
  /** Sender-supplied presentation metadata; `size` is a claim, `name` is display/download only. */
  mime?: string;
  size?: number;
  name?: string;
  /** Sender/relay-claimed duration in seconds; display hint, corrected by the element. */
  duration?: number;
  waveform?: readonly number[];
  voiceNote?: true;
  dimensions?: Readonly<{ width: number; height: number }>;
  /** Validated message-carried BlurHash; decoded locally only for presentation. */
  blurhash?: string;
  /** Signed video poster or media thumbnail URL. */
  previewUrl?: string;
}>;
/** Relay-authored membership activity, not a membership grant or user message. */
export type MembershipChange = Readonly<{
  type: "member_joined" | "member_left" | "member_removed";
  actor: string;
  target: string;
}>;
export type ChannelMessage = Readonly<{
  id: string;
  channelId: string;
  delivery?: Delivery | undefined;
  deliveryError?: string | undefined;
  authorId: string;
  /** Actual signing key when relay attribution makes authorId a different identity. */
  signerId?: string | undefined;
  /** Display-only owner attested by this community’s explicit relay signer. */
  workflowOwnerId?: string | undefined;
  /** Unix seconds from the signed event. */
  createdAt: number;
  /** Effective send ms (valid `ms` tag, else createdAt * 1000); ordered by `compareMessages`. */
  createdAtMs?: number;
  content: string;
  /** Unprojected current body when attachment presentation removed Markdown. */
  sourceContent?: string;
  /** Original kind 40002, regardless of edits; self-declared display evidence, not authority. */
  agentEnvelope?: true;
  /** Signed `audience` tag of the original event: `agents` is coordination
   * between agents, shown quietly. Absent means everyone; unknown values too. */
  audience?: "agents";
  /** Original kind 40008. Untrusted display metadata; content stays a raw patch. */
  diff?: Readonly<{
    filePath?: string | undefined;
    repoUrl?: string | undefined;
    commitSha?: string | undefined;
    description?: string | undefined;
    truncated: boolean;
  }>;
  membership?: MembershipChange;
  huddle?: Readonly<{
    room: string;
    state: "started" | "ended";
    endedAt?: number;
  }>;
  /** Current body came from a replacement edit; original recipients do not bind its prose. */
  edited?: true;
  /** Offsets in `content` where attachment removal joined once-separate text; a
   * bound name never spans one. */
  attachmentSeams?: readonly number[];
  /** Pubkeys named by signed `p` tags. Identity never comes from prose. */
  mentions: readonly string[];
  /** Signed two-field mention tags bind display only; never notification recipients. */
  mentionReferences?: readonly string[];
  /** Authorized edit supplying current imeta; absent when sourced from the original. */
  attachmentSourceId?: string;
  attachments: readonly Attachment[];
  /** Event-local mappings, never the current community palette. */
  emoji?: readonly CustomEmoji[];
  reactions: readonly MessageReaction[];
  /** Canonical thread-opening target from signed reply/root tags; absent on root messages. */
  threadRootId?: string | undefined;
  /** Immediate signed reply target; separate from the canonical thread root. */
  replyParentId?: string | undefined;
  sentFromThread?:
    | Readonly<{ rootId: string; excerpt?: string | undefined }>
    | undefined;
  /** Relay-signed whole-thread reply total (including nested replies), plus this
   * client's own non-deleted reply sends that no summary has counted yet (so an
   * own reply counts before the relay's summary arrives; stored and other users'
   * replies wait for the relay's summary).
   * Falls back to direct replies when the summary lacks a valid descendant total. */
  replyCount: number;
  /** Authors of this client's own reply sends no summary has counted yet, even
   * when the relay already lists them (so an own reply's avatar shows, first,
   * before the relay's summary arrives), followed by the other pubkeys the relay
   * reports as thread participants (may be empty even with replies). */
  participants: readonly string[];
}>;
export type ListStatus = "unavailable" | "idle" | "loading" | "ready" | "error";
export type ChannelList = Readonly<{
  status: ListStatus;
  /** Set when the viewer's roster read hit its cap; omitted channels are then not evidence of removal. */
  coverage?: "partial";
  asOf?: number;
  /** Initial Recent ordering observation, independent of roster/access readiness. */
  activityStatus?: "idle" | "loading" | "ready" | "error" | "unavailable";
  channels: readonly ChannelSummary[];
  error?: string;
}>;
export type WindowStatus = "idle" | "loading" | "ready" | "error";
/** One bounded, chronologically ordered history window. Not the whole channel. */
export type ChannelWindow = Readonly<{
  channelId: string;
  status: WindowStatus;
  rows: readonly ChannelMessage[];
  /** False only after the relay's window bounds reported no more history. */
  hasMore: boolean;
  loadingOlder: boolean;
  error: string | undefined;
  /** Cached rows are immediately readable, but not claimed fresh until revalidated. */
  freshness?: "cached" | "verified";
  historyLimited?: boolean;
  /** A head read is in flight for these rows; older pages wait for it. */
  refreshing?: boolean | undefined;
}>;
/** Post-write discovery opts into writer reads; browsing keeps the default. */
export type ChannelReadOptions = ReadOptions & Pick<ReadFilter, "consistency">;
export type PublicChannelSearch = Readonly<{
  channels: readonly ChannelSummary[];
  /** The metadata read stopped at its bound, so some channels were not checked. */
  partial: boolean;
}>;
/** What a channel-only link may show about a channel the reader may not have
 * joined. `looking` means a lookup is queued or in flight; `unknown` means
 * none is, as before the list is ready, during a failure's backoff or in a
 * cached-only store. `withheld` means a completed lookup found nothing it may
 * show: the relay withholds a private channel's metadata from non-members, so
 * private, deleted and never-valid channels look the same. */
export type ChannelReference =
  | Readonly<{ state: "unknown" }>
  | Readonly<{ state: "looking" }>
  | Readonly<{ state: "withheld" }>
  | Readonly<{
      state: "found";
      name: string;
      description?: string;
      channelType?: ChannelSummary["channelType"];
      private: boolean;
      hidden: boolean;
      archived: boolean;
      joined: boolean;
      /** Only when the viewer may see the roster. */
      members?: number;
      /** A public channel the viewer left is named by its open metadata, but
       * its messages stay unreadable until a lookup confirms it is still
       * open; `looking` while that lookup is queued or in flight. */
      readable?: false;
      looking?: true;
    }>;
/** Reads are side-effect-free; snapshots retain identity until their value changes.
 * Commands are idempotent requests; the store decides whether network work is needed. */
export interface ChannelQueries {
  list(): ChannelList;
  /** Bounded discovery lookup; never inserts public previews into list(). */
  get?(channelId: string): ChannelSummary | undefined;
  resolve?(
    channelIds: readonly string[],
    options?: ChannelReadOptions,
  ): Promise<void>;
  /** Name lookup for active public channels the viewer has not joined. Matches
   * become readable through `get`; they never enter list(). `progress`
   * receives the matches so far each time another metadata page lands. */
  searchPublic?(
    query: string,
    options?: ReadOptions & {
      limit?: number;
      exact?: boolean;
      progress?: ((found: PublicChannelSearch) => void) | undefined;
    },
  ): Promise<PublicChannelSearch>;
  /** Ids of the active public channels the relay flags `auto_join` that the
   * viewer has not joined, from the same directory read as `searchPublic`,
   * with its `partial` bound. Candidates only: joining one re-reads its
   * signed metadata and roster. */
  defaultChannels?(
    options?: ReadOptions,
  ): Promise<Readonly<{ ids: readonly string[]; partial: boolean }>>;
  /** NIP-CL lookup of the channels `creator` made with `label`, oldest first.
   * Includes the system channels the viewer can read, since `#P` asks for them.
   * Matches become readable through `get`; they never enter list(). */
  findLabeled?(
    query: Readonly<{ creator: string; label: string }>,
    options?: ChannelReadOptions,
  ): Promise<readonly ChannelSummary[]>;
  /** Synchronous: the last `searchPublic` answer's channels, or its latest
   * `progress` rows while its read goes on, that still match `query` and are
   * still open previews. Keeps rows while the next search runs, even across
   * a remount. */
  matchPublic?(
    query: string,
    options?: { exact?: boolean },
  ): readonly ChannelSummary[];
  /** Every open channel the last completed public directory read named, for
   * display-only name references (`#name` in prose) until a later read or a
   * cache clear replaces it. Never reads and never grants access: a match
   * resolves through `refer`. Empty while the directory is cold or in flight. */
  openDirectory?(): readonly Pick<
    ChannelSummary,
    "id" | "name" | "description" | "channelType" | "archived"
  >[];
  /** The open channels to browse: a first read's pages so far as they land,
   * otherwise `openDirectory`'s. Display only, like `openDirectory`. */
  browseDirectory?(): ReturnType<NonNullable<ChannelQueries["openDirectory"]>>;
  /** Hears each `browseDirectory` page and finished read. List subscribers
   * hear only a finished read, so pages never wake the rest of the app. */
  subscribeDirectory?(listener: () => void): () => void;
  /** Whether `browseDirectory` names a finished read's channels, rather than
   * the first read's pages so far or none. */
  directoryComplete?(): boolean;
  /** Read the whole open-channel directory for browsing, sharing the
   * `searchPublic` read; `browseDirectory` names its channels as pages land.
   * Never grants access: opening a channel resolves it. */
  readDirectory?(options?: {
    signal?: AbortSignal | undefined;
  }): Promise<{ partial: boolean }>;
  /** Member counts for browsing, from a joined channel's roster or an open
   * channel's relay-signed one, kept a few minutes. A channel without a
   * roster is left out of `counts`; `failed` names the ids whose read
   * failed, while the rest still answer. Display only: never grants access. */
  readMemberCounts?(
    channelIds: readonly string[],
    options?: { signal?: AbortSignal | undefined },
  ): Promise<{
    counts: ReadonlyMap<string, number>;
    failed: readonly string[];
  }>;
  /** Current reference state from local evidence; never reads. */
  describe?(channelId: string): ChannelReference;
  /** Demand a background lookup for a reference that isn't `found`, or is
   * found but not `readable`, until the returned release. The store coalesces requests into bounded reads, keeps
   * a `withheld` answer for a few minutes, backs off after failures,
   * rechecks demanded references when either ends, and notifies list
   * subscribers once per batch as a lookup starts (unless it only rechecks
   * withheld answers) and when it ends. Absent when no lookup can run, as in
   * a cached-only store. */
  refer?(channelId: string): () => void;
  /** Exact re-read of one already-listed channel's roster, merged into the
   * ready list. `resolve` admits channels the list lacks; this confirms a
   * membership change on one it already carries, without a full rediscovery.
   * Returns true only when the read supplied a fresh roster. */
  refreshRoster?(
    channelId: string,
    options?: ChannelReadOptions,
  ): Promise<boolean>;
  /** Lists a Solo chat this device is creating, as `pending`, until the
   * relay's signed metadata and roster for it arrive. It has no history to
   * read meanwhile. Local display and intent only; never saved. */
  start?(
    channel: Readonly<{
      id: string;
      name: string;
      members: readonly string[];
      labels: readonly string[];
      ttlSeconds?: number | undefined;
    }>,
  ): void;
  /** Drops a started chat the relay did not confirm. */
  abandon?(channelId: string): void;
  subscribeList(listener: () => void): () => void;
  window(channelId: string): ChannelWindow;
  subscribeWindow(channelId: string, listener: () => void): () => void;
  ensureList(): void;
  ensure(channelId: string): void;
  loadOlder(channelId: string): void;
  /** Explicit same-scope head revalidation; replaces the bounded head, not a realtime tail. */
  refresh?(channelId: string): void;
  /** Intent warming is optional for fixture-only query implementations. */
  prepare?(channelId: string): void;
  /** Roster warming is optional for fixture-only query implementations. The
   * caller supplies preferred (e.g. starred) ids; the store orders the rest. */
  warm?(preferred: readonly string[]): void;
  refreshList?(options?: Pick<ChannelReadOptions, "consistency">): void;
}
