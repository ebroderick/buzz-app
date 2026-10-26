import "../../src/shared/styles/globals.css";
import { useKeyboardFocusVisibility } from "../../src/shared/design-system/useKeyboardFocusVisibility";
import { AgentSettings } from "../../src/app/AgentSettings";
import { StrictMode, useState, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { finalizeEvent } from "nostr-tools";
import { Context } from "@deepseek-ai/cordis";
import { emptySync } from "../../src/features/communities/known-communities";
import { createPluginManager } from "../../src/plugins/manager";
import { PagesService } from "../../src/features/pages/service";
import { PanelsService } from "../../src/features/panels/service";
import { ShortcutsService } from "../../src/features/shortcuts/service";
import { SettingsCardsService } from "../../src/features/settings/service";
import { provideNavigation } from "../../src/features/navigation/service";
import { ConversationService } from "../../src/features/conversation/service";
import { bundledPlugins } from "../../src/bundled";
import { conversationFeatures } from "../../src/app/conversation-features";
import { bindNames } from "../../src/features/identity-names/service";
import { createAgentDirectory } from "../../src/features/identity-names/testing";
import { createRelaySession } from "../../src/features/relay/session";
import { relayOrigin } from "../../src/features/communities/destination";
import { registerBrokerCommunity } from "../../src/features/relay/transport";
import {
  keypair,
  metadata,
  roster,
  profile,
  message,
  signed,
} from "../../src/features/relay/testing";
import { matchesEvent } from "../../src/features/relay/projection";
import type { RelayEvent } from "../../src/features/relay/events";

const showSettings = new URLSearchParams(location.search).has("settings");
const viewer = keypair(),
  relay = keypair(),
  first = keypair(),
  second = keypair(),
  outsider = keypair();
let members = [viewer.pubkey, first.pubkey, second.pubkey];
let time = 1700000000;
const publications: RelayEvent[] = [];
let replaceRecipients = (
  _people: readonly { pubkey: string; name: string }[],
): boolean => false;
let incoming = (_events: readonly RelayEvent[]) => {};
let releaseProfiles = () => {};
let libraryReads = 0;
const reads: (readonly number[])[] = [];
// Parallel to `reads`: the directory search term a read carries, or null. The
// directory reads once per new query by design, unlike cold session reads.
const readSearches: (string | null)[] = [];
// Parallel to `reads`: whether a typed query made the read rather than the
// session. The people directory searches each query; the public channel
// directory reads its page once per query after the typing pause.
const readQueries: boolean[] = [];
let pendingReads = 0;
let libraryIncludesFirst = false;
const admission = new URLSearchParams(location.search).has(
  "nonmember-admission",
);
// With nonmember-admission: make "General" a DM, which can never add members.
const dm = new URLSearchParams(location.search).has("dm");
const naming = new URLSearchParams(location.search).has("identity-names");
let colliding = false;
const secondProfile = () =>
  profile(
    second,
    {
      name: naming && !colliding ? "Other Honey" : "Honey",
      is_agent: true,
      picture: "https://avatars.test/app-icon.png",
    },
    time,
  );
const delayed = new URLSearchParams(location.search).has("delayed-profiles");
const testControls = new URLSearchParams(location.search).has("test-controls");
const channels = new URLSearchParams(location.search).has("channels");
const stream = new URLSearchParams(location.search).has("stream");
// Opt-in roster scale for local typing diagnostics; ordinary journeys keep two channels.
const channelCount = Math.min(
  1000,
  Math.max(
    0,
    Number(new URLSearchParams(location.search).get("channel-count")) || 0,
  ),
);
const extraChannels = Array.from({ length: channelCount }, (_, index) => [
  roster(relay, `scale-${index}`, [viewer.pubkey], time),
  metadata(relay, `scale-${index}`, `general-${index}`, time, [
    ["t", "stream"],
  ]),
]).flat();
// An open channel the viewer has not joined, for `#` public channel search.
const openChannels = new URLSearchParams(location.search).has("open-channels")
  ? [
      roster(relay, "open", [first.pubkey], time),
      metadata(relay, "open", "Gemstones", time, [["t", "stream"], ["public"]]),
    ]
  : [];
const searches: string[] = [];
const heldSearches: string[] = [];
let searchGate: Promise<void> | undefined;
let releaseSearch = () => {};
// Exact channel resolves (39000 by `#d`), held to observe a pending lookup.
let channelGate: Promise<void> | undefined;
let releaseChannels = () => {};
// Optional visual preview: real GIF search, with messages still local to this fixture.
const gifRelay = new URLSearchParams(location.search).get("gif-community");
const gifCommunity = gifRelay ? relayOrigin(gifRelay) : undefined;
if (gifCommunity)
  await registerBrokerCommunity(gifCommunity, AbortSignal.timeout(12000));
const profileGate = delayed
  ? new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    })
  : Promise.resolve();
const owner = createRelaySession(
  {
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: (url) =>
      url.startsWith("https://avatars.test/") ? new URL(url).pathname : url,
    ...(new URLSearchParams(location.search).has("attachments")
      ? {
          async uploadAttachment() {
            throw new Error("Toolbar fixture does not upload files");
          },
        }
      : {}),
    // Synthetic, lazy capability: only the explicit fixture action loads it.
    async readAgentLibrary() {
      libraryReads++;
      return {
        definitions: [],
        identities: naming
          ? [
              { pubkey: first.pubkey, name: "Honey" },
              {
                pubkey: second.pubkey,
                name: colliding ? "Honey" : "Other Honey",
              },
            ]
          : libraryIncludesFirst
            ? [{ pubkey: first.pubkey, name: "Honey" }]
            : [],
      };
    },
    subscribe(callbacks) {
      incoming = callbacks.receive;
      callbacks.state({ status: "connected", routes: [] });
      return { update() {}, retry() {}, dispose() {} };
    },
    async query(filters) {
      reads.push(filters.flatMap((filter) => filter.kinds ?? []));
      readSearches.push(
        filters.find((filter) => filter.search !== undefined)?.search ?? null,
      );
      readQueries.push(
        filters.some(
          (filter) =>
            filter.search !== undefined ||
            (filter.kinds?.length === 1 &&
              filter.kinds[0] === 39000 &&
              !filter["#d"] &&
              !filter.ids),
        ),
      );
      pendingReads++;
      try {
        if (filters.some((filter) => filter.kinds?.includes(0)))
          await profileGate;
        if (
          channelGate &&
          filters.some(
            (filter) => filter.kinds?.includes(39000) && filter["#d"],
          )
        )
          await channelGate;
        const search = filters.find((filter) => filter.search)?.search;
        if (search !== undefined) {
          searches.push(search);
          if (searchGate) {
            heldSearches.push(search);
            await searchGate;
            heldSearches.splice(heldSearches.indexOf(search), 1);
          }
        }
        const events = [
          roster(relay, "c", members, time),
          admission
            ? signed(relay, {
                kind: 39000,
                content: JSON.stringify({
                  name: "General",
                  channel_type: dm ? "dm" : "stream",
                }),
                created_at: time,
                tags: [
                  ["d", "c"],
                  ["name", "General"],
                  ["t", dm ? "dm" : "stream"],
                ],
              })
            : metadata(
                relay,
                "c",
                "General",
                undefined,
                stream ? [["t", "stream"]] : [],
              ),
          roster(relay, "other", [viewer.pubkey], time),
          metadata(
            relay,
            "other",
            "Other",
            undefined,
            channels ? [["t", "stream"], ["private"]] : [],
          ),
          profile(viewer, { name: "Viewer" }),
          profile(first, {
            name: delayed ? "Mary Jane" : "Honey",
            picture: "https://avatars.test/bestie.png",
          }),
          secondProfile(),
          ...(admission ? [profile(outsider, { name: "Outside Person" })] : []),
          ...extraChannels,
          ...openChannels,
          ...publications,
        ];
        return events.filter((event) =>
          filters.some((filter) => {
            const { search, search_mode: _mode, ...ordinary } = filter;
            // Name-prefix directory search, like the relay's prefix mode.
            return (
              matchesEvent(event, ordinary) &&
              (search === undefined ||
                (event.kind === 0 &&
                  String(JSON.parse(event.content).name ?? "")
                    .toLowerCase()
                    .startsWith(search.toLowerCase())))
            );
          }),
        );
      } finally {
        pendingReads--;
      }
    },
    writer: {
      kinds: [9],
      async sign(event) {
        return finalizeEvent(
          { ...event, tags: event.tags.map((tag) => [...tag]) },
          viewer.secret,
        );
      },
      async publish(event) {
        publications.push(event);
      },
    },
  },
  { outboxStorage: { load: () => [], save: () => {} } },
);
const nameProvider = createAgentDirectory();
const names = bindNames(owner.session, {
  snapshot: () => [nameProvider],
  subscribe: () => () => {},
});
const namedSession = { ...owner.session, names };
if (new URLSearchParams(location.search).has("teams")) {
  const state = {
    status: "ready" as const,
    entries: [
      {
        eventId: "team-head",
        createdAt: 1,
        record: {
          version: 1 as const,
          community: "fixture",
          deleted: false,
          value: {
            type: "team" as const,
            id: "honeys",
            name: "The Honey Team",
            agents: [first.pubkey, second.pubkey],
          },
        },
      },
    ],
  };
  namedSession.channelKit = {
    available: true,
    snapshot: () => state,
    subscribe: () => () => {},
    ensure() {},
    async refresh() {},
    async save() {
      throw new Error("Read-only fixture");
    },
  };
}
owner.session.channels.ensureList();
const context = new Context();
const disabledCalls: {
  inputDisabled: boolean | undefined;
  text: boolean;
  mention: boolean;
}[] = [];
const plugins = createPluginManager(context, {
  bundled: [
    // This harness deliberately makes the real providers optional to exercise
    // contribution removal and stale callbacks. The app always loads them.
    ...conversationFeatures,
    ...bundledPlugins.filter(
      ({ manifest }) =>
        channels && ["buzz.channels", "buzz.links"].includes(manifest.id),
    ),
    {
      manifest: {
        id: "test.disabled-command",
        name: "Disabled command probe",
        apiVersion: 1,
      },
      module: {
        inject: ["conversation"],
        apply(ctx) {
          ctx.conversation.registerTool({
            id: "probe",
            title: "Disabled command probe",
            component: ({
              disabled,
              insertText,
              insertMention,
              replaceRecipients: replace,
            }) => {
              useLayoutEffect(() => {
                replaceRecipients = replace;
                return () => {
                  replaceRecipients = () => false;
                };
              }, [replace]);
              useLayoutEffect(() => {
                if (disabled)
                  disabledCalls.push({
                    inputDisabled:
                      document
                        .querySelector('[role="textbox"]')
                        ?.getAttribute("aria-disabled") === "true",
                    text: insertText("STALE"),
                    mention: insertMention({
                      pubkey: second.pubkey,
                      name: "Honey",
                    }),
                  });
              }, [disabled, insertText, insertMention]);
              return null;
            },
          });
        },
      },
    },
  ],
});
const conversation = new ConversationService(context);
if (channels) {
  new PagesService(context);
  new PanelsService(context);
  new SettingsCardsService(context);
  new ShortcutsService(context);
  provideNavigation(context);
  // Channels requires Agents for its page/settings, neither mounted here.
  context.provide("agents", {});
  context.provide("communityReader", {
    subscribe: () => () => {},
    snapshot: () => ({
      status: "unavailable",
      relayAvailable: false,
      profile: { name: "", picture: "" },
      memberships: [],
      selected: null,
      sync: emptySync(),
    }),
  });
  // Channels hands community membership to its page for the auto-join switch; no roster here.
  context.provide("adminAccess", { membership: undefined });
  // Only the composer is mounted; the Channels page never consumes this service.
  context.provide("relay", {
    snapshot: () => ({ session: namedSession }),
    subscribe: () => () => {},
  });
}
Object.assign(window, {
  mentionFixture: {
    async collide(value: boolean) {
      colliding = value;
      ++time;
      incoming([secondProfile()]);
      await owner.session.agentLibrary.refresh();
    },
    qualifier: (key: string) => names?.lookup(key)?.qualifier,
    outsider: outsider.pubkey,
    first: first.pubkey,
    second: second.pubkey,
    publications,
    replaceRecipients: (people: readonly { pubkey: string; name: string }[]) =>
      replaceRecipients(people),
    disabledCalls,
    change: (action: "enable" | "disable", id: string) =>
      plugins.change(action, id),
    outbox: () => owner.session.outbox?.snapshot(),
    refresh: () => owner.session.channels.refreshList?.(),
    removeFirst() {
      members = [viewer.pubkey, second.pubkey];
      time++;
      owner.session.channels.refreshList?.();
    },
    releaseProfiles: () => releaseProfiles(),
    libraryReads: () => libraryReads,
    reads: () => ({
      kinds: reads,
      searches: readSearches,
      queries: readQueries,
      pending: pendingReads,
    }),
    searches: () => [...searches],
    heldSearches: () => [...heldSearches],
    holdSearches() {
      searchGate = new Promise((resolve) => {
        releaseSearch = resolve;
      });
    },
    releaseSearches() {
      searchGate = undefined;
      releaseSearch();
    },
    holdChannelReads() {
      channelGate = new Promise((resolve) => {
        releaseChannels = resolve;
      });
    },
    releaseChannelReads() {
      channelGate = undefined;
      releaseChannels();
    },
    setLibraryAgent(included: boolean) {
      libraryIncludesFirst = included;
      return owner.session.agentLibrary.refresh();
    },
    list: () => owner.session.channels.list(),
    otherMessage() {
      incoming([message(viewer, "other", "Unrelated preview", ++time)]);
    },
  },
});
function Fixture() {
  useKeyboardFocusVisibility();
  const [thread, setThread] = useState(false);
  const [disabled, setDisabled] = useState(false);
  return (
    <main
      style={
        testControls
          ? { maxWidth: 700, padding: 40, marginTop: 380 }
          : {
              minHeight: "100dvh",
              width: "100%",
              display: "grid",
              placeItems: "center",
              padding: 24,
            }
      }
    >
      {testControls && (
        <>
          <button type="button" onClick={() => setThread(!thread)}>
            Toggle thread
          </button>
          <button
            type="button"
            onClick={() => {
              members = [viewer.pubkey, second.pubkey];
              time++;
              owner.session.channels.refreshList?.();
            }}
          >
            Remove first Honey
          </button>
          <button type="button" onClick={() => setDisabled(!disabled)}>
            Toggle disabled
          </button>
        </>
      )}
      <div style={{ width: "100%", maxWidth: 720 }}>
        <conversation.ui.Composer
          disabled={disabled}
          session={namedSession}
          scope={
            gifCommunity
              ? `${gifCommunity}:${viewer.pubkey}`
              : "mentions-fixture"
          }
          channelId="c"
          channelName="General"
          {...(thread ? { threadRootId: "a".repeat(64) } : {})}
        />
      </div>
      {showSettings && <AgentSettings />}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
