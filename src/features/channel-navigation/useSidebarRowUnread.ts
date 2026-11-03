import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";

export function useSidebarRowUnread(unread: UnreadCapability, ids: string) {
  const targets = useMemo(
    () =>
      (JSON.parse(ids) as string[]).map((channelId) => ({
        kind: "channel" as const,
        channelId,
      })),
    [ids],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = targets.map((target) => unread.subscribe(target, listener));
      return () => {
        for (const stop of stops) stop();
      };
    },
    [unread, targets],
  );
  const snapshot = useMemo(() => {
    let previous = new Map<string, UnreadSnapshot>();
    return () => {
      const next = new Map(
        targets.map((target) => [target.channelId, unread.snapshot(target)]),
      );
      if (
        next.size !== previous.size ||
        [...next].some(([id, value]) => previous.get(id) !== value)
      )
        previous = next;
      return previous;
    };
  }, [unread, targets]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
