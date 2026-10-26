import { useEffect, useSyncExternalStore } from "react";
import type { ChannelLifecycleCapability } from "../relay/channel-lifecycle";
import type { ChannelQueries } from "../relay/contracts";
import { PublishRejected } from "../relay/outbox";
import { useChannelList } from "../relay/react";
import type { RelaySession } from "../relay/session";
import { readView, writeView } from "../../shared/view-state";

/** `done` once per community, viewer and device; leaving the community purges
 * it with the rest of the view scope, so a rejoin starts fresh. */
const KEY = "default-channels";

/** The relay joins new members into its `auto_join` channels itself. This is
 * the backstop for open or old relays and failed adds: with a verified-empty
 * roster, send 9021 for each flagged public channel, at most once per
 * community, viewer and device. A non-empty roster spends the one shot too,
 * so leaving every channel later never re-adds them on this device; a device
 * that has never marked the scope done may re-add them once. The marker is
 * written only when the directory read was complete and every candidate
 * settled with success or a definitive relay rejection; anything else retries
 * next time. */
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
  let partial: boolean;
  try {
    ({ ids, partial } = await queries.defaultChannels({ signal }));
  } catch {
    return;
  }
  // A capped directory page may hide flagged channels; leave the shot unspent.
  let settled = !partial;
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
