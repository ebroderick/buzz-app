import { useEffect, useState, useSyncExternalStore } from "react";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelList } from "../../features/relay/contracts";
import { sidebarSortNeedsActivity } from "../../features/relay/sidebar-sort";

// Presentation latch only, never roster/access data. Warm sidebar remounts reveal
// immediately, but new relay/viewer sessions start independently.
const startupSessions = new WeakMap<
  SidebarStartupSession,
  { revealed: boolean; unreadDone: boolean }
>();
export const SIDEBAR_REVEAL_BUDGET_MS = 1500;
// Only sidebar-owned presentation depends on these signals. No new relay work.
export type SidebarStartupSession = {
  live: Pick<RelaySession["live"], "subscribe" | "snapshot">;
  unread: Pick<RelaySession["unread"], "ensure">;
};

export function useSidebarStartup(
  session: SidebarStartupSession,
  list: ChannelList,
  preferences: ReturnType<RelaySession["sidebarPreferences"]["snapshot"]>,
  sortModesReady = true,
) {
  // The primary sidebar is keyed by scope and connection generation; the hook is
  // remounted for a replacement session, while same-session remounts reuse latches.
  const [retained] = useState(() => {
    const state = startupSessions.get(session) ?? {
      revealed: false,
      unreadDone: false,
    };
    startupSessions.set(session, state);
    return state;
  });
  const [revealed, setRevealed] = useState(retained.revealed);
  const [unreadDone, setUnreadDone] = useState(retained.unreadDone);
  const [expired, setExpired] = useState(false);
  // Only the roster state: live heads change on every message and prefetch.
  const readRosterState = () => session.live.snapshot().roster.state;
  const rosterState = useSyncExternalStore(
    session.live.subscribe,
    readRosterState,
    readRosterState,
  );
  const rosterAvailable = list.status === "ready" || list.status === "error";
  useEffect(() => {
    if (!rosterAvailable) return;
    let mounted = true;
    void session.unread
      .ensure()
      .catch(() => {})
      .then(() => {
        // Only the UI subscription ends on sidebar exit; the session still owns
        // this shared read. Preserve settlement if it finishes while away.
        retained.unreadDone = true;
        if (mounted) setUnreadDone(true);
      });
    return () => {
      mounted = false;
    };
  }, [session, rosterAvailable, retained]);
  useEffect(() => {
    if (revealed || !rosterAvailable) return;
    const timer = setTimeout(() => setExpired(true), SIDEBAR_REVEAL_BUDGET_MS);
    return () => clearTimeout(timer);
  }, [revealed, rosterAvailable]);
  const preferencesReady =
    !!preferences.data ||
    preferences.status === "error" ||
    preferences.status === "unsupported";
  const namesReady = rosterState !== "pending" && rosterState !== "idle";
  const needsActivity = Object.values(preferences.data?.sort ?? {}).some(
    sidebarSortNeedsActivity,
  );
  const activityReady =
    !needsActivity ||
    list.activityStatus === "ready" ||
    list.activityStatus === "error" ||
    list.activityStatus === "unavailable";
  const settled = preferencesReady && namesReady && activityReady && unreadDone;
  const restored = list.channels.some((channel) => channel.cached);
  // Plugin registration gates initial reveal, not later data refreshes.
  const ready =
    revealed ||
    restored ||
    (rosterAvailable && (expired || (settled && sortModesReady)));
  useEffect(() => {
    if (!ready || revealed) return;
    retained.revealed = true;
    setRevealed(true);
  }, [ready, revealed, retained]);
  return {
    ready,
    updating: ready && !settled,
  };
}
