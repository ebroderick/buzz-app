import { useEffect, useSyncExternalStore } from "react";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../relay/channel-lifecycle";
import type { ChannelQueries } from "../relay/contracts";
import { PublishNotSent, PublishRejected } from "../relay/outbox";
import { relayPartition } from "../relay/partition";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import {
  clearView,
  readView,
  replaceView,
  viewRevision,
  writeView,
} from "../../shared/view-state";

/** `pending` from a fresh admission, then `{ owed }` once the first run has
 * snapshotted what the claim missed, then `done`; leaving the community purges
 * it with the rest of the view scope. */
const KEY = "default-channels";

/** A claim that made this viewer a new member (`joined`, never
 * `already_member`): the fallback may reconcile the community's default
 * channels once, on this device. */
export function markDefaultChannelsPending(origin: string, viewer: string) {
  writeView(relayPartition(origin, viewer), KEY, "pending");
}

/** `pending`, the ids still owed, or nothing to do. */
function readMarker(scope: string): "pending" | readonly string[] | undefined {
  const marker = readView<unknown>(scope, KEY, undefined);
  if (marker === "pending") return marker;
  const owed = (marker as { owed?: unknown } | undefined)?.owed;
  return Array.isArray(owed)
    ? owed.filter((id): id is string => typeof id === "string")
    : undefined;
}

/** A join settles once it may have reached the relay (unconfirmed, which
 * includes a cancellation after publishing) or was definitively refused.
 * Failures known to precede publication may succeed later: a rate limit, a
 * write that never left this device, a busy or unavailable lifecycle owner, or
 * a cancellation before publishing. */
const settles = (error: unknown) =>
  error instanceof ChannelLifecycleUnconfirmed ||
  (error instanceof PublishRejected &&
    !(error instanceof PublishNotSent) &&
    !(error.reason ?? error.message).startsWith("rate-limited:"));

/** Removes a settled id from the owed set stored now, whichever run stored
 * it; `done`, a cleared marker or a new admission's `pending` stays. False
 * when storage cannot record it. */
function drop(scope: string, id: string) {
  const revision = viewRevision(scope, KEY);
  if (revision === undefined) return false;
  const owed = readMarker(scope);
  if (typeof owed !== "object" || !owed.includes(id)) return true;
  const rest = owed.filter((other) => other !== id);
  const value = rest.length ? { owed: rest } : "done";
  return replaceView(scope, KEY, revision, value) === "saved";
}

/** The relay joins new members into its `auto_join` channels itself, once, at
 * the claim. This is the backstop for an add that failed there. The first run
 * after a `pending` marker (written by `markDefaultChannelsPending`) records
 * the flagged public channels the verified roster lacks as owed, from whatever
 * page the directory read returned (a capped page is final). Channels the
 * relay already added are never owed, so leaving one is never undone. Each run
 * sends 9021 only for owed ids the directory still lists as candidates, and
 * drops an id once it joined, may have joined (unconfirmed), is no longer
 * listed (already joined, archived or unflagged) or was definitively refused;
 * the marker is `done` when nothing is owed. Nothing is sent until the owed
 * set is stored, and a drop that cannot be stored forgets the marker, so a
 * channel this fallback may have joined is never owed again. Runs can overlap
 * when a session replacement starts a successor while a cancelled publish is
 * still pending, so storage, not either run, holds what is owed: a run joins
 * only ids still stored as owed, and a settlement removes just its id from the
 * owed set stored then, keeping the other run's progress. No marker means no
 * fresh admission on this device (an upgrade, another device, cleared storage
 * or an open community), so nothing runs and a member's earlier leave stands.
 */
export async function ensureDefaultChannels({
  queries,
  lifecycle,
  scope,
  signal,
}: {
  queries: Pick<ChannelQueries, "defaultChannels">;
  lifecycle: Pick<ChannelLifecycleCapability, "available" | "run">;
  scope: string;
  signal: AbortSignal;
}): Promise<void> {
  const revision = viewRevision(scope, KEY);
  const marker = readMarker(scope);
  if (!marker) return;
  if (!lifecycle.available || !queries.defaultChannels) return;
  let missing: readonly string[];
  try {
    missing = await queries.defaultChannels({ signal });
  } catch {
    return;
  }
  const candidates =
    marker === "pending"
      ? missing
      : marker.filter((id) => missing.includes(id));
  // Send nothing until the owed set is stored, over the marker read above: a
  // stale `pending` or owed set would owe this run's joins again, and a
  // successor's snapshot stands.
  const snapshot = candidates.length ? { owed: candidates } : "done";
  if (replaceView(scope, KEY, revision, snapshot) !== "saved") return;
  // Sequential: the lifecycle owner is single-flight, and its join pre-read
  // already sends nothing for a channel the relay added meanwhile. Each settled
  // id is dropped at once, so a later leave of it stands even if this run stops.
  for (const id of candidates) {
    if (signal.aborted) return;
    // Another run may have settled it, or finished.
    const owed = readMarker(scope);
    if (typeof owed !== "object") return;
    if (!owed.includes(id)) continue;
    try {
      await lifecycle.run("join", id, signal);
    } catch (error) {
      if (!settles(error)) {
        if (signal.aborted) return;
        continue;
      }
    }
    if (drop(scope, id)) continue;
    // Storage still owes a channel that may have joined: give up the rest
    // rather than rejoin it after a leave.
    try {
      clearView(scope, KEY);
    } catch {
      // Storage is unavailable; nothing more can be recorded.
    }
    return;
  }
}

/** Runs the fallback once the live roster is verified; cached sessions wait
 * for the real connection. */
export function useDefaultChannels(
  session: Pick<RelaySession, "channels" | "channelLifecycle" | "live">,
  scope: string,
  cached: boolean,
) {
  const list = useChannelList(session.channels);
  const live = useSyncExternalStore(
    session.live.subscribe,
    session.live.snapshot,
    session.live.snapshot,
  );
  const verified =
    !cached &&
    list.status === "ready" &&
    !list.coverage &&
    live.roster.state === "verified";
  useEffect(() => {
    if (!verified) return;
    const controller = new AbortController();
    void ensureDefaultChannels({
      queries: session.channels,
      lifecycle: session.channelLifecycle,
      scope,
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [verified, session, scope]);
}
