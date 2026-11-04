# Agents

## Scope

Agents (`src/bundled/agents`, `src/features/agents`) is the app's only agent
system: it creates, runs and deletes the viewer's agents. This document covers
what the rest of the app knows about agents: shared selection, mentions, archive
display, activity, names, inventory and usage. The v1 Agents page, Profiles plugin,
Channel templates plugin and team bundles are gone, as are the native `agent_control_*`,
model-discovery and harness-install commands behind them. Agents keeps sharing
agents to the community catalog and exporting them; see
[Sharing and exporting agents](#sharing-and-exporting-agents).

Agents was called Agents2 while v1 still shipped. Startup now moves its identity
folder to `agents/identities.json` and its browser settings to `buzz.agents.v1`
and `buzz.agents.teams.v1`. Identity bytes and keychain entries are unchanged.
The Agents2 plugin switch moves to `buzz.agents`; the retired v1 switch is
removed. Plugin registry versions distinguish these preferences (native v2,
browser v3), so a later restart preserves changes to the new switch.

The temporary migrators are `src/features/agents/migrate-storage.ts`,
`src/plugins/migrate-agent-flag.ts`,
`crates/plugin-manager/src/migrate_agent_flag.rs`, and
`src-tauri/src/sign_out/migrate_agents.rs`. Remove them and their call sites after
2026-10-18 once development users have upgraded; remove the old registry-version
readers and the legacy sign-out keep/key-deletion entries at the same time.
This is a one-way development migration: close older Buzz copies before the
first upgraded launch and use the upgraded build afterward. Native migration
requires the existing exclusive instance lock; conflicts stop startup without
replacing either folder. A pending erase handles both folder names before the
migration runs. Browser moves write the destination before removing the source
and resume identical interrupted copies; differing destinations are left intact
and reported as migration errors.

## Creating and changing agents from a conversation

The shared tools offer `agent_types` to list installed local runtimes and
`agent_create` to submit an unsaved creation draft using a listed type key and a display name,
optionally with a picture. It returns a request ID and `saved: false`; no identity exists yet. The owner reviews
the usual Create agent form, may edit the name, runtime and settings, and creates
only by submitting it. Closing the form discards the request. Requests are local,
bounded to 16 and do not survive reload or a change of signed-in owner.
Approval binds the identity to the requesting agent's owner and community, even
when another community is selected. Add the agent to a conversation separately
after creation; see the [shared tool definitions](../src/buzz-mcp/tools.ts) for
the available operations and arguments. Agent tools do not expose draft approval.

`agent_update` submits an unsaved draft of changes to one of the owner's local
agents in the same community, named by pubkey or exact name: a new name, a type
key from `agent_types`, new instructions or a new picture. An agent may propose
changes to itself. Absent fields stay as they are. The
owner reviews them in the New agent form, titled Edit and filled in with the
agent's settings and the proposed changes, with the usual type-change preview;
saving applies what the owner reviewed, and closing the review discards the
request. A type change carries what the new type adopts, as a manual one does. A proposed picture
is a local PNG, JPEG, GIF or WebP file that the tool uploads to the community as
the requesting agent once the request is valid, stripped of metadata as the
owner's own avatar upload is. The draft carries only its HTTPS URL, which starts the
review's avatar picker, and saving sets it as the owner's own avatar change
does. Change requests share the creation requests' local bound and lifetime.
Keys stay in native custody. Hosted-provider provisioning and standalone tool
servers do not support these operations.

## External app authorization

The build flag `BUZZ_EXTERNAL_MCP_COMMUNITIES` lists the allowed community
origins. It defaults to no access. Desktop preview releases enable bb-block only.
Consent and Settings use this list. The Agents service also checks it before
opening a connection and on each tool call. See [configuration](configuration.md#external-mcp-community-flag).

Buzz desktop accepts `buzz://mcp-authorize` requests from local apps. Opening a
link only shows consent. The owner selects a community and an app-held,
unprotected agent, then selects **Authorize** or **Deny**. No plugin specific
to the external app is required. The bundled Agents plugin owns the native MCP
permission. **Settings > External apps** shows the connection and **Revoke access**.
Keys stay in Buzz. Closing Settings keeps access active.

Version 1 links contain `version=1`, the requesting `client` display name,
`callback`, random `state`, `scope` (`read`, `post`, or both), `code_challenge`,
and `code_challenge_method=S256`. The callback must be exactly
`http://127.0.0.1:<port>/buzz/authorize`, with a port from 1024 through 65535.
State and challenge each encode 32 bytes as unpadded base64url. The client name
is supplied by the requesting app; Buzz does not attest its identity.
Requests expire after five minutes. Duplicate or unknown parameters are rejected.

After consent, Buzz sends a JSON POST to the callback with `version: 1`, `state`,
and `outcome: "authorized"`, plus `code` and `exchange_url`. Denial sends
`outcome: "denied"` with no code. A code lasts 60 seconds. The client sends a
JSON POST with `version: 1`, `state`, `code`, and `code_verifier` to the exact
`http://127.0.0.1:<port>/authorize/exchange` URL. S256 verification consumes the
code once and returns `{version: 1, url, token}`. The URL is that listener's
`/mcp` endpoint. Neither a link nor a callback carries the MCP bearer or a key.
Native callback requests do not follow redirects. Failed callbacks close the grant.
A redeemed grant also expires if it does not initialize within the code deadline.

The MCP endpoint accepts JSON POST messages with MCP `2025-06-18`. Initialization
returns `Mcp-Session-Id`; later requests need that header and `Authorization:
Bearer <token>`. Notifications return 202. There is no SSE or DELETE endpoint.
Each grant admits one upstream session; the external app shares it among its
agents. A second initialization stops the grant. Revocation, a community or
identity change, or the end of the owning agent runtime, plugin, or app also
stops it. Start setup again in the external app after a connection ends.

The read scope allows `channel_list`, `channel_get`, and `read`. The post scope
allows `send` and `reply_in_subthread`. Buzz classifies each built-in tool through
its trusted external-access policy. Unclassified tools cannot run. Runtime plugin
tools cannot enroll in this policy.

`tools/list` returns all classified tools in one page. It rejects a supplied
`cursor`. Each tool has `_meta["buzz/requiredScopes"]`. The list result has
`_meta["buzz/grantedScopes"]` and `_meta["buzz/supportedScopes"]`; the supported
set is `read` and `post`. Tool discovery does not grant access. Each call checks
the grant against the trusted policy. A missing scope returns `isError: true`
and `_meta["buzz/error"]: {code: "authorization_required", required_scopes: [...]}`.
`required_scopes` lists the missing scopes. Each approval replaces the previous
grant. The external app must request all scopes it still needs, including scopes
it already has. For example, an app with `read` that needs `post` requests
`scope=read post`. Use `buzz/grantedScopes` from discovery to retain current access.
The app must not retry the call automatically after approval. New classified tools
use this same contract.

The shared schemas apply with explicit
targets: `read` needs `channel`, `thread`, or `message_url`. A `message_url` uses
the linked message's channel and thread; it cannot combine with `channel` or
`thread`. Searches with `q` need `channel` or `message_url`;
`channel_get` needs `channel`; `send` needs `channel`, `text`, and `audience`;
`reply_in_subthread` needs `parent`, `text`, and `audience`. Posts accept
`mentions`, and `send` accepts `reply`. Posts reject `path`, `files`, and `final`.
Unknown fields are rejected. File access, commands, Git credentials, and plugin
tools are unavailable. Connection credentials must stay out of logs and messages.

## Product help for agents

The read-only `buzz_help` tool returns [the Buzz quick guide](buzz-help.md), bundled
with this app version. The shared agent prompt tells agents to read it when someone
asks how to use Buzz; the full guide is not added to every session's initial context.
Claude, Codex, Goose and Pi use the shared tools. This repository's standalone MCP
server exposes the same tool and supplies the hint in its server instructions.
Other remote hosts must adopt the tool themselves. No repository checkout or web
request is needed to read it.

Keep the guide current in the same change as user-facing behavior. It describes
implemented features, not plans or internal support procedures. Existing sessions
may retain their previous prompt or tool list; use **Start a new session** to pick
up the new guidance. Installing a new build updates the bundled guide, not every
older app or remote host.

## Agent Attention

Attention itself (the runtime, tools, storage and sources) is core, but it runs on this device only while a plugin that shows it is on. The bundled Attention plugin (`buzz.watching`, on by default) adds an Attention tab to the settings of every agent running on this device, whatever its type. The tab explains Attention, holds the switch that lets this device run the agent's watches, then groups that agent's subscriptions by Interest. It shows instructions, listening and delivery destinations, enabled state and available wake history, and suggests asks while the agent has none. Ask an agent to create watches through its Attention tools; pausing or removing one preserves the other saved objects. Empty Interests remain visible and can be deleted after their watches are removed. Turning the plugin off hides the tab and turns every agent's Attention off on this device; mentions still wake agents, and each agent keeps its saved switch for when the plugin is back on. The former standalone Agent Attention page is gone, so an old link to `buzz.agents/attention` opens as an unavailable destination.

## Agent types and providers

Harness plugins register agent types with the Agents service. An agent type owns
the defaults, migration policy, per-agent settings tabs, model discovery and run
behavior for its agents. Plugins can add a tab to every local agent with
`ctx.agents.registerTab`, or to some of them with its optional `when(agent)`;
the Attention plugin's Attention tab holds the device Attention switch, and the
Bestie plugin's Bestie tab shows only on your Bestie.

Attention is shared by every harness, and a harness has no attention code.
`src/buzz-mcp/session-tools.ts` exports `BUZZ_SESSION`: the Buzz tools and the
attention tools. How to use the attention tools is in their own descriptions,
not `BUZZ_PROMPT`. Every session gets the
same list and prompt, whether attention is on or off, so turning attention on or off never
restarts a session or invalidates its prompt cache. `turnNote` gives the text
to add at the end of each turn: the attention review when attention is on and
the agent has Interests, a line that it has none when it has none, and a note
that it is off when it is off.

`sessionTools` lists every tool under one `buzz` server, each with a `load`
of `always` or `search`. The Buzz tools load up front and the attention tools on
search. Only the Buzz tools choose: tools plugins add always load on search, so
installing plugins never grows what every turn carries. `sessionHint` says what
the searchable tools are. `respond` stays harness-neutral: a harness passes a
`Listing` to shape it. Claude's marks each tool that loads up front with
`_meta["anthropic/alwaysLoad"]`, so Claude lists the rest by name until the
model searches for them, and makes the hint the server's `instructions`. Codex gets
`deferLoading` on each searched tool and the hint as the namespace description.
Every model in Codex's catalog supports tool search; one that did not would not
see the deferred tools. goose cannot load tools on demand, so it gets every tool
up front and no hint. A tool's name is the same whenever it loads.
`callSessionTool` dispatches each call and refuses attention calls while
attention is off. A new shared tool needs no harness change.

Plugins add tools with `ctx.agents.addTool`, listed after the Buzz tools under
the same `buzz` server. Names are shared by every plugin, so a plugin's tools
should start with its name (`notes_get`); `addTool` refuses one that a Buzz tool
or another plugin has. The standalone server in
`src/buzz-mcp/main.ts` stays without them. A harness reads `agents.tools()`
and passes it to `respond` or `callSessionTool`. A session keeps the list it
started with, so `addedKey` goes in what decides when one is replaced: the
Claude and goose session fingerprints, Claude's spare, and each saved Codex
binding, since `thread/resume` keeps a thread's tools. Claude and goose resume
their sessions when replaced, but a Codex agent starts a new thread and loses its
context. That happens once when a plugin with tools ships, and again whenever a
tool's name, description or schema changes, so edit those deliberately.
`addedKey` covers only plugins' tools, so a resumed Codex thread keeps the Buzz
tools, and their `load`, that it started with.

The GitHub plugin keeps one store of pull request data (`pull-states.ts`), and
it is the only place the plugin reads pull requests from GitHub. Links, the Solo
sidebar, the side panel, watches and agents' lookups each ask it for a level:
`state`, `feedback` (reviews and comments with their text) or `details` (what
the side panel shows and acts on). It reads
each pull request once for all of them, in one batched `gh` query, at every
level asked of it. It drops a level's data at the first read without that
level, and forgets a pull request nobody follows at the first read 15 minutes
after its last poll; with no later read, the data stays in memory.
Each reader also says how often it wants its pull request read again; the
store reads each one as often as its most eager reader wants, and every poll
reads all that are due together.

On desktop the GitHub plugin adds `github_pr_state`, so an agent can read a pull
request's state as its owner's links show it: open, draft, merged or closed,
checks, failed check names and conflicts, with when it was read. With
`details: true` it also gives what the side panel shows: title, branches, files
changed, the review decision and reviewers, unresolved review threads, the
merge state and auto-merge. The answer is at most a minute old unless the agent
asks for a fresh read, or the last read failed: then the answer says so, and
how old it is.

The GitHub plugin also adds `github_watch_pr`, so an agent can wait on a pull
request without a model checking it. An agent calls it with a pull request URL
and the id of one of its own Interests, from a thread or a Solo chat. The tool is a
convenience over `watch_add`: it adds an `attention/github-pr` source watch to that
Interest through the same attention tool code, and refuses an Interest that does
not exist. The plugin never writes an Interest. While the app is open the watch asks the store to
follow the pull request's feedback, which it reads through the signed-in `gh`
CLI once a minute, also while the window is hidden. It wakes the agent when CI
settles on the head commit, once per commit and result, or when new feedback has
been quiet for 90 seconds, and once more when the pull request merges or closes,
so the agent can finish and retire its Interest. Attention delivers the wake
in the conversation where it called the tool: no message is sent, and the agent
is told its text is data. It quotes the failed checks' names and the new
comments, line by line, each clipped, with GitHub's links. Agents comment as the
`gh` account, as their owner does, so GitHub cannot tell them apart: by default
a comment of that account that starts with 🤖, as an agent's do, wakes nobody,
and the owner's other comments wake the agent. A watch is saved in Attention on the device and respects its on/off switch. Device-local GitHub watches saved before Attention are dropped, not imported: they name no Interest. It ends when the
pull request merges or closes, after 20 wakes, after 30 minutes without a
successful read, or when the agent calls it with `stop: true`.

Settings → Plugins → GitHub comment authors decides whose feedback wakes agents,
since anyone can comment on a public pull request. It holds rules, one per
line, saved on the device. Each starts with `allow` or `deny`, followed by any
of these conditions, all of which must hold:

- `author:login`, an exact login, or `author:@me`, the signed-in `gh` account.
  A bot's login ends in `[bot]`.
- `author:/pattern/`, a JavaScript regular expression the login must match.
- `org:name`, membership of a GitHub organization, named exactly.
- `body:/pattern/`, a regular expression the comment's first 1,000 characters
  must match. That is the most of a comment a wake quotes.
- `prefix:text`, what the comment starts with, leading space aside. It runs to
  the end of the line, spaces included, so it comes last.

A bare `allow` or `deny`, with no conditions, matches everyone.

Logins match case aside, so an author pattern always has the `i` flag; a
pattern may also use `m`, `s` and `u`. Patterns take JavaScript's syntax but not
backreferences, lookaround or escapes that mean something else alone, such as
`\c1`, `\U0041` or `\q`, and `src/bundled/github/pattern.ts` matches them
as an automaton, in time the text's length bounds, so a pattern like
`/^(a+)+$/` cannot stall the app on a hostile comment. The first rule that matches decides, and
When no rule matches decides the rest: Wake the agent or Don't wake it.
Saving compiles every pattern and rejects the rules, naming the line, when one
is not a rule, or when they name more organizations than one membership read
can ask about. Saved rules that no longer parse, such as a pattern with
lookaround an earlier build accepted, stay in Settings with their error, and
hold all feedback until they are fixed rather than falling back to the defaults. The defaults keep the behavior from before rules: agents'
comments wake nobody, and everyone else's wake the agent.

```text
deny author:@me prefix:🤖
```

with When no rule matches set to Wake the agent. Adding, say,
`allow org:block` and `allow author:copilot-pull-request-reviewer[bot]` and choosing Don't wake it
limits feedback to those. Membership is asked of `gh` only for organizations the rules
name, and kept for an hour; feedback whose author's membership cannot be read
waits for a later poll, until ten polls in a row fail for that login alone and
it counts as no member. While GitHub answers no membership read, not even about
the signed-in account, no failure counts, so an outage holds feedback rather
than letting it past an `org:` deny rule. A membership hidden from the `gh` account, or a
misspelled organization, counts as none, and bots and deleted accounts are in
no organization. Each poll reads the rules again, so a change applies to
running watches. CI and pull request state are not limited.

The Agents runner starts a mention run from a `p` tag, or from any new message
by the other member of a one-to-one DM the agent is in; group DMs still need
the mention. It also owns watches and timers, and runs attention work in Janet's lanes: each
Interest's turns one at a time, up to 8 Interests at once, beside the mention
lane. For a wake in its lane, `src/features/agent-harness/wakes.ts` checks that
it is still current before and while its prompt is built. A subscription with a delivery address runs in that conversation through the type's `run`, with an `attention` trigger and the Interest instructions outside plugin-data framing. It remains in its Interest lane. Without an address it passes to the type's optional `runOnce`, which runs one turn with
no saved conversation (Claude: a
one-off process; Codex: an ephemeral thread). Its signal aborts
`STANDALONE_DEADLINE_MS` after it starts, including any wait for the harness to
be ready. The prompt text lives in `attention-prompt.ts`.

A plugin wakes an agent with `ctx.agents.wake(pubkey, { channel, root?, text })`,
in the conversation of that channel and thread, or of a Solo chat when it leaves
out `root`. It throws when this copy of the app does not run the agent or its
mention lane is full. The wake is a `plugin` trigger in the mention lane, with
the mention's rate limit, and is dropped like a queued mention when the agent
stops running here. Nothing goes to the relay. Claude, Codex, goose and Pi take
it on their mention path, without the owner check, since the plugin is the
owner's installed code. `src/features/agent-harness/plugin-wake.ts` gives them a local
anchor in place of the event (the thread's `e` tag, and a random id), and a
`<plugin-wake>` section in place of `<buzz-event>`. That section says the plugin
woke the agent, that neither the owner nor anyone in the channel wrote it, and
that its text is data. The anchor's id is never published: failure reports and
typing go to the thread root, or the channel itself in a Solo chat, and a wake
with no `root` outside a Solo chat is ignored. A wake is not saved for resume
and shows no activity row or Stop. Pi, which continues the runs an app left,
ends a wake's run instead, unless a mention or Attention wake left in the same
conversation would end with it or stay queued behind it. Then the wake's run
goes on, and only what it sends is posted. Pi still waits for the wake, so a
run of its own that fails fails what is queued behind it too, which reports it.

An agent hands off to itself in another of its conversations with the
`self_handoff` tool, which takes a channel, a thread and text. The tool requires
a channel the agent can see, as `send` does, and a thread in that channel (any
message of it names its root) unless the channel is a Solo chat. It refuses the
current conversation, which is the whole channel in a DM, a Solo chat or a
channel-scoped session. It is the same `plugin` trigger with `from`, the
conversation it came from, in place of `plugin`, shown in a `<self-handoff>`
section that names that conversation, says nobody wrote it as a message and that
its text is data, and that the agent acts only on what its owner asked. Only a
run's handle hands off.

A plugin leaves context for a later turn with
`ctx.agents.note(pubkey, channelId, text, root?)`, without waking the agent
or publishing a message. Pass the thread root for a thread conversation.
Channel-scoped sessions, DMs and Solo chats consume notes across their channel;
thread-scoped sessions take only notes addressed to their root. Notes are
consumed once when the harness is ready to deliver the turn, and restored to
the same conversation ahead of newer notes if delivery definitely never began.
They remain in memory only, and the call returns false unless this copy runs
the agent.

A type marks its primary configuration tab with `role: "settings"`. In the
Agents build view and profile panel, the host keeps that tab at a stable
`Settings` destination and supplies the current type identity plus retype
control through `settingsHost`. The type keeps ownership of its config draft
and Save behavior. Types without a settings-role tab receive a host-owned,
type-only Settings tab in both surfaces.

A type may mark its sessions tab with `role: "activity"`. The host keeps it at
a stable `agent:activity` destination, where opening the agent's activity lands
in its profile panel.

In completed owned-agent panes, inactive sections unmount. Switching sections
with an unsaved draft asks for confirmation; a confirmed discard also clears a
pending provider choice. Pending saves keep their section mounted until they
settle, so failures remain visible.

A reviewed provider choice remains a host-owned draft until the form's Save
action succeeds or the owner confirms discarding it. While it is pending, the
selected provider's settings tab edits the destination config produced by its migration policy, and
Save is available without another edit. Save commits the provider and that
config together; a failed save leaves the choice and draft available to retry
or revert.

An agent type may also contribute `provider`: a subscribable readiness snapshot,
a read-only check, and a management-dialog body. **Settings → Agent setup →
Harness defaults** lists each active type once using the registered title and
icon. It is a quick health view: rows show ready (with the default-model
control), checking, attention, or a neutral unavailable state. The create
dialog's **Model** row shows the same install and sign-in actions inline. The
Agents host owns the rows, modal framing, focus restoration and contribution
error boundary. The plugin owns connection actions and optional defaults inside
the dialog; blocking install or sign-in work must expose cancellation before the
dialog can close. Disabled or unloaded types remain in Settings → Plugins → Manage plugins.

Goose's Settings → Harness defaults contribution reads and writes Goose's own
configuration through `GooseSetup`. Provider keys stay in Goose's secret store;
Buzz keeps no separate Goose defaults store. Readiness requires a working
`goose-acp` and a configured default provider. The per-agent provider/model
fields remain overrides. Types without a provider contribution have no Harness
defaults row; a failed contribution retains the unavailable fallback.

Workspace, instructions and session scope are always per-agent. Claude and Codex
model/thinking choices may instead be blank, which means inherited rather than
rewritten. Their effective order is explicit agent override, saved device-wide
provider default, then the provider's native default. Missing or malformed
provider preferences preserve native behavior. A provider-default save notifies
the runtime like the corresponding per-agent save but does not mutate agent
records. Codex uses an inherited thinking choice only when the effective model
supports it, otherwise that model's default applies. Transient process/session
state may appear in the Activity tab, but is not durable history.

A type with `sessionControls` (Claude, Codex, goose and Pi) offers three immediate
session controls in the composer's gauge popover: **Compact session**,
**Start a new session**, and **Interrupt**. A side rail keeps all three visible.
Compact and New are enabled while that harness session is idle; Interrupt is
enabled while it is active, including work after a final Buzz reply. Disabled
controls remain focusable and explain their state in a tooltip. The app holding
the agent's runner performs the action; other copies explain where to use it.
Send keeps its existing steering or Solo queue preference and carries no session
action.
While manual compaction runs, its icon shows a spinner and the composer says
“Compacting session…”. Compact, New and Send (including Enter) are disabled;
the draft remains editable and Interrupt remains available. Send returns when
compaction finishes, fails or is interrupted. The block applies to messages
targeting that harness session; other sessions remain usable.

`sessionControls.scope(agent)` returns the agent's session scope. Controls appear in a
thread, DM or Solo chat, and at a channel's top level for a channel-scoped agent.
A thread-scoped agent's top-level message starts a thread of its own, so it has
no existing session to control. goose compacts only a session still open. A new
session is primed with the conversation on the next message. Compaction failures
appear beside the controls. Session actions never travel on messages. A mention
received during an action is accepted into that session's handoff and releases
the agent's mention lane immediately. It waits for the action without spending
its handover deadline; other conversations continue, and stopping the agent
cancels the deferred work.

Claude's channel-scoped sessions save a separate history timestamp for each
thread. Working in one thread does not mark another thread's messages as seen.
The 200 most recently addressed threads are tracked across reloads. Older saves
and evicted entries supply that thread's recent context again on its next turn;
the saved Claude session is retained. DMs and Solo chats keep one conversation
timestamp.

Codex's provider model menu offers **Codex recommended** (the catalog's
recommendation) and specific models. Blank model preferences follow the
recommendation; blank thinking preferences follow the selected model's default
unless a supported Buzz provider thinking preference is inherited. Explicit Buzz
selections take precedence. Local Codex configuration does not supply model or
thinking preferences to Buzz; unrelated configuration is still used where needed.
Preview and execution resolve the same concrete model and thinking level, and
execution passes both explicitly rather than falling through to host preferences.
Composer discovery caches reads until effective model or thinking settings change.
Codex opts into sending the concrete displayed model and known effort with each
composer message; this does not rewrite saved provider preferences or agent
overrides. Model discovery's `sendDefaults` flag is opt-in: other types send only
explicit picks. In particular, an untouched Claude picker must not emit an override,
so follow-up messages preserve a running turn's model and configured cloud model
IDs do not become per-turn tags.

Agent identity is evidence, never authority. Names, library rows, local agent rows,
archive state and presence do not prove ownership, membership or runtime state.

## Local agents

`LocalAgents` (`src/features/agents/local.ts`) is a read-only snapshot of the
viewer's live agents on this machine, in any community:
`{ status, agents: [{ pubkey, name, relayUrl, owner }] }`, with `status` one of
`unavailable`, `loading`, `ready` or `error`. `AgentsService.local()` produces it
from its saved identities (deleted ones omitted), so it carries Agents' own
loading and error state. Agents' `snapshot()` is different: it holds only the
selected community's agents, with their settings.

The source can also carry a separate `hosted` array of completed owned agents
shown in the selected community. These are DM eligibility evidence for
`agentChoices`, not local identities for name precedence or process control.

`app/services.ts` composes consumers before Agents exists, through
`createLocalAgents()`. Until `bind` connects `agents.local`, the snapshot is
`unavailable`; unbinding returns it there. Two consumers read it directly:

- the identity-name service, which lets a local agent's name win in its own
  community; and
- `session.agentChoices` (the communities service hands it to each session), which
  marks matching agents `managed`. New message and mention choices read that flag.

An agent in several communities has one row per community.
`sameCommunityAgents` keeps only rows whose `owner` is the viewer and whose
`relayUrl` maps to this session's community partition. Local agents carry no
process status, so a stopped agent is as selectable as a running one.

### Turns a close or reload stopped

Claude, Codex and goose (`AgentType.resumes`) run their turns in the page, so closing or
reloading the app stops them; the native host then sends no exit for them. The
runner keeps each mention turn working then in agent storage
(`buzz.agents.interrupted.v1:<pubkey>`) until it settles. On the next start Agents lists
those agents as `interrupted` and `InterruptedNotice` asks the owner: **Resume**
reads each mention again and gives it to `run` marked `resumed`, which tells the
agent to carry on in its saved session; **Don’t resume** forgets them. Either
answer covers only the agents the notice names, and only Resume gives those
mentions again: a replay or live delivery of one never does. A turn
stays saved until its resumed turn settles, so closing again first loses none.
goose sessions end with the app, so a resumed goose turn opens a new one and is
shown the mention's thread, including what it already posted there.
Mentions queued behind a working turn, watch turns and other types are not
kept.

### Saved Solo follow-ups

The queued rows above the Solo composer are unsent messages, separate from the
agent runner's interrupted turns. They are saved on this device in view storage,
partitioned by account and community. Text, recipients, uploaded attachments,
references, and model/effort choices survive a reload or app restart. An upload
still in progress has not yet entered this queue.

Restored rows remain paused with **Send** and **Remove** while the owner decides.
**Resume** also unpauses saved follow-ups in the chats whose interrupted requests
are being resumed. Each chat waits for those exact requests to settle, including
the read/startup gap, then sends one queued message per completed turn. An old
observer turn associated with the resumed request does not hold the queue forever;
fresh local completion is required. Uncertain or unreadable requests keep waiting.
If a type cannot resume or the relay confirms a request is gone, its saved follow-ups
return to paused; fresh follow-ups are not marked as restored, and other agents’ waits
remain intact. Resume does not establish channel admission: an incomplete empty roster
keeps saved rows until discovery or an explicit removal establishes their status. Incomplete recipient discovery
defers release until availability can be determined. A predecessor removed by another
window pauses only its successors when this window cannot establish its completion;
earlier rows continue draining. Automatic release rechecks saved FIFO order under a
chat-scoped lock. A durable handoff marker records the sent event and its confirmed completion,
including completion after Resume. Explicit dismissal or abandonment retires the
matching marker under the chat lock. A window-liveness Web Lock prevents a closed
window’s stale marker from pausing fresh rows. It survives removal of the sent row; a
window that cannot establish that predecessor's completion pauses its competing
rows for explicit Send rather than starting overlapping work. The paused rows explain that an earlier message was
handled in another window.
**Don’t resume** leaves the saved follow-ups paused. Other chats remain paused.
Every release rechecks membership and recipient availability. A failed save keeps the
composer draft; a failed removal keeps the row. Delivery transfers to the existing
Outbox only after its journal is durable. Once Outbox owns a message, Remove stays
disabled even if saving its recovery receipt fails; Send retries that same receipt.
Remove is disabled during an active handoff;
a per-row lock also prevents another window from removing it mid-send. If another window has begun sending,
reload to recover its original receipt rather than publishing a second message.
If a handoff was interrupted before a receipt was saved, the row remains available
for inspection; check the conversation before removing it and sending again.

## Shared agent selection

`session.agentChoices` is the canonical read-only selection projection. Mention
pickers, New message, Solo chat agent tagging, channel member invitations and
their admission checks use it, not `agentLibrary` directly. It combines two
sources, deduplicated by public key:

- `agentLibrary`, the display inventory (see [Community inventory](#community-inventory)):
  the host's saved Buzz library plus the owner's relay-published records; and
- the viewer's local agents for this exact community, flagged `managed` with a
  `managedName`.

The same app-owned source also supplies completed hosted agents shown in the
selected community, separately from local identities. The projection checks their
owner and community and gives hosted choices `messageable: true`. As with local
agents, archived identities remain in `identities`; `selectable` and each action's
existing archive policy govern forward-looking choices.
`canMessageAgent` accepts that flag or local `managed` evidence. Profile Message,
search, the DM picker and fresh-send validation use this predicate; hosted agents
never gain local custody or template-management status from it. Library presence
alone does not grant DM eligibility. Existing DMs can reopen without agent-control
evidence, through the normal relay-confirmed DM open.

A snapshot exposes `identities`, `selectable`, `archives`, `definitions`, `status`,
`pending`, `complete` and a separate `templates` projection. `status: ready` means
usable, not complete: automatic-recipient inference must honor `complete`, which
requires a ready, error-free library and a local source that is ready or
unavailable. A failed source contributes no stale candidates; another ready source
stays usable, with partial failures surfaced through Retry.

Do not build another agent inventory in a plugin. `useAgentChoices(session,
includeLegacy, archive)` retains the projection while mounted, which preserves
ready evidence across menu remounts, and ensures the lazy library and archive reads
on demand. Ordinary mentions subscribe without loading the library
(`includeLegacy` false); explicit Refresh retries source failures. The projection
adds no runner, polling, directory scan or signing authority, and session
retirement revokes its candidates.

`templates` serves saved channel-kit templates and project defaults (Solo chat setup
resolves lineups through it with `templateAgentChoices`). Its identities are the
local agents once Agents is bound, and the library only while the local source is
`unavailable`. It never falls back to the library after a local error.
`templateAgentChoices` returns nothing until archive evidence is ready, and
library-only choices additionally need visible community membership. Saved keys
are never rebound to a namesake.

Archive visibility has one owner. The projection reads `session.archives` and
exposes `identities` (every known agent, including archived ones, for facts about
existing content) and `selectable` (known-archived agents removed; unknown state
fails open; the viewer is never hidden). Every forward-looking agent chooser uses
`selectable`, including Solo chat agent tagging. Admission in
`channelWrites.addAgents` rejects every known-archived key it would add; unknown archive
state keeps the library rule. Selectors
demand the lazy archive read through `useAgentChoices(session, includeLegacy, true)`,
and the agent picker shows an archive read failure with Retry. The same base rule,
`archiveHides` (`features/relay/identity-archives.ts`), filters mention recipients,
channel member invitations and member addition, Solo chat sharing and search. Do not
reimplement the rule per surface.

Agent artwork also has one owner: `createAgentLibrary` publishes snapshots where
an identity without its own avatar shows its linked definition's avatar
(`inheritDefinitionAvatars`). Surfaces read `identity.avatar` and do not repeat
the lookup.

Action policy stays explicit: ordinary member mentions use the channel roster and
hide known-archived identities without requiring verified non-archived evidence.
In streams and forums, nonmember mentions also offer people from the selected
community directory and, when the viewer can add members, the viewer's own agents
(`managed` or not) that are not in the channel. Send asks before adding them; selection grants
no access. A pasted mention of a known profile is offered the same way. A DM can
name outsiders but never notifies them. Solo chat invitations keep their existing
rules, including library choices. Shared choice visibility is not permission to
grant access.

Regression source: `features/agents/choices.test.ts`, plus the chooser, composer
and Solo chat admission tests. They exercise shared selection and Solo chat admission,
not native execution.

## Exact channel-member mentions

The shared channel summary now exposes exact members from its existing verified
relay-authored kind-39002 roster, without a second directory or subscription.
The built-in **Mentions** feature always loads and offers **Mention a member** in
both channel and thread composers through the shared conversation tool contract.
It has no optional plugin catalog entry, and saved enablement flags are ignored.
The host retains recipient intent, inline editing and avatar removal even if the
chooser is unavailable because activation failed.
The picker shows keys alongside names (namesakes remain separate), reads optional
profiles only on demand, and keeps selected identity spans in scoped drafts.
Typing a name alone does not notify anyone. Plain Space after a unique exact name
selects its recipient; ambiguous names require Tab, Enter or click. While the
chooser is still waiting on members, names, agents or a directory search, Space
holds the name as a pending chip (a spinner in place of its `@`) and applies the
same rule once the evidence arrives, within 8 s, or returns it to prose; sending
waits for a pending chip, and when one it waited for returns to prose it keeps
the draft and says which name was not tagged and why (not confirmed as one
person or agent, not taggable here, the recipient limit or the message
length), so the next send sends the text knowingly. A name already known to
continue the query (`Mira Example` for `mira`) is a declined Space, not a
pending one, so the next word
can still complete it; a longer name learned only after the chip was held
extends the chip over the words typed after it when they spell one of those
names up to a name boundary, the longest they complete (`@mira Example hi`
tags `Mira Example`), and otherwise returns it to prose, where the reopened
chooser answers the rest of the name from the page already read for the chip
(a complete directory page settles every query extending its own, with no
further read), so the Space that completes the name selects it. Editing a
selected span removes its notification intent. Native beforeinput ranges preserve untouched spans; missing
range evidence, IME/history edits and collapsed deletions clear selections rather
than guess. Even a same-text replacement drops the edited identity. Selected mentions appear as inline identity chips in the composer. Namesakes
selected together receive visible key qualifiers; editing a selected span removes
its notification intent. Chips remain available without the Mentions chooser.

### Chooser rules

Two parts of the app decide who you can mention:

- **The Mentions feature decides what the chooser shows.** This covers both the
  toolbar picker and the inline `@` list: who is listed, in what order, and when
  Space picks a name (`src/bundled/mentions/`).
- **The composer decides who a message can address.** It checks every mention
  before it goes into the draft, whatever added it (`mention-admission.ts`). The
  feature lists only people that this check accepts.

The composer accepts these people:

| Where you write | Who you can mention |
| --- | --- |
| Channel or forum | Anyone. Before sending, the app asks what to do about people who are not in the channel. |
| DM | Anyone. People outside the DM are named but not notified. |
| Solo chat | Chat members, plus your agents (a send adds the tagged ones). |
| New DM, before it is created | Only the people you chose for the DM. |
| Archived or read-only channel | Nobody. |

Everywhere, the composer refuses invalid keys and people known to be archived.
You can always mention yourself. If archive state is unknown, the mention is
allowed.

A mention notifies a member. It does not promise that an agent will answer, and
choosing someone does not give them access or start an agent. In a one-to-one
DM with your own agent, it answers every message you send, mention or not; a
group DM still requires a mention.

Search trims and lowercases the query. Members precede nonmembers, with humans and agents in each group. Within each
group, matches against the visible resolved label come first: whole-name exact,
name prefix, whole-word exact, then word prefix. Base names and known aliases are
fallback matches in that same order. Only resolved names and real profile/agent
names are searchable. Public keys (including unnamed identity fallbacks) are not
completion matches. Arbitrary name substrings do not match. A hidden base-name match never
promotes a weaker visible-label match. When visible-label match quality ties,
base-name/alias match quality breaks the tie before recipient preferences.
Among equal matches, agents with profile-reported ownership by the viewer come
first, before humans and other agents. Agents that share a base name then form one
block, placed at the first of their case-insensitive displayed labels (including
disambiguating suffixes). Inside a block, explicit-choice recency, managed status,
and already-known online/away status decide the order. Humans never join a block
and sort first on an equal label. Remaining ties use the displayed label, then the
full key. Each rule is a per-choice sort key, so the order is the same for any
input order. Ownership comes
from profile owner metadata, not a name or presence in the library or local agents.
Recency stays in memory per session/destination and is bounded to 100 destinations
and 100 recipients each. Neither ownership nor recency overrides membership or
match quality.

An open query installs at most 50 keys. Their order and membership stay fixed until
the query changes or the chooser reopens. Labels, insertion names and availability
remain live. A removed/archived row stays disabled in place; Enter/Tab cannot fall
through to sending. A member who becomes an outside invitation choice also stays
disabled until reopening. Retry refreshes evidence, not the installed order. New
arrivals need a changed query or reopening. Pending sources or missing profiles do
not freeze a premature empty result. Local sources (members and agent choices)
establish the list; the community directory never gates it. Directory people
append below the rows already shown, so a late page never moves a visible row.
While a new query waits or loads, still-matching people from the last settled
page of the same chooser stay visible (one picker, or one inline `@` token; inline
completion remounts per keystroke, so the page is kept per session outside it) and the chooser shows "Searching community…". Uncached queries
reach the network only after a 300 ms typing pause, and only once
the query has at least two characters. Settled first pages are cached
per session and query (100 queries); errors are not cached, and Retry reads the
current query again. Chooser identity naming uses eligible candidates plus the
current draft recipients, not every cached profile. Composer chips name their
recipients among the destination's members plus the draft recipients.

Plain Space selects only a unique exact name/alias/label across the full uncapped
candidate set, and only if that identity is displayed and still eligible. A known
longer name beginning with that name plus a space prevents selection, unless it is
another name of that same identity. Partial names, ambiguous names, modified Space,
IME composition, code and protected literal ranges keep ordinary editing behavior. Selection rechecks available evidence and
stores only `{pubkey, name}`; qualifiers are presentation, not wire data. A Space
the chooser cannot decide yet, because its evidence is still loading, holds the
name as a pending chip that the plugin's headless resolver settles by the same
rule (`resolve-space-mention.ts`); a known longer name declines Space outright
rather than holding it, while one found after the chip was held extends the
chip over the typed words that complete it or returns it to prose; the host
admits the result like any selection, and a pending chip is never stored in a
draft or sent as a tag.

The composer rejects already-known archived recipients (never the viewer) at
send entry. The next draft keeps only agents that the sent message notified. This is not an archive transaction: archive
changes during enrollment, dispatch or retry are intentionally not covered. The
existing relay membership/send/retry validator is unchanged.

After an accepted send, the composer keeps the exact selected agent-name mentions,
deduplicated by key, as its next prefill. That prefill is not a draft: an empty
composer derives it from the agents your latest message in that conversation
notified, so a channel, the thread a message started, a DM or a Solo chat shows
the same prefill on every device, and nothing is saved until you type there.
Sending without the agent ends it. Removing the prefilled mention lasts until the
composer is shown again or your latest message there changes; a draft you have
typed is left as written.
Agent classification uses already-cached profile hints or the shared agent-choice
projection (library and local agents), not a new lookup or permission grant. Human recipients and
plain typed names are not carried forward. Once typed, the draft is an ordinary scoped draft:
channel/thread/account isolation, edits, removal, undo and delivery checks still apply.
**Settings → Buzz → Agent setup → Agent behavior → Remember mentioned agents** defaults on and is saved on this
device. Turning it off stops future prefills without changing the current draft;
turning it back on does not restore old recipients. Solo chat auto-recipient rules are
unchanged. An outbox rejection preserves the original draft; acceptance is not proof
of relay delivery or agent execution.

Team records in the channel kit (see [Channels](channels.md); groups, Canvas and
`buzz-channel-kit-v2` team manifests) appear in both mention choosers as shortcuts.
No bundled plugin writes team records now, so they appear only for records already
in the community. A team is a shortcut, not a group identity: explicit selection
inserts its saved agent keys as individual mentions in one undoable edit through
`insertMentions`. Names never resolve membership. Typing a team name or Space
alone does not select it. Team names also prevent Space from accidentally selecting
a person with the same name or a prefix. Each query shows at most 20 matching teams,
with up to four cached avatar thumbnails and a remainder count. Empty, oversized
(more than 32 agents), changed or partially unavailable teams stay disabled; there
is no partial expansion. Reopen or change the query to refresh changed team
choices. The resulting draft must fit the existing 32-mention and message-length
limits. Selection never adds members: ordinary channels retain invite-on-send
consent, DMs retain reference-only outsiders, and Solo chat admission remains
unchanged.

The picker supports Up/Down navigation, Enter selection and Escape dismissal.

`session.messages.send/reply` accepts up to 32 exact notification pubkeys and emits
deduplicated `p` tags. In ordinary channels, Send pauses for selected nonmembers:
**Invite** grants access only with permission and explicit consent, waits
for confirmed membership, then sends notifications. **Do nothing** (or **Send
anyway** without add permission) sends those identities as separate `mention`
reference tags, without adding or notifying them. Close or Escape keeps the draft. Existing member mentions still notify in a
mixed send. Reference keys are validated and bounded to 32. Selection itself never
invites or starts anyone; whether an agent answers a notification is up to its
own runtime. DM and Solo chat admission paths remain separate. Current notification-recipient membership is checked at
intent, before signing, and after signing before entering the transport publisher;
retry/restored signed intent uses the same publisher check. Before **each**
mention publication the session performs a bounded foreground finite read of this
channel's kind-39002 roster under the captured relay author. It never joins an
older in-flight read. Empty/failed/malformed evidence blocks dispatch; access,
connection and cache changes fence the read. A newer observed removal beats an
older response. Neither AUTH, route establishment nor the optional metadata-read
status substitutes for this preflight. Failed/capacity-limited live routes can use
the finite evidence while connected. One finite request per mention attempt is a
safety cost, not additional startup work or polling.

A first known local rejection is failed/unsent. Finite membership preparation runs
under the same outbox deadline but outside the dispatch phase: a timeout there is
unsent and starts no confirmation reads. The final synchronous scope/membership
check runs immediately before publisher entry, after all asynchronous preparation.
A blocked retry preserves prior
unknown/accepted delivery evidence and reports its retry error separately; the
first dispatched attempt may already have delivered. These checks are client UX safety,
not a substitute for relay authorization, a membership transaction, or the ACP
listener's own admission rules. Network changes after transport dispatch remain
possible. No ownership or running status is inferred from a member's name/profile.

Wire compatibility is kind 9 + `h` + exact `p` for notifications and `mention`
for reference-only identities; direct replies also carry
`["e", root, "", "reply"]`. Existing buzz-acp owns mention admission, replay,
channel membership, pool wake and harness execution. Mentions add no wake loop,
process launcher, configuration save or agent invitation operation. The library, local agents and archive display are not mention authorization.

Focused coverage: `mentions.test.ts`, `MessageComposer.test.tsx`,
`mention-draft.test.ts`, broker sign/publish integration and the real React journey
`tests/browser/mentions.spec.mjs` and `mention-edit.spec.mjs` (Chromium + WebKit,
fixture identities). `mentions-live.test.ts` exercises the actual subscription →
session → outbox path across reconnect, route failures, stale/failed preflight,
restore, optional name failure and unknown delivery. Live ACP
reply and packaged desktop acceptance are not established by these tests.

## Relay-scoped archive display

`session.archives` is a lazy NIP-IA snapshot capability, independent of
page/plugin lifetime. The dev broker passes `archiveAuthority` only when the
community's NIP-11 advertises a valid explicit `self`; the legacy contact `pubkey`
fallback continues to serve existing reads but cannot authenticate archive state.
The native transport passes the NIP-11 `self` it validated on connect; a transport
without an authority leaves this capability unavailable. No secret crosses the
browser boundary.

One fresh background read requests kind 13535 from that exact authority, limit 1.
The verified response must contain exactly one empty-content, protected snapshot
within 2 MiB. Missing/failed/malformed/oversized evidence is unknown, never an empty
active list. Invalid `p` keys are ignored and extra `p` elements have no semantics.
A successful snapshot replaces the entire list; newer timestamps / lower-id ties
win. A session-local ordering fence survives cache clear, without retaining old
archive contents; it is not persistent rollback protection across sessions/devices.
Access purge, disconnect, cache clear and disposal clear evidence and cancel work.
No startup request, periodic poll, event-union seeding or history filtering is added.

This is finite evidence, not a live archive directory.
As in base Buzz, mention autocomplete, the
mention picker and member-add omit archived identities: fail-open while the
snapshot is unknown, never hiding the viewer from themself, and never touching
history or channel membership. `not-archived` means absent from the read snapshot, not online,
owned, authorized or guaranteed current at a later write. Delta processing and
packaged/live acceptance remain separate.

`session.archives.request("archive" | "unarchive", pubkey)` sends exact 9035/9036
requests (`["-"]`, one `p`, optional `auth`) through the session's signer and
publisher (`identityArchive`), never the outbox writer. `consent` is the render and
pre-sign guard: it accepts only the target itself (NIP-IA self request, no `auth`),
a verified NIP-OA owner, or a relay owner/admin in the relay-signed 13534 roster;
the relay re-verifies consent. An owner request copies the target's single live
`auth` tag, verified against the target with `kind=` clauses ignored and
`created_at` bounds checked against the request time. Success requires a fresh
13535 re-read showing the new state; a publish with an unknown outcome is reconciled
by that re-read, and only a definitive relay rejection skips it. No profile pane
offers Archive or Unarchive now; the only caller is agent deletion.

**Delete agent** on Agents marks the agent's row `deleting` in the native agent
store and stops it, keeping its key. The cleanup (`AgentsService.cleanup`, shared
helpers in `features/agents/relay-removal.ts`) then runs:

1. An exact one-member 9001 (`h`, `p`, `client-id`) goes through the outbox for every
   unarchived channel whose relay-signed 39002 roster lists the agent, plus the
   viewer's loaded unarchived channels. Each channel's own fresh roster must then omit
   the agent. The relay refuses membership changes in an archived channel, so its
   roster keeps the deleted agent.
2. A fresh archive read runs; unless it already lists the identity, it is archived
   through the request path above when a consent path exists. An agent that never
   published an owner-attested profile has nothing to hide and is not archived.
3. The owner's agent record is deleted.
4. Only after every step is confirmed is the key erased and the row dropped.

If a step fails or the app quits partway, nothing is erased and nothing retries in
the background. The agent stays listed and stopped, including after a relaunch, with
a note in its settings that Delete didn't finish; pressing Delete again reruns the
whole cleanup. Rows deleted by older builds, whose key is already erased, only have
the owner's agent record deleted and the row dropped.

An agent in several communities leaves each of them this way, one at a time,
and its key is erased once none is left. Delete marks every row `deleting` with
one save to each of `identities.json` and `memberships.json` (below), so if the
app quits between them, some memberships are stopped while others still run
until Delete is pressed again. One whose community can't be reached stays
`deleting` there, and the Delete dialog names it. **Forget** then drops that
membership without reaching its community (`Agents.forget`), so the agent may stay
in that community's channels.

### Agents in several communities

One agent identity can be a member of several of the owner's communities, each
added by the owner. The native store keeps one row per (pubkey, relay); each row
has its own copy of the key and its own profile and picture. Name and type are the
agent's, so rename and retype change every row.

Everything this device keeps for one membership is keyed by its `AgentKey`
(`src/features/agents/membership.ts`): the bare pubkey in the agent's home
community, `pubkey@<encoded host>` elsewhere. The home is the first community the
agent was in. Native saves it on every row Add creates elsewhere (`home`), so every
copy of the app derives the same keys whichever rows remain; one Add creates back
in the home is the home row again. Those rows, and Adds not yet settled, are saved
apart, in `agents/memberships.json`; `agents/identities.json` stays the plain list, in the
fields older builds know, so they keep running each agent in its home and see none
of its other communities. While the agent has its home row, that row holds its
name and type, which older builds may change, and a row an older build imports
again where the agent was added takes the added row's place, without its home,
so the agent's activity there reads its home's sessions. An older build's
Delete or erase acts only on home rows: the agent stays in its other communities,
and an erase can drop `memberships.json` and leave those rows' keys in the
keychain. Keys from before multi-community agents are home keys, so nothing is
migrated. Each
membership has its own record (attention, timers, catch-up), runner (queues and
rate limits), interrupted turns and harness sessions. The agent's config lives only
in its home record and applies everywhere.

- **Import** (`Agents.join`, **Import an agent** in the unified import list)
  adds the agent to the selected community with the same key, name, type and settings. A picture
  in the source community's media is fetched there and uploaded here. Import writes a
  fresh kind 30177 record and unarchives the agent here. Native saves the new row
  as joining until its key is saved, so a crash in between leaves no membership
  without a key; adding it again, or Delete, finishes that row. A Join holds a
  lock across apps until its row and key are settled, which another app's import or
  key removal waits on.
- **Custody** is the agent's, shared by its runners in each community: their
  claims and releases run one at a time, and it is released only while none runs.
- **Delete** leaves every community, the one shown last and only once the others
  are done, so one it cannot reach keeps it listed here with Forget.
- **Remove from this community** (`Agents.leave`) runs Delete's cleanup in that
  community only and keeps the agent in its others. It is refused for the last
  community, which only Delete leaves. The membership's harness sessions and the
  agent's memory in that community stay, so they come back if it is added again;
  its attention there does not.
- **Teams** work like agents: a team shows in every community where it has a
  member (or in all of them while it has none), and a synced team always shows
  in its one home community. A local team is shared by every community; a
  member's roster lists only teammates in the same community, and the editor
  keeps members that are only elsewhere.
  Where the community's relay supports config channels, a new team, or one
  imported from old Buzz, is synced: its NIP-AP config channel (name and
  instructions) is created only in the community it was made in, and its members
  are the owner's agents in that channel. Until the relay's support is known,
  New team and Import are refused rather than made local. Adding an agent with
  no membership there is refused with "Add <agent> to <community> first"; the
  agent is never added to that community for you. A member running in any
  community takes the team's section from the home
  channel's last confirmed copy, and with none its start waits rather than use
  local fields. Changes and Delete (which archives the home channel) run online,
  one at a time per team, and report anything left part way. Existing local
  teams are not migrated.
- **Hosted agents** stay in one community, as their provider holds the key.
  Only a synced team homed there can have them as members, so the team editor
  offers them only for such a team, or for a new one that will sync there. One
  picked in a community Save doesn't put the team in, as when another is
  selected before a new team's first Save, is left off unless the team already
  has it. One picked where Save puts the team stays, shown checked, while that
  community's agent list is read again, but Save refuses it until the list is
  read, and refuses it once the list is read without it. Unchecking it leaves
  it off. They do not get its instructions, but rosters name them.
  Until the community's agent list is read, which tells hosted agents from
  ones on other devices, the team's roster there names each member not on this
  device by npub alone.

`removeRelayAgent` applies the same steps to a relay-only agent: archive when
consent exists, delete the owner's kind 30177 record (NIP-09), then remove it from
its channels on a best-effort basis.
Protocol source: old Buzz `b9392d9` `docs/nips/NIP-IA.md`, especially relay identity,
snapshot format and snapshot/delta consistency. Tests use the actual session and
HTTP broker/verified transport, including corrupted signature rejection.


## Agent Activity plugin

**Agent Activity** owns live observer demand and an avatar-and-dots bubble beneath
the exact message that triggered current work. It registers no panel. Multiple turns group by
agent; completing one turn does not hide another. Hover, click, tap or keyboard
opens a compact avatar-and-latest-tool popup. Its row, like the composer's working
indicator and the channel popover's **View activity**, opens that exact agent's
profile on its Activity tab (see [Profiles](profiles.md#agent-activity)). Escape
or outside click closes the popup. Human typing remains in the ordinary
conversation indicator.

### Local plugin-agent lifecycle

The popup resets on conversation changes and when current work ends. Idle and
past sessions remain in the agent's profile Activity tab rather
than lingering above the composer. Compact status labels omit raw arguments and
full paths; the transcript retains the detail.

While an agent this app runs works on a mention, the app publishes kind-20002
typing signed by the agent every three seconds through its HTTP event route, in
the mention's thread (in the channel itself for the owner's Solo chat), so
the owner's other devices and everyone else in the channel see it working. It
waits for the same Solo chat read as the turn, and shows nothing if the turn
cannot tell where to answer. It stops with the turn, after three refused pulses
in a row, or after 30 minutes; clients drop it when the agent replies or eight
seconds after the last pulse. On the device running the agent, activity replaces that typing.

Thread indicators consume the existing kind-20002 typing signal with the resolved
NIP-10 root, not inferred observer turn IDs. The existing per-channel live route
carries it; typing bypasses ordinary history, unread and persistent caches.
Only identities observed on the current live owner-visible feed are
recognized. Typing before that first frame, or without telemetry publication,
is deliberately omitted; public typing alone does not establish ownership.

Typing expires eight seconds after its signed timestamp (future clock skew is
capped at receipt), swept by the existing one-second activity timer. Messages
clear only the matching agent/channel/thread scope and suppress delayed typing
for two seconds. Disconnect, channel-route failure, disable, access/cache clear
and disposal drop typing evidence. A fresh observer frame does not refresh it.

The sidebar's quiet working dot has two independent sources. The plugin source
is fresh channel observer turns or the channel-scoped typing above, and follows
the plugin's lifecycle. Observer records have no thread identity, so its details
remain explicitly channel-wide.

The display-only source is `session.typing`, not the plugin's typing evidence:
typing by one of the viewer's own agents (`session.agentChoices`: local agents and
the library) anywhere in the channel, threads included. Typing remains a working signal when observer telemetry is explicitly disabled. Other people's agents, known only from a
self-declared profile hint, are not shown. This store keeps working with the plugin off, rejects
future timestamps instead of capping them, schedules its own expiry eight
seconds after the signed timestamp and stays quiet for two seconds after the
typer's message. It is display-only evidence, not ownership; the channel popover
still offers **View activity** for such an agent while the plugin is off.
A timeline thread summary shows the same dots from this source while one of the
viewer's agents types in that thread; before the first reply it offers **View thread**.
The visual working label is reduced to dots; its accessible name retains the status.
No harness change, new subscription, directory or timer is added.
The development broker loads subscription filters at startup: restart the
existing dev server once to receive typing; frontend HMR alone is insufficient.

### Transcript

`activityTranscript` (`src/features/agents/activity-transcript.ts`) is a
display projection over session-owned records, not a second store; the bubble's
latest-tool line uses it. It
reads allowlisted ACP fields into turns: the triggering prompt (author and content
from the `<buzz-event>` framing, other sections collapsed), the session's system
prompt, thoughts, assistant text as Markdown, tool calls, permission requests joined to
their tool call with the auto-approval outcome, plans, mode changes, the session's
selected config values (e.g. model), context usage, stop reason and errors. Tool
names and inputs differ by adapter (Pi, Goose, Codex, Claude), so tool rows show the
adapter's title and raw input as sent; only ACP's standard `kind` (icon), `status`,
`locations` and content (text, with a wholly fenced Markdown block shown as its body,
and `diff` as removed/added lines) are interpreted.
Adapter-specific `_meta` such as exit codes is not shown. The one adapter
special case: pi-acp repeats its `session/new` startup banner
(`_meta.piAcp.startupInfo`) as an agent message, which the transcript omits. JSON-RPC ids are matched per pool slot and
direction. Agent-elided strings and payloads are labeled, not hidden. Turns whose
`turn_started` frame is not loaded are marked as partial. Posted chat messages are
not joined here; the transcript shows the agent's ACP output.

The shared Claude, Goose, and Pi turn formatter encodes conversation history and
the triggering event as JSON with escaped markup delimiters. Message text,
display names, and tags therefore cannot create extra request sections. The
transcript reads that JSON directly and retains support for older line-based
`buzz-event` and `buzz-events` records; it never parses decoded message content
as another prompt.

The plugin's activation leases `session.agentActivity` for the live display;
disabling the plugin clears its live evidence. While demanded, the shared live
connection carries one dedicated owner (`#p=viewer`) route for kind 24200, with no
`#h` or history limit. Live activity starts at actual dispatch/retry. Display
resets renew that live-only route without replacing the socket or chat globals.
An uncertain control failure can reconnect the shared stream through its existing
bounded recovery path.

The native identity host and development broker validate signatures, exact tags,
recipient/key, freshness and size before host-only NIP-44 decryption. The renderer
receives purpose-bound DTOs, not keys or a general decrypt API. Relay admission,
not a name, local library entry or successful decryption, is the ownership
authority on the normal delivery path. These records never enter ordinary message
history, unread reconciliation or channel caches.

Live RAM is limited to 200 envelopes / 2 MiB plaintext and 512 turn states, with
visible trimming. Disable, cache/access reset and session replacement clear live
evidence. A batch with a recognized denied channel is hidden as a whole.

Activity frames (24200) and turn metrics (44200) are no longer saved locally or
restored after reload; plugin harnesses show history from their own session files.
The host archive store (`src-tauri/src/archive`, `browser-host/archive.mjs`) and
any existing `archive/events.sqlite3` remain until a follow-up removes them.

Working is fresh per-turn evidence, not process status. Batch children fold
individually; `session_resolved` is activity, while `turn_completed`, `turn_error`
and `agent_panic` end the agent/turn pair even with a null session ID. Silence
beyond 30 seconds or disconnect makes work unknown, not stopped. Terminal state
retains a monotonic evidence timestamp through clock rollback and bounded eviction.
There is no agent-global sequence gate: producer sequences reset, skip and interleave.

### Activity updates in the conversation

Conversation visibility is separate from execution status. Activity updates use
explicit immediate reply IDs and activity message IDs to select request lifecycle
evidence; a nearby human message or a shared thread root is not proof of a turn.
Consecutive updates from different requests or threads remain separate groups.
Known waiting, working, failed, or uncertain work stays visible even after a public
reply. Once every represented agent has settled successfully, stopped, or been
superseded, the updates leave the conversation flow. History and exact message
links remain available.

When lifecycle evidence is missing (including historical conversations after a
reload), the next public reply can retire older updates from the same request
if its author participated in the exchange or received the helper's last update.
This is a display fallback, not a claim that execution completed. It never
overrides available pending, failed, or uncertain lifecycle evidence. Durable
cross-host completion would require retained request/turn relationships and
terminal events; the current live-only feed does not provide that guarantee.

### Try with an existing owner account

Use the [public-pin/Keychain setup](contributing.md#live-relay-development) and run
`bin/just web` (or `bin/just desktop`). Open the printed Local URL, choose
the agent's community and open a channel. Keep a runner active for that agent, with
telemetry publication enabled, then give it work. This activity plugin does not
start agents. No records may mean publishing is off, no new traffic, or an
interrupted feed, not that an agent is idle.

Select an active agent above the channel or thread composer, or its bubble under
the triggering message: it opens the agent's profile on its Activity tab. Disable
the **Agent Activity** plugin in **Settings → Plugins → Manage plugins**, give the
agent work, then re-enable: the bubble and working indicator should return for new
work only.

The feed is best-effort telemetry: producers coalesce/batch and may elide oversized
content. It is not a complete ACP transcript.

### Coverage

`browser-host/agent-observer.test.mjs`, `browser-host/relay-broker-live.test.mjs`,
and the activity/live service tests cover signed/encrypted WS to host decode to SSE
to the actual session, route generations, terminal retention and stale controls.
`tests/browser/agent-activity.spec.mjs` covers the actual plugin, keyboard opening of each agent's profile and disable/re-enable in
Chromium and WebKit. These use ephemeral identities and synthetic telemetry.
Packaged GUI quit/relaunch, real-relay agent ownership admission and hosted
cross-platform checks are separate gates; consult the pull request for results
tied to its head.

## Shared identity names

Distinct agent keys with the same displayed name receive a short npub suffix,
regardless of their profile links. Names are compared after trimming outer
whitespace, with case preserved. Directory qualifiers use a middle-dot separator
(`Honey · 2abc`). Unique displayed names have no suffix. These display labels are
not serialized into mentions. The composer retains its existing inline-chip
qualifiers for selected namesakes, independently of live directory labels. Collision
checks include library identities and ready local agents in the current community.
Name edits update the suffixes; they never merge identities or profile groups.

The Identity Naming plugin (`buzz.identity-naming`) registers its policy with the
app-owned identity-name service (`features/identity-names`). Each relay session binds
its own view. A ready local agent takes precedence only in its matching community;
otherwise a signed public agent profile's name, then the library's saved name, then
the public profile. Synthetic profile-name placeholders are excluded from naming
and collision checks; caller fallbacks apply when no meaningful name is available.
With no policy registered, public-profile names and caller fallbacks apply.
These labels never change identity keys, membership, credentials,
or runtime admission. Messages, mention choices, activity, conversation labels and
new notifications consume this view. Mention parsing still uses signed identity
evidence before resolving its visible label. The portable policy is specified in
`src/bundled/identity-naming/README.md`.

## Sharing and exporting agents

An agent's card menu offers **Share** when its type has `exportShared`, the
inverse of `importShared`: the catalog `runtime` (`claude`, `codex`, `goose`,
`pi`), `provider` and `model` of its config. Instructions come from the type's
`carry`. `src/features/agents/agent-share.ts` builds one allowlisted definition
for both paths: name, instructions, runtime, provider, model and an HTTPS
picture without a query or fragment. Workspace, keys, environment, memory and
every other setting stay behind, and text that looks like a credential refuses
the share or export, as does a `configProblem`, which leaves the synced settings
and instructions out of `config`. Names and instructions must pass block/buzz's
`validate_agent_definition_text` rules (128-character names, 64 KiB
instructions, no control or invisible characters but those in emoji) on export
and on import.

**Share to catalog** publishes the owner's kind 30175 head with `d` set to the
agent's pubkey and `["shared","true"]`, replacing the head a strong read found
(`supersedes`). Its body names stock transport, `"acp_command": "buzz-acp"`, as
NIP-AP requires of shared heads. Turning it off republishes that head's content without the tag;
the relay then shows it only to its author, and Marketplace lists only shared
heads. An accepted publish can still lose to a newer head, and an unanswered one
may still land, so the dialog reads the head again before it reports success or
failure. The native signer and the development broker admit only this owner
envelope (`src-tauri/src/relay/catalog.rs`, `catalog-envelope.ts`). Delete,
and Remove from one community, unshare a shared head in each community the
agent leaves, before its kind 30177 record goes, and go on only once a fresh
read no longer finds it shared: nothing there lists the agent to unshare it
from afterwards, and a deleted agent can't be adopted. The outbox dates the
replacement past the head, so one dated ahead of this clock is replaced too.
While shared, **Update share** appears once the catalog body differs from what
the agent would share now, and publishes that, still shared.

**Export agent** saves `{name}.agent.png` or, by **File format**,
`{name}.agent.json` in the `buzz-agent-snapshot` version 1 format that block/buzz
and earlier Buzz write, without memory. The PNG is an 820×1230 agent card
(`src/features/agents/share-card.ts`): foil around the picture, the name, and
its harness and model, with the letter tile when the picture is missing, takes
over 5 seconds to load, or can't be read back, and a transparent pixel when no
card can be drawn. The manifest is in a `buzz_agent_snapshot` tEXt chunk.
Exporting the card previews it first and saves the bytes shown; sending the
agent uploads the same card. Desktop saves it
to Downloads through `file_download` (`src-tauri/src/relay.rs`), as media is
saved, since WKWebView cannot save a `blob:` link cleanly, and returns the
saved path, which the dialog shows. It takes only
`.agent.png` and `.agent.json` names, and a repeat export is saved as
`{name} (1).agent.png`.
**Import an agent** → **Choose file** reads `.agent.json` and `.agent.png`
(base64 manifest in a `buzz_agent_snapshot` tEXt chunk) from any of them,
refusing files over 5 MiB (JSON) or 10 MiB (PNG) before reading them, and opens
the Marketplace import dialog, which shows the instructions, so the copy is a
new agent with a new key.
Memory, an inline avatar, respond-to, parallelism and timeouts in an imported
file stay behind. Teams have no catalog or file export.

## Community inventory

`agentLibrary` is the display inventory behind `agentChoices`. Each session reads
the owner's kind-30175 profiles and kind-30177 identities from its accessible relay,
and also the host's saved Buzz library. The development broker's
`/api/relay/agent-library` reads `agents/identities.json` under the app data
directory, leaving out an agent that is only in communities it was added to, and
caps it at 8 MiB / 2000 records; the native host reads it and
`agents/memberships.json` through their owner, `AppAgents`. A missing store is an empty local
inventory; neither host falls back to retired stores. Deleted identities are
omitted and identities configured in multiple communities are joined by public key.
The host read is read-only: it writes no configuration, migrates no identities,
retrieves no credentials and manages no processes. Only identity
public key/name and optional avatar artwork leave the host. Optional artwork
accepts HTTPS without credentials or bounded raster data
URLs, never file URLs or SVG data.

The inventory joins exact public keys, not equal names; explicit profile references
use the publisher's slug mapping only when local definitions do not collide. Local
names and artwork win for matching keys. A failed source leaves the other source
visible with a warning. Reads are lazy (once per demand or Refresh), with no polling
or relay-directory startup scan.

Discovery is not global coverage, verified membership, credentials, or execution
status. No keys, config, memory, membership, or runtime state are changed by it.

### Model-menu design exception

The Harness defaults and Goose creation controls intentionally use the shared Menu
for family → model → effort navigation, as explicitly requested in product
review. This is a scoped exception to DESIGN.md's Select/Combobox form-value
guidance. Keep the selected model and effort accessible, preserve compact chip
appearance and truncation, and offer a trailing action to restore inheritance
without duplicating the current model as the first option. Provider selection
continues to use a searchable Combobox.

Provider dropdowns are intentionally text-only. The model control shows the
selected model family icon, not the Goose runtime or Databricks/provider mark,
as explicitly confirmed by the product owner. On agent cards the Goose mark
precedes it to name the harness, as Pi's card chip does, and the chip leaves
the thinking level and "Default" to its menu and accessible label so the model
name keeps its room. Goose device defaults have no reset action: omitting a
model in Goose retains its stored provider model.

### Databricks model names

Goose's Databricks providers list workspace endpoints (`databricks-*`,
`goose-*`) and Unity Catalog model services (`catalog.schema.model`). The
pickers show their model names, such as `GPT-6.1 Sol` for
`system.ai.gpt-6-1-sol`; endpoints without a known prefix keep their IDs. Models
whose names would read the same keep their IDs. Saved and requested models keep their
full IDs. An agent's one-line summary shows the ID.

`DATABRICKS_MODEL_FILTER`, read through goose's config (its environment
variable, else the same key in goose's `config.yaml`), narrows the listing of
`databricks` and `databricks_v2`: comma-separated patterns, each matched against
a whole ID, case-sensitively, with `*` for any characters and `?` for one, for
example `goose-*,acme_models.goose.*`. A listed model matching any
pattern stays listed. Without patterns, the provider's full listing stays,
which for `databricks` is still only its `databricks-` and `goose-` endpoints,
so a filter cannot widen it. A filter that matches nothing lists none. It only hides
models: a saved model the filter hides is kept, and its menu marks it as a
"Custom model" in pickers that accept one (profiles, cards, new agents) or an
"Unavailable model" in the Goose default model picker. Databricks still decides
access. Buzz does not pass its own `BUZZ_*` variables to goose, so the filter
uses goose's name.

## Usage

Usage is a default-off page summarising what the selected community's agents
on this computer spent: estimated cost against the previous period, tokens, cache
hit rate (cache reads over all prompt tokens: uncached input, cache reads and
cache writes), daily cost by agent
type, and the costliest sessions, each opening its thread.

It reads nothing itself. An agent type that can report usage implements the
optional, read-only `AgentType.usage(agent, { since, signal })`, returning a
snapshot of each session the agent ran from Buzz on this device with activity
since `since`. A snapshot carries the harness's session id, where in Buzz it
started, and one observation per model request: the harness's request id when it
records one, the time, the model, the token counts, and the cost only when the
harness recorded one, with the harness's word for how it got it. An absent count
is unknown, not zero; `input` excludes cache counts, and `cacheWrite1h` is the
subset of `cacheWrite` cached for an hour. Usage groups the observations into
days itself. Reading never starts, stops or changes a session.

A snapshot covers the session's descendants too, such as Claude Code and Codex
subagents, so a consumer never adds a child session again. It also carries:

- `revision`, an opaque digest that is equal for two reads that saw the same
  usage. It says whether a snapshot changed, not which is newer.
- `gaps`, what the read could not see, such as a subagent file that has since
  vanished or a finished line that is not JSON. A partial last line is still
  being written and is not a gap.

A consumer that keeps snapshots follows these rules:

- A snapshot without gaps replaces whatever it kept for that session.
- An incomplete snapshot leaves the previous one in place and reports the gap.
- A session missing from a later read is not deleted: its source may be gone,
  not its usage.
- `since` only bounds activity time. It is not a checkpoint, so it cannot find
  a correction a harness made to a session last active before it.

Until collected usage is persisted, Usage applies these rules to what it holds
while the page is open. An agent whose read fails keeps what earlier reads found.

Usage shows the last 7 or 30 days. It reads the last 30 days once for both, and
again only on Refresh or when the agents change. Thirty days is what Claude Code
keeps by default, and older history would undercount. Only the 7-day period is
compared with the one before it, because a 30-day comparison would need days
that were not read. The page marks costs as a best-effort estimate from the
session files on this computer, not a bill.

Claude implements it from the transcripts Claude Code keeps for the agent's
workspace: sessions whose first prompt names the agent, plus those this app saved
for it (prompts from before agents were named), with their subagents' requests.
Streamed responses repeat their usage on each line, so each request is counted
once.

Codex finds the agent's threads through app-server by the agent's name in their
thread names, keeps those whose rollout's developer instructions name the agent's
pubkey, and reads each rollout's per-response `token_usage_record` entries, adding
the subagent threads each one spawned. Codex records no cost.

Goose lists the agent's sessions in its workspace through `goose-acp`, as its
Activity tab does, and reads the usage goose saves on each reply, with goose's
own cost estimate where it has one. Both count a request's cached tokens in its
input, which the readers subtract.

All three read only the harness's own session history; none reads Buzz's saved
agent activity or turn metrics.

Where a harness recorded no cost, Usage estimates it from the token counts at the
provider's published API list prices, including a model's long-prompt rates and,
for a Claude model a provider prefixes such as `databricks-claude-sonnet-5-5`, the
Anthropic model's rates. The prices are the data `@pydantic/genai-prices` bundles,
loaded when the page first reads; they change with the package version, never at
run time. That may differ from what a subscription or provider bills. Totals add
only known values. A total is marked partial when an unknown count, a model
without known rates or an incomplete snapshot left something out, and
unavailable when nothing was known.
It is never priced at zero. Sessions count by activity time, whether or not they
recorded usage. Usage does not read or publish kind-44200 metrics.


## Attention subscriptions

Buzz owns Interests and generic event, timer and plugin-source subscriptions. Each subscription may have a delivery `channel` and optional thread `root`; without an address, it starts an independent turn for its Interest. Event `channels` selects where to listen, separately from the delivery address. Subscriptions for an Interest share its queue, and their prompt includes the Interest’s saved task instructions.

Use `watch_add` with `type: "source"`, a `provider` in `plugin/source` form and provider-owned `config`. Plugins register deterministic producers with `agents.addAttentionSource({ id, run })`. The host owns registration, scheduling, cancellation, completion and agent delivery; plugins own producer configuration and execution. Empty output starts no turn. Attention off, disabling or editing the subscription, losing the local agent, and provider unload cancel execution and queued output. After a source completes, its subscription remains until its final queued turn succeeds, then is removed. Failed deliveries retain the subscription and output. A retained completed source can be explicitly enabled again. Buffered output and accepted jobs are not durable acknowledgements.

Source output accepts the same optional classifier questions as event watches. Classification preserves output ordering and completion until the resulting delivery settles. `agents.attentionProviders()` lists active registered provider keys with their optional `description` and `configExample`, including providers from unrelated plugins. Disabled and unloaded registrations disappear from discovery.

The bundled Agents plugin owns the command producer and discovery tool. The GitHub plugin owns the GitHub PR producer. Saved provider IDs remain `attention/command` and `attention/github-pr`, and discovery marks them `builtIn: true`. The bundled Attention plugin owns the per-agent overview and controls for existing watches. The GitHub source uses the same PR parser and feedback policy as `github_watch_pr`; it requires the signed-in `gh` CLI. The tool configures Attention subscriptions rather than owning a separate polling loop. Other plugins can register their own source producers through the same lifecycle. Legacy Monitor command registrations and pending wakes are not imported; recreate needed command watches in Attention.

## Attention delivery destinations

Event watches and timers accept an optional delivery `channel` and thread `root`. The event watch's `channels` still selects where to listen: channels the agent is a member of, and public channels it has not joined (`all` hears those through catch-up, about every 30 seconds). A delivery address needs membership; the relay decides where the agent may post. Watches do not change who a mention wakes: a channel the owner's app hears only because a watch names it gives no mention turn, though the watch still hears its events. With an address, the wake continues that conversation with the Interest's instructions. A thread root must be readable by the agent in that destination channel; a missing or mismatched root stops delivery before the harness builds context. Claude, Codex, Goose and Pi accept these Attention triggers. A channel without a root defaults to channel-level posting, while explicit reporting instructions in the Interest can direct another thread or channel within the agent's existing authority. Solo chats retain their personal-chat framing and reply restriction. The address owns the execution conversation and default destination; the Interest owns explicit reporting policy.

Without an address, the subscription runs an independent turn in its Interest's lane. Timers retain their occurrence and expiry budgets. An addressed timer waits without spending an occurrence while destination membership is unconfirmed or absent. `watch_show` reports delivery as held or blocked with a reason; delivery resumes once membership is confirmed. Expiry still applies while held. Membership checks never join channels. The Attention panel shows listening channels separately from the delivery destination.

Event matches wait for confirmation of both listening and destination rosters. Confirmed destination nonmembership discards the match. Addressed wakes refresh the Interest instructions after harness startup and queue waits, immediately before submission, while retaining cancellation checks.

Conversation wakes are local, have no signed message to resume, and never publish their synthetic anchor ids. Pi saves an Attention wake's reply destination separately from its tool context so a recovered answer keeps its destination. Ordinary plugin wakes retain the separate contract above.

Subscription runtime history stays on this device, outside configuration: the last wake time and up to 40 lines (16 KiB) of source output. Missing history on an older subscription is unknown. A completed source or spent timer is removed after its final queued turn succeeds, including work handed to `workingUntil`. A failed source delivery retains the subscription and output.

## Commands using an agent's identity

An Attention source run receives `spawn(processId, { args, cwd, env, onStdout, onStderr })`. Buzz binds it to the watch's owning agent, destination and lifetime. Attention sources do not accept a caller-selected agent identity. The process must be declared in the calling plugin's `host.processes`, and the plugin must declare `host.mcp` (and `host.files` when its tools read local paths). The host retains process permission checks and signing keys. The bundled command helper initializes one MCP session, adds an agent-scoped `buzz` to PATH and passes that session to the command and its children. `buzz tools` lists tools; `buzz <tool> --field value` and `buzz call <tool> '<JSON object>'` invoke them. There is no owner-identity fallback.

Source return or failure, cancellation, Attention off, agent stop, plugin unload, command exit or closing the MCP transport revokes command access. Successful queued output remains valid after the source returns. Killing a command uses the existing host process group/job cleanup for descendants. OS access is the same as the app user's. Buzz owns batching, queue retries and final output draining for its built-in command sources. Other source plugins retain their own producer policies. See the [executable scheduled-source example](../tests/fixtures/agent-command/README.md), including the scope of its fixture-based custody evidence.

## Tools for the user's other local agents

A plugin can offer MCP tools to agents Buzz did not start, such as Claude Code, Codex, Pi or Nexus sessions. It serves a dedicated `host.serveMcp` server and declares the bundled helper as a process, for example `{ "id": "agent-access", "program": "buzz-agent-command", "bundled": true, "args": ["--advertise"] }`. `spawn("agent-access", { mcp: server })` lets the helper claim that server's one session and save it to `~/.buzz-foundation/agent-connections`, then exit. The plugin keeps the server open after the helper exits and spawns it once per server: a second spawn on the same server stops it. Every local agent of this user can then call that server's tools. On macOS and Linux the directory and files are private to the user and the helper ignores files others could have written; on Windows they rely on the profile's inherited permissions. The plugin handler must not assume a particular caller, and protected workers that must not reach these tools need that directory in `hiddenPaths`.

An agent runs the installed helper by absolute path, with no inherited connection, configuration or token: `/Applications/Buzz.app/Contents/Resources/bin/buzz-agent-command tools` on macOS (inside the app's installed name, such as `Buzz Foundation.app`), `…\bin\buzz-agent-command.exe` on Windows and `/usr/lib/Buzz Foundation/bin/buzz-agent-command` on Linux. `tools`, `<tool> --field value` and `call <tool> '<JSON object>'` behave as `buzz` does inside an agent command, and `--help` prints that usage with the path it was run as. The agent's own sandbox must allow loopback connections: Codex's read-only and workspace-write modes, for example, block them unless network access is enabled, and the helper then reports `Could not reach Buzz` and leaves the advertisement in place. The helper uses the newest advertised session that still answers and offers the tool, so a second Buzz window's tools are still reached; when two plugins offer the same tool name, the newer advertisement wins. A tool call stops asking older advertisements once it finds that session, so a stalled older server does not delay it; `tools` asks every advertisement. Before sending a saved session, the helper connects and confirms, by numeric user ID, that a process of this user has accepted that same connection (`lsof` on macOS, `/proc/net/tcp` on Linux), then sends the request on it. If that is not confirmed within about a second, as when another user's process holds a closed server's port, the server receives nothing and the advertisement stays. Windows does not support advertised sessions; the helper reports that instead. An advertisement lasts as long as its server. Closing the server, reloading the page, unloading the plugin or quitting Buzz ends it, and the next caller that asks it removes the file once its server refuses the connection or the session. An inherited `BUZZ_AGENT_CONNECTION` always takes precedence.

Native agent hook callbacks are described in [Agent hook callbacks](agent-tool-hooks.md).
