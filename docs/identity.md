# Packaged human identity and relay access

Native macOS, Windows and Linux without the live development broker open on a
welcome screen when no human key exists on this device: **Buzz** — "Your people,
your agents, your projects — all in one place." — with **Sign in with Builderlab**
(the label the Buzz mobile client uses; first-run copy never names the sign-in
provider) and a live **Community URL** field with **Continue** beside it (the
same field and normalisation as Join a community below). Sign in runs the
bundled Builderlab plugin's browser sign-in under that plugin's own native
network grant; that credential is not yet shared with Settings → Integrations →
Builderlab. A failed or canceled sign-in shows *Couldn’t sign in* with the
error and **Back** to the welcome screen. The welcome screen carries the
onboarding artwork and wordmark, and every later first-run page sits on the
same artwork; pages without a finished design are plain black-and-white
wireframes. When a page replaces another, focus moves to the new page's
heading unless the page focuses a field itself, and **Back** returns focus to
the choice that opened the page.

In federated-identity builds (`BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG`) the
bundled Builderlab plugin has no network grant of its own: its Builderlab calls
go through the native FI session (#1461). There, **Sign in with Builderlab** is the
native [organization sign-in](#native-federated-session-module), whose browser
step, code exchange and token stay native. A session that already exists,
including one saved by an earlier run, signs in again, so the browser can
choose the account; if that sign-in is canceled, first run stops rather than
continuing as the old account, and one that times out fails as *Sign-in did
not finish*. Setup's account calls then go through the native forwarder as the
bundled plugin's installation, fenced to that session, and a backup hands the
uploader the session's revision. Native admission checks only that
installation's grant, so this works whether or not the plugin has started.
*Checking for a backed-up key* (below) goes through the forwarder too, so
Welcome back offers a restore where the portal accepts the session there. The
session outlives first run: sign-in at launch finds it signed in.

A URL given on the welcome screen is looked up first, before sign-in and before
any key exists: **Continue** opens the same **Finding community** page described
below, which sends only the two unauthenticated GETs, so a typo, an unreachable
relay or a non-Buzz address fails there with the same classified copy; **Cancel**
(and **Retry**, when offered) behave as below, except that Cancel returns to the
welcome screen with the address kept in the field. A build has one Builderlab,
and the only listed deployment is the public one (`builderlab-hosted.ts`): a
host under `communities.buzz.xyz` on the default port, or a relay publishing
that deployment's NIP-11 `self` key, is hosted by this build's Builderlab when
the origin of `BUZZ_BUILDERLAB_URL` is `https://app.builderlab.xyz`. Such a
community requires Builderlab sign-in, so it starts at once there, exactly as
the welcome screen's own button does, and the welcome screen shows it pending
(**Cancel sign-in**, with the field disabled); setup then lands on **Join
Community** for the address, and it is never offered a key of the user's own
instead. Cancel sign-in, and **Back** from a sign-in or setup failure, return
to the welcome screen with the address kept and do not look it up again. A
canceled sign-in that finishes later is ignored: it cannot restart setup or use
a later sign-in's account. Any other found community, including one run by
another Builderlab deployment, and every community in a build whose
`BUZZ_BUILDERLAB_URL` is another origin or empty, pauses on **Connect to
{host}**: nothing a relay publishes names its sign-in portal, so the user
chooses. The page says only that Buzz relies on a key for the user's identity; its choices are
**Sign in with Builderlab**, which signs in at `BUZZ_BUILDERLAB_URL` and
continues exactly as the welcome screen's own button does (the landing shows
the sign-in pending with the address held; the key it creates is linked to that
account and backed up there), and setup then lands on **Join Community** for
the address;
**I already have a key** opens **Enter your private key** and, with no account
signed in, continues from there with no link step and no backup offer; **Back**
returns to the welcome screen with the address kept.

Success continues to **Getting ready**, with an animated bee. Detailed operation
status remains available to screen readers without a visible second line. It first runs **Checking your account**, a real read of the
Nostr key bound to the signed-in Builderlab account
(`POST /api/goose/v1/buzz/nostr-identities/current` at the portal that signed
the user in, authenticated with the first-run session credential and sent
through the bundled plugin's native grant; `src/features/identity/builderlab-account.ts`,
sharing the hosted-communities card's routes and reply parsers). A `200` with
no `identity` means no key is linked (kgoose sends `MISSING_MAPPING` only from
the community list); any other failure is **Couldn’t finish setup**, naming the
step and HTTP status (never the response body), for example "Builderlab account
check failed (HTTP 403: not JSON)". A lapsed sign-in, which kgoose answers on
every account route with a plain-text HTTP 401, reads *Your Builderlab sign-in
is no longer valid.* here and on every later account step. Binding is 1:1 and
enforced, so the answer picks the lane: a linked account is never given a
second key. Under the same label, and in parallel, it reads the destinations
saved to the account (`POST /api/goose/v1/buzz/known-communities/list`, same
portal and credential: the list the Builderlab plugin's
[known-communities sync](communities.md#known-communities) keeps, which needs
no Nostr identity). That read never fails setup: a refusal, a portal without
the route (a plain-text `404`) or a row the app cannot read leaves the list
unknown and first run continues as if the account had saved none. The list is
kept from sign-in until the welcome screen is shown again, so Start over keeps
it, and every lane ends by restoring it (*Restoring your communities*, below).

Either lane continues with *Checking for a backed-up key*, which reads the
keys the account holds a backup of
(`POST /api/goose/v1/buzz/nsec-backups/status`, same portal). It is sent only
where the backup step can run (see
[automatic backup](#automatic-backup-and-optional-recovery)); kgoose answers
`404` wherever backups are not configured. Not sent, a `404` or any failure
leaves the lookup unavailable rather than empty, and never fails setup: it only
decides whether Welcome back offers a restore and whether an import needs
automatic backup.

**Not linked** pauses on **Get started with Buzz**, which says the account will
manage the Buzz identity. **Set me up** creates and links a key; **Use an
existing key** opens **Enter your private key**. **Use a different account**
signs out the first-run session and returns to the welcome screen.
The browser may retain its portal session. This choice page shows the signed-in
email so the account can be checked before linking a key.

Builderlab setup automatically backs up the created key after linking it to the
signed-in account and waits for the uploader. The import screen discloses
this behavior. A failed backup stays in setup with **Try again**, preserving the
key on this device; it cannot be bypassed by disabling backup. If the session
has expired, retry signs in again and must return to the original account before
uploading. A canceled sign-in or different account leaves setup and the key intact. First run never
reveals a newly created key; Settings → Identity can reveal it later.

**Enter your private key** accepts a plain-text `nsec1…` key or a text file up to 1 KiB.
The input stays masked until **Reveal private key** is selected using the eye
inside the field; **Hide private key** masks it again. The public identity preview uses npub. NIP-49 encrypted backups are not supported;
invalid input stays on the form. **I lost my key** sits under the input. **Back**
discards the draft. A successful account-backed import links the key and automatically backs it up
unless that key already has a backup. An import without Builderlab
sign-in skips linking and backup. Importing without a Builderlab account never uploads the key.

**Linked** pauses on **Welcome back**: the account is already linked to a Buzz
identity — the key on the user's other device — shown as the full npub under
*Linked public key (npub)* with **Copy**, with the same *Signed in as {email}.*
line under the body. A linked key does not mean a
backed-up one, so only when the lookup lists the linked key does the page also
offer **Restore from backup** (primary), with **Enter your private key** as a
smaller choice; otherwise **Enter your private key** is primary. It opens the
same import page, which here accepts only the linked key: any other valid nsec
is refused under the field with *That isn’t the key linked to this account. It
expects npub1…*, and **Back** returns to Welcome back. **Recover from another
device** is *Coming soon* (device pairing is its future entry). Last in the
stack, **Use a different account** is the same exit as on Get started with Buzz: it
signs the session out and returns to the welcome screen without importing,
restoring or replacing the linked key. The imported
key is already the account's, so nothing is linked. Unless the lookup already
lists it, a successful import automatically backs up the key as on a new
account; a listed key continues without another upload.

**Restore your key** opens native recovery in a separate browser sign-in.
Only the account’s linked key can be installed. While waiting, **Cancel** cancels
the attempt; during installation, navigation is disabled. A successful install
continues directly to community restoration and the next required step, without
another Welcome back confirmation. One status screen shows **Restoring your key…**
throughout recovery, with a browser sign-in hint while waiting. Failure shows **Couldn’t restore your key**,
with **Enter my private key**, **I lost my key**, optional **Try again**, then Back.
Retry is available for transient errors and partially retrieved backups, but not
for unavailable/refused recovery, a complete empty result or complete mismatch.
Leaving or retrying cancels the native attempt first. Nothing claims the key is
saved before installation succeeds.

**I lost my key** opens **Lost your key?**, which first suggests checking another
signed-in device or a usable backup. Starting over replaces the linked key;
old messages and profiles are not deleted, but access does not carry over.
A warning says the old key can never be linked again: kgoose revokes an
unlinked key, and binding it later fails.
Owned community hostnames appear only when present; a failed lookup still shows
its error. **Go back** returns to the prior screen. **Start over with a new key**
creates a key, unlinks the old key, links the new one, then automatically backs it up.
The old key stays linked until the new one is on the device,
and binding never overwrites, so the unlink comes after creation and before
the link. The unlink checks the bound key first: it sends nothing more when
the account holds no key or the new one, fails when it holds a third key, and
deletes only while it is still the old one, so repeating it never removes the
new key's binding. It
counts as done only when kgoose confirms removing the old key, or the account
then holds no key or the new one. If the old key is still bound (kgoose removes
nothing when the sign-in is no longer active) or another key is, the step fails
without Try again.
Welcome back itself never offers Set me up.

Every lane ends the same way. A linked account runs **Finding communities**
(the same real read) once its key is on the device; the old key's list is not
read after starting over. A failed step shows **Couldn’t finish setup** with the
error — for a refused link, the hosted-communities card's copy (*This
Builderlab account is connected to another Buzz identity.*, *This Buzz identity
is connected to another Builderlab account.*) or first run's own for kgoose's
other refusals, such as an expired link request or too many attempts; for a
backup, why it did not complete; otherwise the step and HTTP status, as for the
account check. kgoose's own wording is never shown, nor its correlation ID,
which stays on the error and is logged in development builds. Once a key is on
the device, the page also says what is undone: *Your key is saved on this
device, but it isn’t linked to your account or backed up yet.* when
the unlink or link failed (a key that isn't linked can't be backed up),
otherwise *Your key is saved on this device.* **Try again** repeats the failed step and the rest of the
lane without creating another key. An expired backup session prompts sign-in
again and verifies the original account subject before uploading. Canceled or
wrong-account sign-in leaves setup and the key intact. When backup is explicitly unavailable in the build or not offered by the
account, **Continue without backup** skips only that backup step and runs the
remaining community setup. It retains the saved linked key and does not persist
a backup opt-out. Transient backup failures remain retry-only; linking cannot
be bypassed.
Before a key exists, the page also offers **Back** to the welcome screen.

Within one first-run session the Join page exits only through a join or a
restored community; there is no skip. That holds only while the app stays
open. Quitting with a key on the device but no saved community ends first run:
the next launch restores the key and, with setup idle, lifts the gate straight
into the in-app **Join a community** landing (`CommunityLanding`), the page a
key without a community has always opened on. The key stays on the device, and
the **Key backup** row in Settings → Identity shows the backup state. A link or
backup step still running at quit ends with the process: the native uploader's
pass is retired, and whether the link committed on kgoose is unknown to the
client. Both are safe to run again — the link reads the account's current key
first and does nothing when it already holds this one, and the uploader runs
again when the user next signs in to Builderlab in Settings — but nothing
re-runs the link on its own, and Settings has no row for it; the Key backup row
reports only what the uploader's last pass found. Below it, a **Backed-up key**
row shows the account's linked key when `nsec-backups/status` (read with the
bundled Builderlab session as first run reads it) lists it, marked This device
when it is, with when it was last active in a channel on the current
community's relay. Backups of other keys are left out and the row is
read-only: making another key the account's would unlink the current one, and
kgoose never links a key again once it is unlinked.

In Builderlab → Communities, a mismatched account offers **Switch to this
device’s identity** only behind a confirmation that the account's current key
will be permanently unlinked. There is no Unpair action.

Every lane ends with *Restoring your communities…* when the account check
listed destinations saved to the account (`src/features/identity/restore-communities.ts`):
each distinct destination this build can open (the list is deduplicated by
canonical origin, and an address the app cannot open is skipped) gets the
same signed profile read the Join Community page uses to prove admission, at
most three at once, and none started more than 45 s after the step began. A
destination that admits the key is saved to this device through
`communities.joined` under its hostname (its relay profile seeds the empty
local default); one that refuses the key, cannot be reached or will not save
is recorded and otherwise silent — nothing shows it in the app, and the
Builderlab plugin's sync adds it without an admission read after the next
Settings sign-in. The step never fails setup. Where setup rests then depends
on what was admitted:

- Nothing (the list was empty, unreadable, or every destination was refused or
  unreachable): the Join page below, as if the account had saved none.
- At least one, with no address given on the welcome screen: the first
  admitted is selected and the app opens on it.
- At least one, and the welcome-screen address is among them: that one is
  selected and the app opens on it; nothing else is asked.
- At least one, but the welcome-screen address is not among them (not saved,
  refused or unreachable): the first admitted is selected, the app opens on it,
  and the typed address — with its invite code, if it came from an invite link —
  is handed to the rail's **Add a community** dialog through the same invite
  intent a `buzz://join` link uses ([deep links](deep-links.md)), so the join
  completes inside the app: discovery, policy, code, profile. A saved
  destination that refused the key therefore never shows the first-run **This
  community needs an invite** page; the dialog's access step says to ask an
  administrator for a code, and the npub is in Settings → Identity. Closing
  the dialog leaves the restored community selected.

Entering the app this way (as after a first-run join) first runs the profile
step below when no profile exists anywhere, and clears the typed address from
the welcome screen's own state, so once the dialog owns it nothing on this
side can look it up again. The startup visit's 15-second deadline runs only
while the app is presenting it, so a first run of any length enters on the
channels page rather than a timed-out destination. Otherwise setup lands on
**Join Community** for the address given on the welcome screen, looked up again
(the policy may have changed meanwhile), or otherwise on **Join a community**,
laid out as the in-app Join a community landing: a centred heading, then, when
the account owns communities, rows under *Communities you own* — icon
placeholder, hostname and **Join** (named *Join {host}* for assistive
technology), which takes exactly the typed-URL path for that host — then a
**Community URL** field with **Continue** beside it. An empty or failed list
shows the page without rows. No invite list is shown; nothing serves pending
invites yet. In development,
[`BUZZ_DEV_FIRST_RUN_ACCOUNT`](configuration.md#first-run-account-seed-development)
answers the two account reads, and fakes the link, the unlink and the backup,
in place of kgoose and the native uploader.

The URL field is live. A typed address may omit its scheme (`relay.example.com`
is read as `wss://relay.example.com`); `wss://` and `https://` are accepted in
any case, while `ws://`/`http://`, credentials, paths, queries and fragments are
not (`enteredRelayOrigin` in `src/features/communities/destination.ts`).
**Continue** stays enabled while the field is empty or invalid; Continue or
Enter submits, and an empty or invalid address shows *Please enter a valid
community URL* under the field. Continue only starts the lookup; the join itself
is the Join Community page's **Join**. The field also takes an invite link: the
relay's `https://<host>/invite/<code>` page, or the `buzz://join?relay=…&code=…`
link that page opens (`parsePastedInvite` in
`src/features/communities/invite-link.ts`). The community is looked up at the
link's origin exactly as for a typed address, and nothing is sent with the code
until Join claims it; a link given on the welcome screen keeps its code through
sign-in and setup.

Join opens **Finding community** (`src/features/communities/FindCommunity.tsx`,
reusable by later flows): the hostname and **Cancel** at once, with a "Looking
up {host}…" status only after one second (the shared `LoadingRegion`, as for
any initial read; Retry starts the second again). **Cancel** returns to Join a
community with the typed address intact — however the user arrived there — and
discards any late answer. The page reads the relay's NIP-11
document and `/api/join-policy` in parallel through the identity-free native
`relay_http` GET path. Those two unauthenticated GETs are the only pre-join
traffic: nothing is signed with the device's key until the user chooses to join.
On success it shows **Join Community**: only what the relay publishes — the
icon if set and the hostname — plus, when the deployment has a join policy,
*I confirm that I am at least 18 years old.* (if age attestation is required) and
*I agree to this community’s Terms of Service and Privacy Notice.*, whose links
open the relay's `/api/join-policy/terms` and `/privacy` pages outside the app. No
name, description, member count, owner or invite badge is shown: none is knowable
before joining. **Join** sits to the right of **Cancel**, as in every dialog
footer, and is always labelled Join: shown consent boxes gate it, they do not
rename it. Lookup failures are classified, not echoed: an unreachable relay or an
unusable policy answer offers **Cancel** and **Retry** (a missing policy counts as
"none" only once NIP-11 confirmed a Buzz relay); a non-Buzz address or a Buzz
relay with no community bound to that host offers **Cancel** only.

**Join** is the same join the rail's Add-a-community dialog performs, through
the same owner (`admitCommunity` and `completeJoin` in
`src/features/communities/join.ts`, which save through `communities.joined` in
`src/features/communities/service.ts`; [communities](communities.md)). Before
anything is sent, the join is recorded on this device for the key (the join
journal, `join-journal.ts`), so a reply lost between the relay and the app —
a claim the relay honoured but the app never heard — is not claimed again: a
later Join for a recorded community first sends the signed profile read, and
only when that still denies the key does it claim. A device that cannot keep
the record stops there with the journal's storage message and sends nothing.
When the address came with an invite code, Join
claims it as the dialog does: if the deployment has a join policy, the
policy is accepted for that code with its version and the age box
(`/api/invites/accept-policy`), then the claim (`/api/invites/claim`) carries the
returned receipt; both are NIP-98-signed by the key, and the relay must answer
that the key joined or already was a member. Then, with or without a code, a
signed profile read (`inspectProfile`: NIP-11 again, then a NIP-98-signed
`POST /query` for the key's own kind 0) proves the relay admits this key. The
membership — the canonical origin as id, the hostname as name, the NIP-11
icon if set — is saved to this device and selected, and the gate lifts into the
app on that community; when **Set up your profile** follows (below), the
membership is saved after that step, as in the dialog, so nothing is joined
while it stands. After a Builderlab sign-in the destination is also saved
to the account straight away (`POST /api/goose/v1/buzz/known-communities/add`
with its `wss://host[:port]` address, same portal and credential as the account
reads), so the user's other devices restore it; the app waits for that answer,
but a failed save never stops it opening. A key imported from **Connect to
{host}** has no account, so nothing is saved there. Restored destinations are
not saved again, and joins in the in-app dialog reach the account through the
sync instead ([known communities](communities.md#known-communities)). While the
join is in flight the page shows *Joining…* with Join and Cancel disabled. The
join itself publishes nothing: no kind 0, and no policy receipt or invite claim
without a code. Without a code the ticked boxes are the client's record of
consent, as on the dialog's code-less path.

A relay that requires an invite answers the read with 401/403, shown as **This
community needs an invite**; a claim the relay refuses (an expired, used-up or
invalid code, or a policy that changed) lands on the same page with the dialog's
refusal copy under the code field, and no read is sent. The page offers an
**Invite code** field with **Join**, which runs the same policy acceptance (under
the consent the first Join gave), claim and read for the typed code; a refusal
shows under the field and keeps the page and the typed code, and a code the
native route will not send (anything but letters, digits, `.`, `_` and `-`)
reads as not valid. Admins also admit people by npub, so the page shows the
user's public key as the full npub (never hex or an abbreviation) under *Your
public key (npub)* with **Copy** and an inline copied/could-not-copy status,
plus the note that it is their public identity and safe to share. **Try again**
repeats the join without a code, so an admin's add takes effect without
retyping the address; **Back** returns to the find page (the typed address
stays in the URL field behind it). A relay that cannot be reached — for the
claim or the read — shows the lookup's unreachable copy; a device that will
not keep the join's record shows the journal's storage message. Both offer
**Back**. An existing relay profile seeds the empty local default.

When the admitted relay profile has no trimmed nonempty name, the gate stays up
for **Set up your profile** (`src/features/identity/ProfileStep.tsx`). The shared
fields show an optional avatar and required name, suggested from the Builderlab
email when there is no existing relay profile. The same prompt follows community
restoration when the selected relay profile has no name. A named relay profile
skips it. Restored memberships are already saved: this prompt is not a persistent
relaunch gate for those existing memberships. **Continue** uses the dialog's
profile completion (`completeJoin`): the draft is
recorded in the join journal, the profile is read afresh, the kind 0 is
published to that one relay through the same signed `relay_sign` +
`POST /events` route Settings → Profile uses when the draft differs from what
the relay holds, and it is read back; only a readback that is current saves the
membership (and the result as the device's local default for later joins) and
enters the app on the community. A rejected publish, or a readback the relay
has since superseded, stays on the step with the error inline and the draft
intact. **Go back** returns to community selection without completing the join.
A trimmed nonempty name is required; the avatar is optional. Settings → Profile
remains the editor. Denied/unavailable/corrupt storage is not first run: like the page
shown while the saved identity opens, it is titled **Your Buzz identity**, and
it keeps the **Retry secure storage access** path.

The key setup screen (`IdentitySetup`) is no longer shown on first launch; the
fixture below still renders it. It offers **Create a new identity** or **Use an
existing key**. These are alternatives. It can also offer **Continue with your
Buzz identity** when old Buzz is installed and **Restore from backup** in builds
with backup recovery configured; both are described below. Import accepts an
nsec, validates its checksum and secp256k1 scalar, and persists that exact key
before adopting its public identity. It never generates a replacement after an
import, read or write failure.

One native owner keeps the key in memory after successful restore. The new
create-only secure-storage item is service `xyz.block.buzz.desktop.identity` in release
builds, or `xyz.block.buzz.desktop.identity.debug` with Rust debug assertions,
account `human`. Debug worktrees share the debug item, not the release identity;
ports and frontend dev mode do not isolate it. macOS keeps its existing default
file Keychain/security-framework implementation. Windows uses Credential Manager;
Linux uses Secret Service through keyring 3.6.3, as old Buzz does. Linux requires
a running desktop Secret Service with a default collection (for example GNOME
Keyring), reachable on the user's session D-Bus. Missing, inaccessible or ambiguous
storage fails closed: unlock/configure the store and explicitly retry.

Human storage does not use or change agent credentials or old Buzz's
`buzz-desktop/secrets` blob. A competing item refuses overwrite. Windows/Linux
creates and agent deletes share a per-user, service/account file lock under the
OS account's home `.buzz-foundation/credential-locks`, independent of HOME/XDG,
profile and worktree overrides. Lock files are empty, retained, and never hold keys;
a busy lock reports a retryable error rather than waiting behind another process's
consent dialog. Locks serialize cooperating Buzz instances, not arbitrary other
programs or other machines. Windows credentials use keyring's enterprise persistence
and may roam under Windows policy; locks do not coordinate machines.
Neither Windows Credential Manager nor Secret Service supplies per-app access
isolation from other programs running as the same OS user.

There is no file/environment fallback, automatic legacy migration or human key
replacement. When installed old Buzz's data folder (`xyz.block.buzz.app`) exists,
the welcome screen opens a **Continue with your Buzz identity?** dialog over
itself. The landing's actions never wait for the folder check, and the dialog
waits while a sign-in is pending or another first-run page shows. Only its
**Continue** reads old Buzz's `buzz-desktop`/`secrets` item, so any OS access
prompt follows that click; the offer itself checks only the folder. It takes
the item's `identity` entry and saves it exactly as a pasted import would:
validated, create-only, never over a saved key, and never writing the old item.
A failed import shows its error in the dialog, where Continue tries again. Success enters the app with no Builderlab sign-in, link
or backup, where that key's old communities are offered
([Import from the previous desktop app](communities.md#import-from-the-previous-desktop-app)).
**Not now** or Escape leaves the welcome screen as it was, with focus on its
heading, and the dialog stays closed until the app next starts with no key. It
returns after Sign out while old Buzz's data remains. The human key is deleted
from this device only by [Sign out of Buzz](#sign-out-of-buzz); no other command
or plugin service can delete it. Agents' bring-over (`app_agent_port`) may read
only the selected old Buzz service/account and copy the selected agent key into
this app's separate agent namespace; it never writes the old blob.
No user key belongs in release configuration.

## Local restore helper on macOS

macOS builds with Rust debug assertions accept `BUZZ_DEV_CREDENTIAL_HELPER` as an
absolute executable path. When set, `read_human()` and native agent storage use
this helper.
The helper replaces both the normal read and the copy from the previous service.
Its setup must select the intended saved identity, including its service name.
Exit 10 declares that identity absent; it does not start a Keychain migration.
Release builds ignore it. With no setting, the normal Keychain read is unchanged.
Human import, creation, deletion, and session records keep their own owners.
Legacy agent import also keeps its exact-source read owner.

The helper receives a fresh Unix socket as stdout and no stdin. It must return
exactly 63 bytes of nsec text with no newline, then close stdout and exit zero.
The native identity owner still validates the nsec checksum and scalar. Exit 10
means absent, 11 means denied, and 12 means corrupt. Other failures stop restore.
Only absence permits identity creation. The app clears the returned buffer when
its owner releases it. It does not log helper output or stderr.

Normal reads have a five-second limit. For first approval only, set
`BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE=1`. This passes `--authorize` and allows
two minutes. Remove that setting after approval. A failed helper never triggers
a second credential read.

The helper is trusted local code. Keep its setup and signing keys outside this
repository. It must read only the exact debug human item in the default Keychain
and disable Keychain dialogs during normal reads. Before it sends a key, it must
verify the socket peer's audit token, parent PID, and live code signature against
the configured app identifier and certificate. A PID check alone is insufficient.
Reject pipes and sockets created before exec. Sign both processes with hardened
runtime and without entitlements that allow code injection. These access controls
need native tests; the app hook does not supply them.

For native agents, the app passes `--agent-store <operation> <service> <account>`
after the optional `--authorize`. Operations are `read`, `replace`, and `delete`.
The service is `xyz.block.buzz.desktop.agents` or
`dev.local.buzz.foundation.agents`. The account is `agent-bundle-v1` or the exact
`agent:<credential-id>` selected by the bundle owner. The helper must reject
other services, accounts, and operations. A helper that supports only human
restore must reject agent requests. It must never return a human key for them.

The fresh stdout socket carries data in both directions. Stdin stays closed.
For `replace`, the app sends the bundle bytes, then closes its write side.
The helper must authenticate the peer before it reads these bytes. It reads to
EOF before it sends a response. For `read`, it returns the exact item bytes.
Successful writes and deletes return no bytes. Each direction has a 2 MiB limit.
The app uses the same deadline and exit codes as human restore. Exit 13 means
occupied. A helper failure stops the operation without a direct Keychain retry.

The helper must use the default Keychain and the same peer checks as human
restore. It must preserve item access controls on replacement and confirm a
deleted item is absent. Normal operations must disable Keychain dialogs.
The app retains bundle validation, create-only agent writes, migration order,
locks, cache epochs, and read-back checks. The helper does not store keys in
files or change their access controls to avoid approval. Configure its signed
binary outside this repository. Do not copy existing keys into its setup.

Before a real test, wait for green CI. Obtain explicit consent for first approval.
Then use a disposable agent to check creation, restore after restart, and deletion.
Check denied access and an invalid helper path too. Confirm no normal operation
shows a Keychain dialog. These native checks and a human check are required;
synthetic helper tests do not prove signature or Keychain enforcement.

The certificate check trusts access to its signing key. Another program that can
use that key and app identifier can satisfy the same requirement. Approval to use
the signing key across rebuilds therefore extends trust to those programs.

## Automatic backup and optional recovery

Desktop builds configured with `BUZZ_NSEC_BACKUP_SERVICE_URL` and
`BUZZ_NSEC_BACKUP_NAMESPACE` back up a local identity only after an explicit saved
automatic-backup choice, Builderlab login, and matching key
binding. Unset, self-managed, corrupt or mismatched consent prevents all backup
requests, including retries. An organization-managed build also sets
`BUZZ_NSEC_BACKUP_CONSENT=managed`: backup then needs no saved choice and
ignores one, so every local key is backed up, including one created before
backup was configured. The service and namespace are paired
native build-process inputs; unset or empty leaves the feature disabled. Preview
releases that sign in to `app.builderlab.xyz` set them to that origin's
`/api/goose` service and the `backup/bb-public/production` namespace. The service URL
includes its API prefix and must use HTTPS. Existing login credentials are accepted
only for the matching trusted build origin. Without a qualifying login, backup
defers without opening a browser or delaying identity readiness.

The native host validates enrollment and seals with the reviewed HPKE v1 protocol.
Only encrypted pending bytes and public completion metadata are saved in the OS
account's `.buzz-foundation/nsec-backups/<human credential service>` folder, scoped
separately for debug and release. A shared lock serializes cooperating
copies. Pending bytes and IDs survive restart; later login/binding/key-install
events retry them, including a coalesced follow-up when an event arrives during an
active pass. Upload success requires a matching stored receipt. Backup
failure never replaces or deletes the local identity.

The main WebView can observe the uploader through `identity.backup`, which
registers on first read and stays out of identity snapshots. Its status says
whether Builderlab backup can run in this build and whether the latest pass is
idle, running, complete, waiting for consent, a session or a key binding, or
failed with a named kind; no service response body reaches the renderer. A login
handoff or retry resolves to the number of the pass it starts, or to none, so a
caller can wait for that pass's own outcome. A pass superseded by a key install
reports nothing; reloading the window mid-pass reports idle.

First run's **Backing up your key** is a pass of this uploader. It saves the
automatic choice for the key, hands the first-run Builderlab sign-in to the
uploader, waits up to 60 seconds for the pass that handoff starts, and then
hands the sign-in back, whatever the outcome; an earlier pass's result never
answers it. In an FI build the sign-in is the session the Builderlab plugin
also hands the uploader, so after a completed backup it stays with the
uploader, which runs one more pass; after a failure the uploader has no session
until the plugin hands it over again, when that session changes or the app
restarts. A pass that stops to wait for consent, a session or a key binding
fails the step, since nothing would wake it again before first run ends. The
failed page names the reason without any service response. The automatic choice
stays on after a failure, so a later
Builderlab sign-in may still finish the backup the user asked for. The step
hands a sign-in over only when this build's uploader can back up to Builderlab.
Anywhere else (a build without backup configured) the step fails at once as
*Key backup isn’t configured for this build. You can continue without a backup.* without saving
the choice. First-run failures offer retry and preserve the saved key.

When secure storage confirms absence, native recovery commands support explicit
browser sign-in. The session and recovered keys remain native; the renderer sees
only validated public identities and attempt-scoped handles. Recovery prefers the
account's current associated identity. A previous identity requires explicit
selection and does not change the account association. Failed mapping requests,
unavailable endpoints, an account refused recovery (outside a private
organization, or without Buzz access), failed backups and an empty successful
result remain distinct.
Installation uses the existing create-only secure store; cancel, reload, signout
or a competing create/import prevents stale installation.
Remembering recovered completion is best effort; retry-file failure does not block
secure-store installation. Pending uploads still require durable ciphertext before sending.
Plain signout retains backup records; Sign out and erase removes this credential
service's records through the existing resumable wipe before clearing its marker.

Rollout requires the backend backup/recovery endpoints, private-organization
authorization, database migration, and configured KMS recipient/permissions. The
client inputs must match that service's namespace. Synthetic HTTP/storage tests
do not establish live sign-in, KMS or installed-app
secure-storage acceptance. No backend provisioning or activation is part of this change.

Identity setup offers Restore when secure storage confirms that no local key is present.
The existing restore UI presents the current identity and explicit previous-identity
selection. Restoring a key does not enable automatic backup or change its saved
consent; no consent selection UI is added in this stack.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details are separate under **Buzz → Identity**, so they remain available
if the community profile cannot load. The full npub and hex public key can be
copied. The nsec is absent from the rendered field until Reveal; Copy can fetch it without revealing it. Hide, leaving Identity,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that. The one exception is the
first-run **Enter your private key** page: the typed, pasted or file-read nsec
lives only in that page's state, masked until **Reveal private key**, and
crosses IPC once, on **Continue with this key**, through `identity_import`; leaving the page
discards it, and nothing logs or persists it. On the returning-user lane the
page compares the typed key's derived npub with the account's linked npub in
the page, before IPC, so a mismatched nsec never reaches native import. The
**Welcome back** page shows the linked public key and the signed-in email; the first-run
Builderlab session credential is held by the OAuth session store and sent only
in the two account reads' `X-BB-Session-Credential` header, never rendered.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Sign out of Buzz

Settings → Buzz → Identity → **Sign out of Buzz** removes the private key from this
device only; the npub and its history stay on relays. The dialog presents two
layers: the key always goes, and settings, agents and other Buzz data stay unless
the user erases them. It embeds the private-key controls above. Confirm stays
disabled until the user reveals or copies the key and ticks "I have my key".
**Also erase everything else Buzz stores on this device** (internally, wipe)
requires typing `erase all my data`; **Also remove my agents** appears only with
it; the button then reads **Sign out and erase**. Wipe clears
this app's data, local data, WebView storage, caches and plugin storage. It cannot
reach the clipboard, exported keys or relay data, and the dialog says so. Sign out
is unavailable with the development broker (`BUZZ_DEV_VIEWER`). Development
builds can sign out but not wipe: they have their own human key, but share agent
keys with the installed app, so the native command refuses
wipe. The dialog asks the native side (`sign_out_wipe_refusal`) whether wipe is
available and, when it isn't, disables wipe up front with the reason; this holds
for any Rust debug build, including a debug bundle with a production frontend. A development-build sign-out signs out every
development build, which share the debug key, and leaves the installed app
signed in. Wipe is unavailable while
`BUZZODZ_HOME` moves plugin storage out of app data.

Every running instance, debug or release under any identifier, holds two locks
shared in the user data folder (created first if a first launch finds none)
before it looks for a pending sign-out:

- a **key lock** named for its human key store (`.<service>.instance.lock`), shared
  by every copy using that key whatever its identifier. Like the sign-out marker,
  record and backup folder, it keeps the store's service from before 1.0
  (`dev.local.buzz.foundation.identity`), so files older builds wrote are still
  found; and
- the **all-Buzz lock** (`.dev.local.buzz.foundation.instance.lock`), named for
  the storage all builds share (the default plugin folder and the agent key
  service), not for the app identifier. It keeps the identifier Buzz used before
  1.0, so those builds and later ones exclude each other.

Before 1.0, Buzz's identifier was `dev.local.buzz.foundation`. Before taking these
locks, a launch as `xyz.block.buzz.desktop` renames what the old identifier names:
app data (with plugin storage), config, local data, caches, macOS WebKit storage,
their sign-out trash and a pending sign-out marker, so the update keeps
everything and finishes a sign-out the old build committed. It takes the all-Buzz
lock alone and waits for every agent ownership lock, so it never moves storage
another copy or a stopping agent still uses. If any legacy path sits beside its
new-identifier counterpart, after a rollback for instance, the launch moves
nothing, finishes no pending sign-out, and exits naming every such pair; neither copy
is safely the one to keep, and an erase would miss the legacy one. A failure exits
with a native alert, and the next launch moves what is left. Development launches
(`just desktop`, `just desktop-bundle`) use `xyz.block.buzz.desktop.dev`, so they
keep their own app data and plugin storage and never take or block the installed
app's. The first one copies the installed app's app data (without the release-only
`archive`), config, local data and macOS WebKit storage, each from
`xyz.block.buzz.desktop`, else `dev.local.buzz.foundation`, under the same locks,
so the installed app must be closed once, and takes a pending development
sign-out marker. It refuses while the installed app has a sign-out pending, so it
never copies storage being erased. A linked folder copies what it links to; links
inside are left out, so the copy shares nothing with the installed app's storage,
which stays in place. Copied folders keep who else may read them, but stay
writable by their owner. An interrupted copy finishes at the next launch.

Keys were saved under `dev.local.buzz.foundation.*` services before 1.0; they
now live under `xyz.block.buzz.desktop.*`: the human key (`.identity[.debug]`),
the agent keys (`.agents`, shared by release and development) and the TypeSafe
key (`.jev-key[.debug]`). A read looks under the new name first. Only when the
key is absent there does it look under the old name and copy what it finds,
create-only, then return the key saved under the new name. The copy holds the
old item's interprocess lock, which deleting the old item takes too, so a delete
in another Buzz can't land between its read and write. A key already there
stays, even if it differs. On macOS an agent key is looked for in the new
bundle, then its own new item, then the old bundle, then its own old item, all
under the bundle lock older builds take too. The old items stay, so an older
build still finds them. Any failure is an error for that key only, never
absence. Writes touch only the new names. Every deletion (Sign out, deleting
an agent, an erase, clearing the TypeSafe key) removes the old item before the
new one, and on macOS the agent's entry from the old bundle, so a read never
copies back a deleted key. On macOS each deletion reads again to confirm the
item is gone. Deleting an agent fails, keeping every copy, while the old bundle
is malformed.

Older builds sign out by deleting the human key under the old name only. A
record in the user data folder (`.<service>.sign-outs-seen`, next to the
finished record) keeps the count of finished sign-outs the last launch saw.
After any pending sign-out finishes, a launch that finds the count grew deletes
the human key under the new name too; the first launch only starts the count.
It decides holding the record's lock file alone, so a copy launching at the
same time sees the count this one recorded and never deletes a key saved since.
If the deletion fails, it records nothing and exits. The count is replaced by
a synced rename, and on macOS and Linux every launch syncs its folder before
any key is saved, so a power loss can't bring back a lower count and delete a
newer key. Windows has no folder sync, as for the app's other atomic writes: a
power loss right after a launch recorded a new count can lose the rename, and
the next launch then deletes a key saved in that window. Older builds record a
finished sign-out with an unsynced append on every OS, so a power loss then can
keep the deletion but lose the count, and the signed-out key under the new name
stays. Older builds' other
deletions aren't counted: after an older build erases agents or clears the
TypeSafe key, their copies under the new names stay. On macOS, Keychain may ask once to
allow the renamed app to use each saved item.

A sign-out needs its key lock alone, so every other copy using that key must be
closed. A wipe also needs the all-Buzz lock alone, so every other Buzz must be
closed. A development-build sign-out therefore needs only other development
worktrees closed, not the installed app, and the installed app's plain sign-out
doesn't need development builds closed. Locks are taken key first, then
all-Buzz, released in reverse, and never waited for while one is held alone.
Whenever an instance takes its locks shared again (after finishing a pending
sign-out, or after a refused sign-out), it looks for the marker again: at launch
a new marker is finished in turn; in a running instance it means another process
committed a sign-out, and Buzz exits natively (see below). A running instance
also exits if the sign-out record (`.<service>.sign-outs-finished`, kept forever
and shared by every identifier using the key) changed since launch: another
process finished a sign-out of its key while it let go. Retaking them
shared is bounded too; on timeout, or if a lock can't be let go, Buzz exits the
same way. These locks
coordinate running Buzz 1.0 app copies only: `buzzodz plugin sign` reads the
human key without them, under the new name else the old, and never copies it,
so Keychain items stay the app's; older Buzz versions don't take them, so close those
before signing out. The native
`sign_out` command deletes nothing: it admits one sign-out per instance, refuses
unless it can hold the locks it needs alone, writes a marker beside (not inside)
app data recording the wipe and agent choices, and restarts; agent processes
stop as they do on Quit. The marker is named for the exact human key store
(debug or release), so another build never acts on it. If the marker can't be
written nothing has changed; if a later step fails, Buzz exits natively, and the
next launch finishes the sign-out.

Once the marker is written, and before any native exit, the native signer is
closed for the rest of the process: the cached key is dropped, and every key
operation (signing, agent authorization, export, restore, import or create)
refuses when it runs, including calls that started before it closed. Pairing
closes in the same close step: the live attempt is cancelled before it can publish a
payload it already prepared, and no new attempt starts. Work admitted before
the close isn't recalled: a payload admitted before pairing closes may still be
sent or delivered (an outcome not yet known is reported as uncertain), and signatures and agent authorizations
already issued remain valid. A native exit runs the same best-effort teardown as Quit, then shows a native
alert and exits however that went; the dialog never offers a retry or Cancel
once this instance's locks or agents are in an unknown state. Agents don't
outlive Buzz: each runs under a supervisor that stops it when Buzz's socket
closes, holding that agent's ownership lock (`dev.local.buzz.agent-ownership`
in the user data folder) until it has stopped. A supervisor that can't stop its
agent keeps the lock.

A launch that finds the marker takes its key lock alone, and for a wipe the
all-Buzz lock too, waiting briefly for the exiting instance, then reads the
marker once more and runs only choices those locks cover: if it has meanwhile
become a wipe, the launch lets go and starts over to take every lock. Before a
wipe, it tries every agent ownership lock; if any is still held, it removes
nothing and exits with a native alert that an agent is still stopping, so a
later launch retries. A plain sign-out skips this: it removes only the human
key, and the ownership folder is shared with every Buzz, so another copy's
running agents would block it. A marker
that can't be read or parsed fails closed. It finishes before any window,
webview storage, service or identity read:

1. With remove agents, every agent's locally stored key is deleted, read from
   the agent registry, which stays in place until all are gone. That includes
   imported deployed-remote agents, whose import kept a local copy; the remote
   deployment itself is not stopped or deleted.
2. With wipe, app data, local data, WebView storage and caches are renamed
   aside. App data's agent folder (`agent-controller`) is put back unless agents
   were removed.
3. The human item is deleted and a fresh read must find it absent.
4. The renamed folders and anything recreated in place are deleted, then the
   sign-out record advances, then the marker is removed. Kept agents keep only
   what they need to be identified and start again: the agent list with their
   settings (`agents.json`), the shared agent defaults (`defaults.json`),
   including any API keys entered in their settings, and their keys in the
   keychain. Everything else in `agent-controller`, including saved Databricks
   logins, logs and anything added there later, is deleted; a kept Databricks
   agent must sign in again. The dialog says both.

Every step is safe to repeat: deleting an absent key succeeds, and an agent
registry confirmed absent means its keys are already gone; failing to check it
stops before anything moves. The wipe never acts through a link at Buzz's own
folders: every wiped folder, its `.sign-out-trash` sibling, the kept
`agent-controller` in both, and the agent list when agents are removed must be a
real folder or absent. This is checked before the marker is written, before
anything moves, and again right before every move, rollback and delete. The OS
storage folders above them (`Application Support`, `Caches`, `~/Library/WebKit`)
are trusted as the app already trusts them, so if one is a link the wipe removes
only Buzz's folder under it. The wipe is not designed to resist another program
swapping folders while it runs. Every other presence check in the wipe is fallible
too: one that can't look fails the attempt, keeping the marker. If renaming or the key delete fails, the renames are rolled back. On any failure
the marker is kept and Buzz shows a native error and exits without opening a
window, so nothing recreates wiped storage and the next launch retries. Without
wipe, local data stays: it is already scoped by public key, so signing back in
with the same key finds it. Native federated sessions are removed by the same
sign-out owner across indexed profiles and configurations. Without FI, Builderlab and
hosted-community logins live only in memory and end with the restart; an FI build signs
them in through the native FI session instead, which restores after it. Kept agents start only while the signed-in key
matches the owner in their saved attestation, checked before their key is read.

## Automatic backup consent hooks

The native identity service exposes `getBackupChoice()` and
`setBackupChoice(pubkey, automatic)`. These APIs expose public metadata and do not
change identity readiness. Reading a choice does not contact a server; saving
automatic backup wakes the existing native uploader if a session is connected.
Builderlab first run discloses automatic backup before replacing or importing a
key, says the account manages a key it creates, then enables backup after
linking. There is no separate backup-choice screen or failure bypass.
Independent imports without Builderlab sign-in do not enable backup. Settings
retains control over future automatic uploads.

The choice is bound to the current public key and trusted build-configured backup
service and namespace. Missing or mismatched metadata returns no choice;
unreadable metadata fails closed. An unavailable build rejects choice writes.
Debug and release use their existing separate key-custody namespaces. Only the
main WebView can read or save the choice.
Plain sign-out retains the choice; sign-out and erase removes it through the
existing resumable wipe, without erasing the other key-custody namespace.

The native uploader consumes `nsec_backup_choice::read` before any
backup request and retain its returned value through the upload. Its shared file
lease prevents a successful choice change from racing an admitted upload across
app copies. Saving a choice reports busy while such a lease is held. Disabling
automatic backup governs future uploads and does not delete existing backups.
The consent hooks are the base of the draft stack:
#1137 consent hooks → #1106 gated uploader → #1107 recovery → #1101 restore UI.

## Native federated session module

Federated identity ([NIP-FI](https://github.com/block/buzz/blob/main/docs/nips/NIP-FI.md),
[NIP-FA](https://github.com/block/buzz/blob/main/docs/nips/NIP-FA.md)) adds a native
owner separate from the human Nostr key. Its deployment descriptor is documented
in [configuration](configuration.md#federated-identity-build-input).
The native commands return status, authority, revision, optional email, and fixed
failure codes. Session tokens and assertion headers are native-only.

Sign-in uses the existing native loopback callback owner with NIP-FA `return_to`
and an S256 handoff challenge, exchanges the code natively, and verifies the
fixed session expiry before persistence. Restore checks the stored credential
against `/v1/session`; failed reads and unrecognized refusals do not authorize
replacement. Local expiry, cancellation, and sign-out fence stale work.

FI records use the OS secure-store service
`xyz.block.buzz.desktop.federated-session` (with `.debug` for Rust debug
builds), keyed by profile and deployment fingerprint. On macOS one item per
profile and deployment holds the session and every agent grant, so Keychain
prompts once; Windows and Linux keep one item per record. Older macOS items
move into it on read. This is a one-way development migration: close older
Buzz copies, including other debug worktrees, before the first upgraded launch
and use the upgraded build afterward. An older copy still running can write a
grant the bundle no longer reads, which leaves that agent stopped. Release builds already run one instance. Account indices and
revision-specific refusal markers contain no credential and live outside wiped
Buzz data. Failed removal of a known record leaves refusal durable before any
secure-store access, so that revision cannot restore until cleanup succeeds.
Sign out of Buzz removes indexed FI records across profiles/configurations in
its debug/release namespace before deleting the human key or opening a WebView.

The app's `federatedIdentity` service exposes this public state to the shared
sign-in UI. Session record revision survives restore and scopes account caches
without inventing a NIP-FA subject.

NIP-11 discovery from the exact relay carries no FI credential. Valid absent or
false FI flags retain ordinary Nostr transport. A true flag requires the supported
client-attached/offline-jwt descriptor and compiled authority mapping. Assertions
are acquired with native same-key NIP-98 proof and checked for exact audience,
key, and lifetime. Native HTTP, media, repository Git reads/imports, and socket
upgrades attach the assertion beside their existing possession proof. Protected
socket workers stop by assertion expiry; the existing live owner reconnects and
performs fresh NIP-42. Retirement fences protected reads and results.

### Local agent federated credentials

Each local agent enrolls using the signed-in owner's session and its own NIP-98
proof. The native agent-token owner stores the resulting grant beside session
records in the same OS secure-store service, keyed by profile, deployment, owner
public key and agent public key: in the session's item on macOS, under a
separate key elsewhere. Grants never cross IPC, and assertion headers cross it
only as the `repo` tool's Git headers. There the NIP-98 proof is bound to one
repository URL for 60 seconds, while the assertion is scoped to the relay for
the lifetime its issuer set and bound to the agent's key, so it is unusable
without that key (NIP-FI, Assertion–key binding). Git asks for an assertion
valid for at least 70 seconds and fails rather than accept a shorter one.
Enrollment validates the returned owner and issuer;
assertions are checked for the agent key, issuer, relay audience and lifetime.
The relay remains responsible for signature and authorization verification.

An enrolled grant survives ordinary owner-session expiry and same-account
restoration. Organization sign-out, another account or agent deletion retires it.
Account installation records required retirement before persisting the new session;
interrupted cleanup resumes before grants are admitted. Enrollment also rechecks
its session revision, so a caller paused before reservation cannot install a
credential from a retired session.

A refused grant permits one replacement enrollment while the owner is signed in.
Replacement attempts preserve that budget across transient errors. Before enrollment
or replacement issuance, the same secure-store record reserves a token-free stop
scoped to the persisted session revision. Terminal refusal, restart or interrupted
issuance cannot silently start another enrollment. A new sign-in revision or
explicit agent deletion permits a reset; ordinary restore of the same session does
not. Failure to persist the reservation prevents dispatch. A known transient
outcome releases it only if that storage write succeeds.

The `/v1/nip-fi/agent-grant` and `/v1/nip-fi/agent-assertion` routes and
`Nostr-Agent-Proof` header are this configured adapter's wire contract, not
standard endpoints defined by NIP-FI/NIP-FA. NIP-FI defines the
`nip-fi-agent+jwt` assertion class and owner checks; that does not establish
interoperability with another adapter's enrollment endpoints.

In an FI build, Builderlab's remote-agent, hosted-community, known-community,
Apps viewer and backup calls go through the native FI session. The renderer
names only the public session revision. For API calls, native checks the
plugin's authority/operation grant, enabled artifact revision, live
registration and that revision; the Apps viewer exchange and backup check only
that the revision is current. Each sends the adapter session as
`Authorization: Bearer` to the identity origin only. A 401 fails that call
without ending the session; native then checks the adapter's `GET /v1/session`
once and ends the session only if the adapter refuses it there. Builderlab's
Settings card has no sign-out of its own in an FI build: it links to Identity →
Organization sign-in, which ends the shared session. Builderlab
Apps' agent tools still need the legacy login and are absent in FI builds.

### Sign in at launch

A build whose descriptor sets `"signIn": "at-launch"` treats organization
sign-in as part of opening the app. After key setup, the launch mark stays up
while the saved session is checked. A restored session opens the app directly.
Otherwise a full-window screen titled "Signing you in to *organization*" opens
the browser sign-in, and the app opens when it finishes. Cancel or a failed
sign-in leaves **Sign in with *organization*** and **Not now**; neither reopens
the browser by itself. Not now opens the app, where protected communities offer
their usual sign-in recovery.

When the session ends during a run (expiry or the adapter refusing it), the same
screen covers the app, above any dialog or menu it had open, and starts sign-in
again. The app stays mounted, covered and inert, so drafts, scroll and
navigation survive, and focus returns to where it was. An explicit sign-out
shows the screen without opening the browser. A saved session that cannot be
checked (network or secure storage) offers Try again, and the screen stays up
while it checks.

Before the session expires, a persistent warning names when it ends and offers
**Sign in again**. It appears 72 hours ahead, or halfway through a shorter
session. Signing in again keeps the current session working until the new one
is exchanged; Cancel or a failure leaves it in place, and a different account
retires derived agent grants as any account change does. At expiry, native ends
the session itself rather than waiting for the next relay assertion or 401, and
the screen above takes over.
On-demand builds are unchanged.

The Node development host retains its supported broker flow.

For the community sign-in and recovery UI alone, run the environment-free
fixture server documented below and open `/tests/fixtures/federated-identity.html`.
Click **Sign in**, then **Cancel sign-in** or **Complete** in fixture controls;
verify the prompt switches to **Cancel sign-in** and clears once signed in.
**Binding mismatch** shows existing identity-link guidance; **Storage failure**
shows recovery without claiming success. It does not exercise the running app's
full navigation or native credentials.

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, Windows and Linux, app composition supplies the shared
native relay adapter after identity restoration. Windows/Linux installed-app
transport acceptance remains unverified. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, a body hash on POST and a fresh nonce
for each attempt. Native networking permits only discovery, join-policy, invite
mint/acceptance/claim, relay-advertised GIF search, query, event and bounded
workflow run-history routes on HTTPS origins, with bounded bodies, timeouts and
no redirects. JavaScript never obtains the private key for transport. NIP-11
`self` establishes relay authority; the operator-contact `pubkey` is not a
substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Relay staff console requests (`relay_admin_*`) use a separate native owner.
The admin origin comes only from the selected relay's NIP-11 `admin_api` and
must be a public HTTPS host. Every probe, read, write, attachment fetch and
retry resolves that host, refuses the request if any answer is loopback,
private, link-local or otherwise reserved (or if DNS fails or returns nothing),
and connects only to the vetted addresses while keeping the hostname for TLS
and NIP-98. That client ignores system proxies and follows no redirects. The
webview names a closed route; native code builds the URL, checks the request's
expected relay, admin origin and signer before signing, and caps each response.

When there is a selected identity and relay and the relay advertises a valid
admin host, opening Settings sends one signed role check (`probe`, `GET
/api/admin/v1/probe`, empty body) to that host without a further click, so the
Moderation entries show only to staff (a relay with admin auth off shows its
read-only entries to everyone). Every member who opens Settings sends it, not
only staff, because only the answer says who is staff. It goes to whatever
admin host the relay advertises, which can differ from the community's
connection host and need not share its domain. That host learns the active
public key, the client's IP address and that Settings was opened; no private
key, login token or community data is sent. The NIP-98 signature is bound to
that URL, method and body and carries a timestamp, so it can't be used for any
other request, and a conforming server rejects it after a short window (this
relay allows ±60 seconds); the recipient can still keep it. A relay that names
another deployment's real admin host lets that deployment's staff see and act
on that deployment from inside the wrong relay's Settings, subject to that
deployment's permissions; the relay that named it receives none of that
traffic. The practical risk is confusion about which deployment is being
administered, and each console screen names the admin host in its subtitle,
which limits it. This is accepted because the user already trusts the relay to
name its admin host, and sending that host the key, the IP address and when
Settings was opened is part of that trust. It repeats each time Settings
opens, re-reading the advertised admin host first, and each newly selected
identity or relay is checked once while Settings stays open. Other re-checks
(a 401 or 403, Check again, changing your own staff entry) are listed in
[relay-staff.md](relay-staff.md); none starts after Settings closes.

Channel lifecycle/details and identity archive commands, channel recipe preparation/decoding,
and opening direct messages use purpose-bound native commands. Creation kind 9007 is
advertised only when NIP-11 reports NIP-29 support. NIP-44 stays in the native
identity owner; recipe plaintext is never returned by a generic decrypt command.

Community admission, kind-0 profile reads/publication, the NIP-43 leave request
(kind 28936, signed only in its empty protected shape) and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. For ordinary messages, missing/failed
readback retains uncertainty; inspect the conversation before explicitly sending
another. Expired no-role Solo invitations have a narrower verified retirement
path through [Outbox Retry](solo/sharing.md).

Protected media and uploads are native, because the webview cannot attach Blossom
(kind 24242) authentication itself: `<img>`, `<video>` and `<audio>` send no custom
headers, and the CSP keeps `connect-src` closed to general HTTPS; it admits only
the `buzz-media` scheme, whose bytes the requesting window may already read (such
as an agent card's embedded definition). Relay `/media/`
URLs selected by shared TypeScript render through the `buzz-media` URI scheme;
`<video>` and `<audio>` instead load the same URLs from a native listener on
`127.0.0.1`, since WebKitGTK cannot play a custom scheme. It authorizes each
request by a random per-launch path token given only to the main window, the
bound `Host` and the app's `Origin`, and serves one request per connection.
Both validate HTTPS and the `/media/<hash>` URL shape but do not enforce
saved-community membership; the selected server receives a short-lived token
scoped to its origin. The scheme signs a fresh 60-second `get` token per request
and forwards only a bounded single `Range`; non-image/video/audio types (and SVG)
are served with download disposition and `nosniff`. The main webview does not navigate to protected media for downloads: a narrowly scoped native command authenticates the bounded media GET, saves to the OS Downloads directory without replacing existing files, and rejects unsafe filenames. On macOS, the main webview's native media menu also saves relay media to Downloads without replacing existing files, but under the blob's `<hash>.<ext>` name rather than the attachment name, and removes the partial file if a download fails or Buzz quits before it finishes. It refuses media of unknown length or larger than the largest video Buzz uploads. The menu omits the items that would copy, open or share the tokened loopback URL, and its Download item when Buzz cannot save it. `relay_upload`
hashes, signs (`upload` + `x`) and sends the exact bytes JavaScript passes it,
then requires the successful response's SHA-256 and size to match those bytes.
Shared TypeScript (`hostUpload`) owns limits, error mapping and the remaining
descriptor validation. JavaScript never signs kind 24242. Packaged HEIC and video
preparation uses fixed demuxers and ffmpeg arguments in the native host, then
hashes and uploads only the converted bytes; JavaScript receives the descriptor,
not the prepared file. ffmpeg must be installed on the computer.
Community member changes (NIP-43 kinds 9030–9032) are signed in the host only
in the exact add/remove/role shape; the relay decides authority. Repository HTTP
and other broker-only helpers are not claimed by this adapter.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

Development with a public `BUZZ_DEV_VIEWER` pin enables the legacy broker
(Vite derives `VITE_BUZZ_LIVE=1`), even inside `just desktop`, and does not offer
native private-key controls. `just desktop` passes Vite's effective public pin
(including an explicitly empty shell override) to the native app. The public pin
alone is not authorization. Packaged builds always use native identity, ignoring
the pin. This reuses the broker's trusted-local-process boundary; it does not copy
keys or introduce another signing protocol.

Without the pin, supported desktop development uses
the native identity path; see the [host-mode matrix](contributing.md#shared-logic-and-host-boundaries). Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope. Sign out
does not touch that old blob.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It renders the key import/create screen
(not the first-launch welcome) with mock IPC and an in-memory public
fixture key, not an OS credential store or a relay. Import accepts only the
displayed fixture key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.

### Windows/Linux native acceptance (not established by the fixture)

Use a disposable **OS account/VM**, not a profile, port or HOME override: credentials
are per OS user. Use only throwaway keys, keep old Buzz closed for import handover,
and do not connect that identity to a real community for this storage check.

- On Windows and Linux with a working Secret Service/default collection, create
  or import, export the throwaway key, quit/relaunch, and confirm the same public
  identity and export. Repeat separately for debug and release builds.
- With an existing Linux key locked, dismiss the unlock request. Expect a storage
  error/retry, not first-run create/import choices; unlock and retry to restore.
  Without Secret Service, expect an error rather than key generation/fallback.
- Where two development instances can run, an occupied human/agent item must not
  be overwritten. Lock contention must be retryable; after exit, locks release.

Deferred until agent import is reachable from the UI on Windows/Linux:
explicitly import a throwaway old-Buzz agent, restart and verify the exact key,
then delete only the destination agent and verify the old source remains. This is
not a reachable UI acceptance step for this storage slice and does not establish
Windows execution.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
