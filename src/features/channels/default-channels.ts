import { useEffect, useSyncExternalStore } from "react";
import type { ChannelLifecycleCapability } from "../relay/channel-lifecycle";
import type { ChannelQueries } from "../relay/contracts";
import { PublishRejected } from "../relay/outbox";
import { relayPartition } from "../relay/partition";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";

/** One-shot per community and viewer; leaving the community purges it with
 * the rest of the view scope, so a rejoin starts fresh. */
const KEY = "default-channels";

/** A fresh admission (`joined`, never `already_member`): the roster should
 * carry the community's default channels once Messages opens. */
export function markDefaultChannelsPending(origin: string, viewer: string) {
  writeView(relayPartition(origin, viewer), KEY, "pending");
}

/** The relay joins new members into its `auto_join` channels itself. This is
 * the backstop for open or old relays and failed adds: with a verified-empty
 * roster, send 9021 for each flagged public channel, once. A non-empty
 * roster spends the one shot too, so leaving every channel later never
 * re-adds them. The marker stays until every candidate settled with
 * success or a definitive relay rejection; anything else retries next time. */
export async function ensureDefaultChannels({
  queries,
  lifecycle,
  scope,
  signal,
}: {
  queries: Pick<ChannelQueries, "list" | "defaultChannels">;
  lifecycle: Pick<ChannelLifecycleCapability, "available" | "run">;
  scope: string;
  signal: AbortSignal;
}): Promise<void> {
  if (readView(scope, KEY, undefined) === "done") return;
  if (queries.list().channels.length) {
    writeView(scope, KEY, "done");
    return;
  }
  if (!lifecycle.available || !queries.defaultChannels) return;
  let ids: readonly string[];
  try {
    ids = await queries.defaultChannels({ signal });
  } catch {
    return;
  }
  let settled = true;
  // Sequential: the lifecycle owner is single-flight, and its join pre-read
  // already sends nothing for a channel the relay added meanwhile.
  for (const id of ids) {
    if (signal.aborted) return;
    try {
      await lifecycle.run("join", id, signal);
    } catch (error) {
      if (signal.aborted) return;
      if (!(error instanceof PublishRejected)) settled = false;
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
