import { useEffect, useSyncExternalStore } from "react";
import type { ChannelLifecycleCapability } from "../relay/channel-lifecycle";
import type { ChannelQueries } from "../relay/contracts";
import { PublishNotSent, PublishRejected } from "../relay/outbox";
import { relayPartition } from "../relay/partition";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";

/** `pending` from a fresh admission until the fallback settles, then `done`;
 * leaving the community purges it with the rest of the view scope. */
const KEY = "default-channels";

/** A claim that made this viewer a new member (`joined`, never
 * `already_member`): the fallback may reconcile the community's default
 * channels once, on this device. */
export function markDefaultChannelsPending(origin: string, viewer: string) {
  writeView(relayPartition(origin, viewer), KEY, "pending");
}

/** A definitive refusal settles a candidate; a rate limit, or a write that
 * never left this device, may succeed later. */
const refused = (error: unknown) =>
  error instanceof PublishRejected &&
  !(error instanceof PublishNotSent) &&
  !(error.reason ?? error.message).startsWith("rate-limited:");

/** The relay joins new members into its `auto_join` channels itself, once, at
 * the claim. This is the backstop for an add that failed there: only while the
 * scope is `pending` (written by `markDefaultChannelsPending`), send 9021 for
 * each flagged public channel the verified roster lacks. No marker means no
 * fresh admission on this device (an upgrade, another device, cleared storage
 * or an open community), so nothing runs and a member's earlier leave stands.
 * The marker becomes `done` only when the directory read was complete and
 * every candidate settled with success or a definitive relay refusal; anything
 * else leaves it `pending`, and the next run joins what is still missing. */
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
  if (readView(scope, KEY, undefined) !== "pending") return;
  if (!lifecycle.available || !queries.defaultChannels) return;
  let ids: readonly string[];
  let partial: boolean;
  try {
    ({ ids, partial } = await queries.defaultChannels({ signal }));
  } catch {
    return;
  }
  // A capped directory page may hide flagged channels; stay pending.
  let settled = !partial;
  // Joined channels are not candidates, so a resumed run sends only what is
  // still missing. Sequential: the lifecycle owner is single-flight, and its
  // join pre-read already sends nothing for a channel the relay added meanwhile.
  for (const id of ids) {
    if (signal.aborted) return;
    try {
      await lifecycle.run("join", id, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (!refused(error)) settled = false;
    }
  }
  if (settled) writeView(scope, KEY, "done");
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
