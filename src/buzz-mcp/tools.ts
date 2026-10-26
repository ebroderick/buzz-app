// The Buzz tools: what an agent does in Buzz, in the wire formats the `buzz`
// CLI writes. Names, arguments and descriptions are kept short because every
// session pays for them in context. Each tool answers in plain text.
import { decode, npubEncode } from "nostr-tools/nip19";
import buzzHelp from "../../docs/buzz-help.md?raw";
import { CANVAS_HISTORY_PAGE } from "../features/channel-templates/canvas-limits";
import {
  canonicalDetailsName,
  detailsDraftErrors,
} from "../features/relay/channel-details-protocol";
import {
  lifecycleChannelId,
  lifecycleTemplate,
} from "../features/relay/channel-lifecycle-protocol";
import {
  PROFILE_SEARCH_MAX,
  PROFILE_SEARCH_QUERY_MAX,
} from "../features/relay/profile-search";
import {
  attachmentMarkdown,
  attachmentName,
} from "../features/relay/attachments";
import {
  communityEmoji,
  contentEmojiTags,
  EMOJI_SET,
  EMOJI_SET_KIND,
  referencedEmoji,
} from "../features/relay/emoji";
import { newer } from "../features/relay/events";
import { imageType } from "../features/relay/attachment-limits";
import { LIVE_CANVAS_BYTES } from "../features/channel-templates/model";
import { threadReference } from "../features/relay/thread-reference";
import { parseBuzzLink } from "../features/navigation/buzz-links";
import { soloChannelMetadata } from "../features/relay/discovery";
import { channelLabelTags } from "../features/relay/channel-labels";
import { SOLO_LABEL, SOLO_NAMED_LABEL } from "../features/solo/labels";
import type { RelayEvent } from "../features/relay/events";
import { attestedOwner } from "../features/agents/owner-attestation";
import type {
  BuzzClient,
  BuzzEvent,
  ChannelTemplate,
  Context,
  Filter,
  Memory,
  Upload,
} from "./client";

const ROLES = ["owner", "admin", "member", "guest", "bot"];
const str = { type: "string" } as const;
const strs = { type: "array", items: str } as const;
// Shared by send and reply_in_subthread.
const audience = {
  type: "string",
  enum: ["everyone", "agents"],
  description:
    "agents: only other agents need this (delegating, asking or answering an agent)",
} as const;
const final = {
  type: "boolean",
  description: "Your last message this turn; ends the turn.",
} as const;
/** The channel types a channel list can ask for, as NIP-CL names them. */
const CHANNEL_TYPES = ["stream", "forum", "dm", "workflow", "system"];
const ttl = {
  type: "integer",
  description: "Seconds without a message before it archives; 0: never.",
} as const;
const joinRole = {
  type: "string",
  enum: ["member", "guest"],
  description:
    "Role for people who join or are added without one. guest on an open channel: anyone reads, only members post.",
} as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[] = [],
  annotations?: Readonly<{ readOnlyHint: boolean; destructiveHint?: boolean }>,
) => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  ...(annotations ? { annotations } : {}),
});

export type Tool = ReturnType<typeof tool>;

/** Capture built-in outgoing text before review. Dispatch receives these same
 * arguments, so an approved path cannot supply different bytes afterward. */
export async function captureToolBody(
  client: BuzzClient,
  name: string,
  args: Record<string, unknown>,
) {
  if (
    (name === "agent_create" || name === "agent_update") &&
    text(args.picture)
  )
    throw new Error("Protected picture uploads are not supported.");
  const message = name === "send" || name === "reply_in_subthread";
  if (
    !message &&
    name !== "mem_set" &&
    name !== "notes_set" &&
    name !== "canvas_set"
  )
    return;
  if (message && list(args.files).length)
    throw new Error(
      "Protected attachment uploads are not supported; send reviewable text instead.",
    );
  const path = text(args.path);
  if (!path) return;
  args[name === "canvas_set" ? "content" : "text"] = new TextDecoder().decode(
    await client.read(path),
  );
  delete args.path;
}

export const TOOLS: readonly Tool[] = [
  tool(
    "buzz_help",
    "Read the bundled guide to using Buzz: chats, communities, identity, agents, and settings.",
    {},
  ),
  tool(
    "agent_types",
    "List installed local agent types available for agent_create.",
    {},
  ),
  tool(
    "agent_create",
    "Submit an unsaved agent-creation draft for your owner to review. Nothing is created until they save it. Use a type key from agent_types; picture is a local image file for its avatar.",
    { type: str, name: str, picture: str },
    ["type", "name"],
  ),
  tool(
    "agent_update",
    "Submit an unsaved draft of changes to one of your owner's agents, yourself included, for them to review. agent is its pubkey or exact name; type is a key from agent_types; picture is a local image file for its avatar. Nothing changes until they save it.",
    { agent: str, name: str, type: str, instructions: str, picture: str },
    ["agent"],
  ),
  tool(
    "send",
    "Post a message. Without channel, replies in the current thread. A reply goes in its message's thread.",
    {
      text: str,
      path: str,
      channel: str,
      reply: str,
      files: strs,
      mentions: strs,
      audience,
      final,
    },
    ["audience"],
  ),
  tool(
    "reply_in_subthread",
    "Reply under a specific message, nested in a subthread below it rather than in the main thread. Use when asked to reply in a subthread, or to keep a side discussion under the message it is about. Takes send's text, path, files, mentions, audience and final; the channel is the parent's.",
    {
      parent: { ...str, description: "Id of the message to reply under" },
      text: str,
      path: str,
      files: strs,
      mentions: strs,
      audience,
      final,
    },
    ["parent", "audience"],
  ),
  tool(
    "self_handoff",
    "Hand off to yourself in another of your conversations, waking that session with text. thread: any of its messages, outside a Solo chat.",
    { channel: str, thread: str, text: str },
    ["channel", "text"],
  ),
  tool("edit", "Edit your message.", { id: str, text: str }, ["id", "text"]),
  tool(
    "delete",
    "Delete one of your own messages: only the message with this id, never another author's.",
    { id: str },
    ["id"],
    { readOnlyHint: false, destructiveHint: true },
  ),
  tool(
    "react",
    "React to a message.",
    { id: str, emoji: str, off: { type: "boolean" } },
    ["id", "emoji"],
  ),
  tool(
    "read",
    "Read a thread (default: current), a channel's latest, or search with q.",
    {
      channel: str,
      thread: str,
      message_url: {
        type: "string",
        description: "Buzz message link; replaces channel and thread.",
      },
      q: str,
      author: {
        type: "string",
        description: "With q or channel: only this hex pubkey or npub.",
      },
      since: {
        type: "integer",
        description: "With q or channel: Unix seconds, at or after.",
      },
      before: { type: "integer", description: "Unix seconds, at or before." },
      before_id: {
        type: "string",
        description: "For paginating: with before, from a continue line.",
      },
      limit: {
        type: "integer",
        description: "Search 20 (max 100), thread 100 (500), channel 30 (200).",
      },
    },
  ),
  tool(
    "channel_list",
    "Channels you are in; with all, every one you can see. System channels are listed only when types has system.",
    {
      q: str,
      all: { type: "boolean" },
      types: {
        type: "array",
        items: { type: "string", enum: CHANNEL_TYPES },
        minItems: 1,
        uniqueItems: true,
      },
    },
  ),
  tool("channel_get", "A channel's details (default: current).", {
    channel: str,
  }),
  tool(
    "channel_create",
    "Create a channel. template: one of your owner's, by name. solo: a private Solo chat, with members added in the create.",
    {
      name: str,
      visibility: { type: "string", enum: ["open", "private"] },
      about: str,
      type: {
        type: "string",
        enum: ["stream", "forum", "system"],
        description:
          "system: left out of ordinary channel lists; anyone can still list an open one.",
      },
      ttl,
      join_role: joinRole,
      template: str,
      solo: { type: "boolean" },
      members: { ...strs, description: "Solo only: pubkeys or npubs." },
    },
    ["name", "visibility"],
  ),
  tool("channel_update", "Change a channel's details.", {
    channel: str,
    name: str,
    about: str,
    visibility: { type: "string", enum: ["open", "private"] },
    ttl,
    join_role: joinRole,
    topic: str,
    purpose: str,
  }),
  tool("channel_join", "Join a channel.", { channel: str }),
  tool("channel_leave", "Leave a channel.", { channel: str }),
  tool("channel_archive", "Archive a channel.", { channel: str }),
  tool("channel_unarchive", "Unarchive a channel.", { channel: str }),
  tool("channel_delete", "Delete a channel permanently.", { channel: str }),
  tool("member_list", "A channel's members (default: current).", {
    channel: str,
    limit: { type: "integer", description: "Default 100, max 500." },
    offset: {
      type: "integer",
      description: "Members to skip, from a continue line.",
    },
  }),
  tool(
    "member_add",
    "Add pubkeys or npubs to a channel, optionally with a role.",
    { channel: str, pubkeys: strs, role: { type: "string", enum: ROLES } },
    ["pubkeys"],
  ),
  tool(
    "member_remove",
    "Remove pubkeys or npubs from a channel.",
    { channel: str, pubkeys: strs },
    ["pubkeys"],
  ),
  tool("users", "Profiles by pubkey or name.", { ids: strs, q: str }),
  tool("dm", "Open a DM; returns its channel.", { to: strs }, ["to"]),
  tool(
    "mem_get",
    "Read memory: slug gives its version and text; q finds entries with every word; neither lists slugs.",
    { slug: str, q: str },
  ),
  tool(
    "mem_set",
    "Write memory. To replace an entry, pass the version from your latest mem_get or mem_set of it as expected; without expected it only creates.",
    { slug: str, text: str, path: str, expected: str },
    ["slug"],
  ),
  tool(
    "mem_rm",
    "Delete memory. Pass the version from your latest mem_get of it as expected. core cannot be deleted.",
    { slug: str, expected: str },
    ["slug", "expected"],
  ),
  tool(
    "notes_get",
    "Read a shared note, such as a team runbook, by name; without name, list notes. author: me (default for lists), all, an npub, a hex pubkey or a display name.",
    {
      name: str,
      author: str,
      latest: { type: "boolean" },
      tag: str,
      limit: { type: "integer" },
    },
  ),
  tool(
    "notes_set",
    "Publish your note under name, replacing your earlier one. title is needed the first time; title, summary and tags carry over when left out.",
    { name: str, title: str, summary: str, tags: strs, text: str, path: str },
    ["name"],
  ),
  tool("notes_rm", "Delete your note.", { name: str }, ["name"]),
  tool("canvas_get", "Read a channel's canvas.", { channel: str }),
  tool(
    "canvas_set",
    `Replace a channel's canvas (at most ${LIVE_CANVAS_BYTES / 1024} KiB).`,
    {
      channel: str,
      content: str,
      path: str,
    },
  ),
  tool(
    "canvas_history",
    "A channel's canvas revisions, newest first: each one's id, time, author, size and first line. The first page starts with the canvas's version.",
    {
      channel: str,
      before: { type: "integer", description: "Unix seconds, at or before." },
      before_id: {
        type: "string",
        description: "For paginating: with before, from a continue line.",
      },
    },
    [],
    { readOnlyHint: true },
  ),
  tool(
    "canvas_restore",
    "Republish an earlier canvas revision as the newest one; history is kept. Pass the version from the first page of your latest canvas_history as expected.",
    { id: str, channel: str, expected: str },
    ["id", "expected"],
    { readOnlyHint: false, destructiveHint: true },
  ),
  tool(
    "media_get",
    "Get a file of any type from a Buzz media URL: saves it locally and gives its path; an image is also shown.",
    { url: str },
    ["url"],
  ),
  tool(
    "repo",
    "A channel's Git repository (default: current): its URL and a header that lets git clone, fetch and push it as you for 60 seconds. create starts one for the channel.",
    {
      channel: str,
      create: { type: "string", description: "The new repository's name." },
      repo: { type: "string", description: "owner/name, when it has several." },
    },
  ),
  tool(
    "tabs",
    "Your owner's open tabs for this channel's threads, or open, close or rename a thread's tab. Opening never takes their focus; no name clears a rename.",
    {
      action: { type: "string", enum: ["open", "close", "rename"] },
      thread: str,
      name: str,
    },
  ),
];

/** Message kinds as the CLI reads them. */
const MESSAGES = [9, 40002, 40008, 45001, 45003];
const THREAD = [9, 40002, 40008, 45003];
const SEARCH = [9, 40002, 45001, 45003];
const HEX = /^[0-9a-f]{64}$/;
/** A NIP-23 long-form note, as `buzz notes` writes it. */
const NOTE = 30023;
/** A repository name the community accepts. */
const REPO = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/;
/** Pages of a channel's repository announcements read before giving up. */
const REPO_PAGES = 5;
/** Each agent's repository creation in progress, so its turns start one at a
 * time: a second could otherwise pass the same checks and rebind the first. */
const creating = new Map<string, Promise<unknown>>();
/** A read's page size and scan budget. */
const PAGE = 500;
const MAX_EVENTS = 10_000;
const CHANNEL_BYTES = 16_384;
const CHANNEL_PARTIAL =
  "Partial channel list: scan or output limit reached. Narrow with q or use a known channel ID.";
type Args = Readonly<Record<string, unknown>>;
/** A tool's answer: text, or an image (base64 `data`) for the agent to see,
 * with any `text` about it. */
export type Reply =
  | string
  | Readonly<{ data: string; type: string; text?: string }>;
type Handler = (tools: Tools, args: Args) => Promise<Reply>;

/** Runs tool `name` for an agent working in `context`. A throw is a tool
 * error for the agent to correct. */
export function callTool(
  client: BuzzClient,
  context: Context,
  name: string,
  args: Args,
) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`No tool ${name}`);
  // A channel or member tool refuses arguments it does not list, so a
  // misspelled target cannot fall back to the current channel.
  if (name.startsWith("channel_") || name.startsWith("member_")) {
    const listed =
      TOOLS.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
    const extra = Object.keys(args).filter(
      (key) => !Object.hasOwn(listed, key),
    );
    if (extra.length)
      return Promise.reject(
        new Error(`${extra.join(", ")} cannot be used with ${name}.`),
      );
  }
  return handler(new Tools(client, context), args);
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  async buzz_help() {
    return buzzHelp.trim();
  },
  async agent_types({ client }) {
    if (!client.agentTypes)
      throw new Error("Agent creation is unavailable on this host");
    return JSON.stringify(await client.agentTypes());
  },
  async agent_create({ client }, args) {
    if (!client.createAgent)
      throw new Error("Agent creation is unavailable on this host");
    const type = text(args.type)?.trim();
    const name = text(args.name)?.trim();
    if (!type || !name) throw new Error("type and name are required");
    const picture = proposedPicture(client, args.picture);
    return JSON.stringify(
      await client.createAgent({ type, name, ...(picture && { picture }) }),
    );
  },
  async self_handoff(tools, args) {
    const { client, context } = tools;
    if (!client.handoff) throw new Error("Self-handoff is unavailable here");
    const channel = required(args, "channel");
    const body = text(args.text);
    if (!body) throw new Error("text is required.");
    const thread = text(args.thread);
    const [metadata, event] = await Promise.all([
      tools.metadata(channel),
      thread ? tools.event(thread) : undefined,
    ]);
    if (!metadata) throw unseen(channel);
    if (
      event &&
      !event.tags.some(([name, value]) => name === "h" && value === channel)
    )
      throw new Error(`${thread} is not in ${channel}.`);
    // A harness takes a wake with no thread only in a Solo chat.
    if (!event && !soloChannelMetadata(metadata as RelayEvent))
      throw new Error("thread is required outside a Solo chat.");
    const root = event && rootOf(event);
    if (
      channel === context.channel &&
      (!context.root || context.wholeChannel || root === context.root)
    )
      throw new Error("That is this conversation.");
    const { channel: from, root: fromRoot } = context;
    client.handoff({
      channel,
      ...(root && { root }),
      text: body,
      from: {
        ...(from && { channel: from }),
        ...(fromRoot && { root: fromRoot }),
      },
    });
    return root ? `Handed off to thread ${root}.` : `Handed off to ${channel}.`;
  },
  async agent_update({ client }, args) {
    if (!client.updateAgent)
      throw new Error("Agent changes are unavailable on this host");
    const agent = text(args.agent);
    if (!agent) throw new Error("agent is required");
    const name = text(args.name);
    const type = text(args.type);
    // Empty instructions propose clearing them.
    const { instructions } = args;
    const picture = proposedPicture(client, args.picture);
    return JSON.stringify(
      await client.updateAgent({
        agent,
        ...(name && { name }),
        ...(type && { type }),
        ...(typeof instructions === "string" && { instructions }),
        ...(picture && { picture }),
      }),
    );
  },
  async send(tools, args) {
    const { context } = tools;
    const reply =
      text(args.reply) ??
      (args.channel === undefined ? context.root : undefined);
    // A reply goes to its message's channel.
    const channel =
      text(args.channel) ??
      (reply && reply !== context.root
        ? tag(await tools.event(reply), "h")
        : undefined) ??
      context.channel;
    if (!channel) throw new Error("channel is required here.");
    if (reply && context.topLevel && channel === context.channel)
      throw new Error(
        "This chat stays at the top level: send again without reply.",
      );
    const audienceTags = audienceOf(args);
    const thread = reply ? await tools.threadTags(reply) : [];
    return post(tools, channel, args, thread, audienceTags);
  },

  async reply_in_subthread(tools, args) {
    const { context } = tools;
    const parent = text(args.parent)?.toLowerCase();
    if (!parent) throw new Error("parent is required.");
    const target =
      parent === context.root ? undefined : await tools.event(parent);
    const channel = (target && tag(target, "h")) ?? context.channel;
    if (!channel) throw new Error("No channel for that message.");
    if (context.topLevel && channel === context.channel)
      throw new Error("This chat stays at the top level: use send instead.");
    const audienceTags = audienceOf(args);
    // As relay ingest reads it: the last valid marker, in either case.
    const root = target
      ? (threadReference(target)?.rootId ?? target.id)
      : parent;
    return post(
      tools,
      channel,
      args,
      root === parent
        ? [["e", root, "", "reply"]]
        : [
            ["e", root, "", "root"],
            ["e", parent, "", "reply"],
          ],
      audienceTags,
    );
  },

  async edit(tools, args) {
    const id = required(args, "id");
    const target = await tools.event(id);
    const channel = tag(target, "h");
    if (!channel) throw new Error(`${id} is not a channel message.`);
    const content = required(args, "text");
    await tools.client.publish({
      kind: 40003,
      content,
      // An edit replaces the attachments too, so it keeps the message's.
      tags: [
        ["h", channel],
        ["e", id],
        ...target.tags.filter((t) => t[0] === "imeta"),
        ...(await tools.emoji(content)),
      ],
    });
    return "edited";
  },

  async delete(tools, args) {
    const { client } = tools;
    const id = required(args, "id");
    const target = await tools.event(id);
    const channel = tag(target, "h");
    if (!channel) throw new Error(`${id} is not a channel message.`);
    if (target.pubkey !== client.pubkey)
      throw new Error("Only your own messages can be deleted.");
    await client.publish({
      kind: 5,
      content: "",
      tags: [
        ["h", channel],
        ["e", id],
        ["k", String(target.kind)],
      ],
    });
    return "deleted";
  },

  async react(tools, args) {
    const { client } = tools;
    const id = required(args, "id");
    const emoji = required(args, "emoji");
    if (args.off !== true) {
      await client.publish({ kind: 7, content: emoji, tags: [["e", id]] });
      return "reacted";
    }
    const mine = await client.query([
      { kinds: [7], "#e": [id], authors: [client.pubkey], limit: 100 },
    ]);
    const reaction = mine.find((event) => event.content === emoji);
    if (!reaction) return "no such reaction";
    await client.publish({ kind: 5, content: "", tags: [["e", reaction.id]] });
    return "removed";
  },

  async read(tools, args) {
    const { client, context } = tools;
    if (args.message_url !== undefined) {
      if (args.channel !== undefined || args.thread !== undefined)
        throw new Error(
          "message_url cannot be combined with channel or thread.",
        );
      const link =
        typeof args.message_url === "string"
          ? parseBuzzLink(args.message_url)
          : null;
      if (link?.format !== "legacy" || !link.messageId)
        throw new Error("message_url must be a Buzz message link.");
      args = { ...args, channel: link.channelId, thread: link.messageId };
    }
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    const before = unixTime(args, "before");
    const since = unixTime(args, "since");
    if (since !== undefined && before !== undefined && since > before)
      throw new Error("since must not be after before.");
    let author: string | undefined;
    if (args.author !== undefined)
      try {
        author = pubkey(args.author as string);
      } catch {
        throw new Error(
          "author must be a hex pubkey or npub; users finds one by name.",
        );
      }
    const beforeId = args.before_id;
    if (beforeId !== undefined && before === undefined)
      throw new Error("before_id needs before, from the same continue line.");
    if (
      beforeId !== undefined &&
      (typeof beforeId !== "string" || !HEX.test(beforeId))
    )
      throw new Error("before_id must be a 64-character event ID.");
    const filters = {
      ...(author ? { authors: [author] } : {}),
      ...(since !== undefined ? { since } : {}),
    };
    // The relay's cursor: at or before `until`, after `before_id` at a tie.
    const cursor = {
      ...(before !== undefined ? { until: before } : {}),
      ...(beforeId ? { before_id: beforeId } : {}),
    };
    const q = text(args.q);
    let channel = text(args.channel) ?? context.channel;
    if (q) {
      if (beforeId)
        throw new Error(
          "before_id pages thread and channel reads; narrow a search with before or since.",
        );
      const max = bound(limit, 20, 100);
      const found = await client.query([
        {
          kinds: SEARCH,
          search: q,
          limit: max,
          ...(args.channel ? { "#h": [channel] } : {}),
          ...cursor,
          ...filters,
        },
      ]);
      const lines = await tools.messages(found, {});
      if (!lines.length) return "No messages.";
      if (found.length >= max)
        lines.push(
          "Result limit reached; more matches may exist. Narrow with channel, author, since or before.",
        );
      return lines.join("\n");
    }
    let scope: { channel?: string; root?: string };
    let max: number;
    let more: Args;
    let found: readonly BuzzEvent[];
    let first: BuzzEvent | undefined;
    if (text(args.thread) || (args.channel === undefined && context.root)) {
      if (author || since !== undefined)
        throw new Error(
          "author and since filter a search (q) or a channel read, not a thread; add q or channel.",
        );
      const id = text(args.thread) ?? (context.root as string);
      let root = id;
      if (id !== context.root) {
        const event = await tools.event(id);
        root = rootOf(event);
        channel = tag(event, "h") ?? channel;
      }
      if (!channel) throw new Error("channel is required here.");
      max = bound(limit, 100, 500);
      // The root comes on the first page only, apart from the replies' limit
      // and cursor.
      const events = await client.query([
        {
          kinds: THREAD,
          "#h": [channel],
          "#e": [root],
          limit: max + 1,
          ...cursor,
        },
        ...(before === undefined
          ? [{ ids: [root], kinds: [...THREAD, 45001], limit: 1 }]
          : []),
      ]);
      first = events.find((event) => event.id === root);
      found = events.filter((event) => event.id !== root);
      scope = { channel, root };
      more = { thread: root, limit: max };
    } else {
      if (!channel) throw new Error("channel is required here.");
      max = bound(limit, 30, 200);
      found = await client.query([
        {
          kinds: MESSAGES,
          "#h": [channel],
          limit: max + 1,
          ...cursor,
          ...filters,
        },
      ]);
      scope = { channel };
      more = {
        channel,
        ...(author ? { author } : {}),
        ...(since !== undefined ? { since } : {}),
        limit: max,
      };
    }
    // One more than the limit tells whether older messages remain; the last
    // shown, in the relay's newest-first order, is where the next page starts.
    // A short page is only what the relay returned: serving-time filtering and
    // retention can leave older history unseen.
    const shown = found.slice(0, max);
    const last = shown.at(-1);
    const lines = await tools.messages(
      first ? [first, ...shown] : shown,
      scope,
    );
    if (!lines.length) return "No messages.";
    const noun = scope.root ? "replies" : "messages";
    return [
      scope.root ? `thread ${scope.root} in ${channel}` : `channel ${channel}`,
      ...lines,
      last && found.length > max
        ? `Older ${noun} remain; continue with ${JSON.stringify({ ...more, before: last.created_at, before_id: last.id })}`
        : `The relay returned no older ${noun}.`,
    ].join("\n");
  },

  async channel_list(tools, args) {
    const { client } = tools;
    const ids = new Set<string>();
    // Each channel-state event carries its type in its first `t` tag. The
    // relay leaves system channels out unless `#t` asks for them.
    const types = args.types === undefined ? undefined : list(args.types);
    if (
      types &&
      (!Array.isArray(args.types) ||
        !types.length ||
        types.length !== args.types.length ||
        types.some((type) => !CHANNEL_TYPES.includes(type)))
    )
      throw new Error(`types must list some of ${CHANNEL_TYPES.join(", ")}.`);
    const scope = types ? { "#t": [...new Set(types)] } : {};
    // Membership must not depend on the type tag: a roster signed before
    // NIP-CL has none. So the type filter applies to the channel read only,
    // and the membership read uses `#t` only to opt in to system channels.
    const member = (event: BuzzEvent) => {
      const id = tag(event, "d");
      if (id) ids.add(id);
      return true;
    };
    const memberships = { kinds: [39002], "#p": [client.pubkey] };
    let membershipsComplete = true;
    if (!types || types.some((type) => type !== "system"))
      membershipsComplete = await tools.scan(memberships, member);
    if (types?.includes("system"))
      membershipsComplete =
        (await tools.scan({ ...memberships, "#t": ["system"] }, member)) &&
        membershipsComplete;
    const all = args.all === true;
    const q = text(args.q)?.toLowerCase();
    const rows: string[] = [];
    const encoder = new TextEncoder();
    // Reserve the partial-result notice even when the last row fills the budget.
    let bytes = encoder.encode(CHANNEL_PARTIAL).length;
    const channelsComplete =
      !ids.size && !all
        ? true
        : await tools.scan(
            all
              ? { kinds: [39000], ...scope }
              : { kinds: [39000], "#d": [...ids], ...scope },
            (event) => {
              const id = tag(event, "d") ?? "";
              const flags = [
                tag(event, "t") === "stream" ? "" : tag(event, "t"),
                has(event, "private") ? "private" : "",
                has(event, "archived") ? "archived" : "",
                has(event, "auto_join") ? "auto-join" : "",
                ids.has(id)
                  ? ""
                  : membershipsComplete
                    ? "not joined"
                    : "membership unknown",
              ].filter(Boolean);
              const row = `${id} ${tag(event, "name") ?? ""}${flags.length ? ` (${flags.join(", ")})` : ""}`;
              if (q && !row.toLowerCase().includes(q)) return true;
              if (rows.length === PAGE) return false;
              const size = encoder.encode(row).length + 1;
              if (bytes + size > CHANNEL_BYTES) {
                // Preserve a usable ID when one channel has oversized details.
                const brief = `${id} (details omitted; use channel_get for details)`;
                if (bytes + encoder.encode(brief).length + 1 <= CHANNEL_BYTES)
                  rows.push(brief);
                return false;
              }
              rows.push(row);
              bytes += size;
              return true;
            },
          );
    if (!membershipsComplete || !channelsComplete) rows.push(CHANNEL_PARTIAL);
    return rows.join("\n") || "No channels.";
  },

  channel_get: (tools, args) => tools.details(target(tools, args)),
  channel_create: (tools, args) => tools.create(args),
  channel_update: (tools, args) => tools.update(target(tools, args), args),
  channel_join: (tools, args) => lifecycle(tools, args, "join"),
  channel_leave: (tools, args) => lifecycle(tools, args, "leave"),
  channel_archive: (tools, args) => lifecycle(tools, args, "archive"),
  channel_unarchive: (tools, args) => lifecycle(tools, args, "unarchive"),
  channel_delete: (tools, args) => lifecycle(tools, args, "delete"),

  async member_list(tools, args) {
    const channel = target(tools, args);
    const limit = bound(
      typeof args.limit === "number" ? args.limit : undefined,
      100,
      500,
    );
    const offset = args.offset ?? 0;
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
      throw new Error("offset must be a whole number, 0 or more.");
    // The relay keeps a channel's whole roster in one event; only the page
    // shown needs names.
    const members = await tools.members(channel);
    const page = members.slice(offset, offset + limit);
    if (!page.length) return "No members.";
    const names = await tools.names(page.map((member) => member.pubkey));
    const rest = members.length - offset - page.length;
    return [
      ...page.map(
        ({ pubkey, role }) =>
          `${pubkey} ${names.get(pubkey) ?? ""}${role === "member" ? "" : ` (${role})`}`,
      ),
      ...(rest > 0
        ? [
            `${rest} more; continue with ${JSON.stringify({ channel, limit, offset: offset + limit })}`,
          ]
        : []),
    ].join("\n");
  },
  async member_add(tools, args) {
    const role = args.role;
    if (role !== undefined && !ROLES.includes(role as string))
      throw new Error(`role must be one of ${ROLES.join(", ")}.`);
    return changeMembers(tools, args, "add", role as string | undefined);
  },
  member_remove: async (tools, args) => changeMembers(tools, args, "remove"),

  async users(tools, args) {
    const { client } = tools;
    const ids = list(args.ids).map(pubkey);
    const q = text(args.q)?.toLowerCase();
    if (!ids.length && !q) throw new Error("Give ids or q.");
    if (ids.length && q) throw new Error("Give ids or q, not both.");
    if (ids.length > 100) throw new Error("Give at most 100 ids.");
    // Name search matches only name and display_name, best match first;
    // NIP-50 search matches the whole profile, so text in avatars or `about`
    // can fill its results and hide the person asked for. Name search refuses
    // a query longer than its limit, so a longer name uses NIP-50 search.
    const named =
      !ids.length && q && [...q].length <= PROFILE_SEARCH_QUERY_MAX
        ? await client.searchProfiles?.(q, PROFILE_SEARCH_MAX)
        : undefined;
    const profiles =
      named?.filter((event) => event.kind === 0) ??
      (await client.query([
        ids.length
          ? { kinds: [0], authors: ids, limit: ids.length }
          : { kinds: [0], search: q, limit: 100 },
      ]));
    const rows = newest(profiles)
      .map((event) => {
        const profile = parse(event.content);
        const name = profileName(profile) ?? "";
        const about =
          typeof profile.about === "string" && profile.about.trim()
            ? ` — ${profile.about.trim().slice(0, 120)}`
            : "";
        return { name, row: `${event.pubkey} ${name}${about}` };
      })
      .filter(
        ({ name }) =>
          !q || ids.length || named || name.toLowerCase().includes(q),
      );
    return rows.map(({ row }) => row).join("\n") || "No users.";
  },

  async dm(tools, args) {
    const { client } = tools;
    const to = list(args.to).map(pubkey);
    if (!to.length) throw new Error("to is required.");
    const people = new Set([client.pubkey, ...to]);
    const find = async () =>
      (
        await client.query([
          { kinds: [39000], "#p": [client.pubkey], "#t": ["dm"], limit: 500 },
        ])
      ).find((event) => {
        const members = new Set(
          event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
        );
        return (
          members.size === people.size &&
          [...people].every((key) => members.has(key))
        );
      });
    let found = await find();
    if (!found) {
      await client.publish({
        kind: 41010,
        content: "",
        tags: [...to.map((key) => ["p", key]), ["d", crypto.randomUUID()]],
      });
      // The relay creates the channel's metadata just after answering.
      for (let tries = 0; !found && tries < 5; tries++) {
        if (tries) await new Promise((resolve) => setTimeout(resolve, 400));
        found = await find();
      }
    }
    const channel = found && tag(found, "d");
    if (!channel) throw new Error("The DM did not open.");
    return channel;
  },

  async mem_get(tools, args) {
    const slug = text(args.slug);
    const q = typeof args.q === "string" ? args.q : undefined;
    if (slug && q !== undefined)
      throw new Error("q searches all memory; leave out slug.");
    if (q !== undefined && !q.trim())
      throw new Error("q needs a word to search for.");
    if (!slug) {
      const { entries, partial } = await tools.client.memories();
      const found = q === undefined ? undefined : searchMemory(entries, q);
      const lines =
        found ??
        entries
          .map((entry) => `${entry.slug} ${time(entry.createdAt)}`)
          .join("\n");
      if (!partial)
        return (
          lines ||
          (found === undefined ? "No memory." : `No memory matches ${q}.`)
        );
      if (!lines) throw new Error("Memory could not be read; try again.");
      return `${lines}\nThis ${found === undefined ? "list" : "search"} is incomplete: some memory could not be read.`;
    }
    const key = memorySlug(slug);
    const { entries, partial } = await tools.client.memories(key);
    const body = entries.find((entry) => entry.slug === key)?.body;
    if (body !== undefined)
      return `version: ${await memoryVersion(body)}\n\n${body}`;
    if (partial) throw new Error(`Memory ${key} could not be read; try again.`);
    return `No memory ${key}.`;
  },

  async mem_set(tools, args) {
    const key = memorySlug(required(args, "slug"));
    const body = (await tools.body(args, true)) as string;
    const expected = text(args.expected);
    // A copied mem_get reply would save its header into the entry.
    if (/^version: [0-9a-f]{16}\n/.test(body))
      throw new Error(
        "Leave out the version line from mem_get; pass the version as expected.",
      );
    // A write must be dated after the entry it replaces, so it waits for a
    // read that finds the entry or confirms there is none.
    const { entries, deleted, partial } = await tools.client.memories(key);
    const current = entries.find((entry) => entry.slug === key);
    if (!current && partial)
      throw new Error(`Memory ${key} could not be read; try again.`);
    // Another session of this agent may have written it since this one read
    // it (a session's `core` is a copy from when it started): replacing
    // needs the version it was shown, so nothing it never saw is lost.
    if (!current && expected)
      throw new Error(
        `No memory ${key} to replace; leave out expected to create it.`,
      );
    if (current && !expected)
      throw new Error(
        `${key} exists. Read it with mem_get, keep what still holds, and pass its version as expected.`,
      );
    if (current && expected !== (await memoryVersion(current.body)))
      throw new Error(
        `${key} changed since version ${expected}. Read it again with mem_get, merge your change into it, and pass the new version as expected.`,
      );
    // Recreating a deleted entry follows its tombstone.
    const tombstone = deleted?.find((entry) => entry.slug === key);
    await tools.client.remember(
      key,
      body,
      current?.createdAt ?? tombstone?.createdAt ?? 0,
    );
    const saved = `saved; version ${await memoryVersion(body)}`;
    if (key !== "core") return saved;
    const size = new TextEncoder().encode(body).length;
    const amount =
      size < 1000 ? `${size} bytes` : `${(size / 1000).toFixed(1)} KB`;
    return size > CORE_TARGET_BYTES
      ? `${saved}; core is ${amount}, over the ~10 KB target. Move detail you do not need every turn to a mem/ slug.`
      : `${saved}; core is ${amount}.`;
  },

  async mem_rm(tools, args) {
    const key = memorySlug(required(args, "slug"));
    const expected = required(args, "expected");
    // NIP-AE has no tombstone for core; only a write replaces it.
    if (key === "core")
      throw new Error("core cannot be deleted; replace it with mem_set.");
    const { entries, partial } = await tools.client.memories(key);
    const current = entries.find((entry) => entry.slug === key);
    if (!current && partial)
      throw new Error(`Memory ${key} could not be read; try again.`);
    if (!current) throw new Error(`No memory ${key}.`);
    // As with mem_set, nothing another session wrote since this one read it
    // is lost.
    if (expected !== (await memoryVersion(current.body)))
      throw new Error(
        `${key} changed since version ${expected}. Read it again with mem_get before you delete it.`,
      );
    await tools.client.remember(key, null, current.createdAt);
    return `deleted ${key}`;
  },

  async notes_get(tools, args) {
    const { client } = tools;
    const name = args.name === undefined ? undefined : noteSlug(args.name);
    const author = optional(args, "author");
    if (name === undefined) {
      if (args.latest !== undefined)
        throw new Error("latest is for reading a note by name.");
      const who = author || "me";
      const topic = optional(args, "tag");
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const notes = latestNotes(
        await client.query([
          {
            kinds: [NOTE],
            ...(who === "all" ? {} : { authors: [await tools.author(who)] }),
            ...(topic ? { "#t": [topic] } : {}),
            limit: bound(limit, 50, 200),
          },
        ]),
      );
      if (!notes.length) return "No notes.";
      const names = await tools.names(notes.map((note) => note.pubkey));
      return notes
        .map(
          (note) =>
            `${tag(note, "d")} ${note.pubkey} ${names.get(note.pubkey) ?? ""} ${time(note.created_at)} ${tag(note, "title") || "(untitled)"}`,
        )
        .join("\n");
    }
    if (args.tag !== undefined || args.limit !== undefined)
      throw new Error("tag and limit are for listing notes, without name.");
    if (author === "all")
      throw new Error("author all is for listing; leave author out instead.");
    if (author && args.latest === true)
      throw new Error("Give author or latest, not both.");
    const notes = latestNotes(
      await client.query([
        {
          kinds: [NOTE],
          "#d": [name],
          ...(author ? { authors: [await tools.author(author)] } : {}),
          limit: 50,
        },
      ]),
    );
    const names = await tools.names(notes.map((note) => note.pubkey));
    if (!notes.length) return `No note ${name}.`;
    if (notes.length > 1 && args.latest !== true)
      throw new Error(
        `${notes.length} authors have a note ${name}; give author or latest.\n${notes
          .map(
            (note) =>
              `${note.pubkey} ${names.get(note.pubkey) ?? ""} ${time(note.created_at)} ${tag(note, "title") || "(untitled)"}`,
          )
          .join("\n")}`,
      );
    const note = notes[0] as BuzzEvent;
    const topics = note.tags.filter((t) => t[0] === "t" && t[1]);
    return [
      `${NOTE}:${note.pubkey}:${name} by ${names.get(note.pubkey) ?? note.pubkey}, ${time(note.created_at)}`,
      `title: ${tag(note, "title") ?? ""}`,
      ...(has(note, "summary") ? [`summary: ${tag(note, "summary")}`] : []),
      ...(topics.length ? [`tags: ${topics.map((t) => t[1]).join(", ")}`] : []),
      "",
      note.content,
    ].join("\n");
  },

  async notes_set(tools, args) {
    const { client } = tools;
    const name = noteSlug(args.name);
    const body = (await tools.body(args, true)) as string;
    if (!body.trim()) throw new Error("A note needs text.");
    const given = (key: string) => {
      const value = args[key];
      if (value !== undefined && typeof value !== "string")
        throw new Error(`${key} must be text.`);
      return value;
    };
    const title = given("title");
    const summary = given("summary");
    if (
      args.tags !== undefined &&
      (!Array.isArray(args.tags) ||
        !args.tags.every((item) => typeof item === "string" && item.trim()))
    )
      throw new Error("tags must be a list of words.");
    // Read from the writer, so a lagging replica cannot hide the version
    // this write replaces or the one it saved.
    const own = {
      kinds: [NOTE],
      authors: [client.pubkey],
      "#d": [name],
      limit: 1,
      consistency: "strong",
    };
    const [prior] = latestNotes(await client.query([own]));
    if (title === undefined && !prior)
      throw new Error("title is required for a new note.");
    const kept = (key: string) =>
      prior?.tags.filter((t) => t[0] === key && t[1]).map((t) => t[1]) ?? [];
    const topics =
      args.tags === undefined
        ? kept("t")
        : (args.tags as string[]).map((t) => t.trim());
    const about = summary ?? (prior && tag(prior, "summary"));
    // The newest version wins, so a write must be dated after the one it
    // replaces.
    const after = prior ? (prior.created_at + 1) * 1000 : 0;
    if (after - Date.now() > 5000)
      throw new Error("The note was just changed; try again.");
    await waitUntil(after);
    const saved = await client.publish({
      kind: NOTE,
      content: body,
      tags: [
        ["d", name],
        ["title", title ?? tag(prior as BuzzEvent, "title") ?? ""],
        ...(about === undefined ? [] : [["summary", about]]),
        ...topics.map((topic) => ["t", topic as string]),
        [
          "published_at",
          kept("published_at")[0] ?? String(Math.floor(Date.now() / 1000)),
        ],
      ],
    });
    // The community accepts a write that loses to another version of the
    // same second, so only a read shows whether this one is the note now.
    const [current] = latestNotes(await client.query([own]));
    if (!current)
      throw new Error(
        `conflict: note ${name} was not found after this write. Read it with notes_get, then write again.`,
      );
    if (current.id !== saved.id)
      throw new Error(
        `conflict: note ${name} now holds another version (${current.id}, ${time(current.created_at)}), not this text. Read it with notes_get, then write again.`,
      );
    return `saved ${NOTE}:${client.pubkey}:${name}`;
  },

  async notes_rm(tools, args) {
    const { client } = tools;
    const name = noteSlug(args.name);
    // Read from the writer, so a lagging replica cannot hide a new note.
    const [mine] = latestNotes(
      await client.query([
        {
          kinds: [NOTE],
          authors: [client.pubkey],
          "#d": [name],
          limit: 1,
          consistency: "strong",
        },
      ]),
    );
    if (!mine) throw new Error(`You have no note ${name}.`);
    // A deletion removes only versions dated at or before it, so it must be
    // dated after the note, even one from a writer whose clock runs ahead.
    const after = (mine.created_at + 1) * 1000;
    if (after - Date.now() > 5000)
      throw new Error("The note was just changed; try again.");
    await waitUntil(after);
    const coordinate = `${NOTE}:${client.pubkey}:${name}`;
    await client.publish({ kind: 5, content: "", tags: [["a", coordinate]] });
    return `deleted ${coordinate}`;
  },

  async canvas_get(tools, args) {
    const channel = text(args.channel) ?? tools.context.channel;
    if (!channel) throw new Error("channel is required here.");
    const head = await canvas(tools, channel);
    return head?.content || "No canvas.";
  },

  async canvas_set(tools, args) {
    const { client, context } = tools;
    const channel = text(args.channel) ?? context.channel;
    if (!channel) throw new Error("channel is required here.");
    const content = (await tools.body(args, true, "content")) as string;
    if (new TextEncoder().encode(content).length > LIVE_CANVAS_BYTES)
      throw new Error(
        `The canvas is over its limit of ${LIVE_CANVAS_BYTES} bytes.`,
      );
    const head = await canvas(tools, channel);
    // The newest canvas wins, so a write must be dated after the current one.
    const after = head ? (head.created_at + 1) * 1000 : 0;
    if (after - Date.now() > 5000)
      throw new Error("The canvas was just changed; try again.");
    await waitUntil(after);
    await client.publish({ kind: 40100, content, tags: [["h", channel]] });
    return "saved";
  },

  async canvas_history(tools, args) {
    const channel = text(args.channel) ?? tools.context.channel;
    if (!channel) throw new Error("channel is required here.");
    const before = unixTime(args, "before");
    const beforeId = args.before_id;
    if (beforeId !== undefined && before === undefined)
      throw new Error("before_id needs before, from the same continue line.");
    if (
      beforeId !== undefined &&
      (typeof beforeId !== "string" || !HEX.test(beforeId))
    )
      throw new Error("before_id must be a 64-character event ID.");
    // A page as the app's history shows it, with the relay's cursor. The
    // first is read from the writer, so it includes a write just confirmed.
    const rows = await tools.client.query([
      {
        kinds: [40100],
        "#h": [channel],
        limit: CANVAS_HISTORY_PAGE,
        ...(before === undefined
          ? { consistency: "strong" as const }
          : { until: before }),
        ...(beforeId ? { before_id: beforeId } : {}),
      },
    ]);
    if (!rows.length) {
      if (before === undefined && !(await tools.metadata(channel)))
        throw unseen(channel);
      return before === undefined ? "No canvas." : "No older revisions.";
    }
    const lines = rows.map((row) => {
      const first = row.content.trim().split("\n", 1)[0] ?? "";
      const bytes = new TextEncoder().encode(row.content).length;
      return `${row.id} ${time(row.created_at)} ${row.pubkey} ${bytes}B ${first.slice(0, 80)}`;
    });
    const last = rows.at(-1);
    if (last && rows.length >= CANVAS_HISTORY_PAGE)
      lines.push(
        `Older revisions may remain; continue with ${JSON.stringify({ channel, before: last.created_at, before_id: last.id })}`,
      );
    if (before === undefined) lines.unshift(`version: ${rows[0]?.id}`, "");
    return lines.join("\n");
  },

  async canvas_restore(tools, args) {
    const { client, context } = tools;
    const id = required(args, "id");
    if (!HEX.test(id)) throw new Error("id must be a 64-character event ID.");
    const expected = required(args, "expected");
    const channel = text(args.channel) ?? context.channel;
    if (!channel) throw new Error("channel is required here.");
    // Read from the writer, as the app does, so the guard sees the real head.
    const head = async () =>
      (
        await client.query([
          { kinds: [40100], "#h": [channel], limit: 1, consistency: "strong" },
        ])
      )[0];
    const [revision] = await client.query([{ ids: [id], limit: 1 }]);
    if (
      revision?.kind !== 40100 ||
      !revision.tags.some((t) => t[0] === "h" && t[1] === channel)
    )
      throw new Error(
        `No canvas revision ${id} in ${channel}; canvas_history lists them.`,
      );
    if (new TextEncoder().encode(revision.content).length > LIVE_CANVAS_BYTES)
      throw new Error(
        `Revision ${id} is over the canvas limit of ${LIVE_CANVAS_BYTES} bytes, so it cannot be restored.`,
      );
    const current = await head();
    // Guard the version the agent saw, never one that replaced it since.
    if (current?.id !== expected)
      throw new Error(
        `The canvas changed since version ${expected}. Read canvas_history again before you restore.`,
      );
    if (current.id === id) return "That revision is already the canvas.";
    // The newest canvas wins, so a write must be dated after the current one.
    const after = (current.created_at + 1) * 1000;
    if (after - Date.now() > 5000)
      throw new Error("The canvas was just changed; try again.");
    await waitUntil(after);
    // The relay refuses it if the canvas moved past the revision read above.
    const saved = await client.publish({
      kind: 40100,
      content: revision.content,
      tags: [
        ["h", channel],
        ["expected-revision", expected],
      ],
    });
    const selected = await head().catch((error: unknown) => {
      throw new Error(
        `restored ${id} as ${saved.id}, but the canvas could not be read back to confirm it is current: ${reason(error)}. Read canvas_history before you retry.`,
      );
    });
    if (selected?.id !== saved.id)
      throw new Error(
        `conflict: the restore was received, but another canvas (${selected?.id}) is now current. Read canvas_history again before you retry.`,
      );
    return `restored ${id} as ${saved.id}`;
  },

  async repo(tools, args) {
    const { client } = tools;
    const { gitAuth } = client;
    if (!gitAuth) throw new Error("Git access needs Buzz Desktop.");
    const channel = target(tools, args);
    const create = optional(args, "create");
    if (create !== undefined) {
      if (!REPO.test(create) || create.includes(".."))
        throw new Error(
          "create must be 1 to 64 letters, digits, '.', '_' or '-', not starting with '.'.",
        );
      const previous = creating.get(client.pubkey) ?? Promise.resolve();
      const started = previous
        .catch(() => {})
        .then(async () => {
          const created = await start(tools, channel, create);
          try {
            return await access(gitAuth, created);
          } catch (error) {
            throw new Error(
              `Started ${create}, but its Git header failed: ${reason(error)} Call repo again without create.`,
            );
          }
        });
      creating.set(client.pubkey, started);
      try {
        return await started;
      } finally {
        if (creating.get(client.pubkey) === started)
          creating.delete(client.pubkey);
      }
    }
    const { found, complete } = await repos(tools, channel, false);
    const name = optional(args, "repo");
    const chosen = found.filter(
      (event) => !name || `${event.pubkey}/${tag(event, "d")}` === name,
    );
    if (chosen.length === 1 && (complete || name))
      return access(gitAuth, chosen[0] as BuzzEvent);
    const listed = found.map((event) => `${event.pubkey}/${tag(event, "d")}`);
    if (!complete)
      throw new Error(
        `This channel's repositories could not all be read; try again${listed.length ? `, or choose repo: ${listed.join(", ")}` : ""}.`,
      );
    if (!found.length)
      throw new Error(
        "This channel has no repository from its owners or admins.",
      );
    throw new Error(`Choose repo: ${listed.join(", ")}`);
  },

  async media_get(tools, args) {
    const media = await tools.client.media(required(args, "url"));
    const saved = `Saved ${media.path} (${media.type}, ${media.size} bytes).`;
    if (media.data) {
      // The first 12 bytes name the type.
      const head = atob(media.data.slice(0, 16));
      const type = sniff(Uint8Array.from(head, (c) => c.charCodeAt(0)));
      if (type?.startsWith("image/"))
        return { data: media.data, type, text: saved };
    }
    return `${saved} Open it with your own tools.`;
  },

  async tabs(tools, args) {
    const { client, context } = tools;
    const tabs = client.tabs;
    if (!tabs)
      throw new Error(
        "Tabs are kept in Buzz Desktop and are unavailable here.",
      );
    // Only the channel the agent works in, so it never pulls the owner
    // toward another conversation.
    const channel = context.channel;
    if (!channel) throw new Error("Tabs need a channel to work in.");
    if (args.action === undefined) {
      const open = tabs.list(channel);
      return open.length
        ? open
            .map(
              (tab) =>
                `${tab.root} ${tab.pane}${tab.name ? ` ${JSON.stringify(tab.name)}` : ""}${tab.shown ? " (shown)" : ""}`,
            )
            .join("\n")
        : "No thread tabs open.";
    }
    if (
      args.action !== "open" &&
      args.action !== "close" &&
      args.action !== "rename"
    )
      throw new Error("action must be open, close or rename.");
    const event = await tools.event(required(args, "thread"));
    if (tag(event, "h") !== channel)
      throw new Error(`${event.id} is not in this channel.`);
    // Resolve the root as the reader does, so the tab matched is the one shown.
    const root = threadReference(event)?.rootId ?? event.id;
    if (args.action === "open")
      return tabs.open(channel, root) ? `opened ${root}` : "already open";
    if (args.action === "rename")
      return tabs.rename(channel, root, optional(args, "name") ?? "")
        ? "renamed"
        : "not open";
    const closed = tabs.close(channel, root);
    if (closed === "shown")
      throw new Error("Your owner is looking at that tab, so it stays open.");
    return closed === "closed" ? "closed" : "not open";
  },
};

/** The tags for a message's required audience. */
function audienceOf(args: Args): string[][] {
  if (args.audience !== "everyone" && args.audience !== "agents")
    throw new Error("audience must be everyone or agents.");
  return args.audience === "agents" ? [["audience", "agents"]] : [];
}

/** Publishes `args`' text, files and mentions as a message in `channel`,
 * with `thread`'s e-tags and any `extra` tags. */
async function post(
  tools: Tools,
  channel: string,
  args: Args,
  thread: readonly string[][],
  extra: readonly string[][] = [],
) {
  const files = await tools.attach(list(args.files));
  const content = `${(await tools.body(args, !files.links)) ?? ""}${files.links}`;
  const mentions = await tools.mentions(channel, content, list(args.mentions));
  const event = await tools.client.publish({
    kind: 9,
    content,
    tags: [
      ["h", channel],
      ...thread,
      ...mentions.map((pubkey) => ["p", pubkey]),
      ...files.tags,
      ...(await tools.emoji(content)),
      ...extra,
    ],
  });
  return `sent ${event.id}`;
}

/** One call's helpers, so lookups it repeats are made once. */
class Tools {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(
    readonly client: BuzzClient,
    readonly context: Context,
  ) {}

  private once<T>(key: string, load: () => Promise<T>) {
    let value = this.cache.get(key) as Promise<T> | undefined;
    if (!value) {
      value = load();
      this.cache.set(key, value);
    }
    return value;
  }

  /** `field` (default `text`), or the file at `path`. Undefined when neither
   * is given and `needed` is false. */
  async body(args: Args, needed: boolean, field = "text") {
    const path = text(args.path);
    const value = path
      ? new TextDecoder().decode(await this.client.read(path))
      : typeof args[field] === "string"
        ? args[field]
        : undefined;
    if (value === undefined && needed)
      throw new Error(`Give ${field} or path.`);
    return value;
  }

  async event(id: string) {
    if (!HEX.test(id)) throw new Error(`Not an event id: ${id}`);
    const [event] = await this.client.query([
      { ids: [id], kinds: [...THREAD, 45001], limit: 1 },
    ]);
    if (!event) throw new Error(`No message ${id}.`);
    return event;
  }

  /** The e-tag of a `send` reply to `parent`: a reply to any message in a
   * thread is a reply to the thread's root. */
  async threadTags(parent: string) {
    const root =
      parent === this.context.root ? parent : rootOf(await this.event(parent));
    return [["e", root, "", "reply"]];
  }

  /** Visit matching events in relay order, retaining only what the caller needs.
   * False means the scan or caller's output budget stopped the listing. */
  async scan(filter: Filter, visit: (event: BuzzEvent) => boolean) {
    let count = 0;
    for (let cursor = {}; ; ) {
      const limit = Math.min(PAGE, MAX_EVENTS - count + 1);
      const page = await this.client.query([{ ...filter, ...cursor, limit }]);
      for (const event of page) {
        if (++count > MAX_EVENTS || !visit(event)) return false;
      }
      const last = page.at(-1);
      if (!last || page.length < limit) return true;
      // The relay reads newest first, then by id.
      cursor = { until: last.created_at, before_id: last.id };
    }
  }

  members(channel: string) {
    return this.once(`members/${channel}`, () => this.roster(channel));
  }

  /** The channel's members now, uncached. */
  async roster(channel: string) {
    const [list] = await this.client.query([
      { kinds: [39002], "#d": [channel], limit: 1 },
    ]);
    return (list?.tags ?? [])
      .filter((t) => t[0] === "p" && t[1])
      .map((t) => ({ pubkey: t[1] as string, role: t[3] || "member" }));
  }

  /** The channel's metadata now, if the agent can see it. */
  async metadata(channel: string) {
    const [metadata] = await this.client.query([
      { kinds: [39000], "#d": [channel], limit: 1 },
    ]);
    return metadata;
  }

  async details(channel: string) {
    const metadata = await this.metadata(channel);
    if (!metadata) throw unseen(channel);
    const role = (await this.roster(channel)).find(
      (member) => member.pubkey === this.client.pubkey,
    )?.role;
    const flags = [
      tag(metadata, "t"),
      soloChannelMetadata(metadata as RelayEvent) ? "solo" : "",
      has(metadata, "private") ? "private" : "open",
      has(metadata, "archived") ? "archived" : "",
      has(metadata, "auto_join") ? "auto-join" : "",
      tag(metadata, "ttl")
        ? `archives after ${tag(metadata, "ttl")}s idle`
        : "",
      tag(metadata, "join_role") === "guest" ? "join as guest" : "",
    ].filter(Boolean);
    return [
      `${channel} ${tag(metadata, "name") ?? ""} (${flags.join(", ")})`,
      ...(["about", "topic", "purpose"] as const).flatMap((key) =>
        tag(metadata, key) ? [`${key}: ${tag(metadata, key)}`] : [],
      ),
      `you: ${role ?? "not a member"}`,
    ].join("\n");
  }

  async create(args: Args) {
    const name = canonicalDetailsName(required(args, "name"));
    const about = optional(args, "about") || undefined;
    const ttl = seconds(args.ttl);
    checkDetails(name, about, ttl);
    if (args.visibility !== "open" && args.visibility !== "private")
      throw new Error("visibility must be open or private.");
    const type = args.type ?? "stream";
    if (type !== "stream" && type !== "forum" && type !== "system")
      throw new Error("type must be stream, forum or system.");
    const role = joinRoleArg(args);
    if (role === "guest" && args.visibility === "private")
      throw new Error("join_role guest is for open channels.");
    if (args.solo !== undefined && typeof args.solo !== "boolean")
      throw new Error("solo must be true or false.");
    const solo = args.solo === true;
    if (!solo && args.members !== undefined)
      throw new Error("members is for Solo chats.");
    const members = keys(args, "members").filter(
      (key) => key !== this.client.pubkey,
    );
    // Its members are only the ones named, so no template adds agents.
    if (
      solo &&
      (args.visibility !== "private" ||
        type !== "stream" ||
        about ||
        args.template !== undefined)
    )
      throw new Error(
        "A Solo chat is a private stream without about or template.",
      );
    if (members.length > 32)
      throw new Error("A Solo chat starts with at most 32 members.");
    // Found first, so a wrong name creates nothing.
    const template =
      args.template === undefined
        ? undefined
        : await this.template(required(args, "template"));
    const id = crypto.randomUUID();
    await this.client.publish({
      kind: 9007,
      content: "",
      tags: [
        ["h", id],
        ["name", name],
        ["visibility", args.visibility],
        ["channel_type", type],
        ...(about ? [["about", about]] : []),
        ...(ttl ? [["ttl", String(ttl)]] : []),
        // As Buzz starts a Solo chat: the relay adds the `p` members in the create.
        ...(solo ? channelLabelTags([SOLO_LABEL, SOLO_NAMED_LABEL]) : []),
        ...members.map((key) => ["p", key]),
      ],
    });
    const labeled = (now: BuzzEvent | undefined) =>
      !!now && (!solo || soloChannelMetadata(now as RelayEvent));
    const shown = await until(() => this.metadata(id), labeled).catch(unread);
    if (!shown || shown instanceof Error)
      return `The community accepted channel ${id} but ${shown ? shown.message : "does not show it yet"}${template ? "; the template was not applied" : ""}${role === "guest" ? "; join_role was not set" : ""}${members.length ? "; its members are not confirmed" : ""}.`;
    const lines = [`created ${id}`];
    if (!labeled(shown))
      lines.push(
        "The community did not keep the Solo label, so it is an ordinary private channel.",
      );
    if (members.length) lines.push(...(await this.joined(id, members)));
    if (template) lines.push(...(await this.apply(id, template)));
    // Last, so the template's agents join as members, not guests.
    if (role === "guest")
      try {
        const answer = await this.update(id, { join_role: role });
        lines.push(
          answer === `updated ${id}` ? "new people join as guests" : answer,
        );
      } catch (error) {
        lines.push(`join_role not set: ${reason(error)}`);
      }
    return lines.join("\n");
  }

  /** Reports each of a new channel's `members` as its roster shows them. */
  async joined(id: string, members: readonly string[]) {
    const roster = await until(
      () => this.roster(id),
      (now) => members.every((key) => now.some((m) => m.pubkey === key)),
    ).catch(unread);
    const names = await this.names(members).catch(
      () => new Map<string, string>(),
    );
    return members.map((key) => {
      const who = names.has(key) ? `${key} ${names.get(key)}` : key;
      if (roster instanceof Error)
        return `${who}: the community accepted it but ${roster.message}`;
      return roster.some((m) => m.pubkey === key)
        ? `added ${who}`
        : `${who}: the community accepted it but does not show it yet`;
    });
  }

  /** Starts a new channel's Canvas and adds its agents from `template`. */
  async apply(id: string, template: ChannelTemplate) {
    const lines: string[] = [];
    // The template's own agents, as Buzz adds them; each is tried.
    const agents = template.agents.filter((key) => key !== this.client.pubkey);
    if (template.canvas.trim())
      try {
        await this.client.publish({
          kind: 40100,
          content: template.canvas,
          tags: [
            ["h", id],
            ["expected-revision", "none"],
          ],
        });
        lines.push("started the Canvas");
      } catch (error) {
        // As in Buzz, agents join only once the template's Canvas is started.
        lines.push(
          `Canvas not started${agents.length ? ", so no agents were added" : ""}: ${reason(error)}`,
        );
        return lines;
      }
    if (agents.length) lines.push(...(await this.change(id, agents, [])).lines);
    return lines;
  }

  /** The owner's template named `name`, as one, without guessing. */
  async template(name: string) {
    if (!this.client.templates)
      throw new Error(
        "Channel templates are kept in Buzz Desktop and are unavailable here.",
      );
    const templates = await this.client.templates();
    const found = templates.filter(
      (template) => template.name.toLowerCase() === name.trim().toLowerCase(),
    );
    if (found.length > 1)
      throw new Error(
        `${found.length} templates are named ${name}; your owner should rename one.`,
      );
    if (!found[0])
      throw new Error(
        `No template named ${name}. ${templates.length ? `Templates: ${templates.map((t) => t.name).join(", ")}.` : "Your owner has none."}`,
      );
    return found[0];
  }

  async update(channel: string, args: Args) {
    const metadata = await this.metadata(channel);
    if (!metadata) throw unseen(channel);
    const wanted: [string, string][] = [];
    if (args.name !== undefined)
      wanted.push(["name", canonicalDetailsName(required(args, "name"))]);
    for (const key of ["about", "topic", "purpose"]) {
      const value = optional(args, key);
      if (value !== undefined) wanted.push([key, value]);
    }
    if (args.visibility !== undefined) {
      if (args.visibility !== "open" && args.visibility !== "private")
        throw new Error("visibility must be open or private.");
      wanted.push(["visibility", args.visibility]);
    }
    if (args.ttl !== undefined)
      wanted.push(["ttl", String(seconds(args.ttl) ?? "")]);
    const role = joinRoleArg(args);
    if (
      role === "guest" &&
      (args.visibility ?? (has(metadata, "private") ? "private" : "open")) ===
        "private"
    )
      throw new Error("join_role guest is for open channels.");
    if (role) wanted.push(["join_role", role]);
    if (!wanted.length)
      throw new Error(
        "Give name, about, visibility, ttl, join_role, topic or purpose.",
      );
    const value = (key: string) => wanted.find((t) => t[0] === key)?.[1];
    checkDetails(
      value("name"),
      value("about"),
      Number(value("ttl")) || undefined,
    );
    await this.client.publish({
      kind: 9002,
      content: "",
      tags: [["h", lifecycleChannelId(channel)], ...wanted],
    });
    const shows = (now: BuzzEvent | undefined) =>
      !!now &&
      wanted.every(([key, value]) =>
        key === "visibility"
          ? has(now, "private") === (value === "private")
          : (tag(now, key) ?? "") === value,
      );
    const now = await until(() => this.metadata(channel), shows).catch(unread);
    if (now instanceof Error)
      return `The community accepted the update but ${now.message}.`;
    return shows(now)
      ? `updated ${channel}`
      : "The community accepted the update but does not show it yet.";
  }

  /** Adds and removes members, each tried on its own, and reports each as the
   * roster shows it. `changed` is whether any was accepted. */
  async change(
    channel: string,
    add: readonly string[],
    remove: readonly string[],
    role?: string,
  ) {
    const refused = new Map<string, string>();
    for (const [targets, kind] of [
      [add, 9000],
      [remove, 9001],
    ] as const)
      for (const key of targets)
        try {
          await this.client.publish({
            kind,
            content: "",
            tags: [
              ["h", channel],
              ["p", key],
              ...(kind === 9000 && role ? [["role", role]] : []),
            ],
          });
        } catch (error) {
          refused.set(key, reason(error));
        }
    const added = (roster: Member[], key: string) =>
      roster.some((m) => m.pubkey === key && (!role || m.role === role));
    const removed = (roster: Member[], key: string) =>
      !roster.some((m) => m.pubkey === key);
    const roster = await until(
      () => this.roster(channel),
      (now) =>
        add.every((key) => refused.has(key) || added(now, key)) &&
        remove.every((key) => refused.has(key) || removed(now, key)),
    ).catch(unread);
    const names = await this.names([...add, ...remove]).catch(
      () => new Map<string, string>(),
    );
    const who = (key: string) =>
      names.has(key) ? `${key} ${names.get(key)}` : key;
    // With no role asked for, the relay gives a new member the channel's
    // join_role, which is guest on an announce channel.
    const shown = (key: string) =>
      role ??
      (roster instanceof Error
        ? undefined
        : roster.find((m) => m.pubkey === key)?.role);
    const report = (key: string, verb: string, done?: typeof added) =>
      refused.has(key)
        ? `not ${verb} ${who(key)}: ${refused.get(key)}`
        : roster instanceof Error
          ? `${who(key)}: the community accepted it but ${roster.message}`
          : done?.(roster, key)
            ? `${verb} ${who(key)}${verb === "added" && (role || shown(key) !== "member") ? ` as ${shown(key)}` : ""}`
            : `${who(key)}: the community accepted it but does not show it yet`;
    return {
      changed: refused.size < add.length + remove.length,
      lines: [
        ...add.map((key) => report(key, "added", added)),
        ...remove.map((key) => report(key, "removed", removed)),
      ],
    };
  }

  /** The author `value` names: me, a pubkey or npub, or one display name. */
  async author(value: string) {
    if (value === "me") return this.client.pubkey;
    try {
      return pubkey(value);
    } catch {}
    const q = value.toLowerCase();
    const named =
      [...q].length <= PROFILE_SEARCH_QUERY_MAX
        ? await this.client.searchProfiles?.(q, PROFILE_SEARCH_MAX)
        : undefined;
    const profiles =
      named?.filter((event) => event.kind === 0) ??
      (await this.client.query([{ kinds: [0], search: q, limit: 100 }]));
    const found = newest(profiles).filter(
      (event) => profileName(parse(event.content))?.toLowerCase() === q,
    );
    if (found.length > 1)
      throw new Error(
        `${found.length} people are named ${value}; give their npub.\n${found
          .map((event) => npubEncode(event.pubkey))
          .join("\n")}`,
      );
    if (!found[0]) throw new Error(`No one is named ${value}.`);
    return found[0].pubkey;
  }

  /** Display names of `pubkeys` that have a profile. */
  async names(pubkeys: readonly string[]) {
    const wanted = [...new Set(pubkeys)];
    const names = new Map<string, string>();
    if (!wanted.length) return names;
    const profiles = await this.client.query([
      { kinds: [0], authors: wanted, limit: wanted.length },
    ]);
    for (const event of newest(profiles)) {
      const name = profileName(parse(event.content));
      if (name) names.set(event.pubkey, name);
    }
    return names;
  }

  /** Messages oldest first with their latest edits, a line each: its ID,
   * author and its claimed (unverified) agent owner, channel and thread,
   * omitting what `scope` names. Other agent read surfaces trim the same
   * fields, so change them together, including the `buzz` CLI's agent format
   * (block/buzz `crates/buzz-cli/src/commands/event_output.rs`). */
  async messages(
    events: readonly BuzzEvent[],
    scope: Readonly<{ channel?: string; root?: string }>,
  ) {
    // An edit tags only the message it changes, so a thread's are not in it.
    const ids = events.filter((event) => event.kind !== 40003).map((e) => e.id);
    const edits = ids.length
      ? await this.client.query([{ kinds: [40003], "#e": ids, limit: 500 }])
      : [];
    const messages = edited([...events, ...edits]);
    const names = await this.names(messages.map((event) => event.pubkey));
    return messages.map((event) => {
      const name = names.get(event.pubkey);
      const channel = tag(event, "h");
      const owner = tag(event, "auth");
      const reference = threadReference(event);
      const thread = reference?.rootId;
      return [
        event.id,
        `from ${event.pubkey}`,
        name && JSON.stringify(name),
        owner && `claimed owner ${owner}`,
        channel && channel !== scope.channel && `in ${channel}`,
        thread && thread !== scope.root && `re ${thread}`,
        reference &&
          reference.parentId !== thread &&
          `reply_to ${reference.parentId}`,
        `at ${time(event.created_at)}: ${event.content}`,
      ]
        .filter(Boolean)
        .join(" ");
    });
  }

  /** NIP-30 tags for the community emoji `content` uses, as the composer
   * adds them, so `:shortcode:` renders as the emoji. */
  async emoji(content: string) {
    if (!referencedEmoji(content).length) return [];
    const sets = new Map<string, BuzzEvent>();
    for (const event of await this.client.query([
      { kinds: [EMOJI_SET_KIND], "#d": [EMOJI_SET], limit: 500 },
    ]))
      sets.set(event.pubkey, newer(sets.get(event.pubkey), event));
    return contentEmojiTags(content, communityEmoji(sets.values()));
  }

  /** Who `content` notifies: `mentions`, `nostr:npub…` links, and `@Name`
   * for a channel member, as the CLI resolves them. Each must be a member. */
  async mentions(
    channel: string,
    content: string,
    explicit: readonly string[],
  ) {
    const keys = new Set(explicit.map(pubkey));
    for (const match of content.matchAll(/nostr:(npub1[02-9ac-hj-np-z]{58})/g))
      keys.add(pubkey(match[1] as string));
    const prose = content
      .replace(/^```[\s\S]*?^```/gm, " ")
      .replace(/`[^`\n]*`/g, " ");
    if (!prose.includes("@") && !keys.size) return [];
    const members = await this.members(channel);
    if (prose.includes("@")) {
      const byName = new Map<string, string[]>();
      for (const [key, name] of await this.names(
        members.map((member) => member.pubkey),
      )) {
        const lower = name.toLowerCase();
        byName.set(lower, [...(byName.get(lower) ?? []), key]);
      }
      const longest = [...byName.keys()].sort((a, b) => b.length - a.length);
      const unknown: string[] = [];
      for (const match of prose.matchAll(/(^|\s)@/g)) {
        const rest = prose
          .slice((match.index ?? 0) + match[0].length)
          .toLowerCase();
        const name = longest.find(
          (candidate) =>
            rest.startsWith(candidate) &&
            /^($|[\s,;.!?:)\]}])/.test(rest.slice(candidate.length)),
        );
        const found = name ? (byName.get(name) ?? []) : [];
        if (found.length === 1) keys.add(found[0] as string);
        else {
          const token = name ?? rest.match(/^[a-z0-9._-]+/)?.[0];
          if (token)
            unknown.push(`@${token}${found.length ? " (ambiguous)" : ""}`);
        }
      }
      if (unknown.length && !explicit.length)
        throw new Error(
          `No single channel member is ${unknown.join(", ")}. Pass their pubkeys in mentions, or drop the @.`,
        );
    }
    const outside = [...keys].filter(
      (key) => !members.some((member) => member.pubkey === key),
    );
    if (outside.length)
      throw new Error(`Not in this channel: ${outside.join(", ")}`);
    return [...keys].slice(0, 50);
  }

  /** Uploads each file and returns its `imeta` tags and the links to append.
   * Any file the community accepts attaches; it decides the type. */
  async attach(paths: readonly string[]) {
    const tags: string[][] = [];
    let links = "";
    for (const path of paths) {
      const data = await this.client.read(path);
      const upload = await this.client.upload(
        data,
        sniff(data) ?? "application/octet-stream",
      );
      const name = attachmentName(path.split(/[\\/]/).pop() ?? "");
      tags.push([...imeta(upload), `filename ${name}`]);
      links += `\n${attachmentMarkdown(name, upload)}`;
    }
    return { tags, links };
  }
}

/** The root of the thread `event` is in, by its NIP-10 markers. */
function rootOf(event: BuzzEvent) {
  const tags = event.tags.filter(
    (t) => t[0] === "e" && t.length >= 4 && HEX.test(t[1] ?? ""),
  );
  const root = tags.find((t) => t[3] === "root");
  const reply = tags.find((t) => t[3] === "reply");
  return ((root && reply ? root : reply)?.[1] ?? event.id) as string;
}

/** Messages oldest first, each showing its author's latest edit. */
function edited(events: readonly BuzzEvent[]) {
  const edits = new Map<string, BuzzEvent>();
  for (const event of events)
    if (event.kind === 40003) {
      const target = tag(event, "e");
      const last = target && edits.get(target);
      if (target && (!last || last.created_at < event.created_at))
        edits.set(target, event);
    }
  return events
    .filter((event) => event.kind !== 40003)
    .map((event) => {
      const edit = edits.get(event.id);
      return edit && edit.pubkey === event.pubkey
        ? { ...event, content: edit.content }
        : event;
    })
    .sort((a, b) => a.created_at - b.created_at);
}

/** Each author's newest event. */
function newest(events: readonly BuzzEvent[]) {
  const latest = new Map<string, BuzzEvent>();
  for (const event of events) {
    const seen = latest.get(event.pubkey);
    if (!seen || seen.created_at < event.created_at)
      latest.set(event.pubkey, event);
  }
  return [...latest.values()];
}

function imeta(upload: Upload) {
  return [
    "imeta",
    `url ${upload.url}`,
    `m ${upload.type}`,
    `x ${upload.sha256}`,
    `size ${upload.size}`,
    ...(["dim", "blurhash", "thumb", "duration"] as const)
      .filter((key) => upload[key] !== undefined)
      .map((key) => `${key} ${upload[key]}`),
  ];
}

/** A draft's picture: uploads the image at `path` as the agent once the
 * draft is valid, giving its URL. */
function proposedPicture(client: BuzzClient, path: unknown) {
  const file = text(path)?.trim();
  if (!file) return undefined;
  const upload = client.uploadPicture?.bind(client);
  if (!upload)
    throw new Error("Picture proposals are unavailable on this host");
  return async () => {
    const data = await client.read(file);
    // The preparer's own detector, so it never passes an image through.
    const type = imageType(data);
    if (!type)
      throw new Error("picture must be a PNG, JPEG, GIF or WebP image");
    return (await upload(data, type)).url;
  };
}

/** An image or MP4's type, by the file's leading bytes. */
function sniff(data: Uint8Array) {
  const at = (offset: number, ...bytes: number[]) =>
    bytes.every((byte, index) => data[offset + index] === byte);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) return "video/mp4";
  return undefined;
}

function memorySlug(slug: string) {
  const key = slug === "core" || slug.startsWith("mem/") ? slug : `mem/${slug}`;
  if (
    key.length > 255 ||
    !/^(core|mem\/[a-z0-9][a-z0-9_-]{0,63}(\/[a-z0-9][a-z0-9_-]{0,63})*)$/.test(
      key,
    )
  )
    throw new Error(
      `Bad slug ${slug}: use lowercase parts like notes or team/plan.`,
    );
  return key;
}

/** The size the base prompt asks agents to keep `core` under. */
const CORE_TARGET_BYTES = 10_000;
/** What a memory search shows: entries, lines of each, and characters of a line. */
const SEARCH_ENTRIES = 20;
const SEARCH_LINES = 3;
const SEARCH_LINE_CHARS = 160;

/** A memory's version: the start of the SHA-256 of its text. */
export async function memoryVersion(body: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The entries whose slug or text has every word of `q`, newest first, each
 * with a few of its matching lines cut around the first match. Empty when
 * none match. */
function searchMemory(entries: readonly Memory[], q: string) {
  const words = [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];
  const found = entries
    .filter((entry) => {
      const all = `${entry.slug}\n${entry.body}`.toLowerCase();
      return words.every((word) => all.includes(word));
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  const shown = found.slice(0, SEARCH_ENTRIES).map((entry) => {
    const lines = entry.body
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => words.some((word) => line.toLowerCase().includes(word)))
      .slice(0, SEARCH_LINES)
      .map((line) => `  ${snippet(line, words)}`);
    return [`${entry.slug} ${time(entry.createdAt)}`, ...lines].join("\n");
  });
  const more = found.length - shown.length;
  return [
    ...shown,
    ...(more > 0 ? [`${more} more; add words to q to narrow it.`] : []),
  ].join("\n");
}

/** `line`, cut to SEARCH_LINE_CHARS around its first match. */
function snippet(line: string, words: readonly string[]) {
  if (line.length <= SEARCH_LINE_CHARS) return line;
  const lower = line.toLowerCase();
  const at = Math.min(
    ...words.map((word) => lower.indexOf(word)).filter((index) => index >= 0),
  );
  const start = Math.max(0, Math.min(at - 40, line.length - SEARCH_LINE_CHARS));
  const end = start + SEARCH_LINE_CHARS;
  return `${start ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

/** A note's name, as the CLI allows it. */
function noteSlug(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9._-]{1,80}$/.test(value))
    throw new Error(
      `Bad note name ${String(value)}: use up to 80 of a-z, 0-9, - _ and .`,
    );
  return value;
}

/** Waits until `at`. A timer can fire a moment early, which would date the
 * write in the second it must follow. */
async function waitUntil(at: number) {
  while (Date.now() < at)
    await new Promise((resolve) => setTimeout(resolve, at - Date.now()));
}

/** Each author's newest version of each note, newest first. */
function latestNotes(events: readonly BuzzEvent[]) {
  const latest = new Map<string, BuzzEvent>();
  for (const event of events) {
    const name = tag(event, "d");
    if (event.kind !== NOTE || name === undefined) continue;
    const key = `${event.pubkey}:${name}`;
    const seen = latest.get(key);
    // Of two versions from the same second, the lower id is kept.
    if (
      !seen ||
      seen.created_at < event.created_at ||
      (seen.created_at === event.created_at && event.id < seen.id)
    )
      latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => b.created_at - a.created_at);
}

function pubkey(value: string) {
  if (HEX.test(value.toLowerCase())) return value.toLowerCase();
  try {
    const decoded = decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {}
  throw new Error(`Not a pubkey: ${value}`);
}

const profileName = (profile: Record<string, unknown>) =>
  [profile.display_name, profile.name].find(
    (name): name is string => typeof name === "string" && !!name.trim(),
  );
function parse(content: string): Record<string, unknown> {
  try {
    const value = JSON.parse(content);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
const tag = (event: BuzzEvent, name: string) =>
  event.tags.find((t) => t[0] === name)?.[1];
const has = (event: BuzzEvent, name: string) =>
  event.tags.some((t) => t[0] === name);
type Member = Readonly<{ pubkey: string; role: string }>;
const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Loads until `done` holds, a few times, and returns the last load: the
 * relay updates a channel's state just after answering. */
async function until<T>(load: () => Promise<T>, done: (value: T) => boolean) {
  let value = await load();
  for (let tries = 1; !done(value) && tries < 5; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    value = await load();
  }
  return value;
}

/** A channel without visible metadata, including a newly created channel. */
const unseen = (channel: string) =>
  new Error(
    `No channel ${channel} that you can see (it may not be visible yet). If you supplied a name, channel_list with q finds its ID.`,
  );

/** The repositories bound to `channel` by its owners and admins or their
 * agents, and whether every announcement naming it was read. Git access
 * follows a repository's first `buzz-channel` tag, which anyone may set, so
 * only those that name it first and that it trusts. `strong` reads from the
 * relay's writer, never a replica that may lag a just-accepted write. */
async function repos(tools: Tools, channel: string, strong: boolean) {
  const bound: BuzzEvent[] = [];
  let cursor = {};
  let complete = false;
  for (let page = 0; page < REPO_PAGES && !complete; page++) {
    const events = await tools.client.query([
      {
        kinds: [30617],
        "#buzz-channel": [channel],
        limit: 100,
        ...(strong ? { consistency: "strong" } : {}),
        ...cursor,
      },
    ]);
    bound.push(
      ...events.filter((event) => tag(event, "buzz-channel") === channel),
    );
    complete = events.length < 100;
    // The relay's cursor: at or before `until`, after `before_id` at a tie.
    const last = events.at(-1);
    if (last) cursor = { until: last.created_at, before_id: last.id };
  }
  const trusted = await Promise.all(
    bound.map(async (event) =>
      leads(tools, channel, event.pubkey, await attestedOwner(event)),
    ),
  );
  return { found: bound.filter((_, index) => trusted[index]), complete };
}

/** Announces repository `name` for `channel`, protected, once every check
 * passes, and confirms the relay now binds it there. */
async function start(tools: Tools, channel: string, name: string) {
  const { client } = tools;
  const { found, complete } = await repos(tools, channel, true);
  if (found.length) throw new Error("This channel already has a repository.");
  if (!complete)
    throw new Error(
      "This channel's repositories could not all be read, so none was started; try again.",
    );
  if (!(await tools.metadata(channel))) throw unseen(channel);
  // Announcing it again would move it, history and all, to this channel.
  const coordinate = {
    kinds: [30617],
    authors: [client.pubkey],
    "#d": [name],
    limit: 1,
    consistency: "strong",
  };
  const [mine] = await client.query([coordinate]);
  if (mine) throw new Error(`You already have a repository named ${name}.`);
  if (!(await leads(tools, channel, client.pubkey, client.owner)))
    throw new Error(
      "Only a channel's owner or an admin, or their agent, can start its repository.",
    );
  // Members may push; no one may rewrite or delete a branch, nested or not.
  const created = await client.publish({
    kind: 30617,
    content: "",
    tags: [
      ["d", name],
      ["name", name],
      ["buzz-channel", channel],
      ["buzz-protect", "refs/heads/**", "no-force-push", "no-delete"],
    ],
  });
  let current: BuzzEvent | undefined;
  try {
    [current] = await client.query([coordinate]);
  } catch (error) {
    throw new Error(`${name} was announced, but ${unread(error).message}`);
  }
  if (current?.id !== created.id || tag(current, "buzz-channel") !== channel)
    throw new Error(`${name} was announced, but the relay binds it elsewhere.`);
  return created;
}

/** The repository's URL and a Git command with its headers, one per line. */
async function access(
  gitAuth: NonNullable<BuzzClient["gitAuth"]>,
  event: BuzzEvent,
) {
  const { url, header } = await gitAuth(event.pubkey, tag(event, "d") ?? "");
  return [
    `${tag(event, "name") ?? tag(event, "d")}: ${url}`,
    "For the next 60 seconds, pass these headers to each git command (call again for a new one; never save it):",
    `git ${header
      .split("\n")
      .map((line) => `-c http.${url}.extraHeader='${line}' `)
      .join("")}clone ${url}`,
  ].join("\n");
}

/** Whether `author`, or the `owner` it acts for, is an owner or admin of
 * `channel`. */
async function leads(
  tools: Tools,
  channel: string,
  author: string,
  owner: string | undefined,
) {
  return (await tools.members(channel)).some(
    (member) =>
      (member.role === "owner" || member.role === "admin") &&
      (member.pubkey === author || member.pubkey === owner),
  );
}

/** A failed read after a write, as the reason the write is not confirmed. */
const unread = (error: unknown) =>
  new Error(`its state could not be read back: ${reason(error)}`);

/** The channel's newest canvas, once the channel is known to be visible. */
async function canvas(tools: Tools, channel: string) {
  const [head] = await tools.client.query([
    { kinds: [40100], "#h": [channel], limit: 1 },
  ]);
  if (!head && !(await tools.metadata(channel))) throw unseen(channel);
  return head;
}

/** Makes lifecycle change `action` to the `channel` argument. The relay can
 * accept a change it then fails to make, so it is reported only once the
 * channel shows it. */
async function lifecycle(
  tools: Tools,
  args: Args,
  action: "join" | "leave" | "archive" | "unarchive" | "delete",
) {
  const { client } = tools;
  const channel = target(tools, args);
  const { kind, content, tags } = lifecycleTemplate(action, channel);
  await client.publish({ kind, content, tags });
  const shown = async () => {
    if (action === "join" || action === "leave")
      return (
        (await tools.roster(channel)).some(
          (member) => member.pubkey === client.pubkey,
        ) ===
        (action === "join")
      );
    const metadata = await tools.metadata(channel);
    if (action === "delete") return !metadata;
    return !!metadata && has(metadata, "archived") === (action === "archive");
  };
  const done = {
    join: "joined",
    leave: "left",
    archive: "archived",
    unarchive: "unarchived",
    delete: "deleted",
  };
  const now = await until(shown, Boolean).catch(unread);
  if (now === true) return `${done[action]} ${channel}`;
  return `The community accepted ${action} but ${now ? now.message : "does not show it yet"}.`;
}

/** Adds or removes `pubkeys`, each tried on its own; a throw when none
 * changed. */
async function changeMembers(
  tools: Tools,
  args: Args,
  change: "add" | "remove",
  role?: string,
) {
  const channel = target(tools, args);
  const pubkeys = keys(args, "pubkeys");
  if (!pubkeys.length) throw new Error("pubkeys is required.");
  lifecycleChannelId(channel);
  if (pubkeys.includes(tools.client.pubkey))
    throw new Error("For yourself, use channel_join or channel_leave.");
  if (pubkeys.length > 50)
    throw new Error("Change at most 50 members at a time.");
  const { lines, changed } = await tools.change(
    channel,
    change === "add" ? pubkeys : [],
    change === "remove" ? pubkeys : [],
    role,
  );
  if (!changed) throw new Error(lines.join("\n"));
  return lines.join("\n");
}

/** The `channel` argument, or the current channel only when it is left out. */
function target(tools: Tools, args: Args) {
  if (args.channel === undefined) {
    if (!tools.context.channel) throw new Error("channel is required here.");
    return tools.context.channel;
  }
  const channel = text(args.channel);
  if (!channel) throw new Error("channel must be a channel ID.");
  return channel;
}

/** A list of pubkeys or npubs, each once; any other entry is refused, not dropped. */
function keys(args: Args, name: string) {
  const value = args[name];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${name} must be a list of pubkeys.`);
  return [...new Set(value.map(pubkey))];
}

/** An optional text argument, trimmed; refused when it is not text. */
function optional(args: Args, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be text.`);
  return value.trim();
}

/** A `ttl` argument: undefined when absent or 0, which means never. */
function seconds(value: unknown) {
  if (value === undefined || value === 0) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
    throw new Error("ttl must be a whole number of seconds.");
  return value;
}

/** A `join_role` argument: undefined when absent. */
function joinRoleArg(args: Args) {
  const value = args.join_role;
  if (value === undefined) return undefined;
  if (value !== "member" && value !== "guest")
    throw new Error("join_role must be member or guest.");
  return value;
}

/** A `since` or `before` argument: a Unix time in seconds, inclusive. */
function unixTime(args: Args, key: string) {
  const value = args[key];
  if (value === undefined) return undefined;
  // In milliseconds, a time from this century is past the year 5000.
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= 1e11
  )
    throw new Error(
      `${key} must be Unix seconds: a whole number, not milliseconds.`,
    );
  return value as number;
}

/** The checks Buzz makes on a channel's name, description and lifetime. */
function checkDetails(name?: string, about?: string, ttl?: number) {
  const errors = detailsDraftErrors({
    name: name ?? "-",
    description: about ?? "",
    visibility: "public",
    ttlSeconds: ttl,
  });
  const error = errors.name ?? errors.description ?? errors.lifetime;
  if (error) throw new Error(error);
}
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
function required(args: Args, name: string) {
  const value = args[name];
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required.`);
  return value;
}
const bound = (value: number | undefined, fallback: number, max: number) =>
  Math.max(1, Math.min(max, Math.floor(value ?? fallback)));
const time = (seconds: number) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16)}Z`;
