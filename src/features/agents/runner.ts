// The agent runner: one queue per agent, its rate limit, mention and watch
// matching, due timers, the run deadline and the claim that lets exactly one
// host run each agent. It knows nothing of where it runs: everything it needs
// of the device, community and storage comes through its RunnerHost, so the
// desktop app and a standalone host run agents with the same code.
import { bytesToHex } from "nostr-tools/utils";
import type { ProtectionAction } from "../agent-protection/service";
import type {
  Agent,
  AgentAttention,
  AgentHandle,
  AgentCreationInput,
  AgentUpdateInput,
  AgentHandoff,
  RegisteredAgentType,
  Trigger,
} from "./service";
import type { LocalAgentActivity, WorkOutcome } from "./local-activity";
import { threadReference } from "../relay/thread-reference";
import {
  hasEventProof,
  type ReadFilter,
  type RelayEvent,
} from "../relay/events";
import { wake, wakePrompt } from "../agent-harness/wakes";
import {
  type PluginTrigger,
  type ConversationWake,
  wakeAnchor,
  wakeLands,
} from "../agent-harness/plugin-wake";
import { STANDALONE_DEADLINE_MS } from "../agent-harness/standalone";
import { EFFORT_TAG, MODEL_TAG } from "../relay/messages";
import type { LiveBatch } from "../relay/incoming";
import { CHANNEL_KINDS, LIVE_REPLAY_LIMIT } from "../relay/live";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import {
  addressedTo,
  CHAT_KINDS,
  watchMatches,
  type AttentionObject,
  type AttentionValue,
  sourceCompleted,
  sourceSignature,
  timerSpent,
  timerState,
  type TimerState,
  type TimerWatch,
} from "./attention";
import {
  checkedWrite,
  interestIds,
  show,
  watchSummaries,
  type ClassifierAvailability,
  type WatchFilter,
  type WriteOptions,
} from "./attention-objects";
import {
  classify,
  notRun,
  type ClassifierContext,
  type ClassifierOutcome,
  type ClassifierInput,
} from "./classifier";
import type { Decisions } from "../decisions/service";
import type { EventWatch } from "./attention";
import {
  type AgentEventTemplate,
  type AgentsNative,
  type Membership,
  unconfirmedAgentEvent,
} from "./native";
import type { AgentKey } from "./membership";
import { setAttention, type AgentRecord, type TimerProgress } from "./store";
import type { Start } from "./agent-start";
import { type Pulses, pulseTyping } from "./typing";
import {
  admitted,
  CATCH_UP_PAGES,
  finished,
  heardOf,
  inStream,
  oldestFirst,
  POLL_OVERLAP,
  readWindow,
  streamKey,
  streamsOf,
  undelivered,
  type Checkpoint,
  type Stream,
} from "./catch-up";
import type { Interrupted } from "./interrupted";

/** Jobs waiting in each lane: mentions, and watch work (catch-up included),
 * so watches can never fill the room mentions need, as in Janet. */
const QUEUE_LIMIT = 32;
/** The longest run deadline an agent type may ask for. */
export const TIMEOUT_LIMIT_MS = 30 * 60_000;
/** Janet's lanes for attention work: an Interest's turns run one at a time,
 * in order, and at most this many Interests run at once, beside mentions. */
const INTEREST_LANES = 8;
/** Attention jobs one Interest can have waiting, of the QUEUE_LIMIT, as in
 * Janet, so one busy Interest cannot fill the queue. */
const INTEREST_LIMIT = 8;
/** The spec asks for at least the agent's 2,048 most recent events. */
const SEEN_LIMIT = 2_048;
/** Watched events each agent keeps while their channel's roster is only the one
 * saved on disk, until the relay confirms it. */
const HELD_LIMIT = 256;
/** Replayed events each agent keeps until it has room for them. A replay sends
 * minutes of traffic at once, which the queue and rate limit would otherwise
 * drop; past this, one is left unseen, so a later replay or catch-up can still
 * deliver it. */
const BACKLOG_LIMIT = 512;
/** Channels whose recent ids each agent keeps for replay dedup, the most
 * recently active first. */
const SEEN_CHANNELS = 128;
/** Runs per agent per minute in each lane; bounds two agents that answer
 * each other. */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;
/** How long catch-up waits for room in a full queue before it looks again. */
const CATCH_UP_WAIT_MS = 1_000;
/** Missed events one catch-up turn holds at most, and their most JSON
 * characters. The size is the bound that matters: 64 Ki characters is about
 * 16k–32k tokens of chat, well inside a model's context with the system
 * prompt. A lone larger event still goes; its turn shortens its text. */
const CATCH_UP_BATCH = 64;
const CATCH_UP_BATCH_CHARS = 64 * 1024;
/** Live events each watch keeps while it catches up, as Janet stages them. */
const WAITING_LIMIT = 512;
const WAITING_BYTES = 4 * 1024 * 1024;
/** How long a failed catch-up waits before it is tried again. */
const CATCH_UP_RETRY_MS = 30_000;
/** How often a stream live does not cover is read again, and how many
 * seconds that read stays behind now, for events the relay stores late. */
const CATCH_UP_POLL_MS = 30_000;
const CATCH_UP_POLL_LAG = 10;

/** Classifier calls in flight per agent. */
const CLASSIFY_LIMIT = 32;

const bounded = (set: Set<string>, id: string, limit = SEEN_LIMIT) => {
  set.add(id);
  if (set.size > limit) set.delete(set.values().next().value as string);
};

/** The model and effort the triggering message asks of this agent. Only the
 * owner picks them, so nobody else in a channel can run the agent at their
 * level, and only ones the type lists: effort from the model the run uses. */
async function pickFor(
  trigger: Trigger,
  agent: Agent,
  type: RegisteredAgentType,
): Promise<{ model?: string; effort?: string }> {
  if (
    (trigger.type !== "mention" && trigger.type !== "watch") ||
    trigger.event.pubkey !== agent.owner
  )
    return {};
  const asked = (name: string) =>
    trigger.event.tags.find(
      (tag) => tag[0] === name && tag[1] === agent.pubkey,
    )?.[2];
  const model = asked(MODEL_TAG);
  const effort = asked(EFFORT_TAG);
  if (!model && !effort) return {};
  try {
    const offered = await type.models?.(agent);
    const picked = offered?.models.find((item) => item.id === model);
    const runs =
      picked ?? offered?.models.find((item) => item.id === offered.current);
    return {
      ...(picked ? { model: picked.id } : {}),
      ...(effort && runs?.efforts.some((level) => level.id === effort)
        ? { effort }
        : {}),
    };
  } catch (error) {
    console.warn(`Agent type ${type.key} could not list its models`, error);
    return {};
  }
}

type Job = {
  work?: ReturnType<LocalAgentActivity["begin"]>;
  trigger: Trigger;
  channelId?: string;
  /** For a watch or timer: the object and attention epoch it was matched or
   * found due under. It runs only while both are still current, so a watch or
   * timer edited, disabled, rearmed, replaced or turned off and on again since
   * then does not run it. */
  matched?: { object: AttentionObject; epoch: number };
  sourceCurrent?: () => boolean;
};
type WatchTrigger = Extract<Trigger, { type: "watch" }>;
type CatchUpTrigger = Extract<Trigger, { type: "catch-up" }>;
type SourceTrigger = Extract<Trigger, { type: "source" }>;
/** Mentions and watch work queue and are rate limited apart; a plugin's wake
 * goes with mentions. */
type Lane = "mention" | "watch";
const addressed = (trigger: Trigger) =>
  trigger.type === "mention" ||
  trigger.type === "plugin" ||
  trigger.type === "attention";
const laneOf = (trigger: Trigger): Lane =>
  addressed(trigger) ? "mention" : "watch";
/** The Interest whose lane runs the attention job, or undefined for a mention. */
const interestOf = (trigger: Trigger) =>
  addressed(trigger)
    ? undefined
    : (trigger.type === "timer" ? trigger.timer : trigger.watch).interest_id;
/** Conversation delivery is independent of what produced the wake. */
function conversationWake(
  trigger: Trigger,
  text: string,
): ConversationWake | undefined {
  if (trigger.type === "plugin" || trigger.type === "attention") return trigger;
  const target =
    trigger.type === "timer"
      ? trigger.timer
      : !addressed(trigger)
        ? trigger.watch
        : undefined;
  if (!target?.channel) return;
  return {
    type: "attention",
    channel: target.channel,
    ...(target.root ? { root: target.root } : { topLevel: true }),
    text,
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    at: Date.now(),
  };
}
const channelOf = (event: RelayEvent) =>
  event.tags.find(([key]) => key === "h")?.[1];
/** The key of the catch-up stream that `trigger`'s event is in. */
const streamOf = (
  key: AgentKey,
  { watch, slug, event }: Pick<WatchTrigger, "watch" | "slug" | "event">,
) =>
  streamKey(key, slug, watch.channels === "all" ? undefined : channelOf(event));
/** Classifier calls a trigger's job makes before it queues. */
const classifications = (trigger: Trigger) =>
  trigger.type === "watch" && trigger.watch.classifier
    ? 1
    : trigger.type === "catch-up" && trigger.watch.classifier
      ? trigger.events.length
      : 0;
const sizeOf = (event: RelayEvent) => JSON.stringify(event).length;
type CompiledWatch = Omit<WatchTrigger, "type" | "event">;
type PendingEvent = {
  event: RelayEvent;
  channelId?: string;
  done?: ReadonlySet<string>;
};
type Heard = { triggers: Trigger[]; held?: true; discarded?: string[] };

/** One agent's runtime in one of its communities, for as long as it is a
 * member there. Edits do not replace it: each job reads the agent as it is
 * when the job starts, and the watches are recompiled only when its attention
 * changes. */
type Runner = {
  /** Its membership's key. */
  readonly key: AgentKey;
  /** The agent there, as custody signs and reads in that community. */
  readonly member: Membership;
  /** The partition its community's activity is kept under. */
  readonly scope: string;
  /** The registration whose `run` it calls; a new one aborts the in-flight run. */
  type: RegisteredAgentType | undefined;
  protectionRevision: number;
  controller: AbortController;
  /** Events waiting to run in each lane, mentions first; due timers are found
   * when a run starts instead. */
  readonly queues: Record<Lane, Job[]>;
  running: boolean;
  /** Each lane's runs in the current minute. */
  readonly rates: Record<Lane, { windowStart: number; admitted: number }>;
  /** Watches catching up now, whose live events wait in `waiting` until they
   * have, so the older events come first. */
  catching: ReadonlySet<string>;
  readonly waiting: Map<string, { jobs: Job[]; bytes: number }>;
  /** Watch jobs released from `waiting`, oldest first, going into the queue
   * as it has room. */
  readonly later: Job[];
  /** Events seen. */
  readonly seen: Set<string>;
  /** Events seen in each channel, as many as a reconnect replays of it, so
   * other channels' traffic cannot push out one a replay sends again. Only the
   * `SEEN_CHANNELS` most recently active channels are kept. */
  readonly seenIn: Map<string, Set<string>>;
  /** Replayed events waiting, oldest first, until the agent has room for the
   * jobs each makes. */
  readonly backlog: PendingEvent[];
  /** A missed event catch-up is still giving out, with delivered and rejected
   * matches retained while its other watches wait. */
  fanning?: { id: string; done: ReadonlySet<string> };
  /** Turns still counted as working, which a change of type waits out. */
  working: number;
  /** Its typing pulses, one per conversation it is working in. */
  readonly typing: Pulses;
  /** A provider/config transition owns the idle runner and pauses its queue. */
  transitioning: boolean;
  /** Watched events whose channel roster is not confirmed yet, by id: they are
   * matched again once it is (see `RunnerHost.member`). */
  readonly held: Map<string, PendingEvent>;
  /** Notes plugins left for its next turn, grouped by channel and targeted root. */
  readonly notes: Map<
    string,
    readonly { text: string; root: string | undefined }[]
  >;
  /** Whether native may hold the agent for this copy; true at first, since
   * native outlives a page reload. */
  mayHold: boolean;
  activityClaimed?: boolean;
  /** Advances each time attention is seen off, which voids queued watch work. */
  epoch: number;
  /** Whether a claim has been answered, so `mayHold` is known rather than
   * assumed. */
  asked?: boolean;
  /** Classified watch events not yet queued or dropped, against
   * CLASSIFY_LIMIT. */
  classifying: number;
  /** Classified jobs not yet queued or dropped, by the Interest they go to.
   * Each holds the queue, rate and Interest room it will take when it
   * passes, so work admitted later cannot drop it. */
  readonly classifyingIn: Map<string, number>;
  /** Lanes running a job now: "mention", or an attention job's Interest. */
  readonly busy: Set<string>;
  /** The last classified event's release: results queue in arrival order. */
  classified: Promise<void>;
  compiled?: {
    attention: Agent["attention"];
    watches: readonly CompiledWatch[];
  };
};

/** The session's live connection: `since` is when it last connected, and is
 * absent while it is down; `epoch` counts its connects; `start` is when its
 * listener started, from which live events, replay included, are heard. */
export type Connection = {
  epoch: number;
  start: number;
  since?: number | undefined;
};
/** An agent's community while it is live: one object for as long as its
 * session lasts. */
export type LiveCommunity = {
  readonly session: Pick<
    RelaySession,
    "read" | "readRemote" | "live" | "attendPending"
  >;
  /** Aborts when the session is replaced, so no work outlives it. */
  readonly controller: AbortController;
  readonly connection: Connection;
};
/** One agent's catch-up, for the attention, community and connect it started
 * under; any of them changing starts another. */
type Pass = {
  attention: Agent["attention"];
  community: LiveCommunity;
  epoch: number;
  controller: AbortController;
  done?: boolean;
  /** When it was done, so a stream live does not cover is read again. */
  doneAt?: number;
  failedAt?: number;
};

/** Since when live events have covered `stream`, or undefined when they do
 * not: it names one channel, whose route is live, and live hears all of its
 * kinds. A tick moves only such a stream's checkpoint, once it was read up to
 * then; any other is read again, or an event live never heard could be
 * passed over. */
const coveredSince = (stream: Stream, live: ReadonlyMap<string, number>) =>
  stream.channel !== undefined &&
  stream.kinds.every((kind) => CHANNEL_KINDS.includes(kind))
    ? live.get(stream.channel)
    : undefined;

/** How much of its last window each stream reads again: one live does not
 * cover could still get an event the relay stores late. */
const overlapOf = (live: ReadonlyMap<string, number>) => (stream: Stream) =>
  coveredSince(stream, live) === undefined ? POLL_OVERLAP : 0;

const seconds = () => Math.floor(Date.now() / 1000);
const message = (error: unknown) =>
  String(error instanceof Error ? error.message : error);

/** An agent's membership in a community, which has a runner of its own. */
export type RunnerMember = Readonly<{
  key: AgentKey;
  pubkey: string;
  relay: string;
  type: string;
  protectionRevision?: number | undefined;
  /** The partition its community's activity is kept under. */
  scope: string;
}>;

/** What the runner needs of its host. Each agent it names is a membership,
 * by its key. */
export type RunnerHost = {
  /** Session controls refresh when this copy gains or loses native custody. */
  ownershipChanged?(): void;
  /** The agent, while its community is live to run it in. */
  ready(key: AgentKey): Agent | undefined;
  /** A running agent, in any community. */
  agent(key: AgentKey): Agent | undefined;
  /** Whether the agent is in the event's channel, or undefined while its
   * roster is only the one saved on disk and the relay has not confirmed it. */
  member(agent: Agent, event: Pick<RelayEvent, "tags">): boolean | undefined;
  /** Whether the agent may read the event's channel: it is in it, or the
   * channel is public; undefined as for `member`. Only a member may be
   * delivered to. */
  reads(agent: Agent, event: Pick<RelayEvent, "tags">): boolean | undefined;
  /** Whether the event's channel is a DM between the agent and one other. */
  dm(agent: Agent, event: RelayEvent): boolean;
  /** Whether the event came as it would have with no watch keeping channels
   * live or looking them up; one heard `live`, or read by catch-up. */
  unattended(agent: Agent, event: RelayEvent, live: boolean): boolean;
  /** While the owner is still starting this chat, settles once it can take
   * the agent's events; undefined otherwise. */
  starting?(agent: Agent, channelId: string): Promise<void> | undefined;
  /** Its community, while live. */
  community(agent: Agent): LiveCommunity | undefined;
  /** Arms saved composer follow-ups behind these exact interrupted requests. */
  resumeFollowUps?(agent: Agent, turns: Readonly<Record<string, string>>): void;
  abandonFollowUps?(
    agent: Agent,
    turns: Readonly<Record<string, string>>,
  ): void;
  /** Every saved record, whose watches' catch-up progress is kept. */
  records(): readonly AgentRecord[];
  /** Catch-up progress, as saved. */
  checkpoints: {
    read(): Readonly<Record<string, Checkpoint>>;
    /** Throws when storage refuses it. */
    write(checkpoints: Readonly<Record<string, Checkpoint>>): void;
  };
  /** Mention turns working when the page went away, as saved. */
  interrupted: {
    read(): Interrupted;
    /** Saves the agent's turns. Throws when storage refuses it. */
    write(key: AgentKey, turns: Readonly<Record<string, string>>): void;
    /** This copy began or stopped holding an agent with saved turns. */
    changed(): void;
  };
  /** The partition its community's activity is kept under, while live. */
  scope(agent: Agent): string | undefined;
  /** Its saved record, without defaults. */
  saved(key: AgentKey): AgentRecord | undefined;
  /** Whether a plugin that shows Attention is on; Attention runs only then. */
  attentionShown(): boolean;
  /** Whether plugins have finished starting. */
  pluginsSettled(): boolean;
  /** Its record as its attention handle reads it; throws once it is gone. */
  record(key: AgentKey): AgentRecord;
  /** Changes its record after the changes sent before it, from the newest
   * saved record; settles with the saved record once it is saved, and
   * rejects when `apply` throws or the save fails. */
  change(
    key: AgentKey,
    apply: (record: AgentRecord) => AgentRecord | Promise<AgentRecord>,
  ): Promise<AgentRecord>;
  /** Whether a change other than timer progress is waiting or saving. Its
   * timers wait for it, since it may rearm, restart or remove one. */
  changing(key: AgentKey): boolean;
  /** Its timers' run state, with progress still being saved. */
  timers(key: AgentKey): Readonly<Record<string, TimerState>>;
  /** Saves a timer pass's progress. Its timers see it at once, and it stays
   * in memory even if the save fails, so a timer does not run again at once. */
  progress(key: AgentKey, progress: TimerProgress): void;
  /** The team sections of its prompt; empty without a team. */
  team(key: AgentKey): string;
  /** What its next run starts with, from this device's storage only. */
  start(agent: Agent): Start<unknown>;
  protection?(agent: Agent): AgentHandle["protection"];
  agentTypes(): ReturnType<NonNullable<AgentHandle["agentTypes"]>>;
  createAgent(
    agent: Agent,
    input: AgentCreationInput,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  updateAgent(
    agent: Agent,
    input: AgentUpdateInput,
  ): Promise<Readonly<{ requestId: string; saved: false }>>;
  /** Wakes the agent in another of its conversations, as its own handoff. */
  handoff(agent: Agent, handoff: AgentHandoff): void;
  /** The owner's channel templates as the agent's handle offers them. */
  templates(agent: Agent): ReturnType<AgentHandle["templates"]>;
  /** The owner's thread tabs as the agent's handle offers them. */
  tabs(agent: Agent): ReturnType<AgentHandle["tabs"]>;
  /** Whether watch classifiers can run here. */
  classifier(): ClassifierAvailability;
  /** The decisions service that runs classifiers, where there is one. */
  decisions(): Decisions | undefined;
  /** The event's surroundings for the classifier. */
  context(agent: Agent, event: RelayEvent): Promise<ClassifierContext>;
  /** A person's name as the agent's community shows it. */
  displayName(agent: Agent, pubkey: string): string | null;
  /** Signs, reads and claims as each agent; absent where agents cannot run. */
  custody:
    | Pick<
        AgentsNative,
        | "claim"
        | "release"
        | "publish"
        | "query"
        | "searchProfiles"
        | "upload"
        | "media"
        | "gitAuth"
        | "remember"
      >
    | undefined;
  /** This device's view of each agent's work. */
  activity: LocalAgentActivity;
  /** The event's channel as the agent's community lists it now. */
  channel(
    agent: Agent,
    event: Pick<RelayEvent, "tags">,
  ): ChannelSummary | undefined;
  /** Whether a mention in `channel` continues the agent's owner's Solo chat,
   * so its turn answers, and shows typing, at channel top level. */
  soloChat(
    agent: Agent,
    channel: string,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** The agent wrote this memory through its handle. */
  remembered(key: AgentKey, slug: string, body: string | null): void;
  woke?(
    key: AgentKey,
    object: AttentionObject,
    events?: readonly RelayEvent[],
  ): void;
  /** A run of the agent ended, with everything it handed to `workingUntil`. */
  finished(key: AgentKey): void;
  /** A harness's title for the conversation a mention started; may name a Solo chat. */
  named(agent: Agent, event: RelayEvent, title: string): void;
};

export class AgentRunners {
  private readonly sourceJobs = new Map<Job, string>();
  private readonly failedSources = new WeakSet<AttentionObject>();
  /** A terminal producer retains its registration until every queued turn settles. */
  async completeSource(key: AgentKey, object: AttentionObject) {
    await this.host.change(key, (record) => {
      if (record.attention[object.slug] !== object) return record;
      const pending =
        [...this.sourceJobs].some(
          ([job, agent]) => agent === key && job.matched?.object === object,
        ) ||
        this.runners
          .get(key)
          ?.queues.watch.some((job) => job.matched?.object === object);
      return pending || this.failedSources.has(object)
        ? {
            ...record,
            sourceRuns: {
              ...record.sourceRuns,
              [object.slug]: sourceSignature(object),
            },
          }
        : setAttention(record, object.slug, null);
    });
  }

  private readonly runners = new Map<string, Runner>();
  /** Holds newly joined memberships while their global provider/policy changes. */
  private readonly transitions = new Set<string>();
  /** Each agent's last claim or release, which its next waits for. */
  private readonly custody = new Map<string, Promise<void>>();
  /** Agents whose community was live at the last resume. */
  private connected = new Set<string>();
  /** Catch-up progress of each watch stream, as saved. */
  private checkpoints: Readonly<Record<string, Checkpoint>>;
  /** By agent, its catch-up running or last run. */
  private passes = new Map<string, Pass>();
  /** By community, for its connect, when each channel's route was first seen
   * live since it last was not. A route that comes back covers only what is
   * sent after that, not what it missed while down. */
  private liveSince = new WeakMap<
    LiveCommunity,
    { epoch: number; channels: Map<string, number> }
  >();
  /** Streams seen off (their watch disabled or the agent's attention off)
   * since the host started. One turned on starts from then, so it wakes
   * nothing from the time it was off; across a restart, its saved
   * checkpoint, moved while it was off, does the same. */
  private quiet = new Set<string>();
  /** Whether startup is over for Attention: plugins have finished starting,
   * or Attention has been shown, since this copy started. */
  private settled = false;
  /** Whether Attention is still waiting for startup, so neither its checkpoints
   * nor the live events it would hear can be decided yet. */
  private starting() {
    this.settled ||= this.host.attentionShown() || this.host.pluginsSettled();
    return !this.settled;
  }
  /** Whether live events are held until startup ends. */
  private heldForStartup = false;
  /** Mention turns working now, which closing or reloading the app would
   * stop, and those the app left working last time until they are given
   * again or forgotten, as saved. */
  private turns: Interrupted;
  /** The turns the app left working last time, by agent, until the owner
   * forgets them, or resumes them and each agent's are read again. */
  private left: Interrupted;
  /** The turns the app left working last time, as this page started: only
   * Resume gives them again, never a replay or live delivery. */
  private readonly stopped: Interrupted;
  /** The agents whose `left` the owner chose to resume. */
  private resuming = new Set<string>();
  private workingNow = false;
  private readonly workingListeners = new Set<() => void>();
  constructor(private readonly host: RunnerHost) {
    this.checkpoints = host.checkpoints.read();
    this.turns = this.left = this.stopped = host.interrupted.read();
  }

  /** Whether any agent has a job in a lane or a turn still working. */
  isWorking() {
    return this.workingNow;
  }
  subscribeWorking(listener: () => void) {
    this.workingListeners.add(listener);
    return () => void this.workingListeners.delete(listener);
  }
  private noteWorking() {
    const working = [...this.runners.values()].some(
      (runner) => runner.busy.size > 0 || runner.working > 0,
    );
    if (working === this.workingNow) return;
    this.workingNow = working;
    for (const listener of this.workingListeners) listener();
  }

  /** Agents with turns the app left working last time, until the owner
   * resumes or forgets them. */
  interrupted(): ReadonlySet<string> {
    return new Set(
      Object.keys(this.left).filter((key) => !this.resuming.has(key)),
    );
  }
  /** Gives each of `keys` again the turns it was left working on, once
   * its community is connected. */
  resumeInterrupted(keys: readonly AgentKey[]) {
    for (const key of keys) {
      this.resuming.add(key);
      const agent = this.host.agent(key);
      const turns = this.left[key];
      if (agent && turns && this.runners.get(key)?.type?.resumes)
        this.host.resumeFollowUps?.(agent, turns);
    }
    for (const runner of this.runners.values()) this.resumeTurns(runner);
  }
  /** Forgets the turns the app left `keys` working on last time. */
  dismissInterrupted(keys: readonly AgentKey[]) {
    for (const key of keys) {
      const { [key]: turns, ...rest } = this.left;
      if (!turns || !this.runs(key)) continue;
      const agent = this.host.agent(key);
      if (agent) this.host.abandonFollowUps?.(agent, turns);
      this.unmark(key, Object.keys(turns));
      this.left = rest;
    }
  }

  /** Keeps one runner for each saved agent: a deleted one's is retired, and a
   * replaced type aborts its run. Turning attention off voids the watch work
   * it queued or held, even if it is turned on again before that work would
   * run. */
  reconcile(
    identities: readonly RunnerMember[],
    types: ReadonlyMap<string, RegisteredAgentType>,
  ) {
    for (const [key, runner] of this.runners)
      if (!identities.some((identity) => identity.key === key)) {
        this.retire(runner);
        this.runners.delete(key);
      }
    for (const identity of identities) {
      const type = types.get(identity.type);
      const runner = this.runners.get(identity.key);
      const off = this.host.saved(identity.key)?.attentionEnabled !== true;
      if (runner && (off || !this.host.attentionShown())) {
        runner.epoch++;
        this.dropWatchWork(runner);
        // A startup hold keeps its events until Attention is shown, but not
        // past the switch being turned off.
        if (off) runner.held.clear();
      }
      if (!runner) this.runners.set(identity.key, this.runner(identity, type));
      else if (
        runner.type !== type ||
        runner.protectionRevision !== (identity.protectionRevision ?? 0)
      ) {
        runner.protectionRevision = identity.protectionRevision ?? 0;
        runner.controller.abort();
        runner.controller = new AbortController();
        runner.type = type;
        void this.drain(runner);
      }
    }
  }
  /** Resumes runners whose queue paused while their community was not live,
   * and claims or releases each agent as its community goes live or not, so
   * another host takes over without waiting for an event or tick. `ready` is
   * the agents whose community is live now. */
  resume(ready: ReadonlySet<string>) {
    for (const runner of this.runners.values())
      if (
        runner.queues.mention.length ||
        runner.queues.watch.length ||
        ready.has(runner.key) !== this.connected.has(runner.key)
      )
        void this.drain(runner);
    this.connected = new Set(ready);
  }
  /** Wakes each runner, which starts any timer that is due. */
  tick() {
    for (const key of this.runners.keys()) this.wake(key);
  }
  /** Wakes the agent's runner, as when the changes its timers wait for are
   * saved: one due meanwhile starts now, not at the next tick. */
  wake(key: AgentKey) {
    const runner = this.runners.get(key);
    if (!runner) return;
    this.admit(runner);
    void this.drain(runner);
  }
  /** Queues a plugin's wake in the agent's mention lane. Throws when this
   * copy does not run the agent, or the lane is full. */
  wakeIn(key: AgentKey, trigger: PluginTrigger) {
    const runner = this.runners.get(key);
    if (!runner || !this.runs(key) || !this.host.ready(key))
      throw new Error("This copy of Buzz does not run that agent");
    if (!this.enqueue(runner, { trigger, channelId: trigger.channel }))
      throw new Error("The agent is busy and could not take this wake");
  }
  wakeSource(
    key: AgentKey,
    trigger: Extract<Trigger, { type: "source" }>,
    object: AttentionObject,
    sourceCurrent: () => boolean,
  ) {
    const runner = this.runners.get(key);
    if (!runner || !this.runs(key) || !this.host.ready(key))
      throw new Error("This copy of Buzz does not run that agent");
    const job = {
      trigger,
      matched: { object, epoch: runner.epoch },
      sourceCurrent,
    };
    const agent = this.host.ready(key) as Agent;
    const accepted = trigger.watch.classifier
      ? this.classified(runner, agent, job)
      : this.enqueue(runner, job);
    if (!accepted)
      throw new Error("The agent is busy and could not take this wake");
  }

  /** Whether this copy runs the agent: its type can run it, and no other
   * copy of the app holds it. */
  runs(key: AgentKey) {
    const runner = this.runners.get(key);
    return !!runner?.type?.run && !!runner.asked && runner.mayHold;
  }
  /** Leaves `text` for the agent's next turn in this conversation, while this copy
   * runs it. */
  note(key: AgentKey, channelId: string, text: string, root?: string) {
    const runner = this.runners.get(key);
    if (!runner || !this.runs(key)) return false;
    runner.notes.set(channelId, [
      ...(runner.notes.get(channelId) ?? []),
      { text, root },
    ]);
    return true;
  }
  /** The agent's handle outside any run, while this copy runs it with a
   * type of `pluginId` when specified, not changing it, and its community is live. Each
   * call through the handle checks that again, so a kept handle stops
   * working while it no longer holds, and for good once the agent's type
   * or its plugin is replaced. */
  handle(key: AgentKey, pluginId?: string) {
    const held = () => {
      const runner = this.runners.get(key);
      const agent = this.host.ready(key);
      return runner?.type &&
        (pluginId === undefined || runner.type.pluginId === pluginId) &&
        !runner.transitioning &&
        agent &&
        this.runs(key)
        ? { runner, agent }
        : undefined;
    };
    const now = held();
    if (!now) return;
    const { runner, agent } = now;
    const { signal } = runner.controller;
    return guarded(this.handleFor(runner, agent), () => {
      if (signal.aborted || held()?.runner !== runner)
        throw new Error(
          `${agent.name} no longer runs here as this plugin's agent; ask for its handle again`,
        );
    });
  }
  /** Whether another copy of the app runs an agent this one could. */
  yielded(key: AgentKey) {
    const runner = this.runners.get(key);
    return !!runner?.type?.run && !runner.mayHold && !!this.host.ready(key);
  }
  /** Whether a change of type holds the agent's runner now. */
  transitioning(key: AgentKey) {
    return this.runners.get(key)?.transitioning === true;
  }
  /** Session mutations require a current, successful native custody check. */
  async control<T>(key: AgentKey, change: () => Promise<T>): Promise<T> {
    const runner = this.runners.get(key);
    if (
      !runner ||
      !(await this.claimForRetype(runner)) ||
      this.runners.get(key) !== runner ||
      runner.transitioning ||
      !this.host.ready(key)
    )
      throw new Error(
        "Use session controls in the Buzz app that runs this agent.",
      );
    return change();
  }
  /** Runs `change` while a change of type holds the agent's idle runners, in
   * every community it is in, as its type is theirs: no turn starts
   * meanwhile, and their queues resume after. Refused while a turn is
   * working, and unless this copy of the app holds the agent. */
  async retype<T>(
    key: AgentKey,
    name: string,
    change: () => Promise<T>,
  ): Promise<T> {
    const runner = this.runners.get(key);
    const held = [...this.runners.values()].filter(
      (other) => other.member.pubkey === runner?.member.pubkey,
    );
    const answering = () =>
      new Error(`${name} is answering; change its type when it finishes`);
    const working = () => held.some((other) => other.working);
    if (working()) throw answering();
    if (!runner)
      throw new Error(
        "This agent is not running in this copy of Buzz. Change its provider in the Buzz app that runs it.",
      );
    const pubkey = runner.member.pubkey;
    if (
      this.transitions.has(pubkey) ||
      held.some((other) => other.transitioning)
    )
      throw new Error(`${name}'s provider is already changing`);
    this.transitions.add(pubkey);
    for (const other of held) other.transitioning = true;
    try {
      if (!(await this.claimForRetype(runner)))
        throw new Error(
          "Another copy of Buzz is running this agent. Change its provider there, or quit that copy of Buzz and try again.",
        );
      if (working()) throw answering();
      return await change();
    } finally {
      this.transitions.delete(pubkey);
      for (const other of this.runners.values()) {
        if (other.member.pubkey !== pubkey) continue;
        other.transitioning = false;
        void this.drain(other);
      }
    }
  }
  /** Retires every runner, as when the host stops. */
  clear() {
    for (const runner of this.runners.values()) this.retire(runner);
    this.runners.clear();
  }

  private runner(
    { key, pubkey, relay, scope, protectionRevision }: RunnerMember,
    type: RegisteredAgentType | undefined,
  ): Runner {
    return {
      key,
      member: { pubkey, relay },
      scope,
      type,
      protectionRevision: protectionRevision ?? 0,
      controller: new AbortController(),
      queues: { mention: [], watch: [] },
      running: false,
      rates: {
        mention: { windowStart: 0, admitted: 0 },
        watch: { windowStart: 0, admitted: 0 },
      },
      catching: new Set(),
      waiting: new Map(),
      later: [],
      seen: new Set(),
      seenIn: new Map(),
      backlog: [],
      working: 0,
      typing: new Map(),
      transitioning: this.transitions.has(pubkey),
      held: new Map(),
      notes: new Map(),
      mayHold: true,
      epoch: 0,
      classifying: 0,
      classifyingIn: new Map(),
      busy: new Set(),
      classified: Promise.resolve(),
    };
  }
  private retire(runner: Runner) {
    this.passes.get(runner.key)?.controller.abort();
    this.passes.delete(runner.key);
    this.host.activity.clear(runner.scope, runner.member.pubkey);
    this.dropMentions(runner, true);
    this.dropWatchWork(runner);
    runner.held.clear();
    runner.backlog.length = 0;
    runner.controller.abort();
  }
  /** The runner's event watches for the agent's current attention. */
  private watches(runner: Runner, agent: Agent) {
    if (runner.compiled?.attention === agent.attention)
      return runner.compiled.watches;
    const watches: CompiledWatch[] = [];
    for (const object of Object.values(agent.attention)) {
      const watch = object.value;
      if (watch.type !== "event" || !watch.enabled) continue;
      const interest = agent.attention[`interest/${watch.interest_id}`]?.value;
      watches.push({
        slug: object.slug,
        watch,
        ...(interest?.type === "interest" ? { interest } : {}),
      });
    }
    runner.compiled = { attention: agent.attention, watches };
    return watches;
  }

  /** Gives a community's live events, and replayed ones from `since` on, to
   * the agents in it. */
  dispatch(batch: LiveBatch, heard: (agent: Agent) => boolean, since: number) {
    for (const runner of this.runners.values()) {
      const agent = this.host.ready(runner.key);
      if (!agent || !heard(agent) || !runner.type?.run) continue;
      let overflow = 0;
      for (const event of batch.events) {
        if (batch.replay && event.created_at < since) continue;
        if (!batch.replay) {
          this.hear(runner, agent, event, batch.channelId);
          continue;
        }
        const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
        if (this.hasSeen(runner, event.id, channel)) continue;
        // Left unseen, so a later replay or catch-up can still deliver it.
        if (runner.backlog.length >= BACKLOG_LIMIT) {
          overflow++;
          continue;
        }
        this.markSeen(runner, event.id, channel);
        if (this.isOwn(agent, event)) continue;
        // A replay waits for room rather than take the drops a burst of
        // live traffic would.
        runner.backlog.push({
          event,
          ...(batch.channelId ? { channelId: batch.channelId } : {}),
        });
      }
      if (overflow)
        console.warn(
          `Agent ${agent.name} left ${overflow} replayed events for later`,
        );
      if (batch.replay) this.admit(runner);
    }
  }
  private hasSeen(runner: Runner, id: string, channel: string | undefined) {
    return (
      runner.seen.has(id) ||
      (!!channel && !!runner.seenIn.get(channel)?.has(id))
    );
  }
  /** An agent never hears itself. */
  private isOwn(agent: Agent, event: RelayEvent) {
    return event.pubkey === agent.pubkey;
  }
  private markSeen(runner: Runner, id: string, channel: string | undefined) {
    bounded(runner.seen, id);
    if (!channel) return;
    const ids = runner.seenIn.get(channel) ?? new Set<string>();
    // Moved to the newest end, so the quietest channel is forgotten first.
    runner.seenIn.delete(channel);
    runner.seenIn.set(channel, ids);
    bounded(ids, id, LIVE_REPLAY_LIMIT);
    if (runner.seenIn.size > SEEN_CHANNELS)
      runner.seenIn.delete(runner.seenIn.keys().next().value as string);
  }
  /** Whether the agent can take `mentions` more mentions and an attention
   * job for each of `interests`, `classified` events of them first through
   * the classifier, without dropping any. Every attention job is admitted
   * here, and one being classified keeps the room it was admitted to. */
  private fits(
    runner: Runner,
    mentions: number,
    interests: readonly string[],
    classified: number,
  ) {
    const watches = interests.length;
    const adding = new Map<string, number>();
    for (const interest of interests)
      adding.set(interest, (adding.get(interest) ?? 0) + 1);
    for (const [interest, count] of adding)
      if (
        this.waitingIn(runner, interest) +
          (runner.classifyingIn.get(interest) ?? 0) +
          count >
        INTEREST_LIMIT
      )
        return false;
    const admitted = (lane: Lane) => {
      const rate = runner.rates[lane];
      return Date.now() - rate.windowStart >= RATE_WINDOW_MS
        ? 0
        : rate.admitted;
    };
    const { mention, watch } = runner.queues;
    let reserved = 0;
    for (const count of runner.classifyingIn.values()) reserved += count;
    return (
      mention.length + mentions <= QUEUE_LIMIT &&
      admitted("mention") + mentions <= RATE_LIMIT &&
      watch.length + reserved + watches <= QUEUE_LIMIT &&
      runner.classifying + classified <= CLASSIFY_LIMIT &&
      admitted("watch") + reserved + watches <= RATE_LIMIT
    );
  }
  /** Attention jobs waiting for the Interest's lane. */
  private waitingIn(runner: Runner, interest: string) {
    let count = 0;
    for (const job of runner.queues.watch)
      if (interestOf(job.trigger) === interest) count++;
    return count;
  }
  /** Whether the agent has room for every job `triggers` make. One that
   * makes more jobs than an idle agent takes goes when it is idle, and loses
   * the excess as live delivery would. */
  private takes(runner: Runner, triggers: readonly Trigger[]) {
    const mentions = triggers.filter((t) => t.type === "mention").length;
    // At most what one Interest holds, and what the queue does.
    const counts = new Map<string, number>();
    const interests = triggers
      .flatMap((t) => interestOf(t) ?? [])
      .filter((interest) => {
        const count = (counts.get(interest) ?? 0) + 1;
        counts.set(interest, count);
        return count <= INTEREST_LIMIT;
      });
    return this.fits(
      runner,
      Math.min(mentions, QUEUE_LIMIT),
      interests.slice(0, QUEUE_LIMIT),
      Math.min(
        triggers.reduce((sum, t) => sum + classifications(t), 0),
        CLASSIFY_LIMIT,
      ),
    );
  }
  /** Delivers backlogged events, oldest first, while the agent has room for
   * every job each makes; the rest wait for a later tick. Each is matched
   * against the agent's attention as it is when it is delivered. */
  private admit(runner: Runner) {
    const agent = this.host.ready(runner.key);
    if (!agent || !runner.type?.run) return;
    // First the live events held back while their watch caught up.
    while (runner.later.length) {
      const job = runner.later[0] as Job;
      if (
        !this.fits(
          runner,
          0,
          [interestOf(job.trigger) as string],
          classifications(job.trigger),
        )
      )
        return;
      runner.later.shift();
      this.submit(runner, agent, job);
    }
    while (runner.backlog.length) {
      const { event, channelId, done } = runner
        .backlog[0] as Runner["backlog"][0];
      const heard = this.heard(runner, agent, event, done);
      if (
        (heard.held && runner.held.size >= HELD_LIMIT) ||
        !this.takes(runner, heard.triggers)
      )
        return;
      runner.backlog.shift();
      this.deliver(runner, agent, event, channelId, heard, done);
    }
  }
  /** Gives the agent `event` once, however many times it arrives. */
  private hear(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    channelId: string | undefined,
  ) {
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (this.hasSeen(runner, event.id, channel)) return;
    this.markSeen(runner, event.id, channel);
    if (this.isOwn(agent, event)) return;
    this.deliver(runner, agent, event, channelId);
  }
  /** Saves `event` as heard by each of the agent's streams it is in and has
   * not passed yet, so catch-up after a restart does not give it again. */
  private heardLive(
    agent: Agent,
    event: RelayEvent,
    done?: ReadonlySet<string>,
  ) {
    let changed = false;
    for (const stream of streamsOf(agent))
      if ((!done || done.has(stream.slug)) && inStream(stream, event))
        changed = this.heardIn(stream.key, event) || changed;
    if (changed) this.saveCheckpoints();
  }
  /** Adds `event` to what the stream heard past its checkpoint, unless it is
   * not past it; returns whether it did. */
  private heardIn(key: string, event: RelayEvent) {
    const checkpoint = this.checkpoints[key];
    if (!checkpoint || !undelivered(checkpoint, event)) return false;
    this.checkpoints = {
      ...this.checkpoints,
      [key]: heardOf(checkpoint, [...(checkpoint.heard ?? []), event]),
    };
    return true;
  }
  /** Sets a stream's checkpoint, keeping what it heard live past it as well
   * as what the checkpoint itself lists as heard. */
  private setCheckpoint(key: string, checkpoint: Checkpoint) {
    // Kept below a window's cursor too: one read with an overlap lists there
    // what it gave, which a restart before it is done must not give again.
    this.checkpoints = {
      ...this.checkpoints,
      [key]: heardOf(checkpoint, [
        ...(this.checkpoints[key]?.heard ?? []),
        ...(checkpoint.heard ?? []),
      ]),
    };
  }
  /** Keeps each agent's catch-up going: on start, and after each connect, its
   * event watches read the events they missed from their saved checkpoints,
   * up to the connect. From then on live events cover a stream whose channel
   * is live, of kinds live hears, so while the connection stays up a `tick`
   * moves its checkpoint to now; a quit or a drop leaves the checkpoint where
   * the next catch-up starts. Any other stream, and one whose checkpoint is
   * still before the connect or before its route came back, is read again,
   * up to a little before now. */
  catchUp(tick: boolean) {
    const now = seconds();
    let changed = false;
    const observed = new Set<LiveCommunity>();
    /** The community's live channels, each with when it was first seen live. */
    const liveOf = (community: LiveCommunity) => {
      const { epoch } = community.connection;
      let seen = this.liveSince.get(community);
      if (seen?.epoch !== epoch) {
        seen = { epoch, channels: new Map() };
        this.liveSince.set(community, seen);
      }
      if (!observed.has(community)) {
        observed.add(community);
        const live = new Set(
          community.session.live
            .snapshot()
            .routes.flatMap((route) =>
              route.status === "live" && route.channelId
                ? [route.channelId]
                : [],
            ),
        );
        for (const id of seen.channels.keys())
          if (!live.has(id)) seen.channels.delete(id);
        for (const id of live)
          if (!seen.channels.has(id)) seen.channels.set(id, now);
      }
      return seen.channels;
    };
    const move = (key: string, checkpoint: Checkpoint) => {
      this.setCheckpoint(key, checkpoint);
      changed = true;
    };
    // Until plugins finish starting or Attention is shown, every checkpoint
    // stays put, so the first catch-up still reads what the app missed while
    // closed, and live events stay held. After that, no plugin showing
    // Attention is like turning it off.
    const shown = this.host.attentionShown();
    const held = this.starting();
    for (const runner of this.runners.values()) {
      this.resumeTurns(runner);
      const agent = this.host.agent(runner.key);
      const community = agent && this.host.community(agent);
      const on = !!agent?.attentionEnabled && !!runner.type?.run;
      const reading: Stream[] = [];
      for (const stream of agent && !held ? streamsOf(agent) : []) {
        const checkpoint = this.checkpoints[stream.key];
        if (!on || !stream.enabled) {
          // Saved too, so one turned on after a restart starts from about
          // when this copy last saw it off, or from when Attention is shown.
          this.quiet.add(stream.key);
          if (
            (checkpoint?.through ?? 0) < now ||
            (!shown && !checkpoint?.hidden)
          )
            move(stream.key, { through: now, ...(!shown && { hidden: true }) });
        } else if (
          this.quiet.delete(stream.key) ||
          !checkpoint ||
          checkpoint.hidden
        )
          // A stream new to catch-up, as every one is on an upgrade, starts
          // now: an earlier `since` does not replay older events.
          move(stream.key, { through: now });
        // Until its channel's metadata is known, a read returns none of its
        // events: it waits, with its checkpoint where it was.
        else if (
          stream.channel === undefined ||
          !community?.session.attendPending(stream.channel)
        )
          reading.push(stream);
      }
      const pass = this.passes.get(runner.key);
      const since = community?.connection.since;
      // Seen on every call, so a route that drops and comes back between
      // ticks is not taken as live all along.
      const live =
        community && since !== undefined ? liveOf(community) : undefined;
      if (!agent || !community || since === undefined || !reading.length) {
        pass?.controller.abort();
        this.passes.delete(runner.key);
        this.setCatching(runner, new Set());
        continue;
      }
      if (
        pass?.attention === agent.attention &&
        pass.community === community &&
        pass.epoch === community.connection.epoch &&
        !(pass.failedAt && Date.now() - pass.failedAt >= CATCH_UP_RETRY_MS)
      ) {
        if (!pass.done) continue;
        const channels = live ?? new Map<string, number>();
        // Read up to the connect, and to when live began to cover it.
        const due = (stream: Stream) =>
          Math.max(since, coveredSince(stream, channels) ?? since);
        // How far it was read: one read with an overlap keeps its
        // checkpoint behind that.
        const through = (stream: Stream) => {
          const checkpoint = this.checkpoints[stream.key];
          return checkpoint?.read ?? checkpoint?.through ?? 0;
        };
        const ticks = (stream: Stream) =>
          coveredSince(stream, channels) !== undefined &&
          through(stream) >= due(stream);
        if (tick)
          for (const stream of reading.filter(ticks)) {
            const checkpoint = this.checkpoints[stream.key];
            if (checkpoint && !checkpoint.upper && checkpoint.through < now)
              move(stream.key, { through: now });
          }
        const behind = reading.filter(
          (stream) => through(stream) < due(stream),
        );
        const polled = reading.filter((stream) => !ticks(stream));
        if (
          !behind.length &&
          !(
            polled.length && Date.now() - (pass.doneAt ?? 0) >= CATCH_UP_POLL_MS
          )
        )
          continue;
        const next: Pass = { ...pass, controller: new AbortController() };
        delete next.done;
        delete next.doneAt;
        this.passes.set(runner.key, next);
        // Only one behind holds its live events back, to go on in order.
        this.setCatching(runner, new Set(behind.map(({ slug }) => slug)));
        void this.readMissed(
          runner,
          next,
          polled,
          // One behind reads up to when live began to cover it; any other
          // stays behind now, for events the relay stores late.
          (stream) =>
            Math.max(
              now - CATCH_UP_POLL_LAG,
              behind.includes(stream) ? due(stream) : since,
            ),
          overlapOf(channels),
        );
        continue;
      }
      pass?.controller.abort();
      const next: Pass = {
        attention: agent.attention,
        community,
        epoch: community.connection.epoch,
        controller: new AbortController(),
      };
      this.passes.set(runner.key, next);
      this.setCatching(runner, new Set(reading.map(({ slug }) => slug)));
      const channels = live ?? new Map<string, number>();
      void this.readMissed(
        runner,
        next,
        reading,
        // A stream live does not cover is read as a poll reads it: an edit
        // starts a new pass, and edits more often than the poll would
        // otherwise keep it from being read.
        (stream) =>
          coveredSince(stream, channels) === undefined
            ? Math.max(since, now - CATCH_UP_POLL_LAG)
            : since,
        overlapOf(channels),
      );
    }
    // Once each catch-up is under way, so they are heard after what it reads.
    if (!held && this.heldForStartup) {
      this.heldForStartup = false;
      this.releaseHeld(() => true);
    }
    if (changed) this.saveCheckpoints();
  }
  /** Once the owner chose to resume them, gives the agent again the mention
   * turns the app left it working on, when its community is connected: each
   * read again from the relay, as only its id was saved. Each stays saved
   * until its new turn ends, so closing the app again first loses none; one
   * the relay no longer has, or that was given meanwhile, is forgotten. A
   * failed read leaves them for the next try. */
  private resumeTurns(runner: Runner) {
    const left = this.left[runner.key];
    const agent = this.host.ready(runner.key);
    const community = agent && this.host.community(agent);
    if (
      !this.resuming.has(runner.key) ||
      !left ||
      !agent ||
      !runner.type ||
      community?.connection.since === undefined
    )
      return;
    const { [runner.key]: _, ...rest } = this.left;
    this.left = rest;
    const ids = Object.keys(left);
    if (!runner.type.resumes) {
      this.host.abandonFollowUps?.(agent, left);
      return this.unmark(runner.key, ids);
    }
    this.host.resumeFollowUps?.(agent, left);
    // Not read(): it returns the owner's own mentions as unproven outbox copies.
    void community.session
      .readRemote([{ ids, limit: ids.length }], {
        signal: community.controller.signal,
        fresh: true,
      })
      .then(
        (events) => {
          // A turn's own run forgets it when it settles.
          const kept = new Set<string>();
          // Oldest first, as they were sent: a later correction stays last.
          const proven = (events.filter(hasEventProof) as RelayEvent[]).sort(
            (a, b) =>
              a.created_at - b.created_at ||
              (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          );
          for (const event of proven) {
            const channel = left[event.id];
            if (channel === undefined) continue;
            if (!this.hasSeen(runner, event.id, channelOf(event)))
              this.markSeen(runner, event.id, channelOf(event));
            const queued = this.enqueue(runner, {
              trigger: { type: "mention", event, resumed: true },
              ...(channel ? { channelId: channel } : {}),
            });
            if (queued) kept.add(event.id);
          }
          const forgotten = Object.fromEntries(
            Object.entries(left).filter(([id]) => !kept.has(id)),
          );
          this.host.abandonFollowUps?.(agent, forgotten);
          this.unmark(runner.key, Object.keys(forgotten));
        },
        (error) => {
          this.left = { ...this.left, [runner.key]: left };
          if (!community.controller.signal.aborted)
            console.warn(
              `Agent ${agent.name} could not resume its turns`,
              error,
            );
        },
      );
  }
  /** Saves the mention `id` as working, in `channel` or "" without one. */
  private mark(key: AgentKey, id: string, channel: string) {
    this.saveTurns(key, {
      ...this.turns,
      [key]: { ...this.turns[key], [id]: channel },
    });
  }
  private unmark(key: AgentKey, ids: readonly string[]) {
    const { [key]: turns = {}, ...rest } = this.turns;
    const kept = Object.fromEntries(
      Object.entries(turns).filter(([id]) => !ids.includes(id)),
    );
    this.saveTurns(
      key,
      Object.keys(kept).length ? { ...rest, [key]: kept } : rest,
    );
  }
  /** Saves `key`'s turns only: another program may run the others. */
  private saveTurns(key: AgentKey, turns: Interrupted) {
    this.turns = turns;
    try {
      this.host.interrupted.write(key, turns[key] ?? {});
    } catch (error) {
      console.warn("Agent turns in progress were not saved", error);
    }
  }
  /** Reads each stream's missed events through `upper`, or its own `upper`
   * when that is a function, a window at a time,
   * and delivers them oldest first, in batches, saving its checkpoint after
   * each. A stream with an `overlap` keeps that many seconds below its
   * window open for its next read. A watch's streams are read one after
   * another; once all of them are read, its live events that waited go on. */
  private async readMissed(
    runner: Runner,
    pass: Pass,
    streams: readonly Stream[],
    upper: number | ((stream: Stream) => number),
    overlap: (stream: Stream) => number,
  ) {
    const signal = AbortSignal.any([
      pass.controller.signal,
      pass.community.controller.signal,
    ]);
    const name = () => this.host.agent(runner.key)?.name;
    const read = async (filter: ReadFilter) => {
      const events = await pass.community.session.read([filter], {
        signal,
        priority: "background",
        fresh: true,
        // Of every channel: a public one the session does not know yet too.
        ...(filter["#h"] ? {} : { resolveChannels: true }),
      });
      signal.throwIfAborted();
      // Only what the relay signed: a read also returns the owner's own
      // messages not yet sent, which can be older than its page.
      return events.filter(hasEventProof) as RelayEvent[];
    };
    const progress = (key: string, checkpoint: Checkpoint) => {
      this.setCheckpoint(key, checkpoint);
      this.saveCheckpoints();
    };
    try {
      const slugs = [...new Set(streams.map(({ slug }) => slug))];
      for (const slug of slugs) {
        for (const stream of streams.filter((item) => item.slug === slug))
          for (;;) {
            const window = await readWindow(
              stream,
              this.checkpoints[stream.key],
              typeof upper === "number" ? upper : upper(stream),
              read,
            );
            if (!window) break;
            if (window.skipped)
              console.warn(
                `Agent ${name()} skipped the oldest events ${slug} missed: catch-up reads at most ${CATCH_UP_PAGES} pages`,
              );
            progress(stream.key, window.checkpoint);
            const events = window.events.filter((event) =>
              inStream(stream, event),
            );
            let skipped = window.skipped;
            for (let index = 0; index < events.length; ) {
              const taken = await this.caughtUp(
                runner,
                pass,
                slug,
                events.slice(index, index + CATCH_UP_BATCH),
                skipped,
                signal,
              );
              if (!taken) return;
              skipped = false;
              index += taken;
              progress(
                stream.key,
                admitted(
                  window,
                  events.slice(0, index),
                  this.checkpoints[stream.key]?.heard,
                  overlap(stream),
                ),
              );
            }
            progress(
              stream.key,
              finished(
                window,
                this.checkpoints[stream.key]?.heard,
                overlap(stream),
              ),
            );
          }
        const catching = new Set(runner.catching);
        catching.delete(slug);
        this.setCatching(runner, catching);
      }
      pass.done = true;
      pass.doneAt = Date.now();
    } catch (error) {
      if (signal.aborted) return;
      pass.failedAt = Date.now();
      // Live events go on rather than wait for the next try.
      this.setCatching(runner, new Set());
      console.warn(`Agent ${name()} could not catch up`, error);
    }
  }
  /** Gives the agent the first of `events` it has room for, once the rosters
   * their watches need are confirmed: a checkpoint saved past an event never
   * drops or evicts it. One that makes more jobs than the agent has room for
   * goes to its watches a few at a time. Each watch they match gets one
   * job with all of its events, oldest first, so a long absence does not
   * cost a turn per message. One from before the listener started wakes only
   * watches, so a mention from before the app listened is not answered late.
   * A later one live would have heard, mentions too; catch-up may read it
   * before replay does, which then skips it as seen. Returns how many events
   * were taken, or 0 when an edit since ends the pass: the next one reads them
   * again. */
  private async caughtUp(
    runner: Runner,
    pass: Pass,
    slug: string,
    events: readonly RelayEvent[],
    skipped: boolean,
    signal: AbortSignal,
  ): Promise<number> {
    for (;;) {
      signal.throwIfAborted();
      const agent = this.host.ready(runner.key);
      if (agent?.attention !== pass.attention) return 0;
      const taken = this.batch(runner, agent, pass, slug, events, skipped);
      if (taken) return taken;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, CATCH_UP_WAIT_MS);
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  /** Delivers the longest run of `events`, oldest first, whose jobs the agent
   * has room for now; returns how many it took, or 0 for none. With no room
   * for all of the first one's, what room there is goes to some of them. */
  private batch(
    runner: Runner,
    agent: Agent,
    pass: Pass,
    slug: string,
    events: readonly RelayEvent[],
    skipped: boolean,
  ) {
    const mentions: { trigger: Trigger; channel?: string }[] = [];
    const watches = new Map<string, WatchTrigger[]>();
    let taken = 0;
    let bytes = 0;
    for (const event of events) {
      const channel = channelOf(event);
      // Seen once its first watches have it; the rest still get it.
      const fanning =
        runner.fanning?.id === event.id ? runner.fanning : undefined;
      const heard =
        (!fanning && this.hasSeen(runner, event.id, channel)) ||
        event.pubkey === agent.pubkey
          ? { triggers: [] }
          : this.heard(runner, agent, event, fanning?.done, false);
      if (heard.discarded?.length) {
        this.heardLive(agent, event, new Set(heard.discarded));
        runner.fanning = {
          id: event.id,
          done: new Set([...(fanning?.done ?? []), ...heard.discarded]),
        };
      }
      const listened = event.created_at >= pass.community.connection.start;
      const triggers = heard.triggers.filter((trigger) =>
        trigger.type === "watch"
          ? !fanning?.done.has(trigger.slug) && this.missed(runner, trigger)
          : !fanning && listened,
      );
      if (heard.held) {
        if (!taken) this.fanOut(runner, agent, event, triggers, slug, skipped);
        break;
      }
      const nextMentions = [...mentions];
      const nextWatches = new Map(
        [...watches].map(([key, list]) => [key, [...list]]),
      );
      for (const trigger of triggers)
        if (trigger.type === "watch")
          nextWatches.set(trigger.slug, [
            ...(nextWatches.get(trigger.slug) ?? []),
            trigger,
          ]);
        else nextMentions.push({ trigger, ...(channel ? { channel } : {}) });
      const classified = [...nextWatches.values()].reduce(
        (sum, list) => sum + (list[0]?.watch.classifier ? list.length : 0),
        0,
      );
      const size = sizeOf(event);
      if (taken && bytes + size > CATCH_UP_BATCH_CHARS) break;
      if (
        !this.fits(
          runner,
          nextMentions.length,
          [...nextWatches.values()].map(
            (list) => (list[0] as WatchTrigger).watch.interest_id,
          ),
          classified,
        )
      ) {
        if (!taken) this.fanOut(runner, agent, event, triggers, slug, skipped);
        break;
      }
      mentions.splice(0, mentions.length, ...nextMentions);
      watches.clear();
      for (const [key, list] of nextWatches) watches.set(key, list);
      bytes += size;
      taken++;
    }
    if (!taken) return 0;
    for (const event of events.slice(0, taken)) {
      if (runner.fanning?.id === event.id) delete runner.fanning;
      const channel = channelOf(event);
      if (this.hasSeen(runner, event.id, channel)) continue;
      this.markSeen(runner, event.id, channel);
    }
    this.give(runner, agent, mentions, watches, slug, skipped);
    return taken;
  }
  /** Gives a missed event that makes more jobs than the agent has room for
   * to as many of its watches as there is room for now; later tries give it
   * to the rest, and only then is it taken, so its checkpoint never passes a
   * watch that did not get it. It is seen from the first, so a replay does
   * not give it again. */
  private fanOut(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    triggers: readonly Trigger[],
    slug: string,
    skipped: boolean,
  ) {
    const channel = channelOf(event);
    const mentions = triggers
      .filter((trigger) => trigger.type !== "watch")
      .map((trigger) => ({ trigger, ...(channel ? { channel } : {}) }));
    const watches = new Map<string, WatchTrigger[]>();
    let classified = 0;
    for (const trigger of triggers) {
      if (trigger.type !== "watch") continue;
      const more = trigger.watch.classifier ? 1 : 0;
      const interests = [...watches.values()].map(
        (list) => (list[0] as WatchTrigger).watch.interest_id,
      );
      if (
        !this.fits(
          runner,
          mentions.length,
          [...interests, trigger.watch.interest_id],
          classified + more,
        )
      )
        break;
      watches.set(trigger.slug, [trigger]);
      classified += more;
    }
    if (!watches.size) return;
    if (!this.hasSeen(runner, event.id, channel))
      this.markSeen(runner, event.id, channel);
    // Saved for each watch's stream too, so a restart before the rest have it
    // does not give it to these again.
    let changed = false;
    for (const [trigger] of watches.values()) {
      changed =
        this.heardIn(streamOf(runner.key, trigger as WatchTrigger), event) ||
        changed;
    }
    if (changed) this.saveCheckpoints();
    const done = runner.fanning?.id === event.id ? runner.fanning.done : [];
    runner.fanning = {
      id: event.id,
      done: new Set([...done, ...watches.keys()]),
    };
    this.give(runner, agent, mentions, watches, slug, skipped);
  }
  /** Queues catch-up's mentions, and one job per watch with its events. */
  private give(
    runner: Runner,
    agent: Agent,
    mentions: readonly { trigger: Trigger; channel?: string }[],
    watches: ReadonlyMap<string, readonly WatchTrigger[]>,
    slug: string,
    skipped: boolean,
  ) {
    for (const { trigger, channel } of mentions)
      this.enqueue(runner, {
        trigger,
        ...(channel ? { channelId: channel } : {}),
      });
    for (const [key, list] of watches) {
      const [{ watch, interest }] = list as [WatchTrigger];
      this.submit(runner, agent, {
        trigger: {
          type: "catch-up",
          slug: key,
          watch,
          ...(interest ? { interest } : {}),
          events: list.map(({ event }) => ({ event })),
          ...(skipped && key === slug ? { skipped } : {}),
        },
        matched: {
          object: agent.attention[key] as AttentionObject,
          epoch: runner.epoch,
        },
      });
    }
  }
  /** Whether a catch-up event read for one watch is also one `trigger`'s
   * watch missed: it is past that watch's stream's checkpoint, so a watch
   * added or widened since wakes for nothing older. */
  private missed(runner: Runner, trigger: WatchTrigger) {
    const checkpoint = this.checkpoints[streamOf(runner.key, trigger)];
    return !!checkpoint && undelivered(checkpoint, trigger.event);
  }
  /** Saves the checkpoints of watches that still exist. Unsaved, catch-up
   * starts from the last saved one again, which `seen` dedupes until a
   * restart, and each stream's saved `heard` after one. */
  private saveCheckpoints() {
    const keys = new Set(
      this.host.records().flatMap((record) =>
        // A record's `pubkey` is its membership's key.
        streamsOf({ key: record.pubkey, attention: record.attention }).map(
          (stream) => stream.key,
        ),
      ),
    );
    this.checkpoints = Object.fromEntries(
      Object.entries(this.checkpoints).filter(([key]) => keys.has(key)),
    );
    try {
      this.host.checkpoints.write(this.checkpoints);
    } catch (error) {
      console.warn("Agent catch-up progress was not saved", error);
    }
  }
  /** Matches the held events of a community's agents again, as its rosters
   * change: one now confirmed wakes the watches it matches, or none. They go
   * back through the backlog, ahead of what came after them: a confirmed
   * roster can release more than the agent has room for at once, and each is
   * already seen, so one dropped here would never come again. */
  releaseHeld(heard: (agent: Agent) => boolean) {
    for (const runner of this.runners.values()) {
      if (!runner.held.size) continue;
      const agent = this.host.ready(runner.key);
      if (!agent || !heard(agent)) continue;
      runner.backlog.unshift(...runner.held.values());
      runner.held.clear();
      this.admit(runner);
    }
  }
  private deliver(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    channelId: string | undefined,
    heard = this.heard(runner, agent, event),
    done: ReadonlySet<string> = new Set(),
  ) {
    const { triggers } = heard;
    const completed = new Set([
      ...done,
      ...(heard.discarded ?? []),
      ...triggers.flatMap((trigger) =>
        trigger.type === "watch" ? [trigger.slug] : [],
      ),
    ]);
    if (heard.held) {
      runner.held.set(event.id, {
        event,
        ...(channelId ? { channelId } : {}),
        done: completed,
      });
      if (runner.held.size > HELD_LIMIT) {
        runner.held.delete(runner.held.keys().next().value as string);
        console.warn(
          `Agent ${agent.name} dropped a watched event its roster held`,
        );
      }
    }
    this.heardLive(agent, event, heard.held ? completed : undefined);
    for (const trigger of triggers) {
      const job = {
        trigger,
        ...(channelId ? { channelId } : {}),
        ...(trigger.type === "watch"
          ? {
              matched: {
                object: agent.attention[trigger.slug] as AttentionObject,
                epoch: runner.epoch,
              },
            }
          : {}),
      };
      if (trigger.type === "watch" && runner.catching.has(trigger.slug))
        this.wait(runner, agent, trigger.slug, job);
      else this.submit(runner, agent, job);
    }
  }
  private submit(runner: Runner, agent: Agent, job: Job) {
    const { trigger } = job;
    if (
      (trigger.type === "watch" || trigger.type === "catch-up") &&
      trigger.watch.classifier
    )
      this.classified(runner, agent, { ...job, trigger });
    else this.enqueue(runner, job);
  }
  /** Keeps a live event of a watch catching up until it has, as Janet stages
   * them. Past Janet's bounds the watch stops waiting: what it kept goes on
   * now, out of order, rather than be lost. */
  private wait(runner: Runner, agent: Agent, slug: string, job: Job) {
    const waiting = runner.waiting.get(slug) ?? { jobs: [], bytes: 0 };
    runner.waiting.set(slug, waiting);
    waiting.jobs.push(job);
    waiting.bytes += sizeOf((job.trigger as WatchTrigger).event);
    if (waiting.jobs.length <= WAITING_LIMIT && waiting.bytes <= WAITING_BYTES)
      return;
    console.warn(
      `Agent ${agent.name} heard too much for ${slug} while it caught up; it goes on out of order`,
    );
    const catching = new Set(runner.catching);
    catching.delete(slug);
    this.setCatching(runner, catching);
  }
  /** Sets the watches catching up; the live events of any others that
   * waited go on, oldest first, as the agent has room. */
  private setCatching(runner: Runner, catching: ReadonlySet<string>) {
    runner.catching = catching;
    const released: Job[] = [];
    for (const [slug, { jobs }] of runner.waiting)
      if (!catching.has(slug)) {
        runner.waiting.delete(slug);
        released.push(...jobs);
      }
    if (!released.length) return;
    const event = (job: Job) => (job.trigger as WatchTrigger).event;
    runner.later.push(
      ...released.sort((a, b) => oldestFirst(event(a), event(b))),
    );
    this.admit(runner);
  }
  /** Voids the agent's queued and waiting watch work. */
  private dropWatchWork(runner: Runner) {
    runner.queues.watch.length = 0;
    runner.later.length = 0;
    runner.waiting.clear();
  }
  /** Runs a matched watch's classifier, then queues the event if it passes.
   * The classifier runs after the watch's selectors and filter, and before the
   * event takes a queue slot, as in Janet. Without a key, or when it fails,
   * the event passes and its turn is told why. Results queue in the order the
   * events arrived, whichever call finishes first. A catch-up's events are
   * each classified, and the ones that pass queue together. */
  private classified(
    runner: Runner,
    agent: Agent,
    job: Job & { trigger: WatchTrigger | CatchUpTrigger | SourceTrigger },
  ) {
    const { trigger } = job;
    const events =
      trigger.type === "source"
        ? []
        : trigger.type === "watch"
          ? [trigger.event]
          : trigger.events.map(({ event }) => event);
    const inputs =
      trigger.type === "source"
        ? [{ source: { provider: trigger.watch.provider, text: trigger.text } }]
        : events.map((event) => ({ event }));
    const interest = trigger.watch.interest_id;
    // Never bypassed: without room the event is dropped, like a full queue.
    if (!this.fits(runner, 0, [interest], inputs.length)) {
      if (trigger.type !== "source")
        console.warn(`Agent ${agent.name} dropped an event to classify`);
      return false;
    }
    runner.classifying += inputs.length;
    if (trigger.type === "source") this.sourceJobs.set(job, agent.key);
    const count = (by: number) => {
      const next = (runner.classifyingIn.get(interest) ?? 0) + by;
      if (next) runner.classifyingIn.set(interest, next);
      else runner.classifyingIn.delete(interest);
    };
    count(1);
    // Hands the room it holds to its queued job, or gives it back.
    let reserved = true;
    const unreserve = () => {
      if (!reserved) return;
      reserved = false;
      runner.classifying -= inputs.length;
      count(-1);
    };
    const lifetime = runner.controller.signal;
    // Whether this runner, as it is now, should still act on the event.
    const live = () =>
      !lifetime.aborted &&
      this.runners.get(runner.key) === runner &&
      this.stillCurrent(runner, job);
    // Checked as non-null by the caller.
    const classifier = trigger.watch.classifier as NonNullable<
      EventWatch["classifier"]
    >;
    const outcomes = Promise.all(
      inputs.map((input) =>
        this.classify(runner, agent, classifier, input, live).catch((error) => {
          console.warn(
            `Agent ${agent.name} could not classify an event`,
            error,
          );
          return undefined;
        }),
      ),
    );
    const previous = runner.classified;
    runner.classified = (async () => {
      try {
        await previous;
        const results = await outcomes;
        // A retired or replaced runner keeps none of its work.
        if (lifetime.aborted || this.runners.get(runner.key) !== runner) return;
        unreserve();
        if (trigger.type === "watch" || trigger.type === "source") {
          const [result] = results;
          if (result)
            this.enqueue(runner, {
              ...job,
              trigger: { ...trigger, classifier: result },
            });
          return;
        }
        const passed = events.flatMap((event, index) => {
          const result = results[index];
          return result ? [{ event, classifier: result }] : [];
        });
        if (passed.length)
          this.enqueue(runner, {
            ...job,
            trigger: { ...trigger, events: passed },
          });
      } finally {
        unreserve();
        if (trigger.type === "source") {
          this.sourceJobs.delete(job);
          const object = job.matched?.object;
          if (object && !live()) this.failedSources.add(object);
          if (
            object &&
            sourceCompleted(this.host.record(agent.key).sourceRuns, object)
          )
            await this.completeSource(agent.key, object).catch((error) =>
              console.warn("Attention source completion was not saved", error),
            );
        }
      }
    })();
    return true;
  }
  /** The classifier's outcome for one event, or undefined when it does not
   * pass or should no longer be acted on. */
  private async classify(
    runner: Runner,
    agent: Agent,
    classifier: NonNullable<EventWatch["classifier"]>,
    input:
      | { event: RelayEvent }
      | { source: { provider: string; text: string } },
    live: () => boolean,
  ): Promise<ClassifierOutcome | undefined> {
    const decisions = this.host.decisions();
    if (!decisions) return notRun();
    // A provider still checking its setup, such as reading a saved key, is
    // waited for rather than let the event pass unchecked. One that cannot
    // confirm its setup is still asked: it may be able to answer.
    await statusKnown(decisions);
    const status = decisions.status();
    if (status === "needs-setup" || status === "unavailable") return notRun();
    // Only the copy of the app that holds the agent sends its events out.
    if (!(await this.claim(runner)) || !live()) return undefined;
    const facts: ClassifierInput =
      "event" in input
        ? {
            classifier,
            event: input.event,
            author: {
              role: input.event.pubkey === agent.owner ? "owner" : "other",
              name: this.host.displayName(agent, input.event.pubkey),
            },
            context: await this.host.context(agent, input.event),
          }
        : { classifier, ...input };
    if (!live()) return undefined;
    const { pass, result } = await classify(decisions, {
      ...facts,
      community: agent.relay,
    });
    return pass ? result : undefined;
  }
  /** What `event`, heard `live` or read by catch-up, wakes now, and whether
   * other matching watches still wait for its channel's roster to be
   * confirmed. */
  private heard(
    runner: Runner,
    agent: Agent,
    event: RelayEvent,
    done: ReadonlySet<string> = new Set(),
    live = true,
  ): Heard {
    if (this.stopped[runner.key]?.[event.id] !== undefined)
      return { triggers: [] };
    // Mentions wake an agent only in what the owner's app hears for the
    // owner. An event it has only because watches keep its channel live, or
    // looked the channel up, addresses no one: only watches hear it.
    const addressable = this.host.unattended(agent, event, live);
    // A one-to-one DM is always addressed to the other member, whoever else it
    // names, so no mention is needed. Only new messages: an edit is not a new
    // turn, and a reaction is not conversation. A group DM still needs the
    // mention.
    if (
      addressable &&
      event.kind === 9 &&
      event.pubkey !== agent.pubkey &&
      this.host.dm(agent, event)
    )
      return { triggers: [{ type: "mention", event }] };
    // An addressed event the owner's app hears for the owner never reaches a
    // watch. Only conversation starts a run, not an encrypted DM (kind 4) it
    // cannot read yet. A reaction to its message is not addressed, so a watch
    // can still hear it.
    if (addressable && addressedTo(event, agent.pubkey))
      return CHAT_KINDS.includes(event.kind)
        ? { triggers: [{ type: "mention", event }] }
        : { triggers: [] };
    // An agent whose Attention waits for startup holds what it would hear.
    const waiting =
      !agent.attentionEnabled &&
      this.host.saved(runner.key)?.attentionEnabled === true &&
      this.starting();
    if (!agent.attentionEnabled && !waiting) return { triggers: [] };
    const matches = this.watches(runner, agent).filter(
      ({ slug, watch }) => !done.has(slug) && watchMatches(watch, event),
    );
    if (!matches.length) return { triggers: [] };
    if (waiting) {
      // Not for a stream last seen hidden: Attention was off then, so showing
      // it wakes nothing from before.
      const hidden = (match: (typeof matches)[number]) => {
        const key = streamOf(agent.key, { ...match, event });
        return !!key && !!this.checkpoints[key]?.hidden;
      };
      const discarded = matches.filter(hidden).map(({ slug }) => slug);
      if (discarded.length === matches.length) return { triggers: [] };
      this.heldForStartup = true;
      return { triggers: [], held: true, discarded };
    }
    const reads = this.host.reads(agent, event);
    if (reads === undefined) return { triggers: [], held: true };
    if (!reads) return { triggers: [] };
    const destinations = matches.map(({ watch }) =>
      watch.channel
        ? this.host.member(agent, { tags: [["h", watch.channel]] })
        : true,
    );
    return {
      triggers: matches.flatMap((match, index) =>
        destinations[index]
          ? [{ type: "watch" as const, event, ...match }]
          : [],
      ),
      discarded: matches.flatMap(({ slug }, index) =>
        destinations[index] === false ? [slug] : [],
      ),
      ...(destinations.includes(undefined) ? { held: true as const } : {}),
    };
  }
  /** The job as it should run now, or undefined when it should not run: a
   * watch's event is matched again against the agent's current attention, so
   * one turned off, disabled, removed, replaced or changed since it was
   * queued wakes nothing, even if it now matches again. */
  private current(runner: Runner, agent: Agent, job: Job): Job | undefined {
    const { trigger } = job;
    if (job.sourceCurrent && !job.sourceCurrent()) return undefined;
    if (trigger.type === "source" && job.matched) {
      const { object, epoch } = job.matched;
      return agent.attentionEnabled &&
        epoch === runner.epoch &&
        agent.attention[object.slug] === object &&
        object.value.type === "source" &&
        object.value.enabled
        ? job
        : undefined;
    }
    if (trigger.type !== "watch" && trigger.type !== "catch-up") return job;
    if (!agent.attentionEnabled) return undefined;
    if (
      !job.matched ||
      job.matched.epoch !== runner.epoch ||
      agent.attention[trigger.slug] !== job.matched.object
    )
      return undefined;
    if (trigger.type === "catch-up") {
      const match = this.watches(runner, agent).find(
        ({ slug }) => slug === trigger.slug,
      );
      const events = trigger.events.filter(
        ({ event }) => match && watchMatches(match.watch, event),
      );
      if (!match || !events.length) return undefined;
      return {
        ...job,
        trigger: {
          type: "catch-up",
          slug: trigger.slug,
          watch: match.watch,
          ...(match.interest ? { interest: match.interest } : {}),
          events,
          ...(trigger.skipped ? { skipped: true } : {}),
        },
      };
    }
    const match = this.watches(runner, agent).find(
      ({ slug, watch }) =>
        slug === trigger.slug && watchMatches(watch, trigger.event),
    );
    if (!match) return undefined;
    return {
      ...job,
      trigger: {
        type: "watch",
        event: trigger.event,
        ...match,
        ...(trigger.classifier ? { classifier: trigger.classifier } : {}),
      },
    };
  }

  /** Whether `job`, already started, should still run: the rule `current()`
   * applies to a queued job, asked again for work a type queued itself. */
  private stillCurrent(runner: Runner, job: Job) {
    const agent = this.host.agent(runner.key);
    if (!agent) return false;
    const { trigger } = job;
    if (addressed(trigger)) return true;
    if (
      trigger.type === "watch" ||
      trigger.type === "catch-up" ||
      trigger.type === "source"
    )
      return !!this.current(runner, agent, job);
    // A timer occurrence belongs to the object and epoch it fell due under:
    // attention off and on again, or a disable and rearm, voids it.
    const object = agent.attention[trigger.slug];
    return (
      agent.attentionEnabled &&
      !!job.matched &&
      job.matched.epoch === runner.epoch &&
      object === job.matched.object &&
      object.value.type === "timer" &&
      object.value.enabled
    );
  }

  // Spec schedule rules: occurrence k is due at armed_at + k × interval, at most one
  // runs when overdue, then the next is due interval after it ran. A timer with no
  // saved state counts what was already due as used (see timerState). Checked as a
  // run starts, so no timer has more than one occurrence waiting, and one removed,
  // disabled or expired meanwhile never runs. The longest-waiting timer runs first,
  // so one whose runs outlast its interval cannot hold back the others.
  private dueTimer(
    runner: Runner,
    agent: Agent,
    idle: (interest: string) => boolean,
  ): Job | undefined {
    // Off, timers keep their saved state; one overdue runs once when back on.
    if (!agent.attentionEnabled) return undefined;
    // A pending change may rearm, restart or remove a timer: a later tick
    // runs from the record it saves.
    if (this.host.changing(agent.key)) return undefined;
    const now = seconds();
    const timers = this.host.timers(agent.key);
    let changed: TimerProgress = {};
    let next:
      | {
          slug: string;
          timer: TimerWatch;
          object: AttentionObject;
          state: TimerState;
        }
      | undefined;
    for (const object of Object.values(agent.attention)) {
      const timer = object.value;
      if (timer.type !== "timer" || !timer.enabled) continue;
      const saved = timers[object.slug];
      const state = timerState(timer, saved, now);
      if (state !== saved)
        changed = { ...changed, [object.slug]: { seen: saved, next: state } };
      if (now < state.nextDue || timerSpent(timer, state, now)) continue;
      if (
        timer.channel &&
        this.host.member(agent, { tags: [["h", timer.channel]] }) !== true
      )
        continue;
      // Its Interest's lane is busy: it goes once that lane is free.
      if (!idle(timer.interest_id)) continue;
      if (!next || state.nextDue < next.state.nextDue)
        next = { slug: object.slug, timer, object, state };
    }
    const ran = next && {
      ...next.state,
      used: next.state.used + 1,
      nextDue: now + next.timer.interval_secs,
    };
    if (next && ran)
      changed = {
        ...changed,
        [next.slug]: { seen: timers[next.slug], next: ran },
      };
    if (Object.keys(changed).length) this.host.progress(agent.key, changed);
    if (!next || !ran) return undefined;
    const { slug, timer, object } = next;
    const interest = agent.attention[`interest/${timer.interest_id}`]?.value;
    return {
      trigger: {
        type: "timer",
        slug,
        timer,
        ...(interest?.type === "interest" ? { interest } : {}),
        spent: timerSpent(timer, ran, ran.nextDue),
      },
      matched: { object, epoch: runner.epoch },
    };
  }

  /** Queues `job`, or drops it when the lane is full; returns whether queued. */
  private enqueue(runner: Runner, job: Job) {
    const now = Date.now();
    const lane = laneOf(job.trigger);
    const rate = runner.rates[lane];
    const queue = runner.queues[lane];
    if (now - rate.windowStart >= RATE_WINDOW_MS) {
      rate.windowStart = now;
      rate.admitted = 0;
    }
    const interest = interestOf(job.trigger);
    if (
      !this.fits(
        runner,
        lane === "mention" ? 1 : 0,
        interest === undefined ? [] : [interest],
        0,
      )
    ) {
      if (runner.activityClaimed) {
        this.showWork(runner, job);
        job.work?.finish({
          ok: false,
          error:
            "Agent is busy and could not queue this request. Try again when it finishes.",
        });
      }
      console.warn(
        `Agent ${this.host.agent(runner.key)?.name} dropped an event`,
      );
      return false;
    }
    rate.admitted++;
    if (runner.activityClaimed) this.showWork(runner, job);
    queue.push(job);
    void this.drain(runner);
    return true;
  }
  /** Drops the queued mentions. `forget` forgets the resumed ones saved as
   * working too; otherwise they stay saved for the copy that runs the agent. */
  private dropMentions(runner: Runner, forget = false) {
    const resumed = runner.queues.mention.flatMap(({ trigger }) =>
      trigger.type === "mention" && trigger.resumed ? [trigger.event.id] : [],
    );
    runner.queues.mention.length = 0;
    if (forget && resumed.length) this.unmark(runner.key, resumed);
  }

  private showWork(runner: Runner, job: Job) {
    if (job.work || job.trigger.type !== "mention") return;
    const agent = this.host.agent(runner.key);
    const scope = agent && this.host.scope(agent);
    const event = job.trigger.event;
    const channelId =
      job.channelId ?? event.tags.find(([key]) => key === "h")?.[1];
    if (!scope || !channelId) return;
    const threadRootId = threadReference(event)?.rootId;
    const channel = this.host.channel(agent, event);
    const soloChat =
      channel?.channelType === "solo" &&
      !channel.cached &&
      !channel.pending &&
      !channel.metadataPending;
    const conversationName = channel?.name?.trim();
    job.work = this.host.activity.begin(
      {
        scope,
        agent: runner.member.pubkey,
        channelId,
        messageId: event.id,
        threadRootId: threadRootId ?? event.id,
        ...(threadRootId ? { thread: true } : {}),
        ...(soloChat ? { soloChat: true } : {}),
        ...(soloChat && conversationName ? { conversationName } : {}),
      },
      // Retry queues the same mention again. It was seen when first heard,
      // so it is not marked again; its run saves it as working as any does.
      () =>
        void this.enqueue(runner, {
          trigger: { type: "mention", event },
          ...(job.channelId ? { channelId: job.channelId } : {}),
        }),
    );
    if (
      !soloChat &&
      channel?.channelType === "solo" &&
      channel.pending &&
      !channel.cached &&
      !channel.metadataPending
    ) {
      const starting = this.host.starting?.(agent, channelId);
      if (starting)
        void starting.then(
          () => {
            const confirmed = this.host.channel(agent, event);
            if (
              confirmed?.channelType === "solo" &&
              !confirmed.cached &&
              !confirmed.metadataPending
            )
              job.work?.confirmSolo(confirmed.name ?? undefined);
          },
          () => {},
        );
    }
  }

  // Mentions run one at a time, in arrival order. Beside them, attention work
  // runs in Janet's lanes: each Interest's jobs one at a time, in arrival
  // order and then a due timer, and at most INTEREST_LANES Interests at once;
  // a freed lane goes to the oldest waiting job. Each job runs the agent as it
  // is when the job starts. While its community's session is not live the
  // queue pauses and update() resumes it; a type that cannot run drops what is
  // queued. A mention run that ignores its deadline stops holding its lane
  // when the deadline passes; an Interest's lane is held until its work
  // settles, so its turns never overlap, up to TIMEOUT_LIMIT_MS. Runs are not
  // otherwise fenced.
  private async drain(runner: Runner) {
    if (runner.running || runner.transitioning) return;
    runner.running = true;
    while (this.runners.get(runner.key) === runner) {
      const agent = this.host.ready(runner.key);
      const type = runner.type;
      const run = type?.run;
      // An agent this copy cannot run is left to another copy of the app.
      if (!agent || !type || !run) {
        if (agent) {
          this.host.activity.clear(runner.scope, runner.member.pubkey);
          this.dropMentions(runner);
          runner.queues.watch.length = 0;
        }
        await this.release(runner);
        // It may have come back into view, or gained its type, meanwhile.
        if (this.host.ready(runner.key) !== agent || runner.type !== type)
          continue;
        break;
      }
      // Every copy of the app on this machine hears the same events; only the
      // one holding the agent runs them. Asked on every wake too, so a copy
      // takes over within a tick of the holder quitting or letting go.
      const held = await this.claim(runner);
      if (!held) {
        this.host.activity.clear(runner.scope, runner.member.pubkey);
        runner.activityClaimed = false;
        // Only confirmed custody elsewhere discards this copy's work. An
        // uncertain claim stays closed and retries the same queues on a wake.
        if (held === false) {
          this.dropMentions(runner);
          runner.queues.watch.length = 0;
        }
        break;
      }
      // Retype may have reserved this idle runner while claim was pending.
      if (runner.transitioning) break;
      // The agent or its type may have changed meanwhile.
      if (this.host.ready(runner.key) !== agent || runner.type !== type)
        continue;
      runner.activityClaimed = true;
      for (const queued of runner.queues.mention) this.showWork(runner, queued);
      const next = this.next(runner, agent);
      if (!next) break;
      // Taking a job made room: held and backlogged work may go in now.
      this.admit(runner);
      if (next.job) this.start(runner, agent, type, run, next.lane, next.job);
    }
    runner.running = false;
  }
  /** The job a free lane starts next, taken from its queue; its `job` is
   * undefined when the one taken is no longer current. */
  private next(
    runner: Runner,
    agent: Agent,
  ): { lane: string; job: Job | undefined } | undefined {
    const { mention, watch } = runner.queues;
    if (mention.length && !runner.busy.has("mention"))
      return {
        lane: "mention",
        job: this.current(runner, agent, mention.shift() as Job),
      };
    const attention = runner.busy.size - (runner.busy.has("mention") ? 1 : 0);
    if (attention >= INTEREST_LANES) return undefined;
    const lane = (job: Job) => `interest/${interestOf(job.trigger)}`;
    const index = watch.findIndex((job) => !runner.busy.has(lane(job)));
    if (index >= 0) {
      const [queued] = watch.splice(index, 1) as [Job];
      return { lane: lane(queued), job: this.current(runner, agent, queued) };
    }
    // A due timer, of an Interest with nothing running or waiting.
    const timer = this.dueTimer(
      runner,
      agent,
      (interest) =>
        !runner.busy.has(`interest/${interest}`) &&
        !watch.some((job) => interestOf(job.trigger) === interest),
    );
    return timer && { lane: lane(timer), job: timer };
  }
  /** Runs `job` in `lane`, holding the lane until it may take another. */
  private start(
    runner: Runner,
    agent: Agent,
    type: RegisteredAgentType,
    run: NonNullable<RegisteredAgentType["run"]>,
    lane: string,
    job: Job,
  ) {
    runner.busy.add(lane);
    this.noteWorking();
    if (job.trigger.type === "source") this.sourceJobs.set(job, agent.key);
    const lifetime = runner.controller.signal;
    const signal = AbortSignal.any([
      lifetime,
      AbortSignal.timeout(type.timeoutMs ?? 60_000),
    ]);
    const handle = this.handleFor(runner, agent, true, job.work);
    const anchor = conversationWake(job.trigger, "");
    const destination = !addressed(job.trigger) ? anchor : undefined;
    const working = this.working(
      runner,
      anchor ? { ...job, trigger: anchor, channelId: anchor.channel } : job,
      agent,
    );
    const trigger = job.trigger;
    const named =
      trigger.type === "mention"
        ? (title: string) => this.host.named(agent, trigger.event, title)
        : undefined;
    let attempted = false;
    const woke = () => {
      attempted = true;
      if (!addressed(trigger) && job.matched)
        this.host.woke?.(
          agent.key,
          job.matched.object,
          trigger.type === "watch"
            ? [trigger.event]
            : trigger.type === "catch-up"
              ? trigger.events.map(({ event }) => event)
              : undefined,
        );
    };
    const invoke: typeof run = (delivery) => {
      woke();
      return run(delivery);
    };
    const completion = Promise.resolve().then(async () => {
      if (agent.protection) {
        if (!type.protection || !handle.protection)
          throw new Error(
            type.protectionUnavailable ??
              "This runtime does not support the agent's protection policy",
          );
        handle.protection.assertAvailable();
      }
      const pick = await pickFor(job.trigger, agent, type);
      const start = this.host.start(agent);
      if (!start.ok) throw new Error(start.reason);
      const team = this.host.team(agent.key);
      signal.throwIfAborted();
      const delivery = Object.freeze({
        trigger: job.trigger,
        ...(job.channelId ? { channelId: job.channelId } : {}),
        agent: handle,
        config: start.config,
        revisions: start.revisions,
        ...(start.synced && { synced: start.synced }),
        ...pick,
        ...(team ? { team } : {}),
        signal,
        workingUntil: working.hold,
        ...(job.work
          ? {
              ignored: () => job.work?.remove(),
              acknowledged: () => job.work?.started(),
              superseded: () => job.work?.supersede(),
              interruptible: (stop: () => Promise<void>) =>
                job.work?.interruptible(stop),
              step: (tool: string, target?: string) =>
                job.work?.step(tool, target),
            }
          : {}),
        ...(named ? { named } : {}),
        current: () =>
          !lifetime.aborted &&
          this.stillCurrent(runner, job) &&
          (!destination ||
            this.host.member(agent, wakeAnchor(destination)) === true),
      });
      const runOnce = type.runOnce?.bind(type);
      if (addressed(trigger)) return invoke(delivery);
      if (anchor) {
        if (!delivery.current()) return;
        if (anchor.root) {
          if (!(await this.rootInChannel(agent, anchor.channel, anchor.root)))
            throw new Error("The delivery root is not in its channel");
          if (!delivery.current()) return;
        }
        const wakeText = () =>
          wakePrompt(
            handle,
            trigger,
            trigger.slug.replace(/^watch\//, ""),
            delivery.current,
          );
        const text = await wakeText();
        if (!text || !delivery.current()) return;
        return invoke({
          ...delivery,
          channelId: anchor.channel,
          trigger: { ...anchor, text },
          wakeText,
        });
      }
      if (!runOnce) return invoke(delivery);
      // A watch or timer is a standalone turn; this lane is held until it ends.
      delivery.workingUntil(
        wake(
          handle,
          trigger,
          delivery.current,
          (key, prompt) =>
            standalone(lifetime, (signal) => {
              woke();
              return runOnce({ delivery, key, signal, prompt });
            }),
          type.title,
        ),
      );
    });
    void working.settled
      .then(async () => {
        this.sourceJobs.delete(job);
        if (
          lifetime.aborted ||
          !working.ok() ||
          !attempted ||
          !this.stillCurrent(runner, job)
        ) {
          if (trigger.type === "source" && job.matched)
            this.failedSources.add(job.matched.object);
          return;
        }
        const object = job.matched?.object;
        if (!object) return;
        if (
          trigger.type === "source" &&
          sourceCompleted(this.host.record(agent.key).sourceRuns, object)
        )
          await this.completeSource(agent.key, object);
        if (trigger.type === "timer")
          await this.host.change(agent.key, (record) =>
            record.attention[object.slug] === object &&
            timerSpent(
              trigger.timer,
              timerState(
                trigger.timer,
                record.timers?.[object.slug],
                Math.floor(Date.now() / 1000),
              ),
              Math.floor(Date.now() / 1000),
            )
              ? setAttention(record, object.slug, null)
              : record,
          );
      })
      .catch((error) =>
        console.warn("Completed subscription was not removed", error),
      );
    // Handover expiry releases the queue, never the actual work's outcome.
    void completion.then(
      () => working.release(),
      (error) => working.release({ ok: false, error: message(error) }),
    );
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    const returned = Promise.race([completion, aborted]).catch((error) => {
      if (!lifetime.aborted)
        console.error(`Agent run failed: ${agent.name}`, error);
    });
    // An Interest's next turn waits for all of this one's work, however it
    // handed it off, as Janet's lanes do.
    const held =
      lane === "mention"
        ? returned
        : returned.then(() =>
            Promise.race([
              working.settled,
              new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  console.warn(
                    `Agent ${agent.name} ${lane} is still working; its lane goes on`,
                  );
                  resolve();
                }, TIMEOUT_LIMIT_MS);
                void working.settled.then(() => clearTimeout(timer));
              }),
            ]),
          );
    void held.then(() => {
      runner.busy.delete(lane);
      this.noteWorking();
      void this.drain(runner);
    });
  }

  /** The agent as `run` holds it. */
  private handleFor(
    runner: Runner,
    agent: Agent,
    run = false,
    work?: ReturnType<LocalAgentActivity["begin"]>,
  ): AgentHandle {
    // Taken now, as a type change replaces the controller.
    const lifetime = runner.controller.signal;
    const protection = this.host.protection?.(agent);
    const handle = guarded(
      {
        protection: protection && {
          ...protection,
          check: (action: ProtectionAction, signal: AbortSignal) =>
            protection.check(action, AbortSignal.any([lifetime, signal])),
        },
        key: agent.key,
        pubkey: agent.pubkey,
        name: agent.name,
        owner: agent.owner,
        // What acts as the agent stops with it: a turn still working once it
        // is deleted, removed from this community or retyped can't.
        publish: async (event: AgentEventTemplate, check?: () => void) => {
          lifetime.throwIfAborted();
          const destination = event.tags?.find((tag) => tag[0] === "h")?.[1];
          const ownReply =
            event.kind === 9 && !!work && destination === work.channelId;
          const sent = ownReply ? work.sending() : undefined;
          try {
            const published = await this.publish(
              runner,
              event,
              lifetime,
              check,
            );
            if (ownReply) {
              const channel = this.host.channel(agent, published);
              if (
                channel?.channelType === "solo" &&
                !channel.cached &&
                !channel.pending &&
                !channel.metadataPending
              )
                work.confirmSolo(channel.name ?? undefined);
              work.reply(published.id);
            }
            return published;
          } catch (error) {
            const uncertain = ownReply && unconfirmedAgentEvent(error);
            if (uncertain) work.reply(uncertain);
            throw error;
          } finally {
            sent?.();
          }
        },
        query: async (filters: readonly object[]) => {
          lifetime.throwIfAborted();
          return this.require().query(agent, filters);
        },
        searchProfiles: async (query: string, limit: number) => {
          lifetime.throwIfAborted();
          return this.require().searchProfiles(agent, query, limit);
        },
        upload: async (data: string, mime: string) => {
          lifetime.throwIfAborted();
          return this.require().upload(agent, data, mime);
        },
        media: async (url: string) => {
          lifetime.throwIfAborted();
          return this.require().media(agent, url);
        },
        gitAuth: async (owner: string, repo: string) => {
          lifetime.throwIfAborted();
          return this.require().gitAuth(agent, owner, repo);
        },
        remember: async (slug: string, body: string | null, after: number) => {
          lifetime.throwIfAborted();
          const event = await this.require().remember(agent, slug, body, after);
          this.host.remembered(agent.key, slug, body);
          return event;
        },
        agentTypes: () => this.host.agentTypes(),
        // Drafts outlive the run's handover deadline, as a turn still working may
        // submit one, but not the agent or its type.
        createAgent: async (input: AgentCreationInput) => {
          lifetime.throwIfAborted();
          return this.host.createAgent(agent, input);
        },
        updateAgent: async (input: AgentUpdateInput) => {
          lifetime.throwIfAborted();
          return this.host.updateAgent(agent, input);
        },
        // Only a run hands off: a plugin's wake through `Agents.handle` would
        // read as the agent's own.
        ...(run && {
          handoff: (handoff: AgentHandoff) => {
            lifetime.throwIfAborted();
            this.host.handoff(agent, handoff);
          },
        }),
        templates: () => this.host.templates(agent),
        tabs: () => this.host.tabs(agent),
        notes: (channelId: string, root?: string) => {
          const pending = runner.notes.get(channelId) ?? [];
          const matches = (note: { root: string | undefined }) =>
            root === undefined || note.root === root;
          const notes = pending.filter(matches);
          const kept = pending.filter((note) => !matches(note));
          if (kept.length) runner.notes.set(channelId, kept);
          else runner.notes.delete(channelId);
          return notes.map((note) => note.text);
        },
        attention: this.attention(agent.key, lifetime),
      },
      () => lifetime.throwIfAborted(),
    );
    return Object.freeze({
      ...handle,
      // Compensation for an undelivered request can settle after retirement.
      // It only returns local notes to this runner; acting as the agent stays
      // guarded by the old lifetime above.
      restoreNotes: (
        channelId: string,
        notes: readonly string[],
        root?: string,
      ) => {
        if (notes.length)
          runner.notes.set(channelId, [
            ...notes.map((text) => ({ text, root })),
            ...(runner.notes.get(channelId) ?? []),
          ]);
      },
    });
  }

  /** Counts a run as working until it and everything it handed to
   * `workingUntil` have settled, however long that takes. A
   * mention run is shown typing in its thread meanwhile, from its first
   * `workingUntil`: a runtime that ignores the mention never shows it. Its
   * activity stays on this device. */
  private working(
    runner: Runner,
    { trigger, channelId, work }: Job,
    agent: Agent,
  ) {
    work?.started();
    // A plugin wake types where it posts: its thread, a Solo chat, or the
    // channel explicitly addressed by a subscription, never its own id.
    const wake =
      trigger.type === "plugin" || trigger.type === "attention"
        ? trigger
        : undefined;
    const event =
      trigger.type === "mention"
        ? trigger.event
        : wake && { id: wake.root ?? wake.id, tags: [["h", wake.channel]] };
    const channel =
      event && (channelId ?? event.tags.find((tag) => tag[0] === "h")?.[1]);
    // Saved while it works, so a reload that stops it gives it again. A
    // plugin's wake has no event to read again.
    const resumable =
      trigger.type === "mention" && runner.type?.resumes
        ? trigger.event.id
        : undefined;
    if (resumable) this.mark(runner.key, resumable, channel ?? "");
    let typing: (() => void) | undefined;
    const beginTyping = () => {
      if (typing || !event || !channel) return;
      typing = pulseTyping(
        // Straight to custody, so pulses stay out of what it wrote.
        async (pulse) => this.require().publish(runner.member, pulse),
        // Where its turn answers, read the same way.
        this.host
          .soloChat(agent, channel, runner.controller.signal)
          .then((flat) => {
            if (wake && !wakeLands(wake, flat))
              throw new Error("The wake has no conversation here");
            return flat || wake?.topLevel === true;
          }),
        event,
        channel,
        runner.typing,
      );
    };
    let holds = 1;
    let outcome: WorkOutcome = { ok: true };
    const lifetime = runner.controller.signal;
    let stopped!: () => void;
    const settled = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    runner.working++;
    this.noteWorking();
    const stop = () => {
      if (holds < 0) return;
      holds = -1;
      stopped();
      lifetime.removeEventListener("abort", abort);
      runner.working--;
      this.noteWorking();
      typing?.();
      if (resumable) this.unmark(runner.key, [resumable]);
    };
    const abort = () => {
      work?.remove();
      stop();
    };
    lifetime.addEventListener("abort", abort, { once: true });
    const release = (result?: unknown) => {
      if (holds <= 0) return;
      if (
        result &&
        typeof result === "object" &&
        "ok" in result &&
        result.ok === false
      ) {
        outcome = {
          ok: false,
          error:
            "error" in result
              ? String(result.error)
              : "Could not finish this request",
        };
      } else if (
        result &&
        typeof result === "object" &&
        "stopped" in result &&
        result.stopped === true &&
        outcome.ok
      )
        outcome = { ok: true, stopped: true };
      if (--holds === 0) {
        work?.finish(outcome);
        stop();
        this.host.finished(agent.key);
      }
    };
    return {
      ok: () => outcome.ok && !outcome.stopped,
      /** Settles once the run and all it handed off have, or it is retired. */
      settled,
      hold(pending: PromiseLike<unknown>) {
        if (holds <= 0) return;
        holds++;
        beginTyping();
        Promise.resolve(pending).then(release, (error) =>
          release({ ok: false, error: message(error) }),
        );
      },
      release,
    };
  }

  private claimed(runner: Runner, held: boolean) {
    const before = this.runs(runner.key);
    runner.mayHold = held;
    runner.asked = true;
    this.heldChanged(runner, before);
    if (before !== this.runs(runner.key)) this.host.ownershipChanged?.();
    return held;
  }
  private claim(runner: Runner) {
    return this.custodied(runner.member.pubkey, async () => {
      try {
        return this.claimed(
          runner,
          (await this.host.custody?.claim(runner.member.pubkey)) ?? false,
        );
      } catch (error) {
        this.claimed(runner, false);
        // Uncertain custody must not admit a stale protection policy.
        console.warn(
          `Agent ${this.host.agent(runner.key)?.name} was not claimed`,
          error,
        );
        return undefined;
      }
    });
  }
  /** Runs `step` once the agent's earlier claims and releases settle.
   * Custody holds the agent, which its runners in each community share, so
   * one never lets go while another's claim is answered but not yet known. */
  private custodied<T>(pubkey: string, step: () => Promise<T>): Promise<T> {
    const prior = this.custody.get(pubkey);
    const done = prior ? prior.then(step) : step();
    const settled = done.then(
      () => {},
      () => {},
    );
    this.custody.set(pubkey, settled);
    void settled.then(() => {
      if (this.custody.get(pubkey) === settled) this.custody.delete(pubkey);
    });
    return done;
  }
  /** The notice lists an agent's saved turns only while this copy holds it,
   * so a change in holding lists it again. */
  private heldChanged(runner: Runner, held: boolean) {
    if (this.left[runner.key] && this.runs(runner.key) !== held)
      this.host.interrupted.changed();
  }
  /** Claims exclusively for a provider migration. Unlike turn execution,
   * uncertainty is unsafe here because changing native type is destructive. */
  private claimForRetype(runner: Runner) {
    return this.custodied(runner.member.pubkey, async () =>
      this.claimed(
        runner,
        (await this.host.custody?.claim(runner.member.pubkey)) ?? false,
      ),
    );
  }
  private async release(runner: Runner) {
    if (!runner.mayHold) return;
    this.claimed(runner, false);
    const { pubkey } = runner.member;
    await this.custodied(pubkey, async () => {
      // It stays held while the agent runs here in another community.
      for (const other of this.runners.values())
        if (other.member.pubkey === pubkey && this.runs(other.key)) return;
      await this.host.custody
        ?.release(pubkey)
        .catch((error) =>
          console.warn(`Agent ${pubkey} was not released`, error),
        );
    });
  }

  private async rootInChannel(
    member: Membership,
    channel: string,
    root: string,
  ) {
    const roots = await this.require().query(member, [
      { ids: [root], kinds: [9, 40002], "#h": [channel], limit: 1 },
    ]);
    return roots.some(
      (event) =>
        event.id === root &&
        [9, 40002].includes(event.kind) &&
        channelOf(event) === channel,
    );
  }

  /** The agent's attention as its handle offers it, until `lifetime` ends.
   * Reads the saved record each call, so it is current however long the run
   * lasts. */
  private attention(key: AgentKey, lifetime: AbortSignal): AgentAttention {
    const record = () => this.host.record(key);
    return guarded(
      {
        enabled: () =>
          record().attentionEnabled === true && this.host.attentionShown(),
        classifier: () => this.host.classifier(),
        show: async (slug: string, interest?: string) => {
          const result = await show(record(), slug, seconds(), interest);
          const object = result.object;
          const agent = this.host.agent(key);
          if (
            !agent ||
            !object ||
            object.type === "interest" ||
            !object.channel
          )
            return result;
          const member = this.host.member(agent, {
            tags: [["h", object.channel]],
          });
          if (member === true && object.root) {
            let valid: boolean;
            try {
              valid = await this.rootInChannel(
                agent,
                object.channel,
                object.root,
              );
            } catch {
              return {
                ...result,
                delivery: {
                  status: "held" as const,
                  reason:
                    "Could not verify the delivery root. Retry when relay reads are available; you can still edit or disable this watch.",
                },
              };
            }
            if (!valid)
              return {
                ...result,
                delivery: {
                  status: "blocked" as const,
                  reason:
                    "Delivery root was not found in its channel. Set root to an accessible message in that channel or remove root for channel-level delivery. Rearm a spent timer to retry it.",
                },
              };
          }
          return member === true
            ? result
            : {
                ...result,
                delivery:
                  member === undefined
                    ? {
                        status: "held" as const,
                        reason: "Waiting for confirmed destination membership.",
                      }
                    : {
                        status: "blocked" as const,
                        reason:
                          "Agent is not a member of the delivery channel.",
                      },
              };
        },
        interests: (search?: string) => interestIds(record(), search),
        watches: (filter: WatchFilter = {}) =>
          watchSummaries(record(), filter, seconds()),
        write: async (
          slug: string,
          value: AttentionValue | null,
          options: WriteOptions,
          check?: () => void,
        ) => {
          // The token is checked against the newest saved record, in turn
          // with the other changes to it, so no change lands between.
          const after = await this.host.change(key, async (before) => {
            lifetime.throwIfAborted();
            check?.();
            const next = await checkedWrite(
              before,
              slug,
              value,
              options,
              seconds(),
            );
            lifetime.throwIfAborted();
            check?.();
            return next;
          });
          return show(after, slug, seconds());
        },
      },
      () => lifetime.throwIfAborted(),
    );
  }

  private require() {
    if (!this.host.custody)
      throw new Error("Agents run only in the desktop app");
    return this.host.custody;
  }
  private async publish(
    runner: Runner,
    event: AgentEventTemplate,
    lifetime: AbortSignal,
    check?: () => void,
  ) {
    const channel = event.tags?.find((tag) => tag[0] === "h")?.[1];
    const agent = this.host.agent(runner.key);
    // The relay takes a reply in a starting chat only once it confirms it;
    // a failed start leaves the relay to refuse it.
    if (channel && agent) {
      await this.host.starting?.(agent, channel)?.catch(() => {});
      lifetime.throwIfAborted();
    }
    check?.();
    return this.require().publish(runner.member, event);
  }
}

const AsyncFunction = (async () => {}).constructor;

/** `target`, with `live()` checked before each of its calls, however deep:
 * its async methods reject when it fails, and the others throw. */
function guarded<T extends object>(target: T, live: () => void): T {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        typeof value !== "function"
          ? value && typeof value === "object"
            ? Array.isArray(value)
              ? Object.freeze(
                  value.map((item) =>
                    item && typeof item === "object"
                      ? guarded(item, live)
                      : item,
                  ),
                )
              : guarded(value, live)
            : value
          : value.constructor === AsyncFunction
            ? async (...args: unknown[]) => {
                live();
                return value(...args);
              }
            : (...args: unknown[]) => {
                live();
                return value(...args);
              },
      ]),
    ),
  ) as T;
}

/** Runs a standalone turn with a signal that also aborts
 * STANDALONE_DEADLINE_MS after it starts, so the deadline covers the
 * harness's readiness wait as well as the turn. */
async function standalone<T>(
  lifetime: AbortSignal,
  turn: (signal: AbortSignal) => Promise<T>,
) {
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new Error(
          `The turn ran past its ${STANDALONE_DEADLINE_MS / 1000}s deadline and was stopped`,
        ),
      ),
    STANDALONE_DEADLINE_MS,
  );
  try {
    return await turn(AbortSignal.any([lifetime, deadline.signal]));
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the selected provider's status is not `checking`. */
function statusKnown(decisions: Decisions): Promise<void> {
  if (decisions.status() !== "checking") return Promise.resolve();
  return new Promise((resolve) => {
    const stop = decisions.subscribe(() => {
      if (decisions.status() === "checking") return;
      stop();
      resolve();
    });
  });
}
