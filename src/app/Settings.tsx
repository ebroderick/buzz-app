import type {
  AdminAccessReader,
  AdminAccessState,
} from "../bundled/admin-access";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type HTMLMotionProps,
} from "motion/react";
import { SidebarNavigation } from "../shared/design-system/ui/SidebarNavigation";
import { CommunityAddress } from "./CommunityAddress";
import type { Agents } from "../features/agents/service";
import type { DecisionsService } from "../features/decisions/service";
import { DecisionsSettings } from "./DecisionsSettings";
import { Header, InlineHeader } from "../shared/design-system/ui/Header";
import { ToastNotice } from "../shared/design-system/ui/Toast";
import { Panel } from "../shared/design-system/ui/Panel";
import { NavigationItem } from "../shared/design-system/ui/NavigationItem";
import { NavigationSection } from "../shared/design-system/ui/NavigationSection";
import { Button } from "../shared/design-system/ui/Button";
import { PluginMenu } from "./PluginMenu";
import { Tooltip } from "../shared/design-system/ui/Tooltip";
import { SurfaceButton } from "../shared/design-system/ui/SurfaceButton";
import { IconButton } from "../shared/design-system/ui/IconButton";
import { ChoiceRow } from "../shared/design-system/ui/ChoiceRow";
import { SettingsGroup } from "../shared/design-system/ui/SettingsGroup";
import { Tabs } from "../shared/design-system/ui/Tabs";
import { SearchField } from "../shared/design-system/ui/SearchField";
import { EmptyState } from "../shared/design-system/ui/EmptyState";
import {
  type ReactNode,
  forwardRef,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { RecoveryScreen } from "./RecoveryScreen";
import styles from "./Settings.module.css";
import {
  CheckCircleIcon,
  SparklesIcon,
  SquaresFourIcon,
  SidebarRightIcon,
} from "../shared/design-system/icons/index";
import { canRetryPlugin, type PluginManager } from "../plugins/manager";
import type { Catalog, PluginInfo } from "../plugins/types";
import type { Communities, Membership } from "../features/communities/service";
import { PluginImport } from "./PluginImport";
import { ManagedPluginUpdate, ManagedPlugins } from "./ManagedPlugins";
import { managedBy, pendingManaged } from "../plugins/managed";
import { RecommendationCount } from "./RecommendationCount";
import type { PluginInstallRequests } from "../plugins/installer";
import { PluginReadme } from "./PluginReadme";
import { bundledReadmes } from "../bundled/readmes";
import { bundledIcons } from "../bundled/icons";
import type { Identity } from "../features/identity/service";
import { ProfileSettings } from "./ProfileSettings";
import { IdentitySettings, keyActivity } from "./IdentitySettings";
import type { FederatedIdentity } from "../features/federated-identity/service";
import { CommunityLocalSettings } from "./CommunityLocalSettings";

import type { Appearance } from "../shared/theme/service";
import { AppearanceSettings } from "./AppearanceSettings";
import { NotificationSettings } from "./NotificationSettings";
import type { NotificationsService } from "../features/notifications/service";
import type { ShortcutsService } from "../features/shortcuts/service";
import type { ShortcutBindings } from "../features/shortcuts/preferences";
import { ShortcutSettings } from "./ShortcutSettings";
import { DeveloperSettings } from "./DeveloperSettings";
import { AgentSettings } from "./AgentSettings";
import type { SettingsCards } from "../features/settings/service";
import { OwnedContribution } from "../plugins/OwnedContribution";
import type { Updates } from "../features/updates/updates";
import { UpdateSettings } from "../features/updates/UpdateSettings";
import { CommunityDepartureSettings } from "./CommunityDepartureSettings";
import { developerMode, settingsSections } from "./settings-sections";

import { pluginCategoryDefinitions } from "./plugin-categories";

// Exit animations retain DOM briefly; retired results must stop accepting focus.
const PluginListEntry = forwardRef<HTMLDivElement, HTMLMotionProps<"div">>(
  function PluginListEntry(props, ref) {
    const present = useIsPresent();
    return (
      <motion.div
        {...props}
        ref={ref}
        inert={!present}
        aria-hidden={!present || undefined}
      />
    );
  },
);

function CorePluginGroup({ children }: { children: ReactNode }) {
  return (
    <div className={styles.pluginCoreGrid}>
      <SettingsGroup layout="cards">{children}</SettingsGroup>
    </div>
  );
}

function isCorePlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.discovery?.tags?.some(
      (tag) => tag.trim().toLowerCase() === "core",
    ) ??
      false)
  );
}

function isRequiredPlugin(plugin: PluginInfo) {
  return plugin.manifest.id === "buzz.channels";
}

function isEssentialPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.discovery?.tags?.some(
      (tag) => tag.trim().toLowerCase() === "essentials",
    ) ??
      false)
  );
}

function comparePlugins(a: PluginInfo, b: PluginInfo) {
  return (
    Number(isRequiredPlugin(b)) - Number(isRequiredPlugin(a)) ||
    Number(isEssentialPlugin(b)) - Number(isEssentialPlugin(a)) ||
    a.manifest.name.localeCompare(b.manifest.name)
  );
}

function groupPlugins(plugins: readonly PluginInfo[]) {
  const known = new Map<string, PluginInfo[]>(
    pluginCategoryDefinitions.map(({ id }) => [id, []]),
  );
  const other: PluginInfo[] = [];
  const core: PluginInfo[] = [];
  for (const plugin of plugins) {
    if (isCorePlugin(plugin)) {
      core.push(plugin);
      continue;
    }
    const group = known.get(plugin.manifest.discovery?.category ?? "");
    (group ?? other).push(plugin);
  }
  for (const entries of known.values()) entries.sort(comparePlugins);
  other.sort(comparePlugins);
  return [
    ...(core.length
      ? [
          {
            id: "core",
            plugins: core.sort(comparePlugins),
          },
        ]
      : []),
    ...pluginCategoryDefinitions.flatMap(({ id, label }) => {
      const entries = known.get(id) ?? [];
      return entries.length ? [{ id, label, plugins: entries }] : [];
    }),
    ...(other.length ? [{ id: "other", label: "Other", plugins: other }] : []),
  ];
}

function PluginIcon({
  plugin,
  size = 24,
}: {
  plugin: PluginInfo;
  size?: number;
}) {
  const url =
    plugin.source === "bundled"
      ? bundledIcons.get(plugin.manifest.id)
      : undefined;
  const [failedUrl, setFailedUrl] = useState<string>();
  return (
    <span
      className={styles.pluginIcon}
      data-branded={Boolean(url && url !== failedUrl) || undefined}
      data-category={plugin.manifest.discovery?.category}
      aria-hidden="true"
    >
      {url && url !== failedUrl ? (
        <img src={url} alt="" onError={() => setFailedUrl(url)} />
      ) : (
        <SquaresFourIcon size={size} />
      )}
    </span>
  );
}

function PluginProvenance({
  source,
  publisher,
  managedBy,
  className,
}: {
  source: "bundled" | "external";
  publisher?: string | null | undefined;
  managedBy?: string | undefined;
  className?: string | undefined;
}) {
  const label = [
    source === "bundled" ? "Buzz" : publisher,
    managedBy && `Managed by ${managedBy}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (!label) return null;
  return (
    <span className={`${styles.pluginProvenance} ${className ?? ""}`}>
      <span>{label}</span>
    </span>
  );
}

const noAccessSubscription = () => () => {};
const noInstallRequest = () => undefined;

function restrictedPlugin(plugin: PluginInfo) {
  return (
    plugin.source === "bundled" &&
    (plugin.manifest.id === "buzz.moderation" ||
      plugin.manifest.id === "buzz.relay-staff")
  );
}

function pluginActionLabel(plugin: PluginInfo, access: AdminAccessState) {
  if (plugin.enabled) return "Disable";
  if (restrictedPlugin(plugin) && access !== "allowed")
    return access === "checking" ? "Enable" : "Unavailable";
  return "Enable";
}

function accessMessage(plugin: PluginInfo, state: AdminAccessState) {
  switch (state) {
    case "allowed":
      return null;
    case "checking":
      return "Checking access…";
    case "no-community":
      return "Select a community to check access.";
    case "error":
      return "Could not check access. Open details to try again.";
    case "unavailable":
      return "Access is unavailable in this build or on this relay.";
    case "denied":
      return plugin.manifest.id === "buzz.moderation"
        ? "Select a community where you’re an owner or admin."
        : "Select a community on a relay where you have staff access.";
  }
}

/** Narrow containers cover the catalog with details (Settings.module.css). */
function covered(element: Element | null) {
  return !!element && getComputedStyle(element).visibility === "hidden";
}

function scrollport(element: Element) {
  for (let node = element.parentElement; node; node = node.parentElement)
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  return null;
}

function pluginToggleDisabled(
  plugin: PluginInfo,
  access: AdminAccessState,
  busy: boolean,
) {
  return (
    busy ||
    (!plugin.enabled && restrictedPlugin(plugin) && access !== "allowed")
  );
}

function PluginDetails({
  plugin,
  managed,
  failure,
  retryable,
  busy,
  plugins,
  onToggle,
  close,
  onClose,
  access,
  onCheckAccess,
  catalog,
  authorizeGit,
  onUpdateAvailableChange,
  reviewRequested,
  onReviewHandled,
  initialUpdateAvailable,
  holdReview,
}: {
  plugin: PluginInfo;
  managed?: ReturnType<typeof managedBy>;
  failure: string | null;
  retryable: boolean;
  busy: boolean;
  plugins: PluginManager;
  onToggle(): void;
  close: RefObject<HTMLButtonElement | null>;
  onClose(): void;
  access: AdminAccessState;
  catalog: Catalog;
  authorizeGit: Parameters<typeof PluginImport>[0]["authorizeGit"];
  onCheckAccess(): void;
  onUpdateAvailableChange(available: boolean): void;
  reviewRequested: boolean;
  onReviewHandled(): void;
  initialUpdateAvailable: boolean;
  holdReview: (() => () => void) | undefined;
}) {
  const accessReason = restrictedPlugin(plugin)
    ? accessMessage(plugin, access)
    : null;
  const [installedStatus, setInstalledStatus] =
    useState<HTMLSpanElement | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [actionTarget, setActionTarget] = useState<HTMLDivElement | null>(null);
  const [primaryActionTarget, setPrimaryActionTarget] =
    useState<HTMLDivElement | null>(null);
  const updateAvailable = initialUpdateAvailable;
  useLayoutEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, [close]);
  // READMEs ship with Buzz; never attach one to an external plugin.
  const readme =
    plugin.source === "bundled" && bundledReadmes.get(plugin.manifest.id);
  const otherTags = (plugin.manifest.discovery?.tags ?? []).filter(
    (tag) =>
      !isEssentialPlugin(plugin) || tag.trim().toLowerCase() !== "essentials",
  );
  return (
    <aside
      id="plugin-details"
      className={styles.pluginAside}
      aria-label={`${plugin.manifest.name} details`}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== "Escape" || event.shiftKey)
          return;
        event.stopPropagation();
        onClose();
      }}
    >
      <div className={styles.pluginAsideHeader}>
        <div className={styles.pluginAsideIdentity}>
          <PluginIcon key={plugin.manifest.id} plugin={plugin} size={48} />
          <h2>{plugin.manifest.name}</h2>
          <div className={styles.pluginBadges}>
            {plugin.source === "bundled" ? (
              <span className={styles.pluginInstallBadge}>
                <CheckCircleIcon size={14} aria-hidden="true" />
                Made by Buzz
              </span>
            ) : (
              <PluginProvenance
                source={plugin.source}
                publisher={plugin.publisher}
              />
            )}
            {isEssentialPlugin(plugin) && (
              <span className={styles.pluginInstallBadge}>
                <SparklesIcon size={14} aria-hidden="true" />
                Essentials
              </span>
            )}
          </div>
          {plugin.manifest.description && (
            <p className={styles.pluginAsideDescription}>
              {plugin.manifest.description}
            </p>
          )}
        </div>
        <IconButton
          ref={close}
          aria-label="Close plugin details"
          size="sm"
          icon={<SidebarRightIcon size={16} aria-hidden="true" />}
          onClick={onClose}
        />
      </div>
      {plugin.source === "external" && (
        <div className={styles.pluginBadges}>
          <span className={styles.pluginInstallBadge}>
            <CheckCircleIcon size={14} aria-hidden="true" />
            Installed
          </span>
          {managed && (
            <span className={styles.pluginInstallBadge}>
              Managed by {managed.source}
            </span>
          )}
          <span
            ref={setInstalledStatus}
            className={styles.pluginInstallBadge}
          />
        </div>
      )}
      <div className={styles.pluginStatus}>
        {plugin.enabled && accessReason && (
          <span className="text-caption text-muted">
            {access === "checking" ? "Checking…" : "Unavailable"}
          </span>
        )}
        <div className={styles.pluginPrimaryActions}>
          <div
            ref={setPrimaryActionTarget}
            className={styles.pluginPrimaryAction}
          >
            {/* Channels is required and has no enable/disable control. */}
            {!updateAvailable &&
              (plugin.manifest.id === "buzz.channels" ? (
                <Button variant="outline" size="sm" disabled>
                  Required
                </Button>
              ) : (
                <Tooltip
                  content={
                    access === "error"
                      ? "Could not check access. Try again."
                      : accessReason
                  }
                  {...(accessReason ? {} : { open: false })}
                  disableHoverablePopup
                >
                  <Button
                    variant={
                      plugin.enabled
                        ? "subtle"
                        : accessReason
                          ? "outline"
                          : "prominent"
                    }
                    size="sm"
                    disabled={pluginToggleDisabled(plugin, access, busy)}
                    loading={
                      !plugin.enabled &&
                      restrictedPlugin(plugin) &&
                      access === "checking"
                    }
                    aria-describedby={
                      accessReason ? "plugin-detail-access" : undefined
                    }
                    focusableWhenDisabled
                    ref={toggle}
                    onClick={onToggle}
                  >
                    {pluginActionLabel(plugin, access)}
                  </Button>
                </Tooltip>
              ))}
          </div>
          <PluginMenu
            plugin={plugin}
            plugins={plugins}
            busy={busy}
            {...(updateAvailable
              ? {
                  toggle: {
                    label: pluginActionLabel(plugin, access),
                    disabled: pluginToggleDisabled(plugin, access, busy),
                    run: onToggle,
                  },
                }
              : {})}
          />
        </div>
        <div ref={setActionTarget} className={styles.pluginExtraActions} />
        {accessReason && access === "error" && (
          <Button
            size="sm"
            onClick={() => {
              onCheckAccess();
              toggle.current?.focus();
            }}
          >
            Check access again
          </Button>
        )}

        {plugin.rollbackBlockedReason && (
          <span className="text-body-sm text-muted">
            {plugin.rollbackBlockedReason}
          </span>
        )}
      </div>
      {plugin.source === "external" && plugins.imports && managed && (
        <ManagedPluginUpdate
          plugins={plugins}
          catalog={catalog}
          busy={busy}
          source={managed.source}
          entry={managed.entry}
          holdReview={holdReview}
          returnFocus={() => close.current}
          {...(authorizeGit ? { authorizeGit } : {})}
        />
      )}
      {plugin.source === "external" && plugins.imports && !managed && (
        <PluginImport
          key={`${plugin.revision}:${JSON.stringify(plugin.updateSource)}`}
          initialUpdateAvailable={initialUpdateAvailable}
          actionTarget={updateAvailable ? primaryActionTarget : actionTarget}
          onUpdateAvailableChange={onUpdateAvailableChange}
          reviewRequested={reviewRequested}
          onReviewHandled={onReviewHandled}
          holdReview={holdReview}
          statusTarget={installedStatus}
          returnFocus={() => close.current}
          updateId={plugin.manifest.id}
          plugins={plugins}
          catalog={catalog}
          busy={busy}
          {...(authorizeGit ? { authorizeGit } : {})}
        />
      )}
      {accessReason && (
        <p id="plugin-detail-access" className="sr-only">
          {access === "error"
            ? "Could not check access. Try again."
            : accessReason}
        </p>
      )}
      {readme && (
        <section
          className={styles.pluginAsideSection}
          aria-label={`${plugin.manifest.name} README`}
        >
          <PluginReadme key={plugin.manifest.id} text={readme} />
        </section>
      )}
      <section
        className={styles.pluginAsideSection}
        aria-labelledby="plugin-metadata-title"
      >
        <h3 id="plugin-metadata-title">Details</h3>
        <table
          className={styles.pluginMetadata}
          aria-labelledby="plugin-metadata-title"
        >
          <tbody>
            <tr>
              <th scope="row">Identifier</th>
              <td>
                <code>{plugin.manifest.id}</code>
              </td>
            </tr>
            <tr>
              <th scope="row">Plugin API</th>
              <td>{plugin.manifest.apiVersion}</td>
            </tr>
            {otherTags.length > 0 && (
              <tr>
                <th scope="row">Tags</th>
                <td>{otherTags.join(", ")}</td>
              </tr>
            )}
            {plugin.source === "external" && (
              <>
                <tr>
                  <th scope="row">Revision</th>
                  <td>
                    <code>{plugin.revision}</code>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Signature</th>
                  <td>{plugin.hasSignature ? "Signed" : "Unsigned"}</td>
                </tr>
                {plugin.publisher && (
                  <tr>
                    <th scope="row">Publisher</th>
                    <td>
                      <code title={plugin.publisher}>{plugin.publisher}</code>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </section>
      {failure && (
        <div className={styles.pluginStatus}>
          <p className="m-0 error text-body-sm">{failure}</p>
          {retryable && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (plugins.retryPlugin(plugin.manifest.id))
                  close.current?.focus({ preventScroll: true });
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}

export function Settings({
  agents,
  decisions,
  cards,
  plugins,
  adminAccess,
  communities,
  identity,
  federatedIdentity,
  builderlabIdentity,
  appearance,
  shortcuts,
  shortcutBindings,
  notifications,
  updates,
  navigation,
  installRequests,
  onSection,
  onProvider,
  onPluginImportClosed,
  navigationPane = false,
  onDeparturePending,
  onUnsavedChange,
}: {
  agents?: Agents | undefined;
  decisions?: DecisionsService | undefined;
  cards: SettingsCards;
  plugins: PluginManager;
  adminAccess?: AdminAccessReader;
  communities: Communities;
  identity?: Identity | undefined;
  federatedIdentity?: FederatedIdentity | undefined;
  /** The session as the Builderlab plugin's bundled installation, for its account reads. */
  builderlabIdentity?: FederatedIdentity | undefined;
  appearance: Appearance;
  shortcuts: ShortcutsService;
  shortcutBindings: ShortcutBindings;
  notifications: NotificationsService;
  updates: Updates;
  navigation?:
    | import("../features/navigation/service").PageNavigation
    | undefined;
  installRequests?: PluginInstallRequests | undefined;
  onSection?: (section: string) => void;
  onProvider?: ((provider?: string) => void) | undefined;
  onPluginImportClosed?: (() => void) | undefined;
  navigationPane?: boolean;
  onDeparturePending?: (pending: boolean) => void;
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  useEffect(() => cards.retainVisibility(), [cards]);
  useEffect(() => adminAccess?.ensure(), [adminAccess]);
  const installRequest = useSyncExternalStore(
    installRequests?.subscribe ?? noAccessSubscription,
    installRequests?.snapshot ?? noInstallRequest,
  );
  const settingsMounted = useRef(false);
  useEffect(() => {
    settingsMounted.current = true;
    return () => {
      settingsMounted.current = false;
      queueMicrotask(() => {
        const waiting = installRequests?.snapshot();
        if (!settingsMounted.current && waiting)
          installRequests?.end(waiting.id);
      });
    };
  }, [installRequests]);
  const membershipAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noAccessSubscription,
    () => adminAccess?.status("buzz.moderation") ?? "unavailable",
  );
  const moderationAccess = useSyncExternalStore(
    adminAccess?.subscribe ?? noAccessSubscription,
    () => adminAccess?.status("buzz.relay-staff") ?? "unavailable",
  );
  const pluginAccess = (plugin: PluginInfo) =>
    plugin.manifest.id === "buzz.moderation"
      ? membershipAccess
      : moderationAccess;
  useEffect(() => communities.retainPresentation(), [communities]);
  const contributed = useSyncExternalStore(cards.subscribe, cards.snapshot);
  const client = useSyncExternalStore(
    communities.subscribe,
    communities.snapshot,
  );
  const selectedCommunity = client.memberships.find(
    (membership) => membership.id === client.selected,
  );
  // Local removal drops the saved membership before session disposal/purge
  // settles. Retain only this action's context so its modal can finish.
  const [departure, setDeparture] = useState<{
    community: Membership;
    viewer: string | undefined;
  } | null>(null);
  const departureCommunity =
    departure?.viewer === client.viewer
      ? (departure?.community ?? selectedCommunity)
      : selectedCommunity;
  const { groups, sections, defaultSection } = useMemo(
    () => settingsSections(contributed, departureCommunity),
    [contributed, departureCommunity],
  );
  const [selected, setSelected] = useState(defaultSection);
  // Shortcuts lists every binding with its own controls, so it is built on
  // first visit rather than with every Settings open, then kept like the rest.
  const [shortcutsVisited, setShortcutsVisited] = useState(false);
  if (selected === "shortcuts" && !shortcutsVisited) setShortcutsVisited(true);
  // A switch made from inside the content hides or removes the control that
  // made it, so focus moves into the section it opened.
  const contentFocus = useRef<string>(undefined);
  useLayoutEffect(() => {
    if (selected !== contentFocus.current) return;
    contentFocus.current = undefined;
    (selected === "plugins"
      ? pluginSection.current
      : document.getElementById(
          navigationPane ? "settings-content" : "main-content",
        )
    )?.focus({ preventScroll: true });
  }, [selected, navigationPane]);
  useEffect(() => {
    if (
      departure &&
      (selected !== "leave-community" ||
        departure.viewer !== client.viewer ||
        (client.selected !== null &&
          client.selected !== departure.community.id))
    )
      setDeparture(null);
  }, [client.selected, client.viewer, departure, selected]);
  const requestedSection =
    navigation?.target.kind === "settings"
      ? (navigation.target.section ?? defaultSection)
      : undefined;
  useEffect(() => {
    if (
      requestedSection &&
      sections.some((section) => section.id === requestedSection)
    )
      setSelected(requestedSection);
    else if (!sections.some((section) => section.id === selected)) {
      setSelected(defaultSection);
      if (requestedSection === selected) onSection?.(defaultSection);
    }
  }, [defaultSection, onSection, requestedSection, selected, sections]);
  useEffect(() => {
    if (requestedSection === selected)
      navigation?.complete({ status: "opened" });
  }, [navigation, requestedSection, selected]);
  const { configuration, activation, busy, error, refreshError } =
    useSyncExternalStore(plugins.subscribe, plugins.snapshot);
  const ready = configuration.status === "ready" ? configuration : undefined;
  const catalog = ready?.catalog;
  const externalPluginsPaused = ready?.externalPluginsPaused;
  const managed = ready?.managed;
  const pendingCount = pendingManaged(managed).length;
  const [activationAttempt, setActivationAttempt] = useState<{
    id: string;
    revision: string;
  }>();
  const attemptedPlugin = catalog?.plugins.find(
    (plugin) =>
      plugin.manifest.id === activationAttempt?.id &&
      plugin.revision === activationAttempt?.revision &&
      plugin.enabled,
  );
  const attemptedRunning =
    attemptedPlugin && activation[attemptedPlugin.manifest.id];
  const activationFailure =
    attemptedRunning?.revision === activationAttempt?.revision
      ? attemptedRunning?.error
      : null;
  const togglePlugin = (plugin: PluginInfo) => {
    if (
      busy ||
      (!plugin.enabled &&
        restrictedPlugin(plugin) &&
        adminAccess?.status(plugin.manifest.id) !== "allowed")
    )
      return;
    setActivationAttempt(
      plugin.enabled
        ? undefined
        : { id: plugin.manifest.id, revision: plugin.revision },
    );
    void plugins.change(
      plugin.enabled ? "disable" : "enable",
      plugin.manifest.id,
    );
  };
  const [pluginFilter, setPluginFilter] = useState<"all" | "essentials">("all");
  const [pluginQuery, setPluginQuery] = useState("");
  const pluginSearch = useRef<HTMLElement>(null);
  const pluginFiltersActive =
    pluginFilter !== "all" || pluginQuery.trim() !== "";
  const reducedMotion = useReducedMotion();
  const listMotion = {
    layout: reducedMotion ? (false as const) : ("position" as const),
    initial: reducedMotion ? (false as const) : { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    ...(reducedMotion ? {} : { exit: { opacity: 0 } }),
    transition: {
      duration: reducedMotion ? 0 : 0.16,
      layout: { type: "spring" as const, stiffness: 420, damping: 38 },
    },
  };
  const layoutMotion = {
    layout: listMotion.layout,
    transition: listMotion.transition,
  };
  const coreGroup = useMemo(
    () =>
      groupPlugins(catalog?.plugins ?? []).find((group) => group.id === "core"),
    [catalog?.plugins],
  );
  const pluginGroups = useMemo(() => {
    const query = pluginQuery.trim().toLowerCase();
    return groupPlugins(
      (catalog?.plugins ?? []).filter(
        (plugin) =>
          !isCorePlugin(plugin) &&
          (pluginFilter === "all" || isEssentialPlugin(plugin)) &&
          [
            plugin.manifest.name,
            plugin.manifest.id,
            plugin.manifest.description,
            ...(plugin.manifest.discovery?.tags ?? []),
          ].some((value) => value?.toLowerCase().includes(query)),
      ),
    );
  }, [catalog?.plugins, pluginFilter, pluginQuery]);
  const [selectedPluginId, setSelectedPluginId] = useState<string>();
  const [reviewPluginId, setReviewPluginId] = useState<string>();
  const [updateChecks, setUpdateChecks] = useState<
    Record<string, { revision: string; available: boolean }>
  >({});
  const [pluginImportActions, setPluginImportActions] =
    useState<HTMLSpanElement | null>(null);
  const pluginTrigger = useRef<HTMLButtonElement>(null);
  const restorePluginFocus = useRef(false);
  const pluginSection = useRef<HTMLElement>(null);
  const layout = useRef<HTMLDivElement>(null);
  const detailsClose = useRef<HTMLButtonElement>(null);
  // Opening or closing details can resize the catalog column and reflow rows
  // above the chosen one. Browser scroll anchoring does not reliably hold it
  // (it can jump on close), so keep the chosen row where the user saw it.
  const heldPluginRow = useRef<{ row: Element; top: number }>(undefined);
  const holdPluginRow = (row: Element | null) => {
    heldPluginRow.current = row
      ? { row, top: row.getBoundingClientRect().top }
      : undefined;
  };
  const selectedPlugin = catalog?.plugins.find(
    (plugin) => plugin.manifest.id === selectedPluginId,
  );
  const showingDetails = selected === "plugins" && !!selectedPlugin;
  const visibleReturn = (target: HTMLElement | null) =>
    covered(pluginSection.current) ? (detailsClose.current ?? target) : target;
  useEffect(() => {
    if (selected !== "plugins") setSelectedPluginId(undefined);
  }, [selected]);
  useEffect(() => {
    const element = layout.current;
    if (!showingDetails || !element) return;
    // Resizing can hide the focused catalog control; keep focus in details.
    // A hidden control's focus falls back to a container: the page, or the
    // Settings modal that hosts this layout.
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      const details = detailsClose.current?.closest("aside");
      if (
        covered(pluginSection.current) &&
        active &&
        (active.contains(element) ||
          (element.contains(active) && !details?.contains(active)))
      )
        detailsClose.current?.focus({ preventScroll: true });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [showingDetails]);
  useEffect(() => {
    if (selectedPluginId && catalog && !selectedPlugin) {
      pluginSection.current?.focus();
      setSelectedPluginId(undefined);
    }
  }, [catalog, selectedPlugin, selectedPluginId]);
  const closePluginDetails = () => {
    holdPluginRow(pluginTrigger.current);
    restorePluginFocus.current = true;
    setReviewPluginId(undefined);
    setSelectedPluginId(undefined);
  };
  useLayoutEffect(() => {
    const held = heldPluginRow.current;
    heldPluginRow.current = undefined;
    const port = held?.row.isConnected && scrollport(held.row);
    // Whole pixels: WebKit truncates a fractional scrollTop, so a sub-pixel
    // drift left after its own anchoring would otherwise move the row by 1px.
    const shift =
      held && port
        ? Math.round(held.row.getBoundingClientRect().top - held.top)
        : 0;
    if (port && shift) port.scrollTop += shift;
  });
  useLayoutEffect(() => {
    if (!selectedPlugin && restorePluginFocus.current) {
      restorePluginFocus.current = false;
      const visible = [coreGroup, ...pluginGroups].some((group) =>
        group?.plugins.some(
          (plugin) =>
            plugin.manifest.id === pluginTrigger.current?.dataset.pluginId,
        ),
      );
      (visible ? pluginTrigger.current : pluginSection.current)?.focus({
        preventScroll: true,
      });
    }
  }, [selectedPlugin, coreGroup, pluginGroups]);
  const selectedRunning = selectedPlugin
    ? activation[selectedPlugin.manifest.id]
    : undefined;
  const selectedFailure = selectedPlugin
    ? (selectedPlugin.error ??
      (selectedRunning?.revision === selectedPlugin.revision
        ? selectedRunning.error
        : null))
    : null;
  const renderPluginGroup = (
    group: ReturnType<typeof groupPlugins>[number],
  ) => {
    const core = group.id === "core";
    const Group = core ? CorePluginGroup : SettingsGroup;
    const Target = core ? SurfaceButton : "button";
    return (
      <PluginListEntry
        {...listMotion}
        className={core ? styles.pluginCoreSection : undefined}
        role="region"
        aria-label={core ? "Core plugins" : undefined}
        aria-labelledby={core ? undefined : `plugin-category-${group.id}`}
        key={group.id}
      >
        {!core && (
          <InlineHeader
            id={`plugin-category-${group.id}`}
            title={
              <span className={styles.pluginCategoryTitle}>
                <span>{group.label}</span>
                <span className={styles.pluginCount}>
                  {group.plugins.length}
                  <span className="sr-only">
                    {group.plugins.length === 1 ? " plugin" : " plugins"}
                  </span>
                </span>
              </span>
            }
          />
        )}
        <Group>
          <AnimatePresence initial={false} mode="popLayout" propagate>
            {group.plugins.map((plugin) => {
              const id = plugin.manifest.id;
              const active = id === selectedPluginId;
              const access = pluginAccess(plugin);
              const accessReason = restrictedPlugin(plugin)
                ? accessMessage(plugin, access)
                : null;
              const running = activation[id];
              const failure =
                plugin.error ??
                (running?.revision === plugin.revision ? running.error : null);
              const updateAvailable =
                !!plugins.imports &&
                !managedBy(managed, id) &&
                updateChecks[id]?.revision === plugin.revision &&
                !!updateChecks[id]?.available;
              const name = (
                <span className={styles.pluginName}>
                  <span>{plugin.manifest.name}</span>
                  {plugin.source === "bundled" && (
                    <CheckCircleIcon
                      size={14}
                      strokeWidth={2.5}
                      aria-hidden="true"
                    />
                  )}
                  {isEssentialPlugin(plugin) && (
                    <SparklesIcon
                      size={14}
                      role="img"
                      aria-label="Essential"
                      aria-hidden={false}
                      title="Essential"
                    />
                  )}
                </span>
              );
              return (
                <PluginListEntry key={id} {...listMotion}>
                  <article
                    className={styles.plugin}
                    data-core={core || undefined}
                  >
                    <Target
                      ref={
                        active
                          ? (target: HTMLButtonElement | null) => {
                              if (target) pluginTrigger.current = target;
                            }
                          : undefined
                      }
                      type="button"
                      data-plugin-id={id}
                      data-access-state={
                        plugin.enabled && accessReason ? "" : undefined
                      }
                      className={styles.pluginRow}
                      data-enabled={plugin.enabled}
                      aria-label={`View ${plugin.manifest.name} details`}
                      aria-describedby={
                        [
                          plugin.manifest.description
                            ? `plugin-description-${id}`
                            : null,
                          plugin.source === "external" &&
                          (plugin.publisher || managedBy(managed, id))
                            ? `plugin-publisher-${id}`
                            : null,
                          isEssentialPlugin(plugin)
                            ? `plugin-essential-${id}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" ") || undefined
                      }
                      aria-expanded={active}
                      aria-controls={active ? "plugin-details" : undefined}
                      onClick={(event) => {
                        pluginTrigger.current = event.currentTarget;
                        holdPluginRow(event.currentTarget);
                        if (!active) setActivationAttempt(undefined);
                        setSelectedPluginId(active ? undefined : id);
                      }}
                    >
                      {isEssentialPlugin(plugin) && (
                        <span id={`plugin-essential-${id}`} className="sr-only">
                          Essential
                        </span>
                      )}
                      {core ? (
                        <>
                          <PluginIcon plugin={plugin} />
                          {name}
                          <span
                            id={`plugin-description-${id}`}
                            className={styles.pluginCoreDescription}
                          >
                            {plugin.manifest.description}
                          </span>
                        </>
                      ) : (
                        <ChoiceRow
                          leading={<PluginIcon plugin={plugin} />}
                          label={name}
                          description={
                            plugin.manifest.description ? (
                              <span
                                id={`plugin-description-${id}`}
                                className={styles.pluginRowDescription}
                              >
                                {plugin.manifest.description}
                              </span>
                            ) : undefined
                          }
                        />
                      )}
                      {plugin.source === "external" && (
                        <span id={`plugin-publisher-${id}`}>
                          <PluginProvenance
                            source={plugin.source}
                            publisher={plugin.publisher}
                            managedBy={managedBy(managed, id)?.source}
                            className={styles.pluginRowAuthor}
                          />
                        </span>
                      )}
                    </Target>
                    <div className={styles.pluginRowAction}>
                      {plugin.enabled && accessReason && (
                        <span className="text-caption text-muted self-center">
                          {access === "checking" ? "Checking…" : "Unavailable"}
                        </span>
                      )}
                      {updateAvailable ? (
                        <Button
                          size="sm"
                          variant="prominent"
                          disabled={busy}
                          aria-label={`Update ${plugin.manifest.name}`}
                          onClick={(event) => {
                            holdPluginRow(event.currentTarget);
                            setActivationAttempt(undefined);
                            setSelectedPluginId(id);
                            setReviewPluginId(id);
                          }}
                        >
                          Update
                        </Button>
                      ) : isRequiredPlugin(plugin) ? (
                        <Button variant="outline" size="sm" disabled>
                          Required
                        </Button>
                      ) : (
                        <Tooltip
                          content={accessReason}
                          {...(accessReason ? {} : { open: false })}
                          disableHoverablePopup
                        >
                          <Button
                            variant={
                              plugin.enabled
                                ? "subtle"
                                : accessReason
                                  ? "outline"
                                  : "prominent"
                            }
                            size="sm"
                            aria-label={`${pluginActionLabel(plugin, access)} ${plugin.manifest.name}`}
                            disabled={pluginToggleDisabled(
                              plugin,
                              access,
                              busy,
                            )}
                            loading={
                              !plugin.enabled &&
                              restrictedPlugin(plugin) &&
                              access === "checking"
                            }
                            aria-describedby={
                              accessReason ? `plugin-access-${id}` : undefined
                            }
                            focusableWhenDisabled
                            onClick={() => togglePlugin(plugin)}
                          >
                            {pluginActionLabel(plugin, access)}
                          </Button>
                        </Tooltip>
                      )}
                      <PluginMenu
                        plugin={plugin}
                        plugins={plugins}
                        busy={busy}
                        label={`More actions for ${plugin.manifest.name}`}
                        onRemoved={() => pluginSection.current?.focus()}
                        {...(updateAvailable
                          ? {
                              toggle: {
                                label: pluginActionLabel(plugin, access),
                                disabled: pluginToggleDisabled(
                                  plugin,
                                  access,
                                  busy,
                                ),
                                run: () => togglePlugin(plugin),
                              },
                            }
                          : {})}
                      />
                    </div>
                  </article>
                  {accessReason && (
                    <p id={`plugin-access-${id}`} className="sr-only">
                      {accessReason}
                    </p>
                  )}
                  {failure && (
                    <p
                      className={`${styles.pluginRowError} error text-body-sm`}
                    >
                      {failure}
                    </p>
                  )}
                </PluginListEntry>
              );
            })}
          </AnimatePresence>
        </Group>
      </PluginListEntry>
    );
  };
  // A new connection's session reads activity again.
  const relay = useSyncExternalStore(
    communities.relay.subscribe,
    communities.relay.snapshot,
  );
  const relaySession = relay.status === "ready" ? relay.session : undefined;
  const lastActive = useCallback(
    (pubkey: string) => keyActivity(relaySession, pubkey),
    [relaySession],
  );
  const authorizePluginGit = async (repository: string) => {
    const connection = communities.relay.snapshot();
    return connection.status === "ready"
      ? ((await connection.session.authorizeGit?.(repository)) ?? null)
      : null;
  };
  // Keep announcements outside filtered rows and the covered narrow catalog.
  const announcement = (
    <div
      role={selected === "plugins" ? "alert" : undefined}
      className="sr-only"
    >
      {selected === "plugins" && activationFailure && attemptedPlugin
        ? `${attemptedPlugin.manifest.name}: ${activationFailure}`
        : selected === "plugins" && selectedFailure && selectedPlugin
          ? `${selectedPlugin.manifest.name}: ${selectedFailure}`
          : null}
    </div>
  );
  const detail = (
    <>
      <div
        className={`${styles.detail} buzz-settings-page`}
        data-integrated={navigationPane || undefined}
      >
        <div hidden={selected !== "notifications"}>
          <NotificationSettings
            notifications={notifications}
            active={selected === "notifications"}
          />
        </div>
        <div hidden={selected !== "appearance"}>
          <AppearanceSettings
            appearance={appearance}
            active={selected === "appearance"}
          />
        </div>
        <div hidden={selected !== "shortcuts"}>
          {shortcutsVisited && (
            <ShortcutSettings
              shortcuts={shortcuts}
              bindings={shortcutBindings}
              plugins={plugins}
            />
          )}
        </div>
        <div hidden={selected !== "agents"}>
          <AgentSettings
            agents={agents}
            active={selected === "agents"}
            navigation={navigation}
            onProvider={onProvider}
          />
        </div>
        {decisions && (
          <div hidden={selected !== "decisions"}>
            <DecisionsSettings
              decisions={decisions}
              active={() => selected === "decisions"}
              onSection={
                onSection &&
                ((id) => {
                  contentFocus.current = id;
                  onSection(id);
                })
              }
            />
          </div>
        )}
        <div hidden={selected !== "updates"}>
          <UpdateSettings updates={updates} active={selected === "updates"} />
        </div>
        {contributed.map(
          (card) =>
            selected === card.key && (
              <OwnedContribution key={card.key} entry={card} registry={cards}>
                {(entry, active) => {
                  const Card = entry.component;
                  return (
                    <Card
                      active={active}
                      {...(!card.group && selectedCommunity
                        ? { community: selectedCommunity }
                        : {})}
                    />
                  );
                }}
              </OwnedContribution>
            ),
        )}
        {departureCommunity && selected === "leave-community" && (
          <CommunityDepartureSettings
            key={`${client.viewer}:${departureCommunity.id}`}
            communities={communities}
            community={departureCommunity}
            onPending={(pending) => {
              onDeparturePending?.(pending);
              setDeparture(
                pending
                  ? { community: departureCommunity, viewer: client.viewer }
                  : null,
              );
            }}
            onRemoved={() => {
              contentFocus.current = "profile";
              if (onSection) onSection("profile");
              else setSelected("profile");
            }}
          />
        )}
        <div hidden={selected !== "profile"}>
          <ProfileSettings
            key={`${client.viewer}:${selectedCommunity?.id ?? "local"}`}
            communities={communities}
            community={selectedCommunity}
            onUnsavedChange={onUnsavedChange}
          />
        </div>
        {selectedCommunity && (
          <div hidden={selected !== "local-settings"}>
            <CommunityLocalSettings
              key={`${client.viewer}:${selectedCommunity.id}`}
              communities={communities}
              community={selectedCommunity}
              viewer={client.viewer}
            />
          </div>
        )}
        {selected === "identity" && (
          <IdentitySettings
            key={client.viewer}
            viewer={client.viewer}
            identity={identity}
            federatedIdentity={federatedIdentity}
            builderlabIdentity={builderlabIdentity}
            lastActive={lastActive}
          />
        )}
        {developerMode && (
          <div hidden={selected !== "developer"}>
            <DeveloperSettings relay={communities.relay} />
          </div>
        )}
        <div hidden={selected !== "plugins"}>
          <section
            ref={pluginSection}
            tabIndex={-1}
            aria-labelledby="plugin-settings-title"
          >
            <motion.div {...layoutMotion} className={styles.pluginHeading}>
              <Header
                id="plugin-settings-title"
                title="Manage plugins"
                actions={
                  plugins.imports && catalog ? (
                    <span ref={setPluginImportActions} />
                  ) : undefined
                }
              />
            </motion.div>
            <AnimatePresence initial={false} mode="popLayout">
              {coreGroup && renderPluginGroup(coreGroup)}
            </AnimatePresence>
            {catalog && (
              <ManagedPlugins
                plugins={plugins}
                managed={managed}
                catalog={catalog}
                busy={busy}
                authorizeGit={authorizePluginGit}
                holdReview={installRequests?.holdReview}
              />
            )}
            {catalog && (
              <motion.div {...layoutMotion} className={styles.pluginToolbar}>
                <motion.div {...layoutMotion}>
                  <Tabs
                    variant="panel"
                    label="Plugin filters"
                    items={[
                      {
                        value: "all",
                        label: "All plugins",
                        panelId: "plugin-results-all",
                      },
                      {
                        value: "essentials",
                        label: "Essentials",
                        panelId: "plugin-results-essentials",
                      },
                    ]}
                    value={pluginFilter}
                    onValueChange={setPluginFilter}
                  />
                </motion.div>
                <motion.div {...layoutMotion} className={styles.pluginSearch}>
                  <SearchField
                    inputRef={pluginSearch}
                    label="Search plugins"
                    placeholder="Search plugins…"
                    value={pluginQuery}
                    onValueChange={setPluginQuery}
                  />
                </motion.div>
              </motion.div>
            )}
            {catalog ? (
              <PluginImport
                key={
                  navigation?.target.kind === "settings" &&
                  navigation.target.pluginImport
                    ? navigation.entryId
                    : "add"
                }
                initialGit={
                  navigation?.target.kind === "settings"
                    ? navigation.target.pluginImport
                    : undefined
                }
                requestSignal={navigation?.signal}
                onClosed={() => onPluginImportClosed?.()}
                actionTarget={pluginImportActions}
                request={installRequest}
                onRequestSettled={installRequests?.settle}
                onRequestClaimed={installRequests?.claim}
                onRequestConfirmed={installRequests?.confirm}
                onRequestEnded={installRequests?.end}
                holdReview={installRequests?.holdReview}
                plugins={plugins}
                catalog={catalog}
                busy={busy}
                authorizeGit={authorizePluginGit}
                onOpenInstalled={(id) => {
                  pluginTrigger.current =
                    [
                      ...(pluginSection.current?.querySelectorAll<HTMLButtonElement>(
                        "button[data-plugin-id]",
                      ) ?? []),
                    ].find((button) => button.dataset.pluginId === id) ?? null;
                  setActivationAttempt(undefined);
                  setSelectedPluginId(id);
                }}
                returnFocus={() => detailsClose.current ?? visibleReturn(null)}
              />
            ) : configuration.status === "recovery" ? (
              <RecoveryScreen plugins={plugins} />
            ) : (
              <p role="status">
                Plugin settings are unavailable. Profile and Appearance still
                work.
              </p>
            )}

            <div>
              <div>
                {externalPluginsPaused && (
                  <p role="status" className="text-body-sm text-subtle">
                    External plugins are paused for this launch. Your saved
                    enabled settings are unchanged; you can still manage plugins
                    here.
                  </p>
                )}
                {selected === "plugins" && refreshError && (
                  <ToastNotice
                    title="Plugin settings couldn’t refresh"
                    description={`Showing the last available configuration; retrying automatically. ${refreshError}`}
                  />
                )}
                {selected === "plugins" && error && (
                  <ToastNotice
                    title="Plugin change wasn’t confirmed"
                    description={`Check the current settings before trying again. ${error}`}
                    onDismiss={plugins.dismissError}
                    closeLabel="Dismiss"
                  />
                )}
              </div>
              {catalog &&
                (["all", "essentials"] as const).map((filter) => (
                  <div
                    key={filter}
                    hidden={filter !== pluginFilter}
                    className={
                      filter === pluginFilter
                        ? styles.pluginCategories
                        : undefined
                    }
                    role="tabpanel"
                    id={`plugin-results-${filter}`}
                    aria-labelledby={`plugin-results-${filter}-tab`}
                  >
                    {filter === pluginFilter && (
                      <>
                        {pluginGroups.length === 0 && (
                          <EmptyState
                            icon={<SquaresFourIcon size={24} />}
                            title={
                              pluginFiltersActive
                                ? coreGroup
                                  ? "No other plugins match"
                                  : "No plugins match"
                                : coreGroup
                                  ? "No other plugins"
                                  : "No plugins yet"
                            }
                            description={
                              pluginFiltersActive
                                ? "Try another search or show all plugins."
                                : "Additional plugins will appear here."
                            }
                            action={
                              pluginFiltersActive ? (
                                <Button
                                  variant="subtle"
                                  onClick={() => {
                                    setPluginQuery("");
                                    setPluginFilter("all");
                                    pluginSearch.current?.focus();
                                  }}
                                >
                                  Clear filters
                                </Button>
                              ) : undefined
                            }
                          />
                        )}
                        <AnimatePresence initial={false} mode="popLayout">
                          {pluginGroups.map(renderPluginGroup)}
                        </AnimatePresence>
                      </>
                    )}
                  </div>
                ))}
            </div>
          </section>
        </div>
      </div>
      {showingDetails && selectedPlugin && catalog && (
        <PluginDetails
          key={selectedPlugin.manifest.id}
          plugin={selectedPlugin}
          managed={managedBy(managed, selectedPlugin.manifest.id)}
          catalog={catalog}
          initialUpdateAvailable={
            !managedBy(managed, selectedPlugin.manifest.id) &&
            updateChecks[selectedPlugin.manifest.id]?.revision ===
              selectedPlugin.revision &&
            updateChecks[selectedPlugin.manifest.id]?.available === true
          }
          authorizeGit={authorizePluginGit}
          reviewRequested={reviewPluginId === selectedPlugin.manifest.id}
          onReviewHandled={() => setReviewPluginId(undefined)}
          holdReview={installRequests?.holdReview}
          onUpdateAvailableChange={(available) =>
            setUpdateChecks((current) => {
              const id = selectedPlugin.manifest.id;
              if (
                current[id]?.revision === selectedPlugin.revision &&
                current[id]?.available === available
              )
                return current;
              return {
                ...current,
                [id]: { revision: selectedPlugin.revision, available },
              };
            })
          }
          failure={selectedFailure}
          retryable={canRetryPlugin(
            selectedPlugin,
            selectedRunning,
            !!externalPluginsPaused,
          )}
          busy={busy}
          access={pluginAccess(selectedPlugin)}
          onCheckAccess={() => adminAccess?.retry(selectedPlugin.manifest.id)}
          plugins={plugins}
          onToggle={() => togglePlugin(selectedPlugin)}
          close={detailsClose}
          onClose={closePluginDetails}
        />
      )}
    </>
  );
  // The Settings modal supplies its own frame, title and section navigation.
  if (navigationPane)
    return (
      <div
        className={styles.navigationPane}
        data-plugin-catalog={selected === "plugins" || undefined}
      >
        {announcement}
        <div
          ref={layout}
          className={styles.layout}
          data-plugin-detail={showingDetails ? "" : undefined}
        >
          {detail}
        </div>
      </div>
    );
  return (
    <div className={styles.root}>
      <Panel aria-labelledby="settings-title">
        {announcement}
        <div
          ref={layout}
          className={styles.layout}
          data-plugin-detail={showingDetails ? "" : undefined}
        >
          <aside className={styles.sidebar}>
            <div className={styles.sidebarHeader}>
              <h1 id="settings-title" className="m-0 text-label">
                Settings
              </h1>
            </div>
            <nav aria-label="Settings sections" className={styles.navigation}>
              <SidebarNavigation wrapSections>
                {departureCommunity && (
                  <NavigationSection>
                    <CommunityAddress
                      communities={communities}
                      community={departureCommunity}
                    />
                  </NavigationSection>
                )}
                {groups.map((group) => (
                  <NavigationSection key={group.id} label={group.label}>
                    {group.sections.map(({ id, label, icon: Icon }) => (
                      <NavigationItem
                        label={label}
                        icon={Icon && <Icon aria-hidden="true" size={18} />}
                        selected={selected === id}
                        {...(id === "plugins" && pendingCount > 0
                          ? {
                              trailing: (
                                <RecommendationCount count={pendingCount} />
                              ),
                            }
                          : {})}
                        type="button"
                        key={id}
                        aria-current={selected === id ? "page" : undefined}
                        onClick={(event) => {
                          event.currentTarget.focus();
                          if (onSection) onSection(id);
                          else setSelected(id);
                        }}
                      />
                    ))}
                  </NavigationSection>
                ))}
              </SidebarNavigation>
            </nav>
          </aside>
          {detail}
        </div>
      </Panel>
    </div>
  );
}
