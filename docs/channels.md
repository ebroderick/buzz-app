# Channels, relay data, and plugin panels

## Run the integration

Configure your public `BUZZ_DEV_VIEWER` pin in `.env.local` using the
[development setup](contributing.md#live-relay-development), then run `just web` or
`just desktop` (one at a time); the development broker starts with the dev server.
Join a community using the community picker, open Messages and click a supported GitHub URL in a message to open its object
in a side panel. Pull requests show their change summary and a one-page checklist
of checks, reviews, unresolved threads and merge state; issues, commits, and
repositories show their relevant details. On desktop, the panel reads through the
signed-in `gh` CLI, so private repositories you can see load, and pull requests
can be merged, marked ready or converted to draft, set to merge automatically and
have their branch updated, as your GitHub account. Without `gh` (on the web, or
when it isn't signed in), the panel reads GitHub's public API and offers no
actions. Private or unavailable objects and API limits show an explanation with a
direct GitHub link. File and branch links continue to open normally.

Descriptions support GitHub-flavored Markdown with inline images, video, and
audio. Other files remain links; media that cannot load keeps a fallback link.
Use **Open on GitHub** for attachments that require repository access.

On desktop, an ordinary click on an unhandled HTTP(S) link with
`target="_blank"` uses the native Tauri opener to launch the default browser,
including attachments and **Open on GitHub**. A plugin that handles the click prevents that fallback; disabling
GitHub restores it. The main-window capability allows only HTTP(S) URLs, not
arbitrary file paths or application commands. Web keeps ordinary browser link
behavior. Adding the native opener requires rebuilding/restarting desktop;
frontend hot reload alone is not enough.

HTTP(S) links rendered in messages expose **Open in browser** and **Copy link**
on right-click or long-press, or with Shift+F10 / the Context Menu key while focused.
**Open in browser** uses the same `_blank` fallback above without consulting pane
handlers; both actions retain the original URL, including query and fragment.
Normal and modified clicks are unchanged. In Messages, `buzz://` message links
expose **Open link** and **Copy link** the same ways. **Open link** opens the
linked thread as a tab in the current channel's workspace without navigating;
another channel's thread uses the side pane. When that channel isn't readable
there, it opens as a click would. Other internal `buzz://` links and links outside
message content retain their existing behavior. Copy failures show a dismissible
notice and can be retried from the link menu.

Settings independently enables/disables Channels and GitHub. Disabling GitHub
removes its link handler and open panel; shared channel data remains available.
Channels is required by the current host; optional page removal does not dispose
the app-owned sidebar or session data.

The broker uses the existing authorized Buzz identity in the OS secret store (macOS
Keychain, Linux secret service) and
signs authenticated reads and channel messages in Node. In this broker mode no
private key reaches browser JavaScript; there is a bounded message-signing and
publishing endpoint. The broker is restricted to loopback hosts, same-origin
POSTs, valid Nostr kinds/event IDs, and bounded filters. Without a configured
`BUZZ_DEV_VIEWER` pin, native macOS offers [identity setup](identity.md); web and
unsupported native platforms retain the unavailable shell. The separate native
import/reveal/copy UI deliberately passes private strings through JavaScript.
Packaged builds do not include the development broker. A saved native identity
does not enable relay access: join and community profile editing stay unavailable.
The broker supports explicitly scoped typed relay origins;
see [destination routing and trust limits](communities.md#development-broker-boundary).
This is not a new native login.

## Ownership

- `app/services.ts` constructs client/community, pages, and panels services.
  See [community ownership](communities.md) for selection and join lifetimes.
- `features/relay` owns the [session query core](relay-queries.md), shared profiles,
  and retained channel snapshots. Components use
  its React hooks without creating connections or owning persistence.
- `features/panels` owns target resolution and panel rendering. Panels receive
  `{ target, close }`; their plugins inject additional capabilities as needed.
- `features/messages` owns reusable `ChannelTimeline`, `MessageRow`, `ThreadPanel`,
  `MessageComposer`, delivery presentation, styles and reading geometry. They accept
  ordinary props over the shared session; none owns a connection or outbox.
- `features/channel-navigation` owns the persistent sidebar and its scoped UI handoff
  for Solo drafts and preparing DMs. App composes it beside independent pages;
  sidebar actions use the normal navigation controller. It reuses session capabilities
  and existing sidebar components without another relay/cache or plugin registry.
- `bundled/channels` owns page registration, conversation selection/navigation,
  diagnostics, layout and panel placement. `shared/view-state.ts` partitions persisted
  drafts and view intent by community/viewer scope.
- `bundled/github` registers and implements the panel. Channels uses the panel
  contract and does not import the GitHub implementation.
- `plugins/contributions.ts` owns registration identity, readiness, and disposal
  for both extension points.

See [plugin architecture](plugin-architecture.md) for the authoring contracts.
To build another page, follow `bundled/channels/index.tsx`: declare injected
capabilities, register the page, and pass those capabilities to its React tree.
Keep page-specific navigation and arrangement in the plugin; compose shared message
components rather than copying them. Session reconciliation, authorization, retained
reads and durable outbox recovery remain host-owned even if Channels is disabled.

The sidebar and Channels workspace React keys include community/viewer scope **and**
connection generation. This resets their session-owned state on switching or
reconnecting, not unrelated page drafts;
drafts, channel selection and reading geometry retain their stable scope keys.

Saved sidebar groups, ordering, assignments, stars, mutes and sorting live in the
session's `sidebarPreferences` snapshot, not in the mounted Messages page. `ensure()` shares
one initial read; `refresh()` explicitly reloads/retries while retaining the last
good snapshot through loading/errors. Page exits neither restart nor cancel that
read. Cache clearing and session disposal cancel it and discard decoded data;
late completion cannot repopulate a retired snapshot. These are account-owned
preferences, not channel access grants: sidebar sections still intersect the
authorized roster. Local-first launch also restores a display-only copy from the
existing account/relay-scoped device store; this does not add automatic cross-device sync.

The development broker and packaged native host expose narrow **Mute/Unmute** commands. Each
re-reads the viewer's signed encrypted `channel-mutes` coordinate, changes only the
requested entry, publishes through existing relay admission, and confirms via
readback. The development broker publishes through its existing authenticated live
socket, scoped to the requesting session/community; a missing or disconnected owner
fails without HTTP fallback or automatic replay. Packaged native uses the signed
`POST /events` writer and never automatically replays an unconfirmed write.
Unrelated fields and explicit unmute tombstones survive. Invalid, unreadable, or over-budget heads fail closed; only a successful absent-head read
can seed a record. Same-host writes serialize per relay. This is confirmed
whole-record replacement, not atomic cross-device merging or a durable outbox;
simultaneous writers on different hosts can still race. Failure requires explicit
retry. Group/star writes use their separate narrow commands;
[section sorting](#sidebar-sort-persistence) uses its separate preference coordinate.

Rows expose mute/read actions through right-click/long-press, Shift+F10, or the
Context Menu key. They extend the persistent sidebar’s existing menu after
**Move channel**; DM removal stays separate.
Mute closes immediately and optimistically changes the next menu action, not
unread truth or notification policy before confirmation. Failure rolls back to
confirmed state and shows an app notification with Retry (same intent) and Dismiss.
Newer clicks supersede older completion UI; session-owned writes and sidebar
pending/error presentation survive page switches. Session replacement discards
that presentation. Cache clear/disposal abort
pending work but cannot retract an accepted relay publication.

Mark as read delegates to the [durable unread owner](unread.md), without selecting
the row, and closes after the local transaction commits. Observed unread or a
manual mark offers **Mark as read**; otherwise the menu offers **Mark as unread**
with its device-only tooltip. An open menu subscribes to the shared projection,
without fetching history or inventing exact counts. Read errors remain in-menu
for explicit retry. Focus resolves the current row by identity even if saved
preferences relocated it during the transaction. Read actions require
`frontier-sync`; hosts lacking mute writes keep read-only preference projection.
The packaged host decodes verified self-encrypted sidebar records and signs
only validated sidebar coordinates; it uses its signed HTTP writer and confirms
via readback. Sidebar records and channel recipes share kind 30078, so that
writer selects the admission contract by the event's `d` coordinate: the five
sidebar coordinates must match what the sidebar signer produces, and every
other coordinate must satisfy the recipe contract.

Move channel, Create new, exclusive Starred placement and startup presentation also
belong to this persistent sidebar. Rows in saved groups, **Starred** and **Channels**
can also be dragged with a pointer onto another saved group, **Starred** or
**Channels**; the drop is the same Move intent, with the same gate, optimistic
placement, rollback notice and Retry.
The **Channels** ellipsis menu also offers **Create section**, which creates an
empty section without moving a channel. Its dialog retains the name and section
ID after an attempted write fails and waits for confirmation before closing.
The submitted name stays read-only and focused; a rejected gate that attempted
no write leaves the draft editable. Failed confirmation uses plain copy and
offers Retry preferences whenever preferences are unavailable, with Create
disabled until recovery. After a failed creation,
the session refreshes preferences from the writer before allowing dismissal so
an accepted save stays visible even after Cancel. If that read fails too, new
creation is gated across menu, drop and create-and-move paths, and Retry retains
writer routing until reconciliation succeeds. Recovery waits for all queued
preference writes and repeats a writer read invalidated by a concurrent write.
Ordinary startup remains replica-eligible. Dragging a channel into
the gap above the first custom section expands an **Add to new section** drop
target inside the sidebar. With no custom sections, the target is above
**Channels**; **Starred** keeps its pinned position. The created section appears
at that same first position. The target stays revealed for the rest of that drag, with
reduced motion opening it immediately; other section destinations remain available.
Dropping there opens the existing create-and-move dialog; cancelling leaves the
channel in place, and no preference is written until submission. These entry
points supplement the per-channel **Move channel → Create new…** route and use
the existing gated preference queue and encrypted section record.
Only a channel's select surface starts a drag, the surface its row menu wraps.
**Starred** accepts drops only when it is already visible; starting a drag does
not reveal an empty section. Use the row menu to star the first channel.
Dropping into Starred stars the channel; dropping out assigns the destination
and clears its star, just like the row menu. Forums and Direct
messages take no part in dragging, and the row menu remains the keyboard path.
A saved group also drags by its header, expanded or collapsed, onto another saved
group; an accent line shows where it lands, and Escape cancels. Its section menu's
**Move up** and **Move down** are the keyboard and single-pointer path. Each move
rewrites every live section's `order` register with one stamp, so channels, sort
and collapsed state stay with the group's id; the order shows optimistically and
a failure rolls back with the same move notice and Retry. **Rename section**
in the same menu rewrites only that group's `name` register (a dialog keeps the
entry and shows the error if the save fails), so its channels, order and sort stay
put. The
session serializes placement, sort and mute writes through one queue, retaining
one confirmed preferences snapshot beneath
pending Move and Sort projections. Each confirmation updates only its owned fields
before reapplying pending intent; failure cannot roll back unrelated confirmed
state. Field-only confirmations cannot recover a failed full preference read or
hide its Retry. Move stays gated until that read succeeds. Mute optimism remains
presentation-only; notification policy continues to use confirmed mutes. This
composition does not change the whole-record cross-device limitation below.

Sections collapse and expand through their headers; the ellipsis menu does not
repeat that action. Collapsed section keys and sidebar scroll remain separate, scoped view intent.
They survive page switches in the same mounted sidebar, are saved when that
sidebar exits its session, and restore before paint when the roster and groups
are available; navigation history does not own them. Search lives in the top-bar
palette; legacy sidebar filters are ignored. Each section's ellipsis menu offers
**Filter → All, Unreads, Active in the last**. Unreads shows channels with observed or
manually marked unread messages or unread thread activity. Muted channels with retained unread backlog remain eligible even when their ordinary sidebar cues are quiet: mute does not mark messages read. Active in the last opens a compact,
content-sized dialog with visible 1-, 7-, 30-, and 90-day text-only radio tiles in two columns.
Apply saves the selected rolling window and activates the filter;
Cancel leaves the saved choice unchanged. The dialog retains its draft after a
failed save, and the menu shows the selected window. Activity uses verified timestamps, including your own messages once the relay accepts them. Channels with unknown activity remain visible until their activity is read. Activity applies in one update when a read finishes; a read that fails partway still applies what it read, and channels it did not reach stay available alongside the activity Retry warning. These filters are encrypted account preferences on the current relay, using a
separate kind-30078 `channel-filter` record. They leave saved sorting and section
membership unchanged; earlier device-only filter choices are ignored, not automatically published.
Filtered sections with no visible channels show only their header, retaining their expanded/collapsed state and menu access to hidden channels.
The currently open channel remains visible in its section regardless of its filter,
however it was opened. Navigating away removes that exception. When a filter hides
channels, the **Filter** submenu appends those eligible channels below its three
options and a separator, in the existing section order; choosing one opens
the section and channel without changing the filter. Choices reuse the sidebar's
channel-type icons, unread emphasis, attention/thread dots and working-agent
indicators. The temporarily visible open channel is excluded. Empty filtered sections retain
their header and menu so the filter can be changed or a hidden row opened.
Read-only hosts disable the filter choices while keeping hidden-channel navigation available. The saved-groups
browser regression records every visible return frame and holds the redundant
decode path, so eventual restoration cannot conceal a fallback-group/scroll jump.

Channel row actions share one sidebar-owned `ContextMenuRoot` / `MenuPopup`, labelled
`Actions for <channel>`. **Move channel** comes first when placement is writable; additional sidebar actions
should extend that popup, with a separator only when another action group follows.
`ChannelSidebarItem` owns the context trigger inside its memo boundary, using stable
`onOpenMenu` props. It wraps the activity select surface rather than merging popup
props onto the activity button.
The popup and trigger are enabled only when `rowActions` supplies actual items;
each action owns its eligibility, so one action's availability never gates sibling
actions. `useChannelRowMenu` owns channel id, the full rendered section key
(`starred`, `channels`, `group:<id>`, etc.), and the keyboard anchor. It clears
that state if the row leaves that section or loses its last action; moving back
or restoring eligibility does not reopen the menu. For future group commands,
derive the saved group id separately from `group:<id>` rather than conflating it
with rendered placement.

Sidebar create-channel dialogs stay available on other pages. Channel admission
(creation plus verified viewer membership) is fenced to the originating relay
session and navigates to a normal conversation destination. Create does not
recover attempts. A failed or uncertain admission shows its error and leaves the
form editable. Creating again with identical details republishes the same signed
Create event, with the same UUID and signature, so a delivered first attempt is
not duplicated; changed details abandon that attempt and sign a new one. Closing
the dialog forgets the attempt and dismisses its Outbox entry. Nothing restores
after reopening, reload or session replacement, so a stale Create can never lock
the form; an entry left behind by a reload stays unretried in the Outbox. Setup failures after admission produce a dismissible notice
without navigating again; setup is never continued in the background. New-chat intent uses the Channels version-1
page route `{ kind: "solo-draft", project?, agent? }` (see [Solo](solo/README.md));
only that intent, never draft text, enters history.
Preparing-DM suppression captures the pre-open roster and exact member set, hiding
only newly prepared DMs until confirmation; leaving New message or replacing the
session clears that handoff. Timeline readers and reading leases stay in visible
conversation content and unmount when leaving Messages.

## Sidebar sort persistence

Each sidebar section can independently select **A–Z** (the default) or **Recent**.
The development broker and packaged native host save these choices in the desktop-compatible encrypted
kind-30078 `channel-sort` record: `{ version: 1, groups: { ... }, meta: { v: 1, g: { ... } } }`.
A–Z writes a null register and removes that group's legacy override.
Filters use the same bounded group-register shape in a separate `channel-filter`
coordinate: Unreads is `unreads`, Active in the last is `active`, and All
writes a null reset tombstone. An optional top-level `activeWindowSeconds` map
stores each group’s duration in whole-day seconds; absence means 30 days. Presets
and custom values share this representation. Apply publishes mode and duration
in one encrypted update, and both hosts confirm both values on readback. Other
modes preserve the last duration; section removal clears it. Older fixed-window
clients still read `active` as 30 days until upgraded. Keeping this record separate leaves older clients'
sort records unchanged. Both hosts validate, encrypt, publish and confirm filter
writes through the existing preference queue. The UI projects pending choices,
rolls back a failed save, and offers explicit Retry/Dismiss; a confirmed full read
is required before writes. Removing a saved section resets its filter before
removing the section. A saved startup copy is display-only until relay reads recover.
Like sorting, this is whole-record last-write-wins; another client sees changes
when it loads or refreshes preferences, without a new automatic reconciliation loop.

Sections use
`meta: { v: 1, s: { ... }, a: { ... } }`: per-section name/icon/order/live registers
and per-channel assignments. Upgraded readers project metadata as authoritative;
writers regenerate the legacy fields and preserve unrelated registers, including
section deletion (`live=false`) and assignment/sort reset (`null`) tombstones.
Stars and mutes keep their existing `updatedAt` entries, not this register schema.

A register is `[version, device, value]`, with a nonnegative safe-integer millisecond
version and 16 lowercase hex device ID. Meta-less relay heads import at event
seconds × 1,000 with the zero device ID. Edits exceed every observed register
version and use a random in-memory device ID. Sections sort by canonical `(order,id)`
and project dense display orders; menu-created sections append after the canonical
live maximum, while drop-created sections precede the live minimum. Orphan
assignments are omitted from the legacy projection, not deleted
from metadata. Read projection accepts Desktop string values on retained section
name/icon registers; only projected live text receives UI length limits. Already
satisfied intents return without rewriting the head, including assignment removal
when its register is absent, explicitly null, or points to a nonprojecting section.
Actual rewrites still reject
out-of-policy retained values rather than dropping or truncating them.
Unsupported/malformed metadata fails closed, including unknown fields;
this is not general forward-schema salvage. Live projection caps remain 100
sections, 1,000 assignments and 104 overrides per section-choice record; retained tombstones are bounded
by the existing 128 KiB plaintext budget, not live counts. Native signing/admission
additionally requires legacy fields to equal the validated register projection.

Saving preserves unrelated top-level fields and known register choices present in
the strong head read before publication. This is wire-format compatibility, not
the older Desktop's local-authoritative register cache or automatic reconciler.

Persistence is **whole-record last-write-wins**, not conflict-safe per-section
merging. Two devices can read the same record and save different sections; the
winning replacement can silently erase the other device's choice even when both
saves report success. The broker's mutation queue serializes its own writes only.
Read-back checks the requested section at that moment; it cannot detect an unseen
choice overwritten in another section or guarantee preservation against later
writes. “Independent” describes selecting a mode per section, not simultaneous
cross-device save guarantees. Retaining the shared record preserves compatibility
with existing desktop writers; convergence across unseen heads would require a
separately designed reconciliation lifecycle or atomic relay support.

`browser-host/sidebar-sort.test.mjs` deterministically exercises that accepted limitation
through the real mutation helper: another section saves and confirms between a
read and publication, then the stale whole-record replacement wins and also
confirms. This is contract coverage, not a concurrency fix.

## Starting a direct message

The **+** action in the DMs sidebar header opens **New message**, a routed empty
conversation in Messages. The header remains available before the first DM exists. Its inline **To:**
field owns a paginated people picker and up to eight recipient chips, excluding
this viewer. Agent profiles are offered only when their exact public key is one of the viewer's
local agents (Agents) for this community, the `managed` choices of
`session.agentChoices`. Public profile hints and the inventory library do not
qualify; this filter also applies to searches and cached results. Selected agent
chips are revalidated against the current local agents before a fresh open and
again before enqueueing.
Already queued messages retain exact-event recovery. Namesake identities show
unambiguous shared public-key labels in their options and selected chips. Human profiles remain available while controls load
or fail. The shared popover hugs shorter result lists up to ten rows (or available
viewport space), then scrolls. Search placeholders retain the previous result count
within that cap. An initial 15-profile preview paints first; bounded background batches
continue without scrolling, including for searches. Pages containing only excluded
agents keep loading; an empty result is shown only after all matching pages finish.
Directory reads use the verified scheduler without
admitting browse results into shared conversation profiles, so a large directory
cannot evict sidebar names. Each incoming batch shares the mention pickers' name
ranking, but new identities append so visible rows never reshuffle. This is not a
globally alphabetical directory: the relay pages by profile update time. Completed
pages and recent searches stay in memory for this account/community session, so
returning or clearing a search resumes the same results. Typing immediately filters
loaded names without replacing local matches with a loading placeholder. Once the
browse directory is complete, searches stay local until New message closes; a
reopened picker keeps the loaded list but searches the relay again, so people added
since can be found. While the directory is incomplete, remote matches can append in
the background. A failed background read
keeps existing people visible and offers retry. Mentions retain their conversation-specific
eligibility. Before a DM exists, a composer-local `DraftMentionRoster` supplies
only the selected recipient identities and names to both mention tools. Removing
a selection updates both menus; an already-inserted mention still requires actual
DM membership on Send. Mentioning never opens the DM early or adds recipients.
The existing `MessageComposer` owns the draft and ordinary input behavior. Its placeholder is blank before selection and lists the selected names
afterward. Disabled mention and emoji icons stay unfilled. No timeline is mounted before the first message is confirmed. DMs omit the date
pill at the beginning of their complete history, while retaining message times
and date separators between days.

`features/direct-messages` owns selection, scoped view intent, and the isolated
chip-removal effect. The five-frame effect lasts 400 ms (a gentler 180 ms fade
with reduced motion); audio is best effort. The copied assets retain their MIT
notice in `public/recipient-removal/LICENSE.txt`.

The relay session exposes `directMessages` over its existing verified reader and
outbox. People are kind-0 pages: a 15-profile browse preview (30 for search), followed by
30-profile browse batches. Searches retain 30-profile pages because profile metadata
can be large enough to exceed the read budget in larger batches. Remote name
searches are debounced by 300 ms and need at least two characters.
Opening uses the development broker's purpose-bound `/direct-message` endpoint:
it signs kind 41010 with one to eight distinct other participant keys, checks the
exact command receipt, and returns the canonical channel ID. A unique client tag
allows reissuing this participant-set command after a lost response without
receiving a generic duplicate-event receipt. No private key or arbitrary signing
capability is exposed to the page. Other host adapters report this capability as
unavailable until they implement it.

Before sending, the session requires signed DM metadata and an exact signed roster
containing the viewer and selected people. The first kind-9 message then uses the
normal durable outbox. Navigation waits for an accepted receipt or verified echo.
A failure retains recipients and draft; an uncertain delivery retries its exact
event ID. The outbox persists recovery metadata with the operation before publication and
retains it through confirmed delivery until the composer durably acknowledges it.
Hydration must finish before a fresh send; one recovery key prevents duplicate
first sends. Definitively failed operations restore newer editable draft and recipient
views; uncertain operations keep their durable recovery payload authoritative.
Before acknowledgement retires recovery, saved views are removed and their absence
is verified. Cleanup failure retains recovery for confirmation-only retry. A page
reopened during acknowledgement resets its recovered editor when retirement finishes.
Local storage is a convenience for editable drafts. Only a
definitively failed recovery operation can be removed (including through
Diagnostics), releasing the preserved draft for editing or a changed recipient set. A changed set also invalidates the prepared destination.
Page exit cancels preparation and its delivery waiter, while the outbox retains
ownership of already queued messages. Reopening recovers the pending event rather
than enqueueing a duplicate.

Focused coverage lives in `NewMessage.test.tsx`, `direct-messages.test.ts`,
`relay-broker-api.test.mjs`, and the Chromium/WebKit `new-message.spec.mjs` journey.
The browser journey uses the production app and broker with ephemeral identities
and modeled upstream I/O; it does not send messages to a live community.

## Channel header actions

The conversation header’s **Channel actions** ellipsis opens the shared, default-size
(non-compact) menu. **View channel details** is first and opens or focuses the existing
Channel Settings tab; selecting it again never closes the pane. Editing is available
from that pane, not directly from the menu. **View canvas** is Channels’
[channel menu panel](plugin-architecture.md#optional-channel-menu-panels) and opens a
Canvas tab in the side pane. **Move channel**, **Mute/Unmute**, and **Mark as read/unread**
reuse the sidebar’s action composition and persistent mutation/recovery owners.
Permission-gated lifecycle
actions follow in **Leave → Archive → Delete** order, with Delete in the shared
danger tone. DMs retain Hide conversation and the separate Remove from Messages
action; their permissions are not inferred from stream channels. Members retains its adjacent button and Diagnostics remains inside Settings.
Session headings are unchanged, but their Channel actions menu lists the same
channel menu panels. Header moves and dialog cancellation return focus
to the ellipsis, while session creation hands focus to its composer. Read-only, cached, archived and DM eligibility stays
with the existing capabilities. Opening the menu reads permissions, never publishes
a lifecycle command. Menu Escape/outside dismissal returns to the header;
lifecycle confirmation cancellation also returns there. Dialog owners outlive menu dismissal,
while channel/session navigation retires header-origin dialogs. Canvas is a retained
side-pane tab; changing channel or losing eligibility closes it without discarding
its channel-scoped draft.
The sidebar’s own dialogs and session-owned writes/recovery keep their existing
lifetime; retiring a header does not undo a command already sent. The redundant Canvas card and saved-content
preview are omitted from Channel Settings; opening details does not read Canvas.

## Channel lifecycle

Lifecycle actions extend the persistent sidebar’s existing context popup after
Move channel and the mute/read group. Lifecycle items use shared leading icons and
a separator only when they resolve and earlier actions exist. Right-click
and keyboard access reuse the existing row trigger; no ⋮ control or second popup
is added. Attention actions keep their existing owners. Solo chats in
Messages use these same permission-checked
actions, including the standard header menu and Channel Settings. Existing Canvas
and organization entry points come with that shared menu; the Solo chat
transcript layout, Share behavior and recipient rules do not change. Move/Star/grouping
controls share this popup with independent eligibility; lifecycle actions do not
change shared-menu styling.

The row menu resolves fresh relay-authored metadata (`39000`), administrators
(`39001`) and membership (`39002`) at exact channel coordinates before offering
Archive/Unarchive/Delete/Leave or DM Hide. Archive and Unarchive require a direct
owner/admin role or verified ownership evidence for an owner-role agent, matching
the relay and desktop. Delete is offered to a direct owner or a member with that
same evidence; the last direct owner cannot Leave. The menu omits Leave
when it is forbidden, without an ownership-transfer explanation. Action labels
have no trailing ellipsis. DMs offer Hide only.

Owner-agent eligibility follows the desktop's profile-based UX: read the channel
owners' latest signed kind-0 profiles in bounded exact-author batches, then verify
the unique NIP-OA tag, target binding, owner signature and conditions against the
profile event. Display-only owner fields and agent hints never qualify. The
existing shared verifier owns these checks; no new relay query or deployment is
needed. Direct owners, DMs, Leave, and actions a direct role already grants do
not require these optional profile reads. A failed five-second owner-profile lookup
preserves independently established actions, omits the owner-agent actions and,
on an active channel, exposes "Delete check unavailable" with explicit retry in
both surfaces. Settings keeps
its retry button focusable and busy during a fresh read, without retaining stale
actions. Pending progress stays inside the button spinner, not a duplicate visible
status sentence. If focus is still on recovery when the read finishes, it moves to the
retry, an allowed action (Delete first), or a no-actions status. Moving focus
elsewhere while waiting cancels that handoff.

**Profile provenance is not the relay's persisted authorization mapping.** It is
an eligibility hint for offering an attempt, not proof the command will succeed.
A profile without the attestation may hide Delete from a human the relay would
accept; a conflicting valid attestation may expose an attempt the relay rejects.
Profile replacement does not establish relay ownership transfer or revocation.
The viewer signs the unchanged Delete command and the relay enforces its stored
ownership and current channel state. A definitive rejection retains the channel
and recoverable confirmation; uncertain delivery still blocks blind resubmission.
Archive/Unarchive/Leave depend only on the viewer's own channel role. Existing
membership requirements remain; nonmember access, owner-agent Archive/Unarchive authority and
community-admin overrides are not added.
Membership accepts NIP-29 `p` tags with optional relay and role fields
(`["p", pubkey, relay_hint?, role?]`), including the relay's four-field roster.
These fields never substitute for the separate administrator record. Invalid
member keys and duplicate entries still fail closed. Failed menu permission reads
show "Channel actions unavailable" with retry, not raw protocol errors. Pending
permission reads show neither a loading row nor a lifecycle separator; the
separator appears with the resolved actions or unavailable/retry section, and is
omitted when there are no lifecycle items. Actions appear only after verification.

Channel Settings also offers **Leave channel**, **Archive channel** and **Delete
channel** in its tools area, using one fresh lifecycle permission check. Each
entry follows its own permission result: a last owner can Archive/Delete even
though Leave is forbidden, while an ordinary admin without owner-agent evidence can Archive but not Delete.
Forbidden entries are omitted; failed checks offer retry and unsupported
connections explain unavailability. DMs and read-only nonmember/cached views have no channel
lifecycle entries. Archived channels cannot be deleted:
the relay rejects Delete while archived. A direct owner/admin can restore it with
**Unarchive channel**, which replaces Archive in the same Settings position, before
deletion.
These controls hand off to the same persistent sidebar confirmation/navigation
owner, so confirmed removal can unmount Settings without cancelling completion.
Cancellation returns focus to the originating Settings button (or the sidebar
fallback if that entry has gone away). Archive retains the current conversation,
messages, membership and open Settings, replacing Archive with Unarchive after a
fresh permission read. The conversation stays selected after reload; archived
write restrictions still apply. Archived conversations and their threads replace the
message composer with the lower archived-channel notice. If that composer owned
focus, focus moves to the retained message history. Nonempty unsent text, including
an in-progress message edit, is offered through a host-owned **Copy text** toast;
empty composers and focus elsewhere do not trigger it. Copy failure retains a retry
action, and recovery stays available until used or dismissed. Unarchiving restores the
composer and its saved text draft. A remote unarchive in the same open conversation
preserves the reader's focus instead of autofocus moving it into the restored composer.
When refreshed Settings actions remount, focus
returns to its persistent Settings-tab close control instead of an unrelated sidebar row;
joined archived channels, including session conversations, remain available by name
in search, labeled **Archived channel**, but stay out of the sidebar and Recent
activity. After navigating away, open the search result and Settings to restore it.
This uses the existing membership discovery and exact
navigation, not a new archived-channel directory.

Search also finds active public channels the viewer has not joined, by name,
labeled **Public channel · not joined** after joined matches. Opening one shows the
read-only preview. Member-default previews offer **Join channel**; after the relay confirms
membership, the channel joins the sidebar and the composer becomes available and
focused. Guest-default previews omit Join and preserve reading without membership.
Joining a channel is not available for DMs, private, archived or session
conversations. See [relay queries](relay-queries.md#public-channel-name-search-and-join).
Channel results end with their member count when the roster is known, such as
**Public channel · not joined · 12 members**. A failed read leaves the row
without one. See [relay queries](relay-queries.md#public-channel-name-search-and-join).
Unarchive publishes the existing narrow `9002` command with `archived=false` and
requires fresh relay metadata with a missing/false archive tag before updating
shared discovery; a missing record is not success. Restoration returns the sidebar
row and keeps the current conversation and Settings open, with fresh actions.
When upgrading an already-running development server, restart the **Node process**
before trying Unarchive: Vite's in-process restart can retain the broker's imported
archive-only validator even while the browser has the new action. A page reload
alone does not update that host module.
Archive, Unarchive and Leave use the default button style in Settings. As in macOS,
the prominent confirmation button is the one Enter presses: reversible Archive, Unarchive
and Hide initially focus their prominent action beside a default-style Cancel, while
Leave and Delete initially focus a prominent Cancel beside a default-style Leave or
destructive Delete. Every shared confirmation shows its pending
state inside the primary button using the standard loading spinner (with an
accessible status), without adding a visible status paragraph. Duplicate submission
and Cancel/Escape remain blocked until the operation settles; rejection restores
the action, while an uncertain outcome still blocks blind resubmission and moves
focus to Cancel.
Delete keeps the named-channel warning and destructive confirmation button without
requiring the channel name to be typed. Metadata and member-role editing remain
separate.

Each command has explicit confirmation. The lifecycle owner rechecks signed channel state and, for owner-agent Delete,
profile eligibility before signing and again before publication, validates
the returned command, and confirms relay-owned state before removing a row. Archive retains membership;
confirmed Delete/Leave use the existing access-loss purge. Commands use narrow
development-broker routes or the packaged native `relay_channel_sign` and
`relay_channel_publish` commands, never the message outbox or automatic replay.
The same route carries the **Starter channel for new members** switch as two commands
without a confirmation dialog, `auto-join-on` and `auto-join-off`, each a `9002`
with `auto_join=true|false`. The lifecycle owner requires fresh relay metadata for an
active public stream channel before signing (channel roles cannot show community
ownership; the relay accepts the flag only from community owners and admins) and
confirms the result from the republished `39000`: the relay advertises the flag
as a bare `auto_join` tag only while it is in effect, so success is that tag's
presence or absence, not the written value.
A published lifecycle command keeps its bounded, fresh, strong confirmation
when access loss retires access-dependent work. Retired confirmation reads
are reread; caller cancellation, session clear/disposal and the original deadline
still abort its signal. A rejected publication or definitive confirmation-read
failure still fails the command; an aborted read alone never confirms it. These signals
do not forcibly interrupt an in-flight native publication IPC.
Both hosts admit only the exact two-tag `9002` shape with `archived=true` (Archive),
`archived=false` (Unarchive) or `auto_join=true|false` (the switch); other values,
extra tags, cross-route commands and
altered or foreign signatures are rejected. Hosts without this capability display
an unavailable notice. Native Unarchive and the auto-join switch require
rebuilding/restarting the desktop
binary; updating the frontend alone does not update the Rust validator. Rust
validator and production-IPC tests cover both values, but do not establish an
installed desktop Archive → Unarchive round trip against a live relay; that
acceptance remains outstanding.

Main’s DM × remains local removal, including restoration on new message evidence.
The separate, confirmed Hide conversation action publishes `41012`, not Leave or Delete. The separate relay-authored `30622`
visibility snapshot (`d=viewer`, `p=viewer`, hidden DM `h` tags) only filters sidebar
rows; it does not deny access or prevent exact conversation navigation. Visibility
refreshes with the channel roster, preserves the last good set on failure and
rejects older snapshots. Live cross-device visibility updates and an in-app DM
reopen/unhide flow are deferred; opening a DM through another supported client's
`41010` flow and refreshing restores the row.

A definitive rejection offers retry without optimistic removal. If publication or
confirmation has an uncertain outcome, the dialog warns that the command may have
taken effect, disables blind resubmission and asks the user to close and refresh
channels. Cancellation/cache clear/session replacement fence late results but cannot
retract a request already sent. Cancellation returns focus to the originating row;
confirmed Delete, Leave or Hide moves an active conversation to another available destination
(or the neutral Messages page) with a visible sidebar-row focus fallback. Last-row
Delete/Leave/Hide completion uses the explicit version-1 Channels route `"empty"`, which bypasses
saved/default conversation selection, including after reload. Retained archived or
hidden membership cannot reopen itself through that destination; intentional exact
navigation to a hidden DM remains supported.

## Channel-management modal dismissal

Channel-management modals explicitly opt into the shared Dialog's backdrop-click
cancellation. Members, lifecycle confirmations, new sections and personal
groups use the same Close/Cancel path for outside clicks.
Create and Edit details use their Close path: untouched forms close immediately;
changed drafts require discard confirmation, while explicit Cancel discards immediately.
Clicks inside or in portaled controls do not dismiss them.
The non-modal Settings panel is unchanged; the shared Dialog default stays opt-in.

Canvas reload uses a shared confirmation Dialog above the Canvas tab.
Cancel, Close, Escape or a backdrop click dismisses only that confirmation, keeps the tab’s draft,
and never executes the action. Confirmations initially focus Cancel and return
focus to their initiating control; lifecycle confirmations choose their initial
focus as described above, and their final focus remains sidebar-owned.

Existing pending operations continue to block dismissal. Members remains closable
while session-owned invitations/recovery continue. Canvas keeps its local draft;
closing an uncertain Create abandons it as described above; Edit and lifecycle
outcomes retain their existing recovery rules.
No dismissal saves, retries, replaces setup or confirms a destructive action.

## Editing channel details

Channel Settings shows the signed name and description for ordinary channels. The centered title opens the same editor, revealing a pencil with a short
left-to-right fade on hover or keyboard focus (always visible on touch, no animation
for reduced motion). The pencil follows the final text line;
balanced side padding keeps the text centered and lets long titles wrap without clipping it.
Description has a small pencil after its label,
revealed with a short left-to-right fade on whole-row hover or keyboard focus
(always visible on touch, no animation for reduced motion) without shifting layout;
the whole row opens the shared Dialog with one Name/Description/Duration draft.
Opening Description focuses its textarea; the title focuses Name.
Only authorized editors get the interactive rows; other viewers retain plain metadata.
Members has a right chevron and opens the existing member list. Channel ID has a
small inline copy icon with the same hover/focus/touch behavior; selecting its row
copies the exact ID. Only a successful copy opens a confirmation tooltip, without
growing the row; hovering or focusing does not open a hint or replay old feedback.
Clipboard failure shows an inline error and leaves the row available to retry. The redundant standalone
Edit details button, header-menu Edit details entry and informational Channel type
row are omitted.
Duration uses Create's Ongoing/Temporary cards. Access controls live in the members
dialog, separate from the text and lifespan draft. These details controls stage
changes; none publishes immediately.
**Starter channel for new members**, between Description and Members, is separate: an
immediate switch that publishes its own narrow `9002` (see
[Channel lifecycle](#channel-lifecycle)) and shows pending, the relay's refusal
or, when the change is not confirmed, a prompt to try again beside itself. It appears only to community owners and admins
(the relay-signed kind `13534` roster) on an active public stream channel; the
relay enforces that rule, so the gate is display-only.
**Save changes** submits the draft together and is enabled only for valid, changed values.
**Cancel** explicitly discards edits and closes without confirmation. Close, Escape
and backdrop clicks close untouched forms immediately; changed drafts first show
**Discard changes?** with **Keep editing** initially focused. Keep editing, Escape,
Close or a backdrop click in that confirmation returns to the intact form.
**Discard changes** drops the draft and returns focus to its originating control without
closing Settings, as does the form’s explicit **Cancel**. Pending saves and status
checks block dialog dismissal and show a
loading spinner on the disabled edit control without changing its label.
Saving and permission loading do not add text status rows or reserve empty space;
viewers without editing authority see neither edit controls nor an explanatory hint.
Actionable errors and uncertain-save warnings remain visible.
After an uncertain outcome, the edit controls re-enable so the save may be closed
and reopened for check-only recovery, never a blind resend. The panel retains its
own Close/Escape focus return, conversation and collapsed Diagnostics.
Names accept 1–120 code points and descriptions up to 1,000. Typing and paste
are capped at those limits without splitting Unicode code points; a middle edit
keeps the existing suffix and accepts only the inserted text that fits. Existing
over-limit relay values are preserved: edits may reduce or replace text without
growing the excess, and Save stays invalid until both fields meet the limits. Character
counts appear at the trailing end of the label row only within the last 10% of
each limit (`108/120` or `900/1,000`). Visible counters are numeric; the connected
accessible description retains the full character-count meaning.
Names follow the relay’s Unicode whitespace and leading-hash canonicalization
before validation, signing and confirmation. Empty descriptions clear the value.
Command validation still rejects oversized input independently of the UI.

### Create/Edit form parity

The dialogs share `ChannelTextField` for Name and Description: the same code-point
input caps, middle-edit preservation, label-row counters and connected errors.
Both forms canonicalize names with `canonicalDetailsName` before handing off the
draft. `ChannelDurationField` shares the Ongoing/Temporary cards and draft-only
subtle minus/plus controls beside the selected Temporary card when space permits,
or on a trailing row when its intrinsic content needs the full width. The duration
phrase and feature-owned label wrap at enlarged text sizes; shared Radio styling
and focus space are unchanged. Unselected copy is
“Archives without activity.”; selected copy is “Archives **after [duration]** without
activity.” `motion/react` expands/collapses the middle phrase and the adjustment
space together over 200ms, without scaling text. The interval remains single-line
while animating or hidden and wraps only after expansion, so Ongoing reserves no
hidden multiline height. The middle phrase uses Medium
weight and standard text color against muted surrounding copy. Reduced motion and
keyboard navigation switch immediately; hidden controls are inert and excluded
from accessibility, with one complete accessible description per state.
Steps are **1 day ↔ 7 days ↔ 2 weeks**, starting at seven days, with
unavailable directions disabled. Switching to Ongoing and back retains the chosen
time within the draft. Create keeps its Private switch in the footer; Edit details
leaves access management to the members dialog. Both forms use a compact
12px header-to-body gap and 16px field spacing. Write ownership stays with each
workflow.

Both forms show Description immediately; Create opens with Name focused and keeps
Description optional. The workflows intentionally remain distinct: Create retries only
an identical attempt while open; Edit shows the
saved description, retains custom durations, and owns authority/conflict checks,
Save/Cancel and check-only uncertainty recovery. Create still trims optional
Description on submission; Edit preserves its exact text and can explicitly clear it.

Both dialogs opt into backdrop dismissal and guard Close, Escape and backdrop
dismissal with an in-dialog discard confirmation when the draft differs. Comparison covers raw
text, effective duration and, for Create, staged privacy. Reverting
all fields removes the warning. Pending operations still block dismissal; once
settled, closing abandons any uncertain Create. Returning from a discard confirmation focuses Name and retains the draft.

Create has no destination picker. Opening from a saved group's sidebar + fixes
that destination for the draft and titles the modal **Create a channel in [icon]
[group name]**, reusing the sidebar's decorative Unicode/custom-emoji renderer.
Opening from the general Channels section stays ungrouped and uses **Create a
channel**. Opening from Starred titles the modal **Create a channel in [star icon]
Starred** and saves Starred placement with the creation intent. In the sidebar,
the filled Tabler star retains the section emoji artwork size and is centered in
the channel icon column. The creation heading reuses the decorative emoji slot
and inherits the heading's typography.
Group and Starred placement use the existing preference writer and normally
apply before the new channel opens, so its first sidebar row is already in its
destination; placement that must first re-read preferences can list the row
before moving it.
Placement starts once the Create is delivered, so it also stands when the form
cannot yet confirm the channel; the channel lists in its destination once it is
confirmed. Unavailable placement blocks a new create. Once the channel opens, a
placement failure reports partial setup without creating a second channel; an
unconfirmed create reports only its own failure. An identical retry rechecks its
Create without continuing the template's setup writes; agents or Canvas that
changed underneath an untouched form do not count as new details.
Group placement remains managed through the left-nav Move action.
Unavailable groups block a new create rather than silently falling back to a
different destination.

Create's session and existing creation helper also use `canonicalDetailsName`,
including identical-retry matching. Signed names retain the relay's Unicode rules: trim Unicode White_Space and leading
hashes, preserve U+FEFF, then enforce the code-point limit. This is cleanup, not a
new invisible-character policy. An identical retry still publishes the exact
original signed event.

Editing requires fresh relay-authored metadata (`39000`), administrators (`39001`)
and membership (`39002`) for the exact channel, plus current session participation.
Only direct channel owners/admins may edit ordinary stream/forum channels. Cached,
read-only, archived, DM and Solo chat views do not offer this editor. A local
key, delegated agent role or community-admin status does not imply channel authority.
Create's Private switch stages a choice behind the existing in-modal consequence
confirmation. The device-local opt-out applies to that Create warning; Continue
only stages the choice and Create channel performs the write.

Access management lives in the members dialog. It retains the existing member
list, row menus and confirmed role changes. Exceptional roles appear as muted
text before each row’s ellipsis button: **Owner**, **Admin**, and **Viewing only**.
Ordinary Member and Bot rows have no role caption; verification and access warnings
remain available. The ellipsis menu contains permitted role choices with
the verified selection checked, alongside profile/removal actions and the existing role
confirmation. Immutable roles such as Owner and self remain protected.
General access is the first row in the scrolling member list, with its policy
icon and explanation on the left and the small, text-only Select button on the right.
Its popup aligns to the button’s right edge. The row wraps
when enlarged text needs more room. Access errors, uncertain-save explanations,
and their recovery actions occupy the full width below this row. Copy link stays
at the footer’s left and Done at its right. Read failures offer Retry through the existing member-data
reload path; the persistent Refresh action is removed.
Hidden status announcements do not receive visible-content spacing or extend the
footer's scroll area. Refresh marks the data lists busy, while saving and search
announcements remain outside those busy lists. Reader-only explanations stay
in the first row of the member list. The people/agents filter is an icon action
inside the search field’s trailing edge, with the selected group checked in its
menu and an active button treatment when filtered. Typing a search resets it to All.
The **General access** Select offers three policies:

| Choice | Reading | New people's admission role |
| --- | --- | --- |
| Public | Anyone in the community | Member (Participating) |
| View only | Anyone in the community | Guest (Viewing only) |
| Private | Only members | Preserves the saved default; people must be added |

The popup separates Private from the two community-readable policies with a divider.
Options include concise descriptions and fixed policy icons: Lock for Private,
Globe for Public, and Eye for View only. The selected policy icon stays beside the
explanation on the left of the row. The small outlined dropdown button contains
the selected title and chevron; the entire button opens the choices. Policy
artwork never falls back to a community initial.
Public and View only explicitly select both visibility and admission in one confirmed details
update. Both make the full history readable by the community. Existing members
keep their individual roles. Private is displayed for every private policy,
including an older Guest admission default; opening or reselecting it never
normalizes that stored default. Choosing Public or View only explicitly replaces
it. The shared editor restricts Solo-labelled chats to Private / View only; a
legacy public Member policy is shown as **Public (existing)** until changed.

Each selection opens a consequence confirmation. Cancel/Escape returns focus to
the unchanged Select. **Change access** saves immediately through the existing
channel-details capability, then reloads signed metadata. Loading, pending and
unconfirmed saves disable the control. A pending save shows an inline spinner
in the leading icon slot instead of a separate visible saving message. A persistent
live region outside the busy controls announces saving and confirmed completion.
Rejections offer **Reload access**. Failures before publication identify the initial
access check, signing, or final access check that failed, retaining the underlying
error. No request is retried.
Uncertain results survive closing the dialog and offer **Check save status**,
which reads without republishing. Opening or checking never writes. Private
channels with a Guest default remain intact when changing unrelated details.

For private channels, ordinary human additions explicitly request Member (Participate), including when an older saved admission default is
Guest. Existing roles are not changed; **Add as** still permits an individual
View only or Admin choice. Public additions keep their admission-default behavior,
agents retain Bot, and Solo/system admission is unchanged. The saved default is
preserved while private; explicitly choosing Public or View only selects the
corresponding admission default without a metadata migration.

Readers see General access as plain text from verified channel discovery metadata,
without calling the editing capability. Guests and readers of Guest-default channels
see “Viewing only. Ask an owner or admin to participate.” A nonmember previewing a
Member-default channel instead sees “New people can participate. People already in
the channel keep their access.” Other previews identify defaults that could not be
confirmed. The private-channel summary identifies member-only reading; existing
participants keep their roles. The compact timeline
label says “This channel is read-only.” for Guest-default channels; a Guest in a
Member-default channel sees “Read-only access.” Guest-default previews never suggest
joining to add people or agents.

In Edit, visibility is sent only when changed (`private` or `open`);
text-only edits omit it so they do not reopen the channel in the remaining write race.
The relay remains the final authority.

Temporary defaults to seven days without activity, matching Create. Existing custom
positive durations are shown accurately and retained until explicitly adjusted;
minus/plus selects the nearest offered shorter/longer step without silently rounding
on open. Editing text or toggling back to the original lifetime does not reset
the relay cleanup deadline. A duration change
emits the existing `ttl` command (positive seconds for Temporary, empty to clear for
Ongoing). Absent signed metadata TTL means Ongoing; malformed/duplicate TTL fails
closed. Confirmation checks the exact duration alongside the other draft fields.

`features/relay/channel-details.ts` owns the command and uncertain intent. It
rechecks authority and the edit's metadata version immediately before signing and
publication, verifies the signed command, and requires matching fresh metadata
readback—not merely a publication receipt. Confirmed relay metadata feeds existing
shared discovery so the panel, conversation header and sidebar use the same values.
The version check detects observed conflicts but is not a relay-side compare-and-swap:
concurrent writers can still race after the last read.

A definitive rejection keeps the editable draft. **Reload details** rechecks the
base without discarding text edits. Untouched visibility and duration follow the
reloaded base; explicit choices stay in the draft. A duration-only comparison baseline
survives failed reloads, so an untouched duration follows the next successful read
while an explicit change to Ongoing remains staged. This baseline never grants
editing authority: a failed read still clears the current base and disables Save.
If a failed reload has lost the prior base, privacy adopts the fresh value
conservatively: a stale public text draft must not become reopening intent.
Inspect the retained edits before
saving again. A lost publication response or failed/mismatched readback locks the submitted draft and
offers **Check save status**, which only reads and never republishes. Uncertain
intent survives panel close/reopen and cache clear within the same session; no
background polling, automatic replay or durable recovery record is added. If
status cannot be confirmed, inspect the channel rather than assume failure.
Session replacement drops the in-memory attempt; it does not retract a sent write.
Channel/session changes fence old drafts and late completions. Operations use a
20-second deadline so a stalled read/write becomes explicit recovery, not an
indefinite saving state.

### FOUNDATION integration rationale

This is migration of an existing Buzz user feature, not a session redesign.
The current session already owns community/viewer identity, verified reads,
participation, shared metadata and cancellation. Composing the dedicated details
owner there keeps those authorities together instead of constructing a second
connection or making the panel a command owner. The approved `session.ts` change
is limited to constructor/import, capability exposure, cancellation, cache clear
and disposal (13 added lines). Policy and write logic remain in the feature owner.

The development broker exposes separate `channel-details-sign` and
`channel-details-publish` routes, accepting only bounded name/about and optional
open/private visibility plus an optional bounded TTL change/clear. Existing archive-state-only
lifecycle, invitation and message-outbox admission are unchanged. Publishing reuses the same community's authenticated live
socket; no HTTP fallback or new connection is added. Restart an already-running
dev broker to load these routes. `just web` supports this complete browser flow;
`just desktop` is not required. Hosts without the dedicated capability stay
read-only; packaged/native uses dedicated purpose-bound commands for these edits.

Behavior matrices live in `channel-details.test.ts`,
`ChannelDetailsEditor.test.tsx`, `store.test.ts` and `relay-broker-api.test.mjs`.
Real-relay Save/privacy changes require deliberate testing on a disposable channel;
unit/broker tests and a browser Cancel walkthrough do not establish live-write or
native acceptance.

## Member administration

**Members** has its own conversation visit, carried in its address as
`panel: "members"` through the host navigation owner.
Opening adds a visit: Back closes the dialog on the same channel and Forward
restores it. Explicit dismissal (Close, Escape, outside click) retires the visit
without adding a closed-dialog stop, so Back can leave the channel and Forward
keeps Members closed. Reload and deep links restore the same channel and
Members, including the underlying message/thread address when present; cold
dismissal replaces in place when no matching opener is known.
Profile/DM handoffs dismiss Members without overwriting the destination. A
routed destination replaces the Members visit, so Back returns to its channel
opener once; traversal never repeats a DM open or membership mutation.
Search, role filters, menus and confirmations are transient, not address data.
Scoped history still requires the original viewer, joined community and current
channel access. Tabs remain session-owned: navigation preserves them, but this
change does not add disk persistence for tab sets. Draft persistence is unchanged.
The content-tab menu's **Close other tabs** and **Close all tabs** retire all
closed thread, Profile and GitHub visits together, including inactive tabs.
The kept tab stays selected; underlying channel/message visits remain. Back and
Forward skip the closed content, and reopening it explicitly is still possible.
A covering Members modal owns focus while underlying exact-message readers verify
and restore their targets without focusing through the modal. Session conversations
have no Members surface; a restored/handwritten Members route to a session resolves
to its underlying conversation/message without that panel.

The header **Access** button opens the one access dialog every conversation uses.
It is titled **Channel access** in channels and **Chat access** in a Solo chat (see
[Sharing a Solo chat](solo/sharing.md)). A Solo chat owner can remove people and
agents there but cannot change roles.
One search field, with an accessible name but no visible label, filters current
members and lists people, agents and Teams to invite under **Not in this channel**.
With an empty query, channels and Solo chats show invitations only when the viewer is
the sole member; otherwise they show just the roster. Searching offers invitations
with the existing grouping, ranking and expansion behavior.
Each result's **Add** button, or Enter on the highlighted result, adds immediately.
The footer keeps **Copy link** at its leading edge and **Done** at its trailing edge.
When adding is unavailable, the field reads **Search members** and a short reason names
why (DM, archived, connection, or not joined). The dialog keeps ordinary invitations and adds
verified roles plus per-member administration. Current members appear in separate
**People** and **Agents** groups with sticky headings and counts. Verified authority
alone adds an Owner or Admin tag beside a name.
Everyone else is grouped by the same agent identity evidence used for avatar shapes:
agent identities in Agents, other identities in Members, without asserting a default
protocol role or treating the Bot role as agent identity. Each group is alphabetical
by displayed name (public key breaks ties). Initial opening shows one accessible
loading spinner inside the existing scrollport until the roster, role and member-name
attempts settle; no provisional identity rows or groups appear. Missing names or
failed reads settle to public-key fallback and the existing refresh recovery rather
than blocking forever. A warm reopen with a settled role result (including an honest failure fallback)
and all member profiles already available renders immediately. Later refreshes retain usable content and
preserve the last verified groups on failure. Visible member names request foreground
priority; avatars, presence and manager enrichment never gate the initial list.
Search filters
each group, omits empty elevated and agent groups, and preserves full group counts.
Channels and Solo chats share the **Your agents**, **People**, **Other agents** and
**Your other agents** invitation groups, with empty groups omitted. The idle list
offers this client's agents; search also includes saved agents. Each group uses
shared name, relationship and usage ranking, starts with four rows, and has its
own **Show more**. **Find more matches** requests another directory page and reveals
its matches. Query changes and explicit refresh reset expansion. Solo retains its
direct-agent and person-sharing rules, so ineligible agents never enter its groups.
Only displayed invitation agents
join ownership observation, so the first character cannot mount/enrich the entire
known-agent inventory. Unchanged identity rows retain their rendered
profile/avatar/menu trees across query and loading updates; changed names, permissions,
manager evidence, presence and invitation state still update through their existing owners.
Current-member avatars and rows open a profile panel when a plugin contributes one
(none is bundled now); the access dialog closes and closing the profile returns focus to the
**Access** button. Names sit centered with a smaller, muted **Managed by** line for
agents with verified ownership; there is no hover public-key reveal. Available presence status
stays on the profile control. The manager link opens
the profile panel with the same focus handoff; row-profile and owner-profile controls are
siblings, never nested. Every current member has a separate
ellipsis button (not nested inside profile navigation), with **View profile** first,
then **View owner profile** for agents with verified ownership and available profile
navigation, or **Send message** for other humans on a DM-capable connection,
followed by permitted administration actions. Copying the full npub belongs to
the profile panel, not the member or invitation menu.
Send message reuses the session's verified direct-message opener and the current
conversation navigation owner; it sends no message automatically. One dialog-owned
waiter blocks duplicate opens, shows pending/error status and allows explicit retry.
Closing Members cancels that waiter and suppresses late navigation; a successful
handoff leaves destination focus alone. Owner/self protection, missing
writer support and pending/uncertain writes suppress mutations, not the profile
menu. If no profile panel is available, View profile is disabled. The action
trigger is always visible. Right-click, Context Menu and
Shift+F10 open the same action list through the shared context menu. The ellipsis
uses a separate shared Menu root/trigger so each input retains its platform
interaction owner; only one menu is open per row. The trigger owns toggling and
outside-press dismissal. Scrolling the member list dismisses either menu without
resetting the scroll position; scrolling inside a menu does not dismiss it.
Escape returns focus to the originating row
control; profile navigation hands focus to the panel and returns to the external
**Access** button when closed. Invitation rows reuse the same avatar, name and
**Managed by** line, without a channel-role badge or public key. Their avatars and
identity rows open the profile panel just like current members;
only the separate, extra-small prominent **Add / Adding…** button invites someone.
Invitation results expose the same identity menu through right-click, long-press,
Context Menu or Shift+F10 only, with no ellipsis button. Add stays separate and
there are no role/removal actions. People and agent avatars both use the
shared 32px default size. Both row types
share a 48px minimum height, growing with their content rather than
clipping it; profile targets fill the row height, with identity and actions centered.
Profile navigation stays available during an invitation; a missing profile panel
leaves the identity static without disabling the separate Add button.
The dialog retains its shared surface. A quiet `border-standard` outline frames
one scrolling viewport, with People, Agents and Not in this channel
separated inside it without extra boxes or fills. In roomy result viewports, group
headings stick to the top while scrolling within their sections, with an opaque
matching surface so rows do not show through. When the results have 8rem or less
of content height, headings scroll with their sections so wrapped labels cannot
cover keyboard-highlighted actions. Headings own the text's top inset, without
outer top padding to scroll away; sticky headings start pinned from the first
scroll pixel when their group starts the list. A compact ghost refresh button sits in the
fixed dialog header immediately left of Close, matching its button and 16px icon size;
its tooltip and accessible name are **Refresh member data**. It refreshes this
dialog's member-related data, not the whole application. It is the single retry
control for roster, verified roles, missing member names, shared agent choices,
archive visibility, agent ownership/manager names and the active directory search. Errors stay near their data,
without separate fetch-retry buttons. The current search text is retained; directory
refresh starts at page one rather than mixing old pages with fresh results. Empty
queries and DM membership do not trigger directory searches. Large channel rosters also use directory search when the viewer cannot add members. Cached names
reuse the shared profile directory; failed/missing names are retried. The separate
roster read remains usable when role verification fails. The refresh icon spins
linearly until all these reads settle (except with reduced motion), but stays still
while the initial list spinner is showing so only one spinner is active. It exposes
`aria-busy` and keeps its focus target. Duplicate clicks
and refresh during membership writes are blocked. Optional-name loading/failure does
not disable Add once the roster is verified. Failed invitations keep their explicit
Retry; data refresh never resubmits an invitation, role change or removal.
**Show more** uses subtle emphasis within its invitation group; **Find more
matches** is horizontally centered beneath the search results.
Role confirmations use prominent, and removal remains destructive.
The search has a role dropdown on its right when at least two roster groups are
present. It defaults to All and offers only populated People and Agents groups, with whole-roster counts (including the All total), using the shared
compact Select with its popup aligned to the trigger’s right edge. The popup has
an 11.25rem minimum and reserves checkmark space to avoid width jumps on selection.
Counts form a partition: each identity appears once, with Owners/Admins taking precedence
over agent identity. Any search input, including whitespace, resets to All and animates
the picker out while the search expands. Clearing the input restores All; search
never combines with a role filter, and ordinary invitations stay available.
Reduced motion makes the transition immediate. Existing owner/admin
precedence over agent identity is unchanged. Selecting a role returns the list to
the top; a vanished group or a single-group roster returns to All. Closing and
reopening Members resets the filter. This is display state, not role authority.
The member action trigger retains its compact width and fills the row height, with
right-hand corners matching the row. Inverse left corners carry its hover/pressed
fill around the profile's rounded edge; its hover matches the profile row highlight
rather than the brighter floating-button fill. Profile and action targets remain
separate.
The title, channel name and search stay fixed. Members uses the shared Dialog
with `dismissOnOutsideClick` enabled. Adjacent role groups use an 8px gap in
addition to the heading’s own top inset; invitation/recovery spacing is unchanged.
The search composition reduces the shared header-to-body gap by `--space-2`
(16px normally, 8px at the compact breakpoint) without affecting other dialogs.
The member-list area flexes into the remaining dialog height and owns the only
scrollbar, including search results and recovery messages. Current-member groups render at most 50 rows per page, with Previous/Next controls and whole-group counts. Search still filters the whole roster, and query or role-filter changes reset paging. Live roster changes retain the current page, clamped to the last available page. Subsequent growth retains that clamped page. Large-roster ordering and group membership stay stable while names update; live roster changes remove departed identities and append arrivals without re-sorting survivors. Reopening or refreshing takes a new ordering. Agents counts and the role filter reflect agent identities known at that point and can be partial when profiles have not loaded; newly learned agent badges can appear under People until reopen or refresh. Large rosters show the verified list without waiting for optional names; name enrichment requests only the displayed member pages through the existing profile directory, without warming the entire roster. Name search combines cached labels with paged relay name-search results for existing roster members, including when the viewer cannot add members; public-key search covers every member. Public-key labels remain available when a name is absent or evicted from that shared directory. The role groups and
Not in this channel flow naturally one after the other; empty groups are hidden. Only the bordered viewport fills spare
height, never a group inside it. The shared Dialog's opt-in flex body
keeps the outer body non-scrolling; other dialogs are unchanged.
Agent runtime/access management is not added to the member menu.

Manager attribution uses the existing NIP-OA verifier on each agent's winning
signed kind-0 head, combining one dialog-owned live observation with retained
profile-directory evidence. Filtering retains the current roster in that observation;
matching non-member agents join only while displayed on the invitation page.
Verification is event-bound: newer invalid or missing
auth removes the claim; older reads cannot restore it. The dialog reuses verification
for the same identity and signed head while filtering; a changed head is verified
again, and explicit refresh or session changes reset that reuse. Identity hints, local agent
inventory and channel roles never establish ownership. Missing/invalid evidence
shows no manager hint. Read/admission/name failures join the shared refresh; an
unavailable owner name falls back to their public key. Verified public evidence
can remain during a failed background read. No private/runtime authority is granted.

Agent avatar shapes describe identity type, not the channel's protocol role.
Human and agent avatars reuse the shared online/away/offline presence badge from
message bylines, including its lower-right cutout and accessible status description.
Only mounted rows demand presence from the existing bounded session directory;
filtering or closing releases their demand. Unavailable, stale or failed evidence
leaves the avatar unbadged, never falsely Offline. No presence reader or timer is
added. This is community session status, not agent process state.

Role and archive pills are omitted. Verified roles and archive state remain in
profile-link accessible names and the existing profile surface. A verified Bot
role for an agent identity is still called Member in the accessible name; underlying
Bot roles, invitation defaults and administration permissions are unchanged.
Before the first role read finishes no role is asserted. Missing or unfamiliar
roles after a completed read remain unverified/unknown rather than defaulting to
Member. An open dialog reloads idle role data when session access invalidation
clears it, but only for a current, non-cached channel. Failed reads require explicit
refresh; recovery never replays writes.

`features/channel-members/administration.ts` owns this session-scoped capability;
`session.ts` only composes its reader, narrow writer, access guard, discovery
updates and teardown. The dialog does not own a connection, privileged outbox or
retry loop. Each fresh read verifies exact relay-authored metadata (`39000`),
administrators (`39001`) and the complete roster (`39002`). Administrator and
roster roles must agree; malformed or inconsistent snapshots fail closed.

Current direct owners/admins of an unarchived stream/forum channel can manage
another non-owner member:

| Target role | Change role | Remove from this channel |
| --- | --- | --- |
| Admin / Member / Guest | Admin / Member / Guest, excluding the current role | Yes |
| Bot | Admin / Guest, after explicit confirmation; Participating is already selected | Yes |
| Owner, self, unknown or inconsistent | No | No |

Agent identity is independent of channel role. Explicitly promoting a Bot to Admin grants authority to that agent’s own public key and preserves its verified agent identity; the human owner’s roles do not confer authority.

The menu offers **Viewing only** through a deliberate **Set to viewing only**
confirmation. **Participating** remains the role-menu label for verified Member
and Bot roles, while **Viewing only** represents Guest. Changing the admission
default never changes those roles.

The members dialog's General access Select presents reading access and new people's
contribution access as one policy while preserving their separate relay fields.
The note explicitly preserves existing participants' access; a Guest default leaves designated writers able to contribute.
Owners/admins save choices through the existing kind:9002 command. Missing `join_role` means Member, matching legacy relay
behavior. An unrecognized or malformed explicit default maps to Guest so previews
fail closed. These defaults never replace a participant's stored role.
Unchanged or omitted defaults are not resent, and success requires matching fresh
signed metadata; an older relay that ignores the choice cannot report success.

A Guest's signed roster role makes the channel read-only independently of that
default. Channel and thread history remain available, with a read-only notice
instead of a composer or Join button. Nonmembers of a public Guest-default channel
get the same reading view without Join; opening message or thread links does not
create membership. Explicit promotion to Member restores the
composer; changing only `join_role` does not. Guests retain Leave, and the relay
remains the authority for every write.

The session keeps membership-based reading/lifecycle access separate from writing
permission. Direct guest writes and uploads are refused, and queued writes are
checked again before signing and publication, including signed retries. The
relay's verified agent-owner edit/delete exception is preserved; it does not
permit ordinary posts or reactions.
Guests can search the member directory without invitation controls. Public
previews whose admission default is Guest also omit invitations; existing
writing members retain them independently of the default.

Current members may also remove their own verified non-owner agents, but cannot
edit their roles or remove someone else's agent. The service verifies signed
ownership once per removal attempt, independently of display hints.

DMs, archived channels and session channels have no administration actions.
In a Solo chat only owners and admins can remove members, including other people's agents.
No ownership transfer, community-admin override or new invitation restriction is
introduced. Personal Leave remains a separate lifecycle operation; removing a
member neither deletes their identity nor stops their agents.

Role change and removal use deliberate confirmation steps in the same dialog,
initially focused on Cancel. Removal shows only the avatar/name and actions;
Cancel returns to the list. Errors appear below Search, outside the scrolling
list; pending and success banners are omitted.
The service checks fresh actor/target state before signing and again
before publication, rejects altered signer payloads, and confirms the requested
role or roster absence with a fresh read. Relay acceptance alone is not success.
Pending intent survives dialog close/reopen and suppresses duplicate actions.
Definitive failure preserves the last confirmed roles and offers explicit refresh;
an uncertain outcome offers readback only, never automatic resubmission. If the
requested result still cannot be observed, administration remains blocked in that
session. Cache clear and access loss discard role authority but retain sent,
unconfirmed intent for fresh readback only. They fence late completions, as does
disposal, but cannot retract a request already sent. Unsent work is canceled;
recovery is in-memory, not durable across session disposal or restart.

The development broker and native transport advertise a separate
`memberAdministration` capability and admit only exact `9000` Admin/Member/Guest
changes or `9001` other-member removals through purpose-bound routes. Generic
invitation signing is unchanged; the relay still enforces the authoritative ACL.
Hosts without this writer can read verified roles but expose no management controls.
Native support requires a rebuilt binary; no unrestricted writer fallback is used.

**Accepted protocol limitation:** role commands are existing relay upserts, not
conditional updates. A departure after final preflight can be undone by the role
command re-adding the target; a concurrent role edit can be overwritten. Client
checks/readback reduce uncertainty but do not provide atomic conflict rejection.
Preventing these races requires separately scoped relay support.

Regression coverage lives in `administration.test.ts`,
`MemberAdministration.test.tsx`, `native.test.ts`, and `browser-host/relay-broker-api.test.mjs`;
existing `ChannelMembersDialog.test.tsx` invitation coverage remains. Synthetic confirmed
writes/recovery and a real-app read/confirmation/cancel exercise do not establish
native or deployed destructive-write acceptance. Those checks and human tryout
remain separate delivery gates.

## Performance and correctness carried from Astra

The port retains the prepared-store implementation and its behavior tests:

- 64 prepared heads / 4 MiB serialized memory budget, separate from history.
- Three unpinned history windows; each caps at 2,400 rows or 8 MiB. Mounted readers
  are not evicted by speculative preparation. A budget cap is distinct from EOF.
- Three read slots, at most one background request, with foreground promotion and
  deduplication. Hover/focus prepares at most one speculative head at a time;
  superseded hints do not form a backlog. That shared head keeps foreground
  priority so selection cannot inherit a host-side background wait. Discovery
  restores reverified disk heads against saved, display-only membership before
  network authorization, without waiting for optional channel names, and does not
  fetch heads across the roster.
  Verified heads save before optional profile enrichment; changed profiles can
  enrich the disk record afterward. Network reads belong to intent, selection and
  retained-window live catch-up. Optional profile enrichment stays background.
  Selecting an already-queued catch-up promotes that existing read without adding
  a request or resetting its deadline.
- 1,024 profile entries and an aggregate signed-record byte budget of the entry
  limit × 2 KiB, evicting the least recently requested profile. While a channel is
  open and active (not a retained background tab), it reserves room for its whole
  roster on top of that base, up to 10,240 entries. Leaving gives the room back
  after the current task, so a remount or a roster count change keeps the loaded
  profiles; the shrink cancels background profile reads still in flight, and
  stops the verified-name syncs it emptied. Verified-name syncs (128 people
  each) have their own pool of 80, enough for the largest cache, apart from the
  32 artifact syncs. A background profile read of many pages publishes once,
  when its pages settle (a foreground read that joins it publishes at once), so
  an open mention menu re-ranks a large roster once instead of per page. The
  channel avatar preview reads at most the first 1,024 members; only the mention
  menu reads a whole large roster. Narrow row profile selectors,
  and request-warmed avatars (fetched and decoded, nothing retained; disabled
  under the Save-Data preference). Signature verification yields in batches.
- Account/relay-scoped IndexedDB: 64 records / 8 MiB global disk budget, 24-hour
  expiry. Signed cached events are reverified before display. The same database
  stores account/relay-scoped startup discovery and sidebar organization (a separate
  8 MiB global budget); old version-1 head records survive the version-2 upgrade.
- A 60-second head freshness lease; warm revisits reuse heads without new reads.
  Partial discovery never treats an omitted channel as a membership revocation.
  Explicit denial or signed membership removal invalidates private cached views.
- Viewer membership discovery follows 500-event roster pages using the relay's
  `(until, before_id)` cursor (timestamp descending, event ID ascending), then
  fetches names in batches of at most 500 channel IDs. Verified grants become
  available page by page; successful paged exhaustion confirms scan-start
  omissions with fresh exact roster reads before reconciling against the roster
  versions present when the scan began. Failure, cancellation, nonadvancing
  cursors and the separate 1,024-entry roster/metadata retention caps leave
  coverage partial. Each scan is bounded to three roster-page reads plus at most
  eight 128-channel confirmation reads; metadata failure preserves successful
  membership evidence and earlier name batches.
- Conventional top-down virtua timeline, prepend anchoring, near-bottom following,
  and three cached geometries keyed by session, channel, content, profiles, and width.

Connection generations and store epochs reject late results after disconnect,
replacement, disposal, or access revocation. The data service outlives plugin
components; it is disposed with the app runtime.

## Local-first launch

The selected community and conversation reuse the existing device view-state.
The relay service restores a read-only session from the account/relay-scoped cache
concurrently with the real connection handshake. Saved groups, stars and channel
names are display data, not a confirmed preference mutation base. No cache means
the ordinary cold connection flow; unavailable/corrupt storage never grants access.

With no saved selection, Messages opens the first channel the relay flags
`auto_join` (its starter channel for new members), then the first non-Solo
channel; an explicit empty route bypasses both. The relay adds a new member to
its `auto_join` channels itself, once, during the invite claim, and the resulting
membership hints populate the sidebar live. The client only reads the flag: it
never sends a join on a member's behalf, and the relay never re-adds a member,
so a later leave stands. In an open community, which needs no claim, the relay
advertises the flag but adds nobody.

A cached roster can display previously downloaded, reverified history for up to
24 hours. It cannot authorize head/history reads, unread evidence, typing or
publishing. Unconfirmed membership is not resaved with a fresh lease. An identical
or newer fresh signed roster promotes it; a complete roster omission or explicit
denial purges both the view and the next-launch record. Partial roster reads do
not prove absence. The live transport's relay identity remains authoritative.

A failed or timed-out handshake retains usable saved content with Retry; browser
online/visibility signals retry the connection. The successor restores its local
read models and materializes retained windows before replacing the cached owner.
The workspace generation stays stable for that promotion, so selection, the
channel timeline DOM and its reading state survive. Ordinary reconnect, account
or community changes still reset presentation lifetimes. Drafts remain scope-keyed.
Cache clearing/disconnect/disposal fence pending restoration and connection results.

`index.html` shows a centered Buzz mark on the synchronously selected light/dark
background before React loads. This is a document launch surface, not a native
pre-webview splash; the native window's initial paint remains separate.
`tests/browser/startup.spec.mjs` exercises IndexedDB reload, held/failed handshake,
in-place recovery, denial-by-omission and both document themes in Chromium/WebKit.
`features/relay/startup.test.ts` covers signed-cache admission and authority boundaries.

## DM label recovery invariant

Access-loss purges remove channel content, not profiles. A kind 0 profile is a
global relay event that any community member can read, so a lost channel does not
make a name private; the profile directory keeps it, and a profile read in
flight finishes. This holds for a denied channel list too: profiles do not
depend on channels. Only a full cache clear (logout, community or scope change)
empties the directory. After roster membership
changes, visible DMs must reacquire missing names through the shared profile
directory at background priority, without blocking conversation opening. Recovery
covers a cleared directory (a full cache clear) and an initial profile read that
comes back empty or fails.

`ChannelsPage` passes the **full** roster to `useChannelLabels`; the hook filters
visible conversations for display/profile demand, but derives its recovery trigger
from all channel IDs. Missing-profile and membership keys remain stable on
ordinary message/preview updates: missing/failed responses must not start a
render-driven request loop. Key fragments remain the fallback for unavailable names.

`useChannelLabels.test.tsx` binds the mounted hook to real session roster omission,
including hidden/archived deletion, a name read that finishes after the deletion,
and empty or failed name reads that retry once on a roster change. `tests/browser/dm-labels.spec.mjs` guards the production page wiring and DOM
labels through the real Refresh channels control and broker.

Open channel timelines and mounted thread/media-comment views need no recovery
after access loss: their names stay in the directory. `revocation.test.ts` covers
roster omission, denied channel reads and a denied channel list keeping names, a
profile read in flight finishing, and a full cache clear still fencing a profile
read.

These are foundational recovery constraints, not a new shared-session API or a
guarantee of general profile retry after every cache clear/network failure. See
[browser coverage and limits](browser-testing.md#dm-label-recovery).

## Membership activity

The live route includes relay-signed kind-40099 `member_joined`, `member_left` and
`member_removed` summaries. History pages do not: a NIP-CW page counts every row kind
against its limit, so a burst of joins could fill pages and hold messages back. After
each page or head read, the window reads the relay's notices apart, newest first in
pages of 500, down to its oldest loaded message, so the messages show first and the
activity between them follows. A head read re-reads the newest notices; when they do
not meet the ones held, the descent starts over. A window holds at most 2,000 notices
read this way, outside its row budget; older pages past that show without activity.
A failed notice read leaves activity out until the next page or head read and never
errors the window. Saved heads carry no notices. Only recognized,
channel-scoped payloads from the connected relay become activity rows; malformed,
unknown and other authors' summaries are not rendered as JSON. These events do not
grant/revoke access: the existing signed roster remains authoritative.

The timeline shows only explicit additions by another actor and removals; self-joins
and voluntary leaves are hidden before grouping. Each uninterrupted run of visible
membership activity becomes one centered avatar-and-text row. Messages and huddles
break runs; local-day changes, elapsed time and different removal actors do not.
Each person appears only under their latest visible action in the run, including
in the hover detail: removal followed by re-addition is described as an addition.
The group keeps its newest event's identity and its oldest event's date.

Small same-adder additions use “added by you” for the viewer; mixed additions do not
invent an adder. Large or mixed summaries keep one name per action and a count;
hovering, clicking or keyboard-opening the count shows the full scrollable people
list for that action. Grouping is presentation-only: all signed events remain in
the group, IDs and cursors remain per event, and reading anchors can resolve any
member event. Profiles reuse the shared background directory/cache. Activity has no
message actions, thread, unread evidence or chat preview.
A Solo chat omits its owner's additions and removals of agents before its first
message once history reaches its start; later changes, people and agents added by others still
show. Membership, access and pagination are unchanged.

An already-running development broker needs a coordinated restart to load the
expanded live filter; frontend hot reload alone changes only the history/rendering
path. No native or relay changes are required.

## Viewing threads

Click a message's reply count to open its root and replies in the right column.
Up to three overlapping participant avatars appear beside the count, with `+N`
for additional participants; missing/unavailable pictures use initials. Like the
count, participants come from the relay's summary, with the authors of replies
this client has sent since that summary placed first, so your own reply's avatar
is among the visible three as soon as you send it.
They reuse the channel's existing shared profile/media path, not extra per-row reads.
On a supporting relay, the panel opens at the newest 10 replies and loads older
pages of 50 when you scroll upward; there is no Load more replies button. It validates
signed NIP-CW thread bounds on every page. A prior scroll gesture wins over initial
bottom placement. New replies arrive through the existing session and the panel
follows near the bottom, preserving reading position above it. Sending a reply is
explicit navigation intent and reveals the new local row.

**Bounded history:** strict mode retains at most ten pages (10 initial replies
plus nine pages of 50); legacy mode retains at most ten pages of 50. A limit notice is
not a completeness claim. An older relay returning verified replies without thread
bounds on the initial probe triggers a clean legacy restart: automatic oldest-first
traversal, whose bottom may not be the newest reply in a long thread. An empty
unsigned probe is ambiguous with access denial and stays retryable/unavailable.
Malformed bounds, failed requests and missing bounds after strict support never
downgrade. Media review still eagerly loads its bounded comment range.
The thread and a linked object panel share that slot; a companion can remain below.
Close or Escape returns focus to the reply button when it is still mounted. Changing
channel/community or disabling Channels disposes the owned thread view.

The footer reuses `MessageComposer` and defaults to a direct reply to the resolved
root through `session.messages.reply`. Reply on a child selects that message as the
parent without changing the root-keyed draft; canceling the target returns to the
root. Channel and thread drafts are separate and survive reconnection; failed
replies remain inline with the shared retry action and retain their signed ancestry.
Read-only connections keep the existing composer capability notice; missing/revoked
roots do not expose a composer. Exact navigation can retain and focus a selected
reply beyond the traversal range; it does not extend that range or promise complete history.

A labelled divider separates the original message from replies only while at
least one reply is displayed. With no displayed replies, including while loading,
it is hidden even if a summary total is known. It shows the relay's thread summary
total, the same count as the channel's reply link, including collapsed descendants. Without a positive summary total it says
“Replies”, never inferring that history is empty from the loaded rows or reader
state. Summary counts can briefly lag a just-sent reply, matching the channel link.
The first reply always shows its author, even when it matches the original.
The original has no day divider above it; its byline already names the day.
Agent-addressed messages retain their date when expanded.
Replies show a day divider only when their day differs from the previous row.

Ordinary replies remain flat beneath the root. Replies to those replies form nested
lists, with ascending timestamp/event-ID order among siblings. Nested branches start
closed and expand one level deep; once opened, they stay open for the lifetime
of the thread view, including through child disappearance and rearrival, until the
reader collapses them from their thread line. Expanding moves focus to the first
revealed reply and collapsing returns it to the branch's summary; deleting a focused reply returns focus to
its available parent or thread history. Labeled expansion controls remain available
when visual indentation is capped in narrow panels. Exact links reveal available
ancestors; a reply whose parent is outside loaded history remains visible with a
notice.
Agents reply beneath the root with `send`. Their core `reply_in_subthread` tool
replies under a named message instead, recording that message as the parent exactly
as a person's Reply does.
Retry appears only after a failed read; there is no routine Refresh control. Names
are optional shared background enrichment. The panel describes **replies loaded**,
not visible rows or complete history.
The relay can filter rows after its limit, and summaries/EOSE are not proof of
exhaustion. See [the thread owner and bounds](relay-queries.md#thread-views).

## Validation and limits

`just scan` runs frontend checks/build, runtime/CLI tests, relay behavior tests,
panel lifecycle tests, GitHub parsing/API tests, headless Chromium/WebKit scroll
journeys, and native checks. See [browser setup, structural limits and diagnostic
measurements](browser-testing.md). Reading intent includes a message anchor for
cold/oversized geometry; legacy positions or anchors outside retained history fall
back to an offset without a same-message guarantee.

Channels supports plain-text Markdown authoring with a shared durable outbox and bounded history.
Channel and thread messages render CommonMark plus GFM headings, emphasis, lists, quotes,
tables, task lists, strikethrough and code, while preserving chat-style single line breaks.
Only credential-free HTTP(S) links are active; raw HTML is ignored and inline remote images
are not loaded. Existing image Markdown is projected as an attachment instead. Custom emoji remain
event-local and are not substituted inside links or code.
Authenticated live traffic reconciles through the same session. Channel creation is not
implemented. In the composer, typing the third character of a line holding only ```` ``` ```` or
`~~~` turns that line into a code block at once, and one undo restores the typed characters.
Shift+Enter on an empty last line leaves the block. Only a fence that opens a block converts: a
fence typed inside an existing code block stays literal, and so does pasted or restored fenced
text, including its closing fence line, so Enter after a pasted or edited fenced block sends or
saves as usual and the text still renders as code once sent. Content copied from a rendered
message or from a composer pastes with its lists, quotes, code blocks and inline formatting as
the composer's own blocks and formatting; text copied from anywhere else pastes as plain text,
keeping only its web links. Paste and Match Style pastes the clipboard's plain text verbatim
over the selection with the caret's formatting: no copied blocks, formatting or links, no linked
selection and no recipients. It is ⌘⇧V or Edit → Paste and Match Style in the macOS app, ⌥⇧⌘V in
macOS browsers and Ctrl+Shift+V elsewhere.
A copied spoiler stays a spoiler whether or not it was revealed, and
keeps its `||` delimiters elsewhere. Headings, task checkboxes and horizontal rules, which the
composer has no block for, paste as their Markdown source (`# `, `[ ]`/`[x]`, `***`) so they still
render once sent. Copied with other blocks, each keeps a line of its own; a heading or rule copied
alone, including by triple-click, pastes into the current line like copied prose, so after other
text on that line it stays text. Plain text keeps a task's state and a rule (`---`) but not
heading markers. Blocks pasted at
the start of a list item, or over a selection that starts there, cannot precede its text: a pasted
list of the same kind (bulleted or numbered) has its items join the list before that item, or take
the place of an item whose only content was selected, and other blocks, including a list of the
other kind, which keeps its own numbering, follow the item's text. Pasted into an
empty item, such blocks leave the list first, as Enter does there, and take the empty line's place.
Typing the space after a list or quote marker that starts a line (`- `, `* `, `+ ` or `• `, a number
with a dot or parenthesis such as `1. ` or `3) `, or `> `) turns that line into a bullet, a
numbered item starting at that number, or a quoted paragraph at once, the same block the
formatting toolbar creates. Mentions, emoji, links and formatting later on the line move into
the new block, and one undo restores the typed marker and its space. The typed
`• ` alias sends as Markdown `- `. The channel placeholder appears only in an empty plain
paragraph, not beside a list marker. Enter
continues a list and exits an empty item; use the Send button to send while the caret is
in a list (or Save changes when editing). Enter in ordinary prose still sends or saves. Inside a
quote the markers nest: `- ` opens a list and `> ` a second quote. Inside a list item only a
marker of the item's own list kind, typed as the only text of an item after the first,
converts, nesting that item as Tab does. A marker typed after prose on the same line, as
inline code or link text, inside a code block or inside pasted fenced text stays literal and
renders as prose or code once sent. A quote marker or a marker of the other list kind typed
inside a list item, and any marker typed in a list's first item or beside an item's prose also
stay literal text in the composer but still render once sent: the timeline shows the list or
quote, nested inside the item, where the composer shows the marker.
Two lists of one kind typed one after the other, or separated only by empty lines, send with
alternating markers (`-` then `*`, `1.` then `1)`) so they stay separate lists once sent.
Typing an inline span (`**bold**` or `__bold__`, `_italic_` or `*italic*`, `~~strike~~`,
`` `code` ``) converts it to formatting as the closing delimiter is typed, including on a
heading line such as `# Title **bold**`, and one undo restores the typed characters. Heading
lines themselves stay text in the composer and render as headings once sent. A single `~`
never strikes, and pasted or restored delimiters stay literal text that still renders once
sent. Reply counts open a bounded thread view; attachments are
links. Routine freshness labels are not shown; Channel Settings → Diagnostics
exposes refresh, outbox inspection and timings. Packaged builds do not
include the development relay broker. GitHub fetches public data only; signed-in
GitHub actions remain on GitHub. A saved-groups/stars failure keeps its specific
reason under **Channel Settings → Diagnostics → Saved groups and stars**.
`Preference query` includes reader queueing, transport and verification; use relay
timings to separate those. `Preference decode` identifies the local decoder stage.
The diagnostic does not trigger another request or change retry policy.

Sending appears immediately in the timeline and shared channel-preview data;
the current sidebar does not render preview text. Delivery
status and retries come from the [unified relay session](relay-queries.md), and a
stale read cannot erase the retained local operation.

Use `session.messages.send(channelId, text)` for channel messages or
`session.messages.reply(channelId, resolvedRootId, text)` for thread replies. Confirmed sends
leave the pending outbox automatically and remain in bounded retained data.
**Outbox → Relay timings** captures and exports stage timings, including in-flight
signing and publishing, without logging message content.


## Reusing conversation UI

Source plugins can import from `features/messages` without depending on bundled
Channels. Pass the current `RelaySession`, stable community/viewer `scope`, channel
identity and navigation callbacks. `ChannelTimeline` also receives the current
`ChannelWindow`; `ThreadPanel` owns allocation/disposal of its thread reader.

`ChannelTimeline`, `ThreadPanel` and `MessageComposer` reset their internal state on
session, scope or destination changes. Callers may retarget ordinary props without
supplying React keys; old thread evidence, scroll state or drafts cannot pair with
a new destination. Persistent draft keys remain `draft:<channelId>` and
`draft:<channelId>:thread:<resolvedRootId>` inside stable scope, not connection generation.
`MessageRow` receives folded data, profiles/media and optional reply/retry callbacks.

This is shared source composition, not a new registry or versioned external UI SDK.
See `tests/fixtures/messages.tsx` for a second consumer that deliberately supplies no
caller remount keys. Its browser regression runs real React StrictMode/session/outbox
with local ephemeral signing keys; it does not contact the deployed relay.

## Community emoji

The smile button in channel and thread composers opens Emoji Mart with standard
Unicode emoji, skin tones, and the selected community's custom category. Its data
and search load only when opened. Fuzzy search by name/shortcode, then choose an emoji
to insert at the cursor; Enter selects a search result and Escape closes the picker
and returns focus. You can also type `:shortcode:`: the closing colon after one
exact Unicode or community shortcode, such as `:+1:` or `:-1:`, replaces it with
that emoji, while partial names, namesakes, times, URLs and code keep the typed
text, including raw Markdown code in pasted or restored drafts. Replacement requires
both catalogs to load successfully; partial suggestions and retry remain available
without automatically accepting the colon. One undo restores the full typed shortcode,
including its closing colon, with the caret after it. The picker follows the host
Light/Dark choice, including while already
open, without recreating its search or dictionary. It does not independently
follow the operating system.

The session owns the catalog and its live updates. Reopening reuses the ready
catalog, without hiding custom results behind a fresh read. Catalog failures expose
Retry while leaving Unicode available and retaining drafts. A catalog that has loaded
stays usable for sending and in the picker while it refreshes, such as after a
reconnect, and when that refresh fails. Only one picker owns
Emoji Mart's global dictionary at a time; scoped custom IDs and disposal prevent
old community entries leaking into search or Frequent. Historical messages and
existing reactions keep their signed emoji URLs after catalog changes.
Emoji-only messages stay at the large 42px size regardless of count; normal text
returns the message to its usual size. Long runs wrap instead of shrinking.
Selecting and copying custom emoji preserves their `:shortcode:` in plain text,
along with surrounding text and line breaks. Pasting into a community with that
emoji available resolves the shortcode through its existing composer catalog.
In the composer, Shift+Left/Right selects each rendered custom emoji as one unit,
preserving its full shortcode for copying, replacement and deletion. Reversing
direction shrinks the selection by one emoji. Visible shortcode text and emoji
that cannot be rendered retain ordinary text selection.
Custom emoji autocomplete adds no trailing space. The native caret uses the
regular composer text size while the emoji preview remains large.

Message and thread reactions use one bubble per emoji, counting unique people from
the second reactor; custom emoji with different URLs stay separate.

Message and thread reaction rows have a Lucide smile-plus button after existing
reactions. Messages without reactions do not show it. The Emoji plugin supplies
the emoji-only picker
through its optional conversation tool `reactionComponent`; the shared message
row owns publication. The picker opens outside the scrolling list, closes on
selection or Escape, and returns focus to the plus button. Failed or unconfirmed
reaction delivery offers Retry reaction through the same outbox. Read-only
connections and archived channels do not expose the action.

The composer shows its GIF tab as soon as relay support is confirmed. Unsupported
results are retried when the picker reopens; the broker caches confirmed support
without retaining negative discovery results. Pickers
without tabs use a search radius equal to the container radius minus the 10px
inset; tabbed pickers keep the smaller 8px search radius.

Emoji uploads and management remain in the existing community workflow.

See [the shared catalog/send contract](relay-queries.md#community-emoji). The local
`/tests/fixtures/emoji.html` diagnostic uses ephemeral identities and no live relay.


## Unread badges and reading intent

The sidebar renders the session-owned [unread capability](unread.md): observed
counts, not exact relay totals. Selecting/preloading a channel is not reading.
Focused, fully visible, settled timeline/thread rows receive an individual marker
after dwell; no automatic channel-prefix advance hides unseen siblings. Conversation
options exposes local-only manual unread, explicit mark-through and sync recovery.
Older synchronized hints may expire under bounded retention. Synced manual-unread
and OS notifications are not enabled by this feature.

### Keyboard navigation and reading

The Channels plugin registers Slack-style shortcuts through the shared dispatcher, so
each is listed in Settings → Shortcuts and can be rebound. All run while typing in the
message editor and are ignored behind a dialog. None run in a terminal, which keeps
Escape and Option+Arrow for the shell.

- **Previous/next conversation** (Option+Up/Down) and **previous/next unread
  conversation** (Option+Shift+Up/Down) step through the sidebar's rendered order,
  Solo chats and team rows alike. `conversation-rows.ts` scans the sidebar's
  `Subscribed channels` list, so sorting, sections, filters and the All/Solo/Team pane
  are already applied; rows in a collapsed section or the inactive pane are skipped. A
  row is unread when it shows the unread or thread-activity marker that
  `SidebarUnread` also reads. The open conversation is the row marked `aria-current`.
  Stepping does not wrap, and at either end it does nothing. When the open
  conversation is not among the rows, next starts from the top and previous from the
  bottom. A conversation listed in two sections is stepped over once. The shortcuts
  are unavailable, leaving the key alone, while the sidebar renders no rows (for
  example behind another page's own sidebar). Stepping activates the row's own
  button, so it takes the exact path of a click: the saved selection, navigation
  intent, session staleness guard and Solo's immediate activation. The list scrolls
  just far enough to show the row, and nothing above it moves.
- **Mark conversation as read** (Escape) uses the open conversation's
  `unread.markChannelRead`, as the row menu's Mark as read does, with no success toast.
  A failure shows an error toast. The page publishes it only for a joined,
  non-preview conversation (not the new message page), and it is available only while
  the connection has `frontier-sync`, the conversation shows unread and focus is not a
  text field outside the composer. It never consumes a dismissal: the dispatcher skips
  events something already handled, panels, tabs, completions and message edits stop
  Escape themselves, and the narrow navigation drawer now prevents it when it closes.
- **Mark all as read** (Shift+Escape) is registered by the shell; see
  [shell design](shell-design.md).


### Attachment layout and scrolling

Message rows show images and GIFs in full-frame previews, whether sent alone
or alongside text. Groups of four or more adjacent images use a two-column grid.
Where the host supplies the media review, adjacent videos join these groups and
the grid shows at most four tiles. If more items remain, the fourth displays `+N`,
counting that tile and the hidden items. The overflow tile keeps every photo/video
reachable in the viewer, including when its thumbnail is unavailable.
Files and audio retain their order and separate layout. Surfaces
without a gallery host keep all previews visible. GIF URLs need no file extension
or MIME metadata for this presentation. Image and compact video pixels use
`contain`, so the whole frame stays visible without stretching or cropping.
Other inline video previews and their posters fill their bounded frames with `cover`.
The media review header displays the selected file's name, falling back to Image
or Video when unnamed, and updates as gallery selection changes. While a thread
read is pending or fails, the viewer preserves the opener's known media and offers
thread retry independently of media loading. Verified removal or invalidated access
retires that fallback through retries until a fresh read re-admits the attachment.
Image and video previews share smoothed corners and a 1px outer hairline, black at
10% in light mode and white at 10% in dark mode. The expanded viewer shows the full
media against a pure-black canvas. Large emoji retain their artwork size with the
larger emoji line height on every wrapped line.
Any click on an image preview, modified or not, opens the original in-app from the
same authenticated media source as the preview: the media review where a
surface hosts one, and otherwise a plain fullscreen viewer (Inbox,
drafts and previews). The preview link's own destination is that media source,
so a middle click, drag or copied link yields the same authenticated URL.

Image attachments reserve loading geometry from valid `imeta dim` metadata,
bounded to 360px wide and 320px tall without enlarging the frame beyond the
original dimensions. Missing/invalid dimensions, including metadata that would
reserve less than one CSS pixel on either axis, use a 360:320 loading frame.
When sending media, the app copies `dim` from the relay's upload result.
After the original decodes, its natural dimensions replace metadata and the
loading frame. Loaded previews follow the image's aspect ratio with no grey
backing or letterboxing, bounded to 360px wide and 320px tall. Exceptionally thin
originals retain at least one CSS pixel on each axis. Decode failure retains the
loading preview; retargeting retires the old source's pixels and dimensions.
Virtualized remounts start with loading geometry again. The timeline preserves
the first visible message or bottom-following intent as frames resize. Resizing
inside a visible message moves its following content in place.
Unavailable media keeps the same reserved frame and displays its status within it.
Exceptionally small frames can clip the visible label while retaining the complete
accessible status.
Valid message-carried `imeta blurhash` is decoded locally into a 32×32 canvas in
that same frame when it intersects the viewport. No thumbnail is fetched. The
preview is removed entirely (including behind transparency) only after the lazy
original decodes; failure retains the preview. Missing/invalid hashes or canvas
failures keep the existing background. Syntax validation bounds hashes to 166
base83 characters / 9×9 components; folding does no pixel work. Preview work is
per-mounted-image and uncached, visibility-gated even in nonvirtualized threads.
Without IntersectionObserver, only the ordinary placeholder/original is used.
This favors bounded visible work over instant offscreen previews on scrolling.
`tests/browser/image-scroll.spec.mjs` covers delayed/failed loads, actual remounts,
bottom following, reading anchors and narrow layout in Chromium and WebKit.

## Opening an exact message

Message-addressed conversations reuse the normal timeline and thread panel. A
verified, loaded top-level target is revealed in the timeline. An off-window
message opens as the root in the existing thread panel; a reply opens there with
its actual root and bounded surrounding replies. No around-message channel query
or separate detail screen is added. The presentation choice stays fixed for that
navigation attempt; exact reads do not insert isolated old rows into channel history.

Navigation completes only after the exact folded target is visible and focused.
Reclick/Back reveals again; live/profile updates do not steal focus. The shared
rows preserve Markdown, profile links, composers and background enrichment.
Opening never marks read directly: the ordinary focus/visibility/dwell hook applies.
Missing/deleted targets, access loss and failed reads expose failure/retry instead
of channel-head success. An accessible reply remains visible when its root is
unavailable, without a thread composer. See [the evidence contract](relay-queries.md#exact-message-navigation).
