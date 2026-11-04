import { invoke } from "@tauri-apps/api/core";
import { listedAddress } from "../../bundled/builderlab/known-communities/client";
import {
  type Credential,
  oauthTarget,
} from "../../bundled/builderlab/oauth/browser";
import {
  ApiFailure,
  boundKey,
  check,
  quota,
  relayUrl,
  type Reply,
} from "../../bundled/builderlab/communities/api";
import { enteredRelayOrigin, relayAddress } from "../communities/destination";
import type { FederatedIdentity } from "../federated-identity/service";
import type { Host, HostResponse } from "../host/service";
import { BackupError, backUpWith } from "./backup";
import type { BackupFailureKind } from "./backup-failure";
import type { FirstRunAccountSeed } from "./first-run-seed";
import {
  type Identity,
  RECOVERY_UNAVAILABLE,
  type RecoveryState,
} from "./service";

/** A community the signed-in account owns: its hostname and the canonical origin a join uses. */
export type OwnedCommunity = Readonly<{ host: string; url: string }>;

/**
 * The account's community list. `canCreate` is the Builderlab communities
 * section's verdict before it enables Create a community, short of which key
 * is bound: the account is linked (no missing-mapping refusal), and the list's
 * quota (`api.ts` `quota`) does not refuse. A list with no readable quota does
 * not refuse, as there; kgoose still enforces its limit on create, and
 * `quotaLimit`, when readable, words that refusal.
 */
export type CommunityList = Readonly<{
  owned: readonly OwnedCommunity[];
  canCreate: boolean;
  quotaLimit?: number | undefined;
}>;

/**
 * The identity's native recovery, with the state it publishes while a restore
 * is under way (`undefined` otherwise).
 */
export type Recovery = Pick<
  Identity,
  "subscribe" | "beginRecovery" | "installRecovery" | "cancelRecovery"
> &
  Readonly<{ snapshot(): RecoveryState | undefined }>;

/**
 * What first run reads about the signed-in Builderlab account, the binding
 * that makes this device's key the account's (and the unlink that releases a
 * lost one), and that key's backup.
 */
export type FirstRunAccount = Readonly<{
  /** The hex key bound 1:1 to the account, or null when none is (a reply with no `identity`). */
  linkedKey(): Promise<string | null>;
  /**
   * The account's community list: the communities it owns (archived ones
   * have no relay to join and are left out), and whether it may create one.
   */
  communityList(): Promise<CommunityList>;
  /** Whether `<name>.communities.buzz.xyz` is free to create: the section's availability check. */
  communityAvailable(name: string): Promise<boolean>;
  /**
   * Creates `<name>.communities.buzz.xyz`, owned by the account's bound key,
   * and resolves to the canonical origin a join uses. The section's create;
   * kgoose provisions the relay before it answers. A limit refusal is worded
   * with the list's `quotaLimit`, as the section words it.
   */
  createCommunity(name: string, quotaLimit?: number): Promise<string>;
  /**
   * The destinations saved to the account, `wss://host[:port]` in kgoose's
   * order: the list the Builderlab plugin's known-communities sync keeps.
   * Rejects on any failure, and on a row this client cannot read, so a list it
   * half understood is never acted on.
   */
  knownCommunities(): Promise<readonly string[]>;
  /**
   * Saves `url` to that list (`wss://host[:port]`), as the sync's outbox add
   * would at the next Settings sign-in; the add is idempotent, so that later
   * send changes nothing. Rejects on any failure, including a 2xx that is not
   * kgoose's JSON reply, which the outbox would count as saved.
   */
  saveCommunity(url: string): Promise<void>;
  /**
   * Binds `pubkey`, the key on this device, to the account: kgoose's challenge,
   * the native kind-24243 signer, then verify. Sends nothing more once the
   * account already holds that key, so running it again is safe, and never
   * verifies a signature by any other key.
   */
  bind(pubkey: string): Promise<void>;
  /**
   * Unbinds `old`, the key the account held before starting over, so
   * `replacement`, the new key on this device, can be linked: kgoose's delete.
   * Sends nothing more once the account holds no key or `replacement` (after a
   * re-run), so running it again never removes that, and fails without a
   * delete when it holds a third key. Resolves only once the account holds no
   * key or `replacement`.
   */
  unbind(old: string, replacement: string): Promise<void>;
  /**
   * Backs `pubkey` up and waits for the native uploader's result; rejects with
   * a `BackupError` (`backUpWith`).
   */
  backUp(pubkey: string): Promise<void>;
  /**
   * The hex keys the account holds a backup of, or "unavailable" where backup
   * is not offered (nothing is sent) or kgoose has no backups configured (404).
   * Rejects with a `BackupError`.
   */
  backupStatus(): Promise<readonly string[] | "unavailable">;
  /**
   * Restores a backed-up key. Native recovery opens its own browser sign-in
   * (it takes no first-run credential), and an installed key leaves the
   * identity ready.
   */
  recovery: Recovery;
}>;

/** The identity's backup status, consent and recovery, which the backup steps use. */
type BackupIdentity = Pick<
  Identity,
  | "backup"
  | "setBackupChoice"
  | "subscribe"
  | "snapshot"
  | "beginRecovery"
  | "installRecovery"
  | "cancelRecovery"
>;

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Native commands and host HTTP reject with strings; surface them as errors. */
const asError = (error: unknown) =>
  typeof error === "string" ? new Error(error) : error;

/**
 * A setup-needed mapping is "not linked", as the Builderlab communities
 * section reads it. Only the list route answers this way; the identity route answers 200
 * with no `identity` instead (see `linkedKey`).
 */
const notLinked = (reply: Reply) =>
  reply.error?.setup_needed === true ||
  (typeof reply.error?.code === "string" &&
    reply.error.code.toLowerCase() === "missing_mapping");

/** A reply `notLinked` read as null is the card's missing-mapping refusal. */
const notBound = (reply: Reply | null, fallback: string) =>
  reply ?? check({ error: { code: "missing_mapping" } }, fallback);

/**
 * Names the step and the HTTP status so a failed page tells the account check
 * from the list, and a 403 text/plain from a JSON shape problem. Never the
 * response body: provider bodies are not forwarded to the user.
 */
const failure = (
  step: string,
  response: Pick<HostResponse, "status">,
  detail?: string,
) =>
  new Error(
    `Builderlab ${step} failed (HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
  );

/**
 * kgoose answers a lapsed session credential on every `@Authenticated` route
 * with misk's plain-text 401. Try again would send the same credential.
 */
const SIGNED_OUT = "Your Builderlab sign-in is no longer valid.";

const OTHER_KEY =
  "Your Builderlab account is linked to a different key, so your new key can’t be linked.";

const KEY_CHANGED =
  "The key on this device changed before it could be linked, so your Builderlab account wasn’t changed.";

/**
 * A transport failure (no status), a rate limit or a 5xx may clear on its own,
 * as the native uploader reads them, so the failed page offers Try again; a
 * refusal or an answer we rejected will not. kgoose's challenge route answers
 * 429 `too_many_attempts` once five challenges are open. A host refusal (an
 * undeclared origin) also arrives with no status: native host requests reject
 * with untyped strings, so it cannot be told from a transport failure here.
 */
const transient = (error: unknown, status?: number) =>
  error instanceof Error &&
  (status === undefined || status === 429 || status >= 500)
    ? Object.assign(error, { retryable: true })
    : error;

/**
 * kgoose identity codes (`BuzzNostrIdentityErrorCode`) the hosted card's table
 * lacks, in first run's voice. The card reads `unknown` as its deletion
 * service's, so it takes the step's fallback (no `message`). A code about one
 * challenge is `retryable` whatever its status: Try again re-runs `bind()`,
 * which reads `current` again and asks for a fresh challenge.
 * `invalid_challenge` is not: kgoose sends it for a bad signature or a
 * `created_at` outside its skew window, and a fresh challenge fixes neither.
 */
const ACCOUNT_ERRORS: Readonly<
  Record<string, Readonly<{ message?: string; retryable?: true }>>
> = {
  invalid_origin: {
    message: "Builderlab didn’t accept this request from Buzz.",
  },
  invalid_challenge: {
    message:
      "Builderlab couldn’t verify your key’s signature, so the key wasn’t linked.",
  },
  challenge_not_found: {
    message:
      "Builderlab couldn’t find the request to link your key, so the key wasn’t linked.",
    retryable: true,
  },
  challenge_expired: {
    message:
      "The request to link your key expired before Builderlab confirmed it.",
    retryable: true,
  },
  challenge_consumed: {
    message: "The request to link your key was already used.",
    retryable: true,
  },
  too_many_attempts: {
    message:
      "Builderlab has had too many attempts to link a key. Wait a few minutes, then try again.",
  },
  unknown: {},
};

/**
 * The card's `check` with `ACCOUNT_ERRORS` first. kgoose's own message is
 * dropped, so a code neither table knows takes the step's fallback and
 * kgoose's wording never reaches the failed page. So is its correlation ID,
 * which the card's `ApiFailure` would append to the copy; `call` keeps it.
 */
function checked(reply: Reply, fallback: string, quotaLimit?: number) {
  if (!reply.error) return reply;
  const code = reply.error.code ?? "";
  const own = Object.hasOwn(ACCOUNT_ERRORS, code)
    ? ACCOUNT_ERRORS[code]
    : undefined;
  // Throws the card's copy: the reply has an error.
  if (!own) return check({ error: { code } }, fallback, quotaLimit);
  throw Object.assign(
    new ApiFailure(code, own.message ?? fallback),
    own.retryable ? { retryable: true } : {},
  );
}

/** The Builderlab communities native backend's reply rules, for a response that came through the bundled grant. */
function parse(
  step: string,
  response: HostResponse,
  limit = MAX_RESPONSE_BYTES,
): Reply {
  if (new TextEncoder().encode(response.body).byteLength > limit)
    throw failure(step, response, "response too large");
  let value: unknown;
  try {
    value = JSON.parse(response.body);
  } catch {
    throw failure(step, response, "not JSON");
  }
  const ok = response.status >= 200 && response.status < 300;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (ok || (value as Reply).error)
  )
    return value as Reply;
  throw failure(step, response);
}

/** A backup route's status as the native uploader reads it (`nsec_backup.rs` `failure`). */
const backupFailure = (status: number): BackupFailureKind =>
  status === 401
    ? "signed_out"
    : status === 403
      ? "not_offered"
      : status >= 400 && status < 500 && status !== 429
        ? "refused"
        : "unreachable";

/**
 * `nsec-backups/status`'s `backup_nostr_pubkeys`, or undefined for any other
 * reply. kgoose's Moshi response type always writes this list (`[]` for none)
 * and drops a null `current_nostr_pubkey`, so unlike the Wire list routes, a
 * missing list is not an empty one.
 */
function backedUpKeys(response: HostResponse) {
  if (new TextEncoder().encode(response.body).byteLength > MAX_RESPONSE_BYTES)
    return undefined;
  let keys: unknown;
  try {
    keys = JSON.parse(response.body)?.backup_nostr_pubkeys;
  } catch {
    return undefined;
  }
  if (!Array.isArray(keys)) return undefined;
  const listed = keys.map((key) =>
    typeof key === "string" ? boundKey({ pubkey_hex: key }) : null,
  );
  return listed.every((key) => key !== null) ? listed : undefined;
}

function owned(community: NonNullable<Reply["communities"]>[number]) {
  const relay = relayUrl(community);
  if (!relay || community.archived_at) return [];
  try {
    const url = enteredRelayOrigin(relay);
    return [{ host: new URL(url).host, url }];
  } catch {
    return [];
  }
}

/**
 * Whether this build backs a key up for a Builderlab sign-in: only when it has
 * a Builderlab URL (`oauthTarget` throws otherwise) and the native status says
 * Builderlab backup is allowed. First run's status read and Settings →
 * Identity share this rule; `backUpWith` checks the native status itself.
 * Any error answers false.
 */
export async function backupOfferedFor(
  backup: Pick<Identity["backup"], "ready">,
) {
  try {
    oauthTarget();
    return (await backup.ready()).builderlab;
  } catch {
    return false;
  }
}

/**
 * The real reads, binding and unlink, against the build URL's kgoose
 * (`<BUZZ_BUILDERLAB_URL>/api/goose`),
 * authenticated with the first-run session credential and sent through the
 * bundled plugin's native grant like the sign-in itself. Routes and reply
 * shapes are the communities section's (`communities/native.ts` ROUTES
 * `identity`, `list` and `unbind`, and its `bind`; `api.ts` parsers) and, for the saved
 * destinations, the Builderlab plugin's known-communities list and add;
 * neither owner's own client is touched. The backup goes through the native
 * uploader instead (`backup.ts`).
 */
export function builderlabAccount(
  credential: Credential,
  request: Host["request"],
  identity: BackupIdentity,
): FirstRunAccount {
  const target = oauthTarget();
  return kgooseAccount(
    (path, headers, body) =>
      request({
        url: `${target}${path}`,
        method: "POST",
        headers: { ...headers, "X-BB-Session-Credential": credential.value },
        body,
      }),
    { credential: credential.value },
    identity,
  );
}

/**
 * `builderlabAccount` for an FI build's sign-in (`firstRunCredential`): the
 * same routes through the bundled plugin's NIP-FI forwarder, which sends the
 * native session as a Bearer token, each fenced to the session that sign-in
 * returned (`credential.value` is its revision).
 */
export function federatedBuilderlabAccount(
  credential: Pick<Credential, "value">,
  federated: Pick<FederatedIdentity, "snapshot" | "request">,
  identity: BackupIdentity,
): FirstRunAccount {
  return kgooseAccount(
    (path, headers, body) => {
      const session = federated.snapshot();
      if (
        session.status !== "signed-in" ||
        session.revision !== credential.value ||
        !session.authority
      )
        return Promise.reject(new Error(SIGNED_OUT));
      return federated.request({
        path: `${session.authority.apiBasePath}${path.slice(1)}`,
        method: "POST",
        headers,
        body,
      });
    },
    { federated: credential.value },
    identity,
  );
}

/** One JSON POST under the Builderlab API root; `path` starts with `/`. */
type Post = (
  path: string,
  headers: Readonly<Record<string, string>>,
  body: string,
) => Promise<HostResponse>;

function kgooseAccount(
  send: Post,
  session: Parameters<typeof backUpWith>[2],
  identity: BackupIdentity,
): FirstRunAccount {
  const portal = new URL(oauthTarget()).origin;
  const post = (path: string, body: object = {}) =>
    send(
      path,
      {
        "Content-Type": "application/json",
        // Binding requires the challenge origin to match this header.
        Origin: portal,
      },
      JSON.stringify(body),
    );
  /**
   * One POST; `read` turns the parsed reply (null when not linked) into the
   * answer. Any refusal of the answer is logged in development with the
   * route, status and kgoose's correlation ID — again never the body — then
   * thrown with that ID as `correlationId`, off the failed page.
   */
  const call = async <T>(
    step: string,
    path: string,
    fallback: string,
    read: (reply: Reply | null, response: HostResponse) => T,
    body: object = {},
    {
      limit,
      quotaLimit,
    }: { limit?: number; quotaLimit?: number | undefined } = {},
  ) => {
    const response = await post(path, body).catch((error: unknown) => {
      throw transient(asError(error));
    });
    let reply: Reply | undefined;
    try {
      if (response.status === 401) throw new Error(SIGNED_OUT);
      reply = parse(step, response, limit);
      return read(
        notLinked(reply) ? null : checked(reply, fallback, quotaLimit),
        response,
      );
    } catch (error) {
      const id = reply?.correlation_id;
      if (id && error instanceof Error)
        Object.assign(error, { correlationId: id });
      if (import.meta.env.DEV)
        console.warn(
          `Builderlab ${step}: POST ${path} answered HTTP ${response.status}${id ? ` (correlation ID ${id})` : ""}`,
          error instanceof Error ? error.message : error,
        );
      throw transient(error, response.status);
    }
  };
  const linkedKey = () =>
    call(
      "account check",
      "/v1/buzz/nostr-identities/current",
      "Could not check this Builderlab account.",
      (reply, response) => {
        // kgoose answers 200 with `identity` null or absent when no key is
        // bound; it never sends MISSING_MAPPING here. A linked account must
        // never be given a second key, so a bound identity without a usable
        // key is a failure, not "not linked".
        if (!reply || reply.identity == null) return null;
        const key = boundKey(reply.identity);
        if (!key)
          throw failure("account check", response, "unusable linked key");
        return key;
      },
    );
  return {
    linkedKey,
    async bind(pubkey) {
      // Re-running after a failure must not meet 409 `pubkey_already_bound`.
      if ((await linkedKey()) === pubkey) return;
      const step = "account link";
      const fallback = "Could not link your key to this Builderlab account.";
      // The challenge refuses only with 403 `unauthorized` or `invalid_origin`,
      // or 429 `too_many_attempts`.
      const challenge = await call(
        step,
        "/v1/buzz/nostr-identities/challenge",
        fallback,
        (reply, response) => {
          if (!reply) throw failure(step, response);
          const { challenge_id, nonce, verification_code, origin, expires_at } =
            reply as Record<string, unknown>;
          if (origin !== portal)
            throw failure(step, response, "challenge for another origin");
          return { challenge_id, nonce, verification_code, origin, expires_at };
        },
        { origin: portal },
      );
      // Native code signs a well-formed challenge for production Builderlab
      // or the build URL's origin, so the read above passes on only the
      // latter. It signs with whatever key secure storage holds now. Verify
      // binds the signer, which linking again cannot undo, so only `pubkey`'s
      // signature may reach kgoose.
      const event = await invoke<{ pubkey?: unknown }>(
        "identity_sign_builderlab_binding",
        { challenge },
      ).catch((error: unknown) => {
        throw asError(error);
      });
      if (event.pubkey !== pubkey) throw new Error(KEY_CHANGED);
      // An account bound to another key is refused here, with 409
      // `identity_already_bound`.
      await call(
        step,
        "/v1/buzz/nostr-identities/verify",
        fallback,
        (reply, response) => {
          if (boundKey(reply?.identity) !== pubkey)
            throw failure(step, response, "link not confirmed");
        },
        {
          challenge_id: challenge.challenge_id,
          nonce: challenge.nonce,
          signed_payload: JSON.stringify(event),
        },
      );
    },
    async unbind(old, replacement) {
      // kgoose deletes whatever is bound, so check it is still the old key.
      // A key bound between this read and the delete is still removed: the
      // real fix is an `expected_pubkey_hex` on the delete request, checked
      // under kgoose's user-row lock.
      const before = await linkedKey();
      if (before === null || before === replacement) return;
      if (before !== old) throw new Error(OTHER_KEY);
      const removed = await call(
        "account unlink",
        "/v1/buzz/nostr-identities/delete",
        "Could not unlink your old key from this Builderlab account.",
        (reply) => boundKey(reply?.identity),
      );
      if (removed === old) return;
      // kgoose also answers 200 with no `identity`, removing nothing, when
      // the session or its authorization has lapsed, so read what is bound.
      const now = await linkedKey();
      if (now === null || now === replacement) return;
      throw new Error(
        now === old
          ? "Builderlab didn’t unlink your old key, so your new key can’t be linked. Your Builderlab sign-in may have ended."
          : OTHER_KEY,
      );
    },
    communityList: () =>
      call(
        "community list",
        "/v1/buzz/communities/list",
        "Could not load the communities this account owns.",
        (reply) => {
          const readable = reply && quota(reply);
          return {
            owned: reply?.communities?.flatMap(owned) ?? [],
            canCreate: reply !== null && readable?.canCreate !== false,
            quotaLimit: readable?.limit,
          };
        },
      ),
    communityAvailable: (name) =>
      call(
        "community availability",
        "/v1/buzz/communities/availability",
        "Could not check that address.",
        (reply) =>
          Boolean(notBound(reply, "Could not check that address.").available),
        { name },
      ),
    createCommunity: (name, quotaLimit) =>
      call(
        "community create",
        "/v1/buzz/communities",
        "Could not create the community.",
        (reply, response) => {
          const { community } = notBound(
            reply,
            "Could not create the community.",
          );
          const relay = community && relayUrl(community);
          if (!relay)
            throw failure("community create", response, "no community address");
          return enteredRelayOrigin(relay);
        },
        { name },
        { quotaLimit },
      ),
    // The route consults no Nostr identity, so its refusals are plain strings
    // and `reply` is never null here; its rows are not the card's.
    knownCommunities: () =>
      call(
        "known communities",
        "/v1/buzz/known-communities/list",
        "Could not load the communities saved to this account.",
        (reply, response) => {
          // Protobuf JSON can omit an empty repeated field.
          const rows: unknown = reply?.communities ?? [];
          const listed = Array.isArray(rows)
            ? rows.map(listedAddress)
            : [undefined];
          if (listed.includes(undefined))
            throw failure("known communities", response, "unreadable row");
          return listed.filter((address): address is string => !!address);
        },
        {},
        // Uncapped, as the plugin's own client reads it: kgoose holds about
        // 1,000 destinations of at most 512 characters, far inside the host
        // transport's cap.
        { limit: Number.POSITIVE_INFINITY },
      ),
    async saveCommunity(url) {
      await call(
        "community save",
        "/v1/buzz/known-communities/add",
        "Could not save this community to your Builderlab account.",
        () => undefined,
        { community_url: relayAddress(url) },
      );
    },
    backUp: (pubkey) => backUpWith(identity, pubkey, session),
    // Backup routes answer plain text, not the card's reply shape, so only
    // the status and a 2xx body are read.
    async backupStatus() {
      if (!(await backupOfferedFor(identity.backup))) return "unavailable";
      const path = "/v1/buzz/nsec-backups/status";
      const response = await post(path).catch(() => {
        throw new BackupError("unreachable");
      });
      if (response.status === 404) return "unavailable";
      const ok = response.status >= 200 && response.status < 300;
      const keys = ok ? backedUpKeys(response) : undefined;
      if (keys) return keys;
      if (import.meta.env.DEV)
        console.warn(
          `Builderlab backup status: POST ${path} answered HTTP ${response.status}`,
        );
      throw new BackupError(
        ok ? "invalid_service" : backupFailure(response.status),
      );
    },
    recovery: {
      subscribe: identity.subscribe,
      snapshot() {
        const state = identity.snapshot();
        return state.status === "missing" ? state.recovery : undefined;
      },
      beginRecovery: identity.beginRecovery,
      installRecovery: identity.installRecovery,
      cancelRecovery: identity.cancelRecovery,
    },
  };
}

/**
 * Recovery answered from the seed, with no browser sign-in or native recovery
 * command: a seeded `recovery` key is the one backup recovered, and
 * installing it imports it as Enter your private key would. With none, every
 * restore answers that recovery is unavailable, as every tenant does today.
 */
function seededRecovery(
  seed: FirstRunAccountSeed,
  identity: Pick<Identity, "importKey" | "snapshot">,
): Recovery {
  let state: RecoveryState | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: RecoveryState | undefined) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => state,
    async beginRecovery() {
      publish(
        seed.recovery
          ? {
              status: "choosing",
              candidates: [{ handle: "seed", pubkey: seed.recovery.pubkey }],
              currentPubkey: seed.linked,
              failedCount: 0,
            }
          : { status: "error", error: RECOVERY_UNAVAILABLE },
      );
    },
    async installRecovery() {
      if (!seed.recovery) return;
      publish({ status: "saving" });
      await identity.importKey(seed.recovery.nsec);
      const saved = identity.snapshot();
      publish(
        saved.status === "ready"
          ? undefined
          : {
              status: "error",
              error:
                (saved.status === "missing" && saved.error) ||
                "Couldn’t restore your identity. Try again.",
            },
      );
    },
    async cancelRecovery() {
      publish(undefined);
      return true;
    },
  };
}

/**
 * The reads answered from the `BUZZ_DEV_FIRST_RUN_ACCOUNT` development seed.
 * Binding, unlinking and backup succeed without a request, a native signature
 * or a native backup command, in every build; a seeded `backup` kind fails
 * every backup with that kind's page instead (`fail-once`: only this sign-in's
 * first, as an unconfirmed upload, so Try again succeeds), and a seeded
 * `unlink` status fails every unlink as kgoose answering it would. Backup
 * status lists the seeded `backups`, the saved destinations are the seeded
 * `known` (a save sends nothing), and recovery is `seededRecovery`.
 */
export function seededAccount(
  seed: FirstRunAccountSeed,
  identity: Pick<Identity, "importKey" | "snapshot">,
): FirstRunAccount {
  let failOnce = seed.backup === "fail-once";
  return {
    linkedKey: () => Promise.resolve(seed.linked),
    // The seed models no hosted communities to create.
    communityList: () =>
      Promise.resolve({ owned: seed.communities, canCreate: false }),
    knownCommunities: () => Promise.resolve(seed.known ?? []),
    communityAvailable: () => Promise.resolve(false),
    createCommunity: () =>
      Promise.reject(new Error("The development seed creates no communities.")),
    saveCommunity: () => Promise.resolve(),
    bind: () => Promise.resolve(),
    unbind: () =>
      seed.unlink
        ? Promise.reject(
            transient(
              seed.unlink === 401
                ? new Error(SIGNED_OUT)
                : failure("account unlink", { status: seed.unlink }),
              seed.unlink,
            ),
          )
        : Promise.resolve(),
    backUp() {
      if (failOnce) {
        failOnce = false;
        return Promise.reject(new BackupError("unconfirmed"));
      }
      return seed.backup && seed.backup !== "fail-once"
        ? Promise.reject(new BackupError(seed.backup))
        : Promise.resolve();
    },
    backupStatus: () => Promise.resolve(seed.backups ?? []),
    recovery: seededRecovery(seed, identity),
  };
}
