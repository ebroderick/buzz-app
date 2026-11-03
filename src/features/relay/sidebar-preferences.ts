import { isSidebarSortMode, type SidebarSortMode } from "./sidebar-sort.ts";
export type { SidebarSortMode } from "./sidebar-sort.ts";
import {
  projectSidebarRecord,
  projectSidebarSort,
} from "./sidebar-registers.ts";
import type { ReadFilter } from "./events.ts";
import type { RelayEvent } from "./events.ts";
import type { RelayReader } from "./reader.ts";

export const SIDEBAR_COORDINATES = [
  "channel-sections",
  "channel-stars",
  "channel-mutes",
  "channel-sort",
  "channel-filter",
] as const;
/** Only the complete bounded account-preference batch may exceed the ordinary four-filter limit. */
export function isSidebarPreferencesBatch(
  filters: readonly ReadFilter[],
): boolean {
  const viewer = filters[0]?.authors?.[0];
  return (
    typeof viewer === "string" &&
    !!viewer &&
    filters.length === SIDEBAR_COORDINATES.length &&
    new Set(filters.map((filter) => filter?.["#d"]?.[0])).size ===
      SIDEBAR_COORDINATES.length &&
    filters.every(
      (filter) =>
        Array.isArray(filter?.kinds) &&
        filter.kinds.length === 1 &&
        filter.kinds[0] === 30078 &&
        Array.isArray(filter.authors) &&
        filter.authors.length === 1 &&
        filter.authors[0] === viewer &&
        Array.isArray(filter["#d"]) &&
        filter["#d"].length === 1 &&
        SIDEBAR_COORDINATES.includes(
          filter["#d"][0] as (typeof SIDEBAR_COORDINATES)[number],
        ) &&
        filter.limit === 1 &&
        (filter.consistency === undefined || filter.consistency === "strong") &&
        Object.keys(filter).every((key) =>
          ["kinds", "authors", "#d", "limit", "consistency"].includes(key),
        ),
    )
  );
}
export type SidebarGroups = Readonly<{
  sections: readonly Readonly<{
    id: string;
    name: string;
    icon?: string;
    order: number;
  }>[];
  assignments: Readonly<Record<string, string>>;
}>;
export type SidebarFilterMode = "all" | "unreads" | "active";
export const DEFAULT_ACTIVE_WINDOW_SECONDS = 30 * 86400;
export const MAX_ACTIVE_WINDOW_SECONDS = 365 * 86400;
export function validActiveWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 86400 &&
    value <= MAX_ACTIVE_WINDOW_SECONDS &&
    value % 86400 === 0
  );
}
export type SidebarFilterSettings = Readonly<{
  filters: Readonly<Record<string, SidebarFilterMode>>;
  activeWindowSeconds: Readonly<Record<string, number>>;
}>;
export type SidebarFilterMutator = (
  group: string,
  mode: SidebarFilterMode,
  sectionIds: readonly string[],
  signal: AbortSignal,
  activeWindowSeconds?: number | null,
) => Promise<SidebarFilterSettings>;
export type SidebarSortMutator = (
  group: string,
  mode: SidebarSortMode,
  sectionIds: readonly string[],
  signal: AbortSignal,
) => Promise<Readonly<Record<string, SidebarSortMode>>>;
export type SidebarMuteMutator = (
  intent: Readonly<{ channelId: string; muted: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarPreferences = SidebarGroups &
  Readonly<{
    starred: readonly string[];
    muted: readonly string[];
    sort?: Readonly<Record<string, SidebarSortMode>>;
    filters?: Readonly<Record<string, SidebarFilterMode>>;
    activeWindowSeconds?: Readonly<Record<string, number>>;
  }>;
export type SidebarAssignmentIntent = Readonly<{
  /** Omit only when creating an empty section. */
  channelId?: string;
  sectionId?: string;
  createSection?: Readonly<{ id: string; name: string; position?: "first" }>;
}>;
export type SidebarAssignmentMutator = (
  intent: SidebarAssignmentIntent,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarSectionRemovalMutator = (
  sectionId: string,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarSectionRenameMutator = (
  intent: Readonly<{ sectionId: string; name: string }>,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarSectionOrderMutator = (
  sectionIds: readonly string[],
  signal: AbortSignal,
) => Promise<SidebarGroups>;
/** Adds an empty section without assigning a conversation. */
export type SidebarSectionCreationMutator = (
  section: Readonly<{ id: string; name: string }>,
  signal: AbortSignal,
) => Promise<SidebarGroups>;
export type SidebarStarMutator = (
  intent: Readonly<{ channelId: string; starred: boolean }>,
  signal: AbortSignal,
) => Promise<readonly string[]>;
export type SidebarDecoder = (
  events: readonly RelayEvent[],
  signal: AbortSignal,
) => Promise<SidebarPreferences>;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sidebar preferences");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid sidebar preference text");
  return value;
}
/** Read-only legacy projection. Never merge, migrate, or publish account preferences. */
export function projectSidebarPreferences(
  sections: unknown,
  stars: unknown,
  mutes?: unknown,
  sort?: unknown,
  sortSectionIds?: readonly string[],
  filters?: unknown,
): SidebarPreferences {
  const result: {
    sections: { id: string; name: string; icon?: string; order: number }[];
    assignments: Record<string, string>;
    starred: string[];
    sort?: Record<string, SidebarSortMode>;
    filters?: Record<string, SidebarFilterMode>;
    activeWindowSeconds?: Record<string, number>;
    muted: string[];
  } = {
    sections: [],
    assignments: {},
    starred: [],
    muted: [],
  };
  if (sections !== undefined) {
    const data = projectSidebarRecord("channel-sections", object(sections));
    if (
      data.version !== 1 ||
      !Array.isArray(data.sections) ||
      data.sections.length > 100
    )
      throw new Error("Unsupported sidebar groups");
    const ids = new Set<string>();
    result.sections = data.sections
      .map((raw) => {
        const entry = object(raw);
        const id = text(entry.id);
        if (
          ids.has(id) ||
          typeof entry.order !== "number" ||
          !Number.isFinite(entry.order)
        )
          throw new Error("Invalid sidebar group order");
        ids.add(id);
        return {
          id,
          name: text(entry.name),
          order: entry.order,
          ...(entry.icon === undefined ? {} : { icon: text(entry.icon, 128) }),
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    const assignments = Object.entries(object(data.assignments));
    if (assignments.length > 1000)
      throw new Error("Sidebar assignment budget exceeded");
    result.assignments = Object.fromEntries(
      assignments
        .map(([id, section]) => [text(id), text(section)])
        .filter(([, section]) => ids.has(section as string)),
    );
  }
  if (stars !== undefined) {
    const data = object(stars);
    if (data.version !== 1) throw new Error("Unsupported sidebar stars");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Sidebar star budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.starred !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid sidebar star");
      if (entry.starred) result.starred.push(id);
    }
  }
  if (sort !== undefined) {
    const data = object(sort);
    if (data.version !== 1) throw new Error("Unsupported sidebar sort");
    const entries = Object.entries(projectSidebarSort(data));
    const fixed = new Set(["starred", "channels", "forums", "dms"]);
    const liveSections = new Set(
      (sortSectionIds ?? []).map((id) => `section:${id}`),
    );
    result.sort = Object.fromEntries(
      entries
        .filter((entry): entry is [string, SidebarSortMode] =>
          isSidebarSortMode(entry[1]),
        )
        .map(([key, mode]) => [text(key, 264), mode] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
  }
  if (filters !== undefined) {
    const data = projectSidebarRecord("channel-filter", object(filters));
    if (data.version !== 1) throw new Error("Unsupported sidebar filter");
    const entries = Object.entries(object(data.groups));
    if (entries.length > 104) throw new Error("Sidebar filter budget exceeded");
    const fixed = new Set(["starred", "channels", "forums", "dms"]);
    const liveSections = new Set(
      (sortSectionIds ?? []).map((id) => `section:${id}`),
    );
    if (
      entries.some(
        ([, mode]) => mode !== "all" && mode !== "unreads" && mode !== "active",
      )
    )
      throw new Error("Invalid sidebar filter mode");
    const windows = Object.entries(
      object(
        data.activeWindowSeconds === undefined ? {} : data.activeWindowSeconds,
      ),
    );
    if (
      windows.length > 104 ||
      windows.some(([, value]) => !validActiveWindow(value))
    )
      throw new Error("Invalid sidebar activity window");
    result.activeWindowSeconds = Object.fromEntries(
      windows
        .map(([key, value]) => [text(key, 264), value as number] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
    result.filters = Object.fromEntries(
      entries
        .filter(
          (entry): entry is [string, SidebarFilterMode] =>
            entry[1] === "all" ||
            entry[1] === "unreads" ||
            entry[1] === "active",
        )
        .map(([key, mode]) => [text(key, 264), mode] as const)
        .filter(
          ([key]) =>
            fixed.has(key) ||
            liveSections.has(key) ||
            (sortSectionIds === undefined &&
              key.startsWith("section:") &&
              key.length > 8),
        ),
    );
  }
  if (mutes !== undefined) {
    const data = object(mutes);
    if (data.version !== 1) throw new Error("Unsupported channel mutes");
    const entries = Object.entries(object(data.channels));
    if (entries.length > 500) throw new Error("Channel mute budget exceeded");
    for (const [id, raw] of entries) {
      text(id);
      const entry = object(raw);
      if (
        typeof entry.muted !== "boolean" ||
        typeof entry.updatedAt !== "number" ||
        !Number.isFinite(entry.updatedAt) ||
        entry.updatedAt < 0
      )
        throw new Error("Invalid channel mute");
      if (entry.muted) result.muted.push(id);
    }
  }
  return result;
}

export async function readSidebarPreferences(
  reader: RelayReader,
  viewer: string,
  decode: SidebarDecoder,
  signal: AbortSignal,
  consistency?: "strong",
): Promise<SidebarPreferences> {
  let events: readonly RelayEvent[];
  try {
    events = await reader.read(
      SIDEBAR_COORDINATES.map((coordinate) => ({
        kinds: [30078],
        authors: [viewer],
        "#d": [coordinate],
        limit: 1,
        ...(consistency ? { consistency } : {}),
      })),
      {
        signal,
        priority: "foreground",
        ...(consistency ? { fresh: true } : {}),
      },
    );
    signal.throwIfAborted();
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference query: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  try {
    const result = await decode(events, signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    const cause = signal.aborted ? signal.reason : error;
    if (cause instanceof Error && cause.name === "AbortError") throw cause;
    throw new Error(
      `Preference decode: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
