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
import { clearView, readView, writeView } from "../../shared/view-state";

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
 * channel this fallback may have joined is never owed again. No marker means
 * no fresh admission on this device (an upgrade, another device, cleared
 * storage or an open community), so nothing runs and a member's earlier leave
 * stands. */
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
  let owed = candidates;
  const save = () => writeView(scope, KEY, owed.length ? { owed } : "done");
  // Send nothing until the owed set is stored: a stale `pending` or owed set
  // would owe this run's joins again.
  if (!save()) return;
  // Sequential: the lifecycle owner is single-flight, and its join pre-read
  // already sends nothing for a channel the relay added meanwhile. Each settled
  // id is dropped at once, so a later leave of it stands even if this run stops.
  for (const id of candidates) {
    if (signal.aborted) return;
    try {
      await lifecycle.run("join", id, signal);
    } catch (error) {
      if (!settles(error)) {
        if (signal.aborted) return;
        continue;
      }
    }
    owed = owed.filter((other) => other !== id);
    if (save()) continue;
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
