# Client and community ownership

The app opens into Personal space with no joined community. The shell, local
profile editor, Home, Settings and plugin management do not wait for a relay.
`features/communities/service.ts` owns the local identity's default profile,
saved memberships, optional selection and the [known-community sync
state](#known-communities). `features/relay/session.ts` still owns
each community's queries, live subscriptions, projections and durable outbox.

## Try it

Configure `BUZZ_DEV_VIEWER` with your existing Buzz public key in `.env.local`
([setup and safety notes](contributing.md#live-relay-development)), then run
`just web` and open the Local URL it prints, or use `just desktop` instead. The
development broker runs on macOS and Linux and refuses an OS-store identity
that does not match your explicit public pin.
Click the avatar → **Settings → Profile**. With a community selected in the
header's community picker, Save updates only your profile in that community;
there is no separate profile-destination selector. In Personal space, Save edits
the local default for new communities without publishing. Open the header's
community picker, choose **Join a community** and type a **Community URL**. With
no community saved, the picker is labeled **Communities**; otherwise it shows the
selected community's icon or the Personal space globe. There
is no destination dropdown. Accepts `wss://` or `https://` origins, for example
`wss://relay.example.com` or `wss://other.example.com`, and other
Buzz-compatible community relays. No community is pre-joined; a packaged build
that sets [`BUZZ_DEFAULT_COMMUNITY_URL`](configuration.md) only preselects one.

Surrounding whitespace, host case, a final DNS dot, default port 443 and a single
root slash normalize to the same HTTPS origin. Non-default ports are preserved.
Credentials, insecure schemes, non-root paths, query and fragment are rejected,
not silently stripped. Continue starts discovery and authenticated profile reads;
typing does not contact a relay. The canonical origin stays visible before policy
acceptance or profile publication. Failed setup keeps the typed input and current
selection. Reopening the same canonical origin does not duplicate its membership.

An existing readable profile is offered unchanged: **Open community** saves the
membership locally without publishing. New setup shows the relay's join policy,
optional invite code, then a profile prefilled from the local default. Invite
admission uses the relay's policy receipt and signed claim endpoints. Profile
publication uses a signed kind:0 event and requires a matching accepted receipt
and current profile readback before the client saves the completed membership.
Rejected setup retains input and does not replace the currently selected community.
An admitted invite is a remote side effect and is not undone if later profile
setup fails or is cancelled. The native first-run **Join Community** page
(`features/identity/Welcome.tsx`, [identity](identity.md)) is the only other
caller of `communities.joined`, through the same owner as the dialog
(`join.ts`): the join is journaled before any remote effect, a code from an
invite link or the invite page is claimed with the same policy receipt and
signed claim (a journaled join reads before it reclaims), and the signed profile
read proves admission; the join itself publishes no profile. The first-run
profile step that follows, when no profile exists yet, is the dialog's: a fresh
read, a kind 0 published when the draft differs, its readback, and only then
the saved and selected membership. First run's
restore of the account's [known communities](#known-communities) joins each
admitted destination through the same read and call. `Welcome` is also the
second caller of the invite intent (`invite-intent.ts`) beside OS deep links:
an address typed on the welcome screen that the restore did not admit opens
this dialog, prefilled, as the app opens. A member newly admitted by an invite
claim already has the community's default channels in the sidebar, and Messages
opens the first of them. In an open community, which needs no claim, neither the
relay nor the client joins them. See
[local-first launch](channels.md#local-first-launch).



Profile editing preserves existing fields that this editor does not expose.
After a confirmed Settings save, the profile also becomes the device-local
default used in Personal space and new-community setup; other existing community
profiles are not changed. Media under the current community's `/media/` path is
not copied into that default:
its previous picture is kept, while public URLs and explicit removal still update
it. First-join seeding follows the same rule. URLs hosted by another community and
URLs entered in Personal space are not classified by this guard; user-supplied HTTPS
URLs are not guaranteed portable. The top-right button and menu show the selected
community's name and avatar through its existing profile/media session. Pending
or unavailable community profiles show an identity fallback, not another
community's avatar. Personal space uses the local default. Merely loading a
community profile does not replace that local default. The first completed community setup seeds
the local default only when it is still empty.
The shared avatar editor supports image upload/drop, HTTPS URLs, emoji artwork
and removal. Done changes the form draft; Save applies it. Uploads use the selected
community's existing media transport. Personal space accepts a public HTTPS URL
without uploading. A protected media URL from one community is not a portable
public avatar for another. Switching communities retires the editor: a save not
yet dispatched is cancelled, while an already dispatched save remains bound to
its original community and cannot alter the next community's draft. Settings Save
re-reads the effective name/picture/description after the accepted receipt; a failed read or
conflicting current profile retains the draft for explicit Save retry instead of
reporting success. This confirmation is not a transaction against other clients.

Use the header's community picker to select a saved community or Personal
space. Personal space
clears selection without forgetting memberships. Its **Join a community** item opens the
existing join dialog; displaying saved communities reads relay metadata but does not open sessions for them.
Right-click a saved community (or press the ContextMenu key or Shift+F10 on it)
for Mark all as read, Copy community URL, Invite to community, Community
settings and, last, Leave community. Only the selected community can be marked
read, and only while its read state syncs; Invite shows only where the viewer
owns or administers the selected community and this build can mint invites,
with the role read from the relay-signed roster through the selected
community's existing session rather than a further session request. The
Membership settings card applies the same role gate in both development and
native builds. Owners and admins in both builds read the relay-signed member
list, mint invite links, add members directly and change or remove members. Each
change is one NIP-43 command (kind 9030 add, 9031 remove, 9032 role) signed by
the viewer: the broker signs it in development, and the native host signs only
that exact shape and posts it to the relay's `/events`. The relay alone decides
authority; the client offers only the actions its matrix would allow, shows its
listed refusals verbatim and re-reads the roster after an accepted change. Copy,
Community settings and Leave work on inactive communities without opening their
sessions. Leave asks for confirmation, then sends a signed NIP-43 leave request
(kind 28936) to that community's relay before the device forgets it. Three
answers end the membership here. The relay accepting, or answering that the
viewer is not a member, removes the community and clears its drafts, reading
positions and other device state, since the relay holds nothing to go back to.
The relay answering that the viewer is banned also removes the community and
disposes its session, but keeps that device state: the relay still holds the
membership while a ban lasts (bans can be timed or lifted), and the data is
keyed by origin and viewer, so adding the community again by its URL finds it.
That notice says the viewer is currently banned, so the leave was refused, and
promises nothing about how long; it never calls access revoked for good. Any
other refusal or an unreachable relay keeps the membership and reports the
failure so Leave can be tried again. Once the relay has answered, only this
device can still fail: a device record that will not save keeps the community
in the community picker and says so, naming the storage error so a store that never saves
is not the same promise every attempt, and leaving it again finishes through
the not-a-member answer; a store that will not clear is logged by name and the
success notice says some saved data remains. A left community that was selected
lands on Personal space through the host's selection path, exactly as clicking
Personal space would; a host callback that fails there is logged as the host's
own error, and the leave still reports success because the device did finish.
Messages shows an intentional
empty state there. Try drafting in A, switching to B, then returning to A.
Selected channels, drafts and reading offsets are partitioned by the canonical
community origin and viewer; channel IDs alone are not sufficient keys.

## Import from the previous desktop app

After native startup, Buzz offers the previous desktop app's saved communities
for the signed-in identity. The dialog lists eligible secure origins and warns
that importing may restore communities previously removed. Nothing is added or
queued for account sync until **Import communities** is chosen. **Skip import**,
Close, or Escape declines the import and keeps that decision across launches.

Every nonempty import requires consent. An empty local record or account list
cannot establish an untouched account: acknowledged removals leave no history,
and pending or unsuccessful sync cannot establish it either. Existing memberships
and settings stay unchanged. Memberships and removals observed while the read or
consent is pending are checked again before adding anything.

The native reader opens the previous app's macOS WebKit storage read-only and
skips symlinks. An absent root reads as empty; traversal or database errors leave
the import retryable on the next launch. A read or save that does not complete
does not record approval; disposing a pending prompt does not record a decline.
Other platforms have no supported legacy storage source.

## Known communities

The device record also carries which saved destinations the account service
last reported holding and the uploads still owed to it, in the same single
write as the memberships, so a join or leave and its upload intent cannot be
split by a failed or interrupted save. Destinations are addressed the way the
service spells them, `wss://host[:port]` with a lowercase host, no default
port and no trailing slash; a configured alias resolves to its origin first and
never leaves the device. Records from before this field existed, or a field
this reader cannot understand, read as empty, and a malformed entry is dropped
on its own.

The account's list is a set: the service's add and remove are idempotent, so
the outbox holds at most one intent per destination, the latest. Joining queues
an add and leaving a removal, and a newer intent replaces the older one
outright, since whichever edit lands last is the state. An intent the latest
word already satisfies (the pending intent, or the service holding the
destination) queues nothing, so re-running a join the service already holds
sends nothing; removing a destination the service is not known to hold still
queues, in case another device saved it. An accepted upload moves the
destination into or out of the known set and drops the intent, unless a
different one has replaced it meanwhile, which is then sent in turn. This is
what makes a lost answer safe: the retry simply sends whatever intent stands,
so joining then leaving (or leaving then rejoining) across a lost
acknowledgement converges on the latest intent. A complete list from the
service adds destinations saved on another device under their host name
without opening a session, and queues an upload for saved memberships the
service has never seen, which is how a device list from before sync existed
reaches the account; a pending intent for a destination speaks for it in that
merge. Removals made on another device are ignored for now, a deliberate
interim choice: a saved membership the service knew but no longer lists stays
on this device, and sync never forgets a membership. So that this device does
not undo the other's removal by uploading the membership again, the known set
is cumulative for its account (everything the service has listed or accepted
an add for, less the removals it accepted from here) rather than the last list:
the omitted membership stays known, and so off the queue, on every later
sign-in. Leaving it here still propagates. Until removals are followed, the
devices of one account can disagree about a community, and an add queued while
the service was unreachable can likewise land after another device's removal.
Joining and leaving never wait for sync. The `knownCommunities` capability
exposes the record, the queue and these writes to one owner, the bundled
Builderlab plugin. First run reads the same account list after the Builderlab
sign-in and restores it before the app opens ([identity](identity.md)): each
destination that admits the new device's key is joined through an admission
read, so a refused or unreachable one is not saved then; the next sign-in's
merge adds it without a read, as for any other device. Removals are ignored
there too. A join on first run's **Join Community** page is also posted to the
account's add at once with the first-run sign-in's credential, since the
Settings session that sends the outbox may not exist until a later manual
sign-in; `joined()` still queues the add, and the next sign-in sends it again,
which the service's idempotent add makes harmless. Restored destinations are not
posted.

The list is account-scoped, but this state is still kept under the device
record's viewer key (`buzz-client.v1:<viewer>`), where it outlives a
Builderlab sign-out. So the record also names the account whose list the
known set describes, and a merge for a different account (or for a record
that names none) starts from nothing known, with the outbox kept, so every
saved membership the new account's list lacks is queued for it. Signing back
in as the same account keeps the set, so a membership it once held and no
longer lists is still neither forgotten nor uploaded again. Moving the state
to live with the Builderlab account is a follow-up;
until then a device whose identity changes starts from an empty record and
re-merges on its next sign-in.

The plugin starts a sync owner only where signing in is possible: the native
app with a configured Builderlab service. The owner syncs only while signed in.
Each sign-in reads the complete list, merges it as above, then sends each
destination's latest intent one at a time. A newly queued intent, the window
coming online or becoming visible runs the drain again at once; once the list
has merged, a trigger never reads it again before the next sign-in. A failed
request, or a device record that would not take the answer, retries at 1, 2,
4… seconds, capped at a minute, re-sending the intent that then stands; a
timeout, a rate limit and a server error are such failures. The service's
refusals are never retried as sent: an address it refuses, an account that is
full or any other client error parks that one intent until it is replaced or
the next sign-in while the rest continue, an
account that cannot sync or a list this client cannot read (a shape the two
sides no longer share) stops until then, and a session the service has ended
signs the plugin out. A service that answers any of the routes with 404 has no
known-communities routes yet, or not all of them: sync stops until the next
sign-in. The owner reports nothing to the app, so a halted or parked sync is
not shown anywhere yet; each refusal is named once in a console warning (the
route, the address and the reason), since an account without the routes'
server capability is refused on every sign-in and would otherwise leave no
trace on the device. A listed address this device could never save is left
out and counted the same way, so one bad row cannot stop the account's sync.
Signing out or disabling the plugin abandons the request in flight and leaves
the queue intact.

## Session lifetime

Selecting a saved membership lazily acquires its session. Sessions survive page
navigation and switching; startup opens only the selected one. Once its agent
list loads, Agents also opens each joined community where the viewer has an
agent, through `open`, which connects without selecting so those agents keep
running, and retries one whose connection failed while it is not selected. Opened communities
retain their existing per-session query/cache budgets. Arbitrary destinations mean
there is **no longer a two-session maximum**: retained session count grows with
communities opened until app disposal. This slice does not add background eviction
or change in-flight delivery ownership. A failed session remains retryable without
replacing the shell or its siblings.
App disposal closes all owned contexts and their subscriptions.

The `ctx.relay` compatibility reader follows selection. A component captures a
concrete session for reads and commands. Every broker request, including signing,
publishing, media and live traffic, uses that session's destination path. A send
started in A continues in A even after B becomes selected. Connection generations
still fence obsolete work within a session; they are not persistent storage keys.
Channel-head persistence now includes community origin as well as viewer, rather
than relying solely on the relay signing key. In development broker mode signing keys never enter browser
JavaScript; local preferences contain the public viewer ID only. The app-owned
[native identity UI](identity.md) has deliberate import/reveal/copy interactions,
not a plugin key service.

Packaged builds do not include the broker. Native macOS, Windows and Linux
[identity import/create](identity.md) and the shared native relay adapter provide
discovery, admission, leave requests, profile publication, authenticated reads and
supported event writes. Native invite minting and relay-advertised KLIPY GIF search
use the same captured HTTPS community; neither requires the development broker.
Windows/Linux installed-app acceptance remains unverified. Community creation and
background connection eviction are not implemented. Avatar uploads still require
the development media host. Agents have local
configuration plus separately scoped participation; selecting a community must
not become a deployment or enrollment command.

## Packaged admission and recovery

The native dialog journals an unfinished join before policy/claim dispatch and a
submitted profile before publication. Records are partitioned by public viewer
and canonical HTTPS origin, independent of configured aliases. Existing alias
records normalize to origins when their mapping is available and are persisted
on the next journal write. Unresolved legacy aliases are retained independently:
they do not block other joins or recovery, and become available again after
restoring their original mapping. Records contain only a transaction ID,
destination and optional profile draft, never invite codes, policy receipts or
private keys.
Storage failure blocks the remote operation. Completing a native join requires
successful local membership persistence before clearing its recovery record.

After closing or restarting, open **Join a community** to resume the most recent
unfinished destination. Continue makes a fresh authenticated profile read, with
strong consistency. Successful access resumes profile setup even if the profile
does not exist yet; it never requires reusing an expired invite after admission.
Network failure retains the record for retry. Confirmed access denial returns to
the policy/invite step, where the user can supply a valid code and current consent.
Profile readback avoids repeating a publication whose receipt was lost. An accepted
publication also requires a fresh matching profile read before saving membership
and clearing the journal. Failed reads, missing profiles and superseded writes
retain the submitted draft for explicit retry, including after restart. Late
completions cannot advance an unmounted dialog or a replaced transaction.

Saved memberships are restored through the existing session owner. Uncertain
message delivery stays in the existing endpoint/viewer-scoped IndexedDB outbox,
with no automatic resend on restart. See the [native transport limits](identity.md#packaged-connection).

## Development broker boundary

One parser in `features/communities/destination.ts` serves UI, membership hydration
and broker routing. Optional `BUZZ_COMMUNITY_ALIASES` JSON configuration maps
previously saved short IDs to secure origins; no aliases ship by default. Set the
same alias-to-origin mappings in ignored `.env.local` to reopen memberships that
use short IDs. Unknown but valid aliases are retained in local storage without
being shown or connected; profile edits preserve their saved selection. An explicit
Personal selection or a new join replaces that selection, not the retained membership.
Restore the original configuration and restart to make those memberships available
again. Never remap an existing alias to another community. With no configured alias, new community IDs
are canonical HTTPS origins. Existing origin + viewer storage
keys for drafts, reading state and outbox do not change. Saved aliases and URL
variants deduplicate; malformed saved destinations are ignored independently.

Before contacting a new origin, the client makes a same-origin POST to
`/api/relay/register`. Registration validates and remembers the origin in the
broker process, with **no upstream request, join or signature**. Scoped routes
only resolve registered destinations (configured aliases remain available for
old callers). `BUZZ_RELAY_URL` optionally supplies the unscoped broker destination;
without it unscoped relay operations fail explicitly. `/api/relay/identity` stays
available independently. These settings do not join/select a community or send a
request on startup. Both are public routing values, not credentials; alias mappings
are embedded in the frontend. Restart/rebuild after changing them. Environment
variables override `.env.local`; see `.env.example`. As a separate opt-in,
`BUZZ_DEV_OPEN_RELAY=1` makes a live dev server save and select the canonical
`BUZZ_RELAY_URL` origin for a viewer whose local client record is absent, labeled
with the relay host. Only `1` enables it and it requires `BUZZ_RELAY_URL`; any
saved record, including Personal space, wins; switching in the UI never writes
configuration; production builds ignore it. Session acquisition/retry registers again, including startup of a
saved custom community after broker restart. Query/sign/publish, policy/claim,
owner/admin invite minting and member changes (`invite`, `member`; scoped only,
relay-enforced, used by the bundled `buzz.moderation` plugin), metadata, protected
media and live traffic stay bound to the captured destination.
HTTP authority discovery and other upstream fetches reject redirects.

When a viewer pin enables the broker, Vite configuration rejects non-loopback
listeners, including CLI `--host` overrides, before loading the signing identity.
Use the default listener or `--host 127.0.0.1`; unpinned fixture servers do not
load an identity and retain Vite's normal host options. Packaged builds exclude
the broker.

The broker also checks the loopback Host, requires exact local Origin on POSTs,
and rejects mismatched Origin or non-same-origin Fetch Metadata on GETs too.
This establishes **trusted-app-origin intent, not a human gesture**; same-origin
plugins and local processes remain trusted, not sandboxed. User-directed HTTPS
networking may reach internal/private destinations. This is not a public-only
network policy or DNS-rebinding defense; TLS verification remains enabled.
This broker integration does not expose private keys to JavaScript or widen CSP.
The separate [native identity adapter](identity.md) deliberately exports keys for
backup; same-origin plugin JavaScript is trusted and can invoke that IPC too.

## Verification

`src/features/communities/service.test.ts` covers no-community initialization,
local profiles, scoped view intent, session retention, selective restoration and
leaving (membership removal, Personal space fallback, session disposal, purged
device state, a leave that keeps device state for the banned answer, the last
community, a purge that leaves named failures, and a native device record that
will not save, which throws before the snapshot, session, record or device state
change), that join and leave each write the membership change and its queued
upload in one record write which a restart restores, applying a server list
(additions under the host name, nothing forgotten, one record write) and a
native sync write that will not save.
It also covers that re-running a join the service already holds queues nothing
while a join it does not hold queues an add.
`known-communities.test.ts` covers the queue rules on their own: one latest
intent per destination with a newer intent replacing the older, nothing queued
when the latest word already agrees, acknowledgements moving a destination in
and out of the known set while keeping an intent that replaced the settled one,
both lost-acknowledgement orders converging on the latest intent as a plain
retry, every list-merge branch including the omitted membership kept and not
uploaded again, the pre-sync migration upload and deference to the pending
intent, and the
tolerant reader of saved state.
`src/bundled/builderlab/known-communities/client.test.ts` covers the account
service's three routes against the native host transport: the exact request
shapes, the device's spelling of listed addresses, omitted repeated fields,
unsaveable addresses dropped and counted, rows of another shape and a success
without a JSON object body answered as an invalid response, every named refusal
in JSON and in the framework's plain text, unnamed client errors returned as
rejections on every route while timeouts, rate limits and server errors remain
failures, a 401 that ends the session and an unreachable service.
`sync.test.ts` covers the owner under a controlled clock: sign-in and a
loading record, the complete list merged once per sign-in and an intent queued
while it is in flight, the never-uploaded rule on a later sign-in and a
membership removed elsewhere kept and never re-sent across the sign-ins after
it, one upload in flight at a time in queue order, identical retries at each
backoff boundary and the reset after a success, a device record that will not
take an answer backing off and replaying, the `online` and `visibilitychange`
triggers and no second list once synced, parked and halting refusals
including rejections by status, an unreadable list (through the real client,
keeping every membership) and the 404 on the list or an upload for a service
without the routes, addresses the list left out, a parked add replaced by the
removal that then goes out and re-sent on the next sign-in, a withdrawn parked
intent sent when queued anew, both lost-acknowledgement orders against a set
service, an abandoned upload on sign-out that keeps the queue, a session ended
by the service and disposal. `index.test.tsx` runs the real plugin wiring
through to the list request under the signed-in credential, and that an
unconfigured build starts no owner.
`CommunityPicker.test.tsx` covers the leave flow end to end against the
broker route: confirm, publish, then remove; cancel; refusals and timeouts that
keep the membership; the not-a-member answers (purging) and the banned answer
(keeping device state); a device record that will not save after the relay
answered, naming the storage error; a host selection callback that throws after
a completed leave; residual saved data; the host selection of Personal space for
a left selection; focus placement; the in-flight state; and that no inactive
session is acquired. `device-state.test.ts` covers the per-origin purge and its
per-store failure report. The broker and native adapter tests sign the exact
leave shape and pass through only the relay's known refusals.
`broker.test.ts` runs real localhost HTTP with signed fixture events to verify
multi-community routing, profile publication, invite claims, and a captured send
after opening another community. `destination.test.ts` checks normalization,
rejection and the account service's `wss://` address; `broker-url.test.ts` exercises the real middleware with isolated signing
keys and upstream fixtures, including registration, cross-origin guards, all route
sinks and captured sends. Service tests cover arbitrary membership persistence,
selected-only restore, retry registration and equivalent-URL selection. Existing relay tests cover connection generations,
late responses, delivery and revocation.

`native-join.test.tsx` mounts the real dialog, community service and native adapter
with fixture IPC to cover claim/profile response loss, acknowledged but superseded
or missing profiles, read and persistence failures, interrupted setup, alias
recovery, selected-only restart and the completed join's queued upload in its
device record. `join-journal.test.ts` covers alias addition,
removal and unresolved legacy records across restarts. `native-api.test.ts`
and `relay/native.test.ts` cover routing, verification, live auth, capacity,
receipt correlation and expired-event readback. `app/services.test.ts` exercises
native composition, failure/retry and development precedence. Rust tests cover
actual IPC signing, exact-byte HTTP authentication and redirect rejection without
touching Keychain.

One browser case is added, with none removed: `tests/browser/mocked-native-ipc.spec.mjs`
proves page reload and real localStorage/IndexedDB recovery in Chromium and WebKit.
It preserves one identity across an uncertain claim, joins, loses a message
receipt, reloads, then explicitly retries the identical signed message. The IPC
endpoint is mocked by Playwright; it does not establish Keychain consent, a full native
process restart, production TLS, deployed relay interoperability or notarized
release acceptance.

The paired `tests/fixtures/mocked-native-ipc.html` and `.tsx` files mount the real
community dialog, identity/community services and JavaScript native transport
adapter. Playwright supplies the identity, signing and HTTP responses and stubs
WebSocket; browser storage and reload are real. The page requires the test's IPC
endpoint, so it is not a standalone manual diagnostic.

This regression fixture originated in `78d986c0`, independently of the recording
toolkit added in `f68926da` and removed in `0a9ff77f`. It remains automated test
coverage, not a native-app recording. Any retained local recordings from that
removed toolkit used a simulated host; their source revision must be established
from capture metadata, not the gallery's hard-coded revision label.

Regression evidence: restoring the original unfiltered signing payload makes
both browser engines fail at message delivery (`failed` instead of `unknown`),
because the IPC fixture enforces Rust's strict template shape. Restoring the
four-field projection passes the journey.

Run it with:

```sh
bin/pnpm test:browser tests/browser/mocked-native-ipc.spec.mjs --project chromium --project webkit --no-deps
```

Open `/tests/fixtures/communities.html` for a browser-only fixture of the actual dialog.
It intercepts all broker requests and uses a separate fixture identity. Save a
local profile, join using any invite code, and customize the prefilled name. The
first profile publication deliberately fails; retrying should add the membership
while keeping the local name unchanged. No remote membership, profile, or policy
acceptance is created by this fixture. Live validation with an authorized identity can restore existing profiles and
read selected communities without posting test messages. The fixture itself is
not evidence of live access; see [manual fixture setup](contributing.md#manual-browser-fixtures).

First-run profile setup preserves an existing relay profile, including one without
a display name, and skips editing it. When restoring multiple saved communities
without a requested destination, Buzz prefers one with an existing profile. After
admission, new-profile setup offers Continue without a Back action: returning to
selection would not undo the membership already granted by the community.
