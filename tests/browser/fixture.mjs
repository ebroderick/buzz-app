import { fixtureRelayUrl, fixtureAliases } from "../relay-config.ts";
import { test as base, expect, stopRoutes } from "./playwright-test.mjs";
import { preview } from "./vite-server.mjs";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  verifyEvent,
} from "nostr-tools";
import { writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { platform, arch } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { relayBrokerPlugin } from "../../browser-host/relay-broker.mjs";
import { policyRelay } from "./policy-relay.mjs";
import { buildApp } from "./build.mjs";
import { fixtureBody } from "./fixture-body.mjs";
import { watchPageErrors } from "./page-errors.mjs";
import { validTypingTemplate } from "../../src/features/relay/typing-protocol.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Public nonmember channel for search/preview/join journeys. Real channel ids
// are UUIDs, and lifecycle commands accept only UUID channel ids.
const OPEN_CHANNEL = "6f70656e-0000-4000-8000-000000000001";
export const channels = ["alpha", "beta"];
export const historySize = 640;

// The built app, React, services, verification, IndexedDB and Virtua stay real.
// Layout journeys use synthetic broker HTTP; live journeys retain the production
// broker/subscriber and model only the upstream relay policy with ephemeral keys.
export const test = base.extend({
  productionBroker: [false, { option: true }],
  enabledPlugins: [[], { option: true }],
  builderlab: [{}, { option: true }],
  /** The production broker's live setup deadline. It runs in Node, so the
   * page clock cannot hold it; a test that keeps EOSE pending sets it longer. */
  liveSetupTimeoutMs: [undefined, { option: true }],
  actionProfile: [false, { option: true }],
  agentMessageDeletion: [false, { option: true }],
  profilePicture: ["", { option: true }],
  readState: [false, { option: true }],
  threadUnread: [false, { option: true }],
  presenceThreadAuthors: [0, { option: true }],
  threadUnreadMentions: [false, { option: true }],
  threadUnreadJoined: [false, { option: true }],
  threadUnreadOwnedRoot: [true, { option: true }],
  exactMessages: [false, { option: true }],
  openSearch: [false, { option: true }],
  searchAuthor: [false, { option: true }],
  soloChannels: [[], { option: true }],
  sessionMembers: [{}, { option: true }],
  channelWriteKinds: [null, { option: true }],
  sidebarUnread: [false, { option: true }],
  savedSidebar: [false, { option: true }],
  ownSoloChannels: [[], { option: true }],
  soloAgentNames: [[], { option: true }],
  soloOutsideAgentNames: [[], { option: true }],
  sortingSidebar: [false, { option: true }],
  initialSidebarSort: [{}, { option: true }],
  channelLifecycle: [false, { option: true }],
  leaveRosterBeforeAck: [false, { option: true }],
  guestPermalinks: [false, { option: true }],
  lifecycleRole: ["owner", { option: true }],
  lifecycleOwnerAgent: [false, { option: true }],
  lifecycleVisibility: [{ archived: [], hidden: [] }, { option: true }],
  autoJoinChannels: [[], { option: true }],
  sidebarIcons: [false, { option: true }],
  channelNames: [{}, { option: true }],
  expectedPageFailure: [false, { option: true }],
  expectedSidebarIconFailure: [false, { option: true }],
  largeSidebar: [false, { option: true }],
  iconCongestion: [false, { option: true }],
  dmLabels: [false, { option: true }],
  dmMembers: [{}, { option: true }],
  agentPeers: [false, { option: true }],
  inboxDm: [false, { option: true }],
  inboxDmOldAnchor: [false, { option: true }],
  inboxThreadWindow: [false, { option: true }],
  inboxSoloAgent: [false, { option: true }],
  tallMessages: [false, { option: true }],
  // Opt-in perf workload: chat-like Markdown (code, links, lists, mentions)
  // in most corpus rows instead of inert prose.
  markdownMessages: [false, { option: true }],
  // Opt-in perf workload: newer activity in another joined channel fills the
  // startup unread read, so corpus history reaches the app first-seen.
  firstSeenHistory: [false, { option: true }],
  // Opt-in perf workload: let modeled HTTP pages arrive during wheel input.
  olderPageDelayMs: [null, { option: true }],
  membershipActivity: [false, { option: true }],
  // Joins newer than all alpha history, by distinct new members.
  membershipBurst: [0, { option: true }],
  launchAnimation: [false, { option: true }],
  historyCounts: [{ alpha: 1, beta: 1 }, { option: true }],
  // Rows sharing each history second; above the page size, pages split seconds.
  historyRowsPerSecond: [1, { option: true }],
  channelIds: [channels, { option: true }],
  developmentReact: [false, { option: true, scope: "worker" }],
  builderlabLogin: [false, { option: true, scope: "worker" }],
  pluginFixtures: [false, { option: true, scope: "worker" }],
  localAgentActivity: [false, { option: true, scope: "worker" }],
  pairingFixture: [false, { option: true, scope: "worker" }],
  companionFixture: [false, { option: true, scope: "worker" }],
  compiledApp: [buildApp, { scope: "worker" }],
  app: async (
    {
      page,
      context,
      browserName,
      browser,
      productionBroker,
      enabledPlugins,
      builderlab,
      liveSetupTimeoutMs,
      actionProfile,
      agentMessageDeletion,
      profilePicture,
      readState,
      threadUnread,
      presenceThreadAuthors,
      threadUnreadMentions,
      threadUnreadJoined,
      threadUnreadOwnedRoot,
      exactMessages,
      openSearch,
      searchAuthor,
      soloChannels,
      sessionMembers,
      channelWriteKinds,
      sidebarUnread,
      savedSidebar,
      ownSoloChannels,
      soloAgentNames,
      soloOutsideAgentNames,
      sortingSidebar,
      initialSidebarSort,
      channelLifecycle,
      leaveRosterBeforeAck,
      guestPermalinks,
      lifecycleRole,
      lifecycleOwnerAgent,
      lifecycleVisibility,
      autoJoinChannels,
      sidebarIcons,
      channelNames,
      expectedPageFailure,
      expectedSidebarIconFailure,
      largeSidebar,
      iconCongestion,
      dmLabels,
      dmMembers,
      agentPeers,
      inboxDm,
      inboxDmOldAnchor,
      inboxThreadWindow,
      inboxSoloAgent,
      tallMessages,
      markdownMessages,
      firstSeenHistory,
      olderPageDelayMs,
      membershipActivity,
      membershipBurst,
      launchAnimation,
      historyCounts,
      historyRowsPerSecond,
      channelIds,
      pluginFixtures,
      developmentReact,
      compiledApp,
    },
    use,
    testInfo,
  ) => {
    const channels = firstSeenHistory ? [...channelIds, "busy"] : channelIds;
    const key = (seed) =>
      actionProfile
        ? Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? seed : 0))
        : generateSecretKey();
    const relayKey = key(1);
    const typingKeys = [key(2), key(3)];
    const userKey = key(4);
    const viewer = getPublicKey(userKey);
    const membershipKeys = membershipActivity
      ? [generateSecretKey(), generateSecretKey()]
      : [];
    const membershipEvent = (
      type,
      targetIndex,
      time,
      actorIndex = -1,
      forged = false,
    ) =>
      sign(
        40099,
        [["h", channels[0]]],
        JSON.stringify({
          type,
          actor:
            actorIndex < 0 ? viewer : getPublicKey(membershipKeys[actorIndex]),
          target: getPublicKey(membershipKeys[targetIndex]),
        }),
        forged ? userKey : relayKey,
        time,
      );
    const peerKeys =
      dmLabels ||
      readState ||
      exactMessages ||
      actionProfile ||
      markdownMessages
        ? [key(5), ...(dmLabels ? [key(6), key(7)] : [])]
        : [];
    const peerKey = peerKeys[0];
    const communityIds = {
      primary: "01234567-89ab-cdef-0123-456789abcdef",
      secondary: "11234567-89ab-cdef-0123-456789abcdef",
    };
    const readEvents = new Map([
      ["primary", new Map()],
      ["secondary", new Map()],
    ]);
    const agentRecords = new Map([
      ["primary", new Map()],
      ["secondary", new Map()],
    ]);
    const sign = (
      kind,
      tags,
      content = "",
      key = relayKey,
      time = 1700000000,
    ) => finalizeEvent({ kind, tags, content, created_at: time }, key);
    const profiles = new Map(
      ["primary", "secondary"].map((community) => [
        community,
        sign(
          0,
          [],
          JSON.stringify({ name: "Fixture Reader", picture: profilePicture }),
          userKey,
        ),
      ]),
    );
    // Kind 0 by author for keys a test creates; served on later profile reads.
    const servedProfiles = new Map();
    const soloAgentKeys = [];
    const soloAgents = [...soloAgentNames, ...soloOutsideAgentNames].map(
      (name) => {
        const key = generateSecretKey();
        soloAgentKeys.push(key);
        const pubkey = getPublicKey(key);
        // A NIP-OA owner attestation marks a real agent profile; the app reads
        // only its shape. Outside agents belong to someone else.
        const owner = soloAgentNames.includes(name)
          ? viewer
          : getPublicKey(generateSecretKey());
        servedProfiles.set(
          pubkey,
          sign(
            0,
            [["auth", owner, "", "0".repeat(128)]],
            JSON.stringify({ name, is_agent: true }),
            key,
          ),
        );
        return { pubkey, name };
      },
    );
    const ownerAgentKey =
      lifecycleOwnerAgent || agentMessageDeletion
        ? generateSecretKey()
        : undefined;
    const ownerAgent = ownerAgentKey ? getPublicKey(ownerAgentKey) : undefined;
    const ownerAuthDigest = ownerAgent
      ? new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(`nostr:agent-auth:${ownerAgent}:`),
          ),
        )
      : undefined;
    const ownerAgentProfile = ownerAgentKey
      ? sign(
          0,
          [
            [
              "auth",
              viewer,
              "",
              bytesToHex(schnorr.sign(ownerAuthDigest, userKey)),
            ],
          ],
          JSON.stringify({ name: "Owner Agent", is_agent: true }),
          ownerAgentKey,
        )
      : undefined;
    const ownerAttestationValid =
      !!ownerAgent &&
      !!ownerAgentProfile &&
      !!ownerAuthDigest &&
      schnorr.verify(
        hexToBytes(ownerAgentProfile.tags[0][3]),
        ownerAuthDigest,
        hexToBytes(viewer),
      );
    const participants = largeSidebar
      ? Array.from({ length: 1001 }, (_, i) =>
          (i + 1).toString(16).padStart(64, "0"),
        )
      : peerKeys.map(getPublicKey);
    const dmIds = Object.keys(dmMembers).length
      ? Object.keys(dmMembers)
      : largeSidebar
        ? Array.from(
            { length: 128 },
            (_, i) => `dm-${i.toString().padStart(3, "0")}`,
          )
        : dmLabels
          ? ["dm-peer", "dm-group"]
          : inboxDm || inboxDmOldAnchor
            ? ["dm-peer"]
            : [];
    const sortingIds = sortingSidebar ? ["cedar", "maple", "willow"] : [];
    const renamedChannels = new Map();
    const lifecycleRows = channelLifecycle
      ? [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Lifecycle channel",
            type: "stream",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Lifecycle DM",
            type: "dm",
          },
        ]
      : [];
    const guestChannelId = guestPermalinks ? lifecycleRows[0].id : undefined;
    const archivedIds = new Set(lifecycleVisibility.archived);
    const hiddenDmIds = new Set(lifecycleVisibility.hidden);
    let lifecycleTime = 1700000001;
    const joinedRoles = new Map();
    const channelGuests = new Map();
    const rosterIds = [
      ...new Set([
        ...channels,
        ...dmIds,
        ...sortingIds,
        ...lifecycleRows
          .filter(
            (row) => row.id !== guestChannelId || lifecycleRole !== "nonmember",
          )
          .map((row) => row.id),
      ]),
    ];
    if (savedSidebar) {
      const key = nip44.v2.utils.getConversationKey(userKey, viewer);
      for (const community of ["primary", "secondary"]) {
        const records = readEvents.get(community);
        for (const [coordinate, value] of [
          [
            "channel-sections",
            {
              version: 1,
              sections: [
                {
                  id: "work",
                  name: "Work",
                  order: 0,
                  ...(sidebarIcons ? { icon: ":stamp:" } : {}),
                },
                ...(sidebarIcons
                  ? [
                      {
                        id: "missing",
                        name: "Unavailable",
                        order: 1,
                        icon: ":unavailable_icon:",
                      },
                      { id: "laptop", name: "Laptop", order: 2, icon: "👨‍💻" },
                    ]
                  : []),
              ],
              assignments: { beta: "work" },
            },
          ],
          [
            "channel-stars",
            {
              version: 1,
              channels: { alpha: { starred: true, updatedAt: 1 } },
            },
          ],
          ["channel-sort", { version: 1, groups: initialSidebarSort }],
        ]) {
          records.set(
            coordinate,
            sign(
              30078,
              [["d", coordinate]],
              nip44.v2.encrypt(JSON.stringify(value), key),
              userKey,
            ),
          );
        }
      }
    }
    if (ownSoloChannels.length) {
      if (!productionBroker)
        throw new Error(
          "Own Solo chat fixtures require the production decoder",
        );
      for (const community of ["primary", "secondary"]) {
        const scope = JSON.parse(fixtureAliases)[community];
        const coordinate = `buzz-me-kit-v1:${encodeURIComponent(scope)}:groups:me`;
        const record = {
          version: 1,
          community: scope,
          deleted: false,
          value: {
            type: "groups",
            id: "me",
            groups: [],
            assignments: {},
          },
        };
        readEvents.get(community).set(
          coordinate,
          sign(
            30078,
            [
              ["d", coordinate],
              ["t", "buzz-me-kit-v1"],
            ],
            nip44.v2.encrypt(
              JSON.stringify(record),
              nip44.v2.utils.getConversationKey(userKey, viewer),
            ),
            userKey,
          ),
        );
      }
    }
    const hiddenChannels = new Set();
    const soloDetails = new Map();
    const servedMembers = new Map(Object.entries(sessionMembers));
    const streams = new Map();
    const streamOwners = new Map();
    // Tall histories leave room above the older-page prefetch threshold, even
    // with the compact message type and an extra upward resize-test gesture.
    const histories = new Map();
    const historyStarted = performance.now();
    // One row in eight stays inert prose. The others end with common chat
    // content: colon or multi-paragraph prose, links, a bound mention, a list,
    // code and a quote. Bullet lists only: browser helpers address the
    // timeline through its single ordered list.
    const markdown = [
      () => "",
      (i) =>
        `Update: deploy ${i} finished at 14:${String(i % 60).padStart(2, "0")}, then the relay restarted.`,
      () => "\nA second paragraph follows the blank line.",
      (i) =>
        `Notes: https://example.com/notes/${i} and [the design doc](https://example.com/design/${i % 5}#history).`,
      (i) => `@Alice Fixture can you check item ${i}? Thanks!`,
      () =>
        "Follow-ups:\n- update the fixture\n- rerun `bin/pnpm perf`\n  - compare **medians**",
      (i) =>
        `Repro:\n\`\`\`js\nconst page = await reader.read({ limit: ${20 + (i % 5)} });\nconsole.log(page.length);\n\`\`\``,
      () =>
        "> Can we ship _this_ today?\n\n**Yes**, after ~~one more~~ review.",
    ];
    for (const community of ["primary", "secondary"])
      for (const channel of channels)
        histories.set(
          `${community}/${channel}`,
          Array.from({ length: historyCounts[channel] }, (_, i) => {
            const syntax = markdownMessages ? markdown[i % 8](i) : "";
            return sign(
              9,
              [
                ["h", channel],
                // Mentions bind a known profile name through a p tag.
                ...(syntax.startsWith("@")
                  ? [["p", getPublicKey(peerKey)]]
                  : []),
                // Shared seconds keep the send order real messages carry.
                ...(historyRowsPerSecond > 1
                  ? [
                      [
                        "ms",
                        String(
                          (i % historyRowsPerSecond) *
                            Math.floor(1000 / historyRowsPerSecond),
                        ),
                      ],
                    ]
                  : []),
              ],
              `${community} ${channel} message ${i}\n${"Mixed height message content. ".repeat((1 + (i % 7) * 3) * (tallMessages ? 5 : 1))}${syntax ? `\n${syntax}` : ""}`,
              readState ? peerKey : userKey,
              1700000100 + Math.floor(i / historyRowsPerSecond),
            );
          }),
        );
    // The app's unread read takes the newest 500 events across joined channels.
    if (firstSeenHistory)
      histories.set(
        "primary/busy",
        Array.from({ length: 500 }, (_, i) =>
          sign(
            9,
            [["h", "busy"]],
            `Newer activity ${i}`,
            userKey,
            1700100000 + i,
          ),
        ),
      );
    const ownerAgentMessage = agentMessageDeletion
      ? sign(
          9,
          [["h", "alpha"]],
          "Owned agent deletion fixture",
          ownerAgentKey,
          Math.max(
            ...histories.get("primary/alpha").map((event) => event.created_at),
          ) + 1,
        )
      : undefined;
    if (ownerAgentMessage)
      histories.get("primary/alpha").push(ownerAgentMessage);
    const historyDurationMs = performance.now() - historyStarted;
    for (const community of ["primary", "secondary"])
      for (const id of [...dmIds, ...lifecycleRows.map((row) => row.id)])
        histories.set(`${community}/${id}`, []);
    for (const community of ["primary", "secondary"])
      for (const [index, id] of sortingIds.entries())
        histories.set(`${community}/${id}`, [
          sign(
            9,
            [["h", id]],
            `Activity in ${id}`,
            userKey,
            1700000200 + index,
          ),
        ]);
    const targetEvents = [];
    // Enough newer roots to put the permalink outside the initial history page.
    if (guestChannelId)
      histories.set(
        `primary/${guestChannelId}`,
        Array.from({ length: 103 }, (_, i) =>
          sign(
            9,
            [["h", guestChannelId]],
            `Guest room history ${i}`,
            peerKey,
            1700000000 + i,
          ),
        ),
      );
    let searchTarget;
    if (openSearch) {
      const root = sign(
        9,
        [["h", OPEN_CHANNEL]],
        "Public conversation root",
        userKey,
        1699999000,
      );
      searchTarget = sign(
        9,
        [
          ["h", OPEN_CHANNEL],
          ["e", root.id, "", "reply"],
        ],
        "crew-search exact public reply",
        userKey,
        1699999001,
      );
      histories.set(`primary/${OPEN_CHANNEL}`, [root]);
      targetEvents.push(searchTarget);
    }
    let exact;
    if (exactMessages) {
      const exactChannelId = guestChannelId ?? "alpha";
      const root = histories.get(`primary/${exactChannelId}`)[2];
      const replies = Array.from({ length: guestChannelId ? 3 : 80 }, (_, i) =>
        sign(
          9,
          [
            ["h", exactChannelId],
            ["e", root.id, "", "reply"],
            ["p", getPublicKey(peerKey)],
          ],
          `Old thread reply ${i} · Hello @Alice Fixture`,
          userKey,
          root.created_at + i + 1,
        ),
      );
      if (exactMessages === "nested") {
        const last = replies.at(-1);
        replies[replies.length - 1] = sign(
          9,
          [
            ["h", exactChannelId],
            ["e", root.id, "", "root"],
            ["e", replies.at(-2).id, "", "reply"],
            ["p", getPublicKey(peerKey)],
          ],
          last.content,
          userKey,
          last.created_at,
        );
      }
      const target = replies.at(-1);
      const edit = sign(
        40003,
        [["e", target.id]],
        "**Exact reply edited** · Hello @Alice Fixture",
        userKey,
        target.created_at + 1,
      );
      const reaction = sign(
        7,
        [["e", target.id]],
        "+",
        userKey,
        target.created_at + 2,
      );
      const deletion = sign(
        5,
        [["e", reaction.id]],
        "",
        userKey,
        target.created_at + 3,
      );
      targetEvents.push(...replies, edit, reaction, deletion);
      exact = { root, target, replies, edit, reaction, deletion };
    }
    if (membershipActivity) {
      const history = histories.get(`primary/${channels[0]}`);
      history.push(
        membershipEvent("member_joined", 0, 1700000740),
        membershipEvent("member_joined", 1, 1700000741),
      );
    }
    if (membershipBurst) {
      const history = histories.get(`primary/${channels[0]}`);
      const start = history.at(-1).created_at + 1;
      history.push(
        ...Array.from({ length: membershipBurst }, (_, i) =>
          sign(
            40099,
            [["h", channels[0]]],
            JSON.stringify({
              type: "member_joined",
              actor: viewer,
              target: getPublicKey(generateSecretKey()),
            }),
            relayKey,
            start + i,
          ),
        ),
      );
    }
    let inboxDmAnchor;
    if (inboxDmOldAnchor) {
      inboxDmAnchor = sign(
        9,
        [["h", "dm-peer"]],
        "Inbox old DM anchor",
        peerKey,
        1700000800,
      );
      histories
        .get("primary/dm-peer")
        .push(
          inboxDmAnchor,
          ...Array.from({ length: 24 }, (_, index) =>
            sign(
              9,
              [["h", "dm-peer"]],
              `Recent DM ${index}`,
              userKey,
              1700000810 + index,
            ),
          ),
        );
    }
    if (inboxDm)
      histories
        .get("primary/dm-peer")
        .push(
          sign(
            9,
            [["h", "dm-peer"]],
            "Inbox DM fixture reply",
            peerKey,
            1700000900,
          ),
        );
    if (sidebarUnread) {
      for (const id of Object.keys(dmMembers).length
        ? Object.keys(dmMembers)
        : ["dm-030", "dm-090"])
        histories.set(`primary/${id}`, [
          sign(9, [["h", id]], `Unread in ${id}`, peerKey, 1700000900),
        ]);
    }
    // Opt-in upstream thread evidence: no client cache/read-state injection.
    // Uppercase signed references exercise canonical thread/unread parity.
    const threadReplies = new Map(
      exact ? [[exact.root.id, exact.replies]] : [],
    );
    if (searchTarget)
      threadReplies.set(searchTarget.tags.find(([key]) => key === "e")[1], [
        searchTarget,
      ]);
    const threadSummaries = [];
    // Viewer replies older than the unread sample: the thread view and the
    // conversation lookup return them, but channel unread evidence never does.
    const displacedReplies = new Map();
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      for (const [index, event] of history.slice(-2).entries()) {
        const root = sign(
          9,
          [["h", "alpha"]],
          `Thread root ${index}`,
          // The viewer owns the first thread, so its direct replies are the
          // viewer's conversation. The second is a peer thread: it counts only
          // when a mention names the viewer, or the viewer joined it with an
          // older reply that only the membership lookup returns.
          index === 0 && threadUnreadOwnedRoot ? userKey : peerKey,
          event.created_at,
        );
        history[history.length - 2 + index] = root;
        const replies = [
          sign(
            9,
            [
              ["h", "alpha"],
              ["e", root.id.toUpperCase(), "", "reply"],
              ...(threadUnreadMentions && index === 1 ? [["p", viewer]] : []),
            ],
            `Unread reply ${index}`,
            peerKey,
            root.created_at + 10,
          ),
        ];
        if (threadUnreadJoined && index === 1)
          displacedReplies.set(root.id, [
            sign(
              9,
              [
                ["h", "alpha"],
                ["e", root.id.toUpperCase(), "", "reply"],
              ],
              "Viewer reply",
              userKey,
              root.created_at + 5,
            ),
          ]);
        threadReplies.set(root.id, replies);
        threadSummaries.push(
          sign(
            39005,
            [
              ["h", "alpha"],
              ["e", root.id],
              ["d", root.id],
            ],
            JSON.stringify({
              reply_count: 23,
              participants: [getPublicKey(peerKey)],
            }),
          ),
        );
      }
    }
    if (threadUnread) {
      const history = histories.get("primary/alpha");
      const root = history.at(-2);
      const broadcast = sign(
        9,
        [
          ["h", "alpha"],
          ["e", root.id.toUpperCase(), "", "reply"],
          ["broadcast", "1"],
        ],
        "Broadcast reply",
        peerKey,
        root.created_at + 2,
      );
      history.push(broadcast);
      const replies = threadReplies.get(root.id);
      replies.push(broadcast);
      replies.push(
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", root.id.toUpperCase(), "", "root"],
            ["e", broadcast.id.toUpperCase(), "", "reply"],
            // Nested under the peer's reply, so only the mention makes it count.
            ["p", viewer],
          ],
          "Broadcast descendant",
          peerKey,
          root.created_at + 11,
        ),
      );
      threadSummaries.push(
        sign(
          39005,
          [
            ["h", "alpha"],
            ["e", broadcast.id],
            ["d", broadcast.id],
          ],
          JSON.stringify({
            reply_count: 23,
            participants: [getPublicKey(peerKey)],
          }),
        ),
      );
    }
    let inboxWindow;
    if (inboxThreadWindow) {
      const channelId = channels.find((id) => /^[0-9a-f-]{36}$/.test(id));
      if (!channelId)
        throw new Error("Inbox window needs a canonical fixture channel");
      const root = sign(
        9,
        [["h", channelId]],
        "Inbox strict root",
        userKey,
        1700000100,
      );
      const replies = Array.from({ length: 15 }, (_, index) =>
        sign(
          9,
          [
            ["h", channelId],
            ["e", root.id, "", "reply"],
            ["p", viewer],
          ],
          `Inbox strict reply ${index}`,
          peerKey,
          1700000200 + index,
        ),
      );
      histories.set(`primary/${channelId}`, [root, ...replies]);
      threadReplies.set(root.id, replies);
      inboxWindow = { channelId, root, replies };
    }
    // Signed upstream-only stress data; production traversal and mounting stay real.
    let presenceThread;
    if (presenceThreadAuthors) {
      const threadRoot = histories
        .get("primary/alpha")
        .find((event) => event.content === "Thread root 0");
      if (!threadRoot) throw new Error("Presence thread requires threadUnread");
      const replies = Array.from({ length: presenceThreadAuthors }, (_, i) =>
        sign(
          9,
          [
            ["h", "alpha"],
            ["e", threadRoot.id, "", "reply"],
          ],
          `Distinct author reply ${i}`,
          generateSecretKey(),
          threadRoot.created_at + i + 20,
        ),
      );
      threadReplies.set(threadRoot.id, replies);
      // The ordinary unread fixture also broadcasts one reply into the timeline.
      // This stress case owns exactly the distinct replies above, not that extra row.
      histories.set(
        "primary/alpha",
        histories
          .get("primary/alpha")
          .filter(
            (event) =>
              !event.tags.some(
                ([key, value]) =>
                  key === "e" && value.toLowerCase() === threadRoot.id,
              ),
          ),
      );
      presenceThread = { root: threadRoot, replies };
    }
    if (actionProfile) {
      const root = histories
        .get("primary/alpha")
        .find((row) => row.content === "Thread root 1");
      targetEvents.push(
        sign(
          7,
          [
            ["h", "alpha"],
            ["e", root.id],
          ],
          "👍",
          peerKey,
        ),
      );
    }
    const report = {
      state: {
        head: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        dirty: execFileSync("git", ["status", "--porcelain"], {
          cwd: root,
          encoding: "utf8",
        }),
        browserName,
        developmentReact,
        pluginFixtures,
        agentMessageDeletion,
        compiledBuild: {
          worker: testInfo.workerIndex,
          durationMs: compiledApp.durationMs,
        },
        signedHistory: { counts: historyCounts, durationMs: historyDurationMs },
        largeSidebar,
        readState,
        sidebarUnread,
        savedSidebar,
        sortingSidebar,
        initialSidebarSort,
        dmLabels,
        agentPeers,
        tallMessages,
        markdownMessages,
        firstSeenHistory,
        olderPageDelayMs,
        browserVersion: browser.version(),
        node: process.version,
        platform: platform(),
        arch: arch(),
        viewport: testInfo.project.use.viewport,
        build: `${developmentReact ? "Vite production build with development React" : "production frontend"}; ${productionBroker ? "production broker; modeled upstream WS/HTTP policy" : "fixture broker HTTP"}; no native; no real relay`,
      },
      queries: [],
      profileSearches: [],
      publications: [],
      typingPublications: [],
      readPublications: [],
      sessions: [],
      streamConnections: [],
      streamInterests: [],
      errors: [],
      consoleErrors: [],
      unexpected: [],
      cancelledRequests: [],
      measurements: [],
    };
    const pending = [];
    // IDs of events in modeled HTTP responses; perf proves first-seen reads.
    const served = new Set();
    const olderPageTimers = new Set();
    const retiredStreams = new Set();
    const observerFailures = [];
    const consoleLocations = new Map();
    const send = (response, body, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    // Relay `POST /profiles/search`: the NIP-50 prefix rule (every word but
    // the last equals a name word, the last is a word prefix, any order) over
    // `name` and `display_name` only, then equal, prefix, later-word prefix.
    // Unlike NIP-50 kind:0 search, other profile text such as avatar data
    // never matches.
    const searchProfiles = (community, { query, limit, page = 1 }) => {
      const typed = query.trim().toLowerCase().split(/\s+/);
      const needle = typed.join(" ");
      const field = (value) =>
        typeof value === "string" ? value.toLowerCase().trim() : "";
      const tier = (value) =>
        !value
          ? 3
          : value === needle
            ? 0
            : value.startsWith(needle)
              ? 1
              : value.includes(` ${needle}`)
                ? 2
                : 3;
      report.profileSearches.push({ community, query, limit, page });
      return [
        ...new Map(
          [
            profiles.get(community),
            ...servedProfiles.values(),
            ...(ownerAgentProfile ? [ownerAgentProfile] : []),
          ]
            .filter(Boolean)
            .map((event) => [event.pubkey, event]),
        ).values(),
      ]
        .flatMap((event) => {
          const { name, display_name: display } = JSON.parse(event.content);
          const words = `${field(name)} ${field(display)}`
            .split(/[^\p{L}\p{N}]+/u)
            .filter(Boolean);
          const matches = typed.every((word, index) =>
            index === typed.length - 1
              ? words.some((candidate) => candidate.startsWith(word))
              : words.includes(word),
          );
          return matches
            ? [
                {
                  event,
                  rank: Math.min(tier(field(name)), tier(field(display))),
                },
              ]
            : [];
        })
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            b.event.created_at - a.event.created_at ||
            a.event.id.localeCompare(b.event.id),
        )
        .slice((page - 1) * limit, page * limit)
        .map((entry) => entry.event);
    };
    const answer = (community, filter) => {
      // These ordinary fixture channels have no Huddle creation receipt.
      if (filter.kinds?.length === 1 && filter.kinds[0] === 9007) return [];
      // The real relay can return both current metadata and rosters in one query.
      if (filter.kinds?.includes(39000) && filter.kinds?.includes(39002))
        return [39000, 39002].flatMap((kind) =>
          answer(community, { ...filter, kinds: [kind] }),
        );
      const previewId = filter["#d"]?.length === 1 && filter["#d"][0];
      const preview =
        previewId &&
        !rosterIds.includes(previewId) &&
        soloDetails.get(`${community}/${previewId}`);
      const rosterKind = filter.kinds?.find(
        (kind) => kind === 39001 || kind === 39002,
      );
      if (preview && rosterKind) {
        const owner = preview.tags.find(([key]) => key === "P")?.[1];
        if (filter["#p"] && !filter["#p"].includes(owner)) return [];
        return [
          sign(
            rosterKind,
            [
              ["d", previewId],
              ...(owner
                ? [
                    rosterKind === 39002
                      ? ["p", owner, "", "owner"]
                      : ["p", owner, "owner"],
                  ]
                : []),
            ],
            "",
            relayKey,
            lifecycleTime,
          ),
        ];
      }
      if (filter.kinds?.includes(13535)) {
        expect(filter).toEqual({
          kinds: [13535],
          authors: [getPublicKey(relayKey)],
          limit: 1,
        });
        return [sign(13535, [["-"]])];
      }
      if (filter.kinds?.includes(13534)) {
        // Relay-signed roster for archive consent; the viewer is a plain member.
        expect(filter).toEqual({
          kinds: [13534],
          authors: [getPublicKey(relayKey)],
          limit: 1,
        });
        return [sign(13534, [["member", viewer, "member"]])];
      }
      if (filter.kinds?.includes(30617) || filter.kinds?.includes(30621)) {
        if ("#buzz-channel" in filter) {
          // A channel’s repository discovery: one kind, one channel.
          expect(filter.kinds).toEqual([30617]);
          expect(filter).toEqual({
            kinds: filter.kinds,
            "#buzz-channel": [expect.any(String)],
            limit: 100,
          });
        } else expect(filter).toEqual({ kinds: [30617, 30621], limit: 100 });
        return [];
      }
      // Solo read state shares id lookups with the messages a review resolves.
      if (ownSoloChannels.length > 0 && filter.ids)
        return [
          ...readEvents.get(community).values(),
          ...[...histories.entries()]
            .filter(
              ([key]) =>
                key.startsWith(`${community}/`) &&
                (!filter["#h"] ||
                  filter["#h"].some(
                    (channel) => key === `${community}/${channel}`,
                  )),
            )
            .flatMap(([, events]) => events),
        ].filter((event) => filter.ids.includes(event.id));
      if (filter.kinds?.includes(20001))
        return filter.authors.map((author) =>
          sign(
            20001,
            [["p", author]],
            report.presencePublications?.findLast(
              (entry) =>
                entry.community === community && entry.event.pubkey === author,
            )?.event.content ?? "online",
          ),
        );
      if (filter.kinds?.includes(30622))
        return channelLifecycle
          ? [
              sign(
                30622,
                [
                  ["d", viewer],
                  ["p", viewer],
                  ...[...hiddenDmIds].map((id) => ["h", id]),
                ],
                "",
                relayKey,
                lifecycleTime,
              ),
            ]
          : [];
      if (filter.kinds?.includes(13534)) {
        expect(filter).toEqual({
          authors: [getPublicKey(relayKey)],
          kinds: [13534],
          limit: 1,
        });
        return [sign(13534, [["member", viewer, "owner"]], "", relayKey)];
      }
      if (filter.kinds?.includes(39001))
        return rosterIds
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map((id) =>
            sign(
              39001,
              [
                ["d", id],
                ...((lifecycleRows.some((row) => row.id === id) ||
                  ownSoloChannels.includes(id)) &&
                ["owner", "admin"].includes(lifecycleRole)
                  ? [["p", viewer, lifecycleRole]]
                  : []),
                ...(ownSoloChannels.includes(id)
                  ? soloAgents.map(({ pubkey }) => ["p", pubkey, "", "member"])
                  : []),
                ...(ownerAgent && lifecycleRows.some((row) => row.id === id)
                  ? [["p", ownerAgent, "owner"]]
                  : []),
              ],
              "",
              relayKey,
              lifecycleTime,
            ),
          );
      // Search's member count reads rosters without the viewer filter, so
      // the unjoined public channel answers with its members, not the viewer.
      if (
        filter.kinds?.includes(39002) &&
        !filter["#p"] &&
        openSearch &&
        !rosterIds.includes(OPEN_CHANNEL) &&
        filter["#d"]?.includes(OPEN_CHANNEL)
      )
        return [
          sign(
            39002,
            [
              ["d", OPEN_CHANNEL],
              ...["a", "b", "c"].map((digit) => [
                "p",
                digit.repeat(64),
                "",
                "member",
              ]),
            ],
            "",
            relayKey,
            lifecycleTime,
          ),
        ];
      if (filter.kinds?.includes(39002))
        return rosterIds
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map((id) =>
            sign(
              39002,
              [
                ["d", id],
                [
                  "p",
                  viewer,
                  "",
                  joinedRoles.get(id) ??
                    (lifecycleRows.some((row) => row.id === id) ||
                    ownSoloChannels.includes(id)
                      ? lifecycleRole === "nonmember"
                        ? "member"
                        : lifecycleRole
                      : "member"),
                ],
                ...(ownSoloChannels.includes(id)
                  ? soloAgents.map(({ pubkey }) => ["p", pubkey, "", "member"])
                  : []),
                ...(ownerAgent && lifecycleRows.some((row) => row.id === id)
                  ? [["p", ownerAgent, "", "owner"]]
                  : []),
                ...(servedMembers.get(id) ?? []).map((pubkey) => [
                  "p",
                  pubkey,
                  "",
                  "member",
                ]),
                ...[...(channelGuests.get(id) ?? [])].map((pubkey) => [
                  "p",
                  pubkey,
                  "",
                  "guest",
                ]),
                ...(dmMembers[id]
                  ? dmMembers[id].map((index) => [
                      "p",
                      participants[index],
                      "",
                      "member",
                    ])
                  : agentPeers && channels.includes(id)
                    ? participants.map((pubkey) => ["p", pubkey, "", "member"])
                    : dmLabels && id === "dm-peer"
                      ? [["p", participants[0], "", "member"]]
                      : dmLabels && id === "dm-group"
                        ? participants.map((pubkey) => [
                            "p",
                            pubkey,
                            "",
                            "member",
                          ])
                        : participants
                            .slice(
                              dmIds.indexOf(id) * 8,
                              (dmIds.indexOf(id) + 1) * 8,
                            )
                            .map((pubkey) => ["p", pubkey, "", "member"])),
              ],
              "",
              relayKey,
              lifecycleTime,
            ),
          );
      if (filter.kinds?.includes(39000))
        return [
          ...new Set([
            ...rosterIds,
            ...(openSearch ? [OPEN_CHANNEL] : []),
            ...(guestChannelId ? [guestChannelId] : []),
          ]),
        ]
          .filter((id) => !filter["#d"] || filter["#d"].includes(id))
          .map(
            (id) =>
              soloDetails.get(`${community}/${id}`) ??
              sign(
                39000,
                [
                  ["d", id],
                  [
                    "name",
                    renamedChannels.get(id) ??
                      channelNames[id] ??
                      lifecycleRows.find((row) => row.id === id)?.name ??
                      (id === "alpha"
                        ? "Alpha"
                        : id === "beta"
                          ? "Beta"
                          : id === OPEN_CHANNEL
                            ? "open"
                            : id),
                  ],
                  [
                    "t",
                    lifecycleRows.find((row) => row.id === id)?.type ??
                      (dmIds.includes(id) ? "dm" : "stream"),
                  ],
                  ...(id === guestChannelId ? [["join_role", "guest"]] : []),
                  ...(archivedIds.has(id) ? [["archived", "true"]] : []),
                  ...(autoJoinChannels.includes(id) ? [["auto_join"]] : []),
                  // Ordinary channels are explicitly public; do not add a public
                  // flag to private Solo chats or change the separate DM fixtures.
                  ...(!soloChannels.includes(id) &&
                  !dmIds.includes(id) &&
                  !lifecycleRows.some(
                    (row) => row.id === id && row.type === "dm",
                  )
                    ? [["public"]]
                    : []),
                  ...(dmIds.includes(id) ? [["hidden"]] : []),
                  ...(soloChannels.includes(id)
                    ? [
                        ["private"],
                        ["t", "buzz.solo"],
                        // The viewer's own Solo chats; any other is shared with them.
                        [
                          "P",
                          ownSoloChannels.includes(id)
                            ? viewer
                            : getPublicKey(relayKey),
                        ],
                      ]
                    : []),
                  ...(hiddenChannels.has(id) ? [["hidden"]] : []),
                ],
                "",
                relayKey,
                lifecycleTime,
              ),
          );
      if (filter.kinds?.includes(30078)) {
        const events = [...readEvents.get(community).values()];
        if (readState && filter.read_state_snapshot === 1)
          return {
            read_state_snapshot: 1,
            complete: true,
            community_id: communityIds[community],
            pubkey: viewer,
            snapshot_id: "a".repeat(64),
            events,
          };
        return events.filter(
          (event) =>
            event.tags.some(
              ([key, value]) => key === "t" && filter["#t"]?.includes(value),
            ) ||
            filter["#d"]?.includes(event.tags.find(([k]) => k === "d")?.[1]),
        );
      }
      if (filter.kinds?.includes(30174)) {
        // A local agent's memory, read by its owner: these agents have none.
        expect(filter).toEqual({
          kinds: [30174],
          authors: [expect.stringMatching(/^[0-9a-f]{64}$/)],
          "#p": [viewer],
          limit: 256,
        });
        return [];
      }
      if (filter.kinds?.includes(30315)) {
        expect(filter).toEqual({
          kinds: [30315],
          "#d": ["general"],
          authors: expect.any(Array),
          limit: filter.authors.length,
        });
        expect(filter.authors.length).toBeGreaterThan(0);
        expect(filter.authors.length).toBeLessThanOrEqual(100);
        return [];
      }
      if (filter.kinds?.includes(30178)) {
        expect(filter).toEqual({
          kinds: [30175, 30178],
          limit: 63,
        });
        return [];
      }
      // The Agents service's read of the owner's agent list.
      if (
        filter.kinds?.length === 1 &&
        filter.kinds[0] === 30177 &&
        !filter["#d"]
      ) {
        expect(filter).toEqual({
          authors: [viewer],
          kinds: [30177],
          limit: 500,
        });
        return [...agentRecords.get(community).values()];
      }
      if (filter.kinds?.includes(30175) || filter.kinds?.includes(30177)) {
        expect(filter).toEqual({
          authors: [viewer],
          kinds: [30175, 30177],
          limit: 200,
        });
        return soloAgents
          .filter(({ name }) => soloAgentNames.includes(name))
          .map(({ pubkey, name }) =>
            sign(30177, [["d", pubkey]], JSON.stringify({ name }), userKey),
          );
      }
      if (filter.kinds?.includes(30030)) {
        expect(filter).toEqual({
          kinds: [30030],
          "#d": ["buzz:custom-emoji"],
          limit: 500,
        });
        return sidebarIcons
          ? [
              sign(
                30030,
                [
                  ["d", "buzz:custom-emoji"],
                  [
                    "emoji",
                    "stamp",
                    `https://${community}.example/media/stamp.png`,
                  ],
                ],
                "",
                userKey,
              ),
            ]
          : [];
      }
      if (filter.kinds?.includes(10100)) {
        expect(filter).toEqual({
          kinds: [10100],
          authors: [expect.stringMatching(/^[0-9a-f]{64}$/)],
          limit: 1,
        });
        return [];
      }
      if (filter.kinds?.includes(30177)) {
        expect(filter).toEqual({
          kinds: [30177],
          authors: [expect.stringMatching(/^[0-9a-f]{64}$/)],
          "#d": [expect.stringMatching(/^[0-9a-f]{64}$/)],
          limit: 1,
        });
        return [];
      }
      if (filter.kinds?.includes(30315)) {
        expect(filter).toEqual({
          kinds: [30315],
          authors: [expect.any(String)],
          "#d": ["general"],
          limit: 1,
        });
        return [];
      }
      if (
        searchAuthor &&
        filter.kinds?.includes(0) &&
        filter.search_mode === "prefix"
      )
        return [profiles.get(community)].filter((event) =>
          JSON.parse(event.content)
            .name.toLowerCase()
            .startsWith(filter.search.toLowerCase()),
        );
      if (
        searchAuthor &&
        filter.kinds?.includes(9) &&
        filter.search === undefined &&
        filter.authors
      )
        return [];
      if (filter.search !== undefined)
        return [...histories.entries()]
          .filter(([key]) => key.startsWith(`${community}/`))
          .flatMap(([, events]) => events)
          .concat(community === "primary" ? targetEvents : [])
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.content
                .toLowerCase()
                .includes(filter.search.toLowerCase()) &&
              (!filter["#h"] ||
                event.tags.some(
                  ([key, value]) => key === "h" && filter["#h"].includes(value),
                )) &&
              (!filter.authors || filter.authors.includes(event.pubkey)) &&
              (filter.since === undefined ||
                event.created_at >= filter.since) &&
              (filter.until === undefined || event.created_at <= filter.until),
          )
          .slice(0, filter.limit);
      if (
        agentMessageDeletion &&
        filter.kinds?.includes(0) &&
        filter.authors?.includes(ownerAgent)
      )
        return ownerAgentProfile ? [ownerAgentProfile] : [];
      if (filter.kinds?.includes(0))
        return [
          ...[...servedProfiles.values()].filter((event) =>
            filter.authors?.includes(event.pubkey),
          ),
          ...(ownerAgentProfile && filter.authors?.includes(ownerAgent)
            ? [ownerAgentProfile]
            : []),
          ...(filter.authors?.includes(viewer)
            ? [profiles.get(community)]
            : []),
          ...membershipKeys
            .filter((key) => filter.authors?.includes(getPublicKey(key)))
            .map((key) =>
              sign(
                0,
                [],
                JSON.stringify({
                  name: key === membershipKeys[0] ? "Pinky" : "Brain",
                  ...(key === membershipKeys[1] ? { is_agent: true } : {}),
                }),
                key,
              ),
            ),
          ...peerKeys
            .filter((key) => filter.authors?.includes(getPublicKey(key)))
            .map((key) =>
              sign(
                0,
                [],
                JSON.stringify({
                  ...((agentPeers && key !== peerKey) || inboxSoloAgent
                    ? { is_agent: true }
                    : {}),
                  display_name: [
                    "Alice Fixture",
                    "Bob Fixture",
                    "Carol Fixture",
                  ][peerKeys.indexOf(key)],
                }),
                key,
              ),
            ),
        ];
      if (filter["#p"] && !filter["#h"] && filter.kinds?.includes(9)) {
        expect([...filter.kinds].sort((a, b) => a - b)).toEqual([9, 40002]);
        expect(filter["#p"]).toEqual([viewer]);
        expect(filter.limit).toBe(50);
        const candidates = [...histories.entries()]
          .filter(([key]) => key.startsWith(`${community}/`))
          .flatMap(([, events]) => events)
          .concat(
            community === "primary"
              ? [...targetEvents, ...[...threadReplies.values()].flat()]
              : [],
          );
        return [
          ...new Map(candidates.map((event) => [event.id, event])).values(),
        ]
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.tags.some(([k, v]) => k === "p" && v === viewer),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      }
      if (filter.ids)
        return [...histories.entries()]
          .filter(([key]) => key.startsWith(`${community}/`))
          .flatMap(([, events]) => events)
          .concat(
            community === "primary"
              ? [...targetEvents, ...[...threadReplies.values()].flat()]
              : [],
          )
          .filter(
            (event) =>
              filter.ids.includes(event.id) &&
              (!filter["#h"] ||
                event.tags.some(
                  ([key, value]) => key === "h" && filter["#h"].includes(value),
                )),
          )
          .slice(0, filter.limit);
      if (
        filter["#e"] &&
        filter.kinds?.every((kind) => [5, 7, 9005, 39005, 40003].includes(kind))
      )
        return (community === "primary" ? targetEvents : [])
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.tags.some(
                ([key, value]) => key === "e" && filter["#e"].includes(value),
              ),
          )
          .filter(
            (event) =>
              filter.until === undefined ||
              event.created_at < filter.until ||
              (event.created_at === filter.until &&
                event.id > filter.before_id),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      if (filter.thread_window) {
        const channelId = filter["#h"][0],
          rootId = filter["#e"][0];
        const candidates = [
          ...(histories.get(`${community}/${channelId}`) ?? []),
          ...(community === "primary" ? (threadReplies.get(rootId) ?? []) : []),
        ];
        const rows = [
          ...new Map(candidates.map((event) => [event.id, event])).values(),
        ]
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.tags.some(
                ([k, v]) => k === "e" && v.toLowerCase() === rootId,
              ) &&
              (filter.until === undefined ||
                event.created_at < filter.until ||
                (event.created_at === filter.until &&
                  event.id > filter.before_id)),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          );
        const page = rows.slice(0, filter.limit),
          last = page.at(-1);
        const hasMore = rows.length > page.length;
        const binding = createHash("sha256")
          .update(
            JSON.stringify([
              "tw",
              1,
              "older",
              `${community}.example`,
              viewer,
              channelId,
              rootId,
              filter.limit,
              filter.depth_limit ?? 100,
              [...new Set(filter.kinds)].sort((a, b) => a - b),
              filter.until === undefined
                ? null
                : [filter.until, filter.before_id],
              filter.include_aux ?? false,
            ]),
          )
          .digest("hex");
        return [
          ...page,
          sign(
            39007,
            [
              ["d", `tw:1:${binding}`],
              ["h", channelId],
              ["e", rootId],
            ],
            JSON.stringify({
              version: 1,
              direction: "older",
              has_more: hasMore,
              next_cursor: hasMore
                ? { created_at: last.created_at, id: last.id }
                : null,
            }),
          ),
        ];
      }
      if (filter.depth_limit) {
        const rootId = filter["#e"]?.[0];
        const candidates = [
          ...(community === "primary"
            ? [
                ...(threadReplies.get(rootId) ?? []),
                ...(displacedReplies.get(rootId) ?? []),
              ]
            : []),
          ...(histories.get(`${community}/${filter["#h"]?.[0]}`) ?? []),
        ].filter((event) => {
          const refs = event.tags.filter(([key]) => key === "e");
          const root =
            refs.find((tag) => tag[3] === "root") ??
            refs.find((tag) => tag[3] === "reply");
          return root?.[1]?.toLowerCase() === rootId;
        });
        const rows = [
          ...new Map(candidates.map((event) => [event.id, event])).values(),
        ]
          .filter(
            (event) =>
              filter.thread_cursor === undefined ||
              event.created_at > filter.thread_cursor ||
              (event.created_at === filter.thread_cursor &&
                event.id > filter.thread_cursor_id),
          )
          .toSorted(
            (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
        const ids = new Set(rows.map((event) => event.id));
        const aux = [];
        if (filter.include_aux && community === "primary")
          for (let hop = 0; hop < 2; hop++)
            for (const event of targetEvents) {
              if (
                ids.has(event.id) ||
                ![5, 7, 9005, 39005, 40003].includes(event.kind)
              )
                continue;
              if (
                event.tags.some(([key, value]) => key === "e" && ids.has(value))
              ) {
                aux.push(event);
                ids.add(event.id);
              }
            }
        return [...rows, ...aux];
      }
      // Unread conversation lookup: the viewer's replies to undecided parents.
      if (
        filter.kinds?.includes(9) &&
        filter["#e"] &&
        filter.authors?.length === 1 &&
        filter.authors[0] === viewer
      )
        return (filter["#h"] ?? [])
          .flatMap((channel) => histories.get(`${community}/${channel}`) ?? [])
          .concat(
            threadUnread && community === "primary"
              ? [
                  ...[...threadReplies.values()].flat(),
                  ...[...displacedReplies.values()].flat(),
                ]
              : [],
          )
          .filter(
            (event) =>
              filter.kinds.includes(event.kind) &&
              event.pubkey === viewer &&
              event.tags.some(
                ([key, value]) => key === "h" && filter["#h"]?.includes(value),
              ) &&
              event.tags.some(
                ([key, value]) =>
                  key === "e" && filter["#e"].includes(value?.toLowerCase()),
              ),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      // Unread evidence is not a top-level window, even for a one-ID final batch.
      if (
        filter.kinds?.includes(9) &&
        !filter.top_level &&
        filter["#h"]?.length
      )
        return filter["#h"]
          .flatMap((channel) => [
            ...(histories.get(`${community}/${channel}`) ?? []),
            ...(threadUnread && community === "primary" && channel === "alpha"
              ? [...threadReplies.values()].flat()
              : []),
          ])
          .filter(
            (event) =>
              filter.until === undefined ||
              event.created_at < filter.until ||
              (event.created_at === filter.until &&
                event.id > filter.before_id),
          )
          .toSorted(
            (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
          )
          .slice(0, filter.limit);
      const channel = filter["#h"]?.[0];
      const history = histories.get(`${community}/${channel}`);
      if (!history)
        throw new Error(`Unexpected query: ${JSON.stringify(filter)}`);
      const candidates = history
        .filter((event) => !filter.kinds || filter.kinds.includes(event.kind))
        .filter(
          (event) =>
            filter.until === undefined ||
            event.created_at < filter.until ||
            (event.created_at === filter.until && event.id > filter.before_id),
        )
        .toSorted(
          (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id),
        );
      const events = candidates.slice(0, filter.limit);
      const hasMore = candidates.length > events.length;
      const last = events.at(-1);
      const suffix =
        filter.until === undefined
          ? "head"
          : `${filter.until}:${filter.before_id}`;
      return filter.include_aux
        ? [
            ...events,
            ...(actionProfile
              ? targetEvents.filter((aux) =>
                  aux.tags.some(
                    ([k, id]) =>
                      k === "e" && events.some((row) => row.id === id),
                  ),
                )
              : []),
            ...threadSummaries.filter((summary) =>
              events.some((event) =>
                summary.tags.some(
                  ([key, value]) => key === "e" && value === event.id,
                ),
              ),
            ),
            sign(
              39006,
              [
                ["h", channel],
                ["d", `${channel}:${suffix}`],
              ],
              JSON.stringify({
                has_more: hasMore,
                next_cursor: hasMore
                  ? { created_at: last.created_at, id: last.id }
                  : null,
              }),
            ),
          ]
        : events;
    };
    let heldJoin;
    // Live roster replacement, as the relay republishes after a join. It
    // reaches the app through its open channel REQ, not a join response.
    const deliverRoster = (id, community) =>
      relay.publish(
        community,
        sign(
          39002,
          [
            ["d", id],
            ["p", viewer, "", "member"],
          ],
          "",
          relayKey,
          Math.floor(Date.now() / 1000),
        ),
      );
    const acceptReadPublication = (community, event) => {
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(viewer);
      if (event.kind === 20002) {
        expect(validTypingTemplate(event)).toBe(true);
        expect(rosterIds).toContain(event.tags[0]?.[1]);
        report.typingPublications.push({ community, event });
        relay?.publish(community, event, { requireSubscriber: false });
        return;
      }
      if (openSearch && event.kind === 9021) {
        // NIP-29 join: the relay adds an open channel's requester to its roster.
        expect(event.tags).toEqual([["h", OPEN_CHANNEL]]);
        if (!rosterIds.includes(OPEN_CHANNEL)) rosterIds.push(OPEN_CHANNEL);
        report.lifecyclePublications ??= [];
        report.lifecyclePublications.push(event);
        if (!heldJoin) return;
        // The relay republishes the roster live before the requester's OK.
        deliverRoster(OPEN_CHANNEL, community);
        return heldJoin.promise;
      }
      if (channelLifecycle && event.kind === 9021) {
        const id = event.tags.find(([key]) => key === "h")?.[1];
        expect(lifecycleRows.some((row) => row.id === id)).toBe(true);
        const metadata = answer(community, { kinds: [39000], "#d": [id] })[0];
        expect(metadata.tags).toContainEqual(["public"]);
        expect(metadata.tags).not.toContainEqual(["private"]);
        joinedRoles.set(
          id,
          metadata.tags.find(([key]) => key === "join_role")?.[1] ?? "member",
        );
        if (!rosterIds.includes(id)) rosterIds.push(id);
        lifecycleTime++;
        report.lifecyclePublications ??= [];
        report.lifecyclePublications.push(event);
        return;
      }
      if (
        event.kind === 9002 &&
        ownSoloChannels.includes(event.tags.find(([key]) => key === "h")?.[1])
      ) {
        const id = event.tags.find(([key]) => key === "h")[1];
        const base = answer(community, { kinds: [39000], "#d": [id] })[0];
        const tags = base.tags.filter(
          ([key, value]) =>
            !event.tags.some(
              ([changed]) =>
                (changed === key &&
                  // Label updates preserve the relay's channel-type tag.
                  !(
                    key === "t" &&
                    ["stream", "forum", "dm", "workflow", "system"].includes(
                      value,
                    )
                  )) ||
                (changed === "visibility" &&
                  ["public", "private"].includes(key)),
            ),
        );
        for (const [key, next] of event.tags) {
          if (key === "h") continue;
          if (key === "visibility")
            tags.push([next === "open" ? "public" : "private"]);
          else if (key !== "ttl" || next) tags.push([key, next]);
        }
        soloDetails.set(
          `${community}/${id}`,
          sign(39000, tags, "", relayKey, ++lifecycleTime),
        );
        report.detailsPublications ??= [];
        report.detailsPublications.push(event);
        return;
      }
      if (channelLifecycle && [9002, 9008, 9022, 41012].includes(event.kind)) {
        const id = event.tags.find(([key]) => key === "h")?.[1];
        expect(lifecycleRows.some((row) => row.id === id)).toBe(true);
        if (event.kind === 9002) {
          if (
            event.tags.some(
              ([key, value]) => key === "archived" && value === "false",
            )
          )
            archivedIds.delete(id);
          else archivedIds.add(id);
        }
        if (event.kind === 41012) hiddenDmIds.add(id);
        if (event.kind === 9008 || event.kind === 9022)
          rosterIds.splice(rosterIds.indexOf(id), 1);
        lifecycleTime++;
        if (event.kind === 9022 && leaveRosterBeforeAck)
          relay.publish(
            community,
            sign(39002, [["d", id]], "", relayKey, lifecycleTime),
          );
        report.lifecyclePublications ??= [];
        report.lifecyclePublications.push(event);
        return;
      }
      if (event.kind === 9) {
        report.publications.push({ community, event });
        const channel = event.tags.find(([name]) => name === "h")?.[1];
        histories.get(`${community}/${channel}`).push(event);
        relay.publish(community, event);
        return;
      }
      if (event.kind === 30177) {
        const coordinates = event.tags.filter(([name]) => name === "d");
        expect(coordinates).toEqual([
          ["d", expect.stringMatching(/^[0-9a-f]{64}$/)],
        ]);
        expect(event.tags).toContainEqual(["runtime", expect.any(String)]);
        const content = JSON.parse(event.content);
        expect(content.name.trim()).not.toBe("");
        expect(content.parallelism).toEqual(expect.any(Number));
        expect(content.respond_to).toEqual(expect.any(String));
        agentRecords.get(community).set(coordinates[0][1], event);
        report.agentPublications ??= [];
        report.agentPublications.push({ community, event });
        return;
      }
      if ([7, 5, 40003].includes(event.kind)) {
        const channel = event.tags.find(([name]) => name === "h")?.[1];
        const history = histories.get(`${community}/${channel}`);
        expect(history).toBeDefined();
        const ids = event.tags
          .filter(([name]) => name === "e")
          .map(([, id]) => id);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) {
          const target = [
            ...history,
            ...[...threadReplies.values()].flat(),
          ].find((row) => row.id === id);
          expect(target).toBeDefined();
          expect(target.tags).toContainEqual(["h", channel]);
          if (event.kind === 7) expect(target.kind).toBe(9);
          else {
            const ownerDelete =
              event.kind === 5 &&
              agentMessageDeletion &&
              target.pubkey === ownerAgent &&
              target.kind === 9;
            if (ownerDelete) {
              expect(ownerAgentProfile).toBeDefined();
              expect(ownerAttestationValid).toBe(true);
              const auth = ownerAgentProfile.tags.find(
                ([name]) => name === "auth",
              );
              expect(auth).toHaveLength(4);
              expect(auth[1]).toBe(viewer);
            } else expect(target.pubkey).toBe(viewer);
            expect([7, 9]).toContain(target.kind);
            if (event.kind === 5)
              expect(event.tags).toContainEqual(["k", String(target.kind)]);
            else expect(target.kind).toBe(9);
          }
        }
        if ([7, 40003].includes(event.kind)) expect(ids).toHaveLength(1);
        if (!history.some((row) => row.id === event.id)) {
          history.push(event);
          targetEvents.push(event);
        }
        report.publications.push({ community, event });
        relay.publish(community, event);
        return;
      }
      expect(event.kind).toBe(30078);
      const sidebarCoordinate = event.tags.find(([name]) => name === "d")?.[1];
      if (
        [
          "channel-mutes",
          "channel-sections",
          "channel-stars",
          "channel-sort",
          "channel-filter",
        ].includes(sidebarCoordinate) ||
        (ownSoloChannels.length > 0 &&
          sidebarCoordinate?.startsWith("buzz-me-kit-v1:"))
      ) {
        expect(event.tags).toContainEqual([
          "t",
          sidebarCoordinate.startsWith("buzz-me-kit-v1:")
            ? "buzz-me-kit-v1"
            : sidebarCoordinate,
        ]);
        const blob = JSON.parse(
          nip44.v2.decrypt(
            event.content,
            nip44.v2.utils.getConversationKey(userKey, viewer),
          ),
        );
        readEvents.get(community).set(sidebarCoordinate, event);
        report.sidebarPublications ??= [];
        report.sidebarPublications.push({
          community,
          coordinate: sidebarCoordinate,
          event,
          blob,
        });
        return;
      }
      expect(event.tags).toContainEqual(["t", "read-state"]);
      const blob = JSON.parse(
        nip44.v2.decrypt(
          event.content,
          nip44.v2.utils.getConversationKey(userKey, viewer),
        ),
      );
      const coordinate = event.tags.find(([key]) => key === "d")?.[1];
      expect(coordinate).toMatch(/^read-state:[0-9a-f]{32}$/);
      const previous = readEvents.get(community).get(coordinate);
      if (
        !previous ||
        event.created_at > previous.created_at ||
        (event.created_at === previous.created_at && event.id < previous.id)
      )
        readEvents.get(community).set(coordinate, event);
      report.readPublications.push({ community, event, blob });
    };
    const relay = productionBroker
      ? policyRelay({
          viewer,
          relayAuthor: getPublicKey(relayKey),
          answer,
          searchProfiles,
          report,
          pending,
          // The production broker advertises read-state writes for every session,
          // not only tests opting into complete snapshot reads.
          acceptPublication: acceptReadPublication,
          ...(actionProfile || channelLifecycle
            ? {
                latencyMs: 40,
                holdOlder: false,
                acceptPublication: (community, event) => {
                  expect(verifyEvent(event)).toBe(true);
                  expect(event.pubkey).toBe(viewer);
                  if (
                    channelLifecycle &&
                    [9002, 9008, 9021, 9022, 41012].includes(event.kind)
                  )
                    return acceptReadPublication(community, event);
                  if (event.kind === 30078 || event.kind === 20002)
                    return acceptReadPublication(community, event);
                  expect([9, 7]).toContain(event.kind);
                  const channel = event.tags.find(([k]) => k === "h")?.[1];
                  const history = histories.get(`${community}/${channel}`);
                  expect(history).toBeDefined();
                  if (!history.some((row) => row.id === event.id))
                    history.push(event);
                  if (event.kind === 7) targetEvents.push(event);
                  report.publications.push({
                    community,
                    event,
                    at: performance.now(),
                  });
                  // No live echo in this measurement lane: observe the receipt
                  // and finite-read reconciliation without echo cancellation.
                },
              }
            : {}),
          discovery: (community) => ({
            self: getPublicKey(relayKey),
            // Solo details publications below retain label changes as well as names.
            ...(ownSoloChannels.length
              ? { supported_extensions: ["nip-cl"] }
              : {}),
            ...(readState
              ? {
                  read_state_snapshot: {
                    version: 1,
                    community_id: communityIds[community],
                    max_events: 4096,
                    max_bytes: 8388608,
                  },
                }
              : {}),
          }),
        })
      : undefined;
    const middleware = async (request, response, next) => {
      // Development-React journeys restore the shared login at startup too.
      // This synthetic host has no Builderlab account; keep its stream open
      // until the page disconnects, just like the real broker's signed-out state.
      if (
        request.method === "GET" &&
        request.url === "/api/builderlab/events"
      ) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
        });
        response.write(
          `data: ${JSON.stringify({ revision: "fixture", pending: false, auth: null })}\n\n`,
        );
        return;
      }
      if (!request.url?.startsWith("/api/relay/")) return next();
      try {
        const parts = request.url.split("/");
        const route = parts.at(-1);
        const requestedCommunity = decodeURIComponent(parts[3]);
        const community =
          requestedCommunity.match(
            /^https:\/\/(primary|secondary)\.(?:example|fixture\.invalid)$/,
          )?.[1] ?? requestedCommunity;
        const parsed = await fixtureBody(request, report);
        if (!parsed) return; // The client disconnected; there is no response to send.
        const { body } = parsed;
        if (route === "identity") return send(response, { viewer });
        if (route === "register") return send(response, {});
        if (!["primary", "secondary"].includes(community))
          throw new Error(`Unexpected community: ${request.url}`);
        if (route === "gif-info" && request.method === "GET")
          return send(response, {});
        if (
          (route === "info" || route === "icon-info") &&
          request.method === "GET"
        )
          return send(response, { policy: null });
        if (route === "invite" && request.method === "POST")
          return send(response, {
            code: "fixture",
            url: `${JSON.parse(fixtureAliases)[community]}/invite/fixture`,
            expires_at: 1700003600,
            max_uses: body.max_uses ?? null,
            uses_remaining: body.max_uses ?? null,
          });
        if (route === "session") {
          report.sessions.push(community);
          return send(response, {
            viewer,
            relayAuthor: getPublicKey(relayKey),
            writeKinds:
              channelWriteKinds ??
              (soloChannels.length ? [9, 9007, 30315] : [9, 30315]),
            relayUrl: JSON.parse(fixtureAliases)[community],
            live: true,
          });
        }
        if (route === "sign" && body.kind === 20002) {
          expect(validTypingTemplate(body)).toBe(true);
          expect(rosterIds).toContain(body.tags[0]?.[1]);
          return send(response, finalizeEvent(body, userKey));
        }
        if (route === "publish" && body.kind === 20002) {
          acceptReadPublication(community, body);
          return send(response, { accepted: true, event_id: body.id });
        }
        if (soloChannels.length && route === "sign") {
          expect(body.kind).toBe(9);
          return send(response, finalizeEvent(body, userKey));
        }
        if (soloChannels.length && route === "publish") {
          expect(verifyEvent(body)).toBe(true);
          expect(body.pubkey).toBe(viewer);
          expect(body.kind).toBe(9);
          const channel = body.tags.find(([key]) => key === "h")?.[1];
          expect(soloChannels).toContain(channel);
          histories.get(`${community}/${channel}`).push(body);
          return send(response, { accepted: true, event_id: body.id });
        }
        if (
          ["stream-interests", "stream-priority", "stream-observer"].includes(
            route,
          )
        ) {
          const owner = streamOwners.get(body.streamId);
          // Reload may retire the SSE owner after a control was dispatched.
          // Match the broker for that exact known stream; unknown IDs still fail.
          if (!owner && retiredStreams.has(body.streamId))
            return send(
              response,
              { error: "Live stream no longer available" },
              404,
            );
          expect(owner?.community).toBe(community);
          if (route === "stream-interests") {
            expect(body.interestRevision).toBeGreaterThan(
              owner.interestRevision,
            );
            owner.channels = body.channels;
            owner.interestRevision = body.interestRevision;
            report.streamInterests.push({ community, channels: body.channels });
            owner.state();
          }
          return send(response, {});
        }
        if (route === "stream") {
          // Match the production broker: WebKit can buffer trailing HTTP chunks.
          // Close-delimited SSE must deliver each append without a later write.
          const streamId = randomBytes(16).toString("hex");
          response.useChunkedEncodingByDefault = false;
          response.writeHead(200, {
            "X-Buzz-Live-ID": streamId,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.flushHeaders();
          const owner = {
            community,
            response,
            channels: body.channels,
            interestRevision: body.interestRevision,
            state() {
              response.write(
                `event: state\ndata: ${JSON.stringify({ status: "connected", interestRevision: owner.interestRevision, routes: owner.channels.map((channelId) => ({ id: `channel:${channelId}`, channelId, status: "live", replay: "unknown" })) })}\n\n`,
              );
            },
          };
          streamOwners.set(streamId, owner);
          owner.state();
          const clients = streams.get(community) ?? new Set();
          streams.set(community, clients);
          clients.add(owner);
          report.streamConnections.push({ community, channels: body.channels });
          // The real broker pulses every 15s; the production reader expires
          // streams after 45s without bytes, even while history HTTP is active.
          const heartbeat = setInterval(
            () => response.write(": keepalive\n\n"),
            15000,
          );
          response.on("close", () => {
            clearInterval(heartbeat);
            clients.delete(owner);
            streamOwners.delete(streamId);
            retiredStreams.add(streamId);
          });
          return;
        }
        if (route === "profile" && request.method === "POST") {
          const { existing, name, picture, about } = body;
          const event = sign(
            0,
            [],
            JSON.stringify({
              ...existing,
              name: name.trim(),
              display_name: name.trim(),
              picture,
              about,
            }),
            userKey,
            profiles.get(community).created_at + 1,
          );
          profiles.set(community, event);
          // Deliberately no live echo: Save must confirm through a signed read.
          return send(response, { accepted: true, event_id: event.id });
        }
        if (route === "profile-search" && request.method === "POST")
          return send(response, searchProfiles(community, body));
        if (route !== "query" || request.method !== "POST")
          throw new Error(
            `Unexpected fixture request: ${request.method} ${request.url}`,
          );
        expect(body.length).toBeGreaterThan(0);
        expect(body.length).toBeLessThanOrEqual(
          body.every(
            (filter) => filter.kinds?.length === 1 && filter.kinds[0] === 9007,
          )
            ? 4
            : 3,
        );
        const filter = body[0];
        const result = [
          ...new Map(
            body
              .flatMap((filter) => {
                report.queries.push({ community, filter });
                return answer(community, filter);
              })
              .map((event) => [event.id, event]),
          ).values(),
        ];
        for (const { id } of result) served.add(id);
        if (
          filter.search === undefined &&
          filter.until !== undefined &&
          filter["#h"]?.length
        ) {
          const queuedAt = performance.now();
          const receipt = {
            community,
            channel: filter["#h"][0],
            filter,
            events: result.filter((event) => event.kind === 9),
            release: () => {
              if (response.destroyed || response.writableEnded) return;
              receipt.releaseDelayMs = performance.now() - queuedAt;
              send(response, result);
            },
          };
          pending.push(receipt);
          if (olderPageDelayMs !== null) {
            const timer = setTimeout(() => {
              olderPageTimers.delete(timer);
              receipt.release();
            }, olderPageDelayMs);
            olderPageTimers.add(timer);
          }
        } else send(response, result);
      } catch (error) {
        report.unexpected.push(String(error));
        send(response, { error: String(error) }, 500);
      }
    };
    const heldIcons = [];
    const iconRequests = [];
    const foregroundRequests = [];
    let iconsReleased = false;
    let server;
    // Each watched page's errors; additional pages join through app.watchPageErrors.
    const watchedPages = [];
    try {
      server = await preview({
        ...compiledApp.config,
        plugins: [
          {
            name: "fixture-relay",
            async configurePreviewServer(server) {
              if (iconCongestion) {
                server.middlewares.use((req, res, next) => {
                  if (req.url?.includes("/icon-info")) {
                    iconRequests.push(req.url);
                    if (iconsReleased) return send(res, {});
                    heldIcons.push(res);
                    return;
                  }
                  if (req.url === "/foreground-probe") {
                    foregroundRequests.push(req.url);
                    return send(res, { reached: true });
                  }
                  next();
                });
              }
              if (relay) {
                report.brokerRequests = [];
                server.middlewares.use((req, res, next) => {
                  if (req.url?.startsWith("/api/relay/"))
                    report.brokerRequests.push({
                      url: req.url,
                      at: performance.now(),
                    });
                  // The broker has paused its lane by the time a relayed quota
                  // refusal finishes; this bounds that pause in fixture time.
                  if (/^\/api\/relay\/[^/]+\/query$/.test(req.url ?? ""))
                    res.once("finish", () => {
                      if (res.statusCode !== 429) return;
                      const rejection = relay.rejected.find(
                        (item) => item.relayed === undefined,
                      );
                      if (rejection) rejection.relayed = performance.now();
                    });
                  if (req.url?.endsWith("/stream"))
                    res.once("close", () => {
                      retiredStreams.add(res.getHeader("x-buzz-live-id"));
                    });
                  next();
                });
                const broker = relayBrokerPlugin({
                  builderlab,
                  archiveFile: ":memory:",
                  relayUrl: fixtureRelayUrl,
                  communityAliases: fixtureAliases,
                  identity: () => userKey.slice(),
                  agentLibrary: () => ({ definitions: [], identities: [] }),
                  ...(readState || channelLifecycle
                    ? {}
                    : {
                        authority: async () => ({
                          relayAuthor: getPublicKey(relayKey),
                          ...(ownSoloChannels.length
                            ? { channelIdentity: true }
                            : {}),
                        }),
                      }),
                  upstreamFetch: relay.fetch,
                  socketFactory: relay.socket,
                  liveSetupTimeoutMs,
                });
                await broker.configureServer(server);
              } else server.middlewares.use(middleware);
            },
          },
        ],
        preview: { host: "127.0.0.1", port: 0, strictPort: true },
      });
      const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
      // Intercept only other origins. A same-origin passthrough here would race
      // page.unroute(): Playwright continues a removed page route's in-flight
      // request itself, so a later continue() reports "Route is already handled!".
      await context.route(
        (url) => url.origin !== origin,
        (route) => {
          report.unexpected.push(
            `Blocked external request: ${route.request().url()}`,
          );
          return route.abort();
        },
      );
      await context.routeWebSocket("**/*", (socket) => {
        report.unexpected.push(`Blocked WebSocket: ${socket.url()}`);
        socket.close();
      });
      watchedPages.push(watchPageErrors(page));
      report.errors = watchedPages[0].errors;
      const unexplainedPageErrors = () =>
        watchedPages.flatMap((watched) => watched.unexplained());
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleLocations.set(
            report.consoleErrors.length,
            message.location().url,
          );
          report.consoleErrors.push(message.text());
        }
      });
      page.on("response", (response) => {
        if (
          response.url().endsWith("/stream-observer") &&
          response.status() === 404
        ) {
          const { streamId } = response.request().postDataJSON();
          observerFailures.push({
            streamId,
            url: response.url(),
            retired: retiredStreams.has(streamId),
          });
        }
      });
      // General feature journeys can hold startup data indefinitely. Keep the
      // launch view in dedicated startup journeys so those fixtures can still
      // exercise the feature under test.
      if (!launchAnimation)
        await page.addInitScript(() => {
          const observer = new MutationObserver(() => {
            const launch = document.getElementById("buzz-launch");
            if (!launch) return;
            launch.remove();
            const root = document.getElementById("root");
            root?.removeAttribute("inert");
            root?.removeAttribute("aria-hidden");
            const toastRoot = document.getElementById("buzz-toast-root");
            toastRoot?.removeAttribute("inert");
            toastRoot?.removeAttribute("aria-hidden");
            observer.disconnect();
          });
          observer.observe(document, { childList: true, subtree: true });
        });
      await page.addInitScript(
        ({ viewer, profilePicture, iconCongestion, enabledPlugins }) => {
          // Model fresh plugin choices before seeding an existing community.
          // Feature journeys opt in once; reloads retain later user choices.
          if (!localStorage.getItem("buzzodz.plugins.v1"))
            localStorage.setItem(
              "buzzodz.plugins.v1",
              JSON.stringify({
                version: 3,
                enabled: {
                  "buzz.reminders": false,
                  "buzz.workflows": false,
                  ...Object.fromEntries(enabledPlugins.map((id) => [id, true])),
                },
              }),
            );
          const key = `buzz-client.v1:${viewer}`;
          if (!localStorage.getItem(key))
            localStorage.setItem(
              key,
              JSON.stringify({
                profile: { name: "Browser Fixture", picture: profilePicture },
                memberships: iconCongestion
                  ? [
                      { id: "primary", name: "Primary" },
                      { id: "secondary", name: "Secondary" },
                      ...Array.from({ length: 6 }, (_, index) => ({
                        id: `https://saved-${index}.example`,
                        name: `Saved ${index}`,
                      })),
                    ]
                  : [
                      { id: "primary", name: "Primary" },
                      { id: "secondary", name: "Secondary" },
                    ],
                selected: "primary",
              }),
            );
        },
        { viewer, profilePicture, iconCongestion, enabledPlugins },
      );
      await use({
        sign: (template) => finalizeEvent(template, userKey),
        channelMetadata: (id, tags) => sign(39000, [["d", id], ...tags]),
        // Model an owner changing visibility; production discovery consumes the
        // signed metadata through normal reads/live traffic.
        setChannelMetadata(id, tags) {
          const event = sign(
            39000,
            [["d", id], ...tags],
            "",
            relayKey,
            ++lifecycleTime,
          );
          soloDetails.set(`primary/${id}`, event);
          relay.publish("primary", event, { requireSubscriber: false });
          return event;
        },
        signRelay: (template) => finalizeEvent(template, relayKey),
        membershipSnapshot(role) {
          expect(["owner", "admin", "member"]).toContain(role);
          return sign(13534, [["member", viewer, role]], "", relayKey);
        },
        origin,
        report,
        watchPageErrors(other) {
          const watched = watchPageErrors(other);
          watchedPages.push(watched);
          return watched;
        },
        iconCongestion: iconCongestion
          ? {
              iconRequests,
              foregroundRequests,
              release() {
                iconsReleased = true;
                for (const response of heldIcons)
                  if (!response.writableEnded) send(response, {});
              },
            }
          : undefined,
        pending,
        served,
        histories,
        // Signed device-cache input for the startup scale journey; same modeled
        // wire responses as a real roster/head read, without visiting every row.
        startupCache() {
          return {
            discovery: [
              ...answer("primary", { kinds: [39002] }),
              ...answer("primary", { kinds: [39000] }),
            ],
            heads: rosterIds.map((channelId) => ({
              channelId,
              savedAt: Date.now(),
              profiles: [],
              events: answer("primary", {
                kinds: [9, 40002, 40008],
                "#h": [channelId],
                limit: 20,
                top_level: true,
                include_aux: true,
                include_summaries: true,
              }),
            })),
          };
        },
        presenceThread,
        inboxWindow,
        inboxDmAnchor,
        deleteInboxAnchor(event) {
          const deletion = sign(
            5,
            [
              ["h", inboxWindow.channelId],
              ["e", event.id],
            ],
            "",
            peerKey,
            event.created_at + 100,
          );
          targetEvents.push(deletion);
          relay.publish("primary", deletion);
        },
        exact,
        ownerAgentMessage,
        searchTarget,
        openChannelId: OPEN_CHANNEL,
        membership(
          type,
          targetIndex,
          actorIndex = -1,
          forged = false,
          deliver = true,
        ) {
          const history = histories.get(`primary/${channels[0]}`);
          const event = membershipEvent(
            type,
            targetIndex,
            history.at(-1).created_at + 1,
            actorIndex,
            forged,
          );
          history.push(event);
          if (!deliver) return event;
          if (relay) relay.publish("primary", event);
          else
            for (const client of streams.get("primary") ?? [])
              if (client.channels.includes(channels[0]))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          return event;
        },
        presence(status, community = "primary") {
          const event = sign(
            20001,
            [],
            status,
            peerKey,
            Math.floor(Date.now() / 1000),
          );
          relay.presence(community, event);
          return event;
        },
        participants,
        soloAgents,
        soloAgentMessage(channelId, content) {
          const agent = soloAgents[0];
          expect(agent).toBeTruthy();
          const history = histories.get(`primary/${channelId}`);
          expect(history).toBeTruthy();
          const event = sign(
            9,
            [["h", channelId]],
            content,
            soloAgentKeys[0],
            (history.at(-1)?.created_at ?? 1700000100) + 1,
          );
          history.push(event);
          relay.publish("primary", event);
          return event;
        },
        viewer,
        relay,
        observer(raw, agentKey, community = "primary") {
          const agent = getPublicKey(agentKey);
          const plaintext = JSON.stringify(raw);
          const event = sign(
            24200,
            [
              ["p", viewer],
              ["agent", agent],
              ["frame", "telemetry"],
            ],
            nip44.v2.encrypt(
              plaintext,
              nip44.v2.utils.getConversationKey(agentKey, viewer),
            ),
            agentKey,
            Math.floor(Date.now() / 1000),
          );
          relay.observer(community, event);
          return { event, plaintext, agent };
        },
        // Answer later kind-0 reads for this key; no live delivery is modeled.
        serveProfile(key, body) {
          const event = sign(0, [], JSON.stringify(body), key);
          servedProfiles.set(event.pubkey, event);
          return event;
        },
        // Configure pre-existing members before opening the app. Reads stay at
        // the modeled relay, without a second browser-owned HTTP request.
        serveMembers(id, pubkeys) {
          expect(rosterIds).toContain(id);
          servedMembers.set(id, [...pubkeys]);
        },
        // Change only modeled relay state. The app must consume the next real
        // roster response; this does not call client purge/recovery internals.
        addChannelGuest(id, pubkey) {
          expect(rosterIds).toContain(id);
          const guests = channelGuests.get(id) ?? new Set();
          guests.add(pubkey);
          channelGuests.set(id, guests);
          lifecycleTime++;
        },
        renameChannel(id, name) {
          expect(rosterIds).toContain(id);
          renamedChannels.set(id, name);
          lifecycleTime++;
        },
        hideChannel(id) {
          expect(rosterIds).toContain(id);
          hiddenChannels.add(id);
        },
        omitChannel(id) {
          expect(rosterIds).toContain(id);
          rosterIds.splice(rosterIds.indexOf(id), 1);
        },
        // Hold the join's OK; its live roster still arrives first.
        holdJoin() {
          let release;
          const promise = new Promise((resolve) => {
            release = resolve;
          });
          heldJoin = { promise };
          return () => {
            heldJoin = undefined;
            release();
          };
        },
        // Signed upstream-only simulations: never a browser publication or live relay.
        activity({
          channel = "alpha",
          root,
          author = 0,
          kind = 20002,
          age = 0,
          participant,
          self = false,
        } = {}) {
          if (!relay)
            throw new Error("Typing fixture requires production broker");
          const event = sign(
            kind,
            [["h", channel], ...(root ? [["e", root, "", "reply"]] : [])],
            kind === 20002 ? "" : "Fixture completion",
            self
              ? userKey
              : participant === undefined
                ? typingKeys[author]
                : peerKeys[participant],
            Math.floor(Date.now() / 1000) - age,
          );
          relay.publish("primary", event);
          return event;
        },
        edit(community, channel, target, content) {
          const event = sign(
            40003,
            [
              ["h", channel],
              ["e", target.id],
            ],
            content,
            userKey,
            target.created_at + 1,
          );
          report.publications.push({
            id: event.id,
            target: target.id,
            kind: event.kind,
            frameBytes: Buffer.byteLength(`data: ${JSON.stringify(event)}\n\n`),
          });
          if (relay) relay.publish(community, event);
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              if (client.channels.includes(channel))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
        deleteTarget(target = exact.target) {
          const event = sign(
            5,
            [
              ["h", "alpha"],
              ["e", target.id],
            ],
            "",
            userKey,
            target.created_at + 100,
          );
          targetEvents.push(event);
          relay.publish("primary", event);
        },
        // Relay-owned summary evidence, not a mutation of the client's row.
        threadSummary(rootId, participants, replyCount) {
          const event = sign(
            39005,
            [
              ["h", "alpha"],
              ["e", rootId],
              ["d", rootId],
            ],
            JSON.stringify({ reply_count: replyCount, participants }),
            relayKey,
            Math.floor(Date.now() / 1000) + 1,
          );
          threadSummaries.push(event);
          if (relay) relay.publish("primary", event);
          else
            for (const client of streams.get("primary") ?? [])
              if (client.channels.includes("alpha"))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          return event;
        },
        reply(rootId, own = false, deliver = true) {
          const replies = threadReplies.get(rootId);
          if (!replies) throw new Error("Unknown fixture thread");
          const channel = replies[0]?.tags.find(([key]) => key === "h")?.[1];
          if (!channel) throw new Error("Missing fixture thread channel");
          const event = sign(
            9,
            [
              ["h", channel],
              ["e", rootId, "", "reply"],
            ],
            own ? "My reply" : "New peer reply",
            own ? userKey : peerKey,
            replies.at(-1).created_at + 1,
          );
          replies.push(event);
          if (deliver) relay.publish("primary", event);
          return event;
        },
        append(
          community,
          channel,
          content,
          deliver = true,
          own = true,
          root,
          parent,
          attachmentTags = [],
        ) {
          const history = histories.get(`${community}/${channel}`);
          const event = sign(
            9,
            [
              ["h", channel],
              ...attachmentTags,
              ...(root
                ? parent && parent !== root
                  ? [
                      ["e", root, "", "root"],
                      ["e", parent, "", "reply"],
                    ]
                  : [["e", root, "", "reply"]]
                : []),
            ],
            content ?? `Live append ${history.length}`,
            own ? userKey : peerKey,
            (history.at(-1)?.created_at ?? 1700000900) + 1,
          );
          history.push(event);
          if (relay && deliver) relay.publish(community, event);
          else if (relay) return event;
          else {
            expect(streams.get(community)?.size).toBeGreaterThan(0);
            for (const client of streams.get(community))
              if (client.channels.includes(channel))
                client.response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          return event;
        },
      });
      expect(report.unexpected).toEqual([]);
      // Aborted startup streams can race an already-dispatched observer control.
      // Permit only 404s whose exact stream was already closed by the real host;
      // a current/unknown stream failure still fails, and all errors stay recorded.
      report.retiredObserverControls = [...observerFailures];
      expect(observerFailures.every((failure) => failure.retired)).toBe(true);
      const retiredConsole = (message, index) => {
        if (
          !/^Failed to load resource: the server responded with a status of 404/.test(
            message,
          )
        )
          return false;
        const match = observerFailures.findIndex(
          (failure) => failure.url === consoleLocations.get(index),
        );
        if (match < 0) return false;
        observerFailures.splice(match, 1);
        return true;
      };
      // Recovery journeys inject specific failed host requests. Match
      // each exact URL once, not every 502 or every console error in the test.
      const sidebarFailures = [
        ...(report.sidebarSortFailures ?? []),
        ...(report.sidebarMuteFailures ?? []),
        ...(report.sidebarStarFailures ?? []),
        ...(report.sidebarAssignmentFailures ?? []),
        ...(report.sidebarRemovalFailures ?? []),
        ...(report.sidebarPreferenceFailures ?? []),
        ...(report.startupFailures ?? []),
        ...(report.builderlabFailures ?? []),
      ];
      // Activity reads retry a 502 quietly, so their journeys inject a 403.
      const activityFailures = [...(report.sidebarActivityFailures ?? [])];
      const injectedSidebarFailure = (message, index) => {
        const status =
          /^Failed to load resource: the server responded with a status of (502|403)/.exec(
            message,
          )?.[1];
        const failures =
          status === "502"
            ? sidebarFailures
            : status === "403"
              ? activityFailures
              : undefined;
        const match = failures?.indexOf(consoleLocations.get(index)) ?? -1;
        if (match < 0) return false;
        failures?.splice(match, 1);
        return true;
      };
      // Edge 403 pages (e.g. a VPN reconnecting) injected on relay reads.
      const githubFailures = [
        ...(report.githubFailures ?? []),
        ...(report.relayFailures ?? []),
      ];
      const injectedGitHubFailure = (message, index) => {
        if (
          !/^Failed to load resource: the server responded with a status of 403/.test(
            message,
          )
        )
          return false;
        const match = githubFailures.indexOf(consoleLocations.get(index));
        if (match < 0) return false;
        githubFailures.splice(match, 1);
        return true;
      };
      expect(
        report.consoleErrors.filter(
          (message, index) =>
            !retiredConsole(message, index) &&
            !injectedSidebarFailure(message, index) &&
            !injectedGitHubFailure(message, index) &&
            !(
              expectedSidebarIconFailure &&
              message.includes("Fixture sidebar icon failure")
            ) &&
            !(
              expectedPageFailure &&
              message.includes("Fixture page render failure")
            ) &&
            !(
              relay?.expectedHttpErrors() &&
              /^Failed to load resource: the server responded with a status of 429/.test(
                message,
              )
            ),
        ),
      ).toEqual([]);
      // All page errors stay in the evidence; only known engine reports pass.
      expect(unexplainedPageErrors()).toEqual([]);
    } finally {
      for (const timer of olderPageTimers) clearTimeout(timer);
      if (iconCongestion)
        for (const response of heldIcons)
          if (!response.writableEnded) send(response, {});
      report.additionalPageErrors = watchedPages
        .slice(1)
        .flatMap((watched) => watched.errors);
      await writeFile(
        testInfo.outputPath("evidence.json"),
        JSON.stringify(report, null, 2),
      );
      await testInfo.attach("browser-evidence", {
        body: JSON.stringify(report, null, 2),
        contentType: "application/json",
      });
      await stopRoutes(context);
      await page.close();
      for (const clients of streams.values())
        for (const client of clients) client.response.end();
      if (server) {
        server.httpServer.closeAllConnections();
        await new Promise((resolve) => server.httpServer.close(resolve));
      }
    }
  },
});
export { expect };
