export type SidebarSortMode = "alpha" | "recent" | `plugin:${string}`;

export function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return (
    value === "alpha" ||
    value === "recent" ||
    (typeof value === "string" &&
      value.length <= 512 &&
      /^plugin:[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(
        value,
      ))
  );
}

export function sidebarSortNeedsActivity(mode: SidebarSortMode): boolean {
  return mode === "recent" || mode.startsWith("plugin:");
}
