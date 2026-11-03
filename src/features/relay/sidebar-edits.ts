import { isSidebarSortMode } from "./sidebar-sort.ts";
import {
  projectSidebarPreferences,
  validActiveWindow,
  DEFAULT_ACTIVE_WINDOW_SECONDS,
  type SidebarAssignmentIntent,
  type SidebarGroups,
  type SidebarSortMode,
  type SidebarFilterMode,
} from "./sidebar-preferences.ts";
import {
  editSidebarRecord,
  editSidebarSortRecord,
  nextSidebarSectionOrder,
  projectSidebarRecord,
} from "./sidebar-registers.ts";

/** Tombstone the section and reset its live placements in the same record. */
export function editSidebarSectionRemoval(
  current: Record<string, unknown>,
  createdAt: number,
  sectionId: string,
  now = Date.now(),
): Record<string, unknown> {
  const projected = projectSidebarRecord("channel-sections", current);
  const sections = projected.sections as SidebarGroups["sections"];
  if (!sections.some(({ id }) => id === sectionId)) return current;
  const writes: [string[], unknown][] = [[["s", sectionId, "live"], false]];
  for (const [channelId, id] of Object.entries(
    projected.assignments as SidebarGroups["assignments"],
  ))
    if (id === sectionId) writes.push([["a", channelId], null]);
  return editSidebarRecord("channel-sections", current, createdAt, writes, now);
}

/** Rewrite only the live section's name register; other fields stay untouched. */
export function editSidebarSectionRename(
  current: Record<string, unknown>,
  createdAt: number,
  sectionId: string,
  name: string,
  now = Date.now(),
): Record<string, unknown> {
  const sections = projectSidebarRecord("channel-sections", current)
    .sections as SidebarGroups["sections"];
  const section = sections.find(({ id }) => id === sectionId);
  if (!section) throw new Error("Sidebar section no longer exists");
  const next = name.trim();
  if (section.name === next) return current;
  return editSidebarRecord(
    "channel-sections",
    current,
    createdAt,
    [[["s", sectionId, "name"], next]],
    now,
  );
}

/** Requested live sections first, then unlisted live ones; every order is restamped. */
export function editSidebarSectionOrder(
  current: Record<string, unknown>,
  createdAt: number,
  sectionIds: readonly string[],
  now = Date.now(),
): Record<string, unknown> {
  const live = projectSidebarPreferences(current, undefined).sections.map(
    ({ id }) => id,
  );
  const wanted = new Set(sectionIds.filter((id) => live.includes(id)));
  const ids = [...wanted, ...live.filter((id) => !wanted.has(id))];
  return editSidebarRecord(
    "channel-sections",
    current,
    createdAt,
    ids.map((id, index) => [["s", id, "order"], index]),
    now,
    true,
  );
}

// Typed intent policy; host adapters retain untrusted-envelope validation.
export function validSidebarChannelId(channelId: string): boolean {
  return !!channelId.trim() && channelId.length <= 256;
}

export function validSidebarAssignment(
  intent: SidebarAssignmentIntent,
): boolean {
  const { channelId, sectionId, createSection } = intent;
  return (
    (channelId === undefined
      ? !!createSection
      : validSidebarChannelId(channelId)) &&
    (sectionId === undefined || validSidebarChannelId(sectionId)) &&
    (!createSection ||
      (sectionId === undefined &&
        /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(createSection.id) &&
        validSidebarChannelId(createSection.name) &&
        (createSection.position === undefined ||
          createSection.position === "first")))
  );
}

export function validSidebarSectionRemoval(sectionId: string): boolean {
  return validSidebarChannelId(sectionId);
}

export function validSidebarSectionRename(
  sectionId: string,
  name: string,
): boolean {
  return validSidebarChannelId(sectionId) && validSidebarChannelId(name);
}

export function validSidebarSectionOrder(
  sectionIds: readonly string[],
): boolean {
  return (
    sectionIds.length <= 100 &&
    sectionIds.every(validSidebarChannelId) &&
    new Set(sectionIds).size === sectionIds.length
  );
}

export function validSidebarSort(
  group: string,
  mode: SidebarSortMode,
  sectionIds: readonly string[],
): boolean {
  return (
    group.length <= 264 &&
    isSidebarSortMode(mode) &&
    sectionIds.length <= 100 &&
    sectionIds.every(validSidebarChannelId) &&
    (["starred", "channels", "forums", "dms"].includes(group) ||
      (group.startsWith("section:") && sectionIds.includes(group.slice(8))))
  );
}

export function validSidebarFilter(
  group: string,
  mode: SidebarFilterMode,
  sectionIds: readonly string[],
  activeWindowSeconds?: number | null,
): boolean {
  return (
    ["all", "unreads", "active"].includes(mode) &&
    (activeWindowSeconds === undefined ||
      (activeWindowSeconds === null
        ? mode === "all"
        : mode === "active" && validActiveWindow(activeWindowSeconds))) &&
    validSidebarSort(group, "alpha", sectionIds)
  );
}

// Pure edits of validated, projected heads. Hosts retain validation, signing,
// publication, readback and serialization; these functions never perform I/O.
export function editSidebarAssignment(
  current: Record<string, unknown>,
  createdAt: number,
  intent: SidebarAssignmentIntent,
  now = Date.now(),
): Record<string, unknown> {
  const { channelId, sectionId, createSection } = intent;
  const section = createSection?.id ?? sectionId;
  const existing = current.sections as SidebarGroups["sections"];
  const sections = [...existing];
  if (createSection) {
    const name = createSection.name.trim();
    const found = sections.find((entry) => entry.id === section);
    // Retrying an unknown publication retains the ID, never duplicates or renames.
    if (found && found.name !== name)
      throw new Error("The new section changed; reload and try again");
    if (!found)
      sections.push({
        id: createSection.id,
        name,
        order: nextSidebarSectionOrder(current, createSection.position),
      });
  }
  if (section !== undefined && !sections.some((entry) => entry.id === section))
    throw new Error("Sidebar group no longer exists");
  const writes: [string[], unknown][] =
    channelId === undefined ? [] : [[["a", channelId], section ?? null]];
  if (createSection && !existing.some(({ id }) => id === section)) {
    const added = sections.find(({ id }) => id === section);
    if (!added) throw new Error("Sidebar group no longer exists");
    writes.push(
      [["s", added.id, "name"], added.name],
      [["s", added.id, "icon"], null],
      [["s", added.id, "order"], added.order],
      [["s", added.id, "live"], true],
    );
  }
  return editSidebarRecord("channel-sections", current, createdAt, writes, now);
}

export function editSidebarSort(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarSortMode,
  now = Date.now(),
): Record<string, unknown> {
  return editSidebarSortRecord(current, createdAt, group, mode, now);
}

export function editSidebarFilter(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarFilterMode,
  now = Date.now(),
  activeWindowSeconds?: number | null,
): Record<string, unknown> {
  const windows = {
    ...(current.activeWindowSeconds as Record<string, number> | undefined),
  };
  const previous = windows[group] ?? DEFAULT_ACTIVE_WINDOW_SECONDS;
  const changed =
    activeWindowSeconds === null
      ? Object.hasOwn(windows, group)
      : activeWindowSeconds !== undefined && previous !== activeWindowSeconds;
  if (activeWindowSeconds === null) delete windows[group];
  else if (activeWindowSeconds !== undefined)
    windows[group] = activeWindowSeconds;
  const next = editSidebarRecord(
    "channel-filter",
    current,
    createdAt,
    [[["g", group], mode === "all" ? null : mode]],
    now,
  );
  return changed ? { ...next, activeWindowSeconds: windows } : next;
}

export function editSidebarToggle(
  current: Record<string, unknown>,
  channelId: string,
  field: "starred" | "muted",
  enabled: boolean,
  now = Date.now(),
): Record<string, unknown> {
  const channels = current.channels as Record<string, Record<string, unknown>>;
  const previous = Object.hasOwn(channels, channelId)
    ? channels[channelId]
    : undefined;
  // Absent unstars are satisfied; unmute must persist its explicit tombstone.
  if (
    previous?.[field] === enabled ||
    (!previous && !enabled && field === "starred")
  )
    return current;
  return {
    ...current,
    channels: {
      ...channels,
      [channelId]: {
        ...previous,
        [field]: enabled,
        updatedAt: Math.max(now, Number(previous?.updatedAt ?? 0) + 1),
      },
    },
  };
}
