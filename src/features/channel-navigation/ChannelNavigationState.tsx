import {
  ChannelLifecycleDialog,
  lifecycleNoun,
} from "../../bundled/channels/ChannelLifecycleDialog";
import { ToastNotice } from "../../shared/design-system/ui/Toast";
import { Button } from "../../shared/design-system/ui/Button";
import { useOptimisticMute } from "../../bundled/channels/useOptimisticMute";
import {
  createContext,
  useCallback,
  useLayoutEffect,
  useContext,
  useMemo,
  useState,
  useRef,
  useSyncExternalStore,
  type RefObject,
  type ReactNode,
} from "react";
import { useRelayConnection } from "../relay/react";
import type { RelayData } from "../relay/service";
import type { RelaySession } from "../relay/session";
import type { ChannelSummary } from "../relay/contracts";
import type { ChannelLifecycleAction } from "../relay/channel-lifecycle-protocol";

/** The session owns writes/recovery; each menu owns its focus and read status. */
export type ChannelMenuSurface = {
  /** Navigation presentation lifetime, not the session-owned write lifetime. */
  signal?: AbortSignal | undefined;
  close(finalFocus?: () => HTMLElement | false): void;
  focus(): void;
  pending: boolean;
  runRead(action: () => Promise<unknown>): Promise<void>;
};
type MenuActions = (
  channel: ChannelSummary,
  surface: ChannelMenuSurface,
) => readonly ReactNode[];
function createMenuActions() {
  let current: MenuActions | undefined;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(actions: MenuActions | undefined) {
      current = actions;
      for (const listener of listeners) listener();
    },
  };
}
const noActions = () => undefined;
const noSubscribe = () => () => {};
export function useChannelMenuActions() {
  const handoff = useChannelNavigation();
  return useSyncExternalStore(
    handoff?.menuActions.subscribe ?? noSubscribe,
    handoff?.menuActions.snapshot ?? noActions,
  );
}

type LifecycleCallbacks = { close(): void; completed(): void };

type PreparingDm = { existing: Set<string>; members: Set<string | undefined> };
type State = {
  session: RelaySession;
  scope: string;
  preparingDm: PreparingDm | undefined;
  lifecycleDialog:
    | {
        channel: ChannelSummary;
        action: ChannelLifecycleAction;
        trigger?: HTMLElement;
        focusFallback?: HTMLElement | undefined;
        origin?: AbortSignal | undefined;
        callbacks?: LifecycleCallbacks | undefined;
        /** Chosen from an Undo toast: runs without confirmation. */
        confirmed?: true;
      }
    | undefined;
  /** Undos chosen while another lifecycle action held the gate, oldest first. */
  queuedUndos: readonly ChannelSummary[];
};
type ActivityThread = {
  channelId: string;
  messageId: string;
  entryId: string;
  signal: AbortSignal;
  trigger: HTMLElement | null;
};
type ActivityAgent = {
  channelId: string;
  agent: string;
  trigger: HTMLElement | null;
  /** The one conversation the agent works in, whose transcript to open. */
  transcript?: { rootId?: string };
};
type Handoff = State & {
  menuActions: ReturnType<typeof createMenuActions>;
  mute: ReturnType<typeof useOptimisticMute>;
  muteRecovery: RefObject<
    { focus(channelId: string): void; closeMenu(): void } | undefined
  >;
  lifecycleCallbacks: RefObject<
    { close(): void; completed(): void } | undefined
  >;
  /** The Solo sidebar's shown chats nearest one, nearest first. */
  soloNeighbors: RefObject<((channelId: string) => string[]) | undefined>;
  activityThread: RefObject<ActivityThread | undefined>;
  activityAgent: RefObject<ActivityAgent | undefined>;
  prepareDm(members: readonly string[]): void;
  clearPreparingDm(): void;
  openLifecycle(
    channel: ChannelSummary,
    action: ChannelLifecycleAction,
    trigger?: HTMLElement,
    origin?: AbortSignal,
    callbacks?: LifecycleCallbacks,
  ): void;
  beginLifecycle(): void;
  closeLifecycle(): void;
  /** Unarchives through the same gate as every lifecycle action. */
  undoArchive(channel: ChannelSummary): void;
};
const ChannelNavigationContext = createContext<Handoff | undefined>(undefined);
export const useChannelNavigation = () => useContext(ChannelNavigationContext);

// UI intent shared by the default sidebar and the visible conversation page.
// Session replacement resets this state, not the independent page subtree.
export function ChannelNavigationProvider({
  relay,
  children,
}: {
  relay: RelayData;
  children: ReactNode;
}) {
  const connection = useRelayConnection(relay);
  const scope = connection.scope ?? "disconnected";
  const mute = useOptimisticMute(connection.session.sidebarPreferences.setMute);
  const muteRecovery = useRef<
    { focus(channelId: string): void; closeMenu(): void } | undefined
  >(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retire all sidebar callbacks when the relay session or scope changes.
  const menuActions = useMemo(createMenuActions, [connection.session, scope]);
  const lifecycleCallbacks = useRef<
    { close(): void; completed(): void } | undefined
  >(undefined);
  const soloNeighbors = useRef<((channelId: string) => string[]) | undefined>(
    undefined,
  );
  const [failure, setFailure] = useState<{
    session: RelaySession;
    title: string;
    message: string;
  }>();
  const activityThread = useRef<ActivityThread | undefined>(undefined);
  const activityAgent = useRef<ActivityAgent | undefined>(undefined);
  const [state, setState] = useState<State>(() =>
    restore(connection.session, scope),
  );
  if (state.session !== connection.session || state.scope !== scope) {
    activityThread.current = undefined;
    activityAgent.current = undefined;
    setState(restore(connection.session, scope));
  }
  const update = useCallback(
    (change: (previous: State) => State) => {
      // Retired page/dialog completions cannot mutate a replacement session.
      if (relay.snapshot().session !== connection.session) return;
      setState((previous) =>
        previous.session === connection.session ? change(previous) : previous,
      );
    },
    [relay, connection.session],
  );
  const clearPreparingDm = useCallback(() => {
    update((previous) =>
      previous.preparingDm ? { ...previous, preparingDm: undefined } : previous,
    );
  }, [update]);
  // The relay runs one lifecycle action per session, so an Undo waits for the
  // action holding the gate instead of colliding with it.
  const queuedUndo = !state.lifecycleDialog ? state.queuedUndos[0] : undefined;
  useLayoutEffect(() => {
    if (!queuedUndo) return;
    update((previous) =>
      previous.lifecycleDialog || previous.queuedUndos[0] !== queuedUndo
        ? previous
        : {
            ...previous,
            queuedUndos: previous.queuedUndos.slice(1),
            lifecycleDialog: {
              channel: queuedUndo,
              action: "unarchive",
              confirmed: true,
            },
          },
    );
  }, [queuedUndo, update]);
  const lifecycleOrigin = state.lifecycleDialog?.origin;
  useLayoutEffect(() => {
    if (!lifecycleOrigin) return;
    const retire = () =>
      update((previous) =>
        previous.lifecycleDialog?.origin === lifecycleOrigin
          ? { ...previous, lifecycleDialog: undefined }
          : previous,
      );
    if (lifecycleOrigin.aborted) retire();
    else lifecycleOrigin.addEventListener("abort", retire, { once: true });
    return () => lifecycleOrigin.removeEventListener("abort", retire);
  }, [lifecycleOrigin, update]);
  const value = useMemo<Handoff>(
    () => ({
      ...state,
      menuActions,
      mute,
      muteRecovery,
      lifecycleCallbacks,
      soloNeighbors,
      activityThread,
      activityAgent,
      prepareDm(members) {
        // Capture before the caller starts opening the DM, not in a deferred updater.
        const existing = new Set(
          connection.session.channels
            .list()
            .channels.map((channel) => channel.id),
        );
        update((previous) => ({
          ...previous,
          preparingDm: {
            existing: previous.preparingDm?.existing ?? existing,
            members: new Set([connection.viewer, ...members]),
          },
        }));
      },
      openLifecycle(channel, action, trigger, origin, callbacks) {
        update((previous) =>
          origin?.aborted || previous.lifecycleDialog
            ? previous
            : {
                ...previous,
                lifecycleDialog: {
                  channel,
                  action,
                  callbacks,
                  ...(trigger ? { trigger } : {}),
                  // Settings actions can remount after an archive-state change;
                  // the tab header lives outside the settings aside.
                  focusFallback:
                    trigger
                      ?.closest("[data-panel-workspace]")
                      ?.querySelector<HTMLElement>(
                        'button[aria-label="Close Channel settings tab"]',
                      ) ??
                    trigger
                      ?.closest("aside")
                      ?.querySelector<HTMLElement>("button") ??
                    undefined,
                  ...(origin ? { origin } : {}),
                },
              },
        );
      },
      beginLifecycle() {
        // A confirmed operation belongs to the session, not its originating visit.
        update((previous) =>
          previous.lifecycleDialog
            ? {
                ...previous,
                lifecycleDialog: {
                  ...previous.lifecycleDialog,
                  origin: undefined,
                },
              }
            : previous,
        );
      },
      closeLifecycle() {
        update((previous) => ({ ...previous, lifecycleDialog: undefined }));
      },
      undoArchive(channel) {
        update((previous) =>
          previous.lifecycleDialog
            ? {
                ...previous,
                queuedUndos: [
                  ...previous.queuedUndos.filter(({ id }) => id !== channel.id),
                  channel,
                ],
              }
            : {
                ...previous,
                lifecycleDialog: {
                  channel,
                  action: "unarchive",
                  confirmed: true,
                },
              },
        );
      },
      clearPreparingDm,
    }),
    [
      state,
      menuActions,
      mute,
      connection.session,
      connection.viewer,
      update,
      clearPreparingDm,
    ],
  );
  const archived = state.lifecycleDialog?.channel;
  return (
    <ChannelNavigationContext value={value}>
      {children}
      {[...mute.intents.values()]
        .filter((intent) => !intent.pending)
        .map((intent) => (
          <ToastNotice
            key={intent.channelId}
            title={`Couldn’t ${intent.muted ? "mute" : "unmute"} ${intent.name}`}
            description={intent.error ?? "Please try again."}
            tone="warning"
          >
            <Button
              type="button"
              size="sm"
              onClick={() => {
                mute.change(intent.channelId, intent.name, intent.muted);
                muteRecovery.current?.closeMenu();
                muteRecovery.current?.focus(intent.channelId);
              }}
            >
              Retry
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                mute.dismiss(intent.channelId);
                muteRecovery.current?.focus(intent.channelId);
              }}
            >
              Dismiss
            </Button>
          </ToastNotice>
        ))}
      {state.session === connection.session &&
        state.lifecycleDialog &&
        !state.lifecycleDialog.origin?.aborted && (
          <ChannelLifecycleDialog
            key={`${scope}:${connection.generation}`}
            channelId={state.lifecycleDialog.channel.id}
            channelName={state.lifecycleDialog.channel.name}
            noun={lifecycleNoun(state.lifecycleDialog.channel)}
            action={state.lifecycleDialog.action}
            confirmed={state.lifecycleDialog.confirmed ?? false}
            autoJoin={state.lifecycleDialog.channel.autoJoin ?? false}
            undo={() => {
              // The toast outlives this dialog: Undo restores the channel it archived.
              if (archived) value.undoArchive(archived);
            }}
            lifecycle={connection.session.channelLifecycle}
            onSubmit={value.beginLifecycle}
            // Submission closes asynchronously; use the same captured origin
            // as cancellation instead of Base UI's older focus-history entry.
            finalFocus={() => {
              const { trigger, focusFallback } = state.lifecycleDialog ?? {};
              return trigger?.isConnected
                ? trigger
                : focusFallback?.isConnected
                  ? focusFallback
                  : true;
            }}
            close={() => {
              (
                state.lifecycleDialog?.callbacks ?? lifecycleCallbacks.current
              )?.close();
              value.closeLifecycle();
            }}
            completed={() => {
              (
                state.lifecycleDialog?.callbacks ?? lifecycleCallbacks.current
              )?.completed();
              value.closeLifecycle();
            }}
            failed={(title, message) => {
              setFailure({ session: connection.session, title, message });
              value.closeLifecycle();
            }}
          />
        )}
      {failure?.session === connection.session && (
        <ToastNotice
          title={failure.title}
          description={failure.message}
          onDismiss={() => setFailure(undefined)}
        />
      )}
    </ChannelNavigationContext>
  );
}
function restore(session: RelaySession, scope: string): State {
  return {
    session,
    scope,
    preparingDm: undefined,
    lifecycleDialog: undefined,
    queuedUndos: [],
  };
}
