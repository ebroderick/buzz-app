import { followUpQueue } from "../messages/follow-up-queue";
import type {} from "../navigation/service";
import { removeSessionPrompts } from "./session-prompts";
import { appClient, readFile } from "../../buzz-mcp/app-client";
import { respond } from "../../buzz-mcp/rpc";
import { respondExternal } from "../../buzz-mcp/external";
import type { ExternalScope } from "./external-connection";
import { externalMcpEnabled } from "./external-connection";
import { connectMcp } from "../../buzz-mcp/connection";
import { type HarnessKit, harnessKit } from "../agent-harness/kit";
import { repositoriesContext } from "../communities/repositories";
import type {
  HostMcpServer,
  HostProcess,
  HostProcessOptions,
} from "../host/service";
import { spawnAgentCommand } from "./command";
import { bundledAttention } from "./attention-command";
import { sourceCompleted, sourceSignature } from "./attention";
import {
  AgentProtectionService,
  type AgentProtection,
  type ProtectionBinding,
} from "../agent-protection/service";
import { createLocalAgentActivity } from "./local-activity";
import { bindKeepAwake } from "./keep-awake";
import {
  AgentConfigStore,
  type SettingsSchema,
  type Subject,
} from "./agent-config";
import { isSynced, type Mode, resolveStart } from "./agent-start";
import {
  type CommunityConfig,
  type ConfigAgent,
  type ConfigBase,
  type Side,
  changes,
  communityConfig,
  SIDE_TYPE,
  SIDES,
} from "./community-config";
import { headFields, type Saved } from "./config-writes";
import { importedTeamId as syncedTeamId } from "./config-channels";
import {
  SyncedTeams,
  teamArtifact,
  teamBody,
  teamSources,
} from "./team-config";
import type { TeamResult } from "./team-ops";
import type { Expected, SnapshotRead } from "./agent-config-artifacts";
import type { revertTemplate, SettingsCheck } from "./agent-config-history";
import type { RevertOutcome } from "./AgentConfigHistory";
import { nativeRelayInfo } from "../relay/native";
import { AgentRunners, type Connection, TIMEOUT_LIMIT_MS } from "./runner";
import { CoreMemoryCache } from "./core-memory-cache";
import {
  createAgentHooks,
  dispatchAgentHooks,
  type AgentHook,
  type AgentHookContext,
} from "./hooks";
import { ownerReads } from "./reads";
// Agents: agents that are plugins from the start. A plugin registers an agent
// type (its summary line, peek view, settings tabs and `run`); each agent made
// from it has its own native-held key, an `agent-attention/v1` configuration the
// app owns and the agent edits through its handle, and a config blob the type
// owns. The app delivers matching live events to
// `run` from the stream the owner already receives in the agent's community,
// selected or not, so no plugin opens a socket or a REQ.
//
// A hosted type's provider holds the key and runs the agent instead. The app
// creates it through the type's `remote` steps and signs only the owner's
// attestation. Every agent of either kind is listed in the owner's kind 30177
// records with its type as the `runtime` tag, so every device of the owner's
// can show it: as here, hosted, or on another device.
import { migrateAgentStorage } from "./migrate-storage";
import { migrateWatchFilters } from "./migrate-filter";
import { migrateWatchKeywords } from "./migrate-keywords";
import { agentStorage, type AgentStore } from "./state";
import { Service, type Context } from "@deepseek-ai/cordis";
import { npubEncode } from "nostr-tools/nip19";
import { bytesToHex } from "nostr-tools/utils";
import type { ComponentType, ReactNode } from "react";
import type { DefinedIcon } from "../../shared/design-system/icons";
import {
  createContributions,
  type Contribution,
} from "../../plugins/contributions";
import { channelTemplates, templateAgents } from "../channel-templates/local";
import type { LocalAgentsSnapshot } from "./local";
import { unshare } from "./agent-share";
import {
  deleteAgentRecord,
  publishAgentRecord,
  type AgentRecordBody,
  removeAgentFromChannels,
  removeRelayAgent,
} from "./relay-removal";
import { communityDestination, relayOrigin } from "../communities/destination";
import type { Communities } from "../communities/service";
import {
  prepareRemoteAgentAuthorization,
  type NipOaAuthorization,
} from "../host/service";
import { avatarSource } from "../../shared/avatar-source";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { newer, type EventData, type RelayEvent } from "../relay/events";
import { relayPartition } from "../relay/partition";
import { threadReference } from "../relay/thread-reference";
import { channelTabs } from "../../bundled/channels/useChannelTabState";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import {
  parseSlug,
  type AttentionObject,
  type AttentionValue,
  type EventWatch,
  type Interest,
  type TimerState,
  type TimerWatch,
} from "./attention";
import type {
  ClassifierAvailability,
  Shown,
  WatchFilter,
  WatchSummary,
  WriteOptions,
} from "./attention-objects";
import {
  excerpt,
  mentionFacts,
  type ClassifierContext,
  type ClassifierOutcome,
} from "./classifier";
import type { Decisions } from "../decisions/service";
import {
  nativeAgents,
  type AgentEventTemplate,
  type AgentIdentity,
  type Carry,
  type AgentsNative,
  type AgentMedia,
  type AgentUpload,
  type GitAuth,
  type OldTeam,
  type PortableAgents,
  type PortSource,
} from "./native";
import { agentKey, pubkeyOf, type AgentKey } from "./membership";
import {
  readArchiveUnchecked,
  readRecords,
  recordKey,
  readTeams,
  readUnfinished,
  setAttention,
  writeArchiveUnchecked,
  recentEntries,
  removeRecord,
  splitLegacyRecords,
  writeRecord,
  writeTeams,
  writeUnfinished,
  withProgress,
  type AgentRecord,
  type AttentionEntry,
  type TimerProgress,
  type SkippedObject,
  type Team,
  type Unfinished,
} from "./store";
import { soloChat } from "./solo-chat";
import {
  readCheckpoints,
  splitLegacyCheckpoints,
  writeCheckpoints,
  type Checkpoints,
} from "./catch-up";
import { readInterrupted, writeInterrupted } from "./interrupted";
import { AttentionSources, type AttentionProducer } from "./attention-sources";
import { type AddedTool, BUZZ_SESSION } from "../../buzz-mcp/session-tools";
import { nameSoloChat } from "./solo-chat-name";
import {
  clearDeletedDefaultAgent,
  forgetDefaultAgent,
} from "../solo/default-agent";

/** Where an agent runs: `here`, with its key on this device; `hosted`, by its
 * type's provider; or `elsewhere`, on another of the owner's devices. Only an
 * agent here has attention, timers and config; the others never run here. */
export type AgentPlace = "here" | "hosted" | "elsewhere";
/** One of the viewer's agents, in the community at `relay`. An agent may be
 * in several communities, each with an `Agent` of its own. */
export type Agent<Config = unknown> = Readonly<{
  /** Its membership in this community, which names it in every call here
   * and keys whatever is kept for it, such as its sessions. */
  key: AgentKey;
  /** Its identity, the same in each of its communities. */
  pubkey: string;
  name: string;
  /** Its picture in this community. */
  picture?: string;
  /** The agent type's key, `pluginId/typeId`. */
  type: string;
  owner: string;
  relay: string;
  place: AgentPlace;
  /** A hosted agent its provider made whose setup has not finished; `finish`
   * continues it. */
  unfinished?: true;
  /** Imported, but whether it is still archived in its community could not
   * be checked; `unarchive` tries again. */
  archiveUnchecked?: true;
  /** Its Delete, or its Remove from this community, did not finish: it is
   * stopped here until that runs again. */
  deleting?: true;
  protection?: ProtectionBinding;
  protectionRevision?: number;
  attention: Readonly<Record<string, AttentionObject>>;
  /** Stored attention objects that are invalid or over a limit, by slug. */
  skipped: Readonly<Record<string, SkippedObject>>;
  /** Run state of its timers, by slug; written only by the runtime. */
  timers: Readonly<Record<string, TimerState>>;
  sourceRuns?: Readonly<Record<string, string>>;
  attentionHistory?: AgentRecord["attentionHistory"];
  /** Whether its watches and timers wake it. Off keeps every object. */
  attentionEnabled: boolean;
  /** Its type's settings, the same in each of its communities. */
  config: Config;
  /** The synced head each synced side's editor opens; Save revises it. */
  configBase?: ConfigBase;
  /** Why a synced side can't be read here; its field is then not shown. */
  configProblem?: string;
}>;
export type AgentChange<Config = unknown> = Readonly<{
  name?: string;
  /** An HTTPS image URL; `null` or empty removes the picture. */
  picture?: string | null;
  config?: Config;
  attentionEnabled?: boolean;
  /** Slug to new value; `null` deletes the object. */
  attention?: Readonly<Record<string, AttentionValue | null>>;
  /** Sets only a watch's enabled state, if the displayed object is still current. */
  watchEnabled?: Readonly<
    Record<string, Readonly<{ enabled: boolean; expected: AttentionObject }>>
  >;
  /** Timers in `attention` to start over: a new schedule from their
   * `armed_at`, with no occurrences used. */
  restart?: readonly string[];
  /** The `configBase` of the agent the editor opened: Save revises it. */
  base?: ConfigBase;
}>;
/** What a type's read-only peek receives. */
export type AgentPeekProps<Config = unknown> = { agent: Agent<Config> };
export type AgentSettingsHost = Readonly<{
  /** A labelled Type control supplied only by the Agents build view. */
  typeControl?: (dirty: boolean) => ReactNode;
  /** Host-owned type change committed with the target type's settings draft. */
  pendingSave?: (config?: unknown) => Promise<void>;
}>;
/** What each of a type's settings tabs receives. A type writes only its own
 * config; the app owns the name and attention. */
/** The message's conversation a profile was opened from: its channel, and its
 * thread root when the message had one. Which session that is stays the type's
 * own rule. */
export type AgentConversation = Readonly<{
  channelId: string;
  rootId?: string;
}>;
/** A panel's ask for a conversation's transcript. `opening` identifies it: a
 * new number is a new opening, even of the conversation already shown. */
export type TranscriptRequest = Readonly<{ opening: number; done(): void }>;
export type AgentViewProps<Config = unknown> = {
  agent: Agent<Config>;
  /** Where the agent was opened from, when it was opened from a conversation. */
  conversation?: AgentConversation;
  /** Present while the panel asks to show that conversation's transcript
   * first: an Activity tab does so if it knows it then, or once its lookup
   * finds it unless the reader acts first, and calls `done` once it has
   * decided, so the panel asks only once. */
  initialTranscript?: TranscriptRequest;
  /** Closes the panel showing the tab. */
  close?: () => void;
  /** Opens a channel, or a thread by its root, in the agent's community;
   * absent where the host can't open one. */
  openConversation?: (channelId: string, threadRootId?: string) => void;
  /** Replaces the type's whole config. Spread `agent.config` to change one
   * field, or tabs that each save a part will erase each other's fields. A
   * hosted type's tabs save to its provider instead; for them this rejects. */
  save(config: Config): Promise<void>;
  /** Host identity/retype framing for a Settings tab. Other surfaces omit it. */
  settingsHost?: AgentSettingsHost;
  /** Optional presentation split for providers that declare splitSettings. */
  settingsSection?: "identity" | "runtime";
  /** Host management rows, shown before provider diagnostics. */
  settingsContent?: ReactNode;
};
/** What a type's part of the New agent dialog receives: the new agent's
 * starting config, from `defaults`, to fill in. The app owns its key, name and
 * picture around it. */
export type AgentCreateProps<Config = unknown> = {
  /** Model fields may use the compact card treatment in the library. */
  modelAppearance?: "glass-ghost";
  config: Config;
  onChange(config: Config): void;
  disabled: boolean;
};
export type AgentTab<Config = unknown> = Readonly<{
  id: string;
  title: string;
  /** Lets the Agents build view place host-owned Type controls in this tab. */
  role?: "settings" | "activity";
  /** Supports separate identity and runtime settings presentations. */
  splitSettings?: boolean;
  component: ComponentType<AgentViewProps<Config>>;
}>;
/** A tab a plugin adds to the settings of every agent running on this device,
 * whatever its type, or only those `when` accepts. It reads the agent and
 * saves through the plugin's own `agents`. */
export type AgentAddedTab = Readonly<{
  id: string;
  title: string;
  component: ComponentType<{ agent: Agent }>;
  /** Whether the tab shows for this agent; absent, it shows for each. */
  when?: (agent: Agent) => boolean;
  /** Calls `listener` when `when` may answer differently. */
  subscribe?: (listener: () => void) => () => void;
}>;
export type RegisteredAgentAddedTab = Contribution<AgentAddedTab>;
/** One of an agent's conversation sessions on this device. Without `root` it
 * is the channel's one session: a channel-scoped agent's, a DM's or a Solo
 * chat's; with it, the thread's. `at` is when it last took in a message
 * or ended a turn, in milliseconds. `status` is the type's latest
 * observation of it while running here, such as "Working", "Idle" or a
 * failed turn's outcome; absent means unobserved, not idle. */
export type AgentSession = Readonly<{
  channelId: string;
  root?: string;
  at?: number;
  status?: string;
}>;
/** Read-only: reading never starts, stops or changes a session. */
export type AgentSessions = Readonly<{
  list(agent: AgentKey): readonly AgentSession[];
  subscribe(listener: () => void): () => void;
}>;
/** Token counts as the harness reported them. An absent count is unknown, not
 * zero. `input` excludes the cache counts; together they are the prompt. */
export type TokenCounts = Readonly<{
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Of `cacheWrite`, those cached for an hour rather than five minutes. */
  cacheWrite1h?: number;
}>;
/** One model request of a session, as the harness recorded it. */
export type UsageObservation = Readonly<{
  /** The harness's id for the request, when it records one; unique within
   * the session. */
  requestId?: string;
  /** When the harness recorded the request, in milliseconds. */
  at: number;
  model: string;
  tokens: TokenCounts;
  /** USD the harness itself recorded, and how it says it got it, e.g.
   * goose's `estimated`; absent when it records none. */
  cost?: Readonly<{ usd: number; source: string }>;
}>;
/**
 * A snapshot of one harness session an agent ran on this device: all its
 * usage, its descendants' (subagents') included, so a consumer never adds a
 * child session again. `channelId` and `root` say where in Buzz it started,
 * when the session records it.
 *
 * A snapshot without `gaps` is complete: it replaces whatever a consumer kept
 * for the session. An incomplete one should leave the consumer's previous
 * snapshot in place and report the gap. A session missing from a later read
 * is not deleted: its source may be gone, not its usage.
 */
export type SessionUsage = Readonly<{
  /** The harness's own session id, opaque to others. */
  id: string;
  /** Equal for two reads that saw the same usage. Opaque and unordered: it
   * says whether a snapshot changed, not which is newer. */
  revision: string;
  /** What the read could not see, e.g. a subagent's vanished file. */
  gaps: readonly string[];
  channelId?: string;
  root?: string;
  title?: string;
  startedAt: number;
  lastAt: number;
  observations: readonly UsageObservation[];
}>;
/** A conversation to wake an agent in, and what to tell it there. `root` is
 * the thread's root event id; leave it out for a Solo chat. */
export type AgentWake = Readonly<{
  channel: string;
  root?: string;
  text: string;
}>;
/** The conversation a self-handoff came from: no channel for a watch's or
 * timer's standalone turn. */
export type HandoffSource = Readonly<{ channel?: string; root?: string }>;
/** A wake the agent sends itself, `from` another of its conversations. */
export type AgentHandoff = AgentWake & Readonly<{ from: HandoffSource }>;
/** The agent as `run` holds it. A run's handle works for as long as the
 * agent exists; one from `Agents.handle` fails each call while `handle`
 * would not return it, and for good once the agent's type or its plugin is
 * replaced, so ask for a new one then. */
export type AgentHandle = Readonly<{
  key: AgentKey;
  protection?: AgentProtection | undefined;
  pubkey: string;
  name: string;
  owner: string;
  /** Installed local types and owner-reviewed creation requests. */
  agentTypes?(): readonly Readonly<{ key: string; title: string }>[];
  createAgent?(
    input: AgentCreationInput,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  /** Owner-reviewed changes to one of the owner's agents here. */
  updateAgent?(
    input: AgentUpdateInput,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  /** On a run's handle only: wakes this agent in another of its
   * conversations, as `Agents.wake` would, telling it the wake is its own. */
  handoff?(handoff: AgentHandoff): void;
  /** Rechecks an operation lifetime after channel startup, before signing. */
  publish(event: AgentEventTemplate, check?: () => void): Promise<RelayEvent>;
  /** Reads the community as the agent, seeing only what it may see. */
  query(filters: readonly object[]): Promise<RelayEvent[]>;
  /** Finds profiles by `name` or `display_name`, as the agent, best match
   * first. `undefined` when its community has no profile name search. */
  searchProfiles(
    query: string,
    limit: number,
  ): Promise<RelayEvent[] | undefined>;
  /** Uploads base64 `data`, a file of any type its community accepts, as
   * the agent. `mime` is a hint; the community decides the type. */
  upload(data: string, mime: string): Promise<AgentUpload>;
  /** Saves one of its community's media blobs, of any type, by URL or
   * `sha256[.ext]`, to a local file for the agent. */
  media(url: string): Promise<AgentMedia>;
  /** Repository `repo` of `owner` in its community: its URL, and the Git
   * header that authorizes it there as the agent for a minute. */
  gitAuth(owner: string, repo: string): Promise<GitAuth>;
  /** Writes memory entry `slug`, newer than the entry it replaces (`after`,
   * that entry's `createdAt`, or 0); a `null` body deletes it. The owner
   * reads it back. */
  remember(
    slug: string,
    body: string | null,
    after: number,
  ): Promise<RelayEvent>;
  /** The owner's channel templates on this device, each with the agents it
   * adds that are the owner's agents in this agent's community. */
  templates(): readonly Readonly<{
    name: string;
    canvas: string;
    agents: readonly string[];
  }>[];
  /** The owner's thread tabs on this device in the agent's community;
   * undefined while it is not connected. */
  tabs(): ReturnType<typeof channelTabs> | undefined;
  /** Takes notes for this conversation, oldest first. A thread session passes
   * its root; a channel session omits it and takes all notes in the channel. */
  notes?(channelId: string, root?: string): readonly string[];
  /** Puts back notes taken for a turn that never began, ahead of any left
   * since, targeting the same conversation that took them. */
  restoreNotes?(
    channelId: string,
    notes: readonly string[],
    root?: string,
  ): void;
  /** The agent's own attention, one object at a time. */
  attention: AgentAttention;
}>;
/** What an agent reads and writes of its attention. Every read is current,
 * so a long run sees the owner's switch and the classifier's state change. */
export type AgentAttention = Readonly<{
  /** False when the owner turned attention off: none of its objects wakes the
   * agent. The handle still reads and writes them; the attention tools refuse
   * every call while it is off. */
  enabled(): boolean;
  /** Whether a watch's classifier can run now. Classifiers can be saved
   * either way; one that cannot run lets every event pass. */
  classifier(): ClassifierAvailability;
  /** One object and its expected-state token. `interest` scopes the read:
   * an object of another Interest is `wrong-scope`. */
  show(slug: string, interest?: string): Promise<Shown>;
  interests(search?: string): readonly string[];
  watches(filter?: WatchFilter): readonly WatchSummary[];
  /** Replaces, or with `null` removes, one object; returns it as shown after
   * the write. Throws an AttentionError when refused. */
  write(
    slug: string,
    value: AttentionValue | null,
    options: WriteOptions,
    /** Rechecked when the queued mutation is applied, including after token calculation. */
    check?: () => void,
  ): Promise<Shown>;
}>;
export type { ClassifierOutcome } from "./classifier";
export type CaughtUp = Readonly<{
  event: RelayEvent;
  classifier?: ClassifierOutcome;
}>;
/** A local wake delivered in a conversation, never a signed message: a
 * plugin's (`Agents.wake`), the agent's own `from` another of its
 * conversations (the `self_handoff` tool), or Attention's. */
export type ConversationWake = Readonly<
  {
    channel: string;
    root?: string;
    /** Explicit channel-level delivery when no thread is saved. */
    topLevel?: true;
    text: string;
    id: string;
    at: number;
  } & (
    | { type: "plugin"; plugin: string }
    | { type: "plugin"; from: HandoffSource }
    | { type: "attention" }
  )
>;
export type Trigger =
  /** Directly addressed: a chat message that mentions the agent. `resumed`
   * when its turn was working as the app closed or reloaded, which stopped it
   * partway, and the owner chose to resume it (see `AgentType.resumes`). */
  | Readonly<{ type: "mention"; event: RelayEvent; resumed?: true }>
  | ConversationWake
  /** One matching watch; an event that matches several runs once for each. */
  | Readonly<{
      type: "watch";
      event: RelayEvent;
      slug: string;
      watch: EventWatch;
      /** Absent when the watch names an Interest that does not exist. */
      interest?: Interest;
      /** Set when the watch has a classifier: its answers, or why it did
       * not run or failed. An event the classifier cannot check passes
       * rather than lose a match, and the agent is told why. */
      classifier?: ClassifierOutcome;
    }>
  /** Events one watch missed while the agent was offline, delivered together
   * once it is back: oldest first, from one channel unless it watches "all". */
  | Readonly<{
      type: "catch-up";
      slug: string;
      watch: EventWatch;
      /** Absent when the watch names an Interest that does not exist. */
      interest?: Interest;
      /** Each with its classifier outcome when the watch has a classifier;
       * only the events it passed are here. */
      events: readonly CaughtUp[];
      /** Older missed events were skipped: catch-up reads a bounded window. */
      skipped?: boolean;
    }>
  | Readonly<{
      type: "source";
      interest?: Interest;
      slug: string;
      watch: import("./attention").SourceWatch;
      plugin: string;
      text: string;
      classifier?: ClassifierOutcome;
    }>
  | Readonly<{
      type: "timer";
      slug: string;
      timer: TimerWatch;
      /** Absent when the timer names an Interest that does not exist. */
      interest?: Interest;
      /** This is its last allowed occurrence. */
      spent: boolean;
    }>;
/** A turn with no conversation and nothing saved, such as for a watch or a
 * timer. */
export type StandaloneTurn<Config = unknown> = Readonly<{
  /** The watch's or timer's delivery. */
  delivery: Delivery<Config>;
  /** Names the turn, for status views. */
  key: string;
  /** Aborts when the agent is removed, its type is replaced, or
   * STANDALONE_DEADLINE_MS after the turn starts (agent-harness/standalone).
   * Unlike the delivery's signal, it does not count time spent waiting in
   * the lane. A harness waits for readiness under it and stops its turn when
   * it aborts. */
  signal: AbortSignal;
  /** The turn's whole prompt, asked once the harness is ready to start it.
   * Undefined means it is no longer wanted, so no turn starts. */
  prompt(): Promise<string | undefined>;
}>;
/** How a standalone turn ended. */
export type TurnResult = Readonly<{ ok: boolean; error?: string }>;
export type Delivery<Config = unknown> = Readonly<{
  trigger: Trigger;
  /** The live route's channel; absent when the wire scope was ambiguous. */
  channelId?: string;
  agent: AgentHandle;
  /** The agent's config when this run started. */
  config: Config;
  /** The synced config revisions this run started from; empty when local. */
  revisions?: readonly string[];
  /** The synced settings in `config`. A launch shows an error instead of
   * replacing one its runtime doesn't offer with a default (NIP-AP). */
  synced?: Readonly<Record<string, string>>;
  /** The model the owner asked for in the triggering message: one of the
   * type's `models`. Absent means the agent's own model. */
  model?: string;
  /** The effort level the owner asked for in the triggering message: one of
   * that model's `efforts`. Absent means the agent's own default. */
  effort?: string;
  /** A section for each team the agent is on, with the team's name, roster and
   * instructions, to follow the agent's own instructions. Absent without one. */
  team?: string;
  /** Aborts on the run's deadline, or when the agent is removed or its type is
   * replaced. Advisory: the handle keeps working, so finishing up is harmless. */
  signal: AbortSignal;
  /** Keeps the run counted as working after `run` returns, until `done`
   * settles, for a type that hands its work off and returns early. `done`
   * resolving `{ ok: false, error }` fails the request; `{ ok: true,
   * stopped: true }` says the owner's Stop ended its turn. */
  workingUntil(done: PromiseLike<unknown>): void;
  /** Optional presentation evidence supplied by the harness, not inferred by the UI. */
  step?(tool: string, target?: string): void;
  /** The plugin declined this request; no work or successful outcome is implied. */
  ignored?(): void;
  /** The harness acknowledged this exact request. Not proof of model consumption. */
  acknowledged?(): void;
  /** A newer acknowledged request owns this turn's activity; hide this message's
   * bubble without claiming success or changing the execution outcome. */
  superseded?(): void;
  /** Offers the owner Stop on this request's activity: `stop` stops the turn
   * the request is in, and resolves once the harness has asked it to. The
   * turn still settles what it handed to `workingUntil`. */
  interruptible?(stop: () => Promise<void>): void;
  /** The harness's own title for this mention's conversation. The host may
   * name a Solo chat with it once; the type need not know whether it did. */
  named?(title: string): void;
  /** Rebuilds an addressed subscription prompt after harness readiness or a queue wait. */
  wakeText?(): Promise<string | undefined>;
  /** Whether the trigger should still run, asked again now. False once the
   * agent is removed or its type replaced; for a watch or timer, also once
   * attention was turned off or its object disabled or removed; and for a
   * watch, once it was changed or its event no longer matches. A type that queues a
   * watch's or timer's work asks before it starts that work. */
  current(): boolean;
}>;
export type Effort = Readonly<{ id: string; label: string }>;
/** An immediate session action: `compact` summarizes its history to free
 * context, and `new` starts a new session. */
export type SessionAction = "compact" | "new";
/** Immediate controls for an existing conversation; separate from run picks. */
export type SessionControlAction = SessionAction | "interrupt";
export type SessionPlace = Readonly<{ channelId: string; root?: string }>;
export type SessionState = "idle" | "active" | "compacting" | "unavailable";
export type AgentMigrationSetting = Readonly<{
  id: string;
  label: string;
  isOverride: boolean;
  /** Matching keys mean this override has the same effect after migration. */
  unchangedKey?: string;
}>;
/** A model with its effort levels, lowest first. */
export type Model = Readonly<{
  id: string;
  label: string;
  efforts: readonly Effort[];
  /** The effort a run on it uses without a pick, when known. */
  effort?: string;
}>;
/** The models an owner can pick from, and the id of the one used without a pick. */
export type Models = Readonly<{
  current: string;
  models: readonly Model[];
  /** Send displayed defaults as per-turn picks even when untouched. Opt in only
   * when explicit defaults preserve this provider's running-turn semantics. */
  sendDefaults?: boolean;
}>;
export type AgentProviderSnapshot = Readonly<{
  readiness: "checking" | "ready" | "attention";
  /** Action-oriented menu copy for direct recovery or recovery guidance. */
  attentionLabel?: string;
  /** Installation and sign-in work must be cancelled before its dialog closes. */
  blocking?: boolean;
}>;
export type AgentProvider = Readonly<{
  snapshot(): AgentProviderSnapshot;
  subscribe(listener: () => void): () => void;
  /** Refreshes device-wide readiness without changing installation or auth. */
  check(): void | Promise<void>;
  /** Handles the current attention state directly; absent opens DialogBody. */
  attentionAction?: (() => void) | undefined;
  /** Provider-owned recovery/progress controls and optional saved defaults. */
  DialogBody: ComponentType<{ onClose(): void }>;
  /** Compact device default picker; persistence remains provider-owned. */
  DefaultControl?: ComponentType<{ onConfigure(): void }>;
}>;
/** The artifact types an agent's config channel binding has made synced. */
export type ConfigBinding = Readonly<{
  settings?: Readonly<{ mode: Mode; subject: Subject }>;
  instructions?: Readonly<{ mode: Mode; subject: Subject }>;
}>;

export type AgentType<Config = unknown> = {
  /** Native callback events this harness exposes to plugins. */
  hooks?: Readonly<{ events: readonly string[] }>;
  id: string;
  title: string;
  description?: string;
  /** Decorative design-system mark shown with this type in host-owned choices. */
  icon?: DefinedIcon;
  /** A new agent's starting config and attention objects. */
  defaults(): Readonly<{
    config: Config;
    attention?: Readonly<Record<string, AttentionValue>>;
  }>;
  /** A brought-over agent's config: `config` from `defaults` with whatever of
   * `carry` the type has a place for. Without it, all of `carry` stays behind. */
  adopt?(carry: Carry, config: Config): Config;
  /** Recognize a published catalog runtime and seed this type's import draft.
   * Return undefined when its runtime/provider cannot be preserved by this type. */
  importShared?(source: {
    runtime?: string;
    provider?: string;
    model: string;
  }): Config | undefined;
  /** The inverse of `importShared`: the catalog runtime, provider and model a
   * share or export of `config` records. Without it, its agents are not shared. */
  exportShared?(config: Config): Readonly<{
    runtime: string;
    provider?: string;
    model: string;
  }>;
  /** What of `config` another type may adopt when the agent changes type.
   * Without it, all of its settings stay behind. */
  carry?(config: Config): Carry;
  /** Describes harness settings for a type-change preview. Rendered labels
   * never determine migration behavior. */
  describeMigration?(config: Config): readonly AgentMigrationSetting[];
  /** Brief runtime consequence of leaving this type. */
  migrationWarning?: string;
  /** One short line under the agent's name, e.g. its model; defaults to the title. */
  summary?(agent: Agent<Config>): string;
  /** A read-only glance shown when the agent is selected in the grid. */
  Peek?: ComponentType<AgentPeekProps<Config>>;
  /** The type's choices in the New agent dialog, such as model and
   * instructions; the new agent starts with the config it settles on. */
  Create?: ComponentType<AgentCreateProps<Config>>;
  /** Provider-owned account notice, pinned across the agent's tabs.
   * Return null when no account notice is needed. The active settings view may
   * replace this slot through the AgentSaveFooter context's setPanelNotice(content),
   * clearing it with null on cleanup; the host retains outgoing content through exit.
   * By default a notice dims identity artwork and closes name/avatar editors.
   * Ordinary load/save notices must set data-agent-access-required="false" on
   * their outer DOM element to opt out of those access effects. Both kinds share
   * host-owned placement and measured scroll space. */
  PanelFooter?: ComponentType;
  /** Provider-owned sign-in gate for messaging and name/avatar editing actions. */
  ProfileActions?: ComponentType<{ children: ReactNode }>;
  /** Compact model field for creation and library cards; the type owns discovery and configuration. */
  CreateModel?: ComponentType<AgentCreateProps<Config>>;
  /** Device-wide readiness and management. Agents supplies the menu row,
   * provider identity, modal framing and focus behavior. */
  provider?: AgentProvider;
  /** The type's settings tabs, in order. */
  tabs?: readonly AgentTab<Config>[];
  /** Each agent's sessions, for views across agents. */
  sessions?: AgentSessions;
  /** Models and effort levels the owner can pick for the next run while
   * mentioning the agent. Discovery may be async but must not start a turn.
   * The picks reach that run as `Delivery.model` and `Delivery.effort`. */
  models?(agent: Agent<Config>): Models | Promise<Models>;
  /** Offers immediate controls for the agent's session scope: under `channel`
   * a channel's top-level message joins the channel's one session, and under
   * `thread` it starts a thread of its own, with no session to act on. A DM or
   * Solo chat is one session either way. */
  sessionControls?: {
    scope(agent: Agent<Config>): "thread" | "channel";
    state(agent: Agent<Config>, place: SessionPlace): SessionState;
    run(
      agent: Agent<Config>,
      place: SessionPlace,
      action: SessionControlAction,
    ): Promise<void>;
    subscribe(listener: () => void): () => void;
  };
  /** Read-only: snapshots of the sessions the agent ran from Buzz on this
   * device with activity since `since` (milliseconds). `since` only bounds
   * activity time; it is no checkpoint, and a session last active before it
   * that the harness later corrected is not read again. Reading never starts,
   * stops or changes a session; rejects when `signal` aborts. */
  usage?(
    agent: Agent<Config>,
    options: Readonly<{ since: number; signal: AbortSignal }>,
  ): Promise<readonly SessionUsage[]>;
  /** The settings that sync across devices and how they merge into this
   * device's config. Without it, the type's settings never sync. */
  syncedSettings?: Readonly<{
    schema: SettingsSchema;
    withSynced(
      config: Config,
      settings: Readonly<Record<string, string>>,
    ): Config;
  }>;
  /** Runtime routes its supported security boundaries through AgentHandle.protection. */
  protection?: true;
  /** Why protected runs must stop when this runtime cannot enforce the contract. */
  protectionUnavailable?: string;
  /** Fully retires native sessions for this membership key before policy changes. */
  retire?(key: string): Promise<void>;
  run?(delivery: Delivery<Config>): void | Promise<void>;
  /** Runs a standalone turn and settles when it ends, stopping it when
   * `turn.signal` aborts. With it, the host runs watches and timers as
   * standalone turns in their Interest's lane, and `run` gets only mentions. */
  runOnce?(turn: StandaloneTurn<Config>): Promise<TurnResult>;
  /** Per-run deadline in milliseconds, up to 30 minutes; defaults to 60 seconds. */
  timeoutMs?: number;
  /** Its turns run in this page, so closing or reloading the app stops them.
   * With this, a mention turn still working then is kept, and given to `run`
   * again marked `resumed` if the owner chooses to resume it, to carry on in
   * the conversation's saved session, or in a new one shown the conversation. */
  resumes?: boolean;
  /** Makes the type hosted: its provider runs each agent, so it has no `run`,
   * `models` or `timeoutMs`, and its agents have no attention. */
  remote?: RemoteAgentType;
};
/** A hosted type's provider: it holds each agent's key and runs it. The app
 * calls these in order to create one (`provision`, then `activate`) and owns
 * the owner's agent list; every step is asked again after a failure, so each
 * must be safe to repeat. `community` is the agent's `wss://` community. */
export type RemoteAgentType = Readonly<{
  /** Makes the agent and resolves with its pubkey and the picture it was
   * made with, which a retried creation keeps. Not yet its owner's. */
  provision(
    input: Readonly<{
      name: string;
      /** An HTTPS image URL. */
      picture?: string;
      community: string;
      config?: unknown;
      signal: AbortSignal;
    }>,
  ): Promise<Readonly<{ pubkey: string; picture?: string }>>;
  /** Hands over the owner's attestation (NIP-OA), which the agent attaches to
   * what it signs. The provider publishes its profile with the name and
   * picture it was made with, and starts it. */
  activate(
    input: Readonly<{
      pubkey: string;
      name: string;
      community: string;
      auth: NipOaAuthorization;
      config?: unknown;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  /** Publishes its profile with this name and picture (an HTTPS image URL). */
  profile(
    input: Readonly<{
      pubkey: string;
      community: string;
      name: string;
      picture?: string;
      signal: AbortSignal;
    }>,
  ): Promise<void>;
  /** Stops the turn it is running in one conversation, named by its channel
   * and thread root (a top-level message's own id). False when nothing there
   * was running. Without it, its turns offer no Stop. */
  interrupt?(
    input: Readonly<{
      pubkey: string;
      community: string;
      channelId: string;
      threadRootId: string;
      signal: AbortSignal;
    }>,
  ): Promise<boolean>;
  /** Stops it and deletes its key. An agent already gone counts as removed. */
  remove(
    input: Readonly<{ pubkey: string; community: string; signal: AbortSignal }>,
  ): Promise<void>;
}>;
export type RegisteredAgentType = Contribution<AgentType>;
export type RetypePreview = Readonly<{
  /** Destination settings after applying the target type's migration policy. */
  config: unknown;
  moved: readonly (keyof Carry)[];
  dropped: readonly (keyof Carry)[];
  settings: readonly Readonly<{
    id: string;
    label: string;
    outcome: "reset" | "dropped";
  }>[];
}>;
/** A proposal's picture: uploads it once the proposal is valid, giving its
 * HTTPS image URL. */
export type ProposedPicture = () => Promise<string>;
type AgentCreation = Readonly<{ type: string; name: string }>;
/** A requested agent. */
export type AgentCreationInput = AgentCreation &
  Readonly<{ picture?: ProposedPicture }>;
/** An unsaved creation request; `picture` is an HTTPS image URL. Only the
 * owner-facing review may approve it. */
export type AgentCreationRequest = AgentCreation &
  Readonly<{
    picture?: string;
    id: string;
    requester: string;
    requesterName: string;
    owner: string;
    community: string;
  }>;
/** Proposed changes; absent fields stay as they are. `picture` is an HTTPS
 * image URL. */
export type AgentUpdate = Readonly<{
  name?: string;
  type?: string;
  instructions?: string;
  picture?: string;
}>;
/** `agent` is a pubkey or the exact name of one of the owner's agents here. */
export type AgentUpdateInput = Omit<AgentUpdate, "picture"> &
  Readonly<{ agent: string; picture?: ProposedPicture }>;
/** An unsaved change request. Only the owner-facing review may approve it. */
export type AgentUpdateRequest = AgentUpdate &
  Readonly<{
    id: string;
    requester: string;
    requesterName: string;
    owner: string;
    community: string;
    agent: string;
    agentName: string;
    /** Its type when requested, shown as what the review changes from. */
    agentType: string;
  }>;
export type AgentsSnapshot = Readonly<{
  status: "unavailable" | "loading" | "ready" | "error";
  /** Whether a watch's classifier can run on this device now. */
  classifier: ClassifierAvailability;
  /** The selected community's agents, while it is connected. */
  agents: readonly Agent[];
  /** Every agent kept running here, whichever community is selected: the
   * viewer's agents in each joined community not disconnected, but none
   * whose Delete or Remove there is unfinished. */
  running: readonly Agent[];
  /** Running agents that were working when the app last closed or reloaded,
   * until the owner resumes or forgets those turns. */
  interrupted: readonly Agent[];
  /** The owner's teams on this device, which every community shares, and
   * each synced team with a confirmed copy. */
  teams: readonly Team[];
  /** Whether the selected community's config channels are up, so a new team
   * made there syncs. What `teamHere` says of a new team changes with it. */
  syncsTeams?: boolean;
  error?: string;
}>;
export type { Carry, Team };
export type TeamChange = Omit<Team, "id" | "revision"> &
  Readonly<{
    id?: string;
    /** The team as its editor opened it, the base a synced Save revises. */
    opened?: Team;
    /** A new team's id, made once by its editor so every retry is the same
     * team. */
    draft?: string;
  }>;
/** What `port` imports: an identity an earlier agent system saved on this
 * machine, or an agent a community member shared. */
export type PortInput = Readonly<
  | { source: PortSource; pubkey: string; type: string }
  | {
      source: "shared";
      type: string;
      name: string;
      /** An HTTPS image URL. */
      picture?: string;
      instructions?: string;
      config?: unknown;
    }
>;
/** Whether the binding's owner owns the agent, by the partition Yours uses. */
function ownedBy({ owner }: Pick<AgentIdentity, "owner">, binding: Binding) {
  return binding.scope === relayPartition(binding.origin, owner);
}
/** Whether the agent is in Yours under the binding: its owner's, there. */
function yours(identity: AgentIdentity, binding: Binding) {
  return (
    !identity.deleted &&
    originOf(identity.relay) === binding.origin &&
    ownedBy(identity, binding)
  );
}
/** What Import can bring over, and the agents already in Yours. */
export type FoundAgents = PortableAgents &
  Readonly<{ here: readonly string[] }>;
/** What importing an old Buzz team did. Members that came are kept even when
 * others, or the team itself, did not. */
export type TeamPort = Readonly<{
  /** The team that was saved, including an existing team cleaned to zero
   * members. Absent when no team was saved. */
  team?: Team;
  imported: readonly Agent[];
  failed: readonly Readonly<{ name: string; error: string }>[];
  /** Members already here in another community, left off the team. */
  elsewhere: readonly string[];
  /** Members another account on this device has, left off the team. */
  foreign: readonly string[];
  /** The team could not be saved, though its members were imported. */
  teamError?: Readonly<{ name: string }>;
  /** What did not come over with the members that were imported. */
  notes?: readonly string[];
}>;
/** An imported agent, and what did not come over with it. */
export type Ported = Readonly<{ agent: Agent; notes: readonly string[] }>;
export type NewAgent = Readonly<{
  type: string;
  name: string;
  /** An HTTPS image URL. */
  picture?: string;
  /** Its starting config, from the type's `Create`; else the type's defaults.
   * Hosted setup retains it until the provider has applied it. */
  config?: unknown;
}>;
export type Agents = {
  registerHook(hook: AgentHook): void;
  /** Dispatches hooks for this plugin's agent types in contribution order. */
  dispatchHook(
    harness: string,
    event: string,
    input: unknown,
    context: AgentHookContext,
    options: { accepts(output: unknown): boolean; milliseconds: number },
  ): Promise<unknown>;
  /** Registers a deterministic source owned by this plugin. Attention controls
   * its lifetime; output goes privately to the watch's saved conversation.
   * The provider key is pluginId/id. Local agents only. */
  addAttentionSource(
    source: import("./attention-sources").AttentionSource,
  ): void;
  /** Active providers, including those contributed by other plugins. */
  attentionProviders(): readonly Readonly<{
    provider: string;
    description?: string;
    configExample?: Readonly<Record<string, unknown>>;
    builtIn?: boolean;
  }>[];
  /** How the watch's provider shows it, when the provider presents its watches. */
  presentWatch(
    watch: import("./attention").SourceWatch,
    title: string,
  ): import("./attention-sources").SourcePresentation | undefined;
  register<Config>(type: AgentType<Config>): void;
  types(): readonly RegisteredAgentType[];
  /** Adds a tab to the settings of every agent running on this device,
   * whatever its type, or of those its `when` accepts, after Activity. It
   * shows while the plugin is on. */
  registerTab(tab: AgentAddedTab): void;
  /** The tabs active plugins add now. */
  addedTabs(): readonly RegisteredAgentAddedTab[];
  /** Says the calling plugin shows Attention and its device switch. Agents'
   * Attention runs on this device only while such a plugin is on; with none,
   * it is off for every agent and each keeps its saved switch. */
  controlAttention(): void;
  /** Adds a tool to every agent session in the app, beside the Buzz tools.
   * The tool acts as the agent, like the rest of a trusted plugin's code
   * acts as its owner. A session lists
   * the tools there are when it starts, and one that cannot take a changed
   * list is replaced when it is next used. */
  addTool(tool: AddedTool): void;
  /** The tools active plugins add now. A name is only ever one plugin's. */
  tools(): readonly AddedTool[];
  /** The Buzz side of a turn for an agent type a plugin brings: where a
   * delivery goes, the bundled harnesses' prompts, the agent's Buzz tools as
   * an MCP handler, and its replies. */
  readonly harness: HarnessKit;
  /** Wakes an agent this copy of the app runs in one of its conversations,
   * as a mention there would, but with no message: the agent is told `text`
   * comes from this plugin, not its owner, and is data. Throws when this copy does not run the agent or its queue is full;
   * like a mention, a queued wake is dropped if the agent stops running here. */
  wake(agent: AgentKey, wake: AgentWake): void;
  snapshot(): AgentsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Gives each `interrupted` agent again the turns it was working on, each
   * once its community connects. */
  resumeInterrupted(): void;
  /** Forgets the turns `interrupted` agents were working on. */
  dismissInterrupted(): void;
  /** The agent of this pubkey in the selected community, if it is an agent. */
  find(pubkey: string): Agent | undefined;
  /** The agent as `run` holds it, outside any run: for one of the calling
   * plugin's types while this copy of the app runs it, its type is not
   * changing and its community is live, else undefined. A type whose agents
   * act on something other than a message, such as a call, publishes with
   * it; like any type whose agents run here, it has `run`. A kept handle
   * throws once this no longer holds, so ask again when acting. */
  handle(agent: AgentKey): AgentHandle | undefined;
  canConnectExternal(agent: AgentKey): boolean;
  /** Creates a separate owner-approved external grant in the selected community. */
  connectExternal(
    agent: AgentKey,
    signal: AbortSignal,
    connected: () => void,
    scopes?: readonly ExternalScope[],
  ): Promise<HostMcpServer>;
  /** The owner's connection to a running agent's community, which need not be
   * the selected one: read the agent's conversations through this. */
  relay(agent: AgentKey): RelayData | undefined;
  /** The agent's `core` memory, as this device keeps it current: its text,
   * `null` when it has none, or undefined when it could not be read. A start
   * reads it here, which needs no relay request once this device has read it
   * once; the host refreshes it, so no agent type does. Rejects only when
   * `signal` aborts. */
  core(
    agent: AgentKey,
    signal?: AbortSignal,
  ): Promise<string | null | undefined>;
  /** Where agent types keep what they save for an agent, such as its
   * sessions. Every program that runs this machine's agents shares it, so
   * keep each agent's state under its own `key`, which is its membership's
   * in one community. A write is saved only once its promise settles. */
  readonly storage: AgentStore;
  /** Makes an agent of `type` in the selected community: here, or with a
   * hosted type at its provider. A hosted one whose setup then fails is kept
   * as `unfinished`. */
  create(input: NewAgent): Promise<Agent>;
  /** Local, unsaved requests; closing a review discards its request. */
  creationRequests(): readonly AgentCreationRequest[];
  dismissCreation(id: string): void;
  /** Creates only after the owner reviews the usual creation form. */
  approveCreation(id: string, input: NewAgent): Promise<Agent>;
  /** Local, unsaved change requests; closing a review discards its request. */
  updateRequests(): readonly AgentUpdateRequest[];
  dismissUpdate(id: string): void;
  /** Saves the owner-reviewed edit form, the agent's settings with the
   * request's changes, to the request's agent. */
  approveUpdate(id: string, input: NewAgent): Promise<void>;
  /** Continues an unfinished hosted agent's setup. */
  finish(pubkey: string): Promise<Agent>;
  /** Identities earlier agent systems saved on this machine that are not
   * Agents yet, old Buzz's teams with all their members, and which of those
   * members are already in Yours. */
  portable(): Promise<FoundAgents>;
  /** Imports one as an agent of `type` in the selected community: an identity
   * from `portable` keeps its key, name and picture, and a shared agent gets a
   * new key with its name and picture. Either keeps whatever of its
   * instructions and workspace the type adopts; its other settings stay behind. */
  port(input: PortInput): Promise<Ported>;
  /** Imports an old Buzz team from `portable`, as read now, into the selected
   * community: each member not here yet as an agent of `type`, then the team's
   * copy there with every member here. A team imported before keeps its name,
   * instructions and members here. */
  portTeam(input: Readonly<{ id: string; type: string }>): Promise<TeamPort>;
  /** Saves the owner's change. Its name and config change in every
   * community the agent is in; its picture and attention only in this one. */
  save(agent: AgentKey, change: AgentChange): Promise<void>;
  /** The History of each of the agent's synced config sides; undefined while
   * none syncs here. */
  configHistory(agent: AgentKey): ConfigHistory | undefined;
  /** Previews the destination config and transferable settings the same
   * migration used by `retype` will produce, without changing the agent. */
  previewRetype(agent: AgentKey, type: string): RetypePreview;
  /** Makes it an agent of `type` in every community it is in, keeping its
   * identity and attention. Its new config is the type's defaults with
   * whatever the old type carries and the new one adopts, or the reviewed
   * destination draft; returns what of the old config stayed behind.
   * Refused mid-turn. */
  retype(
    agent: AgentKey,
    type: string,
    change?: Readonly<{ config: unknown }>,
  ): Promise<readonly (keyof Carry)[]>;
  /** Stops it for good, leaves its channels and archives it in its
   * community, and only then deletes its record, key and settings. When that
   * cannot finish, as offline, nothing is deleted and nothing retries it: it
   * stays listed and stopped, and this rejects saying so; Delete again runs it
   * all again. Called while one runs, it joins it. A hosted agent is archived,
   * leaves its channels and is removed from its provider before this resolves.
   * One on another device is deleted there. An agent here leaves every
   * community it is in this way, one at a time; one whose community cannot
   * be reached stays, and the rejection names it. */
  remove(agent: AgentKey): Promise<void>;
  /** The communities the owner's agent `pubkey` is in on this device, as
   * Delete leaves them: each one's origin, whether it is connected, and
   * whether a Delete or Remove there started and hasn't finished. */
  memberships(pubkey: string): readonly Readonly<{
    key: AgentKey;
    origin: string;
    connected: boolean;
    deleting?: true;
  }>[];
  /** Deletes the agent from a community Delete cannot reach without leaving
   * it there: it may stay in that community's channels. */
  forget(agent: AgentKey): Promise<void>;
  /** The owner's agents on this device that the selected community can add:
   * each in one of its other communities, by its home there. */
  joinable(): readonly Agent[];
  /** Adds one of the owner's agents from another community to the selected
   * one, with the same key, name, type and settings; its attention and
   * conversations here are its own. */
  join(agent: AgentKey): Promise<Ported>;
  /** Takes the agent out of its community, as Delete does, and keeps it in
   * its others. Refused for its last one, which only Delete leaves. */
  leave(agent: AgentKey): Promise<void>;
  /** Whether the owner can stop a hosted agent's turns through its provider. */
  interruptible(agent: AgentKey): boolean;
  /** Session controls are available only in the copy holding this agent. */
  sessionState(agent: AgentKey, place: SessionPlace): SessionState;
  session(
    agent: AgentKey,
    place: SessionPlace,
    action: SessionControlAction,
  ): Promise<void>;
  /** Has a hosted agent's provider stop its turn in one conversation. False
   * when nothing there was running. */
  interrupt(
    agent: AgentKey,
    place: Readonly<{ channelId: string; threadRootId: string }>,
  ): Promise<boolean>;
  /** Leaves private context for the agent's next turn in a conversation: text at
   * the end of that turn's prompt that nobody else sees, such as what the
   * owner did since its last turn. False unless this copy runs the agent,
   * so the plugin can say it another way. Notes are not saved: one left
   * when the app quits is gone. Pass a thread root for a thread conversation;
   * omit it for a channel conversation, including Solo chats. Thread sessions
   * never take notes addressed only to their channel. */
  note(
    agent: AgentKey,
    channelId: string,
    text: string,
    root?: string,
  ): boolean;
  /** Unarchives an imported agent whose archive state was not checked, as
   * import does, keeping its key and settings. Resolves with what is left. */
  unarchive(agent: AgentKey): Promise<string | undefined>;
  /** Whether a watch's classifier can run on this device now. */
  classifier(): ClassifierAvailability;
  /** Creates a team, or replaces the one with `id`. Members, by pubkey, must
   * be agents on this device or, for a synced team, its home community's
   * hosted agents whose setup finished. Each community has the members that
   * are in it. */
  saveTeam(team: TeamChange): Promise<Team>;
  /** Whether Save puts the team with `id`, or the new team `draft`, in
   * `community`, by default the selected one: a synced team homed there, or a
   * new team where it syncs. Only such a team can have that community's
   * hosted agents. */
  teamHere(team: Pick<TeamChange, "id" | "draft">, community?: string): boolean;
  /** Deletes the team; its agents are untouched. */
  removeTeam(id: string): Promise<void>;
};
export type ConfigHistory = Readonly<{
  read: SnapshotRead;
  sides: readonly Readonly<{
    side: Side;
    expected: Expected;
    head: RelayEvent | undefined;
    version: number;
  }>[];
  /** What a settings revision must fit to be reverted to. */
  settings?: SettingsCheck;
  /** Saves a revert or restore of `side`, as History builds it. */
  revise(
    side: Side,
    template: ReturnType<typeof revertTemplate>,
  ): Promise<RevertOutcome>;
}>;
declare module "@deepseek-ai/cordis" {
  interface Context {
    agents: Agents;
  }
}

/** Whether `value` can be sent as JSON, as every session's tool list is. */
const serializable = (value: unknown) => {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
};
/** Bounds one cleanup attempt, whose relay steps otherwise wait on the outbox. */
const CLEANUP_TIMEOUT_MS = 60_000;
const TIMER_TICK_MS = 5_000;
/** How often a failed connection to an unselected community is tried again. */
const RETRY_MS = 30_000;
/** How often agents are said to be online; the relay keeps it 180 seconds. */
const PRESENCE_MS = 60_000;
/** The most agents one presence event names. */
const PRESENCE_BATCH = 256;
const EMPTY = Object.freeze({});
const blank = (key: AgentKey): AgentRecord => ({
  pubkey: key,
  attention: EMPTY,
  config: undefined,
});
/** What a membership other than the agent's home keeps of `record`: its
 * attention and timers. */
const ownRecord = (
  key: AgentKey,
  { config: _, ...record }: AgentRecord,
): AgentRecord => ({ ...record, pubkey: key, config: undefined });
/** `record` with the owner's `change` to its settings; throws when the
 * change is not valid for it. */
function changed(record: AgentRecord, change: AgentChange): AgentRecord {
  let next = record;
  if (change.config !== undefined) next = { ...next, config: change.config };
  if (change.attentionEnabled !== undefined) {
    const { attentionEnabled: _, ...rest } = next;
    next = change.attentionEnabled ? { ...rest, attentionEnabled: true } : rest;
  }
  for (const [slug, value] of Object.entries(change.attention ?? {}))
    next = setAttention(
      next,
      slug,
      value,
      undefined,
      change.restart?.includes(slug) ? "restart" : undefined,
    );
  for (const [slug, { enabled, expected }] of Object.entries(
    change.watchEnabled ?? {},
  )) {
    const current = next.attention[slug];
    if (!current || JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error(
        "This watch changed. Review its current settings and try again.",
      );
    if (current.value.type === "interest") throw new Error("Choose a watch");
    if (enabled && current.value.type === "timer" && !current.value.enabled)
      throw new Error("Ask the agent to rearm this timer.");
    if (current.value.enabled !== enabled) {
      const history = next.attentionHistory;
      const completed = sourceCompleted(next.sourceRuns, current);
      next = setAttention(next, slug, { ...current.value, enabled });
      if (history) next = { ...next, attentionHistory: history };
      const updated = next.attention[slug];
      if (completed && updated)
        next = {
          ...next,
          sourceRuns: { ...next.sourceRuns, [slug]: sourceSignature(updated) },
        };
    }
  }
  // As the spec's writer: an Interest stays while anything still uses it.
  for (const [slug, value] of Object.entries(change.attention ?? {})) {
    const id = parseSlug(slug)?.id;
    if (value !== null || !slug.startsWith("interest/") || !id) continue;
    if (
      Object.values(next.attention).some(
        (object) =>
          object.value.type !== "interest" && object.value.interest_id === id,
      )
    )
      throw new Error(
        "Remove or move the watches and timers that use this Interest first",
      );
  }
  return next;
}
/** A new agent's settings: its type's defaults. */
function defaults(pubkey: string, type: RegisteredAgentType) {
  const { config, attention = {} } = type.defaults();
  let record: AgentRecord = { pubkey, attention: {}, config };
  for (const [slug, value] of Object.entries(attention))
    record = setAttention(record, slug, value);
  return record;
}
/** How long the classifier waits for a reply's parent before it goes on. */
const PARENT_LOOKUP_MS = 5_000;
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);
/** The team sections for agent `self`: each team it is on, its members that
 * still exist by name and npub (by npub alone where `agents` has no name),
 * and the team's instructions. */
export function teamPrompt(
  teams: readonly Team[],
  agents: readonly Readonly<{ pubkey: string; name?: string }>[],
  self: string,
) {
  const names = new Map(agents.map((agent) => [agent.pubkey, agent.name]));
  return teams
    .filter((team) => team.members.includes(self))
    .map((team) => {
      const roster = team.members.flatMap((pubkey) => {
        if (!names.has(pubkey)) return [];
        const name = names.get(pubkey);
        const npub = npubEncode(pubkey);
        return [
          `- ${name === undefined ? npub : `${name} (${npub})`}${pubkey === self ? ", you" : ""}`,
        ];
      });
      return [
        "<team>",
        `You are on the team ${JSON.stringify(team.name)}. Its members, you included:`,
        ...roster,
        "Mention a teammate by name, with their npub, to reach them.",
        ...(team.instructions.trim()
          ? [
              "<team-instructions>",
              team.instructions.trim(),
              "</team-instructions>",
            ]
          : []),
        "</team>",
      ].join("\n");
    })
    .join("\n\n");
}
export { fromOwner } from "./owner-attestation";

/** What Agents needs of the communities: the viewer, the selected one, and
 * a connection to any joined one without selecting it. */
export type AgentCommunities = Pick<
  Communities,
  "snapshot" | "subscribe" | "open"
>;
type Binding = {
  scope: string;
  origin: string;
  viewer: string;
  session: RelaySession;
  /** Aborts when this binding is replaced, so no work outlives its session. */
  controller: AbortController;
  stopLive: () => void;
  connection: Connection;
  /** The channels its agents' watches name that it keeps live, and its stop. */
  attending?: Readonly<{ key: string; stop: () => void }>;
  /** Its config support while no config channels are up: being checked, the
   * check failed (and when), or the relay has none. */
  support?: "checking" | "unsupported" | Readonly<{ failed: number }>;
};
/** A community the viewer has an agent in, and its session while live. */
type Bound = {
  relay: RelayData;
  stop: () => void;
  binding?: Binding | undefined;
  /** When its failed connection was last tried again. */
  retried?: number;
};
/** A saved identity, which is the agent's membership in one community, with
 * that membership's key. */
type Member = AgentIdentity & Readonly<{ key: AgentKey }>;
/** The origin a relay URL or community ID names, if it is a valid one. */
const originOf = (value: string) => {
  try {
    return communityDestination(value).url;
  } catch {
    return undefined;
  }
};
/** One of the viewer's kind 30177 agent records. Ones without a `runtime`
 * are earlier agent systems', not shown; replacing one keeps its settings. */
type Listing = Readonly<{
  pubkey: string;
  name: string;
  picture?: string;
  runtime?: string;
  /** The record as read or written, kept by the next one written. */
  prior?: AgentRecordBody | undefined;
}>;
const RUNTIME = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
/** The newest record of each agent, read as listings. */
function listingsOf(events: readonly EventData[], viewer: string) {
  const heads = new Map<string, EventData>();
  for (const event of events) {
    const d = event.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
    if (event.kind === 30177 && event.pubkey === viewer)
      heads.set(d, newer(heads.get(d), event));
  }
  const listings: Listing[] = [];
  for (const [pubkey, event] of heads) {
    if (!/^[0-9a-f]{64}$/.test(pubkey)) continue;
    const runtime = event.tags.find((tag) => tag[0] === "runtime")?.[1] ?? "";
    let body: unknown = null;
    try {
      body = JSON.parse(event.content);
    } catch {}
    const content =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const name = typeof content.name === "string" ? content.name.trim() : "";
    const picture = recordPicture(content.picture);
    listings.push(
      Object.freeze({
        pubkey,
        name,
        ...(picture ? { picture } : {}),
        ...(RUNTIME.test(runtime) ? { runtime } : {}),
        prior: { content, tags: event.tags },
      }),
    );
  }
  return Object.freeze(listings);
}
/** A picture as a record carries it: an HTTPS image URL, never inline data. */
const recordPicture = (value: unknown) => {
  const source = avatarSource(value);
  return source?.startsWith("https:") ? source : undefined;
};
/** A proposed picture as a record carries it; refuses any other. */
const proposedPicture = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const picture = recordPicture(value);
  if (!picture) throw new Error("Propose an HTTPS image URL as the picture");
  return picture;
};
/** The `wss://` URL of a community, as agents and their providers know it. */
const wssOf = (origin: string) =>
  relayOrigin(origin).replace(/^https:/, "wss:");

export class AgentsService extends Service implements Agents {
  private readonly hookContributions;
  registerHook(hook: AgentHook) {
    const adapter = this.contributions
      .snapshot()
      .find((type) => type.key === hook.harness);
    if (adapter && !adapter.hooks?.events.includes(hook.event))
      throw new Error(
        `Hook event ${hook.event} is not supported by ${hook.harness}`,
      );
    this.hookContributions.register(this.ctx, hook);
  }
  dispatchHook(
    harness: string,
    event: string,
    input: unknown,
    context: AgentHookContext,
    options: { accepts(output: unknown): boolean; milliseconds: number },
  ) {
    const owner = this.ctx.pluginOwner;
    if (!owner || !harness.startsWith(`${owner.id}/`))
      throw new Error(
        "Plugins can dispatch hooks only for their own agent types",
      );
    return dispatchAgentHooks(
      this.hookContributions.handlers(harness, event),
      input,
      context,
      options.accepts,
      options.milliseconds,
    );
  }
  private readonly contributions;
  private readonly tabContributions;
  private readonly attentionControls;
  private readonly addedTools;
  /** Every added tool's name, its plugin active or still starting. */
  private readonly toolNames = new Set<string>();
  private readonly attentionSources;
  private readonly sourceTails = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private requests: readonly AgentCreationRequest[] = [];
  private updates: readonly AgentUpdateRequest[] = [];
  private readonly approving = new Set<string>();
  /** Every saved membership, deleted ones included: native's list is the
   * agent list, and `records` only adds settings to it. */
  private identities: readonly Member[] = [];
  /** Each membership's settings as saved, by key, and as the owner and the
   * agent see them. Its home record also keeps the agent's config. */
  private records: Record<AgentKey, AgentRecord>;
  /** Each membership's last change in its queue, until it settles. */
  private readonly changes = new Map<AgentKey, Promise<void>>();
  /** How many changes other than timer progress each membership has queued. */
  private readonly changing = new Map<AgentKey, number>();
  /** Each membership's timer progress that is not saved yet. */
  private readonly progressing = new Map<AgentKey, readonly TimerProgress[]>();
  private teamList: readonly Team[];
  /** Synced teams as discovery last found them, by home community. */
  private readonly syncedTeams: SyncedTeams;
  /** The account whose synced teams `state.teams` shows. */
  private teamsFor: string | undefined;
  /** Each new synced team's home, fixed at its first Save, by draft id. */
  private readonly teamDrafts = new Map<string, string>();
  private state: AgentsSnapshot;
  /** By origin, so each agent listens in its own community, selected or not. */
  private bound = new Map<string, Bound>();
  private readonly runners: AgentRunners;
  private readonly coreMemory: CoreMemoryCache;
  /** Counts list requests, so only the latest one is applied. */
  private listed = 0;
  /** Each running cleanup of a deleted membership, by key, how to stop it,
   * and whether it finished. */
  private cleaning = new Map<
    AgentKey,
    { stop: AbortController; done: Promise<void> }
  >();
  /** Memberships a re-import or add is taking back; no cleanup starts for
   * them. */
  private reclaiming = new Set<AgentKey>();
  /** Memberships, imported or added, whose archive state could not be
   * checked yet, saved so Retry survives a restart until a check confirms
   * the state. */
  private unarchiving: Set<AgentKey>;
  /** Each Delete running, by pubkey, so pressing it again joins it. */
  private deleting = new Map<string, Promise<void>>();
  /** The synced settings head each agent last tried to take its type from. */
  private followedType = new Map<string, string>();
  /** Agents whose type is changing here. No community attaches them
   * meanwhile, even one whose config comes up mid-change, so none moves
   * their settings in under the old type. */
  private retyping = new Set<string>();
  /** Each Remove from a community running, by key, as `deleting`. */
  private leaving = new Map<AgentKey, Promise<void>>();
  private unfinished: readonly Unfinished[];
  /** The viewer's agent records in each community, by origin, as last read
   * from its live session and written since. */
  private listings = new Map<string, readonly Listing[]>();
  /** Memberships whose record is being written, so a sync writes each once. */
  private listing = new Set<AgentKey>();
  /** By origin until its records are first read: the listings written or
   * removed meanwhile, which the read must not undo. */
  private edits = new Map<string, Map<string, Listing | null>>();
  /** By origin, the binding whose read of its records is under way. */
  private reading = new Map<string, Binding>();
  /** Hosted agents whose setup, save or delete is running, so one waits for
   * the others. */
  private busy = new Set<string>();
  /** Hosted and elsewhere agents as last shown, kept while unchanged. */
  private shown = new Map<string, Agent>();
  /** By origin: the agents last said to be online there, and when. */
  private presence = new Map<
    string,
    {
      session: RelaySession;
      online: ReadonlySet<string>;
      at: number;
      /** The session cannot send presence, so it is not tried again. */
      unable?: boolean;
    }
  >();
  /** Confirmed synced config copies, the only synced launch source. */
  private readonly configStore: AgentConfigStore;
  /** Each bound community's config channels, while config sync is on. */
  private readonly communityConfigs = new Map<string, CommunityConfig>();
  /** Origins whose presence is being sent. */
  private announcing = new Set<string>();

  private readonly protection: AgentProtectionService;
  constructor(
    ctx: Context,
    private readonly communities: AgentCommunities,
    private readonly native: AgentsNative | undefined = nativeAgents(),
    readonly storage: AgentStore = agentStorage(),
    private readonly authorize: (
      pubkey: string,
      signal: AbortSignal,
    ) => Promise<NipOaAuthorization> = prepareRemoteAgentAuthorization,
    localActivity = createLocalAgentActivity(),
    /** Runs watch classifiers on this device's decision backend. */
    private readonly decisions: Decisions | undefined = undefined,
    /** Which artifact types an agent has synced, from its config channel
     * binding. Unset, every agent starts `local`. */
    private readonly bindingFor?: (agent: Agent) => ConfigBinding,
  ) {
    super(ctx, "agents");
    this.contributions = createContributions<AgentType>(ctx);
    this.hookContributions = createAgentHooks(ctx);
    this.tabContributions = createContributions<AgentAddedTab>(ctx);
    this.attentionControls = createContributions<{ id: string }>(ctx);
    this.addedTools = createContributions<AddedTool & { id: string }>(ctx);
    this.attentionSources = createContributions<AttentionProducer>(ctx);
    // Each changes the copy at once and logs a failed save itself.
    void migrateAgentStorage(storage);
    void migrateWatchFilters(storage);
    void migrateWatchKeywords(storage);
    this.records = readRecords(storage);
    void splitLegacyRecords(storage, this.records);
    void splitLegacyCheckpoints(storage);
    this.unfinished = Object.freeze(readUnfinished(storage));
    this.unarchiving = readArchiveUnchecked(storage);
    this.teamList = Object.freeze(readTeams(storage));
    this.syncedTeams = new SyncedTeams(storage);
    this.state = Object.freeze({
      status: native ? "loading" : "unavailable",
      classifier: this.availability(),
      agents: [],
      running: [],
      interrupted: [],
      teams: this.teamList,
    });
    this.protection = new AgentProtectionService(
      ctx,
      () => ({
        owner: this.communities.snapshot().viewer,
        agents: this.state.running,
        types: this.types(),
      }),
      {
        read: async (owner) => {
          if (!this.native?.protectionDefaults)
            throw new Error("Native agent protection is unavailable");
          return this.native.protectionDefaults(owner);
        },
        save: async (owner, revision, provider, policy) => {
          if (!this.native?.setProtectionDefaults)
            throw new Error("Native agent protection is unavailable");
          await this.native.setProtectionDefaults(
            owner,
            revision,
            provider,
            policy,
          );
        },
        update: async (pubkey, revision, provider, policy) => {
          const setProtection = this.native?.setProtection?.bind(this.native);
          if (!setProtection)
            throw new Error("Native agent protection is unavailable");
          const members = this.identities.filter(
            (agent) => agent.pubkey === pubkey && !agent.deleted,
          );
          const agent = members[0];
          if (!agent) throw new Error("No such agent on this device");
          const type = this.types().find((type) => type.key === agent.type);
          if (!type?.retire)
            throw new Error(
              "This runtime cannot safely change protection while Buzz is open",
            );
          await this.runners.retype(agent.key, agent.name, async () => {
            for (const member of members) await type.retire?.(member.key);
            await setProtection(pubkey, revision, provider, policy);
            await this.refresh();
          });
        },
      },
    );
    this.configStore = new AgentConfigStore(storage);
    this.teamsChanged();
    // A synced copy that changes reaches running agents as a local save does.
    this.configStore.subscribe(() => {
      this.teamsChanged();
      this.update();
    });
    this.coreMemory = new CoreMemoryCache((key) =>
      ownerReads(this.relay(key), pubkeyOf(key)),
    );
    /** The catch-up progress this program last read or saved. */
    let savedProgress: Checkpoints = {};
    this.runners = new AgentRunners({
      // Only the copy that runs an agent keeps its watched channels live.
      ownershipChanged: () => {
        this.attend(this.state.running);
        this.notify();
      },
      ready: (key) => this.ready(key),
      agent: (key) => this.agent(key),
      member: (agent, event) => this.member(agent, event),
      reads: (agent, event) => this.reads(agent, event),
      dm: (agent, event) => this.dm(agent, event),
      unattended: (agent, event, live) => {
        const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
        const session = this.bindingOf(agent)?.session;
        return !channel || !session || session.unattended(channel, live);
      },
      starting: (agent, channelId) =>
        this.bindingOf(agent)?.session.channelWrites.starting(channelId),
      community: (agent) => this.bindingOf(agent),
      resumeFollowUps: (agent, turns) => {
        const session = this.bindingOf(agent)?.session;
        if (session)
          followUpQueue(session).resumeAfter(agent.pubkey, turns, (entry) => {
            if (
              this.state.running.some(
                (recipient) =>
                  entry.recipients.includes(recipient.pubkey) &&
                  this.bindingOf(recipient)?.session === session &&
                  this.sessionState(recipient.key, {
                    channelId: entry.channelId,
                  }) === "compacting",
              )
            )
              throw new Error(
                "Wait for compaction to finish, or interrupt it.",
              );
          });
      },
      abandonFollowUps: (agent, turns) => {
        const session = this.bindingOf(agent)?.session;
        if (session) followUpQueue(session).pauseAfter(agent.pubkey, turns);
      },
      records: () => Object.values(this.records),
      checkpoints: {
        read: () => (savedProgress = readCheckpoints(this.storage)),
        write: (checkpoints) => {
          void writeCheckpoints(this.storage, checkpoints, savedProgress).catch(
            (error) => {
              console.warn("Agent catch-up progress was not saved", error);
              // The copy went back to what is saved: the next save compares
              // with that.
              savedProgress = readCheckpoints(this.storage);
            },
          );
          savedProgress = checkpoints;
        },
      },
      interrupted: {
        read: () => readInterrupted(this.storage),
        write: (key, turns) => {
          void writeInterrupted(this.storage, key, turns).catch((error) =>
            console.warn("Agent turns in progress were not saved", error),
          );
        },
        changed: () => this.update(),
      },
      scope: (agent) => this.bindingOf(agent)?.scope,
      saved: (key) => this.records[key],
      attentionShown: () => this.attentionShown(),
      pluginsSettled: () => this.ctx.pluginStatus.settled?.() ?? true,
      record: (key) => {
        const member = this.liveMember(key);
        if (!member) throw new Error("No such agent on this device");
        return this.recordOf(member);
      },
      change: async (key, apply) => {
        const record = await this.change(key, () => {
          const member = this.liveMember(key);
          if (!member) throw new Error("No such agent on this device");
          // In turn, so this is the newest saved record.
          return apply(this.recordOf(member));
        });
        if (!record) throw new Error("No such agent on this device");
        return record;
      },
      changing: (key) => this.changing.has(key),
      timers: (key) => this.timersOf(key),
      progress: (key, ran) => this.progress(key, ran),
      start: (agent) =>
        this.resolve(agent, (this.records[agent.pubkey] ?? agent).config),
      team: (key) => {
        const member = this.liveMember(key);
        const origin = member && originOf(member.relay);
        // Only teammates in the same community, where it can reach them.
        return member && origin
          ? teamPrompt(this.allTeams(), this.teammates(origin), member.pubkey)
          : "";
      },
      protection: (agent) => this.protection.bind(agent),
      agentTypes: () =>
        this.types()
          .filter((type) => !type.remote)
          .map(({ key, title }) => ({ key, title })),
      createAgent: async (agent, { picture: upload, ...input }) => {
        const request = (picture?: string): AgentCreationRequest => {
          const binding = this.bindingOf(agent);
          if (!binding || !this.liveMember(agent.key))
            throw new Error("The requesting agent is no longer available");
          if (!input.name.trim()) throw new Error("Name the agent");
          const kind = this.types().find((entry) => entry.key === input.type);
          if (!kind) throw new Error("That agent type is not available");
          if (kind.remote)
            throw new Error("A hosted agent's key stays with its provider");
          if (this.requests.length + this.updates.length >= 16)
            throw new Error("Review the pending agent requests first");
          return {
            id: crypto.randomUUID(),
            requester: agent.pubkey,
            requesterName: agent.name,
            owner: agent.owner,
            community: binding.origin,
            type: input.type,
            name: input.name.trim(),
            ...(picture && { picture }),
          };
        };
        // Its picture uploads only for a valid request, which is then
        // checked again.
        request();
        const next = request(proposedPicture(await upload?.()));
        this.requests = [...this.requests, next];
        this.notify();
        return { requestId: next.id, saved: false };
      },
      updateAgent: async (
        agent,
        { agent: target, picture: upload, ...proposed },
      ) => {
        /** `wanted`: the target; `pending`: a picture still to upload, a
         * change until its URL is known. */
        const request = (
          wanted: (identity: AgentIdentity) => boolean,
          picture?: string,
          pending = false,
        ): AgentUpdateRequest => {
          const binding = this.bindingOf(agent);
          if (!binding || !this.liveMember(agent.key))
            throw new Error("The requesting agent is no longer available");
          const matches = this.identities.filter(
            (identity) =>
              !identity.deleted &&
              !identity.deleting &&
              identity.owner === agent.owner &&
              originOf(identity.relay) === binding.origin &&
              wanted(identity),
          );
          const [identity] = matches;
          if (!identity)
            throw new Error("Your owner has no agent here by that name or key");
          if (matches.length > 1)
            throw new Error("Several agents have that name; use its pubkey");
          const name = proposed.name?.trim();
          const change: AgentUpdate = {
            ...(name !== undefined && name !== identity.name && { name }),
            ...(proposed.type !== undefined &&
              proposed.type !== identity.type && { type: proposed.type }),
            ...(proposed.instructions !== undefined && {
              instructions: proposed.instructions,
            }),
            ...(picture !== undefined &&
              picture !== identity.picture && { picture }),
          };
          if (Object.keys(change).length === 0 && !pending)
            throw new Error("Propose at least one change");
          this.updateKind(identity, change);
          if (this.requests.length + this.updates.length >= 16)
            throw new Error("Review the pending agent requests first");
          return {
            id: crypto.randomUUID(),
            requester: agent.pubkey,
            requesterName: agent.name,
            owner: agent.owner,
            community: binding.origin,
            agent: identity.pubkey,
            agentName: identity.name,
            agentType: identity.type,
            ...change,
          };
        };
        // Its picture uploads only for a valid request, which is then
        // checked again for the same agent, even if renamed meanwhile.
        const { agent: key } = request(
          (identity) => identity.pubkey === target || identity.name === target,
          undefined,
          upload !== undefined,
        );
        const next = request(
          (identity) => identity.pubkey === key,
          proposedPicture(await upload?.()),
        );
        this.updates = [...this.updates, next];
        this.notify();
        return { requestId: next.id, saved: false };
      },
      handoff: (agent, { from, ...wake }) =>
        this.wakeIn(agent.key, wake, { from }),
      templates: (agent) => {
        // The agents Agents shows for this community, as the create dialog
        // offers a template's.
        const origin = originOf(agent.relay);
        const here = new Set(
          [
            ...this.state.running.filter(
              (a) => originOf(a.relay) === origin && this.bindingOf(a),
            ),
            ...this.listedAgents(origin),
          ].map((a) => a.pubkey),
        );
        return channelTemplates.snapshot().map((template) => ({
          name: template.name,
          canvas: template.canvas,
          agents: templateAgents(template, this.allTeams(), here),
        }));
      },
      tabs: (agent) => {
        const session = this.bindingOf(agent)?.session;
        return session && channelTabs(session, ctx.navigation);
      },
      classifier: () => this.classifier(),
      decisions: () => this.decisions,
      context: (agent, event) => this.context(agent, event),
      displayName: (agent, pubkey) => this.displayName(agent, pubkey),
      custody: native && {
        ...native,
        claim: async (pubkey) => {
          try {
            return await native.claim(
              pubkey,
              this.identities.find(
                (agent) => agent.pubkey === pubkey && !agent.deleted,
              )?.protectionRevision ?? 0,
            );
          } catch (error) {
            void this.refresh().catch(() => undefined);
            throw error;
          }
        },
      },
      activity: localActivity,
      channel: (agent, event) => this.channelOf(agent, event),
      soloChat: (agent, channel, signal) =>
        soloChat(() => this.relay(agent.key), agent.owner, channel, signal),
      remembered: (key, slug, body) => this.coreMemory.wrote(key, slug, body),
      woke: (key, object, events) =>
        this.history(
          key,
          object,
          events?.map((event) => ({
            id: event.id,
            at: event.created_at,
            author: event.pubkey,
            channel: event.tags.find(([name]) => name === "h")?.[1],
            text: event.content,
            mentions: event.tags.flatMap(([name, value]) =>
              name === "p" && value ? [value] : [],
            ),
            mentionReferences: event.tags.flatMap((tag) =>
              tag.length === 2 && tag[0] === "mention" && tag[1]
                ? [tag[1]]
                : [],
            ),
          })),
          Math.floor(Date.now() / 1000),
        ),
      finished: (key) => {
        void this.coreMemory.refresh(key);
        this.retakeType(key);
      },
      named: (agent, event, title) =>
        void nameSoloChat(
          this.relay(agent.key),
          agent.owner,
          agent.pubkey,
          event,
          title,
        ).catch((error) => console.warn("Couldn't name the Solo chat", error)),
    });
    if (native)
      ctx.effect(() =>
        bindKeepAwake(this.runners, (hold) => native.keepAwake(hold)),
      );
    ctx.effect(() => {
      const running = new Map<Contribution<AttentionProducer>, () => void>();
      const reconcile = () => {
        const active = this.attentionSources.snapshot();
        for (const [source, stop] of running) {
          if (active.includes(source)) continue;
          stop();
          running.delete(source);
        }
        for (const source of active) {
          if (!running.has(source))
            running.set(source, this.startAttentionSource(source));
        }
      };
      const unsubscribe = this.attentionSources.subscribe(reconcile);
      reconcile();
      return () => {
        unsubscribe();
        for (const stop of running.values()) stop();
      };
    });
    ctx.effect(() => {
      const stops = [
        this.contributions.subscribe(() => {
          this.hookContributions.validate(this.contributions.snapshot());
          this.update();
          this.notify();
        }),
        // Every agent's Attention turns on or off with its controls.
        this.attentionControls.subscribe(() => {
          this.update();
          this.notify();
        }),
        // A new state object, so views reading `addedTabs()` render again.
        this.tabContributions.subscribe(() => {
          this.state = Object.freeze({ ...this.state });
          this.notify();
        }),
        communities.subscribe(() => {
          const { viewer } = communities.snapshot();
          const kept = this.requests.filter(
            (request) => request.owner === viewer,
          );
          const updates = this.updates.filter(
            (request) => request.owner === viewer,
          );
          if (
            kept.length !== this.requests.length ||
            updates.length !== this.updates.length
          ) {
            this.requests = kept;
            this.updates = updates;
            this.notify();
          }
          this.watch();
          // Synced teams are the signed-in account's.
          if (viewer !== this.teamsFor) this.teamsChanged();
          this.update();
        }),
        // Another provider, or its setup, can make classifiers available.
        this.decisions?.subscribe(() => this.updateClassifier()) ?? (() => {}),
      ];
      this.watch();
      void this.refresh();
      this.updateClassifier();
      // Wakes each runner, which starts any timer that is due.
      const tick = setInterval(() => {
        this.runners.tick();
        this.reconnect();
        this.announce();
        this.runners.catchUp(true);
      }, TIMER_TICK_MS);
      return () => {
        clearInterval(tick);
        // A list still being read is stale: it must not reopen communities.
        this.listed++;
        for (const stop of stops) stop();
        for (const origin of [...this.bound.keys()]) this.unbind(origin);
        this.runners.clear();
        this.presence.clear();
        // Clear what is shown without reconciling, which would make new runners.
        this.state = Object.freeze({
          ...this.state,
          agents: Object.freeze([]),
          running: Object.freeze([]),
          interrupted: Object.freeze([]),
          syncsTeams: false,
        });
        this.notify();
      };
    });
  }

  register<Config>(type: AgentType<Config>) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(type.id ?? "") ||
      !type.title ||
      typeof type.defaults !== "function"
    )
      throw new Error("Agent types need an id, a title and defaults");
    if (
      type.timeoutMs !== undefined &&
      !(
        Number.isInteger(type.timeoutMs) &&
        type.timeoutMs >= 1 &&
        type.timeoutMs <= TIMEOUT_LIMIT_MS
      )
    )
      throw new Error(
        `Agent type timeoutMs must be a whole number from 1 to ${TIMEOUT_LIMIT_MS}`,
      );
    const { remote } = type;
    if (
      remote &&
      (type.run ||
        type.models ||
        type.timeoutMs !== undefined ||
        (["provision", "activate", "profile", "remove"] as const).some(
          (step) => typeof remote[step] !== "function",
        ))
    )
      throw new Error(
        "A hosted agent type has provision, activate, profile and remove, and no run, models or timeoutMs",
      );
    this.contributions.register(this.ctx, type as unknown as AgentType);
  }
  types = () => this.contributions.snapshot();
  registerTab(tab: AgentAddedTab) {
    if (
      !/^[a-z0-9][a-z0-9._-]*$/.test(tab.id ?? "") ||
      !tab.title ||
      typeof tab.component !== "function" ||
      (tab.when !== undefined && typeof tab.when !== "function") ||
      (tab.subscribe !== undefined && typeof tab.subscribe !== "function")
    )
      throw new Error("Agent tabs need an id, a title and a component");
    this.tabContributions.register(this.ctx, tab);
    // A new state object, so views asking `when` render again.
    const { subscribe } = tab;
    if (subscribe)
      this.ctx.effect(() =>
        subscribe(() => {
          this.state = Object.freeze({ ...this.state });
          this.notify();
        }),
      );
  }
  addedTabs = () => this.tabContributions.snapshot();
  controlAttention() {
    this.attentionControls.register(this.ctx, { id: "attention" });
  }
  /** Whether a plugin that shows Attention is on, so Attention may run. */
  private attentionShown = () => this.attentionControls.snapshot().length > 0;
  addTool(tool: AddedTool) {
    if (
      !/^[a-z][a-z0-9_]{0,63}$/.test(tool.name ?? "") ||
      BUZZ_SESSION.tools.some((core) => core.name === tool.name) ||
      !tool.description ||
      tool.inputSchema?.type !== "object" ||
      !serializable(tool.inputSchema) ||
      typeof tool.call !== "function"
    )
      throw new Error(
        "Agent tools need a lowercase name no Buzz tool has, a description, a JSON object inputSchema and call",
      );
    // Reserved from registration, not activation: plugins starting together
    // are not active yet, and the second to take a name must fail.
    if (this.toolNames.has(tool.name))
      throw new Error(`Another plugin adds agent tool ${tool.name}`);
    this.addedTools.register(this.ctx, { ...tool, id: tool.name });
    this.ctx.effect(() => {
      this.toolNames.add(tool.name);
      return () => this.toolNames.delete(tool.name);
    });
  }
  addAttentionSource(source: import("./attention-sources").AttentionSource) {
    const plugin = this.ctx.pluginOwner?.id;
    if (
      bundledAttention.providers.some(
        ({ provider }) => provider === `${plugin}/${source.id}`,
      )
    )
      throw new Error(
        "Attention command sources are built into Buzz. Update the Attention UI plugin.",
      );
    if (
      !plugin ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(source.id) ||
      typeof source.run !== "function" ||
      (source.present !== undefined && typeof source.present !== "function") ||
      (source.description !== undefined &&
        (typeof source.description !== "string" ||
          !source.description.trim())) ||
      (source.configExample !== undefined &&
        (!source.configExample ||
          typeof source.configExample !== "object" ||
          Array.isArray(source.configExample) ||
          !serializable(source.configExample)))
    )
      throw new Error(
        "A plugin source needs an id, run and valid discovery metadata",
      );
    const connect = async (
      key: AgentKey,
      options: Readonly<{
        signal: AbortSignal;
        channel?: string | undefined;
        root?: string | undefined;
        cwd?: string;
      }>,
    ): Promise<HostMcpServer> => {
      if (!this.ctx.pluginOwner)
        throw new Error("Only an installed plugin connects as an agent");
      options.signal.throwIfAborted();
      const handle = this.runners.handle(key);
      if (!handle) throw new Error("This agent is not running here");
      const host = this.ctx.host;
      if (!host?.serveMcp)
        throw new Error("Agent connections require a desktop MCP host");
      const reads = () => {
        const source = ownerReads(this.relay(key), pubkeyOf(key));
        if (!source) throw new Error("The agent's community is not connected");
        return source;
      };
      const source = reads();
      const topLevel =
        options.channel !== undefined &&
        (await soloChat(
          () => this.relay(key),
          handle.owner,
          options.channel,
          options.signal,
        ));
      return connectMcp(
        host.serveMcp.bind(host),
        (signal) => {
          const client = appClient(handle, {
            signal,
            relayAuthor: source.relayAuthor?.(),
            signingAuthority: source.workflowAuthority(),
            check: () => {
              handle.attention.enabled();
              if (reads().connection !== source.connection)
                throw new Error("The agent's community connection changed");
            },
            read: async (path) => {
              if (handle.protection) {
                if (!host.spawn)
                  throw new Error("Protected file reading is unavailable");
                return readFile(
                  host.spawn.bind(host),
                  options.cwd ?? "~",
                  path,
                  signal,
                  handle.protection.processProtection,
                );
              }
              if (!host.readFile)
                throw new Error("This plugin cannot read local files");
              return host.readFile(
                path,
                options.cwd === undefined ? undefined : { cwd: options.cwd },
              );
            },
            memories: (slug) => reads().memoryListing(signal, slug),
          });
          return (message) =>
            respond(
              client,
              {
                ...(options.channel === undefined
                  ? {}
                  : { channel: options.channel }),
                ...(topLevel
                  ? { topLevel: true }
                  : options.root === undefined
                    ? {}
                    : { root: options.root }),
              },
              message,
            );
        },
        options.signal,
      );
    };
    const spawn = async (
      key: AgentKey,
      process: string,
      options: Omit<HostProcessOptions, "mcp"> & {
        signal: AbortSignal;
        channel?: string | undefined;
        root?: string | undefined;
      },
    ): Promise<HostProcess> => {
      options.signal.throwIfAborted();
      const host = this.ctx.host;
      if (!host?.spawn)
        throw new Error("Agent commands require a desktop process host");
      const handle = this.runners.handle(key);
      if (!handle) throw new Error("This agent is not running here");
      if (handle.protection)
        throw new Error(
          "Protected agents cannot run external Attention commands until that execution path supports complete protection",
        );
      const source = ownerReads(this.relay(key), pubkeyOf(key));
      if (!source) throw new Error("The agent's community is not connected");
      const spawn = host.spawn.bind(host);
      return spawnAgentCommand(
        {
          connect: (signal) => connect(key, { ...options, signal }),
          spawn: (settings) => spawn(process, settings),
          subscribe: (changed) => {
            const agent = this.subscribe(changed);
            const community = this.relay(key)?.subscribe(changed);
            return () => {
              agent();
              community?.();
            };
          },
          check: () => {
            if (!handle.attention.enabled())
              throw new Error("Attention is off");
            if (
              ownerReads(this.relay(key), pubkeyOf(key))?.connection !==
              source.connection
            )
              throw new Error("The agent's community connection changed");
          },
        },
        options,
      );
    };
    this.attentionSources.register(this.ctx, {
      ...source,
      run: async (input) => {
        const {
          agent,
          watch: { channel, root },
        } = input;
        const completed = new AbortController();
        const signal = AbortSignal.any([input.signal, completed.signal]);
        try {
          await source.run({
            ...input,
            spawn: (process, options) =>
              spawn(agent, process, {
                ...options,
                signal,
                channel,
                root,
              }),
          });
        } finally {
          completed.abort();
        }
      },
      ...(source.configExample === undefined
        ? {}
        : { configExample: JSON.parse(JSON.stringify(source.configExample)) }),
    });
  }
  private attentionProvider(source: Contribution<AttentionProducer>) {
    return (
      bundledAttention.providers.find(
        ({ plugin, id }) => source.pluginId === plugin && source.id === id,
      )?.provider ?? source.key
    );
  }
  attentionProviders = () =>
    this.attentionSources.snapshot().map((source) => {
      const { description, configExample } = source;
      return {
        provider: this.attentionProvider(source),
        ...(this.attentionProvider(source) !== source.key
          ? { builtIn: true }
          : {}),
        ...(description === undefined ? {} : { description }),
        ...(configExample === undefined
          ? {}
          : { configExample: JSON.parse(JSON.stringify(configExample)) }),
      };
    });
  presentWatch = (watch: import("./attention").SourceWatch, title: string) => {
    const source = this.attentionSources
      .snapshot()
      .find((source) => this.attentionProvider(source) === watch.provider);
    try {
      return source?.present?.(watch, title);
    } catch (error) {
      // One plugin's mistake leaves its watches plain, not the page broken.
      console.warn(
        `Attention source ${watch.provider} failed to present`,
        error,
      );
      return undefined;
    }
  };
  private history(
    key: AgentKey,
    object: AttentionObject,
    events: readonly AttentionEntry[] = [],
    lastWokeAt?: number,
  ) {
    void this.queued(key, async () => {
      const record = this.records[key];
      if (!record || record.attention[object.slug] !== object) return;
      const { output, ...prior } = record.attentionHistory?.[object.slug] ?? {};
      const kept = recentEntries([...(prior.events ?? []), ...events]);
      // Entries replace the one string a watch kept before them.
      const entry = {
        ...prior,
        ...(lastWokeAt !== undefined ? { lastWokeAt } : {}),
        ...(kept.length
          ? { events: kept }
          : output !== undefined
            ? { output }
            : {}),
      };
      await this.commit(key, record, {
        ...record,
        attentionHistory: { ...record.attentionHistory, [object.slug]: entry },
      });
      this.update();
    }).catch((error) => console.warn("Attention history was not saved", error));
  }
  private startAttentionSource(source: Contribution<AttentionProducer>) {
    const sources = new AttentionSources(
      {
        completed: (key, object) =>
          sourceCompleted(this.records[key]?.sourceRuns, object),
        finish: (key, object) => this.runners.completeSource(key, object),
        emit: (key, object, text, current) => {
          const agent = this.state.running.find((agent) => agent.key === key);
          if (
            !agent?.attentionEnabled ||
            agent.attention[object.slug] !== object ||
            !object.value.enabled
          )
            throw new Error("This source watch is no longer enabled");
          // Output keeps its end, where a failure is summarised.
          this.history(key, object, [
            { at: Math.floor(Date.now() / 1000), text: text.slice(-2000) },
          ]);
          this.runners.wakeSource(
            key,
            {
              type: "source",
              slug: object.slug,
              watch: object.value,
              plugin: source.pluginId,
              text,
            },
            object,
            current,
          );
        },
      },
      this.sourceTails,
    );
    const update = () =>
      sources.reconcile(
        this.attentionProvider(source),
        source,
        this.state.running.filter((agent) => this.runners.runs(agent.key)),
      );
    const unsubscribe = this.subscribe(update);
    update();
    return () => {
      unsubscribe();
      sources.stop();
    };
  }
  tools = () => this.addedTools.snapshot();
  readonly harness = harnessKit({
    relay: (key) => this.relay(key),
    core: (key) => this.core(key),
    added: () => this.tools(),
    repositories: repositoriesContext,
  });
  wake(key: AgentKey, wake: AgentWake) {
    const plugin = this.ctx.pluginOwner?.id;
    if (!plugin) throw new Error("Only a plugin wakes an agent");
    this.wakeIn(key, wake, { plugin });
  }
  private wakeIn(
    key: AgentKey,
    { channel, root, text }: AgentWake,
    source: Readonly<{ plugin: string } | { from: HandoffSource }>,
  ) {
    if (!channel || !text.trim())
      throw new Error("A wake needs a channel and text");
    // Harnesses find the thread from a well-formed id; any other would leave
    // them answering at the wake's own id.
    if (root !== undefined && !/^[0-9a-f]{64}$/i.test(root))
      throw new Error("A wake's root must be the thread's 64-hex event id");
    this.runners.wakeIn(key, {
      type: "plugin",
      ...source,
      channel,
      ...(root ? { root: root.toLowerCase() } : {}),
      text,
      id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
      at: Date.now(),
    });
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  resumeInterrupted = () => {
    this.runners.resumeInterrupted(this.interruptedKeys());
    this.update();
  };
  dismissInterrupted = () => {
    this.runners.dismissInterrupted(this.interruptedKeys());
    this.update();
  };
  /** The agents the notice names, and only they, are resumed or forgotten. */
  private interruptedKeys() {
    return this.state.interrupted.map((agent) => agent.key);
  }
  find = (pubkey: string) =>
    this.state.agents.find((agent) => agent.pubkey === pubkey);
  handle(key: AgentKey) {
    const owner = this.ctx.pluginOwner;
    return owner && this.runners.handle(key, owner.id);
  }
  canConnectExternal(key: AgentKey) {
    const handle = this.runners.handle(key);
    return (
      externalMcpEnabled(this.communities.snapshot().selected) &&
      !!handle &&
      !handle.protection
    );
  }
  async connectExternal(
    key: AgentKey,
    signal: AbortSignal,
    connected: () => void,
    scopes: readonly ExternalScope[] = ["read", "post"],
  ) {
    if (this.ctx.pluginOwner?.id !== "buzz.agents")
      throw new Error("Authorize external apps in Buzz.");
    const host = this.ctx.host;
    if (!host?.serveMcp)
      throw new Error("External connections require Buzz desktop.");
    const handle = this.runners.handle(key);
    if (!handle)
      throw new Error("This agent is not running in this copy of Buzz.");
    if (handle.protection)
      throw new Error("Protected agents cannot use external connections.");
    const relay = this.relay(key);
    const session = relay?.snapshot().session;
    const agent = this.agent(key);
    const source = ownerReads(relay, handle.pubkey);
    const selected = this.communities.snapshot();
    if (!externalMcpEnabled(selected.selected))
      throw new Error("External apps are not enabled for this community.");
    if (
      !source ||
      !relay ||
      !session ||
      !agent ||
      !selected.selected ||
      selected.viewer !== handle.owner ||
      relayOrigin(selected.selected) !== relayOrigin(agent.relay)
    )
      throw new Error("Select this agent's connected community first.");
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    const check = () => {
      lifetime.throwIfAborted();
      handle.attention.enabled();
      const current = this.communities.snapshot();
      if (
        current.viewer !== selected.viewer ||
        current.selected !== selected.selected ||
        !externalMcpEnabled(current.selected) ||
        ownerReads(this.relay(key), handle.pubkey)?.connection !==
          source.connection ||
        !session.agentChoices
          .snapshot()
          .selectable.some((agent) => agent.pubkey === handle.pubkey)
      )
        throw new Error(
          "The external connection has ended. Authorize the external app again in Buzz.",
        );
    };
    const changed = () => {
      try {
        check();
      } catch {
        controller.abort();
      }
    };
    const stops = [
      this.subscribe(changed),
      this.communities.subscribe(changed),
      relay.subscribe(changed),
      session.agentChoices.subscribe(changed),
    ];
    const release = () => {
      for (const stop of stops) stop();
    };
    try {
      check();
      const server = await connectMcp(
        host.serveMcp.bind(host),
        (signal) => {
          const client = appClient(handle, {
            signal,
            check,
            relayAuthor: source.relayAuthor?.(),
            signingAuthority: source.workflowAuthority(),
            read: async () => {
              throw new Error("External connections cannot read files.");
            },
            memories: async () => {
              throw new Error("External connections cannot read memory.");
            },
          });
          return (message) => {
            check();
            return respondExternal(client, message, connected, scopes);
          };
        },
        lifetime,
      );
      void server.closed.then(release);
      return server;
    } catch (error) {
      release();
      throw error;
    }
  }
  note(key: AgentKey, channelId: string, text: string, root?: string) {
    return this.runners.note(key, channelId, text, root);
  }
  relay = (key: AgentKey) => {
    const origin = originOf(this.agent(key)?.relay ?? "");
    return origin ? this.bound.get(origin)?.relay : undefined;
  };
  core = (key: AgentKey, signal?: AbortSignal) =>
    this.coreMemory.core(key, signal);
  private localCache:
    | {
        identities: readonly AgentIdentity[];
        state: Pick<AgentsSnapshot, "status" | "error">;
        hosted: readonly Agent[];
        value: LocalAgentsSnapshot;
      }
    | undefined;
  /** Local identities in every community, plus completed hosted choices in the
   * selected community. Hosted choices grant no local custody. */
  local = (): LocalAgentsSnapshot => {
    const { identities, state } = this;
    const hosted = state.agents.filter(
      (agent) => agent.place === "hosted" && !agent.unfinished,
    );
    const cached = this.localCache;
    if (
      cached?.identities === identities &&
      cached.hosted.length === hosted.length &&
      hosted.every((agent, index) => agent === cached.hosted[index]) &&
      cached.state.status === state.status &&
      cached.state.error === state.error
    )
      return cached.value;
    const value: LocalAgentsSnapshot = Object.freeze({
      status: state.status,
      agents: Object.freeze(
        identities
          .filter((identity) => !identity.deleted)
          .map(({ pubkey, name, relay, owner, picture }) =>
            Object.freeze({
              pubkey,
              name,
              relayUrl: relay,
              owner,
              ...(picture ? { picture } : {}),
            }),
          ),
      ),
      ...(hosted.length
        ? {
            hosted: Object.freeze(
              hosted.map(({ pubkey, name, relay, owner, picture }) =>
                Object.freeze({
                  pubkey,
                  name,
                  relayUrl: relay,
                  owner,
                  ...(picture ? { picture } : {}),
                }),
              ),
            ),
          }
        : {}),
      ...(state.error ? { error: state.error } : {}),
    });
    this.localCache = { identities, state, hosted, value };
    return value;
  };

  async create({ type, name, picture, config }: NewAgent) {
    if (!name.trim()) throw new Error("Name the agent");
    const remote = this.types().find((entry) => entry.key === type)?.remote;
    if (remote) {
      const listed = recordPicture(picture);
      if (picture && !listed)
        console.warn(`Agent ${name.trim()} picture is not an HTTPS image URL`);
      const binding = this.selectedBinding();
      const pending = this.unfinished.find(
        (setup) =>
          setup.type === type &&
          setup.name === name.trim() &&
          setup.relay === wssOf(binding.origin) &&
          setup.owner === binding.viewer,
      );
      if (pending) {
        if (config !== undefined || listed)
          await this.writeUnfinished(
            this.unfinished.map((setup) =>
              setup === pending
                ? {
                    ...setup,
                    ...(config !== undefined ? { config } : {}),
                    ...(listed ? { picture: listed } : {}),
                  }
                : setup,
            ),
          );
        return this.finish(pending.pubkey);
      }
      return this.provision(type, remote, name.trim(), listed, config);
    }
    return this.add(
      type,
      async (native, destination, owner) => ({
        agent: await native.create(destination, owner, type, name.trim()),
      }),
      { config, picture },
    );
  }
  creationRequests = () => this.requests;
  dismissCreation = (id: string) => {
    if (this.approving.has(id)) return;
    this.requests = this.requests.filter((request) => request.id !== id);
    this.notify();
  };
  async approveCreation(id: string, input: NewAgent) {
    const request = this.requests.find((item) => item.id === id);
    if (!request || this.approving.has(id))
      throw new Error("No such pending agent request");
    const binding = this.bindingOf({
      relay: request.community,
      owner: request.owner,
    });
    if (!binding || binding.controller.signal.aborted)
      throw new Error("Connect to the requesting community first");
    if (!input.name.trim()) throw new Error("Name the agent");
    this.approving.add(id);
    try {
      const agent = await this.add(
        input.type,
        async (native, destination, owner) => ({
          agent: await native.create(
            destination,
            owner,
            input.type,
            input.name.trim(),
          ),
        }),
        input,
        binding,
      );
      this.requests = this.requests.filter((item) => item.id !== id);
      this.notify();
      return agent;
    } finally {
      this.approving.delete(id);
    }
  }
  updateRequests = () => this.updates;
  dismissUpdate = (id: string) => {
    if (this.approving.has(id)) return;
    this.updates = this.updates.filter((request) => request.id !== id);
    this.notify();
  };
  async approveUpdate(id: string, input: NewAgent) {
    const request = this.updates.find((item) => item.id === id);
    if (!request || this.approving.has(id))
      throw new Error("No such pending agent request");
    // The agent as it is in the community that asked.
    const identity = this.identities.find(
      (member) =>
        member.pubkey === request.agent &&
        originOf(member.relay) === request.community &&
        !member.deleted,
    );
    if (!identity || identity.deleting)
      throw new Error(`${request.agentName} no longer exists`);
    const binding = this.bindingOf(identity);
    if (!binding || binding.controller.signal.aborted)
      throw new Error("Connect to the agent's community first");
    const { type, name, picture, config } = input;
    this.updateKind(identity, { name, type });
    const { key } = identity;
    const retyped = type !== identity.type;
    this.approving.add(id);
    try {
      if (retyped)
        await this.retype(
          key,
          type,
          config === undefined ? undefined : { config },
        );
      await this.save(key, {
        name,
        ...(picture && { picture }),
        ...(!retyped && config !== undefined && { config }),
      });
      this.updates = this.updates.filter((item) => item.id !== id);
      this.notify();
    } finally {
      this.approving.delete(id);
    }
  }
  /** The type `change` leaves the agent with, refusing what it cannot apply. */
  private updateKind(identity: AgentIdentity, change: AgentUpdate) {
    if (change.name !== undefined && !change.name.trim())
      throw new Error("Name the agent");
    const kind = this.types().find(
      (entry) => entry.key === (change.type ?? identity.type),
    );
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted provider cannot take over a local agent key");
    if (change.instructions !== undefined && !kind.adopt)
      throw new Error(`${kind.title} agents have no instructions to change`);
    return kind;
  }
  /** Whether watch classifiers can run on this device: the selected
   * decision provider is ready. */
  classifier(): ClassifierAvailability {
    return this.state.classifier;
  }
  private availability(): ClassifierAvailability {
    return this.decisions?.status() === "ready" ? "available" : "unavailable";
  }
  private updateClassifier() {
    const classifier = this.availability();
    if (this.state.classifier === classifier) return;
    this.state = Object.freeze({ ...this.state, classifier });
    this.notify();
  }
  /** The event's surroundings for the classifier, from what the app knows. */
  private async context(
    agent: Agent,
    event: RelayEvent,
  ): Promise<ClassifierContext> {
    const channelId = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.bindingOf(agent)?.session.channels;
    const summary = channelId
      ? (channels?.list().channels.find((item) => item.id === channelId) ??
        channels?.get?.(channelId))
      : undefined;
    const parent = threadReference(event)?.parentId ?? null;
    let found: RelayEvent | undefined;
    const native = this.native;
    if (parent && native)
      try {
        // Bounded: classified events release in order, so a stuck lookup
        // would hold back every later one.
        let timer: ReturnType<typeof setTimeout> | undefined;
        [found] = await Promise.race([
          native.query(agent, [{ ids: [parent], limit: 1 }]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("The parent lookup timed out")),
              PARENT_LOOKUP_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      } catch {
        // The parent stays unknown; the classifier still runs.
      }
    return {
      channel: { name: summary?.name ?? null },
      thread: {
        is_reply: !!parent,
        parent: found
          ? {
              author: {
                role:
                  found.pubkey === agent.pubkey
                    ? "self"
                    : found.pubkey === agent.owner
                      ? "owner"
                      : "other",
                name: this.displayName(agent, found.pubkey),
              },
              content: excerpt(found.content),
            }
          : null,
      },
      mentions: mentionFacts(event.tags, agent.pubkey, agent.owner),
    };
  }
  private displayName(agent: Agent, pubkey: string) {
    return (
      this.bindingOf(agent)?.session.profiles?.snapshot().get(pubkey)?.name ??
      null
    );
  }

  /** Has the provider make the agent, then sets it up. From here on it is
   * kept, unfinished until set up, so a failure never makes a second one. */
  private async provision(
    type: string,
    remote: RemoteAgentType,
    name: string,
    picture: string | undefined,
    config?: unknown,
  ) {
    const binding = this.selectedBinding();
    const community = wssOf(binding.origin);
    const { pubkey, picture: made } = await remote.provision({
      name,
      ...(picture ? { picture } : {}),
      community,
      ...(config !== undefined ? { config } : {}),
      signal: binding.controller.signal,
    });
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey))
      throw new Error("The provider did not return the agent's key");
    if (
      pubkey === binding.viewer ||
      this.identities.some((identity) => identity.pubkey === pubkey) ||
      [...this.bound.keys()].some((origin) => this.rowOf(origin, pubkey))
    )
      throw new Error("The provider returned a key that is already in use");
    if (
      made !== undefined &&
      (typeof made !== "string" || !recordPicture(made))
    )
      throw new Error("The provider returned an invalid picture");
    await this.writeUnfinished([
      ...this.unfinished.filter((setup) => setup.pubkey !== pubkey),
      {
        pubkey,
        type,
        name,
        relay: community,
        owner: binding.viewer,
        ...(made ? { picture: made } : {}),
        ...(config !== undefined ? { config } : {}),
      },
    ]);
    return this.finish(pubkey);
  }

  finish(pubkey: string) {
    return this.exclusive(pubkey, () => this.setUp(pubkey));
  }
  private async setUp(pubkey: string) {
    const setup = this.unfinished.find((entry) => entry.pubkey === pubkey);
    if (!setup) throw new Error("That agent has no setup to finish");
    const remote = this.types().find(
      (entry) => entry.key === setup.type,
    )?.remote;
    if (!remote) throw new Error("That agent type is not available");
    const origin = originOf(setup.relay);
    const binding = this.bindingOf(setup);
    if (!origin || !binding) throw new Error("Connect to its community first");
    const { signal } = binding.controller;
    const auth = await this.authorize(pubkey, signal);
    if (auth[1] !== setup.owner)
      throw new Error("Sign in as the agent's owner to finish its setup");
    await remote.activate({
      pubkey,
      name: setup.name,
      community: setup.relay,
      auth,
      ...(setup.config !== undefined ? { config: setup.config } : {}),
      signal,
    });
    const { picture } = setup;
    await this.writeListing(origin, binding, {
      pubkey,
      name: setup.name,
      ...(picture ? { picture } : {}),
      runtime: setup.type,
      prior: this.rowOf(origin, pubkey)?.prior,
    });
    await this.writeUnfinished(
      this.unfinished.filter((entry) => entry !== setup),
    );
    // Only its record makes a hosted agent a choice, so Solo chats can tag it.
    await binding.session.agentChoices.refresh(true, { fresh: true });
    const agent = this.find(pubkey);
    if (!agent) throw new Error("The agent was set up in another community");
    return agent;
  }

  async portable() {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const found = await native.portable();
    const own = new Set(
      this.identities
        .filter((identity) => !identity.deleted)
        .map((identity) => identity.pubkey),
    );
    const binding = this.bound.get(this.selectedOrigin() ?? "")?.binding;
    return {
      ...found,
      agents: found.agents.filter((agent) => !own.has(agent.pubkey)),
      here: binding
        ? this.identities
            .filter((identity) => yours(identity, binding))
            .map((identity) => identity.pubkey)
        : [],
    };
  }

  async port(input: PortInput): Promise<Ported> {
    const { type } = input;
    if (input.source !== "shared")
      return this.portIdentity(input.source, input.pubkey, type);
    const name = input.name.trim();
    if (!name) throw new Error("Name the agent");
    const { picture, instructions } = input;
    // A shared agent has no key to keep; it is a new identity that carries
    // what was shared, as a brought-over one does.
    const agent = await this.add(
      type,
      async (native, destination, owner) => ({
        agent: await native.create(destination, owner, type, name),
        ...(instructions?.trim() ? { carry: { instructions } } : {}),
      }),
      {
        picture,
        ...(input.config !== undefined ? { config: input.config } : {}),
      },
    );
    return { agent, notes: [] };
  }

  /** Takes over an identity an earlier agent system saved. One deleted here
   * whose cleanup already archived it comes back unarchived where the owner
   * can, and otherwise says it is still archived. */
  private async portIdentity(
    source: PortSource,
    pubkey: string,
    type: string,
    given?: Binding,
  ): Promise<Ported> {
    const binding = given ?? this.selectedBinding();
    const notes: string[] = [];
    // A cleanup still running from its Delete must not touch it once it is back.
    await this.reclaim(pubkey);
    try {
      const agent = await this.add(
        type,
        async (native, destination, owner) => {
          const ported = await native.port(
            source,
            pubkey,
            destination,
            owner,
            type,
          );
          notes.push(...(ported.notes ?? []));
          return ported;
        },
        {},
        binding,
      );
      await this.unarchiveHere(agent, binding, notes);
      return { agent, notes };
    } finally {
      this.reclaiming.delete(pubkey);
    }
  }
  /** Unarchives an agent that came into the binding's community, as one
   * deleted or removed there may have been archived, noting what is left. */
  private async unarchiveHere(agent: Agent, binding: Binding, notes: string[]) {
    try {
      const done = await unarchive(binding.session.archives, agent.pubkey);
      this.setArchiveUnchecked(agent.key, false);
      if (!done) notes.push(stillArchived(agent.name));
    } catch (error) {
      console.warn(`Agent ${agent.name} archive state was not checked`, error);
      this.setArchiveUnchecked(agent.key, true);
      this.update();
      this.notify();
      notes.push(
        `Couldn't check whether ${agent.name} is archived in this community. Retry from its settings.`,
      );
    }
  }

  async portTeam({
    id,
    type,
  }: Readonly<{ id: string; type: string }>): Promise<TeamPort> {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    // Every member and the team land here, whatever is opened meanwhile.
    const binding = this.selectedBinding();
    const origin = this.selectedOrigin();
    const kind = this.types().find((entry) => entry.key === type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted agent's key stays with its provider");
    const moved = () => this.selectedOrigin() !== origin;
    // As old Buzz has it now, not as the Import tab showed it.
    const found = await native.portable();
    if (moved()) throw new Error("Community changed");
    const old = found.teams.find((team) => team.id === id);
    if (!old) throw new Error("That team is no longer saved there");
    const live = this.liveRows();
    /** Its membership here, else one in another community. */
    const memberOf = (pubkey: string) =>
      live.find(
        (identity) => identity.pubkey === pubkey && yours(identity, binding),
      ) ?? live.find((identity) => identity.pubkey === pubkey);
    const members: string[] = [];
    const imported: Agent[] = [];
    const failed: { name: string; error: string }[] = [];
    const elsewhere: string[] = [];
    const foreign: string[] = [];
    const notes: string[] = [];
    const listed = new Set(found.agents.map((agent) => agent.pubkey));
    // Synced where this community syncs config, so every device imports the
    // same team.
    const home = this.newTeamHome(origin);
    const localId = await importedTeamId(old, binding.scope);
    const teamId = home
      ? await syncedTeamId({
          owner: binding.viewer,
          community: home,
          source: "old-buzz-team",
          sourceId: old.id,
        })
      : localId;
    const labels = publicKeyLabels(old.members.map(({ pubkey }) => pubkey));
    /** Whether an agent already here may be on the team, noting why not. */
    const fits = (here: AgentIdentity, name: string) => {
      if (yours(here, binding)) return true;
      // Its keys are another account's; neither can take it from the other.
      if (!ownedBy(here, binding)) foreign.push(name);
      // A synced team's members are in its home community only.
      else if (home)
        notes.push(`Add ${name} to ${hostOf({ relay: home })} first.`);
      // Kept to its own community's copy of the team, never moved here.
      else elsewhere.push(name);
      return false;
    };
    for (const member of old.members) {
      const name =
        member.name.trim() || (labels.get(member.pubkey) ?? member.pubkey);
      const here = memberOf(member.pubkey);
      if (here) {
        if (fits(here, name)) members.push(member.pubkey);
        continue;
      }
      if (!listed.has(member.pubkey)) {
        failed.push({ name, error: "No longer available in old Buzz" });
        continue;
      }
      // Checked with no wait before the import starts.
      if (moved()) {
        failed.push({ name, error: "Community changed" });
        continue;
      }
      try {
        const ported = await this.portIdentity(
          member.source,
          member.pubkey,
          type,
          binding,
        );
        const { agent } = ported;
        notes.push(...ported.notes);
        imported.push(agent);
        members.push(agent.pubkey);
      } catch (error) {
        failed.push({ name, error: message(error) });
      }
    }
    // Members an earlier import saved are judged as these were; one not
    // here now stays, as nothing shows it belongs to anyone else.
    const judged = new Set(old.members.map(({ pubkey }) => pubkey));
    const saved = this.teamList.find((team) => team.id === localId);
    const kept = (saved?.members ?? []).filter((pubkey) => {
      const here = memberOf(pubkey);
      if (judged.has(pubkey)) return false;
      if (!here) return true;
      return fits(here, here.name || pubkey);
    });
    const result = { imported, failed, elsewhere, foreign, notes };
    // A saved team is rewritten so the members judged out leave it; a new
    // one is made only with members.
    if (!saved && !members.length) return result;
    if (home) {
      try {
        // An existing synced team keeps its name and instructions; a new one
        // takes the local copy's edits over old Buzz's text.
        await this.changeSyncedTeam(
          home,
          {
            id: teamId,
            name: saved?.name ?? old.name,
            instructions: saved?.instructions ?? old.instructions,
            members: [...kept, ...members],
          },
          { adopt: true },
        );
        // Templates follow an earlier import's local copy before it goes.
        if (saved) {
          channelTemplates.replaceTeam(saved.id, teamId);
          await this.writeTeams(this.teamList.filter((team) => team !== saved));
        }
      } catch (error) {
        notes.push(message(error));
        return { ...result, teamError: { name: old.name } };
      }
      const team = this.synced().find((entry) => entry.team.id === teamId);
      return { ...result, ...(team && { team: team.team }) };
    }
    try {
      const team = await this.writeImportedTeam(old, teamId, saved, [
        ...kept,
        ...members,
      ]);
      return { ...result, team };
    } catch (error) {
      console.warn(`Team ${old.name} was not saved`, error);
      return { ...result, teamError: { name: old.name } };
    }
  }

  /** Saves a new identity of `type` in the selected community, or `binding`'s,
   * with the type's default settings, or the `config` it was made with,
   * adopting what a brought-over one carried. */
  private async add(
    type: string,
    save: (
      native: AgentsNative,
      destination: string,
      owner: string,
    ) => Promise<Readonly<{ agent: AgentIdentity; carry?: Carry }>>,
    made: Readonly<{ config?: unknown; picture?: string | undefined }> = {},
    given?: Binding,
  ) {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const binding = given ?? this.selectedBinding();
    const kind = this.types().find((entry) => entry.key === type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted agent's key stays with its provider");
    const settings = defaults("", kind);
    const { agent: identity, carry } = await save(
      native,
      relayOrigin(binding.origin),
      binding.viewer,
    );
    let record: AgentRecord = { ...settings, pubkey: identity.pubkey };
    try {
      if (made.config !== undefined)
        record = { ...record, config: made.config };
      if (carry && kind.adopt)
        record = { ...record, config: kind.adopt(carry, record.config) };
      await this.change(identity.pubkey, () => record);
    } catch (error) {
      // The agent exists either way; unsaved settings start from the defaults.
      console.warn(`Agent ${identity.name} settings were not saved`, error);
    }
    // Before the refresh, which publishes its profile with the picture. The
    // agent exists either way; its picture can be set again later.
    let shown: Member = { ...identity, key: identity.pubkey };
    const { picture } = made;
    if (picture)
      await native.setPicture(identity, picture).then(
        () => {
          shown = { ...shown, picture };
        },
        (error: unknown) =>
          console.warn(`Agent ${identity.name} picture was not saved`, error),
      );
    await this.refresh();
    const listed = this.identities.find(
      (member) =>
        !member.deleted &&
        member.pubkey === identity.pubkey &&
        member.relay === identity.relay,
    );
    return this.view(listed ?? shown, record);
  }

  private selectedOrigin() {
    return originOf(this.communities.snapshot().selected ?? "");
  }

  /** The selected community's live binding, where agents are made. */
  private selectedBinding() {
    const selected = this.communities.snapshot().selected;
    const binding = selected
      ? this.bound.get(originOf(selected) ?? "")?.binding
      : undefined;
    if (!binding) throw new Error("Connect to a community first");
    return binding;
  }

  configHistory = (key: AgentKey): ConfigHistory | undefined => {
    const agent = this.liveMember(key);
    const pubkey = pubkeyOf(key);
    const config = agent && this.communityConfigs.get(this.configHome(agent));
    const sides = config?.history(pubkey);
    if (!agent || !config || !sides?.length) return undefined;
    const schema = this.types().find((type) => type.key === agent.type)
      ?.syncedSettings?.schema;
    return {
      read: config.read,
      sides,
      ...(schema && { settings: { agentType: agent.type, schema } }),
      revise: async (side, template) => {
        // As a save: a revert can't put this type back over another's.
        const problem = side === "settings" && this.otherType(agent);
        if (problem) return { status: "refused", message: problem };
        const result = await config.revise(pubkey, side, template);
        switch (result.status) {
          case "saved":
          case "accepted-unavailable":
            return { status: "accepted" };
          case "unknown":
            return { status: "uncertain", message: result.message };
          default:
            return { status: "refused", message: saveProblem(result) };
        }
      },
    };
  };
  async save(key: AgentKey, change: AgentChange) {
    const identity = this.liveMember(key);
    // A hosted agent's key is its pubkey.
    if (!identity)
      return this.exclusive(key, () => this.saveHosted(key, change));
    if (!this.native) throw new Error("No such agent on this device");
    const { pubkey } = identity;
    if (change.config !== undefined && this.runners.transitioning(key))
      throw new Error(`${identity.name}'s provider is already changing`);
    const name = change.name?.trim();
    if (name === "") throw new Error("Name the agent");
    // Its config is its home record's, in every community; the rest is this
    // membership's own. Synced sides save to the relay first: an edit that
    // isn't saved there changes nothing here and stays in the editor.
    const home = key === pubkey;
    if (change.config !== undefined)
      await this.saveSynced(identity, change.config as object, change.base);
    if (!home && change.config !== undefined)
      await this.change(pubkey, (saved) =>
        changed(saved ?? this.settingsOf(identity), { config: change.config }),
      );
    const own = home ? change : { ...change, config: undefined };
    if (
      own.config !== undefined ||
      own.attention ||
      own.watchEnabled ||
      own.attentionEnabled !== undefined
    )
      await this.change(key, (saved) =>
        changed(saved ?? this.recordOf(identity), own),
      );
    const picture =
      change.picture === undefined ? undefined : change.picture || null;
    const renamed = name !== undefined && name !== identity.name;
    const repictured =
      picture !== undefined && picture !== (identity.picture ?? null);
    if (renamed) await this.native.rename(pubkey, name);
    if (repictured) await this.native.setPicture(identity, picture);
    // Shows the new name or picture and publishes it as the agent's profile.
    if (renamed || repictured) await this.refresh();
  }

  /** Why `identity`'s synced settings can't be revised here: their head
   * names another type. */
  private otherType(identity: AgentIdentity) {
    const settings = this.configBinding(identity).settings;
    const head = settings && this.configStore.state(settings.subject).head;
    const named = head && settingsType(head);
    return named && named !== identity.type
      ? `This agent's settings are for its ${named} type now; change its type here to edit them`
      : undefined;
  }

  /** Saves each synced side an edit changed as the next revision of the head
   * its editor opened; throws unless every one saved. */
  private async saveSynced(
    identity: AgentIdentity,
    config: object,
    base: ConfigBase = this.editorConfig(identity, config)?.base ?? {},
  ) {
    const live = this.communityConfigs.get(this.configHome(identity));
    const binding = this.configBinding(identity);
    const agent = this.configAgent(identity, config);
    const applies = (side: Side) => side === "instructions" || !!agent.schema;
    this.refuseWhileMoving(identity, applies);
    const edited = SIDES.filter((side) => {
      const subject = binding[side]?.subject;
      return (
        subject &&
        isSynced(this.configStore, binding[side]) &&
        applies(side) &&
        changes(side, agent, config, this.configStore.state(subject).head)
      );
    });
    if (!edited.length) return;
    const typed = edited.includes("settings") && this.otherType(identity);
    if (typed) throw new Error(typed);
    if (!live) throw new Error("Connect to the community to save");
    // Its editor showed no copy to revise, so the edit can't be based on it.
    const problem = this.editorConfig(identity, config)?.problem;
    if (
      problem &&
      edited.some((side) => {
        const subject = binding[side]?.subject;
        return !!subject && this.configStore.state(subject).state !== "present";
      })
    )
      throw new Error(problem);
    const saved = await live.save(agent, config, base);
    const failures = (Object.values(saved) as Saved[]).flatMap((result) =>
      result.status === "saved" ? [] : [saveProblem(result)],
    );
    // Not bound here yet, or not opened by the editor: nothing was sent.
    if (edited.some((side) => !saved[side]))
      failures.push("This agent's config isn't synced here yet; try again");
    if (failures.length) throw new Error(failures.join(" "));
  }
  /** Saved now, an edit would land in the local copy being moved and never
   * be sent, so it stays in its editor until the move is confirmed. */
  private refuseWhileMoving(
    identity: AgentIdentity,
    applies: (side: Side) => boolean = () => true,
  ) {
    const binding = this.configBinding(identity);
    if (
      SIDES.some((side) => applies(side) && binding[side]?.mode === "migrating")
    )
      throw new Error(
        "This agent's config is moving to the community; try again shortly",
      );
  }
  /** A hosted agent's name and picture are its provider's to publish; the app
   * then lists it under them. Its settings are the provider's, not saved here. */
  private async saveHosted(pubkey: string, change: AgentChange) {
    const { agent, remote, origin, binding } = this.hosted(pubkey);
    if (
      change.config !== undefined ||
      change.attention ||
      change.watchEnabled ||
      change.attentionEnabled !== undefined
    )
      throw new Error("A hosted agent's settings save through its provider");
    const name = change.name === undefined ? agent.name : change.name.trim();
    if (!name) throw new Error("Name the agent");
    const picture =
      change.picture === undefined
        ? agent.picture
        : recordPicture(change.picture ?? undefined);
    if (change.picture && !picture)
      throw new Error("A hosted agent's picture is an HTTPS image URL");
    // The provider can replace a picture but not clear one yet; listing the
    // agent without it would hide a picture its profile still shows.
    if (agent.picture && change.picture !== undefined && !change.picture)
      throw new Error(
        "A hosted agent's picture can't be removed yet; choose another picture",
      );
    if (name === agent.name && picture === agent.picture) return;
    await remote.profile({
      pubkey,
      community: agent.relay,
      name,
      ...(picture ? { picture } : {}),
      signal: binding.controller.signal,
    });
    await this.writeListing(origin, binding, {
      pubkey,
      name,
      ...(picture ? { picture } : {}),
      runtime: agent.type,
      prior: this.rowOf(origin, pubkey)?.prior,
    });
  }
  sessionState(key: AgentKey, place: SessionPlace): SessionState {
    const agent = this.agent(key);
    const type = agent && this.types().find((kind) => kind.key === agent.type);
    if (
      !agent ||
      (agent.protection && type?.protection !== true) ||
      !this.runners.runs(key) ||
      this.runners.transitioning(key)
    )
      return "unavailable";
    return type?.sessionControls?.state(agent, place) ?? "unavailable";
  }
  async session(
    key: AgentKey,
    place: SessionPlace,
    action: SessionControlAction,
  ) {
    // Only the selected community's agent, as its composer shows it.
    const shown = () => this.state.agents.find((agent) => agent.key === key);
    const agent = shown();
    const type = agent && this.types().find((kind) => kind.key === agent.type);
    if (
      !agent ||
      !type?.sessionControls ||
      this.sessionState(key, place) === "unavailable"
    )
      throw new Error(
        "Use session controls in the Buzz app that runs this agent.",
      );
    await this.runners.control(key, async () => {
      const current = shown();
      if (current?.type !== agent.type || !this.types().includes(type))
        throw new Error("The agent's harness changed. Try again.");
      await type.sessionControls?.run(current, place, action);
    });
  }

  /** Whether the owner can stop a hosted agent's turn: its provider can. A
   * hosted agent's key is its pubkey. */
  interruptible(pubkey: AgentKey) {
    const agent = this.state.agents.find(
      (entry) =>
        entry.pubkey === pubkey &&
        entry.place === "hosted" &&
        !entry.unfinished,
    );
    return !!this.types().find((entry) => entry.key === agent?.type)?.remote
      ?.interrupt;
  }
  /** Stops the hosted agent's turn in `place`; false when none was running. */
  async interrupt(
    pubkey: AgentKey,
    place: Readonly<{ channelId: string; threadRootId: string }>,
  ) {
    const { agent, remote, binding } = this.hosted(pubkey);
    if (!remote.interrupt) throw new Error("This agent can't be stopped here");
    return remote.interrupt({
      pubkey,
      community: agent.relay,
      ...place,
      signal: binding.controller.signal,
    });
  }

  /** A hosted agent shown now, its provider, and its community's live session. */
  private hosted(pubkey: string, unfinished = false) {
    const agent = this.state.agents.find(
      (entry) => entry.pubkey === pubkey && entry.place === "hosted",
    );
    if (agent?.unfinished && !unfinished)
      throw new Error("Finish the agent's setup first");
    const remote =
      agent && this.types().find((entry) => entry.key === agent.type)?.remote;
    const origin = agent && originOf(agent.relay);
    const binding = agent && this.bindingOf(agent);
    if (!agent || !remote || !origin || !binding)
      throw new Error("No such agent on this device");
    return { agent, remote, origin, binding };
  }

  async retype(
    key: AgentKey,
    type: string,
    change?: Readonly<{ config: unknown }>,
  ) {
    const identity = this.liveMember(key);
    if (!this.native || !identity)
      throw new Error("No such agent on this device");
    const kinds = new Map(this.types().map((kind) => [kind.key, kind]));
    const kind = kinds.get(type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted provider cannot take over a local agent key");
    if (type === identity.type) return [];
    this.refuseWhileMoving(identity);
    const retyped = async () => {
      // Its home can move its settings in while custody is claimed.
      this.refuseWhileMoving(identity);
      const { adopted, preview } = this.retypePlan(
        identity,
        kinds.get(identity.type),
        kind,
      );
      const config = change ? change.config : adopted;
      // Its other devices take the type its synced settings name.
      await this.publishType(identity, type, config as object);
      await this.applyType(identity, type, config);
      return preview.dropped;
    };
    return this.runners.retype(key, identity.name, () =>
      this.typeChange(identity, retyped),
    );
  }
  /** Runs a change of `identity`'s type once its home's attach in flight
   * settles, with no attach of it anywhere until the change ends. */
  private async typeChange<T>(
    identity: AgentIdentity,
    change: () => Promise<T>,
  ): Promise<T> {
    const { pubkey } = identity;
    if (this.retyping.has(pubkey))
      throw new Error(`${identity.name}'s provider is already changing`);
    this.retyping.add(pubkey);
    try {
      const home = this.communityConfigs.get(this.configHome(identity));
      const retireThenChange = async () => {
        const previous = this.types().find(
          (type) => type.key === identity.type,
        );
        if (identity.protection && !previous?.retire)
          throw new Error(
            "The protected runtime cannot safely change its type",
          );
        for (const member of this.identities)
          if (member.pubkey === pubkey && !member.deleted)
            await previous?.retire?.(member.key);
        return change();
      };
      return await (home
        ? home.exclusive(pubkey, retireThenChange)
        : retireThenChange());
    } finally {
      this.retyping.delete(pubkey);
      // Attaches it with the type it has now.
      this.update();
    }
  }
  /** Saves synced settings as `type`'s, unless they already are. */
  private async publishType(
    identity: AgentIdentity,
    type: string,
    config: object,
  ) {
    const settings = this.configBinding(identity).settings;
    if (!settings || !isSynced(this.configStore, settings)) return;
    const head = this.configStore.state(settings.subject).head;
    if (head && settingsType(head) === type) return;
    const live = this.communityConfigs.get(this.configHome(identity));
    if (!live) throw new Error("Connect to the community to change its type");
    const saved = await live.save(
      this.configAgent({ ...identity, type }, config),
      config,
      { settings: head?.id ?? null },
    );
    const result = saved.settings;
    if (result?.status !== "saved")
      throw new Error(
        result
          ? saveProblem(result)
          : "This agent's config isn't synced here yet; try again",
      );
  }
  /** Makes the agent `type` here with `config`, as its type's change saves. */
  private async applyType(
    identity: AgentIdentity,
    type: string,
    config: unknown,
  ) {
    const native = this.native;
    if (!native) throw new Error("No such agent on this device");
    const { pubkey } = identity;
    await native.setType(pubkey, type);
    try {
      await this.change(
        pubkey,
        (saved) => ({ ...(saved ?? this.settingsOf(identity)), config }),
        // Shown with its new type, only once its config is saved.
        () => {
          this.identities = this.identities.map((saved) =>
            saved.pubkey === pubkey ? { ...saved, type } : saved,
          );
        },
      );
    } catch (error) {
      try {
        await native.setType(pubkey, identity.type);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Could not save or restore ${identity.name}'s provider`,
        );
      }
      throw error;
    }
    await this.refresh();
  }
  /** Another device changed the agent's type: its synced settings name the
   * new one, which this device takes too when it has it. So does the device
   * that saved them when its own change failed after. Each head is tried
   * once, and once more after a run of the agent ends (`retakeType`); a type
   * this device doesn't have shows as its start's problem, and its settings
   * can't be saved here meanwhile. */
  private followType(identity: Member) {
    const settings = this.configBinding(identity).settings;
    if (settings?.mode !== "synced") return;
    const head = this.configStore.state(settings.subject).head;
    const type = head && settingsType(head);
    if (
      !head ||
      !type ||
      type === identity.type ||
      this.followedType.get(identity.pubkey) === head.id ||
      this.runners.transitioning(identity.key) ||
      // The change running now calls `update` as it ends.
      this.retyping.has(identity.pubkey)
    )
      return;
    const kind = this.types().find((candidate) => candidate.key === type);
    if (!kind || kind.remote) return;
    this.followedType.set(identity.pubkey, head.id);
    const failed = (error: unknown) =>
      console.warn(`Agent ${identity.name} didn't take its new type`, error);
    const { adopted } = this.retypePlan(
      identity,
      this.types().find((candidate) => candidate.key === identity.type),
      kind,
    );
    const exclusive = () =>
      this.typeChange(identity, () => this.applyType(identity, type, adopted));
    // The copy that runs it holds its runners while its type changes.
    void (
      this.runners.runs(identity.key)
        ? this.runners.retype(identity.key, identity.name, exclusive)
        : exclusive()
    ).catch(failed);
  }

  /** A run of the agent ended: a type it couldn't take, as while it was
   * answering, is tried once more. */
  private retakeType(key: AgentKey) {
    // Its home membership follows its type for every community.
    const identity = this.liveMember(pubkeyOf(key));
    if (identity && this.followedType.delete(identity.pubkey))
      this.followType(identity);
  }

  previewRetype(key: AgentKey, type: string): RetypePreview {
    const identity = this.liveMember(key);
    if (!this.native || !identity)
      throw new Error("No such agent on this device");
    const kinds = new Map(this.types().map((kind) => [kind.key, kind]));
    const kind = kinds.get(type);
    if (!kind) throw new Error("That agent type is not available");
    if (kind.remote)
      throw new Error("A hosted provider cannot take over a local agent key");
    if (type === identity.type)
      return {
        config: this.settingsOf(identity).config,
        moved: [],
        dropped: [],
        settings: [],
      };
    return this.retypePlan(identity, kinds.get(identity.type), kind).preview;
  }

  async remove(key: AgentKey): Promise<void> {
    const pubkey = pubkeyOf(key);
    if (!this.identities.some((identity) => identity.pubkey === pubkey))
      return this.removeHosted(pubkey);
    const running = this.deleting.get(pubkey);
    if (running) return running;
    const work = this.removeLocal(pubkey).finally(() =>
      this.deleting.delete(pubkey),
    );
    this.deleting.set(pubkey, work);
    return work;
  }
  /** Keeps its key until each community it is in confirms it left every
   * channel and was archived, so nothing can import it back meanwhile, here
   * or in another copy of the app. The owner signs each step. */
  private async removeLocal(pubkey: string) {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const identity = this.liveRows(pubkey)[0];
    if (!identity) throw new Error("No such agent on this device");
    // Saved first, so neither a relaunch nor another copy runs it again.
    await native.beginDelete(pubkey);
    await this.refresh();
    // The community shown goes last, and only once the others are done, so
    // one that is not stays listed here with Forget.
    const shown = this.selectedOrigin();
    const rows = this.liveRows(pubkey);
    const roleBindings = [
      ...new Map(
        rows.flatMap((row) => {
          const binding = this.bindingOf(row);
          return binding ? [[binding.scope, binding] as const] : [];
        }),
      ).values(),
    ];
    const unfinished = `${identity.name} isn't deleted yet and may still be in some channels. It stays stopped; Delete it again to finish.`;
    // Left its home, which keeps its config: that is archived first, so a
    // failure leaves it listed here to Delete again.
    if (!rows.some((row) => row.key === pubkey))
      await this.archiveHomeConfig(identity).catch((error: unknown) => {
        console.warn(`Agent ${identity.name} config was not archived`, error);
        throw new Error(`${unfinished} Its home community isn't connected.`);
      });
    // Its config channel can't be archived until its home's coordinator is
    // up, so nothing is removed before then.
    else if (
      Object.keys(this.configBinding(identity)).length &&
      !this.communityConfigs.get(this.configHome(identity))
    )
      throw new Error(`${unfinished} Its home community isn't connected.`);
    const here = rows.filter((member) => originOf(member.relay) === shown);
    const left: Member[] = [];
    let offline = false;
    for (const member of [
      ...rows.filter((row) => !here.includes(row)),
      ...here,
    ]) {
      if (left.length && here.includes(member)) continue;
      const departed = await this.depart(member, true);
      if (departed === "done") continue;
      left.push(member);
      offline ||= departed === "offline";
    }
    if (left.length && rows.length === 1)
      throw new Error(
        offline ? `${unfinished} Its community isn't connected.` : unfinished,
      );
    if (left.length) {
      // Shows it gone from the communities it did leave.
      await this.refresh();
      throw new Error(
        `${unfinished} It is still in ${left.map(hostOf).join(", ")}.`,
      );
    }
    for (const origin of this.listings.keys()) this.unlist(origin, pubkey);
    // Drops its settings.
    await this.refresh();
    forgetDefaultAgent(pubkey);
    const failed: string[] = [];
    for (const binding of roleBindings)
      try {
        await clearDeletedDefaultAgent(binding.session, binding.scope, pubkey);
      } catch {
        failed.push(binding.origin);
      }
    if (failed.length)
      throw new Error(
        `${identity.name} was deleted, but Buzz couldn't clear it as your Bestie in ${failed.join(", ")}. Open Bestie to choose another.`,
      );
  }
  /** Archives the config channel in the agent's home community, which it is
   * no longer a member of. Nothing to do when its config never synced. */
  private async archiveHomeConfig(identity: AgentIdentity) {
    if (!Object.keys(this.configBinding(identity)).length) return;
    const home = this.configHome(identity);
    const binding = this.bound.get(home)?.binding;
    const config = this.communityConfigs.get(home);
    if (!binding || !config) throw new Error("Its home isn't connected");
    await config.remove(
      identity.pubkey,
      AbortSignal.any([
        binding.controller.signal,
        AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
      ]),
    );
  }
  /** Takes the membership out of its community: it leaves every channel and
   * is archived there, and its record there is deleted, and only then its key
   * and row here. Nothing is deleted when its community is offline or the
   * cleanup fails. All of it runs under its removal held for this copy of the
   * app, so a cleanup from another copy can't undo its being added there
   * again afterwards. Its catalog share there goes too, as nothing there
   * lists it to unshare from after; Delete also archives its config channel
   * in its home, which keeps it. */
  private async depart(member: Member, deleting = false) {
    const native = this.native;
    const binding = this.bindingOf(member);
    if (!native || !binding) return "offline";
    const { pubkey } = member;
    // Refused while another copy of the app removes it, which says so.
    await native.holdRemoval(member);
    try {
      try {
        const signal = AbortSignal.any([
          binding.controller.signal,
          AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
        ]);
        await leaveCommunity(binding.session, pubkey, signal);
        await unshare(binding.session, binding.viewer, pubkey, signal);
        await deleteAgentRecord(
          binding.session,
          binding.viewer,
          pubkey,
          signal,
        );
        if (deleting && member.key === pubkey) {
          // Home can reconnect while another community's departure awaits,
          // before its new coordinator is up.
          const config = this.communityConfigs.get(binding.origin);
          if (config) await config.remove(pubkey, signal);
          else if (Object.keys(this.configBinding(member)).length)
            throw new Error("Its home's config coordinator isn't up");
        }
      } catch (error) {
        console.warn(
          `Agent ${member.name} did not leave ${member.relay}`,
          error,
        );
        return "failed";
      }
      await native.remove(member);
      this.setArchiveUnchecked(member.key, false);
      this.unlist(binding.origin, pubkey);
      await native.forget(member);
    } finally {
      await native.releaseRemoval(member);
    }
    // So the community's agent choices no longer offer it.
    await binding.session.agentChoices.refresh(true, { fresh: true });
    return "done";
  }

  memberships(pubkey: string) {
    return this.liveRows(pubkey).map((member) => ({
      key: member.key,
      origin: originOf(member.relay) ?? member.relay,
      connected: !!this.bindingOf(member),
      ...(member.deleting && { deleting: true as const }),
    }));
  }
  async forget(key: AgentKey) {
    const native = this.native;
    const member = this.liveMember(key);
    if (!native || !member) throw new Error("No such agent on this device");
    if (!member.deleting)
      throw new Error("Only an agent whose Delete started can be forgotten");
    await native.holdRemoval(member);
    try {
      await native.remove(member);
      this.setArchiveUnchecked(key, false);
      this.unlist(originOf(member.relay) ?? "", member.pubkey);
      await native.forget(member);
    } finally {
      await native.releaseRemoval(member);
    }
    await this.refresh();
    if (!this.liveRows(member.pubkey).length) forgetDefaultAgent(member.pubkey);
  }

  joinable() {
    const binding = this.bound.get(this.selectedOrigin() ?? "")?.binding;
    if (!binding) return [];
    const here = new Set(
      this.liveRows()
        .filter((member) => originOf(member.relay) === binding.origin)
        .map((member) => member.pubkey),
    );
    const shown = new Map<string, Agent>();
    for (const member of this.liveRows()) {
      const { pubkey } = member;
      if (here.has(pubkey) || member.deleting || !ownedBy(member, binding))
        continue;
      // By its home, where it has one; else the first community it is in.
      if (shown.has(pubkey) && member.key !== pubkey) continue;
      shown.set(pubkey, this.view(member, this.recordOf(member)));
    }
    return [...shown.values()];
  }
  async join(key: AgentKey): Promise<Ported> {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const source = this.liveMember(key);
    if (!source) throw new Error("No such agent on this device");
    const { pubkey, name, picture } = source;
    if (source.deleting) throw new Error(`${name} is being deleted`);
    const binding = this.selectedBinding();
    const { origin } = binding;
    if (!ownedBy(source, binding))
      throw new Error(`${name} belongs to another account`);
    if (
      this.liveRows(pubkey).some((member) => originOf(member.relay) === origin)
    )
      throw new Error(`${name} is already here`);
    // Native gives the row it adds its home, the source's.
    const target = agentKey(pubkey, origin, homeOf(source));
    // A cleanup still running from its leaving here must not touch it now.
    await this.reclaim(target);
    try {
      // A picture in its community's media is fetched there and uploaded
      // here; any other is a URL both can show.
      const media =
        picture?.startsWith(`${relayOrigin(source.relay)}/media/`) && picture;
      // An animated avatar's `#buzz-anim=` fragment is display's, not the blob's.
      const image = media
        ? await native
            .media(source, media.split("#", 1)[0] ?? media)
            .catch((error: unknown) => {
              console.warn(`Agent ${name} picture was not fetched`, error);
              return undefined;
            })
        : undefined;
      const joined = await native.join(
        pubkey,
        source.relay,
        relayOrigin(origin),
        media ? undefined : picture,
      );
      const notes: string[] = [];
      if (media)
        try {
          if (!image?.data) throw new Error("Not an image an agent can show");
          const { url } = await native.upload(joined, image.data, image.type);
          await native.setPicture(joined, url);
        } catch (error) {
          console.warn(`Agent ${name} picture was not copied`, error);
          notes.push(
            `${name}'s picture didn't come over. Choose one in its settings.`,
          );
        }
      // Its listing here is written new, for this membership.
      this.unlist(origin, pubkey);
      await this.refresh();
      const agent = this.agent(target) ?? this.find(pubkey);
      if (!agent) throw new Error(`${name} was added but isn't shown yet`);
      await this.unarchiveHere(agent, binding, notes);
      return { agent, notes };
    } finally {
      this.reclaiming.delete(target);
    }
  }
  leave(key: AgentKey): Promise<void> {
    const running = this.leaving.get(key);
    if (running) return running;
    const work = this.leaveHere(key).finally(() => this.leaving.delete(key));
    this.leaving.set(key, work);
    return work;
  }
  /** Takes it out of one community, as Delete does, and keeps its key and
   * settings for its others. Its conversations stay on this device, so they
   * come back if it is added again; what it paid attention to there does not. */
  private async leaveHere(key: AgentKey) {
    const native = this.native;
    if (!native) throw new Error("Agents run only in the desktop app");
    const member = this.liveMember(key);
    if (!member) throw new Error("No such agent on this device");
    const { pubkey, name } = member;
    if (
      !this.liveRows(pubkey).some(
        (other) => other.key !== key && !other.deleting,
      )
    )
      throw new Error(
        `This is ${name}'s last community. Delete it to remove it here.`,
      );
    // Saved first, so neither a relaunch nor another copy runs it there again.
    await native.beginLeave(member);
    await this.refresh();
    const departed = await this.depart(member);
    if (departed !== "done")
      throw new Error(
        `${name} hasn't left ${hostOf(member)} yet and may still be in some of its channels. It stays stopped there; Remove it again to finish.${departed === "offline" ? " That community isn't connected." : ""}`,
      );
    // Its home record keeps the agent's settings, but not what it paid
    // attention to there.
    if (key === pubkey)
      await this.change(key, (saved) => {
        if (!saved) return null;
        const {
          skipped: _,
          timers: __,
          attentionEnabled: ___,
          ...rest
        } = saved;
        return { ...rest, attention: {} };
      });
    await this.refresh();
  }

  async unarchive(key: AgentKey): Promise<string | undefined> {
    const identity = this.liveMember(key);
    const binding = identity && this.bindingOf(identity);
    if (!binding)
      throw new Error("Its community isn't connected. Try again once it is.");
    const done = await unarchive(binding.session.archives, identity.pubkey);
    this.setArchiveUnchecked(key, false);
    this.update();
    this.notify();
    return done ? undefined : stillArchived(identity.name);
  }

  /** Has a hosted agent's provider remove it, then takes it out of the
   * community as Delete does for one here. Its record goes last, so a failure
   * leaves it listed for Delete to be tried again. */
  private removeHosted(pubkey: string) {
    if (
      this.state.agents.some(
        (agent) => agent.pubkey === pubkey && agent.place === "elsewhere",
      )
    )
      throw new Error("Delete it on the device that runs it");
    return this.exclusive(pubkey, async () => {
      const { agent, remote, origin, binding } = this.hosted(pubkey, true);
      const { signal } = binding.controller;
      await remote.remove({ pubkey, community: agent.relay, signal });
      // Before its record goes, so a failure leaves it listed to Delete again.
      await unshare(binding.session, binding.viewer, pubkey, signal);
      // An unfinished one may have published its profile before setup failed.
      await removeRelayAgent(binding.session, binding.viewer, pubkey, signal);
      this.unlist(origin, pubkey);
      await this.writeUnfinished(
        this.unfinished.filter((setup) => setup.pubkey !== pubkey),
      );
      try {
        await handOnMainAgent(binding.session, pubkey);
      } catch {
        throw new Error(
          `${agent.name} was deleted, but Buzz couldn't clear it as your Bestie. Open Bestie to choose another.`,
        );
      }
    });
  }
  private async exclusive<T>(pubkey: string, step: () => Promise<T>) {
    if (this.busy.has(pubkey))
      throw new Error("Wait for the agent's last change to finish");
    this.busy.add(pubkey);
    try {
      return await step();
    } finally {
      this.busy.delete(pubkey);
    }
  }

  async saveTeam({
    id,
    name,
    instructions,
    members,
    opened,
    draft,
  }: TeamChange) {
    if (!this.native) throw new Error("Agents run only in the desktop app");
    if (!name.trim()) throw new Error("Name the team");
    const home = this.teamHome(id, draft);
    const teamId = id ?? draft;
    if (home && teamId) {
      if (draft) this.teamDrafts.set(draft, home);
      if (id && !opened?.revision)
        throw new Error("Close and reopen this team to change it");
      const team: Team = Object.freeze({
        id: teamId,
        name: name.trim(),
        instructions,
        members: Object.freeze([...new Set(members)]),
      });
      await this.changeSyncedTeam(home, team, {
        ...(opened?.revision
          ? { base: { head: opened.revision, members: opened.members } }
          : {}),
      });
      if (draft) this.teamDrafts.delete(draft);
      return team;
    }
    const unknown = members.find((pubkey) => !this.liveRows(pubkey).length);
    if (unknown) throw new Error("A member is not an agent on this device");
    if (id && !this.teamList.some((team) => team.id === id))
      throw new Error("No such team");
    const team: Team = Object.freeze({
      id: id ?? crypto.randomUUID(),
      name: name.trim(),
      instructions,
      members: Object.freeze([...new Set(members)]),
    });
    await this.writeTeams(
      id
        ? this.teamList.map((saved) => (saved.id === id ? team : saved))
        : [...this.teamList, team],
    );
    return team;
  }

  teamHere(
    { id, draft }: Pick<TeamChange, "id" | "draft">,
    community?: string,
  ) {
    const origin =
      community === undefined ? this.selectedOrigin() : originOf(community);
    try {
      return !!origin && this.teamHome(id, draft) === origin;
    } catch {
      // Save refuses a new team while it can't tell where that syncs.
      return false;
    }
  }

  /** Where Save puts the team with `id`, or the new team `draft`: a synced
   * team's home, or where a new one syncs, staying in the community its
   * first Save chose. Undefined keeps the team on this device. */
  private teamHome(id: string | undefined, draft: string | undefined) {
    if (id)
      return this.synced().find((entry) => entry.team.id === id)?.community;
    return draft
      ? (this.teamDrafts.get(draft) ?? this.newTeamHome(this.selectedOrigin()))
      : undefined;
  }

  /** Where a new team made with `selected` selected syncs: nowhere only
   * when its relay is known to have no config channels. */
  private newTeamHome(selected: string | undefined) {
    if (!selected || this.communityConfigs.has(selected)) return selected;
    if (this.bound.get(selected)?.binding?.support === "unsupported") return;
    throw new Error(
      `Can't tell yet whether ${hostOf({ relay: selected })} syncs teams; try again shortly`,
    );
  }

  /** Puts `members` on an old Buzz team's copy `id`, made from `saved` or,
   * the first time, `team`. Its name and instructions here are never
   * replaced. */
  private async writeImportedTeam(
    team: OldTeam,
    id: string,
    saved: Team | undefined,
    members: readonly string[],
  ) {
    const joined: Team = Object.freeze({
      id,
      name: saved?.name ?? team.name,
      instructions: saved?.instructions ?? team.instructions,
      members: Object.freeze([...new Set(members)]),
    });
    await this.writeTeams(
      saved
        ? this.teamList.map((entry) => (entry === saved ? joined : entry))
        : [...this.teamList, joined],
    );
    return joined;
  }

  async removeTeam(id: string) {
    const synced = this.synced().find((entry) => entry.team.id === id);
    if (synced) {
      const config = this.communityConfigs.get(synced.community);
      if (!config)
        throw new Error(
          `Connect to ${hostOf({ relay: synced.community })} to delete this team`,
        );
      return config.removeTeam(id);
    }
    await this.writeTeams(this.teamList.filter((team) => team.id !== id));
  }

  /** Synced teams with a confirmed copy, as members use them. */
  private synced() {
    const { viewer } = this.communities.snapshot();
    return this.syncedTeams.all().flatMap(({ owner, community, team }) => {
      if (owner !== viewer) return [];
      const subject = teamArtifact(owner, community, team);
      const head = !team.archived && this.configStore.state(subject).head;
      const body = head && teamBody(head.content);
      return body
        ? [
            {
              community,
              team: Object.freeze({
                id: team.id,
                ...body,
                members: team.members,
                revision: head.id,
              }) as Team,
            },
          ]
        : [];
    });
  }
  private allTeams(): readonly Team[] {
    return [...this.teamList, ...this.synced().map((entry) => entry.team)];
  }
  private teamsChanged() {
    this.teamsFor = this.communities.snapshot().viewer;
    const prior = this.state.teams;
    // Reuse each unchanged team, so config churn notifies nobody.
    const teams = this.allTeams().map(
      (team) =>
        prior.find(
          (old) =>
            old.id === team.id &&
            old.revision === team.revision &&
            old.name === team.name &&
            old.instructions === team.instructions &&
            old.members.length === team.members.length &&
            old.members.every(
              (member, index) => member === team.members[index],
            ),
        ) ?? team,
    );
    if (
      teams.length === prior.length &&
      teams.every((team, index) => team === prior[index])
    )
      return;
    this.state = Object.freeze({ ...this.state, teams });
    this.notify();
  }

  /** Makes `team` so in its home community, online: only its owner's agents
   * there may be members, and none is added to that community here. Rejects
   * with what was and wasn't done unless all of it was confirmed. */
  private async changeSyncedTeam(
    home: string,
    team: Team,
    extra: Readonly<{
      base?: Readonly<{ head: string; members: readonly string[] }>;
      adopt?: boolean;
    }>,
  ) {
    const host = hostOf({ relay: home });
    const opened = extra.base?.members ?? [];
    const labels = publicKeyLabels(new Set([...team.members, ...opened]));
    const name = (pubkey: string) =>
      this.liveRows(pubkey)[0]?.name || (labels.get(pubkey) ?? pubkey);
    // New members must be here or hosted in the home community. Ones the team
    // already has may run on another device; the roster proves them.
    const members = new Set(this.teamAgents(home).map((agent) => agent.pubkey));
    const outside = team.members.find(
      (pubkey) => !opened.includes(pubkey) && !members.has(pubkey),
    );
    // Until its agent records are read, a hosted one there isn't known.
    if (outside)
      throw new Error(
        this.listings.has(home)
          ? `Add ${name(outside)} to ${host} first`
          : `Can't tell yet whether ${name(outside)} is in ${host}; try again shortly`,
      );
    const config = this.communityConfigs.get(home);
    if (!config) throw new Error(`Connect to ${host} to change this team`);
    const result = await config.saveTeam({ ...team, ...extra });
    if (!result.ok) throw new Error(teamOutcome(result, name));
  }

  /** Saves the teams; memory changes once storage has taken them, and the
   * promise settles once they are saved. When the save fails, memory goes
   * back to the teams storage still has. */
  private writeTeams(teams: readonly Team[]) {
    const saving = writeTeams(this.storage, teams);
    const shown = this.showTeams(teams);
    return saving.catch((error: unknown) => {
      if (this.teamList === shown) this.showTeams(readTeams(this.storage));
      throw error;
    });
  }
  private showTeams(teams: readonly Team[]) {
    this.teamList = Object.freeze(teams);
    this.teamsChanged();
    return this.teamList;
  }

  /** Saves which imports need an archive check, then keeps it in memory. */
  private setArchiveUnchecked(pubkey: string, unchecked: boolean) {
    if (this.unarchiving.has(pubkey) === unchecked) return;
    const next = new Set(this.unarchiving);
    if (unchecked) next.add(pubkey);
    else next.delete(pubkey);
    // Unsaved, the next start offers no Retry until a check fails again.
    void writeArchiveUnchecked(this.storage, next).catch((error) =>
      console.warn("Agent archive checks were not saved", error),
    );
    this.unarchiving = next;
  }

  /** Saves the unfinished setups; memory changes once storage has taken them,
   * and the promise settles once they are saved. When the save fails, memory
   * goes back to the setups storage still has. */
  private writeUnfinished(unfinished: readonly Unfinished[]) {
    const saving = writeUnfinished(this.storage, unfinished);
    const shown = this.showUnfinished(unfinished);
    return saving.catch((error: unknown) => {
      if (this.unfinished === shown)
        this.showUnfinished(readUnfinished(this.storage));
      throw error;
    });
  }
  private showUnfinished(unfinished: readonly Unfinished[]) {
    this.unfinished = Object.freeze(unfinished);
    this.update();
    return this.unfinished;
  }

  /** Reads the viewer's agent records in the community, then lists each of
   * its agents here that they lack. A sync asks again until one succeeds.
   * Without the desktop app there are no agents to show. */
  private async readListings(origin: string, binding: Binding) {
    if (!this.native || this.reading.get(origin) === binding) return;
    this.reading.set(origin, binding);
    const { session, viewer, controller } = binding;
    try {
      const events = await session.read(
        [{ kinds: [30177], authors: [viewer], limit: 500 }],
        { signal: controller.signal, priority: "background", fresh: true },
      );
      if (this.bound.get(origin)?.binding !== binding) return;
      const edits = this.edits.get(origin);
      const read = listingsOf(events, viewer).filter(
        (row) => !edits?.has(row.pubkey),
      );
      const written = [...(edits?.values() ?? [])].filter((row) => !!row);
      this.listings.set(origin, Object.freeze([...read, ...written]));
      this.edits.delete(origin);
    } catch (error) {
      // Its edits stay for the next read, which a sync asks for.
      if (!controller.signal.aborted)
        console.warn("The agent list could not be read", error);
      return;
    } finally {
      if (this.reading.get(origin) === binding) this.reading.delete(origin);
    }
    this.update();
    this.list(origin, binding);
  }
  /** The community's listings: as read, or until the first read finishes,
   * those written since. */
  private rowsOf(origin: string): readonly Listing[] {
    return (
      this.listings.get(origin) ??
      [...(this.edits.get(origin)?.values() ?? [])].filter((row) => !!row)
    );
  }
  private rowOf(origin: string, pubkey: string) {
    return this.rowsOf(origin).find((row) => row.pubkey === pubkey);
  }
  /** Lists each agent here in the community whose record is missing or shows
   * another name, picture or type. Waits for the first read, so it never
   * replaces a record it has not seen. */
  private list(origin: string, binding: Binding) {
    if (!this.listings.has(origin)) return;
    for (const identity of this.identities) {
      if (
        identity.deleted ||
        identity.deleting ||
        identity.owner !== binding.viewer ||
        originOf(identity.relay) !== origin ||
        this.listing.has(identity.key)
      )
        continue;
      const picture = recordPicture(identity.picture);
      const row = this.rowOf(origin, identity.pubkey);
      if (
        row?.name === identity.name &&
        row.picture === picture &&
        row.runtime === identity.type
      )
        continue;
      const { key, pubkey } = identity;
      this.listing.add(key);
      this.writeListing(origin, binding, {
        pubkey,
        name: identity.name,
        ...(picture ? { picture } : {}),
        runtime: identity.type,
        prior: row?.prior,
      }).then(
        () => {
          this.listing.delete(key);
          // Lists a rename or new picture made while this write was under way.
          if (this.bound.get(origin)?.binding === binding)
            this.list(origin, binding);
        },
        (error) => {
          this.listing.delete(key);
          if (!binding.controller.signal.aborted)
            console.warn(`Agent ${identity.name} was not listed`, error);
        },
      );
    }
  }
  /** Writes the agent's record and lists it so, without reading it back.
   * Never relists an agent being deleted: its record may already be gone. */
  private async writeListing(
    origin: string,
    binding: Binding,
    entry: Listing & { runtime: string },
  ) {
    if (this.isDeleting(origin, entry.pubkey)) return;
    const prior = await publishAgentRecord(
      binding.session,
      entry,
      binding.controller.signal,
    );
    if (this.bound.get(origin)?.binding !== binding) return;
    this.setRow(origin, entry.pubkey, Object.freeze({ ...entry, prior }));
    this.update();
  }
  /** Whether its Delete, or its leaving the community at `origin`, started
   * there; in its other communities it is still listed. */
  private isDeleting(origin: string, pubkey: string) {
    return this.identities.some(
      (identity) =>
        identity.pubkey === pubkey &&
        originOf(identity.relay) === origin &&
        identity.deleting,
    );
  }
  private unlist(origin: string, pubkey: string) {
    this.setRow(origin, pubkey, null);
  }
  /** Replaces or removes the agent's listing, and keeps the change until the
   * community's records are first read. */
  private setRow(origin: string, pubkey: string, row: Listing | null) {
    const listings = this.listings.get(origin);
    if (!listings) {
      const edits = this.edits.get(origin) ?? new Map<string, Listing | null>();
      this.edits.set(origin, edits.set(pubkey, row));
      return;
    }
    const rest = listings.filter((entry) => entry.pubkey !== pubkey);
    if (row || rest.length !== listings.length)
      this.listings.set(origin, Object.freeze(row ? [...rest, row] : rest));
  }
  /** The selected community's agents that are not here: hosted ones, set up
   * or not, and ones on the viewer's other devices. */
  private listedAgents(origin: string | undefined) {
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    if (!origin || !binding) return [];
    const here = new Set(this.identities.map((identity) => identity.pubkey));
    const listings = this.rowsOf(origin);
    const types = new Map(this.types().map((type) => [type.key, type]));
    const relay = wssOf(binding.origin);
    const shown: Agent[] = [];
    for (const row of listings)
      if (row.runtime && row.name && !here.has(row.pubkey))
        shown.push(
          this.show({
            pubkey: row.pubkey,
            name: row.name,
            ...(row.picture ? { picture: row.picture } : {}),
            type: row.runtime,
            owner: binding.viewer,
            relay,
            place: types.get(row.runtime)?.remote ? "hosted" : "elsewhere",
          }),
        );
    for (const setup of this.unfinished)
      if (
        originOf(setup.relay) === origin &&
        setup.owner === binding.viewer &&
        !here.has(setup.pubkey) &&
        !listings.some((row) => row.runtime && row.pubkey === setup.pubkey)
      )
        shown.push(
          this.show({
            pubkey: setup.pubkey,
            name: setup.name,
            ...(setup.picture ? { picture: setup.picture } : {}),
            type: setup.type,
            owner: setup.owner,
            relay: setup.relay,
            place: "hosted",
            unfinished: true,
          }),
        );
    return shown;
  }
  /** The agent as shown, the same object while nothing about it changed. */
  private show(
    fields: Pick<
      Agent,
      | "pubkey"
      | "name"
      | "picture"
      | "type"
      | "owner"
      | "relay"
      | "place"
      | "unfinished"
      | "protection"
      | "protectionRevision"
    >,
  ): Agent {
    const prior = this.shown.get(fields.pubkey);
    if (
      prior &&
      prior.name === fields.name &&
      prior.picture === fields.picture &&
      prior.type === fields.type &&
      prior.owner === fields.owner &&
      prior.relay === fields.relay &&
      prior.place === fields.place &&
      prior.unfinished === fields.unfinished &&
      prior.protectionRevision === fields.protectionRevision &&
      prior.protection === fields.protection
    )
      return prior;
    const agent: Agent = Object.freeze({
      ...fields,
      // One not run here is keyed by its pubkey alone.
      key: fields.pubkey,
      attention: EMPTY,
      skipped: EMPTY,
      timers: EMPTY,
      attentionEnabled: false,
      config: undefined,
    });
    this.shown.set(fields.pubkey, agent);
    return agent;
  }

  /** Changes one agent's record. This is the only way a record changes:
   * owner settings, the agent's attention tools, timer progress, a provider
   * change and removal all send a change here. One agent's changes run in
   * the order they are sent, each after the one before it is saved or has
   * failed, so each one applies to the newest saved record, never to a copy
   * another change replaces. `apply` gets that record (or undefined) and
   * returns the next one, or null to remove it; it may throw to change
   * nothing. The owner and the agent see a change once it is saved, and the
   * promise settles then. When the save fails, the promise rejects and they
   * keep the saved record, so a form keeps its unsaved changes. `saved`
   * runs as the change is shown, before anyone is told. */
  private change(
    key: AgentKey,
    apply: (
      record: AgentRecord | undefined,
    ) => AgentRecord | null | Promise<AgentRecord | null>,
    saved?: (record: AgentRecord | null) => void,
  ): Promise<AgentRecord | null> {
    this.changing.set(key, (this.changing.get(key) ?? 0) + 1);
    return this.queued(key, async () => {
      try {
        const base = this.records[key];
        const next = await apply(base);
        await this.commit(key, base, next);
        saved?.(next);
        this.update();
        return next;
      } finally {
        const left = (this.changing.get(key) ?? 1) - 1;
        if (left) this.changing.set(key, left);
        else {
          this.changing.delete(key);
          // Its timers waited for this change, saved or failed.
          this.runners.wake(key);
        }
      }
    });
  }
  /** Records that timers ran or started counting, as a change to their run
   * state only. It applies to whatever the record is when its turn comes, so
   * it never undoes a change sent before it: when a timer was rearmed or
   * restarted meanwhile, its new deadline stays and only the occurrences it
   * used are added. Timers see it at once (`timersOf`), and memory keeps it
   * even when its save fails, so a timer does not run again at once. */
  private progress(key: AgentKey, ran: TimerProgress) {
    const pending = this.progressing.get(key) ?? [];
    this.progressing.set(key, [...pending, ran]);
    void this.queued(key, async () => {
      try {
        const base = this.records[key];
        const next = base && withProgress(base, ran);
        if (!base || !next) return;
        await this.commit(key, base, next).catch((error) => {
          console.warn(`Agent ${key} timer state was not saved`, error);
          this.records = { ...this.records, [key]: next };
        });
        this.update();
      } finally {
        const left = (this.progressing.get(key) ?? []).filter(
          (entry) => entry !== ran,
        );
        if (left.length) this.progressing.set(key, left);
        else this.progressing.delete(key);
      }
    });
  }
  /** Runs `step` after the agent's earlier changes have settled. */
  private queued<T>(key: AgentKey, step: () => Promise<T>) {
    const run = (this.changes.get(key) ?? Promise.resolve()).then(step);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.changes.set(key, tail);
    void tail.then(() => {
      if (this.changes.get(key) === tail) this.changes.delete(key);
    });
    return run;
  }
  /** Saves `next` over `base` in the membership's own key, then keeps it.
   * Only this key: others may be another program's to change. A record
   * other than the agent's home record keeps no config, which is the
   * agent's, never one community's. */
  private async commit(
    key: AgentKey,
    base: AgentRecord | undefined,
    given: AgentRecord | null,
  ) {
    if (given === base) return;
    const next = given && key !== pubkeyOf(key) ? ownRecord(key, given) : given;
    if (next) await writeRecord(this.storage, next);
    else {
      if (this.storage.get(recordKey(key)) !== null)
        await removeRecord(this.storage, key);
      await removeSessionPrompts(this.storage, key);
    }
    const { [key]: _, ...others } = this.records;
    this.records = next ? { ...others, [key]: next } : others;
  }
  /** The agent's timers' run state as its timers go by: saved, with the
   * progress still being saved. */
  private timersOf(key: AgentKey) {
    const record = this.records[key];
    const pending = this.progressing.get(key);
    if (!record || !pending) return record?.timers ?? EMPTY;
    return (
      pending.reduce((next, ran) => withProgress(next, ran) ?? next, record)
        .timers ?? EMPTY
    );
  }
  /** The agent's memberships, or every agent's, that were not deleted. */
  private liveRows(pubkey?: string) {
    return this.identities.filter(
      (identity) =>
        !identity.deleted &&
        (pubkey === undefined || identity.pubkey === pubkey),
    );
  }
  /** The agents a team in `origin` can have: its agents here, and its hosted
   * ones whose setup finished. */
  private teamAgents(origin: string) {
    return [
      ...this.liveRows().filter(
        (identity) => originOf(identity.relay) === origin,
      ),
      ...this.listedAgents(origin).filter(
        (agent) => agent.place === "hosted" && !agent.unfinished,
      ),
    ];
  }
  /** Who rosters in `origin` name: the agents a team there can have. Until
   * its agent records are read, which tell a hosted agent from one on another
   * device, a synced team homed there names its other members by npub. */
  private teammates(origin: string) {
    const agents = this.teamAgents(origin);
    if (this.listings.has(origin)) return agents;
    const known = new Set(
      [...this.identities, ...this.listedAgents(origin)].map(
        (agent) => agent.pubkey,
      ),
    );
    const unnamed = new Set(
      this.synced().flatMap(({ community, team }) =>
        community === origin
          ? team.members.filter((pubkey) => !known.has(pubkey))
          : [],
      ),
    );
    return [...agents, ...[...unnamed].map((pubkey) => ({ pubkey }))];
  }
  /** The membership of this key, unless it was deleted. */
  private liveMember(key: AgentKey) {
    return this.identities.find(
      (identity) => identity.key === key && !identity.deleted,
    );
  }
  /** Each row as a membership, with its key. */
  private withKeys(rows: readonly AgentIdentity[]): readonly Member[] {
    return rows.map((row) =>
      Object.freeze({
        ...row,
        key: agentKey(
          row.pubkey,
          originOf(row.relay) ?? row.relay,
          homeOf(row),
        ),
      }),
    );
  }
  /** The agent's home record, which keeps its config: as saved or, without
   * one, its type's defaults, kept in memory until a save stores them.
   * Without its type there are no defaults yet. */
  private settingsOf({ pubkey, type }: Pick<AgentIdentity, "pubkey" | "type">) {
    const kind = this.types().find((entry) => entry.key === type);
    if (!this.records[pubkey] && kind)
      try {
        this.records = { ...this.records, [pubkey]: defaults(pubkey, kind) };
      } catch (error) {
        console.warn(`Agent type ${type} has invalid defaults`, error);
      }
    return this.records[pubkey] ?? blank(pubkey);
  }
  /** The membership's settings as its owner and agent see them: its own
   * attention, starting with none, and the agent's config. */
  private recordOf(member: Member): AgentRecord {
    const settings = this.settingsOf(member);
    if (member.key === member.pubkey) return settings;
    const own = this.records[member.key] ?? blank(member.key);
    return { ...own, config: settings.config };
  }
  private retypePlan(
    identity: AgentIdentity,
    source: RegisteredAgentType | undefined,
    kind: RegisteredAgentType,
  ) {
    const saved = this.settingsOf(identity);
    // Its synced fields are its config's, not the local copy's.
    const record = {
      ...saved,
      config:
        this.editorConfig(identity, saved.config as object)?.config ??
        saved.config,
    };
    const carry = source?.carry?.(record.config) ?? {};
    const { config } = kind.defaults();
    const adopted = kind.adopt ? kind.adopt(carry, config) : config;
    const kept = kind.carry?.(adopted) ?? {};
    const keys = (Object.keys(carry) as (keyof Carry)[]).filter(
      (key) => carry[key] !== undefined,
    );
    const moved = keys.filter((key) => kept[key] === carry[key]);
    const dropped = keys.filter((key) => kept[key] !== carry[key]);
    const destinationSettings = new Map(
      kind.describeMigration?.(adopted).map((setting) => [setting.id, setting]),
    );
    const settings =
      source
        ?.describeMigration?.(record.config)
        .filter((setting) => setting.isOverride)
        .flatMap((setting) => {
          const next = destinationSettings.get(setting.id);
          if (
            next &&
            setting.unchangedKey !== undefined &&
            setting.unchangedKey === next.unchangedKey
          )
            return [];
          return [
            {
              id: setting.id,
              label: setting.label,
              outcome: next ? ("reset" as const) : ("dropped" as const),
            },
          ];
        }) ?? [];
    return {
      record,
      adopted,
      preview: {
        config: adopted,
        moved,
        dropped,
        settings,
      },
    };
  }
  private view(identity: Member, record: AgentRecord): Agent {
    const editor = this.editorConfig(identity, record.config as object);
    return Object.freeze({
      key: identity.key,
      pubkey: identity.pubkey,
      name: identity.name,
      ...(identity.picture && { picture: identity.picture }),
      type: identity.type,
      owner: identity.owner,
      relay: identity.relay,
      place: "here",
      ...(identity.protection ? { protection: identity.protection } : {}),
      protectionRevision: identity.protectionRevision ?? 0,
      attention: record.attention,
      skipped: record.skipped ?? EMPTY,
      timers: record.timers ?? EMPTY,
      ...(record.sourceRuns ? { sourceRuns: record.sourceRuns } : {}),
      attentionHistory: record.attentionHistory,
      attentionEnabled:
        record.attentionEnabled === true && this.attentionShown(),
      config: editor?.config ?? record.config,
      ...(editor && { configBase: editor.base }),
      ...(editor?.problem && { configProblem: editor.problem }),
      ...(this.archiveUnchecked(identity.key) && { archiveUnchecked: true }),
      ...(identity.deleting && { deleting: true }),
    });
  }
  /** What the agent starts with: its row, with each synced side's confirmed
   * copy over it. */
  /** The community whose config channel holds the agent's config: its home,
   * as every membership's row saved it, since that config applies in each
   * community it is in. Its other communities never discover, create or bind
   * one, so an Add can't split its config. */
  private configHome(agent: Pick<Agent, "pubkey" | "relay">) {
    const row = this.identities.find(
      (member) => member.pubkey === agent.pubkey,
    );
    return row ? homeOf(row) : (originOf(agent.relay) ?? "");
  }
  /** Whether the agent is still a member of its home community. */
  private homeRemains(pubkey: string) {
    return this.liveRows(pubkey).some((row) => row.key === pubkey);
  }
  /** Which config sides the agent has synced: its home community's binding. */
  private configBinding(
    agent: Pick<Agent, "pubkey" | "relay" | "owner">,
  ): ConfigBinding {
    const community = this.configHome(agent);
    const bound =
      this.bindingFor?.(agent as Agent) ??
      this.communityConfigs.get(community)?.binding(agent.pubkey) ??
      {};
    // A side once bound, or with a synced revision here, stays synced while
    // no channel is bound to it — after a restart, an archive, a channel
    // handover or with its home disconnected — so it starts from the copy
    // confirmed in its last channel, or blocks, never from the local row.
    const held = (side: Side) => {
      const unbound: Subject = {
        owner: agent.owner,
        community,
        subject: agent.pubkey,
        channel: "",
        type: SIDE_TYPE[side],
      };
      const channel = this.configStore.boundChannel(unbound);
      return channel !== undefined || this.configStore.hadVersion(unbound)
        ? {
            mode: "synced" as const,
            subject: { ...unbound, channel: channel ?? "" },
          }
        : undefined;
    };
    return Object.fromEntries(
      SIDES.flatMap((side) => {
        const entry = bound[side] ?? held(side);
        return entry ? [[side, entry]] : [];
      }),
    );
  }
  private resolve(
    agent: Pick<Agent, "pubkey" | "relay" | "type" | "owner">,
    local: unknown,
  ) {
    const binding = this.configBinding(agent);
    const { settings, instructions } = binding;
    // Its config syncs only through its home membership: without one, no
    // channel keeps the confirmed copy current.
    if (Object.keys(binding).length && !this.homeRemains(agent.pubkey))
      return {
        ok: false as const,
        state: "unavailable" as const,
        reason: "This agent left the community that keeps its config",
      };
    const merge = this.types().find(
      (type) => type.key === agent.type,
    )?.syncedSettings;
    if (!merge && isSynced(this.configStore, settings))
      return {
        ok: false as const,
        state: "invalid" as const,
        reason: "This agent type has no synced settings",
      };
    return resolveStart({
      store: this.configStore,
      local: local as object,
      agentType: agent.type,
      ...(settings && merge
        ? {
            settings: {
              ...settings,
              schema: merge.schema,
              withSynced: merge.withSynced as (
                config: object,
                synced: Readonly<Record<string, string>>,
              ) => object,
            },
          }
        : {}),
      ...(instructions ? { instructions } : {}),
      teams: teamSources(this.syncedTeams, agent.owner, agent.pubkey),
    });
  }
  /** For an agent whose config syncs: its row with each synced side's
   * confirmed copy, as editors show it and running agents use it, and those
   * heads as the base a Save revises. Undefined while every side is local. */
  private editorConfig(identity: AgentIdentity, local: object) {
    const binding = this.configBinding(identity);
    const sides = SIDES.filter((side) =>
      isSynced(this.configStore, binding[side]),
    );
    if (!sides.length) return undefined;
    const base: ConfigBase = Object.fromEntries(
      sides.map((side) => {
        const subject = binding[side]?.subject;
        return [
          side,
          (subject && this.configStore.state(subject).head?.id) ?? null,
        ];
      }),
    );
    const resolved = this.resolve(identity, local);
    if (resolved.ok)
      return { config: resolved.config, base: Object.freeze(base) };
    // Without a usable confirmed copy, a synced side's local field is stale:
    // the editor shows the problem instead of it.
    const schema = this.configAgent(identity, local).schema ?? {};
    const stale = new Set(
      sides.flatMap((side) =>
        side === "instructions" ? ["instructions"] : Object.keys(schema),
      ),
    );
    return {
      config: Object.fromEntries(
        Object.entries(local).filter(([name]) => !stale.has(name)),
      ),
      base: Object.freeze(base),
      problem: resolved.reason,
    };
  }
  private configAgent(
    agent: Pick<Agent, "pubkey" | "name" | "type">,
    config: object,
  ): ConfigAgent {
    return {
      pubkey: agent.pubkey,
      name: agent.name,
      type: agent.type,
      config,
      schema: this.types().find((type) => type.key === agent.type)
        ?.syncedSettings?.schema,
    };
  }
  private archiveUnchecked(pubkey: string) {
    return this.unarchiving.has(pubkey) || undefined;
  }
  /** The live binding of the agent's community, if it has one now. */
  private bindingOf({ relay, owner }: Pick<AgentIdentity, "relay" | "owner">) {
    const origin = originOf(relay);
    const binding = origin ? this.bound.get(origin)?.binding : undefined;
    return binding?.scope === relayPartition(origin ?? "", owner)
      ? binding
      : undefined;
  }
  /** Whether the agent stays running: it is the viewer's, and its community is
   * joined and not disconnected. A reconnect does not stop it. */
  private alive({ relay, owner }: AgentIdentity) {
    const origin = originOf(relay);
    const entry = origin ? this.bound.get(origin) : undefined;
    return (
      owner === this.communities.snapshot().viewer &&
      !!entry &&
      entry.relay.snapshot().status !== "disconnected"
    );
  }
  /** A running agent, in any community. */
  private agent(key: AgentKey) {
    return this.state.running.find((agent) => agent.key === key);
  }
  /** The agent, while its community's session is live to run it in. */
  private ready(key: AgentKey) {
    const agent = this.agent(key);
    return agent && this.bindingOf(agent) ? agent : undefined;
  }

  /** Reads the agent list from native. Every change is made there first and
   * then read back here, so the list has one source; Retry reads it again. */
  async refresh() {
    if (!this.native) return;
    const turn = ++this.listed;
    try {
      const rows = await this.native.list();
      // A newer list is on its way; this one may predate a change.
      if (turn !== this.listed) return;
      // One still joining, or a Join a crash cut short, is no membership.
      const identities = this.withKeys(rows.filter((row) => !row.joining));
      this.identities = identities;
      // A read that succeeds ends the failure the last one reported.
      const { error: _, ...state } = this.state;
      this.state = Object.freeze({ ...state, status: "ready" });
      // Settings whose agent is gone, or that a community it left kept, do
      // nothing. Its home record keeps its config while it is anywhere.
      const live = new Set(
        identities
          .filter((saved) => !saved.deleted)
          .flatMap((saved) => [saved.key, saved.pubkey]),
      );
      const gone = Object.keys(this.records).filter((key) => !live.has(key));
      for (const key of gone)
        void this.change(key, () => null).catch((error) =>
          console.warn(`Agent ${key} settings were not removed`, error),
        );
      // Nor do change requests, which would hold review slots unseen.
      this.updates = this.updates.filter((request) => live.has(request.agent));
      // A deleted agent leaves its teams; the teams stay.
      if (
        this.teamList.some((team) =>
          team.members.some((pubkey) => !live.has(pubkey)),
        )
      )
        void this.writeTeams(
          this.teamList.map((team) => ({
            ...team,
            members: team.members.filter((pubkey) => live.has(pubkey)),
          })),
        ).catch((error) => console.warn("Agent teams were not saved", error));
    } catch (error) {
      if (turn !== this.listed) return;
      this.state = Object.freeze({
        ...this.state,
        status: "error",
        error: message(error),
      });
    }
    this.watch();
    this.update();
    this.notify();
    this.sync();
  }

  /** Brings the relay in line with the saved identities: publishes each name
   * its community lacks, and finishes Delete where connected. Each step
   * is safe to repeat; what fails is tried again on the next refresh or connect. */
  private sync() {
    for (const [origin, { binding }] of this.bound) {
      if (!binding) continue;
      if (this.listings.has(origin)) this.list(origin, binding);
      else void this.readListings(origin, binding);
    }
    const native = this.native;
    for (const identity of this.identities)
      if (!identity.deleted)
        native
          ?.publishProfile(identity)
          .catch((error) =>
            console.warn(
              `Agent ${identity.name} profile was not published`,
              error,
            ),
          );
      else {
        const binding = this.bindingOf(identity);
        if (binding) this.cleanup(identity, binding);
      }
  }
  /** Starts the cleanup of a membership deleted under the old order, or
   * whose Delete or Remove stopped short of dropping it, unless one is
   * running or a re-import or add is taking it back. Its key there is gone,
   * so it can be imported or added again, and nothing tells whether someone
   * added it back to a channel since: it only drops the record and the row. */
  private cleanup(member: Member, binding: Binding) {
    const { key } = member;
    if (
      this.reclaiming.has(key) ||
      this.reclaiming.has(member.pubkey) ||
      this.cleaning.has(key)
    )
      return;
    const stop = new AbortController();
    const done = this.clean(member, binding, stop.signal).finally(() =>
      this.cleaning.delete(key),
    );
    this.cleaning.set(key, { stop, done });
  }
  /** Stops running cleanups before a re-import or add takes a membership
   * back, `target` naming it by key, or every one of an agent by its pubkey,
   * and keeps new ones from starting until the import or add ends. Resolves
   * once every write they started has settled; none starts after the stop. */
  private async reclaim(target: string) {
    this.reclaiming.add(target);
    const running = [...this.cleaning].filter(
      ([key]) => key === target || pubkeyOf(key) === target,
    );
    for (const [, cleanup] of running)
      cleanup.stop.abort(new Error("The agent was taken back"));
    await Promise.all(running.map(([, cleanup]) => cleanup.done));
  }
  /** Deletes a deleted membership's record, then drops its row. A re-import's
   * stop holds through signing, while a publish already started settles, so
   * the deletion never lands on the record of an agent taken back. */
  private async clean(member: Member, binding: Binding, stopped: AbortSignal) {
    const { pubkey, relay } = member;
    const signal = AbortSignal.any([
      binding.controller.signal,
      AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
    ]);
    const fence = AbortSignal.any([signal, stopped]);
    const stillDeleted = async () => {
      const saved = (await this.native?.list())?.filter(
        (identity) => identity.pubkey === pubkey && identity.relay === relay,
      );
      fence.throwIfAborted();
      if (!saved?.length || saved.some((identity) => !identity.deleted))
        throw new Error("The agent was taken back");
    };
    try {
      await stillDeleted();
      await deleteAgentRecord(
        binding.session,
        binding.viewer,
        pubkey,
        signal,
        stopped,
      );
      this.unlist(originOf(relay) ?? "", pubkey);
      await this.native?.forget(member);
      await this.refresh();
    } catch (error) {
      if (!fence.aborted) console.warn("Deleted agent cleanup stopped", error);
    }
  }

  /** Connects the selected community, where agents are made, and each one
   * the viewer has an agent in, deleted ones included so their cleanup can
   * finish; lets go of the rest. */
  private watch() {
    const { viewer, selected } = this.communities.snapshot();
    const origins = new Set<string>();
    const shown = viewer && originOf(selected ?? "");
    if (shown) origins.add(shown);
    for (const identity of this.identities) {
      const origin = identity.owner === viewer && originOf(identity.relay);
      if (!origin) continue;
      origins.add(origin);
      // Its home keeps its config, which its Delete archives even after it
      // left there.
      origins.add(homeOf(identity));
    }
    // Left, or left and joined again with a new session.
    for (const [origin, entry] of this.bound)
      if (!origins.has(origin) || this.communities.open(origin) !== entry.relay)
        this.unbind(origin);
    for (const origin of origins) {
      if (this.bound.has(origin)) continue;
      const relay = this.communities.open(origin);
      if (!relay) continue;
      this.bound.set(origin, {
        relay,
        stop: relay.subscribe(() => this.bind(origin)),
      });
      this.bind(origin);
    }
  }
  /** Tries each unselected community whose connection failed again, since
   * nobody is there to press its Retry; its agents wait on it. Checks config
   * support again where its check failed. */
  private reconnect() {
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const now = Date.now();
    for (const [origin, entry] of this.bound)
      if (
        origin !== selected &&
        entry.relay.snapshot().status === "error" &&
        now - (entry.retried ?? 0) >= RETRY_MS
      ) {
        entry.retried = now;
        entry.relay.retry();
      }
    for (const [origin, { binding }] of this.bound)
      if (
        typeof binding?.support === "object" &&
        now - binding.support.failed >= RETRY_MS
      )
        void this.startConfig(origin, binding);
  }
  private unbind(origin: string) {
    const entry = this.bound.get(origin);
    this.bound.delete(origin);
    this.listings.delete(origin);
    this.edits.delete(origin);
    entry?.stop();
    entry?.binding?.stopLive();
    entry?.binding?.attending?.stop();
    entry?.binding?.controller.abort();
    this.communityConfigs.get(origin)?.dispose();
    this.communityConfigs.delete(origin);
  }
  private bind(origin: string) {
    const entry = this.bound.get(origin);
    if (!entry) return;
    const snapshot = entry.relay.snapshot();
    const live =
      snapshot.status === "ready" &&
      !snapshot.cached &&
      snapshot.scope &&
      snapshot.origin &&
      snapshot.viewer
        ? {
            scope: snapshot.scope,
            origin: snapshot.origin,
            viewer: snapshot.viewer,
            session: snapshot.session,
            controller: new AbortController(),
          }
        : undefined;
    const changed =
      entry.binding?.session !== live?.session ||
      entry.binding?.scope !== live?.scope;
    if (changed) {
      entry.binding?.stopLive();
      entry.binding?.attending?.stop();
      entry.binding?.controller.abort();
      this.listings.delete(origin);
      this.edits.delete(origin);
      this.communityConfigs.get(origin)?.dispose();
      this.communityConfigs.delete(origin);
      const connection: Connection = {
        epoch: 0,
        start: Math.floor(Date.now() / 1000),
      };
      entry.binding = live && {
        ...live,
        connection,
        stopLive: this.listen(live.session, origin, connection),
      };
    }
    // Disconnecting stops its agents even when no binding changed.
    this.update();
    // Its sync reads the community's agent records too.
    if (changed && entry.binding) {
      this.sync();
      this.refreshCore(origin);
      void this.startConfig(origin, entry.binding);
    }
  }

  /** Brings up the community's config channels when config sync is on and
   * its relay passes the support check; a replaced binding drops it. */
  private async startConfig(origin: string, binding: Binding) {
    binding.support = "checking";
    const config = await communityConfig(
      {
        session: binding.session,
        owner: binding.viewer,
        community: origin,
        store: this.configStore,
        teams: this.syncedTeams,
        info: (signal) => nativeRelayInfo(origin, signal),
        changed: () => {
          this.teamsChanged();
          this.update();
        },
      },
      binding.controller.signal,
    ).catch(() => undefined);
    if (this.bound.get(origin)?.binding !== binding) return config?.dispose();
    if (!config) {
      binding.support =
        config === null ? "unsupported" : { failed: Date.now() };
      return;
    }
    delete binding.support;
    this.communityConfigs.set(origin, config);
    this.update();
  }

  /** Delivers the session's live events, and retries what failed whenever its
   * connection recovers, which happens within the same session. A subscription
   * that comes back, after a reconnect or a failed route, first sends its
   * recent history again: what in it is new since this listener started was
   * missed while it was down, and is delivered now (`seen` drops the rest).
   * Older history is catch-up's, not replay's. */
  private listen(
    session: RelaySession,
    origin: string,
    connection: Connection,
  ) {
    let connected = session.live.snapshot().status === "connected";
    const since = connection.start;
    if (connected) Object.assign(connection, { epoch: 1, since });
    const heard = (agent: Agent) => originOf(agent.relay) === origin;
    const stopEvents = session.subscribeLive(
      (batch) => this.runners.dispatch(batch, heard, since),
      { replay: true },
    );
    const stopStatus = session.live.subscribe(() => {
      const now = session.live.snapshot().status === "connected";
      if (now !== connected) {
        // Catch-up reads what this connect may have missed, up to now.
        connection.epoch += now ? 1 : 0;
        connection.since = now ? Math.floor(Date.now() / 1000) : undefined;
      }
      if (now && !connected) {
        this.sync();
        this.refreshCore(origin);
      }
      connected = now;
      this.runners.catchUp(false);
    });
    // A roster the relay confirms decides the events held for it.
    const stopRosters = session.channels.subscribeList?.(() =>
      this.runners.releaseHeld(heard),
    );
    return () => {
      stopEvents();
      stopStatus();
      stopRosters?.();
    };
  }

  /** Refreshes the cached `core` memory of each agent running in the
   * community, which may have changed elsewhere while it was not connected. */
  private refreshCore(origin: string) {
    for (const agent of this.state.running)
      if (originOf(agent.relay) === origin)
        void this.coreMemory.refresh(agent.key);
  }

  // Joins identities, records and the connections into the running and visible
  // agents, and keeps one runner per saved agent. Runners outlive edits and
  // reconnects; one is retired only when its agent is deleted or its Remove
  // starts, and its run is aborted when the agent's type is replaced.
  private update() {
    const identities = this.identities.filter((identity) => !identity.deleted);
    const alive: Agent[] = [];
    for (const identity of identities) {
      if (!this.alive(identity)) continue;
      const record = this.recordOf(identity);
      // Reuse the frozen agent while nothing visible changed, so subscribers see
      // a stable snapshot.
      const prior =
        this.agent(identity.key) ??
        this.state.agents.find(
          (agent) => agent.key === identity.key && agent.deleting,
        );
      const editor = this.editorConfig(identity, record.config as object);
      if (identity.key === identity.pubkey) this.followType(identity);
      alive.push(
        prior &&
          prior.name === identity.name &&
          prior.picture === identity.picture &&
          prior.type === identity.type &&
          prior.protectionRevision === (identity.protectionRevision ?? 0) &&
          prior.attention === record.attention &&
          prior.skipped === (record.skipped ?? EMPTY) &&
          prior.timers === (record.timers ?? EMPTY) &&
          prior.sourceRuns === record.sourceRuns &&
          prior.attentionHistory === record.attentionHistory &&
          prior.attentionEnabled ===
            (record.attentionEnabled === true && this.attentionShown()) &&
          sameConfig(prior, editor?.config ?? record.config, editor?.base) &&
          prior.configProblem === editor?.problem &&
          prior.archiveUnchecked === this.archiveUnchecked(identity.key) &&
          prior.deleting === identity.deleting
          ? prior
          : this.view(identity, record),
      );
    }
    // An unfinished Delete or Remove stays listed, but nothing runs it: its
    // types' plugins stop what they keep for it.
    const running = alive.filter((agent) => !agent.deleting);
    const selected = originOf(this.communities.snapshot().selected ?? "");
    const agents = [
      ...alive.filter(
        (agent) => originOf(agent.relay) === selected && this.bindingOf(agent),
      ),
      ...this.listedAgents(selected),
    ];
    this.runners.reconcile(
      identities
        .filter((identity) => !identity.deleting)
        .map(({ key, pubkey, relay, type, owner, protectionRevision }) => ({
          key,
          pubkey,
          relay,
          type,
          protectionRevision,
          scope: relayPartition(originOf(relay) ?? relay, owner),
        })),
      new Map(this.types().map((type) => [type.key, type])),
    );
    const left = this.runners.interrupted();
    // Only the copy that holds an agent may resume or forget its turns.
    const interrupted = running.filter(
      (agent) => left.has(agent.key) && this.runners.runs(agent.key),
    );
    const same = (next: readonly Agent[], prior: readonly Agent[]) =>
      next.length === prior.length &&
      next.every((agent, index) => agent === prior[index]);
    const syncsTeams = !!selected && this.communityConfigs.has(selected);
    if (
      !same(agents, this.state.agents) ||
      !same(running, this.state.running) ||
      !same(interrupted, this.state.interrupted) ||
      syncsTeams !== !!this.state.syncsTeams
    ) {
      this.state = Object.freeze({
        ...this.state,
        agents: Object.freeze(agents),
        running: Object.freeze(running),
        interrupted: Object.freeze(interrupted),
        syncsTeams,
      });
      this.notify();
    }
    this.runners.resume(
      new Set(
        running.filter((agent) => this.bindingOf(agent)).map((a) => a.key),
      ),
    );
    this.announce();
    this.runners.catchUp(false);
    this.attend(running);
    for (const [origin, config] of this.communityConfigs)
      void config.attach(
        running
          .filter(
            (agent) =>
              agent.key === agent.pubkey &&
              this.configHome(agent) === origin &&
              !this.retyping.has(agent.pubkey),
          )
          .map((agent) =>
            this.configAgent(
              agent,
              (this.records[agent.pubkey] ?? agent).config as object,
            ),
          ),
      );
  }

  /** Keeps live, in each community, the channels that the enabled watches
   * of the agents this copy runs name, so a watch also hears a public channel
   * the owner has not joined. A watch of "all" hears what the session already
   * listens to. A copy that does not hold an agent leaves its channels out. */
  private attend(running: readonly Agent[]) {
    const wanted = new Map<Binding, Set<string>>();
    for (const { binding } of this.bound.values())
      if (binding) wanted.set(binding, new Set());
    for (const agent of running) {
      const channels = this.bindingOf(agent);
      const ids = channels && wanted.get(channels);
      if (!ids || !agent.attentionEnabled || !this.runners.runs(agent.key))
        continue;
      for (const { value } of Object.values(agent.attention))
        if (value.type === "event" && value.enabled && value.channels !== "all")
          for (const id of value.channels) ids.add(id);
    }
    for (const [binding, ids] of wanted) {
      const key = JSON.stringify([...ids].sort());
      if (binding.attending?.key === key) continue;
      // The new set goes in before the old one goes out, so a channel in
      // both keeps its live route.
      const previous = binding.attending;
      if (ids.size)
        binding.attending = { key, stop: binding.session.attend([...ids]) };
      else delete binding.attending;
      previous?.stop();
    }
  }

  /** Tells each community which agents this copy runs there: online every
   * minute while it does, and offline once it stops, unless another copy took
   * over. Offline is best effort; the relay lets a lapsed online expire. */
  private announce() {
    const online = new Map<string, Set<string>>();
    for (const agent of this.state.running) {
      const origin = originOf(agent.relay);
      if (origin && this.bindingOf(agent) && this.runners.runs(agent.key))
        online.set(origin, (online.get(origin) ?? new Set()).add(agent.pubkey));
    }
    for (const origin of this.presence.keys())
      if (!this.bound.has(origin)) this.presence.delete(origin);
    const now = Date.now();
    for (const [origin, entry] of this.bound) {
      const binding = entry.binding;
      if (!binding || this.announcing.has(origin)) continue;
      const next = online.get(origin) ?? new Set<string>();
      const prior = this.presence.get(origin);
      const same = prior?.session === binding.session;
      if (same && prior.unable) continue;
      // Another copy that took an agent over says it is online; offline from
      // this one could arrive after that, so forget it was online here.
      // Each pubkey said online here is one membership's, the one here.
      const keyOf = (pubkey: string) =>
        this.identities.find(
          (identity) =>
            identity.pubkey === pubkey &&
            !identity.deleted &&
            originOf(identity.relay) === origin,
        )?.key;
      const was = new Set(
        [...(prior?.online ?? [])].filter((pubkey) => {
          const key = keyOf(pubkey);
          return next.has(pubkey) || !key || !this.runners.yielded(key);
        }),
      );
      if (prior && was.size < prior.online.size)
        this.presence.set(origin, { ...prior, online: was });
      const gone = [...was].filter((pubkey) => !next.has(pubkey));
      const due = !same || now - prior.at >= PRESENCE_MS;
      const changed =
        gone.length > 0 || [...next].some((pubkey) => !was.has(pubkey));
      if (!changed && (!due || !next.size)) continue;
      this.announcing.add(origin);
      const sent = { session: binding.session, online: next, at: now };
      this.presence.set(origin, sent);
      void (async () => {
        for (const [status, agents] of [
          ["offline", gone],
          ["online", [...next]],
        ] as const)
          for (let at = 0; at < agents.length; at += PRESENCE_BATCH)
            if (
              !(await binding.session.publishAgentPresence(
                status,
                agents.slice(at, at + PRESENCE_BATCH),
                binding.controller.signal,
              ))
            )
              return false;
        return true;
      })()
        .then((ok) => {
          if (ok || this.presence.get(origin) !== sent) return;
          console.warn("Agent presence cannot be sent on this connection");
          this.presence.set(origin, { ...sent, unable: true });
        })
        .catch((error) => {
          if (binding.controller.signal.aborted) return;
          console.warn("Agent presence was not sent", error);
          // Try again sooner than the minute, but not every tick.
          if (this.presence.get(origin) === sent)
            this.presence.set(origin, {
              ...sent,
              at: Date.now() - PRESENCE_MS + RETRY_MS,
            });
        })
        .finally(() => this.announcing.delete(origin));
    }
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  /** The event's channel as the agent's community knows it, if at all. */
  private channelOf(agent: Agent, event: Pick<RelayEvent, "tags">) {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    const channels = this.bindingOf(agent)?.session.channels;
    if (!channel || !channels) return undefined;
    return (
      channels.list().channels.find((item) => item.id === channel) ??
      channels.get?.(channel)
    );
  }
  /** Whether the agent is in the event's channel, by its relay-signed roster.
   * An event with no channel, or whose roster is unknown, is in none. A
   * roster only loaded from disk decides nothing (undefined): the agent may
   * have been removed or added since it was saved, so the event waits until
   * the relay confirms it. */
  private member(
    agent: Agent,
    event: Pick<RelayEvent, "tags">,
  ): boolean | undefined {
    const summary = this.channelOf(agent, event);
    if (summary?.cached) return undefined;
    return !!summary?.members?.includes(agent.pubkey);
  }
  /** Whether the agent may read the event's channel: it is in it, or the
   * channel is public, as its relay-signed metadata says, and neither hidden
   * nor a DM, so the relay lets anyone read it. The stream is the owner's,
   * so a watch, even of "all", hears only what the agent itself could read.
   * For an agent not in the channel, metadata not yet read, or only loaded
   * from disk, decides nothing (undefined): the channel may have turned
   * public or private since. */
  private reads(
    agent: Agent,
    event: Pick<RelayEvent, "tags">,
  ): boolean | undefined {
    const member = this.member(agent, event);
    if (member !== false) return member;
    const summary = this.channelOf(agent, event);
    if (summary?.metadataCached || summary?.metadataPending) return undefined;
    return (
      summary?.visibility === "public" &&
      !summary.hidden &&
      summary.channelType !== "dm"
    );
  }
  /** Whether the event's channel is a DM of exactly the agent and one other,
   * by the same roster. A group DM, or one whose roster is unknown, is not. */
  private dm(agent: Agent, event: RelayEvent) {
    const summary = this.channelOf(agent, event);
    return (
      summary?.channelType === "dm" &&
      summary.members?.length === 2 &&
      summary.members.includes(agent.pubkey)
    );
  }
}

/** An old Buzz team's copy for one owner in one community (`scope`), the same
 * from every import. */
async function importedTeamId(team: OldTeam, scope: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${team.id}\n${scope}`),
  );
  return `beta-${bytesToHex(new Uint8Array(digest))}`;
}

/** As harness Delete does: leaves every channel, then archives the identity so
 * it drops out of member lists and mention suggestions. Rejects unless each is
 * confirmed. */
async function leaveCommunity(
  session: RelaySession,
  pubkey: string,
  signal: AbortSignal,
) {
  await removeAgentFromChannels(session, pubkey, signal);
  const { archives } = session;
  if (!archives.writable) return;
  // The archive cache is not live; this needs a read started now.
  await archives.ensure();
  await archives.refresh();
  signal.throwIfAborted();
  const state = archives.state(pubkey);
  // An unfinished read says nothing, least of all "not archived".
  if (state === "unknown") throw new Error("Archive state is unknown");
  // Without an owner-attested profile the agent is not in the directory, so
  // there is nothing to hide (and no consent path to archive it with).
  if (state === "not-archived" && (await archives.consent(pubkey, signal)))
    await archives.request("archive", pubkey, signal);
}
/** After a finished Delete, rereads the shared agent choices, superseding any
 * read begun before it, so their inventory no longer offers it; then forgets
 * it as the main agent so the next available one is saved in its place. */
async function handOnMainAgent(session: RelaySession, pubkey: string) {
  await session.agentChoices.refresh(true, { fresh: true });
  forgetDefaultAgent(pubkey);
  await clearDeletedDefaultAgent(session, session.scope, pubkey);
}
/** The membership's community, as its owner knows it. */
/** The origin of the agent's home community, as native saved it on the row:
 * the community it was first in, where its membership's key is its pubkey. */
function homeOf(row: Pick<AgentIdentity, "relay" | "home">) {
  const relay = row.home ?? row.relay;
  return originOf(relay) ?? relay;
}
/** A synced team change that stopped, as its owner reads it. */
function teamOutcome(result: TeamResult, name: (pubkey: string) => string) {
  const list = (pubkeys: readonly string[]) => pubkeys.map(name).join(", ");
  return [
    result.error,
    result.added.length && `Added ${list(result.added)}.`,
    result.removed.length && `Removed ${list(result.removed)}.`,
    result.failed && `Stopped at ${name(result.failed)}.`,
    result.skipped.length && `Not tried: ${list(result.skipped)}.`,
    result.uncertain
      ? "The last change had no answer and may still take effect; reopen the team to see where it stands."
      : (result.added.length || result.removed.length) &&
        "Reopen the team to continue.",
  ]
    .filter(Boolean)
    .join(" ");
}
function hostOf({ relay }: Pick<AgentIdentity, "relay">) {
  return originOf(relay) ? new URL(relay).host : relay;
}
function stillArchived(name: string) {
  return `${name} is still archived in this community, so it stays out of member lists and mentions there.`;
}
/** Unarchives an identity the owner may, as re-import does for one a Delete's
 * cleanup archived. False when it stays archived. */
async function unarchive(
  archives: RelaySession["archives"],
  pubkey: string,
): Promise<boolean> {
  // The archive cache is not live; this needs a read started now.
  await archives.ensure();
  await archives.refresh();
  // A community without archives cannot have archived it. A session closed
  // meanwhile reads as "unknown" below, never as nothing to unarchive.
  if (!archives.supported) return true;
  const state = archives.state(pubkey);
  if (state === "not-archived") return true;
  // An unfinished read says nothing, least of all "not archived".
  if (state === "unknown") throw new Error("Archive state is unknown");
  const signal = AbortSignal.timeout(20_000);
  if (!archives.writable) return false;
  if (!(await archives.consent(pubkey, signal))) {
    // A session closed during the check also refuses; that settles nothing.
    if (archives.state(pubkey) === "unknown")
      throw new Error("Archive check was interrupted");
    return false;
  }
  await archives.request("unarchive", pubkey, signal);
  return true;
}

/** What a synced side's Save that didn't save tells the editor. */
function saveProblem(result: Saved) {
  switch (result.status) {
    case "conflict":
    case "superseded":
      return "This config changed elsewhere; your edit is kept. Reopen to see the current version.";
    case "accepted-unavailable":
      return "Saved, but the current version couldn't be read back.";
    case "unknown":
      return `It may or may not have saved: ${result.message}`;
    case "refused":
      return result.message;
    default:
      return "";
  }
}

/** The agent type a synced settings head is for. */
function settingsType(head: RelayEvent) {
  const { agentType } = headFields(head);
  return typeof agentType === "string" ? agentType : undefined;
}
/** Whether a running agent's view still shows `config` and `base`: a fresh
 * synced copy equal to the shown one keeps the view. */
const sameConfig = (prior: Agent, config: unknown, base?: ConfigBase) =>
  (prior.config === config ||
    JSON.stringify(prior.config) === JSON.stringify(config)) &&
  JSON.stringify(prior.configBase) === JSON.stringify(base);
