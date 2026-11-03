import { RenameSidebarSection } from "./RenameSidebarSection";
import { SidebarActiveDialog, activeWindowLabel } from "./SidebarActiveDialog";
import { FadingLabel } from "./FadingLabel";
import {
  useId,
  useRef,
  useState,
  type DOMAttributes,
  type ReactNode,
  type Ref,
} from "react";
import {
  MenuGroup,
  MenuGroupLabel,
  MenuIcon,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSeparator,
  MenuSubmenu,
  MenuSubmenuPopup,
  MenuSubmenuTrigger,
  MenuTrigger,
  MenuTrailing,
} from "../../shared/design-system/ui/Menu";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ArrowsDownUpIcon,
  CaretDownIcon,
  ChatsCircleIcon,
  ChatUnreadIcon,
  DotsThreeIcon,
  Filter2Icon,
  PencilSimpleIcon,
  PlusIcon,
  TextAaIcon,
  TimerIcon,
  TrashIcon,
} from "../../shared/design-system/icons";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Button } from "../../shared/design-system/ui/Button";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { SidebarSortMode } from "../../features/relay/sidebar-sort";
import type { SidebarFilter } from "./useSidebarFilters";
import { SidebarGroupIcon } from "./SidebarGroupIcon";
import { SidebarStarIcon } from "./SidebarStarIcon";
import { ChannelSidebarMenuItem } from "./ChannelSidebarMenuItem";
import styles from "./Channels.module.css";

export function SidebarSection({
  sectionKey,
  title,
  hideTitle = false,
  icon,
  session,
  open,
  onToggle,
  headerActions,
  headerNotice,
  hideMoreActions = false,
  persistentChevron = false,
  createChannel,
  createSection,
  newMessage,
  sort,
  filter,
  channels,
  dropRef,
  dropTarget = false,
  dropEdge,
  dragHandle,
  dragging = false,
  move,
  onRemove,
  onRename,
  channelCount,
  removalFocus,
  children,
}: {
  sectionKey: string;
  title: string;
  hideTitle?: boolean;
  icon?: ReactNode;
  session?: RelaySession | undefined;
  open: boolean;
  onToggle: (open: boolean) => void;
  headerActions?: ReactNode;
  headerNotice?: ReactNode;
  onRemove?: (() => unknown) | undefined;
  onRename?: ((name: string) => unknown) | undefined;
  hideMoreActions?: boolean;
  /** Keep the disclosure affordance visible instead of revealing it on hover. */
  persistentChevron?: boolean;
  channelCount?: number | undefined;
  removalFocus?: (() => HTMLElement | null | undefined) | undefined;
  createChannel?:
    | { available: boolean; open: (trigger: HTMLButtonElement) => void }
    | undefined;
  newMessage?: (() => void) | undefined;
  createSection?:
    | { available: boolean; open: (trigger: HTMLButtonElement) => void }
    | undefined;
  sort?:
    | {
        value: SidebarSortMode;
        modes?: readonly { id: SidebarSortMode; label: string }[];
        change: (mode: SidebarSortMode) => void;
      }
    | undefined;
  filter?:
    | {
        value: SidebarFilter;
        disabled?: boolean;
        activeWindowSeconds?: number | undefined;
        change: (mode: SidebarFilter, seconds?: number) => unknown;
        dismissError?: () => void;
      }
    | undefined;
  channels?:
    | {
        rows: readonly ChannelSummary[];
        selected?: string | undefined;
        select: (id: string) => void;
      }
    | undefined;
  dropRef?: Ref<HTMLDivElement> | undefined;
  dropTarget?: boolean;
  /** Where a dragged group would land relative to this one. */
  dropEdge?: "before" | "after" | undefined;
  dragHandle?:
    | {
        ref: Ref<HTMLElement>;
        listeners?: DOMAttributes<HTMLElement> | undefined;
      }
    | undefined;
  dragging?: boolean;
  /** Single-pointer and keyboard reordering; an absent direction is disabled. */
  move?:
    | { up?: (() => void) | undefined; down?: (() => void) | undefined }
    | undefined;
  children: ReactNode;
}) {
  const id = useId();
  const cancelRemove = useRef<HTMLButtonElement>(null);
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [activeOpen, setActiveOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const canRemove = !!onRemove && sectionKey.startsWith("group:");
  const canRename = !!onRename && sectionKey.startsWith("group:");
  const remove = async () => {
    if (!onRemove || removing) return;
    setRemoving(true);
    setRemoveError("");
    try {
      await onRemove();
      setRemoveOpen(false);
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : String(error));
    } finally {
      setRemoving(false);
    }
  };
  if (hideTitle)
    return (
      <div className={`${styles.channelSection} ${styles.untitledSection}`}>
        {headerNotice}
        <div
          id={id}
          className={`${styles.sectionContent} ${styles.untitledSectionContent}`}
        >
          <div>{children}</div>
        </div>
        <div className={styles.sectionActions}>
          {headerActions}
          {newMessage && (
            <IconButton
              hint="familiar"
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
        </div>
      </div>
    );
  return (
    <div
      ref={dropRef}
      className={styles.channelSection}
      data-sidebar-section={sectionKey}
      data-drop-target={dropTarget || undefined}
      data-drop-edge={dropEdge}
      data-section-dragging={dragging || undefined}
      data-menu-open={menuOpen || undefined}
      data-persistent-chevron={persistentChevron || undefined}
    >
      <div className={styles.sectionHeader}>
        <details open={open}>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: summary has native keyboard activation. */}
          <summary
            ref={dragHandle?.ref}
            {...dragHandle?.listeners}
            aria-label={title}
            aria-controls={id}
            onClick={(event) => {
              event.preventDefault();
              onToggle(!open);
            }}
          >
            <span className={styles.sectionLabel}>
              {sectionKey === "starred" ? (
                <SidebarStarIcon />
              ) : typeof icon === "string" && session ? (
                <SidebarGroupIcon icon={icon} session={session} />
              ) : (
                icon
              )}
              <FadingLabel
                className={`${styles.sectionTitle} ${
                  persistentChevron ? styles.scopeSectionTitle : ""
                }`}
              >
                {title}
              </FadingLabel>
            </span>
            <span className={`${styles.sidebarIcon} ${styles.sectionChevron}`}>
              <CaretDownIcon strokeWidth={2.5} size={15} />
            </span>
          </summary>
        </details>
        <div className={styles.sectionActions}>
          <MenuRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <MenuTrigger
              ref={actionsTrigger}
              render={(props) => (
                <IconButton
                  {...props}
                  hidden={hideMoreActions}
                  size="compact"
                  aria-label={`More actions for ${title}`}
                  icon={<DotsThreeIcon strokeWidth={2.5} size={15} />}
                />
              )}
            />
            <MenuPopup align="end" aria-label={`More actions for ${title}`}>
              {filter && (
                <MenuSubmenu>
                  <MenuSubmenuTrigger>
                    <MenuIcon>
                      <Filter2Icon size={14} />
                    </MenuIcon>
                    Filter
                  </MenuSubmenuTrigger>
                  <MenuSubmenuPopup
                    aria-label={`Filter ${title}`}
                    finalFocus={false}
                  >
                    <MenuRadioGroup
                      value={filter.value}
                      onValueChange={(mode) => {
                        if (mode === "active") return;
                        void Promise.resolve(
                          filter.change(mode as SidebarFilter),
                        ).catch(() => {});
                        setMenuOpen(false);
                      }}
                    >
                      <MenuRadioItem
                        disabled={filter.disabled}
                        closeOnClick={false}
                        value="all"
                      >
                        <MenuIcon>
                          <ChatsCircleIcon size={14} />
                        </MenuIcon>
                        All
                      </MenuRadioItem>
                      <MenuRadioItem
                        disabled={filter.disabled}
                        closeOnClick={false}
                        value="unreads"
                      >
                        <MenuIcon>
                          <ChatUnreadIcon size={14} />
                        </MenuIcon>
                        Unreads
                      </MenuRadioItem>
                      <MenuRadioItem
                        disabled={filter.disabled}
                        closeOnClick={false}
                        value="active"
                        onClick={() => {
                          setMenuOpen(false);
                          setActiveOpen(true);
                        }}
                      >
                        <MenuIcon>
                          <TimerIcon size={14} />
                        </MenuIcon>
                        Active in the last
                        {filter.value === "active" && (
                          <MenuTrailing>
                            {activeWindowLabel(filter.activeWindowSeconds)}
                          </MenuTrailing>
                        )}
                      </MenuRadioItem>
                    </MenuRadioGroup>
                    {channels &&
                      filter.value !== "all" &&
                      channels.rows.length > 0 && (
                        <>
                          <MenuSeparator />
                          <MenuGroup>
                            <MenuGroupLabel emphasis="quiet">
                              {filter.value === "unreads"
                                ? "No unread messages"
                                : `No activity in the last ${activeWindowLabel(filter.activeWindowSeconds)}`}
                            </MenuGroupLabel>
                            {channels.rows.map((channel) => {
                              const select = () => {
                                onToggle(true);
                                channels.select(channel.id);
                                setMenuOpen(false);
                              };
                              return session ? (
                                <ChannelSidebarMenuItem
                                  key={channel.id}
                                  channel={channel}
                                  session={session}
                                  selected={channels.selected === channel.id}
                                  onSelect={select}
                                />
                              ) : (
                                <MenuItem
                                  key={channel.id}
                                  aria-current={
                                    channels.selected === channel.id
                                      ? "page"
                                      : undefined
                                  }
                                  onClick={select}
                                >
                                  {channel.name}
                                </MenuItem>
                              );
                            })}
                          </MenuGroup>
                        </>
                      )}
                  </MenuSubmenuPopup>
                </MenuSubmenu>
              )}
              {sort && (
                <MenuSubmenu>
                  <MenuSubmenuTrigger>
                    <MenuIcon>
                      <ArrowsDownUpIcon size={14} />
                    </MenuIcon>
                    Sort
                  </MenuSubmenuTrigger>
                  <MenuSubmenuPopup
                    aria-label={`Sort ${title}`}
                    finalFocus={false}
                  >
                    <MenuRadioGroup
                      value={sort.value}
                      onValueChange={(mode) => {
                        sort.change(mode as SidebarSortMode);
                        setMenuOpen(false);
                      }}
                    >
                      <MenuRadioItem closeOnClick={false} value="recent">
                        <MenuIcon>
                          <TimerIcon size={14} />
                        </MenuIcon>
                        Recent
                      </MenuRadioItem>
                      <MenuRadioItem closeOnClick={false} value="alpha">
                        <MenuIcon>
                          <TextAaIcon size={14} />
                        </MenuIcon>
                        A–Z
                      </MenuRadioItem>
                      {sort.modes?.map((mode) => (
                        <MenuRadioItem
                          key={mode.id}
                          closeOnClick={false}
                          value={mode.id}
                        >
                          <MenuIcon>{null}</MenuIcon>
                          {mode.label}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuSubmenuPopup>
                </MenuSubmenu>
              )}
              {createSection && (
                <>
                  {(filter || sort) && <MenuSeparator />}
                  <MenuItem
                    disabled={!createSection.available}
                    onClick={() => {
                      setMenuOpen(false);
                      if (actionsTrigger.current)
                        createSection.open(actionsTrigger.current);
                    }}
                  >
                    <MenuIcon>
                      <PlusIcon size={14} />
                    </MenuIcon>
                    Create section
                  </MenuItem>
                </>
              )}
              {move && (
                <>
                  <MenuItem
                    disabled={!move.up}
                    onClick={() => {
                      move.up?.();
                      setMenuOpen(false);
                    }}
                  >
                    <MenuIcon>
                      <ArrowUpIcon size={14} />
                    </MenuIcon>
                    Move up
                  </MenuItem>
                  <MenuItem
                    disabled={!move.down}
                    onClick={() => {
                      move.down?.();
                      setMenuOpen(false);
                    }}
                  >
                    <MenuIcon>
                      <ArrowDownIcon size={14} />
                    </MenuIcon>
                    Move down
                  </MenuItem>
                </>
              )}
              {canRename && (
                <MenuItem
                  onClick={() => {
                    setMenuOpen(false);
                    setRenameOpen(true);
                  }}
                >
                  <MenuIcon>
                    <PencilSimpleIcon size={14} />
                  </MenuIcon>
                  Rename section
                </MenuItem>
              )}
              {canRemove && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    tone="danger"
                    onClick={() => {
                      setRemoveError("");
                      setMenuOpen(false);
                      setRemoveOpen(true);
                    }}
                  >
                    <MenuIcon>
                      <TrashIcon size={14} />
                    </MenuIcon>
                    Remove section
                  </MenuItem>
                </>
              )}
            </MenuPopup>
          </MenuRoot>
          {headerActions}
          {newMessage && (
            <IconButton
              hint="familiar"
              size="compact"
              aria-label="New message"
              title="New message"
              onClick={newMessage}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
          {activeOpen && filter && (
            <SidebarActiveDialog
              seconds={filter.activeWindowSeconds}
              apply={(seconds) => filter.change("active", seconds)}
              close={() => {
                filter.dismissError?.();
                setActiveOpen(false);
              }}
              finalFocus={actionsTrigger}
            />
          )}
          {renameOpen && onRename && (
            <RenameSidebarSection
              title={title}
              rename={onRename}
              close={() => setRenameOpen(false)}
              finalFocus={actionsTrigger}
            />
          )}
          {canRemove && (
            <Dialog
              size="compact"
              open={removeOpen}
              onOpenChange={setRemoveOpen}
              dismissOnOutsideClick
              preventClose={removing}
              initialFocus={cancelRemove}
              finalFocus={() =>
                actionsTrigger.current?.isConnected
                  ? actionsTrigger.current
                  : (removalFocus?.() ?? false)
              }
              title={`Remove ${title}?`}
              description={`${channelCount === undefined ? "Assigned channels" : `${channelCount} ${channelCount === 1 ? "channel" : "channels"}`} will move back to Channels. This does not delete any channels.`}
              actions={
                <>
                  <Button
                    ref={cancelRemove}
                    type="button"
                    disabled={removing}
                    onClick={() => setRemoveOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    loading={removing}
                    onClick={() => void remove()}
                  >
                    Remove section
                  </Button>
                </>
              }
            >
              {removeError && <p role="alert">{removeError}</p>}
              {removing && (
                <p role="status" className="sr-only">
                  Removing section and waiting for confirmation…
                </p>
              )}
            </Dialog>
          )}
          {createChannel && (
            <IconButton
              size="compact"
              aria-label="Create channel"
              title={
                createChannel.available
                  ? "Create channel"
                  : "Channel creation unavailable"
              }
              disabled={!createChannel.available}
              onClick={(event) => createChannel.open(event.currentTarget)}
              icon={<PlusIcon strokeWidth={2.5} size={15} />}
            />
          )}
        </div>
      </div>
      {headerNotice}
      <div
        id={id}
        className={styles.sectionContent}
        inert={!open}
        hidden={!open}
      >
        <div>{children}</div>
      </div>
    </div>
  );
}
