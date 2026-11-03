import { isSidebarSortMode, type SidebarSortMode } from "./sidebar-sort.ts";

/** Section and section-choice registers. No persistence or publication owner. */
export type SidebarRegister = [number, string, unknown];
type Tree = { [key: string]: Tree | SidebarRegister };
type Coordinate = "channel-sections" | "channel-sort" | "channel-filter";
const legacyDevice = "0".repeat(16);
let device: string | undefined;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid sidebar metadata");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max = 256) =>
  typeof value === "string" && !!value.trim() && value.length <= max;
const own = (value: Tree, key: string) =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const sectionFields = {
  name: (v: unknown) => text(v),
  icon: (v: unknown) => v === null || text(v, 128),
  order: (v: unknown) => Number.isSafeInteger(v),
  live: (v: unknown) => typeof v === "boolean",
};
function register(
  value: unknown,
  valid: (value: unknown) => boolean,
): SidebarRegister {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    !Number.isSafeInteger(value[0]) ||
    value[0] < 0 ||
    typeof value[1] !== "string" ||
    !/^[0-9a-f]{16}$/.test(value[1]) ||
    !valid(value[2])
  )
    throw new Error("Invalid sidebar register");
  return value as SidebarRegister;
}
function map(
  value: unknown,
  max: number,
  parse: (value: unknown) => Tree | SidebarRegister,
): Tree {
  const entries = Object.entries(object(value));
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (!text(key, max) || key === "__proto__")
        throw new Error("Invalid sidebar metadata key");
      return [key, parse(value)];
    }),
  );
}
function metadata(
  coordinate: Coordinate,
  value: unknown,
  reading = false,
): Tree {
  const data = object(value);
  // Desktop retains unrestricted text on deleted sections. Read its wire shape;
  // UI text limits apply to the live projection, not nonprojecting tombstones.
  // Writers keep strict admission and never rewrite a partially understood tree.
  const fieldsFor = reading
    ? {
        ...sectionFields,
        name: (v: unknown) => typeof v === "string",
        icon: (v: unknown) => v === null || typeof v === "string",
      }
    : sectionFields;
  // Tombstones outlive live projection caps. Bound all retained nodes by bytes,
  // not the number of currently visible sections/sort overrides.
  if (new TextEncoder().encode(JSON.stringify(data)).length > 128 * 1024)
    throw new Error("Sidebar metadata budget exceeded");
  const allowed =
    coordinate === "channel-sections" ? ["v", "s", "a"] : ["v", "g"];
  if (data.v !== 1 || Object.keys(data).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported sidebar metadata");
  if (coordinate !== "channel-sections")
    return {
      g: map(data.g === undefined ? {} : data.g, 264, (v) =>
        register(
          v,
          (v) =>
            v === null ||
            (coordinate === "channel-filter"
              ? v === "unreads" || v === "active"
              : v === "alpha" || v === "recent"),
        ),
      ),
    };
  return {
    s: map(data.s === undefined ? {} : data.s, 256, (value) => {
      const fields = object(value);
      return Object.fromEntries(
        Object.entries(fields).map(([key, value]) => {
          if (!Object.hasOwn(sectionFields, key))
            throw new Error("Invalid sidebar section register");
          return [
            key,
            register(value, fieldsFor[key as keyof typeof fieldsFor]),
          ];
        }),
      );
    }),
    a: map(data.a === undefined ? {} : data.a, 256, (v) =>
      register(v, (v) => v === null || text(v)),
    ),
  };
}
const val = (node: Tree, key: string) => {
  const entry = own(node, key);
  return Array.isArray(entry) ? entry[2] : undefined;
};
function projection(coordinate: Coordinate, tree: Tree) {
  if (coordinate !== "channel-sections")
    return {
      groups: Object.fromEntries(
        Object.entries(tree.g ?? {}).flatMap(([key, reg]) =>
          Array.isArray(reg) && reg[2] !== null ? [[key, reg[2]]] : [],
        ),
      ),
    };
  const sections = Object.entries(tree.s ?? {})
    .filter(
      ([, node]) =>
        val(node as Tree, "live") === true &&
        typeof val(node as Tree, "name") === "string",
    )
    .map(([id, node]) => {
      const fields = node as Tree;
      const icon = val(fields, "icon");
      return {
        id,
        name: val(fields, "name"),
        order: Number(val(fields, "order") ?? 0),
        ...(typeof icon === "string" && icon ? { icon } : {}),
      };
    })
    .sort(
      (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .map((section, order) => ({ ...section, order }));
  const live = new Set(sections.map(({ id }) => id));
  return {
    sections,
    assignments: Object.fromEntries(
      Object.entries(tree.a ?? {}).flatMap(([key, reg]) =>
        Array.isArray(reg) && typeof reg[2] === "string" && live.has(reg[2])
          ? [[key, reg[2]]]
          : [],
      ),
    ),
  };
}
/** Metadata is authoritative; never trust a conflicting legacy projection. */
export function projectSidebarRecord(
  coordinate: Coordinate,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (value.meta === undefined) return value;
  return {
    ...value,
    ...projection(coordinate, metadata(coordinate, value.meta, true)),
  };
}
function importLegacy(
  coordinate: Coordinate,
  value: Record<string, unknown>,
  createdAt: number,
): Tree {
  const stamp = (v: unknown): SidebarRegister => [
    createdAt * 1000,
    legacyDevice,
    v,
  ];
  if (coordinate !== "channel-sections")
    return {
      g: Object.fromEntries(
        Object.entries(object(value.groups))
          .filter(([, v]) =>
            coordinate === "channel-filter"
              ? v === "unreads" || v === "active"
              : v === "alpha" || v === "recent",
          )
          .map(([key, v]) => [key, stamp(v)]),
      ),
    };
  const sections = value.sections as {
    id: string;
    name: string;
    order: number;
    icon?: string;
  }[];
  const live = new Set(sections.map(({ id }) => id));
  return {
    s: Object.fromEntries(
      sections.map(({ id, name, order, icon }) => [
        id,
        {
          name: stamp(name),
          icon: stamp(icon ?? null),
          order: stamp(Math.round(order)),
          live: stamp(true),
        },
      ]),
    ),
    a: Object.fromEntries(
      Object.entries(object(value.assignments))
        .filter(([, v]) => live.has(v as string))
        .map(([key, v]) => [key, stamp(v)]),
    ),
  };
}
function maxVersion(tree: Tree): number {
  return Object.values(tree).reduce(
    (max, v) => Math.max(max, Array.isArray(v) ? v[0] : maxVersion(v)),
    0,
  );
}
/**
 * Apply only the requested leaves; preserve every other register and tombstone.
 * With `all`, any change restamps every requested leaf (a whole-list reorder).
 */
export function editSidebarRecord(
  coordinate: Coordinate,
  current: Record<string, unknown>,
  createdAt: number,
  writes: readonly (readonly [readonly string[], unknown])[],
  now = Date.now(),
  all = false,
): Record<string, unknown> {
  const tree =
    current.meta === undefined
      ? importLegacy(coordinate, current, createdAt)
      : metadata(coordinate, current.meta, true);
  const changed = writes.filter(([path, value]) => {
    let node: Tree | SidebarRegister | undefined = tree;
    for (const key of path)
      node = node && !Array.isArray(node) ? own(node, key) : undefined;
    // Removing an unprojected assignment is already satisfied at the fresh head,
    // including a retained reference to a deleted section. Do not rewrite it.
    if (
      value === null &&
      coordinate === "channel-sections" &&
      path.length === 2 &&
      path[0] === "a" &&
      path[1] !== undefined &&
      !Object.hasOwn(projection(coordinate, tree).assignments ?? {}, path[1])
    )
      return false;
    return !Array.isArray(node) || node[2] !== value;
  });
  if (!changed.length) return current;
  device ??= Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const version = Math.max(now, maxVersion(tree) + 1);
  if (!Number.isSafeInteger(version))
    throw new Error("Sidebar register clock exhausted");
  for (const [path, value] of all ? writes : changed) {
    let node = tree;
    for (const key of path.slice(0, -1)) {
      const child = own(node, key);
      if (Array.isArray(child))
        throw new Error("Invalid sidebar register path");
      if (!child)
        Object.defineProperty(node, key, {
          value: {},
          enumerable: true,
          writable: true,
          configurable: true,
        });
      node = own(node, key) as Tree;
    }
    const key = path.at(-1);
    if (!key) throw new Error("Invalid sidebar register path");
    Object.defineProperty(node, key, {
      value: [version, device, value],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  // Validate edited metadata too; callers enforce live projection and payload caps.
  const meta = { v: 1, ...tree };
  const projected = projection(coordinate, metadata(coordinate, meta));
  return { ...current, ...projected, meta };
}

function pluginSortRegisters(value: unknown): Tree {
  if (value === undefined) return {};
  const data = object(value);
  if (
    data.v !== 1 ||
    Object.keys(data).some((key) => !["v", "g"].includes(key))
  )
    throw new Error("Unsupported plugin sidebar sort");
  const groups = map(data.g, 264, (value) =>
    register(
      value,
      (mode) =>
        typeof mode === "string" &&
        mode.startsWith("plugin:") &&
        isSidebarSortMode(mode),
    ),
  );
  if (Object.keys(groups).length > 104)
    throw new Error("Plugin sidebar sort budget exceeded");
  return groups;
}

/** Plugin choices stay outside the strict metadata understood by older hosts. */
export function projectSidebarSort(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const projected = projectSidebarRecord("channel-sort", value);
  const groups = { ...object(projected.groups) };
  if (Object.keys(groups).length > 104)
    throw new Error("Sidebar sort budget exceeded");
  const base =
    value.meta === undefined
      ? {}
      : (metadata("channel-sort", value.meta, true).g as Tree);
  for (const [key, choice] of Object.entries(
    pluginSortRegisters(value.pluginSort),
  )) {
    const bound = own(base, key);
    if (
      Array.isArray(choice) &&
      Array.isArray(bound) &&
      (bound[2] === "alpha" || bound[2] === null) &&
      choice[0] === bound[0] &&
      choice[1] === bound[1]
    )
      Object.defineProperty(groups, key, {
        value: choice[2],
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return groups;
}

export function editSidebarSortRecord(
  current: Record<string, unknown>,
  createdAt: number,
  group: string,
  mode: SidebarSortMode,
  now: number,
): Record<string, unknown> {
  const choices = pluginSortRegisters(current.pluginSort);
  const previousCount = Object.keys(choices).length;
  const plugin = mode.startsWith("plugin:");
  const source =
    plugin && current.meta === undefined
      ? {
          ...current,
          meta: { v: 1, ...importLegacy("channel-sort", current, createdAt) },
        }
      : current;
  // Older A–Z writers tombstone with null and skip equal values. A distinct
  // alpha anchor lets their explicit choice supersede the plugin binding.
  const next = editSidebarRecord(
    "channel-sort",
    source,
    createdAt,
    [[["g", group], plugin ? "alpha" : mode === "recent" ? "recent" : null]],
    now,
  );
  const base =
    next.meta === undefined
      ? {}
      : (metadata("channel-sort", next.meta, true).g as Tree);
  // Section presence is a separate record; a caller snapshot cannot prove deletion.
  for (const [key, choice] of Object.entries(choices)) {
    const bound = own(base, key);
    if (
      !Array.isArray(choice) ||
      !Array.isArray(bound) ||
      (bound[2] !== "alpha" && bound[2] !== null) ||
      choice[0] !== bound[0] ||
      choice[1] !== bound[1]
    )
      delete choices[key];
  }
  const pruned = Object.keys(choices).length !== previousCount;
  if (plugin) {
    const bound = own(base, group) as SidebarRegister;
    const previous = own(choices, group);
    if (
      next === current &&
      !pruned &&
      Array.isArray(previous) &&
      previous[0] === bound[0] &&
      previous[1] === bound[1] &&
      previous[2] === mode
    )
      return current;
    Object.defineProperty(choices, group, {
      value: [bound[0], bound[1], mode],
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    if (!Object.hasOwn(choices, group) && !pruned) return next;
    delete choices[group];
  }
  const pluginSort = { v: 1, g: choices };
  pluginSortRegisters(pluginSort);
  return { ...next, pluginSort };
}

/** Insertion uses canonical orders, not the densely numbered legacy projection. */
export function nextSidebarSectionOrder(
  current: Record<string, unknown>,
  position: "first" | "last" = "last",
): number {
  const orders =
    current.meta === undefined
      ? (current.sections as { order: number }[]).map(({ order }) =>
          Math.round(order),
        )
      : Object.values(metadata("channel-sections", current.meta).s as Tree)
          .filter((node) => val(node as Tree, "live") === true)
          .map((node) => Number(val(node as Tree, "order") ?? 0));
  return position === "first"
    ? Math.min(0, ...orders) - 1
    : Math.max(-1, ...orders) + 1;
}
