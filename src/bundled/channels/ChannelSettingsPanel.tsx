import { usePanelTabHost } from "../../features/panels/PanelWorkspace";
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import { PublishNotSent, PublishRejected } from "../../features/relay/outbox";
import { managesCommunity } from "../../features/communities/roster";
import type { CommunityMembership } from "../moderation/membership";
import { channelIcon } from "../../features/channels/channel-icon";
import {
  GearIcon,
  CircleNotchIcon,
  CaretRightIcon,
  CopyIcon,
  PencilSimpleIcon,
} from "../../shared/design-system/icons/index";
import { Tabs } from "../../shared/design-system/ui/Tabs";
import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import { Panel } from "../../shared/design-system/ui/Panel";
import { PanelHeader } from "../../shared/design-system/ui/PanelHeader";
import { Switch } from "../../shared/design-system/ui/Switch";
import styles from "./Channels.module.css";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import {
  ChannelDetailsEditor,
  type ChannelDetailsAction,
} from "./ChannelDetailsEditor";
import { writeClipboardText } from "../../shared/clipboard";

export function ChannelSettingsPanel({
  channel,
  scope,
  close,
  children,
  setupTools,
  details,
  lifecycle,
  membership,
  openMembers,
}: {
  channel: ChannelSummary | undefined;
  scope: string;
  close(): void;
  children: ReactNode;
  setupTools?: ReactNode;
  details?: ChannelDetailsCapability;
  /** With `membership`, offers the community owner/admin auto-join switch. */
  lifecycle?: ChannelLifecycleCapability | undefined;
  membership?: CommunityMembership | undefined;
  openMembers?(trigger: HTMLButtonElement): void;
}) {
  const tabbed = !!usePanelTabHost();
  const header = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (tabbed) return;
    header.current
      ?.querySelector<HTMLElement>('[role="tab"]')
      ?.focus({ preventScroll: true });
  }, [tabbed]);
  const ChannelIcon = channelIcon(channel);
  const editable =
    channel &&
    (channel.channelType === "stream" || channel.channelType === "forum") &&
    !channel.readOnly &&
    !channel.cached &&
    !channel.archived;
  const renderPanel = (
    edit?: ChannelDetailsAction,
    editStatus?: ReactNode,
    loading = false,
  ) => (
    <Panel
      as="aside"
      aria-label="Channel settings"
      aria-busy={loading}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div ref={header} className={styles.settingsPanel}>
        {!tabbed && (
          <PanelHeader
            title={
              <Tabs
                variant="navigation"
                label="Panel tabs"
                value="settings"
                onValueChange={() => {}}
                items={[
                  {
                    value: "settings",
                    label: "Channel settings",
                    icon: <GearIcon size="1rem" />,
                    panelId,
                    onClose: close,
                  },
                ]}
              />
            }
          />
        )}
        <div
          id={tabbed ? undefined : panelId}
          {...(!tabbed
            ? { role: "tabpanel", "aria-labelledby": `${panelId}-tab` }
            : {})}
          className={styles.settingsContent}
        >
          {channel && (
            <>
              <div className={styles.settingsIdentity}>
                <span className={styles.settingsIcon}>
                  <ChannelIcon size={32} aria-hidden="true" />
                </span>
                <h3
                  className={`text-heading text-primary ${styles.settingsTitle}`}
                  aria-label={channel.name}
                >
                  {edit ? (
                    <button
                      type="button"
                      className={styles.settingsTitleAction}
                      aria-label="Edit channel name"
                      disabled={edit.pending}
                      aria-busy={edit.pending}
                      aria-description={channel.name}
                      aria-haspopup="dialog"
                      onClick={(event) => edit.open(event.currentTarget)}
                    >
                      <span>
                        {channel.name}
                        {"\u2060"}
                        <span
                          className={styles.settingsTitlePencil}
                          aria-hidden="true"
                        >
                          {edit.pending ? (
                            <CircleNotchIcon
                              size={16}
                              className="motion-safe:animate-spin"
                            />
                          ) : (
                            <PencilSimpleIcon size={16} />
                          )}
                        </span>
                      </span>
                    </button>
                  ) : (
                    channel.name
                  )}
                </h3>
              </div>
              <dl className={styles.settingsDetails}>
                {channel.channelType !== "solo" &&
                  channel.channelType !== "dm" && (
                    <SettingsDetail
                      label="Description"
                      value={
                        channel.description === undefined
                          ? "Not available"
                          : channel.description || "No description"
                      }
                      valueClassName={styles.settingsDescription}
                      actionLabel="Edit"
                      loading={edit?.pending}
                      onOpen={
                        edit
                          ? (trigger) => edit.open(trigger, "description")
                          : undefined
                      }
                    />
                  )}
                {editable &&
                  channel.channelType === "stream" &&
                  channel.visibility === "public" &&
                  lifecycle &&
                  membership && (
                    <AutoJoinSetting
                      key={`auto-join:${channel.id}`}
                      channel={channel}
                      lifecycle={lifecycle}
                      membership={membership}
                    />
                  )}
                {channel.members && (
                  <SettingsDetail
                    label="Members"
                    value={String(channel.members.length)}
                    trailingIcon={
                      <CaretRightIcon size={16} aria-hidden="true" />
                    }
                    onOpen={openMembers}
                  />
                )}
                <ChannelIdDetail key={channel.id} id={channel.id} />
              </dl>
            </>
          )}
          {editStatus}
          {setupTools}
          <details className={styles.settingsDiagnostics}>
            <summary>Diagnostics</summary>
            <div className={styles.settingsTools}>{children}</div>
          </details>
        </div>
      </div>
    </Panel>
  );
  return editable && details?.available ? (
    <ChannelDetailsEditor
      channel={channel}
      capability={details}
      scope={scope}
      renderSurface={renderPanel}
    />
  ) : (
    renderPanel(
      undefined,
      editable ? <p>Editing is unavailable on this connection.</p> : undefined,
    )
  );
}

/**
 * The relay enforces who may flag a channel for new members (community
 * owners/admins on an active public stream channel); this gate only decides
 * whether to show the switch. No optimistic state: the switch follows the
 * signed metadata the lifecycle owner confirms.
 */
function AutoJoinSetting({
  channel,
  lifecycle,
  membership,
}: {
  channel: ChannelSummary;
  lifecycle: ChannelLifecycleCapability;
  membership: CommunityMembership;
}) {
  const role = useSyncExternalStore(
    membership.subscribe,
    () => membership.snapshot().role,
  );
  useEffect(() => membership.ensure(), [membership]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => operation.current?.abort(), []);
  const control = useId();
  const description = useId();
  const alert = useId();
  if (!managesCommunity(role)) return null;
  const disabled = pending || !lifecycle.available;
  const toggle = async (enabled: boolean) => {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setPending(true);
    setError("");
    try {
      await lifecycle.run(
        enabled ? "auto-join-on" : "auto-join-off",
        channel.id,
        controller.signal,
      );
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          // Setting the same value again is idempotent, so retrying is the check.
          error instanceof ChannelLifecycleUnconfirmed
            ? "Saved, but not confirmed yet. Try again to check."
            : // A rate limit or a write that never left this device, not a refusal.
              error instanceof PublishNotSent
              ? "Not sent. Try again."
              : error instanceof PublishRejected
                ? (error.reason ??
                  "Only community owners and admins can change this.")
                : error instanceof Error
                  ? error.message
                  : String(error),
        );
    } finally {
      operation.current = undefined;
      if (!controller.signal.aborted) setPending(false);
    }
  };
  // A row of the details list: the label is its term, and the description,
  // switch and any error are its definition.
  return (
    <div
      className={styles.settingsSwitch}
      data-disabled={disabled || undefined}
    >
      <dt>
        <label htmlFor={control}>Starter channel for new members</label>
      </dt>
      <dd>
        <span id={description}>
          New community members are added to this channel automatically.
        </span>
        <Switch
          id={control}
          aria-label="Starter channel for new members"
          aria-describedby={error ? `${description} ${alert}` : description}
          checked={!!channel.autoJoin}
          disabled={disabled}
          aria-busy={pending || undefined}
          onCheckedChange={(enabled) => void toggle(enabled)}
        />
        {error && (
          <p id={alert} role="alert" className="text-danger">
            {error}
          </p>
        )}
      </dd>
    </div>
  );
}

/** A native button's hit area covers the row without nesting controls or losing list semantics. */
function SettingsDetail({
  label,
  value,
  valueClassName,
  feedback,
  actionLabel,
  actionIcon = <PencilSimpleIcon size={14} />,
  trailingIcon,
  onOpen,
  hasPopup = "dialog",
  disabled = false,
  loading = false,
  renderAction = (action) => action,
}: {
  label: string;
  value: string;
  valueClassName?: string | undefined;
  feedback?: ReactNode;
  actionLabel?: string | undefined;
  actionIcon?: ReactNode;
  trailingIcon?: ReactNode;
  hasPopup?: "dialog" | false;
  disabled?: boolean;
  loading?: boolean | undefined;
  renderAction?(action: ReactElement<ComponentProps<"button">>): ReactNode;
  onOpen?: ((trigger: HTMLButtonElement) => void) | undefined;
}) {
  return (
    <div>
      <dt>
        {onOpen
          ? renderAction(
              <button
                type="button"
                className={styles.settingsDetailAction}
                aria-label={
                  actionLabel
                    ? `${actionLabel} ${label.toLowerCase()}`
                    : `View ${label.toLowerCase()}`
                }
                aria-description={value}
                aria-haspopup={hasPopup}
                disabled={loading}
                aria-busy={loading || undefined}
                aria-disabled={disabled || undefined}
                onClick={(event) => {
                  if (!disabled && !loading) onOpen(event.currentTarget);
                }}
              >
                <span className={styles.settingsDetailLabel}>
                  <span>{label}</span>
                  {!trailingIcon && (
                    <span
                      className={styles.settingsDetailIcon}
                      aria-hidden="true"
                    >
                      {loading ? (
                        <CircleNotchIcon
                          size={14}
                          className="motion-safe:animate-spin"
                        />
                      ) : (
                        actionIcon
                      )}
                    </span>
                  )}
                </span>
                {trailingIcon}
              </button>,
            )
          : label}
      </dt>
      <dd className={valueClassName}>
        {value}
        {feedback}
      </dd>
    </div>
  );
}

function ChannelIdDetail({ id }: { id: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">(
    "idle",
  );
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  async function copy() {
    setFeedbackOpen(false);
    setState("copying");
    try {
      await writeClipboardText(id);
      setState("copied");
      setFeedbackOpen(true);
    } catch {
      setState("failed");
    }
  }
  return (
    <SettingsDetail
      label="Channel ID"
      value={id}
      valueClassName={styles.settingsId}
      feedback={
        state === "failed" && (
          <p role="alert" className="text-danger">
            Couldn’t copy channel ID. Try again.
          </p>
        )
      }
      actionLabel="Copy"
      actionIcon={<CopyIcon size={14} />}
      hasPopup={false}
      disabled={state === "copying"}
      onOpen={() => void copy()}
      renderAction={(action) => (
        <Tooltip
          open={state === "copied" && feedbackOpen}
          closeOnClick={false}
          onOpenChange={(open) => {
            if (!open) setFeedbackOpen(false);
          }}
          disableHoverablePopup
          content={<span role="status">Channel ID copied</span>}
        >
          {action}
        </Tooltip>
      )}
    />
  );
}
