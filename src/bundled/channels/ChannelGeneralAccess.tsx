import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChannelDetailsCapability } from "../../features/relay/channel-details";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { RelayRecovery } from "../../features/relay/recovery";
import { useReauthorizedRetry } from "../../features/relay/RecoveryNotice";
import type {
  ChannelDetails,
  ChannelDetailsDraft,
} from "../../features/relay/channel-details-protocol";
import { Button } from "../../shared/design-system/ui/Button";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Select } from "../../shared/design-system/ui/Select";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import {
  CircleNotchIcon,
  LockIcon,
  GlobeIcon,
  EyeIcon,
} from "../../shared/design-system/icons";
import styles from "./ChannelMembersDialog.module.css";
import { privacyConsequence } from "./ChannelPrivacyConfirmation";
import {
  SOLO_ACCESS_DISCLOSURE,
  soloLabels,
  soloRetainedAccessWarning,
} from "../../features/solo/labels";
import {
  generalAccessOptions,
  generalAccessPolicy,
  generalAccessValue,
} from "../../features/channels/general-access";

/** General access uses the same signed save/readback owner as channel details.
 * Each policy is confirmed once, like the individual member roles. */
export function ChannelGeneralAccess({
  capability,
  recovery,
  channelId,
  channel,
  mayHaveGuestMembers = true,
}: {
  capability: ChannelDetailsCapability;
  recovery?: RelayRecovery | undefined;
  channelId: string;
  channel?: ChannelSummary;
  /** False only when the signed member-role snapshot verifies no Guests. */
  mayHaveGuestMembers?: boolean;
}) {
  const place = channel?.channelType === "solo" ? "chat" : "channel";
  const Icon =
    channel?.visibility === "public"
      ? channel.joinRole === "guest"
        ? EyeIcon
        : GlobeIcon
      : LockIcon;
  // Public previews and Guests can inspect signed discovery metadata without
  // calling the membership/write-gated channel-details capability.
  if (channel?.readOnly)
    return (
      <section aria-label="General access" className={styles.generalAccess}>
        <h3 className={`${styles.groupHeading} pb-2 text-caption text-subtle`}>
          General
        </h3>
        <div className={styles.accessRow}>
          <span className={styles.accessIcon} aria-hidden="true">
            <Avatar
              alt=""
              fallback=""
              fallbackContent={<Icon size={24} />}
              shape="squircle"
            />
          </span>
          <div className={styles.accessAudience}>
            <p className="text-body-sm">
              {channel.visibility === "public"
                ? "Anyone in the community can read."
                : channel.visibility === "private"
                  ? `Only ${place} members can read.`
                  : "Reading access could not be confirmed."}
            </p>
            <p className="text-caption text-subtle">
              {channel.viewerRole === "guest" || channel.joinRole === "guest"
                ? "Viewing only. Ask an owner or admin to participate."
                : channel.joinRole === "member"
                  ? "New people can participate. People already in the channel keep their access."
                  : "New people’s access could not be confirmed."}
            </p>
          </div>
        </div>
      </section>
    );
  return (
    <ChannelGeneralAccessEditor
      capability={capability}
      recovery={recovery}
      channelId={channelId}
      mayHaveGuestMembers={mayHaveGuestMembers}
      autoJoin={channel?.autoJoin ?? false}
    />
  );
}

function ChannelGeneralAccessEditor({
  capability,
  recovery,
  channelId,
  mayHaveGuestMembers,
  autoJoin,
}: {
  capability: ChannelDetailsCapability;
  recovery: RelayRecovery | undefined;
  channelId: string;
  mayHaveGuestMembers: boolean;
  autoJoin: boolean;
}) {
  const attempt = useSyncExternalStore(capability.subscribe, () =>
    capability.snapshot(channelId),
  );
  const [base, setBase] = useState<ChannelDetails>();
  const [choice, setChoice] = useState<ChannelDetailsDraft>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const lifetime = useRef<AbortController | undefined>(undefined);
  const busy = useRef(false);
  const origin = useRef<HTMLElement | null>(null);
  const section = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const reauthorized = useReauthorizedRetry(recovery, () => {
    const signal = lifetime.current?.signal;
    if (signal && !signal.aborted) void load(signal);
  });
  const load = useCallback(
    async (signal: AbortSignal) => {
      const failed = reauthorized.begin();
      setLoading(true);
      setError("");
      try {
        const details = await capability.load(channelId, signal);
        if (!signal.aborted) {
          setBase(details);
          return details;
        }
      } catch (reason) {
        if (!signal.aborted) {
          setBase(undefined);
          setError(reason instanceof Error ? reason.message : String(reason));
          failed(reason);
        }
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [capability, channelId, reauthorized],
  );
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setBase(undefined);
    setChoice(undefined);
    setPending(false);
    setStatus("");
    busy.current = false;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const locked = loading || pending || !!attempt || !base?.canEdit;
  const solo = soloLabels(base?.labels);
  const place = solo ? "chat" : "channel";
  const access = base ? generalAccessValue(base) : "";
  const Icon =
    access === "public"
      ? GlobeIcon
      : access === "view-only"
        ? EyeIcon
        : LockIcon;
  async function choose(value: string) {
    if (locked || !base) return;
    const option = Object.values(generalAccessOptions).find(
      (option) => option.value === value,
    );
    if (value === access || !option || (solo && value === "public")) return;
    origin.current =
      section.current?.querySelector<HTMLElement>('[role="combobox"]') ?? null;
    setError("");
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    // The title or access may have changed since this dialog opened. Consent
    // starts from a fresh signed snapshot; save still verifies its version.
    const current = await load(signal);
    if (
      signal.aborted ||
      !current?.canEdit ||
      generalAccessValue(current) === value ||
      (soloLabels(current.labels) && value === "public")
    )
      return;
    setChoice({
      ...current,
      ...generalAccessPolicy(option.value, current.joinRole),
    });
  }
  async function apply(check = false) {
    const controller = lifetime.current;
    if (
      !controller ||
      busy.current ||
      (check ? attempt?.status !== "unconfirmed" : !base || !choice || locked)
    )
      return;
    if (check) section.current?.focus();
    busy.current = true;
    setPending(true);
    setStatus(check ? "Checking save status…" : "Saving access…");
    setError("");
    // The choices lock while saving; keep keyboard focus in the access region.
    origin.current = section.current;
    setChoice(undefined);
    try {
      if (check) await capability.check(channelId, controller.signal);
      else if (base && choice)
        await capability.save(base, choice, controller.signal);
      if (!controller.signal.aborted) {
        setStatus("Access updated");
        await load(controller.signal);
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        setStatus("");
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (!controller.signal.aborted) {
        busy.current = false;
        setPending(false);
      }
    }
  }
  return (
    <>
      <section
        ref={section}
        aria-label="General access"
        tabIndex={-1}
        className={styles.generalAccess}
      >
        <h3 className={`${styles.groupHeading} pb-2 text-caption text-subtle`}>
          General
        </h3>
        <div className={styles.accessControl}>
          <div className={styles.accessIdentity}>
            <span className={styles.accessIcon} aria-hidden="true">
              <Avatar
                alt=""
                fallback=""
                fallbackContent={
                  pending ? (
                    <CircleNotchIcon
                      size={24}
                      className="motion-safe:animate-spin"
                    />
                  ) : (
                    <Icon size={24} />
                  )
                }
                shape="squircle"
              />
            </span>
            <div className={styles.accessSummary}>
              <p className="text-body-sm">
                {access === "private"
                  ? "Only people you add"
                  : access
                    ? "Anyone in the community"
                    : "General access"}
              </p>
              <p className="text-caption text-subtle">
                {access === "public"
                  ? "New people can participate."
                  : access === "view-only"
                    ? "New people can only view."
                    : access === "private"
                      ? "Existing members keep their access."
                      : loading
                        ? "Checking current access…"
                        : "Current access could not be confirmed."}
              </p>
            </div>
          </div>
          <div className={styles.accessAudience} aria-busy={loading || pending}>
            <Select
              variant="compact"
              align="end"
              size="sm"
              label="General access"
              value={access}
              valueLabel={
                solo && access === "public" ? "Public (existing)" : undefined
              }
              placeholder={loading ? "Loading access…" : "Access unavailable"}
              disabled={locked}
              groups={[
                {
                  label: "",
                  options: [
                    {
                      ...generalAccessOptions.public,
                      leading: <GlobeIcon size={20} />,
                    },
                    {
                      ...generalAccessOptions["view-only"],
                      leading: <EyeIcon size={20} />,
                    },
                  ].filter((option) => !solo || option.value !== "public"),
                },
                {
                  label: "",
                  separator: true,
                  options: [
                    {
                      ...generalAccessOptions.private,
                      leading: <LockIcon size={20} />,
                    },
                  ],
                },
              ]}
              onValueChange={choose}
            />
          </div>
        </div>
        {choice && base && (
          <AlertDialog
            title="Change general access?"
            description={[
              solo && choice.visibility === "public"
                ? SOLO_ACCESS_DISCLOSURE
                : choice.visibility !== base.visibility
                  ? solo
                    ? "Only chat members will have access."
                    : privacyConsequence(choice.visibility)
                  : "",
              solo && choice.visibility === "private"
                ? soloRetainedAccessWarning(base, mayHaveGuestMembers)
                : "",
              solo &&
              access === "public" &&
              choice.visibility === "public" &&
              choice.joinRole === "guest"
                ? "People already in the chat keep their access."
                : "",
              // The relay keeps the flag but refuses changing it on a private channel.
              choice.visibility === "private" && autoJoin
                ? "It’s a starter channel, so new members will be added to it again if it’s made public. To stop that, turn off Starter channel for new members in Settings first."
                : "",
              !solo && choice.visibility === "public"
                ? `New people will ${choice.joinRole === "guest" ? "only be able to view" : "be able to participate"}. People already in the ${place} keep their access.`
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClose={() => setChoice(undefined)}
            initialFocus={cancel}
            finalFocus={origin}
            actions={
              <>
                <Button ref={cancel} onClick={() => setChoice(undefined)}>
                  Cancel
                </Button>
                <Button
                  variant="prominent"
                  disabled={locked}
                  onClick={() => void apply()}
                >
                  Change access
                </Button>
              </>
            }
          />
        )}
        <p role="status" aria-atomic="true" className="sr-only">
          {status}
        </p>
      </section>
      {(error || attempt?.status === "unconfirmed") && (
        <fieldset
          aria-label="General access recovery"
          className={styles.accessFeedback}
        >
          {error && (
            <p role="alert" className="text-body-sm text-danger">
              {error}
            </p>
          )}
          {attempt?.status === "unconfirmed" ? (
            <>
              <p role="status" className="text-body-sm">
                The change may have been saved. Check its status before trying
                again. Checking never resends it.
              </p>
              <Button
                disabled={loading || pending}
                onClick={() => void apply(true)}
              >
                Check save status
              </Button>
            </>
          ) : (
            error && (
              <Button
                disabled={loading || pending}
                onClick={() => {
                  section.current?.focus();
                  if (lifetime.current) void load(lifetime.current.signal);
                }}
              >
                Reload access
              </Button>
            )
          )}
        </fieldset>
      )}
    </>
  );
}
