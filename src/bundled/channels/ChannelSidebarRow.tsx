import { FadingLabel } from "./FadingLabel";
import { activeChannelRows } from "../../features/channel-navigation/active-channel-rows";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { BellSlashIcon, XIcon } from "../../shared/design-system/icons/index";
import { useIsPresent } from "motion/react";
import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import type { ChannelSummary } from "../../features/relay/contracts";
import styles from "./ChannelSidebarRow.module.css";

export function ChannelSidebarRow({
  channel,
  icon,
  nameAccessory,
  badge,
  working = false,
  ordinary = false,
  muted = false,
  dmVisualSpacing = false,
  wrapSelect,
  selected,
  presenceDescription,
  onSelect,
  onPrepare,
  onHideDm,
}: {
  channel: ChannelSummary;
  icon: ReactNode;
  nameAccessory?: ReactNode;
  badge?: ReactNode;
  /** Agents are working here; the badge reserves its own trailing space. */
  working?: boolean;
  /** Ordinary unread backlog emphasises the label. */
  ordinary?: boolean;
  muted?: boolean;
  dmVisualSpacing?: boolean;
  wrapSelect?: ((trigger: ReactElement) => ReactNode) | undefined;
  selected?: string | undefined;
  presenceDescription?: string | undefined;
  onSelect: (id: string) => void;
  onPrepare: (id: string) => void;
  onHideDm?: (id: string) => void;
}) {
  const selectRef = useRef<HTMLButtonElement>(null);
  const present = useIsPresent();
  useLayoutEffect(() => {
    const button = selectRef.current;
    if (!button || !present) return;
    const document = button.ownerDocument;
    const section = button.closest("[data-sidebar-section]");
    const sidebar = section?.closest("nav");
    return () => {
      if (document.activeElement !== button) return;
      const rows = [
        ...(section?.querySelectorAll<HTMLElement>("button[data-channel-id]") ??
          []),
      ];
      const index = rows.indexOf(button);
      const neighborIds = [
        ...rows.slice(index + 1),
        ...rows.slice(0, index).reverse(),
      ].map((row) => row.dataset.channelId ?? "");
      // A plugin wrapper can remount this row and its neighbors. Resolve them
      // after the commit, excluding retained exits and focus moved elsewhere.
      queueMicrotask(() => {
        if (
          (document.activeElement !== document.body &&
            document.activeElement !== button) ||
          (button.isConnected && !button.closest("[inert]")) ||
          !sidebar?.isConnected
        )
          return;
        const liveRows = activeChannelRows(sidebar);
        const sectionRows = activeChannelRows(section);
        const candidates = [
          liveRows.find((row) => row.dataset.channelId === channel.id),
          ...neighborIds.map((id) =>
            sectionRows.find((row) => row.dataset.channelId === id),
          ),
          section?.querySelector<HTMLElement>("details > summary"),
        ];
        for (const candidate of candidates) {
          if (!candidate?.isConnected || candidate.closest("[hidden], [inert]"))
            continue;
          candidate.focus();
          if (document.activeElement === candidate) break;
        }
      });
    };
  }, [channel.id, present]);
  const presenceId = useId();
  const selectButton = (
    <NavigationItem
      ref={selectRef}
      type="button"
      data-channel-id={channel.id}
      data-working={working || undefined}
      aria-current={selected === channel.id ? "page" : undefined}
      aria-describedby={presenceDescription ? presenceId : undefined}
      onPointerEnter={() => onPrepare(channel.id)}
      onFocus={() => onPrepare(channel.id)}
      onClick={() => onSelect(channel.id)}
      selected={selected === channel.id}
      label={
        <span
          className={styles.nameContent}
          data-name-accessory={muted || nameAccessory ? "" : undefined}
        >
          <FadingLabel className={styles.label}>{channel.name}</FadingLabel>
          {muted && (
            <span className={styles.muted} role="img" aria-label="Muted">
              <BellSlashIcon size={14} />
            </span>
          )}
          {nameAccessory}
        </span>
      }
      icon={
        <span
          className={styles.iconSpace}
          data-dm-visual={dmVisualSpacing || undefined}
        >
          {icon}
        </span>
      }
      trailing={
        badge && (
          <span className={styles.badges} data-working={working || undefined}>
            {badge}
          </span>
        )
      }
    />
  );
  return (
    <div
      className={styles.row}
      data-channel-sidebar-row=""
      data-ordinary={ordinary || undefined}
      data-selected={selected === channel.id || undefined}
    >
      <div className={styles.select}>
        {wrapSelect ? wrapSelect(selectButton) : selectButton}
        {presenceDescription && (
          <span className="sr-only" id={presenceId}>
            {presenceDescription}
          </span>
        )}
      </div>
      {channel.channelType === "dm" && onHideDm && (
        <span className={`${styles.more} ${styles.remove}`}>
          <IconButton
            type="button"
            size="compact"
            aria-label={`Remove ${channel.name} from DMs`}
            onClick={(event) => {
              const section = event.currentTarget.closest(
                "[data-sidebar-section]",
              );
              const rows = activeChannelRows(section);
              const index = rows.findIndex(
                (row) => row.dataset.channelId === channel.id,
              );
              const otherSection = [
                ...(section?.parentElement?.querySelectorAll<HTMLElement>(
                  "details > summary",
                ) ?? []),
              ].find((summary) => summary.parentElement !== section);
              (rows[index + 1] ?? rows[index - 1] ?? otherSection)?.focus();
              onHideDm(channel.id);
            }}
            icon={<XIcon size={15} aria-hidden="true" />}
          />
        </span>
      )}
    </div>
  );
}
