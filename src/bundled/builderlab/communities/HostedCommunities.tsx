import { SettingsGroup } from "../../../shared/design-system/ui/SettingsGroup";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { npubEncode } from "nostr-tools/nip19";
import { AlertDialog } from "../../../shared/design-system/ui/AlertDialog";
import { Button } from "../../../shared/design-system/ui/Button";
import { Checkbox } from "../../../shared/design-system/ui/Checkbox";
import { Dialog } from "../../../shared/design-system/ui/Dialog";
import { EmptyState } from "../../../shared/design-system/ui/EmptyState";
import { InlineHeader } from "../../../shared/design-system/ui/Header";
import { Field } from "../../../shared/design-system/ui/Field";
import { Input } from "../../../shared/design-system/ui/Input";
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  BoxArrowUpIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  GlobeIcon,
  SignOutIcon,
  TrashIcon,
  WarningCircleIcon,
} from "../../../shared/design-system/icons";
import {
  ApiFailure,
  boundKey,
  check,
  clearPendingDeletion,
  isDefinitiveDeletionRejection,
  makePendingDeletion,
  persistPendingDeletion,
  quota,
  quotaLimitMessage,
  readPendingDeletion,
  relayUrl,
  Unsupported,
  type Account,
  type Api,
  type Community,
  type Identity,
  type PendingDeletion,
  type Quota,
} from "./api";
import { writeClipboardText } from "../../../shared/clipboard";
import { CommunityAddressField, useCommunityAddress } from "./CommunityAddress";

const card = "mt-6 rounded-xl border border-default p-5";
const sectionClassName = "mt-section-gap";
const npub = (hex?: string | null) => (hex ? npubEncode(hex) : "Unavailable");
const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);
type Confirm = {
  title: string;
  description: string;
  action: string;
  run(): Promise<void>;
};

export function HostedCommunities({
  api,
  active,
  sharedSignIn = false,
}: {
  api: Api;
  active(): boolean;
  /** The surrounding page owns sign-in, sign-out and the account row. */
  sharedSignIn?: boolean;
}) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const [auth, setAuth] = useState<Account | null>();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityLoadFailed, setIdentityLoadFailed] = useState(false);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [quotaState, setQuotaState] = useState<Quota | null>(null);
  // This device's key: undefined while loading, null when it could not be read.
  const [local, setLocal] = useState<string | null>();
  const [unsupported, setUnsupported] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [transfer, setTransfer] = useState<Community | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Community | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<PendingDeletion | null>(null);
  const [blockedOwner, setBlockedOwner] = useState<string | null>(null);
  const [deletionNotice, setDeletionNotice] = useState("");
  // The last address handed off for joining, and whether the clipboard took it.
  const [handoff, setHandoff] = useState<{
    url: string;
    copied: boolean;
  } | null>(null);
  const handoffOwner = useRef(0);
  const loginAbort = useRef<AbortController | null>(null);
  // Bumped by every operation and unmount; a read applies only if none happened since it began.
  const generation = useRef(0);
  const actionOwner = useRef(0);
  const acceptedDeletions = useRef(new Map<string, PendingDeletion>());
  const loadedOwner = useRef<string | null | undefined>(undefined);

  const load = useCallback(
    async (reconcileAccepted = false) => {
      const at = generation.current;
      const [current, list] = await Promise.all([
        api.call("identity"),
        api.call("list"),
      ]);
      if (at !== generation.current) return null;
      // A setup-needed mapping is the connect state. An upstream unauthorized
      // response may also be an expired session (browser-host/builderlab.mjs forwards it).
      if (
        current.error?.code === "unauthorized" ||
        list.error?.code === "unauthorized"
      ) {
        setIdentityLoadFailed(true);
        setIdentity(null);
        setCommunities([]);
        setQuotaState(null);
        setPendingDeletion(null);
        setBlockedOwner(null);
        setDeletionNotice("");
      }
      if (!current.error?.setup_needed)
        check(current, "Could not load the connected Buzz identity.");
      if (!list.error?.setup_needed) check(list, "Could not load communities.");
      setIdentityLoadFailed(false);
      const nextIdentity = current.identity ?? null;
      const nextOwner = boundKey(nextIdentity);
      if (
        loadedOwner.current !== undefined &&
        loadedOwner.current !== nextOwner
      ) {
        acceptedDeletions.current.clear();
        setDeletionNotice("");
      }
      loadedOwner.current = nextOwner;
      const stored = readPendingDeletion();
      setBlockedOwner(
        stored &&
          (stored.owner_pubkey !== nextOwner ||
            stored.backend_origin !== api.origin())
          ? stored.owner_pubkey
          : null,
      );
      setPendingDeletion(
        stored?.owner_pubkey === nextOwner &&
          stored.backend_origin === api.origin()
          ? stored
          : null,
      );
      const listed = list.communities ?? [];
      if (
        reconcileAccepted &&
        nextOwner &&
        listed.some((community) =>
          acceptedDeletions.current.has(community.id ?? ""),
        )
      ) {
        const currentAuth = await api.getAuth().catch(() => null);
        if (at !== generation.current || !activeRef.current()) return null;
        if (currentAuth?.capabilities?.can_delete_buzz_communities === true)
          for (const community of listed) {
            if (at !== generation.current || !activeRef.current()) return null;
            const accepted = acceptedDeletions.current.get(community.id ?? "");
            if (!accepted || accepted.owner_pubkey !== nextOwner) continue;
            try {
              await api.admitDeletion(accepted.request, "recovery");
            } catch (reason) {
              if (
                at === generation.current &&
                activeRef.current() &&
                acceptedDeletions.current.get(accepted.request.community_id) ===
                  accepted
              ) {
                if (
                  reason instanceof ApiFailure &&
                  reason.code === "deletion_aborted"
                ) {
                  acceptedDeletions.current.delete(
                    accepted.request.community_id,
                  );
                  if (acceptedDeletions.current.size === 0)
                    setDeletionNotice("");
                  setError(
                    `Deletion of ${accepted.request.host} stopped. This community is not being deleted.`,
                  );
                } else setError("Couldn't check deletion status.");
              }
            }
            if (at !== generation.current || !activeRef.current()) return null;
          }
      }
      const nextCommunities = listed.filter(
        (community) =>
          !community.id || !acceptedDeletions.current.has(community.id),
      );
      const nextQuota = quota(list);
      setIdentity(nextIdentity);
      setCommunities(nextCommunities);
      setQuotaState(nextQuota);
      return { identity: nextIdentity, communities: nextCommunities };
    },
    [api],
  );

  const markDeletionAccepted = useCallback(
    (pending: PendingDeletion, at: number) => {
      if (at !== generation.current || !activeRef.current()) return false;
      clearPendingDeletion(pending);
      acceptedDeletions.current.set(pending.request.community_id, pending);
      setPendingDeletion(null);
      setCommunities((list) =>
        list.filter((item) => item.id !== pending.request.community_id),
      );
      setDeletionNotice("Deletion started");
      setError("");
      return true;
    },
    [],
  );

  const localRead = useRef(0);
  const loadLocal = useCallback(() => {
    const at = ++localRead.current;
    setLocal(undefined);
    void api
      .localKey()
      .then((key) => at === localRead.current && setLocal(key));
  }, [api]);

  useEffect(() => {
    const at = ++generation.current;
    loadLocal();
    void api
      .getAuth()
      .then((next) => {
        if (at !== generation.current) return;
        setAuth(next);
        if (next)
          return load().catch(
            (reason) => at === generation.current && setError(message(reason)),
          );
      })
      .catch((reason) => {
        if (at !== generation.current) return;
        setAuth(null);
        if (reason instanceof Unsupported) setUnsupported(reason.message);
        else setError(message(reason));
      });
    return () => {
      generation.current++;
      loginAbort.current?.abort();
    };
  }, [api, load, loadLocal]);

  /** Runs one account operation at a time; resolves whether it succeeded. */
  async function run(label: string, operation: () => Promise<unknown>) {
    if (!activeRef.current()) return false;
    const at = ++generation.current;
    const owner = ++actionOwner.current;
    setAction(label);
    setError("");
    try {
      await operation();
      return true;
    } catch (reason) {
      if (at === generation.current) setError(message(reason));
      return false;
    } finally {
      if (owner === actionOwner.current) setAction(null);
    }
  }
  const copy = async (url: string) => {
    // A retired card must not start a clipboard write.
    if (!activeRef.current()) return;
    const at = handoffOwner.current;
    const copied = await Promise.resolve()
      .then(() => writeClipboardText(url))
      .then(
        () => true,
        () => false,
      );
    if (at === handoffOwner.current) setHandoff({ url, copied });
  };
  /** Refreshes after a confirmed write; a failed read must not present the write as failed. */
  const settle = () => {
    const at = generation.current;
    return load().catch(
      (reason) =>
        at === generation.current &&
        setError(
          `The change was saved, but the list could not be refreshed. ${message(reason)} Use Refresh to try again.`,
        ),
    );
  };
  const settleDeletion = async (
    pending: PendingDeletion,
    at: number,
    operation: () => Promise<unknown>,
  ) => {
    try {
      await operation();
      if (!markDeletionAccepted(pending, at)) return false;
      await settle();
      return true;
    } catch (reason) {
      if (at !== generation.current || !activeRef.current()) return false;
      if (
        (reason instanceof ApiFailure && reason.code === "deletion_aborted") ||
        isDefinitiveDeletionRejection(reason)
      ) {
        clearPendingDeletion(pending);
        setPendingDeletion(null);
        if (reason instanceof ApiFailure && reason.code === "deletion_aborted")
          await load().catch(() => undefined);
      } else setPendingDeletion(pending);
      throw reason;
    }
  };
  const checkPendingDeletion = (pending: PendingDeletion) =>
    run("delete", async () => {
      const at = generation.current;
      const snapshot = await load();
      if (at !== generation.current || !activeRef.current()) return;
      const currentAuth = await api.getAuth();
      if (at !== generation.current || !activeRef.current()) return;
      const stored = readPendingDeletion();
      if (
        !snapshot ||
        !stored ||
        JSON.stringify(stored) !== JSON.stringify(pending) ||
        stored.backend_origin !== api.origin() ||
        boundKey(snapshot.identity) !== pending.owner_pubkey
      )
        throw new Error(
          "This deletion request no longer matches the current account. Sign in with the original account to check its status.",
        );
      setAuth(currentAuth);
      if (currentAuth?.capabilities?.can_delete_buzz_communities !== true)
        throw new Error("Community deletion is no longer available.");
      await settleDeletion(pending, at, () =>
        api.admitDeletion(pending.request, "recovery"),
      );
    });
  /** Retries a failed account check; the surrounding page keeps the shared session. */
  const retryAuth = () =>
    run("retry", async () => {
      const at = generation.current;
      const next = await api.getAuth();
      if (at !== generation.current || !activeRef.current()) return;
      setAuth(next);
      if (next) await load();
    });
  const busy = action !== null;
  // Repeated inside open dialogs, whose modal backdrop hides the page copy.
  const failure = error && (
    <p role="alert" className="error flex items-start gap-2 break-words">
      <WarningCircleIcon
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0"
      />
      <span className="min-w-0 wrap-anywhere">{error}</span>
    </p>
  );
  const bound = boundKey(identity);
  // Without a usable bound key, the account cannot prove which identity it acts for.
  const mismatch =
    Boolean(identity) && (!bound || (Boolean(local) && bound !== local));
  // Acting requires this device's key to be known and to match the account's.
  const ready = bound !== null && bound === local;
  const deletionEnabled =
    auth?.capabilities?.can_delete_buzz_communities === true;
  // A handoff belongs to the bound identity: whenever it changes, by a local
  // action or a refresh, drop the handoff and any clipboard result in flight.
  // Layout effect, so a stale handoff is never painted beside the new identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: bound is the trigger.
  useLayoutEffect(() => {
    handoffOwner.current++;
    setHandoff(null);
  }, [bound]);
  // Joining guidance is never offered for an address the card knows is archived,
  // including a clipboard result that lands after the archive.
  const shown =
    handoff &&
    !communities.some(
      (item) => item.archived_at && relayUrl(item) === handoff.url,
    )
      ? handoff
      : null;

  const bind = async () => {
    const reply = check(
      await api.call("bind"),
      "Could not connect the Buzz identity.",
    );
    setIdentity(reply.identity ?? null);
    await settle();
  };
  const mutate = async (
    kind: "archive" | "unarchive",
    community: Community,
    fallback: string,
  ) => {
    const reply = await api.call(kind, { community_id: community.id ?? "" });
    const archivedAt = reply.community?.archived_at;
    const done = kind === "archive" ? Boolean(archivedAt) : archivedAt === null;
    if (!done) check(reply, fallback);
    // Apply the confirmed state now, so a failed refresh cannot leave the row's old actions.
    if (done)
      setCommunities((list) =>
        list.map((item) =>
          item.id === community.id
            ? { ...item, archived_at: archivedAt ?? null }
            : item,
        ),
      );
    await settle();
  };

  return (
    <section
      aria-labelledby="hosted-communities-title"
      className={sectionClassName}
    >
      <InlineHeader
        id="hosted-communities-title"
        title="Communities"
        subtitle="Create and manage Block-hosted communities. Other relays don’t require a Builderlab account."
      />
      {failure}
      {unsupported ? (
        <p className={`${sectionClassName} text-body-sm text-muted`}>
          {unsupported}
        </p>
      ) : auth === undefined ? (
        <p
          role="status"
          className="flex items-center gap-2 text-body-sm text-muted"
        >
          <CircleNotchIcon
            size={16}
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
          Checking sign-in…
        </p>
      ) : !auth ? (
        sharedSignIn ? (
          <div className="mt-3">
            <Button
              loading={action === "retry"}
              disabled={busy}
              onClick={() => void retryAuth()}
            >
              Try again
            </Button>
          </div>
        ) : (
          <EmptyState
            icon={<GlobeIcon />}
            title="Sign in to manage hosted communities"
            description="Sign in through your browser to manage Block hosting. The rest of Buzz works without a Builderlab account."
            action={
              <>
                <Button
                  variant="primary"
                  loading={action === "login"}
                  disabled={busy}
                  onClick={() =>
                    void run("login", async () => {
                      loginAbort.current = new AbortController();
                      const next = await api.login(loginAbort.current.signal);
                      setAuth(next);
                      await settle();
                    })
                  }
                >
                  <ArrowSquareOutIcon size={18} aria-hidden="true" /> Sign in
                  with Builderlab
                </Button>
                {action === "login" && (
                  <Button onClick={() => loginAbort.current?.abort()}>
                    Cancel
                  </Button>
                )}
              </>
            }
          />
        )
      ) : (
        <>
          {!sharedSignIn && <InlineHeader title="Account" />}
          <SettingsGroup layout="form">
            {!sharedSignIn && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="m-0 text-label">
                    {auth.name || auth.email || "Builderlab account"}
                  </p>
                  {auth.name && auth.email && (
                    <p className="m-0 text-body-sm text-muted">{auth.email}</p>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run("sign-out", async () => {
                      await api.signOut();
                      setPendingDeletion(null);
                      setAuth(null);
                      setIdentity(null);
                      setCommunities([]);
                      setQuotaState(null);
                    })
                  }
                >
                  <SignOutIcon aria-hidden="true" /> Sign out
                </Button>
              </div>
            )}
            {!identity ? (
              identityLoadFailed ? null : (
                <div className="space-y-3">
                  <InlineHeader
                    title="Link this account to your Buzz identity"
                    subtitle="This Builderlab account isn’t linked to a Buzz identity yet. Connect this device’s key to create and own communities under it — Buzz signs a one-time challenge locally. Connecting shares the signed proof and your public identity."
                  />
                  <Button
                    variant="primary"
                    loading={action === "bind"}
                    disabled={busy}
                    onClick={() => void run("bind", bind)}
                  >
                    Connect Buzz identity
                  </Button>
                </div>
              )
            ) : local === undefined && bound ? (
              <p role="status" className="space-y-3">
                Checking this device’s Buzz identity…
              </p>
            ) : local === null && bound ? (
              <div className="space-y-3">
                <p role="alert" className="error m-0">
                  Could not read this device’s Buzz identity, so community
                  actions are paused.
                </p>
                <div className="mt-3">
                  <Button onClick={loadLocal}>Try again</Button>
                </div>
              </div>
            ) : mismatch ? (
              <section className="space-y-3" aria-label="Identity mismatch">
                <InlineHeader
                  icon={<WarningCircleIcon size={16} aria-hidden="true" />}
                  title="This account is connected to a different Buzz identity"
                />
                <p className="text-body-sm text-muted">
                  Your Builderlab account is linked to another Buzz key.
                  Creating communities and copying addresses are paused until
                  the identities match.
                </p>
                <dl className="text-body-sm">
                  <dt className="text-muted">Account uses</dt>
                  <dd className="m-0 break-all font-mono">{npub(bound)}</dd>
                  <dt className="mt-2 text-muted">This device</dt>
                  <dd className="m-0 break-all font-mono">{npub(local)}</dd>
                </dl>
                <Button
                  variant="primary"
                  disabled={busy || !local}
                  onClick={() =>
                    setConfirm({
                      title: "Switch to this device’s identity?",
                      // kgoose revokes an unlinked key: binding it again answers 409.
                      description:
                        "The key your account uses now will be permanently unlinked. It can never be linked to a Builderlab account again.",
                      action: "Switch identity",
                      run: async () => {
                        check(
                          await api.call("unbind"),
                          "Could not release the previously connected Buzz identity.",
                        );
                        setPendingDeletion(null);
                        // Unbound is a valid resting state; Connect recovers it.
                        setIdentity(null);
                        if (activeRef.current()) await bind();
                      },
                    })
                  }
                >
                  Switch to this device’s identity
                </Button>
              </section>
            ) : (
              <p className="m-0 flex min-w-0 flex-wrap items-center gap-2 text-body-sm">
                <CheckCircleIcon size={16} aria-hidden="true" />
                Buzz identity connected{" "}
                <span className="break-all font-mono text-muted">
                  {npub(bound)}
                </span>
              </p>
            )}
          </SettingsGroup>
          <div className="mt-section-gap">
            <InlineHeader
              title="Your communities"
              subtitle={
                quotaState
                  ? `${quotaState.used} of ${quotaState.limit} used`
                  : undefined
              }
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run("refresh", () => load(true))}
                >
                  <ArrowsClockwiseIcon aria-hidden="true" /> Refresh
                </Button>
              }
            />
          </div>
          {deletionNotice && (
            <p role="status" className={`${card} text-body-sm`}>
              {deletionNotice}
            </p>
          )}
          {pendingDeletion && (
            <div className={card}>
              <p className="m-0 text-label">Deletion status is unknown</p>
              <p className="text-body-sm text-muted">
                Buzz will not check automatically. Use Check deletion status
                when deletion is available. This resends the same request UUID,
                which may admit the original intent; a failed check does not
                prove the earlier request was never accepted.
              </p>
              <p className="break-all font-mono text-body-sm">
                {pendingDeletion.request.host}
              </p>
              <p className="text-body-sm text-muted">
                If this remains uncertain, contact support and include this
                Request UUID:
              </p>
              <p className="select-all break-all font-mono text-body-sm">
                {pendingDeletion.request.request_id}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  loading={action === "delete"}
                  disabled={busy || !deletionEnabled || !ready}
                  onClick={() => void checkPendingDeletion(pendingDeletion)}
                >
                  Check deletion status
                </Button>
              </div>
              {!deletionEnabled && (
                <p className="text-body-sm text-muted">
                  Community deletion is unavailable right now, so this request
                  can't be checked. It stays saved on this device.
                </p>
              )}
            </div>
          )}
          {deletionEnabled && blockedOwner && (
            <p role="status" className={`${card} text-body-sm`}>
              {blockedOwner === bound ? (
                <>
                  This identity has a deletion request saved from a different
                  app address on this device. It can't be checked here, so
                  contact support before starting another deletion.
                </>
              ) : (
                <>
                  A deletion request from {npub(blockedOwner)} is still pending
                  on this device. Switch to that Buzz identity and use Check
                  deletion status before starting another deletion here. If you
                  no longer have that identity, contact support.
                </>
              )}
            </p>
          )}
          {communities.length === 0 ? (
            identity && !error && action !== "refresh" ? (
              <EmptyState
                icon={<GlobeIcon />}
                level={4}
                title="No hosted communities yet"
                description={
                  ready
                    ? "Create a community below to give your team a place to connect."
                    : "Communities hosted by this account will appear here."
                }
              />
            ) : null
          ) : (
            <SettingsGroup>
              <ul className="m-0 list-none p-0">
                {[...communities]
                  .sort(
                    (a, b) =>
                      Number(Boolean(a.archived_at)) -
                      Number(Boolean(b.archived_at)),
                  )
                  .map((community, index) => {
                    const name =
                      community.name ?? community.slug ?? "Hosted community";
                    const url = relayUrl(community);
                    const archived = Boolean(community.archived_at);
                    const deletionPending =
                      pendingDeletion?.request.community_id === community.id;
                    return (
                      <li
                        key={community.id ?? community.normalized_host ?? index}
                        className={`flex flex-wrap items-center justify-between gap-3 border-b border-line py-4${archived ? " opacity-70" : ""}`}
                      >
                        <div className="min-w-0">
                          <p className="m-0 text-label">{name}</p>
                          <p className="m-0 text-body-sm text-muted">
                            {community.normalized_host}
                            {archived ? " · Archived" : ""}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {archived ? (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={
                                  busy || !community.id || deletionPending
                                }
                                onClick={() =>
                                  setConfirm({
                                    title: `Unarchive ${name}?`,
                                    description:
                                      "This address becomes connectable again. Connections that closed during archival will not reconnect automatically.",
                                    action: "Unarchive",
                                    run: () =>
                                      mutate(
                                        "unarchive",
                                        community,
                                        "Could not unarchive the community.",
                                      ),
                                  })
                                }
                              >
                                <BoxArrowUpIcon aria-hidden="true" /> Unarchive
                              </Button>
                              {deletionEnabled &&
                                ready &&
                                community.id &&
                                community.normalized_host && (
                                  <Button
                                    variant="prominent"
                                    size="sm"
                                    disabled={
                                      busy ||
                                      Boolean(pendingDeletion) ||
                                      Boolean(blockedOwner)
                                    }
                                    onClick={() => setDeleteTarget(community)}
                                  >
                                    <TrashIcon aria-hidden="true" /> Delete
                                  </Button>
                                )}
                            </>
                          ) : (
                            <>
                              {url && ready && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void copy(url)}
                                >
                                  {shown?.copied && shown.url === url
                                    ? "Copied"
                                    : "Copy address"}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !community.id}
                                onClick={() => setTransfer(community)}
                              >
                                <ArrowsLeftRightIcon aria-hidden="true" />{" "}
                                Transfer
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy || !community.id}
                                onClick={() =>
                                  setConfirm({
                                    title: `Archive ${name}?`,
                                    description:
                                      "New and existing connections stop and the address stays reserved. Archiving can’t be undone from here without unarchiving, and the community keeps counting toward your quota — it isn’t deleted.",
                                    action: "Archive",
                                    run: () =>
                                      mutate(
                                        "archive",
                                        community,
                                        "Could not archive the community.",
                                      ),
                                  })
                                }
                              >
                                <ArchiveIcon aria-hidden="true" /> Archive
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </SettingsGroup>
          )}
          {shown?.copied && (
            <p role="status" className="text-body-sm text-muted">
              Address copied. To join, open the community picker and choose Join
              a community.
            </p>
          )}
          {shown && !shown.copied && (
            <div role="alert" className="text-body-sm">
              <p className="m-0">
                Couldn’t copy the address. Copy it manually, then open the
                community picker and choose Join a community:
              </p>
              <p className="m-0 select-all break-all font-mono">{shown.url}</p>
              <div className="mt-2">
                <Button
                  disabled={busy || !ready}
                  onClick={() => void copy(shown.url)}
                >
                  Try copying again
                </Button>
              </div>
            </div>
          )}
          <CreateCommunity
            api={api}
            enabled={ready && quotaState?.canCreate !== false}
            atLimit={
              quotaState?.canCreate === false
                ? quotaLimitMessage(quotaState.limit)
                : null
            }
            busy={busy}
            creating={action === "create"}
            onCreate={(name) =>
              run("create", async () => {
                const reply = check(
                  await api.call("create", { name }),
                  "Could not create the community.",
                  quotaState?.limit,
                );
                // Hand off the address before refreshing, so a failed refresh cannot lose it.
                const url = reply.community && relayUrl(reply.community);
                if (url) await copy(url);
                await settle();
              })
            }
          />
        </>
      )}
      {deleteTarget && bound && (
        <DeleteCommunityDialog
          community={deleteTarget}
          pending={action === "delete"}
          failure={failure}
          close={() => setDeleteTarget(null)}
          onDelete={() => {
            const occupied = readPendingDeletion();
            if (blockedOwner && !occupied) {
              setBlockedOwner(null);
              setError("Try again.");
              return;
            }
            if (blockedOwner || occupied) {
              if (
                occupied?.owner_pubkey === bound &&
                occupied.backend_origin === api.origin()
              ) {
                setPendingDeletion(occupied);
                setError(
                  "Deletion was not sent. This identity already has a pending deletion request. Use Check deletion status.",
                );
              } else if (occupied) {
                setBlockedOwner(occupied.owner_pubkey);
                setError(
                  occupied.owner_pubkey === bound
                    ? "Deletion was not sent. This identity has a deletion request saved from a different app address on this device. Contact support before starting another deletion."
                    : `Deletion was not sent. A deletion request from ${npub(occupied.owner_pubkey)} is already pending on this device.`,
                );
              }
              return;
            }
            let pending: PendingDeletion;
            try {
              pending = makePendingDeletion(bound, deleteTarget, api.origin());
              persistPendingDeletion(pending);
            } catch {
              const stored = readPendingDeletion();
              if (
                stored?.owner_pubkey === bound &&
                stored.backend_origin === api.origin()
              )
                setPendingDeletion(stored);
              setError(
                "Deletion was not sent because its recovery record could not be saved.",
              );
              return;
            }
            setPendingDeletion(pending);
            setDeleteTarget(null);
            void run("delete", async () => {
              const at = generation.current;
              await settleDeletion(pending, at, () =>
                api.admitDeletion(pending.request, "fresh"),
              );
            });
          }}
        />
      )}
      {confirm && (
        <AlertDialog
          title={confirm.title}
          description={confirm.description}
          pending={busy}
          onClose={() => setConfirm(null)}
          {...(failure ? { children: failure } : {})}
          actions={
            <>
              <Button disabled={busy} onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="prominent"
                loading={busy}
                onClick={() =>
                  void run("confirm", confirm.run).then(
                    (ok) => ok && setConfirm(null),
                  )
                }
              >
                {confirm.action}
              </Button>
            </>
          }
        />
      )}
      {transfer && (
        <TransferDialog
          name={transfer.name ?? transfer.slug ?? "this community"}
          busy={busy}
          failure={failure}
          close={() => setTransfer(null)}
          onTransfer={(recipient) =>
            run("transfer", async () => {
              const reply = await api.call("transfer", {
                communityId: transfer.id ?? "",
                transfereeNpub: recipient,
              });
              if (reply.error?.code === "limit_reached")
                throw new ApiFailure(
                  "limit_reached",
                  "The recipient has reached their community limit.",
                  reply.correlation_id,
                );
              check(reply, "Could not transfer ownership.");
              // The community is no longer owned; drop it before refreshing.
              setCommunities((list) =>
                list.filter((item) => item.id !== transfer.id),
              );
              await settle();
            }).then((ok) => ok && setTransfer(null))
          }
        />
      )}
    </section>
  );
}

function DeleteCommunityDialog({
  community,
  pending,
  failure,
  close,
  onDelete,
}: {
  community: Community;
  pending: boolean;
  failure: ReactNode;
  close(): void;
  onDelete(): void;
}) {
  const [host, setHost] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const expected = community.normalized_host ?? "";
  const name = community.name ?? community.slug ?? "this community";
  const confirmed = host === expected && acknowledged;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      size="compact"
      title={`Permanently delete ${name}?`}
      description="This starts an irreversible deletion."
      preventClose={pending}
      actions={
        <>
          <Button disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="prominent"
            loading={pending}
            disabled={!confirmed || pending}
            onClick={onDelete}
          >
            Start deletion
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-body-sm">
        <p className="m-0">
          This request cannot be canceled by an owner. All community content
          will be deleted eventually, the host stays permanently reserved, and
          your quota slot is released only after logical cleanup finishes.
        </p>
        <Field label="Type the exact host">
          <Input
            autoComplete="off"
            spellCheck={false}
            value={host}
            onValueChange={setHost}
          />
        </Field>
        <p className="m-0 break-all font-mono">{expected}</p>
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(checked) => setAcknowledged(checked === true)}
          label="I understand this cannot be canceled and deletion continues after acceptance."
        />
        {failure}
      </div>
    </Dialog>
  );
}

function CreateCommunity({
  api,
  enabled,
  atLimit,
  busy,
  creating,
  onCreate,
}: {
  api: Api;
  enabled: boolean;
  atLimit: string | null;
  busy: boolean;
  creating: boolean;
  onCreate(name: string): Promise<boolean>;
}) {
  const availability = useCallback(
    async (name: string) =>
      Boolean(
        check(
          await api.call("availability", { name }),
          "Could not check that address.",
        ).available,
      ),
    [api],
  );
  const address = useCommunityAddress(availability, enabled);
  return (
    <form
      className={sectionClassName}
      onSubmit={(event) => {
        event.preventDefault();
        if (address.ready)
          void onCreate(address.name).then((ok) => ok && address.setName(""));
      }}
    >
      <InlineHeader
        title="Create a community"
        subtitle="Choose the address your team will use to connect."
      />
      <SettingsGroup layout="form">
        {atLimit && <p className="text-body-sm text-muted">{atLimit}</p>}
        <CommunityAddressField address={address} busy={busy} />
        <Button
          type="submit"
          variant="primary"
          loading={creating}
          disabled={!address.ready || busy}
        >
          Create community
        </Button>
      </SettingsGroup>
    </form>
  );
}

function TransferDialog({
  name,
  busy,
  failure,
  close,
  onTransfer,
}: {
  name: string;
  busy: boolean;
  failure: ReactNode;
  close(): void;
  onTransfer(npub: string): void;
}) {
  const [recipient, setRecipient] = useState("");
  const valid = /^npub1[02-9ac-hj-np-z]{58}$/.test(recipient);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && close()}
      preventClose={busy}
      title="Transfer ownership"
      description={`Transfer ${name} to another person. You become a regular member. The recipient needs a connected Buzz identity first, and this can’t be undone.`}
      actions={
        <>
          <Button disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={busy}
            disabled={!valid}
            onClick={() => onTransfer(recipient)}
          >
            Transfer ownership
          </Button>
        </>
      }
    >
      <Field
        label="Recipient npub"
        invalid={Boolean(recipient) && !valid}
        error={
          recipient && !valid
            ? "Enter a valid npub that starts with npub1."
            : undefined
        }
      >
        <Input
          autoComplete="off"
          spellCheck={false}
          placeholder="npub1…"
          value={recipient}
          onValueChange={(value) => setRecipient(value.trim())}
        />
      </Field>
      {failure}
    </Dialog>
  );
}
