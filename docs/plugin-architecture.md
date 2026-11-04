# Plugin architecture

## Purpose

Buzz should make it practical for people and agents to build new product experiences with code. A designer should be able to build an experimental Channels page using real data and useful components, without implementing relay operations. A developer experience team should be able to add rich integrations to conversations without owning the surrounding application. And end customers of buzz should be able to extend the installed app dynamically, without having to contribute upstream or run the dev server.

Plugins are the unit of contribution and installation. They can contain substantial implementations: several components, their own layout and interactions, and multiple contributions. The foundation is ordinary React components, shared data and execution capabilities, and a small number of explicit extension points.

## The first two authoring experiences

**A page (target authoring experience).** A builder creates a plugin that registers
a page, reads shared channel views, and builds a new interface. They should be able
to reuse timeline/message components or build their own, owning the complete page
implementation and its behavior and appearance. Bundled source demonstrates this composition. The conversation preview
now supplies host Composer/Message through a generated type-only author entry;
broader supported external reuse remains an [author-contract gate](status.md#open-acceptance-and-product-gates).

**Rich conversation content.** An integration plugin recognizes a link to a GitHub pull request or a native Buzz object and supplies a panel showing that object. The Channels page decides where the panel appears. Another page can display the same content in a different arrangement.

Both experiences use real session capabilities. As AI integrations become available, authors should be able to consume those capabilities without rebuilding authentication, execution, or state handling. Agents is the app's only agent system; [shared agent selection](agents.md) gives other plugins the viewer's local agents and the known inventory through `session.agentChoices`, and mentions use current channel membership. Execution and credential handling stay blocked in the disposable editor.

## Ownership

| Area | Responsibility |
| --- | --- |
| Application host | Startup, plugin installation and activation, page navigation, persistent channel sidebar, Settings, and recovery. |
| Page plugin | Its complete React tree, local interaction state, internal navigation, and arrangement of panels. |
| Panel plugin | Recognizing a supported target and implementing the content and interactions for that target. |
| Shared capabilities | Session state, relay access, retained data, local agents, and eventually external connections. |
| Reusable UI components | Useful rendering and interaction behavior, configured through ordinary props. |
| Cordis | Dependency availability and resource lifetime across plugin activation, replacement, and disposal. |

Bundled and local plugins use the same contribution contracts. Within the source
tree, shared implementation code remains importable without another registration
layer; this is not a promise that external artifacts can import host source paths.

### Interface composition

Owning a React tree does not require inventing its visual system. Use the
[design guide's surface recipes](../src/shared/design-system/DESIGN.md#compose-the-whole-surface)
and [contribution ownership table](../src/shared/design-system/DESIGN.md#plugin-contribution-boundaries)
before building a page, panel, Settings contribution, dialog, or menu. Establish
which host supplies the outer surface, header, scrolling, and dismissal before
adding any of them. The Settings host renders contributed content directly;
registration metadata does not supply its content heading or group layout.

Source plugins reuse shared components; external artifacts use their supported
author contract and exposed roles. This is design guidance, not a new component
SDK or automatic conformance guarantee. Keep specialized layouts and product
behavior with the plugin, while preserving shared controls, states, and host
lifecycle. The [adoption review](design-system-adoption.md#composition-review)
distinguishes reusable examples from existing gaps.


## Code arrangement

```text
app/                    host, startup, navigation, Settings
plugins/                installation, lifecycle, contribution ownership
features/pages/         page contract and host rendering
features/panels/        target resolution, launcher contract and reusable card/frame
features/shortcuts/     in-app binding dispatch, focus rules and plugin ownership
features/relay/         shared channel data, queries, profiles and durable delivery
features/messages/      reusable timeline, message, thread and composer UI
features/channel-navigation/ persistent sidebar, scoped draft handoff, Channels routes
bundled/channels/       conversation navigation, page layout and panel placement
bundled/repos/          repository pages, issue/PR details and Git views
features/repos/        entity route/data contracts and bounded Git read bridge
bundled/agents/        Agents page and agent types (harness plugins register theirs)
features/agents/       Agents service: saved agents, creation, deletion
features/agents/        session-owned agent inventory, choices, local agents and activity
features/agent-harness/ Buzz base prompt, memory reads, attention prompts and wakes shared by harness plugins
bundled/github/         builtin GitHub panel plugin
bundled/bestie/         builtin Bestie page
bundled/inbox/          builtin Inbox page for unread conversations and mentions
```

The host composes the conversation sidebar (Solo and Team inventories) beside
independently mounted pages. Settings supplies its own modal navigation; a selected
page can replace the conversation sidebar through its optional `sidebar` contribution.
The conversation sidebar reuses session-owned roster, unread, creation and
preferences capabilities; it does not
retain a hidden Channels page or message reader. Sidebar and page render errors
have separate boundaries. A page sidebar is isolated by the same owned-contribution
boundary, so a failure falls back to a concise alert without taking down the page,
Settings, or shell. The host owns the slot, collapse state, labels, and narrow drawer;
the page owns its sidebar content and local interaction state. Sidebar presentation
helpers remain importable from `bundled/channels`; the conversation sidebar also
exposes a versioned section contribution for plugins.

Channels is the page-authoring example, not a thin registration wrapper over a
host-owned product page. Keep page-specific components, styles, interactions and tests
beside `bundled/channels/index.tsx`. New page plugins should do the same. At the
owner’s request, reusable conversation UI lives in `features/messages`: timeline,
message rows, thread panel, composer, delivery presentation and reading geometry.
Other source plugins can compose those components through ordinary props, with
internal session/destination isolation rather than caller-dependent remount keys.
Import shared capabilities through the existing relay and panel contracts; do not
create a second connection, cache or outbox inside a page. The conversation preview exposes only Composer/Message in a stable component bag;
source imports are not a versioned external SDK. See
[conversation component ownership](channels.md#reusing-conversation-ui).

## Open a Git import from a link

Open `buzz://plugin-install?repository=<encoded-repository>[&ref=<encoded-ref>][&path=<encoded-folder>][&commit=<hex>]`
to open a preview in **Settings > Plugins > Manage plugins > Add**. The repository
accepts HTTPS, `ssh://`, `git@host:path`, `github.com/owner/repo`, or `owner/repo`.
Omit `ref` to use the repository default. For example, on macOS:

```sh
open 'buzz://plugin-install?repository=https%3A%2F%2Fgithub.com%2FOWNER%2FPLUGIN.git&ref=main'
open 'buzz://plugin-install?repository=git%40github.com%3AOWNER%2FPLUGIN.git&ref=main'
open 'buzz://plugin-install?repository=OWNER%2FPLUGINS&path=plugins%2Fone&commit=0123456789abcdef0123456789abcdef01234567'
```

`path` names the plugin folder inside the repository. It is relative and
`/`-separated; absolute paths, `.` or `..` segments, empty segments, backslashes and
control characters make the link invalid, and an empty value or `.` means the
repository root. The review then offers only that folder instead of asking you to
choose, and refuses a repository with no plugin there.

`commit` is a full 40- or 64-digit hex commit. It pins the link the same way
`requestInstall` pins a plugin's request: the import refuses a reference whose tip is
any other commit, the review checks the fetched commit again, and nothing installs
unless it matches. A link that carries `path` or `commit` locks the repository and
reference fields, so Find retries the same pinned source. Each of `repository`, `ref`,
`path` and `commit` may appear once; a repeated key makes the link invalid.

The link fetches a preview through the existing importer. Review the plugin and
computer access, then select **Install plugin**. Opening the link does not install,
enable, or grant access. You can close the dialog while the preview loads. A late
result is discarded. Confirmed installation remains protected from dismissal.

SSH uses known hosts and, unless a [repository access rule](repository-access.md)
selects another agent, the desktop process's inherited `SSH_AUTH_SOCK`. The importer
disables SSH config and interactive prompts. If terminal Git uses an `IdentityAgent`,
add a rule with that socket, or launch Buzz with it as `SSH_AUTH_SOCK`.

A new installation completes identity setup before the app can show the linked
preview. For a repository hosted by a Buzz community, select that community and
wait for its relay connection before opening the link. Other repositories do not
require a selected community. See [OS deep links](deep-links.md).

## The `buzzodz` CLI

Run `pnpm buzzodz --help` from this repository, or install the standalone executable:

```sh
cargo install --locked --path crates/plugin-manager --bin buzzodz
buzzodz plugin init /tmp/my-page example.page "My page"
# Generate and pack the host-matched type-only preview once:
pnpm author:build
(cd dist-author && pnpm pack --pack-destination ..)
pnpm --dir /tmp/my-page add -D "$PWD/buzz-author-0.0.0-preview.1.tgz"
buzzodz plugin build /tmp/my-page
buzzodz plugin install /tmp/my-page/dist
buzzodz plugin enable example.page
buzzodz plugin list
```

The CLI prints readable results and reports errors with a nonzero exit code.
`disable`, `remove`, and
`rollback` take a plugin ID. New installs start disabled; updates preserve their
existing enabled state. `recover` backs up management settings and resets to
bundled defaults, preserving artifacts for reinstallation. `managed` prints the
[managed plugin policy](managed-plugins.md) and how each recommendation stands.
`access [URL]` prints the [repository access rules](repository-access.md) and, for a
URL, the rule, clone URL and agent socket a Git import would use.

`--home ABSOLUTE_PATH` and `--profile NAME` precede `plugin`. The desktop and CLI
also read `BUZZODZ_HOME` and `BUZZODZ_PROFILE` (default: `default`). Match these to
target the same instance. Otherwise, the desktop keeps profiles in its own
application-data folder (`xyz.block.buzz.desktop/profiles` for the installed app,
`xyz.block.buzz.desktop.dev/profiles` for development launches). A debug CLI
(`just cli`, `pnpm buzzodz`) defaults to the development folder and a release CLI
to the installed app's. A release CLI refuses while only the pre-1.0
`dev.local.buzz.foundation` folder exists; open Buzz once to move it, or pass
`--home`. A debug CLI likewise refuses before the first `just desktop` has copied
the installed app's storage into the development folder.

```sh
BUZZODZ_PROFILE=experiment just desktop
pnpm buzzodz --profile experiment plugin list
```

`BUZZODZ_SAFE_MODE=1 just desktop` opens the shell without external pages.
Bundled pages work on web; their enabled settings are stored in that browser.
Folder and Git/GitHub loading is available in **desktop Settings → Plugins → Manage plugins**.
Choose a folder, or enter an HTTPS/SSH repository URL and optional branch/tag;
then select a built plugin subfolder and install it. New installs are disabled;
updates retain their enabled state and may run immediately. Repositories must
include built `manifest.json` + `plugin.js` artifacts—Buzz never runs project builds
or install scripts. See [import behavior and limits](#loading-from-folders-and-repositories).
Browser installation is not supported; the browser shows a desktop-only explanation.
An organization can recommend plugin sources through a policy file next to the profile
folders; see [managed plugin sources](managed-plugins.md).

## Emoji and reusable conversation UI

Emoji and Mentions are built-in conversation features, always loaded by the app
and absent from the optional plugin catalog. Saved `buzz.emoji` and `buzz.mentions`
enablement flags are ignored. They reuse the contribution runtime for readiness
and cleanup, retaining their contribution keys. Emoji's picker, reactions, custom
rendering and Custom emoji Settings stay available; catalog, event tags and delivery stay
session-owned. The standard composer remains shared host UI, independent of any
example plugin. Automated tests use source-only external consumer and tool fixtures
to exercise component reuse and contribution lifecycle.

## Plugin module contract

`src/bundled/channels` is a bundled example. External projects have `manifest.json`
(`id`, `name`, `apiVersion: 1`, and optional `description`/`discovery`) and an entry
point exporting
`apply(ctx)`. `ctx` is a Cordis context. External JSX plugins export
`inject = ["react", "pages"]` and obtain `const React = ctx.react` inside `apply`, then call
`ctx.pages.register({ id, title, component })` to contribute a page. A plugin may register
several pages or none. Page IDs are unique within their plugin. Add `primary: true` for a
row in the sidebar's page navigation; every active page is listed in search. Buzz supplies React
and owns the Cordis runtime (`@deepseek-ai/cordis` 4.0.2). Import their types only
in external plugins; runtime imports are rejected by the scaffold's builder.

The scaffold uses classic JSX, so normal JSX compiles against the local `React`
variable. Components in other files can be created by a factory receiving that
same React instance. Automatic `react/jsx-runtime` imports are not supported by
the current standalone module format. Older plugins using `apply(ctx, host)` must
switch to the React injectable and rebuild.

Module evaluation must be pure. Enabled plugins activate even when their page is
not selected. Register plugin resources with `ctx.effect(() => cleanup)`; these
are disposed on disable, replacement, or app teardown. React effects belong to
the visible page and clean up when navigating away. Plugin activation must finish
within ten seconds, including waiting for required services. Losing a required
service hides the plugin's pages while Cordis waits and reactivates it; each
reactivation has a fresh ten-second deadline. Failed activation is shown in Settings;
disable/enable or install a new revision to retry. Replacement waits for prior
cleanup; if cleanup stalls, restart before that plugin can activate again.

The CLI scaffolds `src/index.tsx`, a standard `vite.config.ts`, and a `pnpm build`
script that type-checks and bundles the page. `buzzodz plugin build` runs that
script; Node/pnpm are only needed for authoring, not installing or loading pages.

API v1 distributes one self-contained JavaScript module; use inline styles or
existing host classes. Separate CSS/assets are not supported. Type-check an
external source project with `pnpm exec tsc` in that directory.

The host owns navigation, Settings, loading errors, and render error boundaries.
Settings controls and CLI management do not depend on plugin activation. Updates are detected while the app
is running. A selected page remounts when its revision changes; its local React
state resets. Plugin-specific persistent data has no host API yet.

Plugins are trusted code executing in the app's JavaScript context. They are not
sandboxed: infinite loops, global changes, and external side effects cannot be
contained or rolled back by a React error boundary. Restart selects the bundled page, but enabled external plugins still activate.
Use `BUZZODZ_SAFE_MODE=1` to pause external plugins for a launch if startup freezes.
This leaves the profile’s saved enabled settings unchanged. The CLI remains usable if the UI
freezes. Loaded JavaScript module revisions remain in memory until restart.

See [foundation status and open gates](status.md) for maintained decisions,
remaining acceptance work and historical evidence.

## Starting contracts

### Plugin installer

A plugin, such as a catalog or marketplace page, may ask the host to review a plugin
for installation. Read the optional `pluginInstaller` service with
`ctx.reflect.get("pluginInstaller")` instead of adding it to required `inject`; the
lookup returns `undefined` when an older host has not provided it.

```ts
type PluginInstaller = {
  requestInstall(source: {
    repository: string; // https://, ssh:// or scp-style git URL
    reference: string; // branch or tag
    path?: string; // relative folder inside the repository
    commit?: string; // 40- or 64-hex; install exactly this commit
  }): Promise<"installed" | "updated" | "cancelled" | "unavailable">;
};
```

`requestInstall` never installs silently. It opens Settings → Plugins with the Git
source prefilled and read-only, and the user still chooses **Find**, reviews the
existing access review, and confirms. The promise resolves with what the user did:
`installed`, `updated` (an installed plugin was replaced), or `cancelled` (the dialog
was closed, including after reviewing a plugin that was already current). It resolves
`unavailable` in the browser build, before plugin settings have loaded, when Settings
cannot open, while another request waits or any plugin review dialog is open, or when
the calling plugin has already been disabled or removed. It rejects for a source
outside the accepted grammar or a caller that is not an installed plugin.

The review shows "Opened from <plugin name> (<plugin id>)", taken from the calling
plugin's own manifest. It is a hint for the user, not proof of who asked: the access
review and the source shown are what the user approves. A request nobody claims in
Settings expires as `cancelled` after a minute, and any request is cancelled when
Settings closes, a `buzz://plugin-install` link replaces its review, or the requesting
plugin is disabled or removed, unless the user has already confirmed the install. A plugin that updates itself is replaced during that
install and still resolves `updated`.

A request can install a new plugin, or update an installed plugin only from the same
saved Git repository and folder. A plugin already installed from another source,
including a local folder or an unknown one, is refused with a message naming both
sources; remove it first to install it from the new one. Dismissing the review of a
plugin already at the requested revision resolves `cancelled`, because nothing was
installed. The folder source is hidden while a request is open. When `commit` is
given, the native Git import refuses a reference whose tip is any other commit, so a
branch that moves after a catalog review cannot install unreviewed code, and the
review checks the fetched commit again before offering to install.

### Conversation sidebar sections

A plugin may register a versioned `sidebarSections` contribution. Read it with
`ctx.reflect.get("sidebarSections")` instead of adding it to required `inject`;
the lookup returns `undefined` when an older host has not provided the capability. The host
renders its rows inside the existing Team sidebar using the same collapsible,
reorderable, resizable section frame as built-in
sections. It owns presentation and persists contributed section expansion and
relative order; a plugin supplies row data and actions, not another sidebar.

Each registration is owned by the plugin's Cordis scope and is removed on
disable, replacement, or teardown. Rows use an external-store snapshot and
subscription: return a stable immutable array until the data changes, then notify
listeners. `select` is a pure row-to-`OpenTarget` function used for both active
selection and opening the row. Optional
header actions are compact buttons; each has a stable id, accessible label,
icon, and callback. A render failure, including invalid rows, replaces only that
section with its unavailable state. Its Retry renders the current rows again.
Rejected row/header actions stay local to that section.

```tsx
import { createElement } from "react";

const rows = [{
  id: "today",
  label: "Today",
  count: 2,
}];
const listeners = new Set<() => void>();
ctx.reflect.get("sidebarSections")?.register({
  version: 1,
  id: "work",
  title: "Work",
  icon: "W",
  rows: {
    snapshot: () => rows,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  select: () => ({ version: 1, kind: "home" }),
  actions: [{
    id: "new",
    label: "New item",
    icon: createElement("span", { "aria-hidden": true }, "+"),
    onSelect: createItem,
  }],
});
```

A plugin exports `inject` and `apply(ctx)`. Pages register with
`ctx.pages.register({ id, title, layout?, companion?, primary?, placement?, icon?, component, sidebar? })`. Panels register with
`ctx.panels.register({ id, title, matches, order?, launcher?, toolbar?, component })`. An optional `toolbar` supplies live controls beside shell search in place of the static launcher. Its lifetime stays with its plugin, and shell render failures are isolated. Huddles is the first caller. IDs are local to the
plugin; the registry adds installation identity and revision and removes the
contribution when its Cordis scope ends. `primary: true` opts a page into shell
navigation. Its optional `placement` chooses `"sidebar"` (the default), `"topbar"`
(centered text destination), or `"toolbar"` (top-right full-page icon near search).
Pages without `primary: true` remain search/deep-link-only even with a placement.
The host owns ordering, active state, responsive overflow and navigation history;
plugins do not supply header React or a second navigation stack. Placement is fixed
for a registration's lifetime. An invalid value is dropped with a page-named warning,
falling back to the sidebar without failing activation. Older hosts ignore placement
and continue to show primary pages in their sidebar.

Harness plugins register an agent type with `ctx.agents.register`. Per-agent
configuration belongs in its `tabs`; the plugin that controls Attention shows the device switch. An optional
`provider` contribution exposes a stable readiness snapshot, subscription,
read-only `check()` and `DialogBody`. The Agents page supplies the Providers
health submenu plus provider title, registered icon, modal framing, dismissal,
focus restoration and error boundary. The plugin body supplies Connection and,
when supported, explicit-save Defaults sections. It also marks active install or
authentication work as blocking and supplies its cancellation control. Only
active registered types appear there; plugin activation remains owned by
Settings → Plugins → Manage plugins. Provider defaults are versioned device preferences, not
agent-record migrations; blank per-agent values inherit them.

An installed harness plugin gets the Buzz side of each turn from
`ctx.agents.harness`, as the bundled harnesses do it, and keeps its own
process, sessions and saved state. `conversation(delivery, scope)` admits a
mention or wake (undefined means the harness ignores it: not the owner's own
or attested by them, or with no conversation to go to) and freezes where
it goes. `systemPrompt` and `turnPrompt` give Buzz's prompts, `turnPrompt`
showing what the session has not seen and taking plugins' notes. Its
`cursor` is opaque: save it with the session and give it to the next
`turnPrompt`, which keeps a mark for each thread of a channel conversation.
`reply` posts as the agent there. `tools(agent, conversation, { read })`
answers the Buzz tools over MCP for `ctx.host.serveMcp`, so the manifest
declares `host.mcp`; `read` is the plugin's own file access (`host.files`),
which uploads of local files use. The kit grants nothing `ctx.agents` and
`ctx.host` do not already give the plugin.

A plugin, bundled or installed, can add a tab to the settings of agents
running on this device, whatever their type, with
`ctx.agents.registerTab({ id, title, component, when, subscribe })`. The component receives
`{ agent }`; it reads and saves through the plugin's own `ctx.agents`. An
optional `when(agent)` limits the tab to the agents it returns true for, and an
optional `subscribe(listener)` tells the host when `when` may answer
differently, so the tab appears or goes without a reload. A `when` that throws
hides only its own tab. The tab
follows Activity and precedes History and Settings, in the agent's Build view and
its profile panel, and is not offered for hosted or elsewhere agents. It is
removed when the plugin is turned off or its scope ends. The bundled Agent
Attention UI plugin uses it.

A plugin that shows Attention and its device switch calls
`ctx.agents.controlAttention()`. Installed plugins may call it too, and one that
does should show that switch. Agents' watches, timers and sources run on this
device only while such a plugin is on. With none on, every agent's
`attentionEnabled` reads false and each keeps its saved switch. Messages from
then wake no kind 9 watch later, even across a restart, though a relay replay
after a reconnect can still deliver one, as it can after the switch is off. While plugins are still
starting and none has shown Attention yet, kind 9 watches keep their catch-up
place, so startup still catches up on what the app missed while closed, and the
events an agent with its switch on would hear wait to be matched once startup
ends. Those are dropped for a kind 9 watch last seen with Attention hidden;
other watches keep no such record, so they still match them. The bundled Agent
Attention UI plugin calls it.

Protection plugins inject `ctx.agentProtection` to register checks and review
models and save native owner defaults or per-agent policies. An `AgentType`
declares `protection` / `protectionUnavailable` and retires native sessions with
`retire(key)`, where `key` is the membership key. Protected runs receive
`AgentHandle.protection`; missing providers or enforcement stop them. This
service shares the trusted-plugin authority described above, not a separate
plugin permission boundary. The [protection contract](agent-protection.md)
documents payload capture, missing-provider recovery and the explicit one-way
storage upgrade, which also affects agents shared with older installed builds.

A plugin, bundled or installed, can add a tool to every agent session in the
app with `ctx.agents.addTool({ name, description, inputSchema, call })`. `call`
gets the agent's Buzz client and where it is working, so the tool acts as the
agent, as the rest of a trusted plugin's code acts as its owner. Names are
lowercase and cannot be a Buzz tool's. The tool is removed when its plugin's
scope ends, so safe mode removes installed plugins' tools.

`ctx.agents.wake(pubkey, { channel, root?, text })` wakes an agent this copy of
the app runs in one of its conversations, as a mention there would, with no
message. `root` is the thread's root event id (64 hex); leave it out for a Solo
chat. The agent is told
the text comes from the plugin, not its owner, and is data, so quote what others
wrote (comments, check output) rather than phrasing it as instructions. It
throws when this copy does not run the agent or its queue is full. Claude, Codex and Goose accept plugin wakes; Pi ignores them. Attention delivery uses a separate internal `attention` trigger in the Interest lane, accepted by all four harnesses. Its Interest instructions retain their instruction framing, while observed messages remain data. A channel-only Attention address supplies a default posting destination and allows explicit thread replies outside Solo chats.

An agent type's `run` gets the agent's handle, which publishes, reads and
uploads as the agent. For agents that act on something other than a message,
such as a call, `ctx.agents.handle(pubkey)` returns the same handle outside any
run. It does so only for agents of the calling plugin's own types, while this
copy of the app runs them, their type is not changing and their community is
live; otherwise it returns `undefined`. A handle kept from earlier fails each
call while that no longer holds, and for good once the agent's type or its
plugin is replaced, so ask for it when acting rather than keeping it. Like any type whose agents run here, the type needs `run`.

Plugins can discover active Attention source registrations through `ctx.agents.attentionProviders()`. Each entry includes its `provider` key and optional `description` and JSON-object `configExample` supplied to `addAttentionSource`. The catalog omits executable callbacks and inactive registrations; discovery tools belong in external plugins.

A source may also `present` its watches on the Agent Attention page. Given a watch and its display name, it returns the watch's kind and, optionally, an icon, a target with a subtitle, an external link, and a details component that replaces the name in the expanded row. When a provider has no `present`, or it throws, Buzz shows the watch by its name. The GitHub plugin presents pull request watches this way, linking to its comment author settings.

Each Attention source `run` receives `spawn(processId, options)` for commands using that watch's owning agent. The host binds agent identity, watch destination and run lifetime; plugins cannot select another agent or obtain the raw authenticated connection. Declare the process in `host.processes` and request `host.mcp`, plus `host.files` for tools reading local paths. Options supply arguments, working directory, environment and output callbacks.

Buzz revokes command access on return, failure, cancellation, agent stop, provider unload or community reconnection, and closes the process and its descendants. Successfully emitted output remains queued after a producer returns. The key and MCP connection stay in Buzz; commands retain the app user's operating-system privileges and can use the agent's tools while their run remains active.

```ts
ctx.pages.register({
  id: "dashboard",
  title: "Dashboard",
  primary: true,
  placement: "toolbar",
  component: Dashboard,
});
```

A page may replace the conversation sidebar while selected. Its component receives
the current read-only `OpenTarget` and, when present, shell-generated primary
Pages navigation as `children`. It supplies only its sidebar contents within the
existing sidebar slot. The host places the contribution and its unavailable
fallback in the same resizable track as the conversation sidebar. Both use one
saved width per community and viewer workspace, with a 260px default, 220px
minimum, 520px maximum, and the shell's existing available-width clamp. The host
owns the resize handle, keyboard controls, reset, and persistence; switching
between Messages and a page sidebar preserves that shared width. Wrap the content
in the existing `shell-sidebar-default` layout role so it fills the host track.
That role does not provide an inner surface, frame, padding, or content layout;
the contributor owns those details.
External authors use this CSS role and their own markup; internal source components
such as `SidebarFrame` are not part of the author SDK. The host owns the slot and
collapse/drawer interaction. Pages do not manage a separate sidebar width
preference, receive navigation completion authority, or own routing. On wide
layouts the shell keeps its generic Show/Hide sidebar toggle; on narrow layouts the existing
Show/Hide navigation drawer, focus handoff, Escape, inert, and ARIA behavior remain
shell-owned. Pages without `sidebar` continue to
use the conversation sidebar. The host isolates sidebar rendering with
`OwnedContribution`; a throwing sidebar shows a concise alert with scrollable page
navigation inside the standard fallback frame while the selected page and shell
remain usable. A new page navigation request retries a failed sidebar without
remounting healthy sidebar state. The sidebar shares the page's admitted workspace
target and stays mounted beneath Settings; invalid destinations are not delivered
to it.

```tsx
import type { PageSidebarProps } from "@buzz/author";

function ActivitySidebar({ target, children }: PageSidebarProps) {
  return (
    <div className="shell-sidebar-default">
      <aside className="activity-sidebar" aria-label="Activity sidebar">
        <header>Activity</header>
        <p>Current destination: {target.kind}</p>
        {children}
      </aside>
    </div>
  );
}

ctx.pages.register({
  id: "activity",
  title: "Activity",
  component: ActivityPage,
  sidebar: ActivitySidebar,
});
```

Header entries move into the labelled More pages popover when they cannot fit,
including at narrow widths. Toolbar and overflow entries use native-button
navigation and `aria-current`, not companion-panel toggles. The wide topbar uses
shared chrome tabs linked to retained page panels; manual selection leaves focus
on the tab and suppresses destination autofocus. Every active page remains
searchable, regardless of its placement.

A primary page may also supply `badge`, a component the shell renders at the end
of its navigation row, such as a count of due items. The plugin owns its data and
re-rendering; the shell owns the row and placement. A badge that throws renders
nothing and leaves navigation usable. Toolbar badges are clipped to a compact
2rem × 1rem corner mark; authors should use short counts or dots there, not rich
content. The overflow popover uses ordinary labelled rows with trailing badges.
Pages without `primary` have no navigation entry, so their badge is not shown.

`notifications.register({ id, label })` adds a category with its own switch in
Settings and returns `submit({ sourceKey, target, title?, body? })`. Submissions
share the host's permission, preference, duplicate and click handling. The host
owns display text: `title` and `body` are flattened to plain text and bounded the
same way message alerts are (`title` to 128 characters; `body` as Markdown prose
to 200), so a plugin cannot send raw markup or unlimited text to the OS. Without
them the banner reads `Buzz` / `New <label>`. The host applies no age limit to
plugin submissions; the plugin decides what is still worth announcing.

A page may supply `icon`, a `data:image/<subtype>[;params],<payload>` URL; the
scheme and type match case-insensitively. Search Buzz and the page navigation
render it as a decorative image, with the generic icon when it is absent or fails
to load. An SVG that paints with `currentColor` is drawn as a mask in the text
colour, so a monochrome glyph follows the theme and hover and selected states
like the host's icons; any other image keeps its own colours. Registration drops any other value with one console warning that names
the page; the page still registers and opens. Bundled pages keep their host icons.
External plugins ship no separate assets, so inline the art into `plugin.js`, for
example with a bundler `?inline` import.

A page calls `panels.resolve(target)` and renders `PanelView` with the resulting
contribution, the target string, and a close callback. Among active panels whose
matcher accepts the target, the lowest `order` wins; a throwing matcher is
skipped. Panels receive `{ target, close }` plus
optional host context. A conversation host may supply
`context: { channelId, canOpen, open }` for contextual panel-to-panel actions.
`canOpen` is advisory active-target availability; `open` re-resolves at click time
and returns false after the originating opening, channel, session or host
presentation retires. This is not a global navigation API or an access grant.
A tab's `open` replaces that tab; a channel drawer or side-column panel's `open`
opens the target as a new tab.

### Huddle status

While native Huddles is available and active, it provides an optional
read-only `huddleStatus` service with this document's call phase, so a plugin
such as a music player can pause for a call. Read it with
`ctx.inject(["huddleStatus"], (scope) => …)` instead of adding it to required
`inject`. The callback runs only while Huddles provides the service, and its
scope is disposed when Huddles unloads. External plugins declare the
structural type themselves.

```ts
type HuddleStatus = {
  version: 1;
  phase():
    | "idle" | "incoming" | "connecting" | "connected" | "leaving" | "error";
  subscribe(listener: () => void): () => void; // returns unsubscribe
};
```

The phase belongs to this window's call, not to the viewer's identity, so a
call on another device never appears here. `connecting` begins before the
microphone prompt. `leaving` covers call teardown; a teardown failure moves to
`error`, so the end of `leaving` does not by itself prove the native call closed.
`subscribe` also fires for changes other than the phase, such as speaking
levels, so compare `phase()` with the last value seen. The service exposes no
destination, roster, audio or controls.

### Opening targets from channel plugins

Every plugin surface in a channel or thread can open a target, such as a panel
URL, with the same `canOpen(target)` / `open(target)` pair (`TargetOpener`):
panels (`context`), channel-header launchers, composer tools and accessories,
message renderers, message ⋯ action components, attachment renderers and inline
renderers. The conversation host decides placement: in Channels a panel target
opens as a side-pane tab, as if the user clicked a link to it in that message or
composer. `canOpen` is presentation only. `open` re-resolves at click time and
returns false outside a conversation host, after the contribution is removed or
after its mount retires. Link renderers keep host-owned link activation;
reaction choosers and message markers get no opener.

### Resolution order

Panels, link renderers and attachment renderers (`registerAttachment`) share
one rule when several match the same target; for an attachment renderer the
target is the `Attachment`, and an `order` function receives it. Message
renderers (`registerMessage`, rendered by `MessageBody`) keep first-active-match
semantics and accept no `order`.
`order` is optional and defaults to `0`; lower wins, and equal orders fall to
ascending contribution key (`pluginId/contributionId`), so activation, load
latency and disable/re-enable never decide the winner. `matches` stays boolean,
so `canOpen` is unchanged. Three bands by convention:

| Band | Meaning |
| --- | --- |
| `-10` | Specialises a target another plugin already handles (a richer GitHub PR view). |
| `0` | Default: the plugin is specific to the targets it matches (GitHub, Activity). |
| `100` | Catch-all or fallback: anything under a scheme or host (a website panel, a globe icon). |

Bundled catch-alls declare `100` themselves, so a third-party plugin specific to
one service wins at the default without knowing the convention. A static number
covers a plugin that is uniformly broad or specific. A plugin whose matcher already
knows which class it hit can instead supply a function, evaluated per target; a
throwing or non-finite result counts as `0`:

```ts
ctx.panels.register({
  id: "docs",
  title: "Docs",
  matches: (target) => target.startsWith("https://docs.google.com/"),
  // Previews Docs natively; embeds anything else under the host as a fallback.
  order: (target) => (/\/document\//.test(target) ? 0 : 100),
  component: DocsPanel,
});
```

Same-band overlaps between two plugins that both consider themselves specific are
not arbitrated; the key decides. Register a separate contribution per band when
one plugin needs different titles for its specific and fallback views.
Channel-header launchers use the separate public `channelContext` metadata
contract described below; launcher/fallback panels need not have either context.
A plugin that needs shared data declares `relay` in its
injection list and passes those capabilities to its components using a closure,
just as the bundled Channels page does. The conversation preview adds only the two demonstrated component surfaces.

Channels owns its selected channel and docked target. The panel view isolates
render failures and remounts on target or revision changes. Unloading a plugin
removes its contributions and closes its panel. Other pages can use these same
contracts with their own layout and local navigation.

### Bundled defaults

**Channels is the only required bundled plugin.** Bestie,
Todos, Usage, Reminders and Workflows are off by default for fresh installs. Feedback, Diff viewer, Identity
Naming, Agent Activity, Terminal, Links, GitHub, Inbox,
Repositories, Agents, Claude, Codex, Builderlab,
Membership, and Moderation are on by default, but optional. Both browser and
native catalogs declare that policy.

Solo is part of Channels, not a plugin: Solo chats are channels opened in
Messages, and Solo drafts are a Messages route. Channels requests topbar
placement and the shell presents it as Messages, the startup destination.
Saved `buzz.me` and `buzz.sessions` flags are ignored like any uninstalled owner.

Saved enabled/disabled flags win over defaults (except required Channels).
Both storage owners persist resolved bundled states. Native default snapshots
are best effort: a failed write keeps the readable catalog usable and is retried
on the next read; explicit edits and resets still report write failures.
Existing profiles without saved Reminders or Workflows choices retain
their former On state; fresh profiles start both Off. Reopening preserves either
result, and an explicit reset uses current defaults. Future default-off changes
must follow [the fresh-install decision](plugin-defaults.md), including legacy
backfills for releases without saved states.
Default-on does not promise platform support: Terminal contributes UI
only on macOS/Linux desktop; Builderlab's hosted communities need either the desktop app or
the live development broker. Disabling Membership removes its Invite to community shortcut.

Membership and Moderation share app-owned access controllers composed in
`app/services.ts` (`bundled/admin-access.ts`). Their navigation entries and the
Plugins catalog use the same verified roster or native staff probe, including
while either plugin is disabled. The catalog leaves details readable, gates only
Enable on current access, and always permits Disable. Access status remains
visible while enabled; navigation and administrative actions require verified
authority. Restoring default-on needs no migration; explicit Off remains saved.
These UI checks do not grant permissions; relay and native enforcement still apply.

Repositories is enabled by default and owns versioned, validated repository, PR
and issue page routes. Its page is absent from primary navigation. It resolves
signed metadata through the session reader and reports navigation completion only
after destination content is presented. Git browsing uses a narrow host-owned,
authenticated Git capability in the native host and development broker; plugins cannot choose a signer or
remote URL. See [entity links and limits](deep-links.md).
GitHub recognizes repository,
pull request, issue, and commit URLs and loads object details on demand. Its
manifest declares `gh api graphql --hostname github.com --input -` as a host
process, so on desktop it reads and changes pull requests as the user's
signed-in `gh` account. That allows any query or mutation the account may make;
the token stays inside `gh`. Without `gh` it reads public data only. Unsupported
URLs retain ordinary link behavior. A host-owned GitHub connection with narrower scopes, and agent
execution, remain future shared capabilities.

### Optional channel menu panels

A panel can register `channelMenu: { label, eligible(channel, session) }` for
placement in Channels → Channel actions. Channels owns the menu, selected channel,
tab geometry, focus, and close behavior; it opens the **exact active contribution**
without resolving a target matcher. Eligibility is evaluated again at activation
against the current connected session, selected non-cached channel and membership.
Disabling or replacing a plugin retires its open tab; a channel change or loss of
eligibility closes it and unmounts its archive reader. `eligible` also decides
archived-channel availability; exclude `channel.archived` if the panel writes.
Re-enabling never reopens a
stale tab. Eligibility and `channelContext` are presentation, **not authority**:
the panel must independently verify access before reading any sensitive data and
fence asynchronous reads on revocation. Channels registers **View canvas** this
way. Canvas has no separate plugin toggle; Solo,
Todos, and agents use the same session capability. Its editor keeps the channel's
draft locally, so reopening after a channel change restores it. Members of archived
channels can read Canvas and History, but cannot edit, save, or restore through the panel.
A retained unpublished draft is labeled as local; History shows the saved versions.

### Settings cards

`ctx.settingsCards.register({ id, title, icon, component })` contributes a Settings
destination under the selected community. Adding `group` places it under that
labelled navigation group instead; the existing `"App"` group appears as **Buzz**.
Adding `personal: true` also lists a community card under **Personal space**, for
cards such as Pair mobile that collect their own community address; it cannot be
combined with `group` or `section`.
Its section id is the contribution key (`plugin/card`) and disappears with the plugin. The optional `icon`
uses the shared design-system icon gateway; the host supplies a fallback when omitted.
Cards receive `active()` and use ordinary
session capabilities through injection. Host boundaries isolate rendering errors;
exact registration identity and mounted lifetime revoke callbacks on removal.

The channel template extension point (`ctx.channelTemplates`) was removed with the
v1 Agents system. The host sidebar owns channel groups and the existing + creation
buttons. Channel templates are now device-local (`buzz.channel-templates.v1`,
`features/channel-templates/local.ts`): a name, agent pubkeys, Agents team ids
and a starting Canvas, managed under Settings → Buzz → Channel templates. Picking one in
Create resolves its agents and its teams' members to those that are the owner's
agents in this community and sends them with the Canvas as ordinary channel setup,
which the session applies and retries as before.

Hosted communities are part of the Block-specific Builderlab plugin
(`block.builderlab`, `communities/`), shown under Settings → Plugins → Builderlab
beside remote agents. They manage Block-hosted relays through the plugin's one
Builderlab sign-in: binding the local Buzz identity (a locally signed kind
24243 challenge), and create/archive/unarchive/transfer. A server-declared,
default-off capability also exposes owner deletion for archived communities. The
card persists the bound four-field request before admission. A fresh request can
terminate on a known structured pre-admission code and HTTP status pair;
ambiguous first responses stay pending until an explicit same-UUID delete replay.
Only a tuple-bound non-aborted 202 confirms progress; an aborted 202 ends recovery
without claiming deletion. The card displays valid server quota when available;
without it, Create remains available and the server enforces its owner limit.
`can_create: false` alone disables Create; usage is informational and is never
estimated from visible rows. One origin-wide pending slot is
re-read and verified before dispatch; browser local storage has no atomic compare-and-set,
so exactly simultaneous contexts remain a documented client-side race;
it never signs deletion or infers acceptance from a missing list row. Joining
stays in the existing Join a community dialog; the card only copies the new relay address. Its
account backend follows the same split as `HostService`: live development with a
pinned viewer uses the broker's `/api/builderlab/*` routes (`browser-host/builderlab.mjs`),
which keep their own session credential and signing key in Node. Desktop builds use
`native.ts`, the same routes with the plugin's shared session credential, host HTTP to
the configured `BUZZ_BUILDERLAB_URL` grant, and `identity_sign_builderlab_binding`, which
validates the challenge and signs only the fixed kind 24243 binding. They read the
account after sign-in's automatic identity link settles. The desktop credential lives in
plugin memory for the plugin's lifetime and is never persisted, so restarting the app
signs out. Builds without a configured Builderlab URL show the unavailable notice.

### Composer accessories

`ctx.conversation.registerAccessory({ id, title, order?, component })` contributes
read-only contextual UI above the shared composer. The host passes
`{ session, scope, channelId, threadRootId?, canOpen, open }`: no editor commands,
new socket, or implied access grant. Channels supplies target resolution and panel
placement; other composer consumers can omit navigation and return unavailable.
The shared renderer owns deterministic order, error isolation and command
revocation on removal/unmount. Composer destination keys fence session/channel/
thread changes. The accessory remains usable on read-only connections.

Message-placed accessories may opt into `decoratesMessageSummary`. The first
ordered decorator receives the optional `renderMessageSummary(activity?)` hook;
other accessories do not. The host retains reply counts, participant identity,
unread state, and thread navigation. The decorator supplies its activity identities,
inline status content, accessible label and trigger ref, allowing its existing
popover to wrap the host button. It renders the ordinary summary when idle.
When no decorator is registered, or it fails, the host renders the ordinary summary.
This presentation hook grants no additional data or navigation permissions.

Agent Activity is the first consumer. Plugin activation owns its telemetry lease;
multiple composers subscribe to the same session capability. No global selected
channel or activity-specific dependency is added to reusable message components.
The persistent sidebar reads the same session activity snapshot for its quiet marker;
it owns presentation, not capture or an additional activity lease.
This is a host-matched preview addition, not cross-version capability negotiation.

### Channel-header launchers

A panel may additionally contribute `channelLauncher: ComponentType<ChannelLauncherProps>`.
Channels renders these in its conversation header with public `context`, `pressed`,
`available()`, `toggle(target)` and the channel's `canOpen`/`open`. The page owns one selected channel panel, placed
in the bottom drawer by default or the existing companion column when the contribution
sets `channelPlacement: "side"`. With `channelPlacement: "tab"` the launcher instead
opens one tab per channel in the side pane, grouped with thread and other panel tabs;
a new target replaces that tab, and a link tab already open for the target becomes it.
The tab receives `PanelProps.context` too, so it can open or push further tabs. A launcher
selects its **exact active contribution**, not target matching. `available()` and
`toggle()` are revoked when the mounted context or contribution is retired. Optional
`PanelProps.channelContext` carries the current displayed public context to a channel
panel; ordinary link/host panels do not supply it. It is presentation metadata, not
signing authority. Plugins decide when to capture it into their own work.

A tab a link opens is a transient detail: the next link or thread replaces it. A panel
that sets `keepOpen: true` keeps each target it opens from links as its own tab until
the viewer closes it, as a launcher's tab is kept.

A panel may set `deferUntilShown: true` to mount tab content on its first selection
in a workspace visit, then retain it for that visit. The default remains eager.
Component-provided titles (`usePanelTabTitle`) and local detail tabs (`PanelLocalTab`)
are also deferred; opt in when the contribution's static title is sufficient until
selection.

Channels keeps layout and channel/thread selection. The Terminal plugin binds its
mounted launcher into the existing shortcut dispatcher, and owns sessions separately
from drawer mounts. No global selected-channel store, extra shortcut listener or
host companion change is required. Disabling/replacing a contribution closes its
drawer, and re-enabling starts closed. See [Terminal](terminal.md) for native support,
session behavior and validation limits. This is a host-matched preview addition,
not cross-version capability negotiation.

### Optional Canvas todos

Todos (`buzz.todos`) is bundled **off by default** in browser and desktop. Enable
it under Settings → Plugins → Manage plugins. Its channel-header ListChecks button opens a right-hand
side panel, grouping items as To do, In progress and Done, with add, a per-item status
selector, check/uncheck, one optional assignee per item, automatic
saving after each action, and explicit Refresh. It uses shared controls and theme
tokens; Channels still owns panel geometry, responsive placement and selection. Terminal remains in the bottom drawer.

The source of truth is ordinary Markdown in one root level-two `Todos` section:

```markdown
## Todos

- [ ] Review the plan
- [/] Build the preview
- [x] Share the preview
```

`[/]` marks Doing, the common Markdown convention for an in-progress task;
ordinary Markdown renders it as plain text. Canvases without it keep their
existing meaning: `[ ]` is To do and `[x]`/`[X]` is Done.

Unordered checkbox items in that section are shown, including nested tasks. Nested tasks remain under their root task’s status group, with collapsible subtrees.
Quotes and fenced examples are not tasks in this view. Doing and checkbox edits
change one source byte; additions insert below the heading without rewriting other
content.
Duplicate Todos sections block editing until corrected in Canvas. Disabling removes
the convenience UI, not the saved list: Channel actions → View canvas remains editable.

An optional terminal suffix records assignment as ordinary Markdown:
` · Assignee: [Display name](nostr:npub…)`, using a full valid npub, not the abbreviated
placeholder shown here. Only that exact structural suffix is assignment metadata;
other links/prose remain task text. The public key is identity; names are escaped
presentation. Assign/change/clear edits only the suffix. The selector uses the
current channel member roster, including that boundary for shared naming policy,
with public-key qualifiers in the opened choices. Missing rosters disable assignment controls; failed profile reads retain key/name fallbacks
and offer retry. Profile renames never rewrite saved Canvas. Former members remain
visible and can be changed or cleared. Assignment sends no notification and grants
no channel membership or access.

Canvas reads occur on open and explicit Refresh, not on a timer. Missing assignee
and member profiles use the existing shared background directory. Typing an unfinished
new item stays local; Add, checkbox and assignment actions save automatically.
Task actions pause while saving; the new-item input stays editable and retains
its text when the save finishes. If the loaded Canvas was written in the current second,
a single cancellable wait respects its timestamp ordering; there is no background
retry loop. Failures and recovered drafts expose Retry rather than silently publishing
on reopen. Save uses the existing session Canvas/outbox contract, including its
24 KiB limit, fresh membership check, writer-backed Canvas head/editor-confirmation
reads and exact signed-event recovery. Canvas reads default to strong consistency
for editor/Todos bases and setup preconditions. Setup delivery and its separate
exact-ID confirmation both use writer-backed reads; unknown seed outcomes are
checked without automatically replaying the seed. Template copies explicitly opt
out and remain replica-eligible; Channel Settings no longer reads a Canvas preview.
The session Canvas owner checks returned events independently of the relay's query
filter: kind 40100 and exactly one two-field `h` tag naming the requested channel.
It ignores mismatched events before selecting the current head; an invalid newer
event cannot hide a valid returned head. History rejects pages containing invalid
coordinates. These checks precede Solo's separate owner/agent-attestation check,
so an authentic signature on unrelated content cannot make it Canvas instructions.
Editor/Todos saves carry `expected-revision=<loaded
head id>` (or `none` when absent); template seeds carry `none`. On relays supporting
Canvas compare-and-swap, stale preconditions are refused atomically before mutation.
A proven conflict keeps the local draft and dismisses only that rejected outbox
operation so a reviewed save can proceed. Unknown outcomes remain in Outbox and
block replacement; exact signed retries keep their original precondition. The
post-write different-head check remains conservative and also retains the draft.

**Compatibility gate:** deploy with a relay supporting Canvas revision preconditions
([block/buzz#6780](https://github.com/block/buzz/pull/6780)) for atomic protection.
An older relay may ignore the tag; strong reads and client head comparison alone
cannot prevent concurrent overwrite. The client does not upgrade the relay.
Detected conflicts require reviewing the saved Canvas. Refresh confirms before discarding
edits. Local recovery drafts are partitioned by community/viewer/channel; if browser
storage is unavailable they survive only while the editor stays open. Save never
promotes local recovery storage to shared state. Already accepted outbox operations
remain session-owned if the drawer closes or plugin is disabled.

**Canvas history:** Channel actions → View canvas → History lazily reads retained
kind-40100 revisions in pages of 25, ordered by `created_at DESC, id ASC` with
`until`/`before_id` keyset cursors. The first page is writer-backed so a just-restored
revision is visible; older pages remain replica-eligible. The current marker uses
the editor's strong-read head, not list position. Refresh history rechecks the
head without replacing the editor draft. Author labels use the shared profile
directory, with public-key fallbacks; previews are read-only Markdown source.

Restore requires explicit confirmation and publishes the selected content as a
new signed revision through the existing Canvas save/outbox owner. Its precondition
is the displayed head, never the historical revision or a silently substituted
newer head. Clean editors adopt the confirmed result. Edited or stale recovered
drafts keep their content and original base until explicit reload; browsing and
cancelling never replace drafts. Restore inherits Save's delivery confirmation,
which may automatically replay the exact signed event with its original
`expected-revision`. It never creates a fresh event or substitutes a newer
precondition to retry. If confirmation ultimately fails or remains uncertain,
the dialog retains drafts and shows the error without starting another restore.
Empty revisions can be restored; revisions exceeding the existing 24 KiB save
limit remain previewable but cannot be restored here. No diff viewer or new
delivery owner is introduced.

### Top-bar launchers and the companion slot

A panel may supply `launcher: { icon, target }`. The host renders the decorative
image (generic icon on failure) and uses the panel title as the button label.
`target` is an opaque string, including an empty default; it is not an agent URI.
Launcher-only panels use `matches: () => false`. Clicking selects that exact active
contribution, bypassing target matching so another plugin cannot intercept it.

App owns one launched-panel selection, separate from a page’s local target. The
selection starts closed, repeated clicks toggle it closed, and navigation preserves
open intent. Disable/replacement invalidates the installation object; re-enable
stays closed even at the same key/revision. A stale close cannot dismiss a later
opening, including a later opening of the same contribution. Ordinary close returns
focus to the launcher if available.

Pages explicitly opt in with `companion: true` and receive `{ companion?: ReactNode }`,
a ready-to-render card. They must place it in **every** state, including no relay,
loading and empty data. Channels places its local target above this card in one
right column. Non-opted/legacy pages and Settings use the generic host fallback;
there is never a second simultaneous host dock. The fallback frame stays mounted
while opening/closing to preserve page-local state. `PanelCard` and `PanelFrame`
are ordinary shared components, not another registry.

Only open intent crosses pages: the panel component can remount under a new page,
so this mechanism does not promise persistent agent sessions or drafts. The bundled
Bestie page currently supplies art and truthful not-connected copy, with no send
control, agent API or top-bar launcher. Both browser and Rust native/CLI catalogs
keep it bundled but off by default; saved enabled or disabled flags still win.
Enable it under Settings → Plugins → Manage plugins.

`main.tsx` creates the shared services once; `app/App.tsx` owns startup screens,
navigation, and built-in Settings. `app/services.ts` composes the core services.

Settings and Recovery subscribe directly to plugin management. Page render errors
stay in the page boundary rather than being copied into plugin configuration.

`plugins/manager.ts` is the plugin subsystem's entry point. The app supplies the
Cordis context and bundled manifests/modules. Storage defaults to the platform
adapter, with an optional override for tests. React is provided as `ctx.react`;
external JSX plugins declare `inject = ["react"]` to use the shared instance. The manager
constructs its module loader and execution adapter internally, observes configuration,
and selects the desired plugins (including enabled flags and safe mode).

### Discovery metadata

Plugin manifests may include display-only discovery metadata:

```json
{
  "id": "example.invoices",
  "name": "Invoices",
  "apiVersion": 1,
  "description": "Reconcile invoices without leaving Buzz.",
  "discovery": {
    "category": "productivity",
    "tags": ["Accounting", "Invoice Management"]
  }
}
```

Descriptions contain 1–280 UTF-8 bytes. Category values use the same stable
lowercase identifier syntax as plugin IDs. Tags are readable plain text, such as
`"Programming Language"`, with 1–80 UTF-8 bytes per tag and at most 16 tags. Blank
tags and control characters (including tabs and newlines) are rejected. Duplicate
comparison trims and collapses Unicode whitespace to a single space, then applies
Unicode lowercasing; `"Programming Language"` and `" programming   language "`
are duplicates. The original spelling, casing, and spacing are preserved for
display and serialization. This comparison does not perform Unicode canonical
normalization or full Unicode case folding.
Categories are open slugs: a host may give recognized categories first-class
labels and group unrecognized values under Other, but an unrecognized category
does not invalidate a plugin. Tags carry open-ended search terms. Neither field
grants capabilities, asserts provenance, or describes runtime state. The
`discovery` object accepts unknown display hints for forward compatibility;
security-bearing manifest fields remain strict.

Hosts released before these metadata fields were introduced reject `description`
and `discovery` as unknown manifest keys. Publishers targeting those hosts must
omit both fields; using slug tags does not make them compatible.

### Writing plugin discovery metadata

Choose one primary category by the plugin's purpose. The current Settings
categories are defined in [`src/app/plugin-categories.ts`](../src/app/plugin-categories.ts):

| Category ID | Settings label | Use for |
| --- | --- | --- |
| `communication` | Communication | Composing, reading and navigating conversations. |
| `agents` | Agents | Agent runtimes and configuration. |
| `agent-tools` | Agent tools | Utilities for working with agents and their activity. |
| `developer-tools-and-integrations` | Developer tools & integrations | Developer workflows and connections to other products. |
| `people-and-communities` | People & communities | Profiles, membership and community or relay administration. |
| `productivity` | Productivity | Tasks, reminders and personal work. |

These are host-recognized choices, not a closed manifest enum. Omitted or
unrecognized categories appear under Other. For bundled plugins, the catalog test
requires a non-empty description and a recognized category. External authors can
use other valid slugs, but should use a recognized one when it fits.

Write the description around **what the plugin does**. For example, Voice Notes
uses "Record voice notes and play them in conversations." Name an entry point
only when it is not obvious, using the labels people see in Buzz. Leave the
walkthrough to the README. Avoid feature inventories, implementation details and
repeating an obvious page name just to fill the byte budget.

Use tags for useful topics or search terms that the category and description do
not already explain. Both plain-text terms and slugs are valid; the schema does
not require one naming style. Categories describe purpose; they do not list every
UI surface a plugin touches. Keep `Essentials` and `Core` for host-curated bundled
metadata; external plugins should not use them. This is authoring guidance, not a
manifest validation rule. Discovery tags must not claim permissions, signing,
provenance or runtime health; the host owns those decisions and states.

### Make bundled plugins distinct

Each bundled plugin must be distinguishable from the others at a glance. Choose
a name and description that make its job and scope clear, including who it is
for when that matters. Similar plugins should explain their different jobs in
the catalog itself; people should not need to open both READMEs to tell them
apart. For example, community administration concerns one community's members,
roles and invitations, while relay administration concerns reports, feedback and
communities across a relay for authorized relay staff.

Artwork should reinforce that distinction with a recognizable subject or
silhouette while following Buzz's shared visual style. Avoid giving neighboring
plugins near-identical imagery or relying on color alone to distinguish them.
Before adding or changing a bundled plugin, authors and reviewers must compare
its name, description and artwork with the existing catalog, especially plugins
with similar names or purposes in the same category. Check whether someone new
to Buzz can tell what each adds and which one they need. Revise ambiguous copy
or imagery before considering the plugin ready.

### Writing the plugin README

Keep the user guide short and positive: `# <plugin name>`, a couple of sentences
about what it adds, then one `## Getting started` heading with basic steps. Put
entry points and any required setup in those steps. Focus on using the plugin;
skip default-enabled status and descriptions of what turning it off removes.
For bundled plugins, `src/bundled/readmes.test.ts` enforces this heading structure.
Contributor specifications may follow a `---` separator after the user guide.
Settings still displays that content below the guide; the separator only limits
the heading check in the test.

For example, the bundled Voice Notes guide uses:

```markdown
# Voice Notes

Record a voice note when talking is easier than typing.

## Getting started

1. Choose **Record voice note** (the microphone) in the composer.
2. Choose **Finish voice note** to attach it, then send.
3. Play voice notes in conversations, and change their speed if you like.
```

README packaging and display are separate. Settings displays only READMEs shipped
with Buzz for bundled plugins; it does not display packaged READMEs from external
installations. External authors can still package a README, but should not promise
that it will appear in Settings.

For that bundled renderer, use ordinary Markdown and external HTTPS links.
Credential-free HTTP links are also accepted; relative and in-page links render
as text. Raw HTML is skipped and images render as alt text rather than loading
remote media or data URLs. Put an external build's README beside `manifest.json`
and `plugin.js`; a repository-level README is not automatically included.
The [packaging rules below](#loading-from-folders-and-repositories) cover the
README/icon size limits, reserved filenames and signature coverage.
See the [example authoring walkthrough](../examples/plugins/README.md#add-discovery-metadata-and-a-readme)
for a manifest with these optional fields.

### Declaring host access

Plugins can separately declare host access in `manifest.json`:

```json
{
  "host": {
    "commands": [{ "id": "status", "program": "example-cli", "args": ["status"] }],
    "networkOrigins": ["https://api.example.com"]
  }
}
```

Plugins declaring `host` in `inject` use `ctx.host.runCommand(id, input?)` and
`ctx.host.request({ url, method, headers, body })`. Command calls name a declared
ID; the program and arguments come only from the plugin's manifest. Native
execution uses no shell, accepts no stdin by default, discards stderr, and returns at most 4 KiB of
UTF-8 stdout by default. A command may declare `maxOutputBytes`, an integer from
1 through 1048576 (1 MiB), to request a different bound. Output exceeding that
bound returns `null` without truncation. Existing declarations retain the 4 KiB
default. Hosts that do not support this field reject manifests that declare it.

For example, a plugin querying tools available to an agent may need room for a
JSON inventory containing tool names and descriptions:

```json
{
  "id": "agent-tools",
  "program": "agent-tools",
  "args": ["list", "--json"],
  "maxOutputBytes": 65536
}
```

This is a command entry inside `host.commands`. The plugin parses the inventory;
the host only enforces the declared byte limit.

The direct command invocation has a five-second deadline;
commands may declare `maxInputBytes` (1–65536) for optional UTF-8 stdin data.
Undeclared or oversized input is rejected before spawning. Input never changes
the installed program or arguments, and its delivery shares the existing deadline.
cancellation or timeout kills its process group on Unix or its job process tree
on Windows. Failure returns `null`. The app
also searches standard Homebrew binary directories when a macOS GUI launch has a
limited PATH and passes that search path to the command.
Plugins parse and retain their own credentials; the host has no provider registry
or credential store.

A plugin that needs a long-lived program, such as an agent CLI that speaks a
JSON protocol on stdin and stdout, declares it under `host.processes`:

```json
{
  "host": {
    "processes": [
      { "id": "agent", "program": "example-agent" },
      { "id": "install", "program": "bash", "args": ["-c", "curl -fsSL https://example.com/install.sh | bash"] }
    ]
  }
}
```

`ctx.host.spawn(id, { args, cwd, env, mcp, protection, onStdout, onStderr })` starts it
with the caller's `args` after the declared ones, so the declaration names the
program but not every argument. It returns `{ write, end, kill, exited }`.
stdout and stderr arrive as UTF-8 text as they are read, not split into lines.
`cwd` is absolute or `~/…` and is created if missing. `env` adds to the app's
environment (`null` removes a variable); variables starting `BUZZ_` or `NOSTR_`
are never inherited. The program is found on the same search path as commands,
which on macOS also includes `~/.local/bin`. A process declared with
`"bundled": true` instead runs the copy the app ships in its `bin` resources and
never searches PATH; the Goose plugin runs `goose-acp` this way.

`mcp` supplies an app-held MCP session URL and headers. The bundled command
helper initializes that session and supplies an agent-scoped `buzz` tool command
to the worker. Agent identity, signing authority and tool authorization stay in
the app; this option does not transfer private identity keys to the worker.

A process lives until it exits, the plugin kills it, the plugin unloads, the
page reloads or the app exits. `kill` sends SIGTERM to its process group and
SIGKILL three seconds later; the group is always killed once the process exits,
so descendants do not outlive it. At most 64 processes run at once. Processes
run with the user's full access by default; the import preview says so.
`protection: { readOnlyPaths, hiddenPaths }` adds macOS containment for the worker
and descendants. Both arrays contain existing paths, absolute or under the user's
home written `~/…`. Read-only paths reject writes; hidden paths reject reads and
writes. The host adds its application, plugin storage and actual Agents folder,
blocks Apple Events, and refuses mutable development frontends or unsupported
operating systems.

Contained launches require an app-bundled executable or an `artifact` descriptor;
PATH-only entrypoints are refused. Artifact descriptors name an executable, absolute
or under the user's home written `~/…`, its SHA-256, and optional flat sibling files
with their hashes. Native launch hashes while copying those declared files into a
content-addressed generation beneath the actual shared Agents folder, then launches
that copy. All contained workers are prevented from writing this store. Corrupt
generations fail closed and are never repaired in place. Equivalent Windows path
forms are accepted; symlinks remain rejected. Control characters in containment
paths refuse launch.

This is approval-authority containment, covering the application, controls, private
approval state, and declared launch files. It does not verify every dependency an
interpreter loads. Unsandboxed processes running as the same user, including code
planted for later execution, are outside this boundary; broader isolation belongs
to Sandpit. Ordinary launches retain their existing PATH and access behavior.

A plugin that declares `"files": true` under `host` reads files and resolves
directories natively, the same on every platform, rather than starting a
program such as `base64` or `pwd` that Windows lacks.
`ctx.host.readFile(path, { cwd })` returns the bytes of a file of at most 50 MB;
`path` is absolute, `~/…`, or relative to `cwd`, which is absolute or `~/…`. A
missing file rejects with an error whose message contains "No such file".
`ctx.host.resolveDirectory(path)` returns an absolute or `~/…` directory as an
absolute path without symbolic links, in the platform's ordinary form, and
creates it if missing, as a process's `cwd` is. Both act with the user's full
access; the import preview says so.

Bundled host grants use the effective compiled manifest at revision `bundled` and
require the plugin to be enabled in the native catalog. External grants require the
enabled current artifact and its integrity checks; safe mode pauses external
plugins while enabled bundled plugins remain usable.

Builderlab's effective manifest derives its exact origin from the validated
[`BUZZ_BUILDERLAB_URL` build input](configuration.md#builderlab-url-build-input).
With the [FI descriptor](configuration.md#federated-identity-build-input), it
instead gets a `host.federatedIdentity` grant of exact Builderlab routes and no
network origins or files. Its source manifest contains no deployment origins;
external plugin declarations remain fixed in their installed artifacts.

The `federatedIdentity` service forwards a granted operation natively to the
identity origin with the FI session as `Authorization: Bearer`, scoped to the
caller's enabled current artifact, a live registration and the session revision
the call started under. Plugin reload, recovery and enable changes retire
registrations; a caller registers again once. The token never enters the
renderer, and an ordinary network origin is never authority to use it.

Requests use the native HTTPS client, so a plugin can declare an exact
origin without changing the renderer CSP. URLs must use a declared origin; redirects
are not followed and cookies are not forwarded. Requests accept up to 1 MiB of text
body and 8 KiB of headers; responses return status, up to 64 headers totaling
16 KiB (excluding `Set-Cookie`), and up to 16 MiB of UTF-8 body. The full request
defaults to a 30-second deadline; `timeoutMs` may select 1–180000 milliseconds
for long operations such as Apps initialization. Archive uploads have a
180-second deadline. Browser calls cannot use these native operations.
Existing bundled GitHub requests retain their first-party renderer fetch and CSP
entry.

`host.requestOnce?.(request, { callId })` is an explicit opt-in, desktop-only POST
primitive for non-idempotent submissions on compatible hosts.
Ordinary `request`, byte GET/save, archive uploads, processes and publication do not
automatically opt in; there is no endpoint-specific URL or content logic. Check the method
before starting work; missing native context also rejects without falling back to
ordinary `request`. A compatible frontend **and** native release are required.

For a final caller-policy check, first detect
`typeof host.requestOnce === "function"`; synchronous eligibility is part of this
optional method's contract. If absent, refuse work that depends on it; do not fall
back to ordinary requests. The minimum compatible released version is not yet
established; method availability does not prove native compatibility.

Pass `isEligible: () => boolean` alongside `callId` (the exported
`HostRequestOnceOptions` type). The host calls it synchronously after native
context preparation and validation, immediately before protected invoke. Only
literal `true` permits dispatch; false, throwing, nonboolean values and
Promises/thenables refuse without dispatch, fallback, authority refresh or retry.
It rechecks the calling fiber after the callback in case it disposed that scope,
with no await between a successful check and invoke. The predicate is not sent
to native. Omission preserves existing protected-request semantics.

The caller owns this policy, including checking an elapsed monotonic deadline
rather than relying on a timer task. This is a JavaScript pre-invoke boundary,
not native approval, cancellation, or a deadline at network/server receipt. It
cannot prevent or undo work already accepted by native or the server.

Record a random canonical lowercase hyphenated UUID `callId` and the exact request
before calling. The host adds a calling-fiber activation and native boot/page
context. After current enabled-artifact, HTTPS, origin and request-limit checks,
native consumes the authority before dispatching and disables client retries.
Repeated native dispatch of that same envelope rejects as already consumed with
unknown outcome; changed payload under the same authority rejects as a conflict.
Neither returns cached success or sends again, including after failure or timeout.
Never mint a fresh identity or refresh authority to retry an unknown submission.

Native retains at most 1024 compact digest claims per page generation, with no
rearming on completion, unload or grant change. Advancing the native page generation
clears its claims; old boot/page envelopes are rejected before claim lookup and
cannot use the freed capacity. Capacity/poison/generation exhaustion fails closed.
Fiber disposal blocks new cooperative calls and suppresses late success, but cannot undo
an admitted upstream request. An in-place fiber restart creates a fresh activation;
old in-flight calls remain inactive. Restart must not be used to retry an unknown
submission. This is **same-envelope host dispatch protection**,
not durable exactly-once execution, server/proxy deduplication, spend approval,
upstream cancellation, a malicious-plugin sandbox or deduplication of fresh authorities.
Plugin persistence and non-resuming approval policy remain the caller's responsibility.
In particular, this blocks same-envelope IPC-fallback resends only: fresh calls,
proxy/server retries and work after a client disconnect remain outside its scope.
When supported by the destination, send the recorded `callId` as its server
idempotency key as well (for example in an `Idempotency-Key` header). Do not mint
a new key to recover an unknown outcome.
Actual WebView fallback/runtime acceptance is distinct from native fixture tests.

### Protected in-memory multipart uploads

Compatible desktop frontend/native pairs expose optional
`host.uploadBytesOnce(bytes, {url, field, name, contentType, fields?}, {callId, isEligible?})`.
Check `typeof host.uploadBytesOnce === "function"` before work requiring it; an
absent method or incompatible native host must fail closed, with no renderer
fetch, ordinary request/upload, process, file, or IPC fallback.

This POST sends one nonempty in-memory `Uint8Array` of at most 16 MiB. The host
copies bytes and metadata synchronously before awaiting native authority, and
builds the multipart boundary and body in native code. It requires only the exact
HTTPS origin in `host.networkOrigins`: neither `host.files` nor
`host.managedFiles` is needed, and no path is accepted. URL credentials, caller
headers, cookies, redirects, and HTTP client retries are not permitted. Text
fields are optional (at most 16 string values, each at most 8 KiB in UTF-8).
The filename and all form names must be 1–256 ASCII bytes containing only letters,
digits, dots, underscores or hyphens, with no leading dot. A filename is a single
name, never a path; separators, control characters and dotfiles are refused.
`contentType` must be exactly `image/png`, `image/jpeg` or `image/webp`, and native
magic-byte sniffing must match that declaration. This signature check is not a
full image decode or a guarantee that downstream image processing is safe.
The full ASCII-escaped IPC metadata, including
the authority envelope, is bounded to 16 KiB. The frontend reserves 512 bytes for
that envelope: the total escaped-metadata cap of 16 KiB minus 512 bytes takes
precedence over the per-field limits, so 16 fields of 8 KiB each are not possible.
Unicode text values are preserved, but escaping can increase their metadata size.

The deadline is fixed at 30 seconds. Responses use the existing bounded
`HostResponse`: status, at most 64 headers totaling 16 KiB excluding `Set-Cookie`,
and at most 16 MiB of UTF-8 body. This operation shares the existing app-wide byte
work permit and bounded FIFO admission queue with byte GET/save. At most 16 callers
wait; queue overflow refuses before consumption/dispatch. Waiting is charged to
the same entry deadline, and multipart/body cloning starts only after admission.
This is a work-admission bound, not a whole-process IPC or RSS memory bound.

Upload authority uses the same boot/page, fiber activation, canonical UUID
`callId`, final synchronous eligibility check, consumed-envelope storage and
late-result suppression as `requestOnce`. Its operation kind is distinct from a
text POST; use a separate recorded callId for each submission. The payload digest
binds exact URL, form metadata and bytes, not a randomized multipart boundary.
Repeated or conflicting native dispatch of the same upload envelope refuses,
including after ambiguous failure, timeout, or a lost reply. This prevents
same-envelope host/IPC resends, not durable exactly-once execution; use an upstream
idempotency key when supported, and never mint a new callId to retry an unknown
outcome. Missing raw IPC support rejects JSON/array fallback before consumption
of that fallback dispatch, but the original upload may already have run. Treat a
"Protected upload body must be raw bytes; outcome may be unknown" refusal as an
unknown outcome, never as proof that nothing was sent or permission to retry
with a fresh callId.

Plugin author types export `AddedTool`, `AddedToolContext`, `AddedToolReply`,
`BuzzClient` and `Media` from
`@buzz/author`; an added tool can use its supplied `client.media(url)` to read
community media. In the native client, optional base64 `Media.data` is present
only for JPEG, PNG, GIF or WebP of at most 3,932,160 decoded bytes (3.75 MiB; up to
5 MiB base64). Larger media can be saved by that API but omit `data`; the 16 MiB
upload limit does not increase the inline-media limit. Consumers must handle
missing data and validate their own media/type/size policy without assuming a
file-read capability.

### Bounded binary retrieval and temporary managed files

Compatible desktop frontend/native pairs expose optional `host.requestBytes` and
`host.saveBytes`. These are independent of POST dispatch protection: neither gets
native call context, a call identity, a replay envelope or deduplication. Check
method availability before starting work. An older native host can reject the
unknown `managedFiles` manifest field at installation, before any plugin UI runs.
The minimum released compatible host version is not yet established; an API
version alone is not capability evidence. No ordinary-text, base64 or private IPC
fallback is provided by these methods.

```ts
const response = await ctx.host.requestBytes?.({
  url: "https://api.example.com/data",
  maxBytes: 1024 * 1024,
  timeoutMs: 30000,
});
// Check the HTTP status and keep the input immutable through hashing/save.
// sha256 is the lowercase 64-hex digest of exactly the bytes being saved.
const saved = response && await ctx.host.saveBytes?.(response.body, { sha256 });
// saved: { path, size, sha256, expiresAt } — not an upload or publication receipt.
```

`requestBytes({url,maxBytes,timeoutMs?})` performs only GET, with no caller headers,
body or cookies and no redirects. The destination must be an exact declared
HTTPS origin of the current enabled plugin revision, checked again before handoff.
`maxBytes` is a required integer from 1 through 16777216 (16 MiB); actual chunks
are counted regardless of Content-Length. The deadline defaults to 30000 ms and
can be 1–30000 ms. Empty bodies and non-2xx statuses are returned, not reclassified
as successful operations. Existing ordinary GET client retry semantics remain;
this is not an at-most-one GET promise or an application retry policy.

The internal raw response is a four-byte big-endian metadata length, UTF-8 JSON
`{status,headers}` of at most 20 KiB, then the body. At most 64 response headers
and 16 KiB of header names/values are accepted, excluding Set-Cookie. The frontend
requires ArrayBuffer before creating a view, validates framing/status/headers/body
bounds and returns a Uint8Array view without another JS body clone. Numeric-array
fallback replies are refused rather than converted to bytes. Tauri can redispatch
a GET after custom-protocol fetch/decoding failure, so an unsupported reply can
follow more than one native download.

Declare `host: { managedFiles: true }` for pathless temporary saves. This grants
neither file reading nor arbitrary-path writes. Existing `host.files` still means
broad read/directory-resolution authority; it is not required by the saving plugin.
`saveBytes(bytes,{sha256})` accepts nonempty Uint8Array data up to 16 MiB. Keep its
buffer immutable through hashing and the awaited save. Native validates actual
raw input length and recomputes the expected lowercase SHA256, failing closed on
mismatch. No filename, destination, content type, expiry or reader grant is supplied
by the caller. `expiresAt` is safe-integer Unix milliseconds from the host clock.

Saves use one flat `plugin-artifacts` child of app-data storage, host expiry/UUID
names and exclusive file creation. New names also include a digest of the owning
plugin ID; no caller path/name is accepted. Unix uses 0700 root/0600 files with ownership
and link checks; other desktop platforms rely on private app storage conventions.
This is trusted same-user storage, not isolation from malicious plugins or other
code with the user's access. A fixed cross-process try-lock covers expiry sweeping,
actual regular-file accounting, capacity, write/hash/file sync, supported directory
sync and final eligibility/cleanup. A busy lock refuses without a waiting queue.
Unknown regular files, partial writes, zero-length leftovers and failed deletions
count; unknown links/directories, unreadable accounting or bounded-scan overflow
refuse. Only the verified fixed ownership file is excluded.

The shared root permits at most 64 MiB and 16 artifact files. Any plugin can fill
it; there is no per-plugin quota or fairness promise. A full root refuses before
another file is created, without evicting unexpired files. Failures remove output
best-effort; residue remains counted. There is no index, sidecar, recovery adoption,
content deduplication or temporary-to-final file service.

Optional `host.deleteManagedFile(path)` requires `host.managedFiles` and the current
enabled plugin revision, not `host.files`. It accepts only a direct, host-generated
file in this root whose owner digest matches the calling plugin ID, including
files saved by its earlier revisions. It never follows links or deletes a different
plugin's file. Legacy files without an owner digest cannot be deleted through this
API and retain their expiry behavior. Deleting a missing file rejects.

Deletion shares byte GET/save's bounded FIFO admission and single work permit,
with a 30-second deadline including queue time. Saves and deletes in this app
serialize before taking the storage lock; another process holding that lock can
still refuse as busy. A queued timeout says the file was not deleted and does
not dispatch filesystem work. After dispatch to the blocking worker, a timeout
may have an unknown outcome; that worker retains admission until it completes.

Await attachment sends before deleting their source. Deletion conservatively
refuses app-wide while **any plugin's** `host.readFile` call or declared process
named `read`/`read-protected` is admitted or running, regardless of its program,
path or owner. One unrelated or stalled reader can therefore block every plugin's
managed deletion until its actual work completes, even after an async timeout or
kill request. A delete that wins before read admission makes that later read fail
as missing; it does not reserve paths for future sends or other processes. Retry
a known in-use refusal after the work completes, but never automatically retry an
ambiguous deletion timeout.

Expiry is host wall-clock save time plus 24 hours and a 30-second save window.
Files survive normal plugin unload, disable/update and app restart. Expired files
are swept only on a new save; there is no startup sweep/background deletion timer.
They can remain after expiry until another save. Ordinary signout is not erasure;
existing explicit app-data erase removes this root. Clock changes, user deletion,
erase or disk loss can invalidate retention assumptions; do not treat the path as
a durable archive or an unqualified availability guarantee.

One process-local byte-work permit is shared by GET/save/managed deletion/uploadBytesOnce.
A FIFO semaphore queues at most 16 waiting calls, rejects overflow, and charges
queue time to each call's existing deadline (GET 1–30000 ms, save/delete/upload
30 seconds). Expired/canceled waiters leave
the queue without dispatch; raw saves do not clone their body until admitted.
The one-admitted-operation/16 MiB work bound is unchanged, but waiting IPC input
buffers still exist: this is not a whole-process memory bound. Blocking save work
owns its permit and root lock through actual completion, even after the
30-second async deadline. Timeout suppresses handoff and eventual cleanup is
best-effort, not proof of rollback or completed deletion. Native checks current
enabled revision/managedFiles at admission and immediately before result eligibility.
Frontend Cordis uid/cleanup guards refuse stale admission and suppress late success,
without POST context. They cannot cancel accepted work or close every final-check
versus reply/disposal race.

Save IPC uses top-level raw bytes and bounded plugin/revision/hash headers. JSON
fallback refuses before copying/writing, but an original successful write followed
by a lost reply can leave a quota-counted orphan. Manually repeated raw calls can
save multiple files: there is no at-most-one-save guarantee. Never automatically
resave, reconstruct or refresh an identity after unknown outcome. Unsupported raw
transport does not authorize repeating upstream work. Tauri may allocate numeric
arrays before these application guards; rejecting fallback does not undo that cost.

The 16 MiB cap bounds individual admitted work, not RSS or pre-handler IPC buffers.
A rough normal-path explicit-buffer model is 64–80 MiB (4–5 times the cap), with
phase/GC-dependent overlap. Existing appClient attachment upload separately builds
binary/base64 strings. Real native/WebView peak and fallback memory acceptance
requires a separately authorized target run and explicit memory budget; offline
fixtures do not establish that bound or prove raw transport works on every target.

A returned path is not proof that any agent can read it. The existing app-owned
reader is AgentsService → appClient.read → the agent-owning plugin's host.readFile;
that reader owner must already hold `host.files`. Core send(files) reads actual
bytes, then existing MIME/upload/publication and channel/thread/audience policies
apply unchanged. The saving plugin does not directly invoke core send. Standalone
node readers still reject paths outside their configured root: managed membership
does not widen that namespace. Offline native-file and app-owned-reader fixtures
are composition evidence, not a single native WebView delivery test.

`host.upload` requires both `host.files` and the destination in `host.networkOrigins`.
It sends a multipart archive to that origin and reads one absolute
regular `.tar.gz` file under home, up to 100 MiB. This is local-file access in
addition to ordinary network requests. The archive suffix and path checks are
guardrails for trusted plugins, not a sandbox or a content classification check.

New-install review lists declarations. Update review compares against the installed
revision and leads with added, changed and removed declarations; changed commands and
processes include previous and replacement details. Equivalent default limits and
reordered declarations do not count as changes. Unchanged updates say so explicitly,
and View unchanged declarations opens a separate view inside the same dialog. Back
returns to the summary without acquiring or discarding the prepared update.
Update review names the plugin, keeps the trust warning visible, and avoids nesting
declarations inside an additional disclosure.
The install/update action accepts that displayed version; an enabled update may run
immediately. These declarations help review and catch mistakes. Plugins share the
main WebView and can invoke app commands directly, so the declarations do not
isolate a malicious plugin. Load only trusted plugin code.

### Loading from folders and repositories

Authors can sign a built API v1 plugin with `buzzodz plugin sign DIST_DIRECTORY`
after `buzzodz plugin build`. The command reads the saved Buzz human identity
from the same OS credential slot as the desktop app; it never exports or creates
a key. Use the same OS account and matching debug or release build. Missing or
locked storage fails. It writes `plugin.artifact.json` and
`plugin.signature.json` as the local [NIP-PS](nips/NIP-PS.md) file pair. No relay
or URL is needed. Include both files in the imported folder or Git repository.
Buzz checks the event ID, signature and exact artifact bytes before install and
each load. Unsigned `manifest.json` and `plugin.js` builds remain available for
local development.

A build may also include conventional `README.md`, `icon.png`, and `icon.jpg` files beside
those required files. README content must be UTF-8 and is limited to 256 KiB.
Icons must match their PNG or JPEG filename and have a decodable first image, each at most 1 MiB, no more than 4096 pixels on
either side, and no more than 1,048,576 pixels total. Signing places their exact
content in typed optional release-envelope fields, so the artifact hash and
publisher signature cover them without changing plugin `apiVersion: 1`. Hosts
continue to accept older `{ manifest, code }` artifacts. The catalog exposes only
small content revisions for import/update comparison. `Manager::content` reads the
integrity-checked content on demand; its native command and capability land with
the first details surface that consumes them.
Both icon formats may be packaged together and are returned independently; the
client decides which format to prefer.
Header parsing and image decoding use a 16 MiB allocation budget; the underlying
decoder may discard optional metadata that exceeds that budget. Validation does
not certify later animation frames or reject trailing bytes after the image.
Content reads return the stored base64 icon strings. Conventional
asset filenames are case-sensitive in both folder and Git imports; a symbolic
link at one of those filenames rejects an unsigned candidate.

`README.md`, `icon.png`, and `icon.jpg` are reserved names in an unsigned build
folder, with the same all-or-nothing rule as `manifest.json`: a file at one of
those names that misses the limits above rejects the whole folder or Git import,
reload, and signing, and an installed plugin keeps its current revision.
Older hosts ignored these names, so a source tree that already ships a
nonconforming file there (for example, a 2048×2048 `icon.png`) stops reloading
after upgrade. To migrate, resize the file to meet the limits, or rename or move it
out of the build folder. Signed artifacts carry their content explicitly and are
not affected by neighboring files.

Older hosts can still read asset-free packages and registry entries. Packages
with these new fields, and registry entries recording their content revisions,
require a host that supports them; older hosts reject unknown fields and may
offer settings recovery. Downgrading after installing such a package is not
supported. This does not change the plugin runtime API version.
Signing requires regular, non-symlink source files, using the same directory
capability boundary as folder import.

These files are publisher-supplied presentation content, not an endorsement or a
runtime asset directory. Buzz-owned framing and fallback artwork remain
authoritative. Any surface that renders packaged READMEs must keep raw HTML and
scripts disabled and must not load embedded data URLs or passive remote media; the
bundled README renderer already follows these rules. The package API does not
turn README links, images, or the icon into plugin runtime resources.

A signed installation can only update from the same publisher; remove and
reinstall to choose a different publisher. Signing identifies an author, but
does not sandbox plugin code or make a publisher trustworthy.

Desktop Settings → Plugins → Manage plugins loads a folder with the native folder picker, or an
HTTPS/SSH Git repository (including GitHub `owner/repository`). An optional branch
or tag is separate from the repository URL; GitHub `tree` URLs are rejected with
guidance rather than ambiguously splitting branch names and subfolders. Discovery
lists built plugin folders by path, name and manifest ID, including nested `dist`
folders. Choose one and explicitly install. An already-installed plugin offers
Open in Buzz, which discards the preview and opens its installed details. Choosing
another source still requires deleting the plugin and adding it again. New plugins
enable by default, with an opt-out in the review footer; successful installation closes the dialog. Updates match
**manifest ID** and preserve the saved enabled state:
an enabled update may activate immediately except in safe mode. Review shows declared host access, including changes. Installed artifacts do
not watch/pull the source. Plugins installed from a folder keep the selected folder
path for automatic checks in Settings → Plugins → Manage plugins. Changed packages
offer Update, which opens access review before explicit confirmation, preserving
the saved enabled state. Settings does not expose the immediate Reload shortcut.
For development, `buzzodz plugin reload ID` explicitly allows replacing an enabled
folder plugin while preserving its enabled state. The running desktop observes the
shared profile catalog every second and disposes the previous revision before
activating the new one. Use the same `--home` and `--profile` as the app. Reloading
identical build bytes does not restart the plugin. CLI reload applies the same
manifest ID and publisher checks as Settings. CLI reload accepts changed host
access and reports the previous and updated declarations. Rejected builds leave
the installed revision unchanged. Replacing an active plugin ends its in-memory
work, including a voice call. This is a host-management capability, since an
external plugin cannot manage other installations or add CLI commands.

Opening an installed plugin's details checks its remembered folder. A matching
package shows Up to date in the pane. Local folders are checked every five seconds
while the pane is open and the app is visible, and again when the app becomes active.
Checks pause during review or pending management operations. Folder checks resolve
the saved source by installed plugin ID and return only a revision or build diagnostic,
without reserving the native import slot. Add can prepare its own preview while a
folder check is pending. Choosing Update acquires a fresh immutable preview; checks
never supply installation bytes. A changed package offers
Update, which opens access review before explicit confirmation. A known update takes
the prominent action position in both the pane and its list row; Enable/Disable
moves into their ellipsis menus while Update is available. The row retains the latest
check result for the installed revision and opens the pane’s review, checking the
saved source again when the pane reopens. Known Git results remain visible on reopen;
Git is checked explicitly through a read-only acquisition that never locks or replaces the shared import preview. Choosing
Update reacquires the Git source with fresh authorization. Only the open pane polls local folders.
The menus also offer Review access, reusing the import review’s disclosures
for the installed manifest, and Delete with confirmation. These menus appear only for
manual/external plugins; bundled plugins keep their Enable/Disable control.
The list row shows no freshness status label. Failed activation shows Retry beside the error for an enabled,
unpaused plugin. Retry activates the installed revision after its previous cleanup
finishes; it does not acquire source files, install a package, or change saved state.
Package freshness and activation failures are displayed separately. Update uses the same source and candidate path; changing sources
requires deleting the plugin and adding it again. Git checks remain explicit in the
pane, using the remembered repository and branch/tag with fresh authorization;
credentials/tokens are never saved with source metadata. SSH accepts explicit URLs
and `user@host:owner/repository.git` shorthand, including organization-specific
usernames. [Repository access rules](repository-access.md) select the SSH user and
agent socket for matching sources, and can read matching HTTPS sources over SSH; the
saved source keeps the entered URL. Other SSH sources use the desktop process's
inherited `SSH_AUTH_SOCK`. SSH uses known hosts, with interactive prompts and SSH
config disabled. For another agent selected by `IdentityAgent` in SSH config, add a
rule with that socket, or launch the app with it in `SSH_AUTH_SOCK`.
Each check reads metadata from its own temporary clone; only Update retains an
immutable installation preview. The source
follows the current revision through update and rollback. Rollback requires confirmation
in Settings and consumes the previous revision: it cannot toggle forward again. The
enabled/disabled choice is preserved; a later update establishes a new rollback target. Missing sources or changed
plugin identities/paths leave the installation unchanged. Older Git installs and
dropped-folder snapshots without saved source information can use Update to choose
a folder or repository. Only candidates with the installed plugin ID are offered;
confirmation updates in place, preserves the enabled state and retains rollback
history under the normal update rules. The selected source is saved with the new
revision. Git sources remain ineligible for folder Reload.

The Rust manager owns acquisition and immutable preview artifacts, with a bounded
single pending preview per native process. Replacing/closing a preview discards it;
leaving Settings ignores and discards a late result, never automatically installing.
Acquisition is separate from the manager's ten-second management-write timeout.
Installation uses the exact captured bytes and retains the existing artifact hash,
profile locking, rollback, recovery and safe-mode behavior. An uncertain write retains
the preview identity for same-artifact retry; it does not refetch or rebuild.

Local discovery skips symlink directories, `node_modules`, `target` and dot-prefixed
directories such as `.git` and `.claude` (Claude worktrees) below the selected
folder; select such a folder itself to import from it. Git discovery does not skip
dot-prefixed directories. Local discovery uses `cap-std` directory-relative reads to
confine descendant path resolution. Files must be regular and non-symlink;
manifests, modules, READMEs, signatures and candidate folder names must be UTF-8,
while icons are validated as binary PNGs or JPEGs. Folder names are not lossily normalized.
Discovery never evaluates modules. Git is a required local
tool: a shallow no-checkout clone reads committed blobs, without hooks, filters,
submodules, LFS downloads or project scripts. Only HTTPS/SSH are allowed; inherited
Git config, URL rewrites, credential helpers and interactive prompts are disabled.
SSH uses the selected agent and known hosts, not user SSH config; password entry, HTTPS
private-repo sign-in and custom SSH-config aliases are not supported in this slice.
Repository URLs/refs are passed as arguments, not a shell command. Private/internal
HTTPS hosts are not prohibited; this is not a public-network-only policy.
A caller may require a commit: the import then refuses a reference that resolves to
anything else, and records that commit in the saved source. An unpinned import records
no commit, so its registry stays readable by older versions.
[Managed plugin sources](managed-plugins.md) use this.

Git acquisition has a 60-second deadline (including blob discovery), an observed
256 MiB repository limit and bounded command output; transport processes are killed
on failure before temporary cleanup. These are polling limits, not hard OS quotas.
Folder traversal checks a 60-second budget between directory reads (a hung filesystem
syscall is not forcibly cancelled), 32 nesting levels and 20,000 entries. A preview
holds at most 32 plugins / 32 MiB; each artifact retains the 8 MiB limit. No builds
are run: source-only folders explain that the author must supply `manifest.json`
plus the self-contained `plugin.js`. Arbitrary assets/TSX/runtime dependency resolution
remain outside API v1. Browser Settings truthfully directs users to desktop rather
than adding a second external-plugin storage or broadening CSP. Native commands need
a rebuilt/restarted desktop process; frontend HMR alone cannot add them.

`plugins/storage.ts` isolates browser storage and desktop IPC. `plugins/modules.ts`
imports and caches executable revisions. `plugins/runtime.ts` adapts Cordis lifetimes
and owns activation status; contribution services receive a read-only readiness view
of that same status. There is no separately synchronized status store.

The runtime receives only the desired plugins. It retains cancellation and cleanup
barriers around asynchronous imports and replacement; Cordis owns dependency
availability and effect disposal. Stopping plugin management stops polling and its
owned plugin lifetimes. App shutdown starts manager disposal and root-context
disposal together: a hung plugin cannot delay cancellation of shared sessions,
requests or subscriptions. The returned promise rejects after 10 seconds if cleanup
has not finished; it does not claim that arbitrary plugin code has stopped. Plugin
replacement still waits for the predecessor's actual cleanup, even after a timeout.
React owns only subscriptions and presentation state.

Catalog polling observes external `buzzodz` writes once per second. Its ten-second
watchdog bounds the caller's wait, not native lock acquisition: one pending catalog
read retains ownership until it actually settles. Retry cannot launch a replacement
while that read is pending. Recovery remains available, but is a separate management
operation and still needs the native registry lock. A timed-out management operation
keeps controls busy until actual settlement; late results are not applied. A fresh
poll reconciles the eventual stored state. Disposal stops polling/publication, not
an already-running native operation.

Relay consumers use `session.channels` for channel views,
`session.profiles` for shared identities, and `session.read` for
finite filtered event reads, and `session.unread` for shared observed badges and
cancellable reading intent. See [relay query ownership](relay-queries.md) and the
[unread capability, durability and limitations](unread.md).

Plugins subscribe to `ctx.relay` connection snapshots and bind work to the current
ready session. `useRelayConnection(relay)` is the React adapter; remount session-owned
views with a key including both scope and generation (for example,
``key={`${connection.scope}:${connection.generation}`}``). Scope distinguishes
retained communities whose generation numbers may match; generation distinguishes
reconnections within one scope. Persist drafts and view intent under scope alone,
not generation. Reactive filtered reads use `session.observe`;
writes use `session.outbox` or the `session.messages` convenience methods. Reads,
live traffic and local events share reconciliation, with no separately injected
write service. Dispose owned views when their plugin or session scope ends.
For kind 30177 publication, follow the
[managed-agent registration guidance](relay-queries.md#managed-agent-registration-kind-30177).

The [Profiles plugin](profiles.md) supplies read-only human/agent identity panels.
Shared message UI opens exact public-key targets through ordinary page callbacks;
no inline-renderer or panel contract extension is needed.

## Navigation targets and visits

The host provides `ctx.navigation` to plugins declaring `navigation` in `inject`.
`open(target)` returns a presentation result, not merely an accepted address:
`opened`, `failed` (with a reason), `superseded`, or `cancelled`. The host owns one
history driver, toolbar/keyboard traversal, and a 15-second attempt deadline
that runs only while a presenter is attached (the identity/key-setup gate,
`IdentitySetup`, hides the only one, so the startup visit's deadline starts when
that gate lifts).
A visit has stable identity; retrying/reclicking preserves that visit and Forward,
while a new destination truncates the forward branch. Leaving aborts the old
attempt, and late completion cannot acknowledge a replacement attempt.

Version-1 `OpenTarget` accepts legacy Home targets (resolved to Messages), Settings sections, contributed pages with
optional versioned JSON routes, plugin links, and account/community-bound conversations.
A plugin link, `{ kind: "plugin", pluginId, pageId?, params?, scope? }`, is the target
form of `buzz://plugin?id=…`. It names a plugin and optionally one of its pages, with
untrusted string `params`. Once the plugin runtime has settled, the host resolves it
in place to an ordinary page target: the named page, else the plugin's primary page,
else its first page. `params` become that page's route params only when the page
declares a route and its `validate` accepts them; otherwise the page opens without
params. A plugin that is absent, disabled, or lacks the page fails `unavailable`.
Conversation targets may include `panel: "members"` to restore that channel’s
Members dialog without replacing its channel/message identity. Unknown panel
values are rejected; this is presentation state, never mutation or confirmation state.
The boundary copies, freezes and bounds route data; an address is never an access
grant. Scoped targets require the original viewer and an already joined community.
An explicit `scope: null` restores Personal space; omitted page scope leaves the
current community alone. Unknown providers/routes fail with the target retained
for retry, rather than silently opening another page.

Pages receive optional `navigation` in `PageProps`. Its optional `focus` is
`"content"` by default or `"preserve"` when the opening control keeps focus; page
autofocus must honor it. This is per-opening presentation intent, never route data
or a saved history value. Session binding and default resolution carry it forward;
retry preserves it, while explicit openings and history traversal default to
content focus. The shell topbar passes `open(target, { focus: "preserve" })`
through its page-selection handoff.

Ordinary pages acknowledge a successful mount inside the render boundary.
Pages declaring `handlesNavigation`
acknowledge their domain presentation with `navigation.complete(...)`; Channels
waits for its requested channel window or exact-message reveal/focus. `navigation.resolve(target)` normalizes a
pending default destination within the same visit, caller and original deadline;
it does not start competing navigation. Normalization revokes the old request.

A page request belongs to the exact active registration and mounted host
presentation. Its signal aborts and its callbacks return false after removal,
replacement, unmount or scoped-community invalidation, even before React cleanup.
A reactivated provider receives a fresh request for the still-pending visit.
Session-aware pages bind each rendered connection with
`navigation.forSession(relay, connection)` and pass that request to their
session-owned subtree; Channels demonstrates this boundary. Replacement revokes
the bound request synchronously without revoking static page authority or resetting
the caller's deadline. These are trusted-plugin lifecycle fences, not a sandbox.

`route: { version, validate }` opts a page
into versioned route parameters. These are host-matched preview types through
`@buzz/author`, not a cross-version runtime compatibility promise.

Browser `#buzz=` addresses and session history support reload and Back/Forward.
Messages recognize the Buzz link forms `buzz://channel/<id>`,
`buzz://channel/<id>/<event>`,
`buzz://message?channel=<id>&id=<event>&thread=<optional-root>` and
`buzz://plugin?id=<plugin>&page=<optional-page>&route.<key>=<optional-value>`
(plugin pages; see [OS deep links](deep-links.md)). Buzz links carry
no community: they bind to the receiving conversation's community and viewer and
pass through existing navigation admission and session ownership checks. The app
has no link form of its own; any other `buzz://` host is rejected everywhere,
staying plain text in messages. Message targets open their
verified thread, reveal the exact message after bounded history loading, and only
then acknowledge navigation. Supplied root hints do not override verified events.
Missing or unavailable messages report failure. Ingress adapters must reuse this
validated target/completion lifecycle; notification clicks
([notifications](notifications.md)) and OS-delivered deep links on desktop
([OS deep links](deep-links.md)) do. The OS ingress accepts only the Buzz link
forms and binds them to the selected community; any other OS link fails
`invalid-target` through the same failure notice rather than being dropped.

Drafts, reading geometry and sidebar view intent remain domain-owned, outside
visit history. Saved sidebar preferences live in the relay session, not in the
mounted page; see [sidebar ownership](channels.md#ownership).

## Conversation contributions

`registerMessage({ id, title, matches, ownsAttachment?, component })` contributes an optional whole
message body. Components receive `{ message: ChannelMessage, canOpen, open }`; the first active
match wins, throwing matchers are skipped, and render failure/removal restores the
host body. Registration uses the same owned contribution lifetime as inline/link
renderers. The host retains author/time chrome, actions, attachments and session
ownership. `ownsAttachment(message, attachment)` lets the component claim the
attachments it draws itself: the host leaves those out of its list, keeps the
others, and lists every one again if the component fails. Claims count only
while the host draws that component; attachment-only and session-card-only
messages skip it, so their attachments stay listed. A throwing claim is false. `MessageRenderer` is a host-matched author-preview type, not event
admission or cross-version capability negotiation.

`registerMessageAction({ id, title, icon?, matches, component, marker? })` adds an
entry to a message's ⋯ menu. `matches(message, session)` decides per row whether
the entry appears; throwing matchers are skipped. `icon` renders beside the title.
Choosing the entry mounts `component` with `{ message, session, close, canOpen, open }` inside the
row, typically a dialog; it stays mounted until it calls `close()`. The optional
`marker` receives `{ message, session }` and renders beside the timestamp, such as a
state mark. It renders only while `matches` passes, so hiding the menu entry also
hides its mark. The host owns the menu, focus restoration and row lifetime: a row
with an open action stays mounted while it scrolls out of view. Icon, component
and marker failures each render nothing and leave the row and menu usable. The
bundled Reminders plugin is the first consumer.

The bundled **Diff viewer** (`buzz.diffs`) handles `ChannelMessage.diff` from legacy
kind 40008. Shared history, live, thread and exact readers retain these messages
independently of the plugin, preserving raw patches rather than interpreting them
as Markdown images or links. The plugin supplies an inline preview and expanded
Unified/Split dialog. Disabled/failed rendering, malformed/incomplete patches and
patches over the display parsing budget retain escaped raw text. Unconsumed
patch lines and unsupported binary payloads also fall back to the complete raw
patch; metadata-only rename/mode/binary summaries retain rich presentation.
Preview, file and raw scroll regions support native keyboard navigation. Diff
messages are not editable, including through the selected-message Edit shortcut.
Diff search remains deferred: the client accepts kind 40008 hits, but relays
whose search index allowlist excludes that kind cannot return them. Metadata is
untrusted presentation, not repository access authority. No sending, applying,
repository fetching or sidebar panels are added.

`registerLink({ id, title, matches, order?, className?, component })` contributes
optional presentation for links already recognized by messages. The host retains
the anchor, destination, new-tab/modifier behavior and panel activation. Components
receive `{ url }` and render non-interactive inline content inside that anchor.
They must not nest links or buttons. Among matching renderers the lowest `order`
wins under the panel [resolution order](#resolution-order); throwing matchers are
skipped. A render failure or plugin removal restores the ordinary link, including
its styling. Registration follows the existing plugin lifetime.

The bundled Links plugin uses blue text, a blue fill only on hover, 2px padding
4px corners, and service icons for GitHub, Google Drive, Figma, Notion, Slack,
Dropbox, OneDrive, GitLab, YouTube, Loom, Zoom and Teams. Google Docs, Sheets and
Slides use distinct file-type icons; unknown websites use a globe. Host matching
does not fetch metadata or infer a service from names in paths or query strings.
Its `order` is a function: recognised services and Buzz entities claim the default
band, the globe case the catch-all band, so a renderer dedicated to one website
wins it at the default.
It does not fetch titles. The bundled GitHub plugin contributes a pull request
renderer at a lower `order` for github.com pull request URLs: the same label
with the pull request's state (open, draft, merged, closed) as a coloured icon,
read with the person's `gh` sign-in or the public API and kept current while
shown. Repositories, issues and commits, and every pull request link when that
plugin is disabled, keep the Links presentation. If the renderer fails, a pull
request link shows as a plain link.
Messages currently recognize
credential-free HTTP(S) and supported Buzz links. Markdown labels preserve their
formatting, escaped pasted wrappers are normalized outside code, and paired `<…>`
autolink wrappers are hidden in display. Buzz links use known channel names with corresponding icons, falling back
to Channel, Message or Thread when that name is unavailable in the current community;
the full destination remains on the anchor. A raw message or thread link in a listed
channel reads as “<author> in #<channel>” once its author has a name, and a workflow’s
as “Workflow in #<channel>”; DMs, Solo chats, authored labels and drafts keep the channel
name. So does a message the lookup cannot find or read, whether deleted or not yet
replicated; it is looked up again when a link to it mounts again or the live stream
connects again. An author once found stays shown for the session, even after its message
is deleted. Buzz activation stays inside the host,
including modifier/middle clicks, even when the optional Links plugin is disabled.
Unsupported Buzz formats remain plain text. The host-matched author preview exports `LinkRenderer`; older hosts do not
provide `registerLink`.

Message hover/focus previews are host-owned. The entire card is a keyboard-accessible
link to the same destination, routed through the same host navigation handler. Opening a preview allocates the current
session's bounded thread reader; closing disposes it. A live message link borrows
the same reader only until it learns its author, and not when its channel’s timeline
already holds the message. Its reads take background admission, so opening or previewing
a conversation reads first. The reader supplies verified
message content, author and timestamp and preserves edit/deletion/access handling.
Previewing never acknowledges reading or switches community. The host offers a
resolved label to the bundled presentation via `LinkLabelContext`, and whether
the link is live or a composer decoration or preview via `LinkInteractiveContext`,
so a renderer reads nothing for a draft. A renderer that shows a status, such as
a pull request's state, describes the host anchor via `LinkDescriptionContext`,
so the link keeps its label or URL as its name; no author API
contract or relay protocol changes are required. Known channel references and
unambiguous signed person/agent mentions share the inline hover styling. Names in
ordinary prose never create notification intent or establish an identity.

`registerCodeBlock({ id, title, matches, component, action? })` contributes optional
presentation for a fenced code block. `matches(language)` receives the fence's
info-string language as written; `component` and `action` receive `{ code, language }`. The
host retains the code frame and its copy action, which copies the source; it
places the optional `action` control, such as an expand button, before copy. A
text selection spanning the block also copies its fenced source, not the
presentation.
Matching uses the same resolution as links without an `order`; throwing matchers
are skipped. A render failure or plugin removal restores the plain block, and
noninteractive previews always show the plain block. The bundled **Mermaid
diagrams** plugin (`buzz.mermaid`) draws `mermaid` blocks with
[Pele](https://pele.run), loaded on first use. Diagrams are untrusted content: Pele escapes
their text and the plugin disables diagram links, images and Pele's own zoom
controls. Its action opens the diagram in an expanded dialog, which zooms by
pinch, Ctrl/⌘-scroll, drag, double-click and keyboard and offers Copy code.
Invalid source shows Pele's error with the source.

The conversation preview exposes top-level `registerTool`, `registerCompletion` and `registerInline`
methods and stable `conversation.ui.Composer` / `.Message` / `.Thread` components, plus `.Tabs` while a plugin provides it. Generated
type-only `@buzz/author` declarations are exercised by a source-only external consumer
fixture in `tests/fixtures/conversation-consumer`; it is built and installed only in
the browser test's temporary profile.
`conversation.format` returns the host's date labels, so plugin text reads like
the message list: `itemTimestamp(seconds, { withTime })` for bylines ("9:05 AM",
"Yesterday at 9:05 AM"), `dayGroupLabel(seconds)` for day dividers ("Today",
"Monday"), `fullTimestamp(seconds)` for the full hover date, and
`relativeTimestamp(seconds)` for link previews ("5 minutes ago"). They use the
current locale and time zone; all but `fullTimestamp` take an optional `now`
for tests. They compute the label when called. `conversation.ui.Message` and
the host's day dividers re-render at local midnight; a plugin that shows these
labels in its own long-lived view must call them again when the day changes.
This remains a host-matched preview, not a stable cross-version SDK. Shared session
ownership and trusted-plugin authority do not change.

`conversation.ui.Thread({ session, scope, channelId, channelName, messageId })`
renders the existing `ThreadPanel` without its side-panel header, close control
or Escape dismissal; the page owns the surrounding header and placement. The
host supplies the rest of the Channels thread behavior: contribution renderers,
message management (edit, delete, mark read/unread, and a notice above the
thread to retry or discard a failed edit or deletion), session-channel
recipients, Buzz link navigation, and one modal at a time for a registered panel
or media review. The page passes its current ready session and stable
community/viewer scope; retargeting disposes the old thread and its modal. As in
Channels, showing a thread is one visit to its channel for unread state, and
that visit lasts across threads of the same channel. The page holds no second
message reader, cache or outbox.
Exact message links still navigate to Channels rather than the page's route.

`conversation.ui.Tabs({ id, session, scope, label, icon, children })` makes the
page's content the first main tab of the host's conversation tab workspace.
`children(open, close, isOpen)` renders that tab; `open({ channelId, threadId?, messageId? }, { keep? })`
shows a joined conversation in a host tab and returns false for any other. A
thread opened with `messageId` reveals that message and keeps it in view. A
thread opens as a side-pane thread tab and a whole conversation as a side-pane
conversation tab, each with the same reader and composer as Channels tabs, so
the page stays in view; any thread can then move to the main pane. A plain open
replaces the tab the previous one added, and `keep: true` adds a tab beside it;
an already-open conversation's tab is selected wherever it is. Each open moves
keyboard focus to the opened tab's composer (a thread's reply box, keeping any
reply target chosen in it) once it can take focus, unless the user clicks or
types first; an open at a message reveals it instead, and a tab restored when
the page remounts takes no focus. `close(target)` closes that conversation's tab, leaving focus to the page unless it opens a tab in the same update, and returns false when none is open; `isOpen(target)` says whether it has one, and a thread opened at a reply keeps its tab once its root resolves. `id` keys the page's tabs, which last for its community session as
Channels tabs do; they keep no Back/Forward visits. Showing a tab enters its
channel visit, as in Channels; `visits: false` leaves reading to the page, as
Inbox does.
The tab workspace belongs to Channels, which supplies it with
`conversation.registerTabs(component)`; the conversation service only holds that
slot. `ui.Tabs` is undefined while no enabled plugin provides it, so a page reads
it at render and falls back to its own layout.

`open({ channelId, messageId })` opens the conversation at that message. The
shared `useMessageOpening` reader waits for verified history (cached rows
decide nothing), reads older pages until the message loads (at most 25 pages
of 20 top-level posts) and mounts the list once, at the message; a reply, or a
message it does not find, opens as its thread in the same tab, scrolled to the
message. Each open asks again, even for the same message, but a tab restored
when the page remounts does not jump back to it. With `threadId` too, the
thread tab opens and scrolls to that message, again on each open. `open(target, { markRead: false })` makes a
conversation tab mark nothing read, so a page such as For You can keep the
posts beside the one it opened unread and mark that one itself; threads read
as they do in Channels.

### Composer ownership and mention tools

The standard composer is reusable host UI in `features/messages`, not a mandatory
Composer plugin. Page plugins may compose it through `conversation.ui.Composer`
(or source props), or build their own editor against the shared session. Built-in
Emoji and Mentions use the same `registerTool` contract as optional tool plugins.
No page imports their implementations. Optional numeric
`order` (default zero, lower first; ties by contribution key) keeps visual and
keyboard order stable across asynchronous activation and re-enable. Mentions uses
`-10` to retain its position before default-order tools such as Emoji. The host groups
negative-order tools with selected-recipient avatars, preserving DOM/keyboard order;
this is host layout, not a new plugin contract. Inline identity chips remain in the draft.

Links, channel references, selected mentions and custom emoji render through shared
message components directly in the editable draft. Display tokens retain the exact authored source;
copying and sending preserve that source. Arrow keys and deletion open adjacent
links for ordinary text editing. Partially deleting a link keeps it plain during
the editing session; double-click selects the link and triple-click selects its
whole paragraph. The host owns source offsets, plain-text paste, composition, undo and
selected recipient metadata. Token renderers are display-only while editing.
Names pasted as text never create notification intent.

Tools receive `insertText`, `insertMention({ pubkey, name })`,
`insertMentions([{ pubkey, name }, …])`, `replaceRecipients`, `insertResource` and `focus` commands,
and read-only `recipients`: the draft's selected mentions as `{ pubkey, name }` in
draft order, so a tool can act for whoever the draft addresses. There is one entry
per mention, so a person mentioned twice appears twice. Recipients the host adds
at send time, such as a Solo channel's sole agent, are not included. The array
keeps its identity until the recipients change.
Mention insertion atomically records visible text and exact notification intent;
`true` means the edit was accepted, **not** that membership or delivery succeeded.
The host serializes successive commands using the latest draft and selection,
enforces text/recipient limits, and revokes commands on tool removal/replacement,
editor destination/session change, disabled/read-only state and unmount. Names are
presentation, never recipient resolution. Editing/pasting over an identity span
removes its intent under the existing draft rules.
The batch command inserts several recipients, such as a team record's agents, as
individual recipients in one undoable edit. It deduplicates batch keys and rejects the whole edit if any recipient is
ineligible, or the resulting draft exceeds its text or 32-mention limit. While
editing an existing message, both mention commands insert identity references
without changing the original notification recipients.

`replaceRecipients([{ pubkey, name }, …])` changes the recipient set in one undoable transaction, preserving prose, formatting, focus and the mapped selection. Mentions that stay keep their names and positions, including duplicates; new recipients are inserted at the start. An unchanged set does not edit the draft, regardless of order. Removed mentions also remove one following space when present, leaving punctuation unchanged. An empty array clears selected mentions. Automatic replacement does not update recent-mention rankings. It uses the same admission and lifetime checks as insertion and rejects the entire edit for invalid or unavailable recipients or length limits. It returns false while editing a sent message. Plain-text names do not become recipients.

`replaceRecipientsIfEmpty` takes the same selection but rejects the change if the current draft contains non-whitespace text outside selected mention spans. Automatic targeting can use this guarded command when available. A false result must not trigger unrestricted replacement. The host checks the current draft at invocation, so a retained command cannot overwrite recipients after typing begins.

`insertResource({ uri, label })` inserts a host-owned inline reference to plugin
content, such as a repository issue or pull request. The host normalizes the label
(single line, at most 120 code points), requires a navigation-safe URI, and sends
exactly one ordinary Markdown link, `[escaped label](uri)`. No tags, recipients or
access grants are added; the receiving agent sees the link. It returns `true` only
when the draft accepted the atom, otherwise the host's user-facing reason (code,
another link, 32 resources, or message length), which the tool should show in place.
The atom is removed whole, restores without its plugin, and copies as its Markdown.
If later edits or restore would stop it from sending as that link (a preceding `!`,
surrounding backticks, code/link formatting), the host turns it into the ordinary
text that will actually be sent, as it does for broken mention intent.

**User intent outlives the tool that created it.** If the built-in Mentions chooser
is unavailable because activation failed, selected recipients, their inline chips
and avatar removal controls, scoped drafts and pending messages remain available.
Editing or deleting a selected mention removes
its explicit mention intent. Removing an avatar clears that identity's explicit
mention intent without changing the authored text. A Solo chat
still needs a tagged agent to send. The session
still owns roster/profile data, membership checks, signing and publication/retry.
Plugins remain trusted same-process code; revocable editor commands do not sandbox the session capabilities they receive.

This preview is host-matched: a tool using `insertMention` needs a host providing
that command. The generated type-only `@buzz/author` package and `apiVersion: 1`
are not runtime capability negotiation or cross-version compatibility promises.

### Composer completion providers

Emoji, Mentions and Channels each register a separate `registerCompletion` contribution.
The host observes focused, enabled textarea text and collapsed UTF-16 selection,
then chooses the valid syntax match closest to the caret (greatest range start),
with `order` and contribution key breaking ties. This lets a later emoji trigger
win over an earlier multi-word mention query. Matchers
must not depend on asynchronously arriving session data: the winning component owns
reactive roster/profile/catalog filtering. Only that component mounts. An empty
result without status/retry hides the menu while keeping the provider subscribed.
Before the first publication the menu is also hidden: syntax matching is not evidence
of loading. Providers must publish an explicit status for actual pending work. Escape
still revokes unpublished work, without exposing ARIA controls for a missing listbox.

Providers receive immutable observation/range evidence and `publish(result)`—not
DOM, focus or replacement commands. Results contain stable IDs, labels, optional
detail/decorative previews and either text, an exact `{ pubkey, name }` mention,
or a `mentions` array of up to 32 such recipients. Batch edit primitives are
copied and frozen before display, and accepted as a single editor transaction.
The host copies edit/query primitives and caps publications at 50 choices. A
publication returns its own withdrawal disposer (or `false` after revocation).
Providers must withdraw synchronously when the data supporting a displayed choice
changes, and republish from the new snapshot; unrelated notifications must not
leave a withdrawn result without pending work. Cleanup cancels asynchronous work.

The host binds callbacks to the exact contribution, editor revision and query.
Edits (including same-text input), selection changes, blur, composition, disabled
state, plugin replacement, destination/session change and unmount revoke old work.
Acceptance rechecks the actual DOM text/caret/focus and atomically replaces the
query through the existing mention-draft path, retaining its text/recipient limits.
Typing/pasting a name alone never creates notification authority. Accepted mention
intent survives optional plugin removal and remains subject to session validation.

One host-owned, viewport-bounded portal renders the active listbox. Focus stays on
the textarea with `aria-controls`/`aria-activedescendant`; arrows follow stable IDs,
plain Enter/forward Tab accept, and Escape dismisses pending results. A typed
terminator accepts the provider-verified unique exact match: plain Space for a
mention, the closing colon for an emoji shortcode. Emoji publishes an exact-match ID
only after both Unicode and community catalogs successfully settle. The editor refuses
typed terminators in rich or raw Markdown literal ranges; colon conversion records the
typed source first so undo restores the closing colon and collapsed caret. A rejected
displayed choice must not fall through to sending. Retry is a selectable menu action
using the same arrow/Enter/Tab path, including when there are no results. Modified
keys, Shift+Enter/Shift+Tab and IME events retain ordinary editing behavior.

Emoji lazily copies native-only records (including aliases and keywords) from the
pinned data package; it does not use Emoji Mart's mutable global search singleton.
Community matches come only from the current session catalog. Mentions performs
bounded background enrichment through the shared profile directory, not per-key
network reads or a separate identity cache. Multi-word filtering stays in the
provider so a delayed name can appear without another editor event.

Channels filters the session's joined channel roster locally, including private
channels and joined channels restored from cache (the store marks those
`readOnly` and `cached` until the relay reconfirms them), but excluding DMs,
sessions, archived, hidden, unnamed and other read-only entries. After a 300 ms
typing pause, a query also asks `searchPublic`, through the same
`usePublicChannelSearch` hook as Command-K, for open channels the viewer has not
joined; they are labeled "Not joined", and private results are never offered.
The relay has no name search, so that lookup covers only its newest page of
channel metadata, which the store reuses while the viewer types. While the next
lookup runs, the previous one's still-matching rows stay. Names match by the
channel pickers' rule (`matchName`): exact, prefix, word start, substring,
then letter runs that each begin a word (`tlp` for `team-launch-planning`), with
alphabetical ties. Its last rank, letters merely in order, is left out, because
Enter and Tab pick the first row while the viewer writes prose. The same rule
applies to open channels from the lookup. Open channels follow joined ones, as in
Command-K, so a late search result never moves the first row; when joined
matches would fill the 20 rows, five stay reserved for open channels. Namesakes
include their channel IDs. A query containing a space completes only names it
prefixes, as person names do, so ordinary prose after `#name` closes the popup.
Empty ready results hide the popup. Loading (only while the channel list is
loading), open-channel search and explicit error/retry states stay visible; a
failed open-channel search keeps joined matches and offers a retry. When the
search covered only the newest page and found no open match, a note says so
beside the rows already shown. Selection rechecks current membership (or the
public preview) and name, then inserts an escaped, ID-backed Markdown link
without notification recipients.
The shared editor host checks raw Markdown and rich code/link/literal ranges only
after a Channels syntax match, keeping suggestions in prose (including headings).
Ordinary typing skips that extra context scan. Popup positioning and keyboard/IME
behavior remain host-owned; no new completion API or editor command is introduced.

This is the same host-matched preview as toolbar tools, not version negotiation or
a sandbox. Inline mention pills remain outside this completion implementation.

The optional bundled `buzz.voice-notes` plugin registers a microphone tool and
an attachment renderer. `capture(component)` gives the tool a revocable composer
surface with `accept(recording)` and `cancel()` commands. Disabling the plugin,
hiding the conversation, changing destinations or entering read-only mode stops
unaccepted recording. Accepted recordings belong to the existing attachment draft,
so navigation or plugin removal leaves them available with host fallback controls.

The existing native and browser upload adapters prepare `voice-note-*.wav` files
as the old Buzz H.264/AAC MP4 envelope. Voice Notes adds no uploader, signer or
outbox. Files upload on Send, retain the shared progress/recovery behavior, and
carry bounded duration and waveform metadata through ordinary `imeta` tags.
Recordings stop at five minutes. Pending files have the same tab-local lifetime
and limits as other attachment drafts; they do not survive app restart.

The player loads audio on Play, supports seeking and playback speed, and pauses
when its conversation is hidden. Existing voice notes are recognized from signed
filename metadata even when their Markdown label differs. Notes without waveform
metadata retain a neutral waveform. Disabling the plugin restores ordinary audio
cards. The fixture at `/tests/fixtures/voice-notes.html` exercises the real recorder,
composer and session with disposable local media; browser tests provide its local
media response. Native microphone permissions were exercised in the staging app.

## Desktop browser

Plugins can render the host-provided [`browser.View` component](browser.md) inside a panel. It opens HTTP(S) pages beside the conversation on macOS desktop. The host owns website rendering, navigation controls, and native session cleanup. Remote pages receive no Buzz IPC bridge; plugin JavaScript remains trusted same-process code. The [capability guide](browser.md#try-the-capability-with-a-local-plugin) includes a complete local-plugin example and installation steps.

## Decisions

The host composes one `DecisionsService` in `app/services.ts`. Plugins, bundled
or external, declare `inject = ["decisions"]` and call `ctx.decisions.decide`
to ask typed questions about a piece of text. One provider answers every
question in one call:

```ts
import type { Context } from "@buzz/author";
export const inject = ["decisions"];
export async function apply(ctx: Context) {
  const result = await ctx.decisions.decide({
    state: "The build is broken on main.",
    questions: {
      urgent: { type: "yes_no", instructions: "It needs attention now." },
      topic: {
        type: "choice",
        instructions: "What is it about?",
        options: { build: "CI or builds", other: "Anything else" },
      },
      severity: { type: "score", instructions: "How severe?", levels: ["low", "medium", "high"] },
    },
    timeoutMs: 5_000,
  });
  if (result.outcome === "answered") {
    const urgent = result.answers.urgent; // { type: "yes_no", probability }
  }
}
```

A request has 1 to 32 questions, keyed by an answer name of at most 64
characters. `choice` takes 2 to 255 options (value -> when to pick it); `score`
takes 2 to 10 level labels, lowest first. A `yes_no` answer is a probability;
a `choice` answer is the picked value with its confidence; a `score` answer is
where it falls on the 0-based scale (it can be fractional), with a confidence.
Probabilities are 0 to 1. `timeoutMs` is clamped to 1 to 30 seconds.
`community` is the Buzz community (its relay URL) the text comes from. A
provider that bills the community, such as Builderlab, refuses a request
without one (`invalid_request`); TypeSafe ignores it.

`decide` never rejects. It resolves with `{ outcome: "failed", reason }` when
no decision provider is on (`unavailable`), the chosen provider has no
saved key or sign-in (`missing_credentials`), the provider refused it
(`unauthorized`), the questions are malformed (`invalid_request`), the request
is over 128 KiB (`input_limit`), or the call times out, fails, or returns
answers that do not fit the questions. A failed call is not retried and never
falls back to another provider.

Agents ask through the `decisions_ask` tool, which the Agents plugin adds to
every agent session (`src/features/decisions/agent-tool.ts`). It takes and
returns TypeSafe's [System One format](https://docs.typesafe.ai/api/system-one.md)
(`noul`, `choice` and `score` questions with `criteria`), maps it onto
`decide`, and sends the agent's community. It has no `model`, images, box
questions or `usage`: the provider the owner chose answers. A failure is a tool
error that names the reason and what the owner can do about it. Agents on a
device have at most 4 calls in flight at once, so Attention's classifier keeps
most of the native client's 16 slots.

### Decision providers

Providers are plugins too. A plugin offers one with
`ctx.decisions.registerProvider`; it is listed under Settings > Decisions API
while the plugin is on, and removed when the plugin stops or calls the function
`registerProvider` returns:

```ts
import type { Context } from "@buzz/author";
export const inject = ["decisions"];
export function apply(ctx: Context) {
  ctx.decisions.registerProvider({
    id: "example",
    label: "Example",
    description: "Use your Example account.",
    status: () => "ready", // or "checking", "unconfirmed", "needs-setup"
    subscribe: (listener) => () => {}, // call listener when status changes
    async decide(request, { signal }) {
      // request is already checked and has its timeoutMs; signal aborts at it.
      return { outcome: "answered", model: "example-1", answers: {} };
    },
    Settings: ({ active }) => null, // shown while this provider is selected
  });
}
```

The host owns everything around the call, so every provider is held to the same
rules: it checks the request against the limits before any provider sees it,
stops waiting at the deadline, turns a throw into `service_error`, and checks
the reply. An answer of the wrong type, an unknown choice, a value outside 0 to
1 or a missing answer makes the call `invalid_response`; answers to questions
that were not asked are dropped.

The user chooses the provider in Settings > Decisions API, and the choice is
kept on this device. Until they choose, the first default provider that is on
answers: Builderlab (`block.builderlab/builderlab`), then TypeSafe
(`buzz.typesafe/typesafe`). The same holds while a chosen default is not on.
Decision text can include private messages, so no other provider gets it
without that choice: while a chosen provider that is not a default is not on,
decisions are `unavailable` and are not sent to another provider. `ctx.decisions.backend()`
is the answering provider's key (`<plugin id>/<provider id>`), or undefined
when none is on, and `ctx.decisions.status()` its status. `Decisions` exposes
no way to choose the provider. `state` and every question go to the provider,
so send only what the decision needs.

| Provider | Plugin | Credentials |
|----------|--------|-------------|
| `buzz.typesafe/typesafe` | TypeSafe (bundled, on by default) | The user's TypeSafe key, kept and read only by native code (`src-tauri/src/decisions.rs`) |
| `block.builderlab/builderlab` | Builderlab (bundled, in desktop builds with a Builderlab); registered only while the user is signed in to an account Builderlab allows decisions for | The user's Builderlab sign-in, which native code sends with each call. Builderlab answers with Jev and bills the request's `community`; its server allows up to 32 questions per call |

## In-app keyboard shortcuts

The host composes one `ShortcutsService` in `app/services.ts`. Plugins declare
`inject = ["shortcuts"]` and call `ctx.shortcuts.register(shortcut)`; their bindings
use the same matching/dispatch rules as host-owned Settings and interface sizing.
There is no OS-wide hotkey registration, native accelerator API, or command bus.

```ts
import type { Context, Shortcut } from "@buzz/author";
export const inject = ["shortcuts"];
export function apply(ctx: Context) {
  const shortcut: Shortcut = {
    id: "show-details",
    title: "Show details",
    binding: { key: "k", mod: true, shift: true },
    // Optional Settings presentation order within this plugin's category.
    order: 10,
    when: () => detailsViewIsAvailable(),
    run: () => showDetails(),
  };
  ctx.shortcuts.register(shortcut);
}
```

`binding` is one binding or a nonempty array of aliases. `key` matches the logical
`KeyboardEvent.key` case-insensitively, not a physical `code` (Space is `" "`,
not `"Space"`). `mod` means Command
on Apple platforms and Control elsewhere; Shift/Alt and the other primary modifier
match exactly. IME/AltGraph events and already-prevented events are never consumed.
The window listener runs in the bubbling phase, after local editor handlers.

By default bindings do not run in editable targets (including open Shadow DOM),
while a dialog is open, or repeatedly on a held key. Explicit `allowInEditable`,
`allowInModal` and `repeat` opt in; `when` checks current eligibility without
re-registering. `run` may return a promise; throws/rejections are logged and isolated.
Only a selected binding prevents the browser default. An eligible held binding
still prevents the default when its repeat handler is suppressed.

IDs are namespaced by installation. Only active revisions participate; disable,
failed activation, replacement and Cordis disposal remove eligibility. Plugin ties
are resolved by ascending namespaced ID, independent of activation order. Host
bindings are reserved even while unavailable (Settings does not navigate behind a
modal). `snapshot`/`subscribe` expose ready plugin registrations, not host bindings
or a promise that every binding wins every current focus conflict. The host-only
registration method is deliberately absent from the injected type contract; plugins
remain trusted same-process code, not sandboxed adversaries.

`order` is optional and defaults to `0`. It controls only the row order in Settings
within this owner's category; lower values appear first. Every bundled plugin
assigns deliberate values to its actions (for example, a primary action starts
at `10`), leaving gaps for related actions to be added later. Equal orders use
the stable namespaced contribution key (`pluginId/shortcutId`), then title, as
presentation tie-breakers. The core Buzz host category uses the same metadata
and a host-owned functional sequence: navigation, interface sizing, search/settings,
then development-only actions. Host rows use their bare IDs for tie-breaking.
Presentation order does not affect dispatch precedence, and
shortcuts with duplicate titles remain separate rows because registry keys—not
titles—identify bindings and their overrides.

See [`shortcut-counter`](../examples/plugins/shortcut-counter/README.md) for a
self-contained external plugin using the real service without a DOM listener.
The generated type-only `@buzz/author` exports `Shortcuts`, `Shortcut`, `KeyBinding`
and `RegisteredShortcut`. This is a host-matched preview: older hosts without the
`shortcuts` capability cannot activate such a plugin. `apiVersion: 1` alone is not
runtime feature negotiation. Multi-key chord sequences and command palettes are
outside this initial contract.

Users can rebind any registered shortcut in Settings → Shortcuts without plugin
changes. The page lists host bindings and every active plugin contribution from the
dispatcher's own `hostSnapshot`/`snapshot` registries, grouped by owner, so it
cannot drift from what fires. Overrides live in the host-owned device-local
`buzz-shortcut-bindings.v1` preference, keyed by the registry identity the
dispatcher already uses: the bare id for host bindings and `pluginId/id` for plugin
contributions. The dispatcher resolves the effective binding at match time, so a
plugin keeps registering its default and never sees, stores or re-registers for
an override; the override follows the plugin across disable, re-enable and
replacement, and an override whose owner is no longer installed is ignored rather
than deleted. Rebinding replaces an alias set with the single chosen chord; reset
restores every alias. On Apple platforms a binding may add Control (`ctrl`) beside
Command, as in ⌃⌘A Archive chat; elsewhere Control is `mod`, so a `ctrl`
binding never matches there and capture never records one. Host chords stay reserved: the page refuses to assign a chord
that another listed shortcut already uses, host or plugin, refuses the copy, cut,
paste and select-all chords (and close-window/quit in the desktop build) because a
match would prevent their default everywhere, and warns when a chord is one the
message editor handles locally. A conflict can still appear after capture, for
example when a plugin that was disabled at the time is re-enabled with the same
default or a new plugin ships one; the dispatcher then resolves it silently, so
each affected row shows an "Also used by …" line naming the others. A malformed
stored override falls back to the registered default rather than stopping
dispatch. `formatBinding` in
`features/shortcuts/format.ts` renders any `KeyBinding` for the current platform;
plugins that print their own hint (the bundled terminal does) show their registered
default because overrides are host state. Xterm is the intentional local-first
exception: before translating a keydown into PTY input, it synchronously forwards
the original event to this same dispatcher through a private DOM handoff. Eligible
app shortcuts (including live rebinds) win there; unhandled keys stay with xterm.
No plugin shortcut API or preference access is added. Ordinary editors continue
to handle keys before the window's bubbling dispatcher.

Slack-style message keys are host bindings. In an empty composer, Up selects the
newest message (by id, not tree order) of the timeline or thread sharing its edit scope (on macOS ⌘↑ keeps editing
the latest own message directly; elsewhere use Up, then E); a selection is
DOM focus on that message's box (`features/messages/message-selection.ts`), so
the timeline's Virtua keeps the row mounted and assistive technology follows it.
Membership notices and folded or collapsed rows are skipped. While a message
itself is focused, Up/Down move between rendered messages, Down past the newest and
Escape return to the composer (a handled Escape does not also close the thread),
and Up at the oldest rendered row stays native so history can load. When the
timeline is scrolled far enough that the newest message is unmounted, Up from the
composer keeps its old edit-last behavior, Down at the last rendered row scrolls
natively, and ⌘⇧\ does nothing rather than act on an older message. E edits a selected eligible own message through the scope's
editor, R opens the row's reaction picker through the host-owned
`[data-reaction-tool]` trigger, and ⌘⇧\ selects the newest message in the focused
pane, even from another selected message, and does the same. T or → clicks the row's Reply action (open or answer its
thread), U marks unread from it (`useMessageKeyActions` in `MessageManagement.tsx`,
the menu's own call), and Delete or Backspace opens the menu's delete confirmation
for your own message; agent-owner deletion stays in the menu because it needs
ownership evidence a key cannot wait for. Remind me (M) has no key: plugin message
actions have no binding in their contract. Single-letter bindings never run in
editable targets. ⌘1–⌘9 select the community switcher's entries in its order
(⌘1 is Personal space) and ⌘⇧] / ⌘⇧[ step through them, wrapping
(`app/shell/CommunityShortcuts.tsx`); Ctrl+Tab stays Buzz's tab switching.
⌘T opens Search Buzz as a default alias of ⌘K (Slack's switcher answers to
both); a shortcut may ship several default chords, and Settings → Shortcuts lists each
distinct one ("⌘K or ⌘T") while showing layout aliases of one physical key (⌘=
and ⌘+) once, but a Settings rebind replaces them with one. Plain-Escape
dismissals (thread, panels, drawer, plugin details) ignore Shift so ⇧Esc reaches
Mark all as read. The message editor's own keys (`composerFormats` and `linkBindings` in
`features/messages/composer-dom.ts`, plus undo, redo and new line) are listed
read-only under Message formatting, which says once under its heading that they
belong to the editor; the editor matches them before any shortcut,
so rebinding a shortcut onto one warns. Slack's ⌘⇧C (code), ⌘⇧9 (quote), ⌘⌥⇧C
(code block) and ⌘⇧U (link) are aliases of Buzz's chords. ⌘/ opens Settings →
Shortcuts, which is built the first time it is shown rather than with every
Settings open. ⌘⇧Y opens Set a status while the profile menu
can (the message editor keeps it as Redo). Home is on the placeholder ⌘⇧O while
⌘⇧A opens Inbox's unread view. Inbox's ⌘⇧A, ⌘⇧T, ⌘⇧M and ⌘⇧K are ordinary
`buzz.inbox` plugin contributions, so they follow the plugin precedence above: a
plugin whose namespaced ID sorts first and claims the same chord wins it while
eligible. Settings → Shortcuts marks such rows "Also used by"; rebinding either one
resolves it.

Known limitations. Capture and matching both use the logical `KeyboardEvent.key`.
On macOS an Option chord reports the composed character, so Option+K is stored
and shown as `⌥˚`, and Shift+digit chords store the punctuation (`!` rather than
`1`). This is internally consistent, so the binding fires, but it depends on the
active keyboard layout and the displayed chord can differ from the keys pressed.
The intended fix is to match Alt/Option chords on the physical `event.code` in
both the capture control and the dispatcher's `matches`, which is a coordinated
change to the plugin-facing matching rules and is deliberately not part of the
Settings page.

Native agent hook callbacks are described in [Agent hook callbacks](agent-tool-hooks.md).
