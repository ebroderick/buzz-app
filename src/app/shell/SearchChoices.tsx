import { matchRank } from "../../features/search/match";
import {
  useLayoutEffect,
  useRef,
  useEffect,
  type RefObject,
  type ReactNode,
} from "react";
import type { ChatCircleIcon } from "../../shared/design-system/icons/index";
import { Avatar } from "../../shared/design-system/ui/Avatar";
import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { SearchField } from "../../shared/design-system/ui/SearchField";
import { isApplePlatform } from "../../features/shortcuts/format";
import { MatchedLabel } from "../../features/search/MatchedLabel";
import { useSearchHighlight } from "../../features/search/use-search-highlight";
import { PageIcon } from "./PageIcon";
import "./SearchChoices.css";

export type SearchDestination = {
  content?: ReactNode;
  rank?: number;
  key: string;
  label: string;
  detail?: string;
  /** Quiet metadata at the row's end, such as a count. */
  trailing?: ReactNode;
  /** Code points of `label` that match the typed text. */
  matches?: readonly number[];
  icon: typeof ChatCircleIcon;
  image?: string | undefined;
  avatar?:
    | { src?: string | undefined; shape: "circle" | "squircle" }
    | undefined;
  run: () => void;
};

export type SearchGroup = {
  label: string;
  /** Name the group for assistive technology only, when the view's own tab
   * already says what it holds. */
  hideLabel?: boolean;
  /** Message-content scores are not comparable to named destinations. */
  rank?: number;
  destinations: readonly SearchDestination[];
  /** How many rows the whole list holds when only its first are drawn, so
   * assistive technology counts them all. */
  total?: number;
  empty?: ReactNode;
  notice?: ReactNode;
  /** Non-interactive visual status; callers own its live announcement. */
  headingStatus?: string | undefined;
};

export type SearchInputProps = {
  inlineSettings?: readonly SearchGroup[] | undefined;
  query: string;
  onQueryChange: (query: string) => void;
  input: RefObject<HTMLElement | null>;
  label?: string;
  scope?: { label: string; onRemove: () => void } | undefined;
  /** A control that refines the scoped results, beside the scope chip. */
  scopeAction?: ReactNode;
  authorChip?:
    | {
        /** `in:@person` shares the chip with `from:@author`. */
        operator: "from" | "in";
        label: string;
        title: string;
        onRemove: () => void;
      }
    | undefined;
  displayQuery?: string | undefined;
  onDisplayQueryChange?: ((value: string) => void) | undefined;
  /** False while the palette closes, so a held Enter chooses nothing. */
  open?: boolean | undefined;
};

/** Views of one search, switched from the field with Ctrl+Tab and
 * Ctrl+Shift+Tab, drawn between the field and the results. */
export type SearchViews = {
  tabs: ReactNode;
  /** Names the results list for the view shown. */
  resultsLabel: string;
  /** The shown view's tab panel, which its tab controls. */
  panelId: string;
  onSwitch: (delta: 1 | -1) => void;
  /** Where the results were: their scroll position and highlighted row,
   * restored as the view mounts and kept as they change. */
  place: SearchPlace;
};

/** A kept place in the results. `anchor` is the first row in view and how
 * far above the view's top it sat, so a list whose order changed while
 * closed reopens on the same rows rather than the same pixels. */
export type SearchPlace = {
  top: number;
  key: string;
  anchor?: { key: string; offset: number } | undefined;
};

const rowKeysOf = (elements: readonly Element[]) =>
  elements.flatMap((row) =>
    row instanceof HTMLElement && row.dataset.searchKey
      ? [row.dataset.searchKey]
      : [],
  );

export function SearchChoices({
  groups: originalGroups,
  query,
  onQueryChange,
  authorChip,
  displayQuery,
  onDisplayQueryChange,
  input,
  label = "Search Buzz",
  scope,
  scopeAction,
  children,
  inlineSettings,
  open = true,
  pending = false,
  isAction,
  views,
  highlightEmpty = false,
  onRowsShown,
}: SearchInputProps & {
  groups: readonly SearchGroup[];
  children?: ReactNode;
  /** A row that should lead may still arrive, so Enter before any row
   * waits until it has. */
  pending?: boolean;
  /** Whether a row acts on the search rather than being a result, so Enter
   * on it can wait for `pending` like Enter before any row. */
  isAction?: (key: string) => boolean;
  views?: SearchViews | undefined;
  /** Highlight the first row before anything is typed, for a view whose
   * unfiltered list is the list to choose from. */
  highlightEmpty?: boolean;
  /** Hears the keys of rows scrolled into (or near) view, for details worth
   * reading only for the rows someone can see. */
  onRowsShown?: ((keys: readonly string[]) => void) | undefined;
}) {
  const palette = useRef<HTMLDivElement>(null);
  const resultsViewport = useRef<HTMLDivElement>(null);
  const resultsContent = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = resultsViewport.current;
    const content = resultsContent.current;
    if (!viewport || !content) return;
    let initialized = false;
    let frame = 0;
    const measure = () => {
      const height = content.offsetHeight;
      viewport.style.height = `${height}px`;
      if (!initialized) {
        initialized = true;
        frame = requestAnimationFrame(() => {
          viewport.dataset.measured = "";
        });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  const needle = query.trim().toLowerCase();
  const score = (group: SearchGroup) =>
    group.rank ??
    Math.min(
      matchRank(group.label, needle) ?? Infinity,
      ...group.destinations.map(
        (row) =>
          row.rank ??
          Math.min(
            matchRank(row.label, needle) ?? Infinity,
            matchRank(row.detail ?? "", needle) ?? Infinity,
          ),
      ),
    );
  // Upstream order includes usage and remembered choices. Only insert the new
  // groups; never re-rank existing destinations from their display labels.
  const groups = [...originalGroups];
  for (const group of [...(inlineSettings ?? [])].sort(
    (a, b) => score(a) - score(b),
  )) {
    const index = groups.findIndex(
      (existing) => score(existing) > score(group),
    );
    groups.splice(index < 0 ? groups.length : index, 0, group);
  }
  const hasControls = groups.some((group) =>
    group.destinations.some((row) => row.content),
  );
  const destinations = groups.flatMap((group) => group.destinations);
  const apple = isApplePlatform(navigator.platform);
  const shortcutNumbers = new Map(
    destinations.slice(0, 9).map(({ key }, index) => [key, index + 1]),
  );
  const place = views?.place;
  const keys = destinations.map(({ key }) => key);
  const highlight = useSearchHighlight({
    query,
    keys,
    onChoose: (key) => destinations.find((row) => row.key === key)?.run(),
    open,
    pending,
    isAction,
    highlightEmpty,
    // A kept place keeps its row: Enter never chooses a row scrolled away.
    ...(place?.key && keys.includes(place.key)
      ? { initial: place.key }
      : place?.top
        ? { initial: "" }
        : {}),
  });
  const selected = highlight.active;
  // A highlight is kept only while its row is in view: one scrolled away
  // would reopen with Enter choosing a row nobody can see.
  useEffect(() => {
    if (place) place.key = selected;
  }, [place, selected]);
  const rowBox = (key: string) =>
    document.getElementById(highlight.rowId(key))?.getBoundingClientRect();
  const inView = (key: string) => {
    const content = resultsContent.current;
    const box = key ? rowBox(key) : undefined;
    if (!content || !box) return false;
    const view = content.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom;
  };
  const keepPlace = () => {
    const content = resultsContent.current;
    if (!place || !content) return;
    place.key = inView(selected) ? selected : "";
    // Rows stack in order: find the first one reaching into the view.
    const top = content.getBoundingClientRect().top;
    let low = 0;
    let high = keys.length - 1;
    let anchor: SearchPlace["anchor"];
    while (low <= high) {
      const middle = (low + high) >> 1;
      const key = keys[middle];
      const box = key ? rowBox(key) : undefined;
      if (!key || !box) break;
      if (box.bottom > top) {
        anchor = { key, offset: top - box.top };
        high = middle - 1;
      } else low = middle + 1;
    }
    place.anchor = anchor;
  };
  useEffect(() => {
    input.current?.focus();
  }, [input]);
  // macOS sends Ctrl+Tab from its menu as a request to the focused control.
  const switchView = views?.onSwitch;
  useEffect(() => {
    const root = palette.current;
    if (!root || !switchView) return;
    const request = (delta: 1 | -1) => (event: Event) => {
      event.preventDefault();
      switchView(delta);
    };
    const next = request(1);
    const previous = request(-1);
    root.addEventListener("buzz:next-tab", next);
    root.addEventListener("buzz:previous-tab", previous);
    return () => {
      root.removeEventListener("buzz:next-tab", next);
      root.removeEventListener("buzz:previous-tab", previous);
    };
  }, [switchView]);
  const resultsLabel = views?.resultsLabel ?? "Search results";
  // A group drawn in part says where each row sits in the whole of it.
  const positions = new Map<
    string,
    { "aria-setsize": number; "aria-posinset": number }
  >();
  for (const { destinations, total } of groups)
    if (total !== undefined)
      for (const [index, { key }] of destinations.entries())
        positions.set(key, {
          "aria-setsize": total,
          "aria-posinset": index + 1,
        });
  // A view returns to its kept position, waiting for late rows to make room
  // until the person scrolls or moves the highlight themselves.
  const restore = useRef(place?.top ?? 0);
  const restoreScroll = () => {
    const content = resultsContent.current;
    if (!content || !restore.current) return;
    const anchor = place?.anchor;
    const box = anchor && rowBox(anchor.key);
    const target =
      anchor && box
        ? content.scrollTop +
          box.top -
          content.getBoundingClientRect().top +
          anchor.offset
        : restore.current;
    content.scrollTop = target;
    if (Math.abs(content.scrollTop - target) <= 1) restore.current = 0;
  };
  /** Once the kept place is back, a highlight left out of view is dropped,
   * so Enter never chooses a row nobody can see. */
  const settling = useRef(!!place?.top);
  const settle = () => {
    if (!settling.current || restore.current) return;
    settling.current = false;
    if (selected && !inView(selected)) highlight.clear();
  };
  // Before paint, and again after the highlight reveals its first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useLayoutEffect(() => {
    const target = restore.current;
    restoreScroll();
    restore.current = target;
  }, [destinations.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Rows arriving give the kept position room.
  useEffect(() => {
    restoreScroll();
    settle();
  }, [destinations.length]);
  const shown = useRef(onRowsShown);
  shown.current = onRowsShown;
  const watching = !!onRowsShown;
  const rowsObserver = useRef<
    { observer: IntersectionObserver; watched: Set<Element> } | undefined
  >(undefined);
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = rowKeysOf(
          entries.flatMap((entry) =>
            entry.isIntersecting ? [entry.target] : [],
          ),
        );
        if (visible.length) shown.current?.(visible);
      },
      // Half a view ahead, so details are usually there before the row is.
      { root, rootMargin: "50% 0px" },
    );
    rowsObserver.current = { observer, watched: new Set() };
    return () => {
      observer.disconnect();
      rowsObserver.current = undefined;
    };
  }, [watching]);
  const rowKeys = destinations.map(({ key }) => key).join("\n");
  // Only rows not yet watched start watching, so a list that grows as it
  // scrolls doesn't observe its earlier rows again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: New rows need watching.
  useEffect(() => {
    const root = resultsContent.current;
    if (!root || !watching) return;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-search-key]")];
    const watch = rowsObserver.current;
    if (!watch) {
      shown.current?.(rowKeysOf(rows));
      return;
    }
    for (const row of watch.watched)
      if (!row.isConnected) {
        watch.observer.unobserve(row);
        watch.watched.delete(row);
      }
    for (const row of rows)
      if (!watch.watched.has(row)) {
        watch.watched.add(row);
        watch.observer.observe(row);
      }
  }, [watching, rowKeys]);
  return (
    <div
      ref={palette}
      className="search-palette"
      data-search-palette=""
      data-modal-tab-switch={views ? "" : undefined}
      data-search-views={views ? "" : undefined}
      {...highlight.listProps}
    >
      {(scope || scopeAction) && (
        <div className="search-palette-scope-row">
          {scope && (
            <button
              type="button"
              className="search-palette-scope"
              aria-label={`Remove ${scope.label} search scope`}
              onClick={scope.onRemove}
            >
              {scope.label} <span aria-hidden="true">×</span>
            </button>
          )}
          {scopeAction}
        </div>
      )}
      <SearchField
        variant="palette"
        prefix={
          authorChip ? (
            <span className="search-palette-author-prefix">
              <button
                type="button"
                className="search-palette-author-chip"
                aria-label={`Remove ${authorChip.operator === "in" ? "conversation with" : "author"} ${authorChip.label}`}
                title={authorChip.title}
                onClick={authorChip.onRemove}
              >
                <span aria-hidden="true">×</span> {authorChip.operator}:@
                {authorChip.label}
              </button>
            </span>
          ) : undefined
        }
        inputRef={input}
        role="combobox"
        aria-controls={highlight.listId}
        aria-expanded="true"
        aria-autocomplete="list"
        aria-haspopup={hasControls ? "grid" : "listbox"}
        {...highlight.fieldProps}
        label={label}
        placeholder="Search..."
        value={displayQuery ?? query}
        onValueChange={onDisplayQueryChange ?? onQueryChange}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        maxLength={256}
        onKeyDown={(event) => {
          const shortcutNumber = /^Digit([1-9])$/.exec(event.code)?.[1];
          if (
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229 &&
            !event.altKey &&
            event.shiftKey &&
            event.metaKey === apple &&
            event.ctrlKey !== apple &&
            shortcutNumber
          ) {
            const destination = destinations[Number(shortcutNumber) - 1];
            if (destination) {
              event.preventDefault();
              if (!event.repeat) highlight.choose(destination.key);
            }
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp")
            restore.current = 0;
          if (
            views &&
            event.key === "Tab" &&
            event.ctrlKey &&
            !event.metaKey &&
            !event.altKey
          ) {
            event.preventDefault();
            views.onSwitch(event.shiftKey ? -1 : 1);
            return;
          }
          highlight.keyDown(event);
        }}
      />
      {views && <div className="search-palette-views">{views.tabs}</div>}
      <div
        ref={resultsViewport}
        className="search-palette-height"
        {...(views
          ? {
              role: "tabpanel",
              id: views.panelId,
              "aria-labelledby": `${views.panelId}-tab`,
            }
          : {})}
      >
        <div
          ref={resultsContent}
          className="search-palette-scroll"
          onWheel={() => {
            restore.current = 0;
          }}
          onPointerDown={() => {
            restore.current = 0;
          }}
          onScroll={(event) => {
            if (restore.current) return;
            // Enter never chooses a row scrolled out of sight.
            if (selected && !inView(selected)) highlight.clear();
            if (!place) return;
            place.top = event.currentTarget.scrollTop;
            keepPlace();
          }}
        >
          {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid and listbox support an accessible label. */}
          <div
            id={highlight.listId}
            role={hasControls ? "grid" : "listbox"}
            aria-label={resultsLabel}
            className="search-palette-results interaction-panel"
          >
            {groups
              .filter(
                ({ destinations, empty, headingStatus }) =>
                  destinations.length || empty !== undefined || headingStatus,
              )
              .map(
                ({
                  label,
                  hideLabel,
                  destinations,
                  empty,
                  notice,
                  headingStatus,
                }) => (
                  // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Both grid rowgroups and listbox groups are named.
                  <div
                    key={label}
                    role={hasControls ? "rowgroup" : "group"}
                    aria-label={label}
                    // A status-only group has no rows yet; busy states why.
                    aria-busy={
                      (!!headingStatus && !destinations.length) || undefined
                    }
                    className="search-palette-group"
                  >
                    <div className="navigation-section" data-buzz-ui="">
                      {!hideLabel && (
                        <div
                          className="navigation-section-heading"
                          aria-hidden={hasControls || undefined}
                        >
                          <h2
                            className={`navigation-section-label text-body text-secondary${headingStatus ? " truncate" : ""}`}
                          >
                            {label}
                            {headingStatus && (
                              <span aria-hidden="true"> · {headingStatus}</span>
                            )}
                          </h2>
                        </div>
                      )}
                      <div className="navigation-section-rows">
                        {destinations.map(
                          ({
                            content,
                            key,
                            label,
                            detail,
                            trailing,
                            matches,
                            icon,
                            image,
                            avatar,
                          }) =>
                            content ? (
                              // biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table.
                              <div
                                key={key}
                                {...highlight.rowProps(key)}
                                role="row"
                                aria-label={[label, detail]
                                  .filter(Boolean)
                                  .join(" — ")}
                                aria-selected={selected === key}
                                tabIndex={-1}
                                className="search-control-row"
                                data-highlighted={selected === key || undefined}
                                onClick={(event) => {
                                  if (
                                    !event.currentTarget.contains(
                                      event.target as Node,
                                    )
                                  )
                                    return;
                                  if (
                                    (event.target as HTMLElement).closest(
                                      "button, input, label, [role=switch], [role=combobox]",
                                    )
                                  )
                                    return;
                                  highlight.choose(key);
                                }}
                                onKeyDownCapture={(event) => {
                                  const target = event.target as HTMLElement;
                                  if (
                                    target !== event.currentTarget &&
                                    event.currentTarget.contains(target) &&
                                    !target.closest(
                                      '[role="combobox"][aria-expanded="true"]',
                                    )
                                  )
                                    highlight.rowProps(key).onKeyDown(event);
                                }}
                                onKeyDown={(event) => {
                                  if (event.target !== event.currentTarget)
                                    return;
                                  if (
                                    event.key === "Enter" ||
                                    event.key === " "
                                  ) {
                                    event.preventDefault();
                                    highlight.choose(key);
                                  } else
                                    highlight.rowProps(key).onKeyDown(event);
                                }}
                              >
                                {/* biome-ignore lint/a11y/useSemanticElements: Interactive search grid, not a data table. */}
                                <div id={key} role="gridcell" tabIndex={-1}>
                                  {content}
                                </div>
                              </div>
                            ) : (
                              // biome-ignore lint/a11y/useAriaPropsSupportedByRole: Selection and label apply only to the grid row.
                              // biome-ignore lint/a11y/noStaticElementInteractions: Keyboard handling applies only to the grid row.
                              <div
                                key={key}
                                {...(hasControls
                                  ? highlight.rowProps(key)
                                  : {})}
                                role={hasControls ? "row" : "presentation"}
                                aria-label={
                                  hasControls
                                    ? [label, detail]
                                        .filter(Boolean)
                                        .join(" — ")
                                    : undefined
                                }
                                aria-selected={
                                  hasControls ? selected === key : undefined
                                }
                                tabIndex={hasControls ? -1 : undefined}
                                data-search-result={
                                  hasControls ? "" : undefined
                                }
                                data-search-key={watching ? key : undefined}
                                data-highlighted={
                                  (hasControls && selected === key) || undefined
                                }
                                onKeyDown={
                                  hasControls
                                    ? (event) => {
                                        if (
                                          event.target ===
                                            event.currentTarget &&
                                          event.key === "Enter"
                                        ) {
                                          event.preventDefault();
                                          highlight.choose(key);
                                        } else
                                          highlight
                                            .rowProps(key)
                                            .onKeyDown(event);
                                      }
                                    : undefined
                                }
                              >
                                <div
                                  role={
                                    hasControls ? "gridcell" : "presentation"
                                  }
                                >
                                  <NavigationItem
                                    variant="search"
                                    key={key}
                                    {...(!hasControls
                                      ? highlight.rowProps(key)
                                      : {})}
                                    role={hasControls ? "button" : "option"}
                                    aria-selected={
                                      hasControls ? undefined : selected === key
                                    }
                                    {...(!hasControls && positions.get(key))}
                                    tabIndex={-1}
                                    aria-current={false}
                                    highlighted={selected === key}
                                    data-search-result={
                                      !hasControls ? "" : undefined
                                    }
                                    aria-keyshortcuts={
                                      shortcutNumbers.has(key)
                                        ? `Shift+${apple ? "Meta" : "Control"}+${shortcutNumbers.get(key)}`
                                        : undefined
                                    }
                                    icon={
                                      <span className="grid size-6 shrink-0 items-center justify-items-start">
                                        {avatar ? (
                                          <Avatar
                                            alt=""
                                            fallback={label}
                                            src={avatar.src}
                                            size="small"
                                            shape={avatar.shape}
                                          />
                                        ) : (
                                          <PageIcon
                                            icon={icon}
                                            image={image}
                                            size={21}
                                          />
                                        )}
                                      </span>
                                    }
                                    label={
                                      <>
                                        <span className="block truncate text-body-sm">
                                          <MatchedLabel
                                            label={label}
                                            positions={matches}
                                          />
                                        </span>
                                        {detail && (
                                          <span className="block truncate text-body-sm text-subtle">
                                            {detail}
                                          </span>
                                        )}
                                      </>
                                    }
                                    trailing={trailing}
                                    onClick={() => highlight.choose(key)}
                                  />
                                </div>
                              </div>
                            ),
                        )}
                        {(notice ||
                          (!destinations.length && !headingStatus)) && (
                          <div role={hasControls ? "row" : "presentation"}>
                            <div
                              role={hasControls ? "gridcell" : "presentation"}
                            >
                              {notice}
                              {!destinations.length && (
                                <p className="search-palette-group-empty">
                                  {empty ?? "No matching results."}
                                </p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ),
              )}
          </div>
          {children && <div className="search-palette-status">{children}</div>}
        </div>
      </div>
    </div>
  );
}
