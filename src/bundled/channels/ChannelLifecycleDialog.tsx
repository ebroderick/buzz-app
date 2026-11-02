import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import type { ChannelLifecycleCapability } from "../../features/relay/channel-lifecycle";
import type { ChannelLifecycleAction } from "../../features/relay/channel-lifecycle-protocol";
import { Dialog, type DialogProps } from "../../shared/design-system/ui/Dialog";
import {
  ToastNotice,
  useToastNotification,
} from "../../shared/design-system/ui/Toast";

export type LifecycleNoun = "channel" | "chat";

/** Solo chats are channels on the relay; people should read them as chats. */
export const lifecycleNoun = (
  channel: Readonly<{ channelType?: string | undefined }> | undefined,
): LifecycleNoun => (channel?.channelType === "solo" ? "chat" : "channel");

const details = {
  channel: {
    archive:
      "Archive this channel for everyone and remove it from the sidebar. Messages are kept. Find it in search and open Settings to unarchive it later.",
    unarchive:
      "Unarchive this channel for everyone and return it to the sidebar. Members can send messages again.",
    delete: "This deletes the channel for everyone. You can’t undo this.",
    leave:
      "Leave this channel and remove it from your sidebar. You may need an invitation to rejoin a private channel.",
  },
  chat: {
    archive:
      "Archive this chat for everyone in it and remove it from the sidebar. Messages are kept. Find it in search to unarchive it later.",
    unarchive:
      "Unarchive this chat and return it to the sidebar. Messages can be sent again.",
    delete: "This deletes the chat for everyone in it. You can’t undo this.",
    leave:
      "Leave this chat and remove it from your sidebar. You may need an invitation to rejoin.",
  },
} as const;

function copyFor(action: ChannelLifecycleAction, noun: LifecycleNoun) {
  if (action === "hide")
    return {
      pending: "Hiding conversation…",
      done: "Conversation hidden",
      title: "Hide conversation",
      detail:
        "Hide this conversation from your sidebar only. Messages and membership are kept; other participants are not removed.",
    };
  const Noun = noun === "chat" ? "Chat" : "Channel";
  const verb = {
    archive: ["Archive", "Archiving", "archived"],
    unarchive: ["Unarchive", "Unarchiving", "unarchived"],
    delete: ["Delete", "Deleting", "deleted"],
    leave: ["Leave", "Leaving", "left"],
  }[action];
  return {
    pending: `${verb[1]} ${noun}…`,
    done: `${Noun} ${verb[2]}`,
    title: `${verb[0]} ${noun}`,
    detail: details[noun][action],
  };
}

// Reversible actions retain their prominent treatment. Archive still starts
// on Cancel, so an accidental Enter cannot archive a channel for everyone.
const reversible = new Set<ChannelLifecycleAction>([
  "archive",
  "unarchive",
  "hide",
]);

export function ChannelLifecycleDialog({
  channelId,
  channelName,
  noun = "channel",
  action,
  lifecycle,
  close,
  completed,
  onSubmit,
  failed,
  finalFocus,
  confirmed = false,
  undo,
  autoJoin = false,
}: {
  channelId: string;
  channelName: string;
  noun?: LifecycleNoun;
  action: ChannelLifecycleAction;
  lifecycle: ChannelLifecycleCapability;
  close(): void;
  completed(): void;
  onSubmit?(): void;
  finalFocus?: DialogProps["finalFocus"];
  failed?(title: string, message: string): void;
  /** Already chosen without a dialog, as Undo is: run it on mount. */
  confirmed?: boolean;
  /** Offered from an immediate archive's result toast. */
  undo?(): void;
  /** A starter channel: the relay keeps the flag while archived. */
  autoJoin?: boolean;
}) {
  const callbacks = useRef({ completed, failed });
  useLayoutEffect(() => {
    callbacks.current = { completed, failed };
  });
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const confirms = reversible.has(action);
  const copy = copyFor(action, noun);
  // The switch is hidden while archived, and Unarchive applies the flag again.
  const description =
    action === "archive" && autoJoin
      ? `${copy.detail} It’s a starter channel, so new members will be added to it again once it’s unarchived. To stop that, turn off Starter channel for new members in Settings first.`
      : copy.detail;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const notify = useToastNotification();
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    return () => {
      operation.current?.abort();
    };
  }, []);
  // Archiving a chat is undoable from its result toast, so it skips
  // confirmation; channels archive for everyone and still confirm. Undo was
  // chosen from that toast, so it runs at once too.
  // Deferring the start lets a development StrictMode remount cancel it.
  const immediate = confirmed || (action === "archive" && noun === "chat");
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once per mounted archive request.
  useEffect(() => {
    if (!immediate) return;
    const timer = setTimeout(() => void submit());
    return () => clearTimeout(timer);
  }, []);
  // Without a confirmation to dismiss, a fast archive needs no progress
  // feedback: the result toast follows. Announce only a slow write.
  const [slow, setSlow] = useState(!immediate);
  useEffect(() => {
    if (!immediate || !busy) return;
    const timer = setTimeout(() => setSlow(true), 1000);
    return () => clearTimeout(timer);
  }, [immediate, busy]);
  const submit = async () => {
    if (operation.current || error) return;
    const controller = new AbortController();
    operation.current = controller;
    onSubmit?.();
    setBusy(true);
    setError("");
    try {
      await lifecycle.run(action, channelId, controller.signal);
      if (!controller.signal.aborted) {
        notify(
          `${copy.done}: ${channelName}`,
          "success",
          immediate && action === "archive" && undo
            ? { label: "Undo", onClick: undo, timeout: 3000 }
            : undefined,
        );
        callbacks.current.completed();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        if (callbacks.current.failed)
          callbacks.current.failed(`${copy.title} failed`, message);
        else setError(message);
      }
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  // Keep the owner mounted while closing the modal, so shared focus restoration
  // runs and the caller's duplicate gate remains held until the result settles.
  return (
    <>
      {((busy && slow) || error) && (
        <ToastNotice
          title={busy ? copy.pending : `${copy.title} failed`}
          description={busy ? channelName : error}
          tone={busy ? "info" : "error"}
          {...(!busy && { onDismiss: close })}
        />
      )}
      <Dialog
        size="compact"
        open={!immediate && !busy && !error}
        dismissOnOutsideClick
        initialFocus={confirms && action !== "archive" ? confirm : cancel}
        // Cancellation remains sidebar-owned; submission returns to the trigger.
        finalFocus={busy || error ? finalFocus : false}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title={
          action === "delete"
            ? `Delete ${channelName}?`
            : `${copy.title}: ${channelName}`
        }
        description={description}
        actions={
          <>
            <Button ref={cancel} type="button" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              ref={confirm}
              variant={
                action === "delete"
                  ? "destructive"
                  : confirms
                    ? "prominent"
                    : "subtle"
              }
              onClick={() => void submit()}
            >
              {copy.title}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </>
  );
}
