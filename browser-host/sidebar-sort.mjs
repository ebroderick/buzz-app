import {
  editSidebarSort,
  editSidebarFilter,
  validSidebarSort,
  validSidebarFilter,
} from "../src/features/relay/sidebar-edits.ts";
import { projectSidebarRecord } from "../src/features/relay/sidebar-registers.ts";
import { finalizeEvent, getPublicKey, nip44, verifyEvent } from "nostr-tools";
import { projectSidebarPreferences } from "../src/features/relay/sidebar-preferences.ts";
import { SIDEBAR_REQUEST_BYTES } from "./sidebar-preferences.mjs";

export const {
  assertIntent: assertSidebarSortIntent,
  prepare: prepareSidebarSort,
  mutate: mutateSidebarSort,
} = sectionChoice("channel-sort", validSidebarSort, editSidebarSort, "sort");
export const {
  assertIntent: assertSidebarFilterIntent,
  prepare: prepareSidebarFilter,
  mutate: mutateSidebarFilter,
} = sectionChoice(
  "channel-filter",
  validSidebarFilter,
  editSidebarFilter,
  "filters",
);

// Both section choices use the same bounded encrypted read/edit/confirm contract.
function sectionChoice(coordinate, validIntent, edit, field) {
  const label = field === "sort" ? "sort" : "filter";
  const project = (blob, sectionIds) =>
    projectSidebarPreferences(
      undefined,
      undefined,
      undefined,
      field === "sort" ? blob : undefined,
      sectionIds,
      field === "filters" ? blob : undefined,
    );

  function assertIntent(intent) {
    if (
      !intent ||
      typeof intent !== "object" ||
      Array.isArray(intent) ||
      typeof intent.group !== "string" ||
      !Array.isArray(intent.sectionIds) ||
      intent.sectionIds.some((id) => typeof id !== "string") ||
      !validIntent(
        intent.group,
        intent.mode,
        intent.sectionIds,
        intent.activeWindowSeconds,
      ) ||
      Object.keys(intent).some(
        (key) =>
          ![
            "group",
            "mode",
            "sectionIds",
            ...(field === "filters" ? ["activeWindowSeconds"] : []),
          ].includes(key),
      )
    )
      throw new Error(`Invalid sidebar ${label} intent`);
  }
  function parseHead(events, secret, sectionIds) {
    if (
      !Array.isArray(events) ||
      events.length > 1 ||
      Buffer.byteLength(JSON.stringify(events)) > SIDEBAR_REQUEST_BYTES
    )
      throw new Error(`Invalid sidebar ${label} head`);
    if (!events.length)
      return { blob: { version: 1, groups: {} }, createdAt: 0 };
    const [event] = events;
    const viewer = getPublicKey(secret);
    const tags = event?.tags?.filter?.(
      (tag) => Array.isArray(tag) && tag[0] === "d",
    );
    if (
      event?.kind !== 30078 ||
      event.pubkey !== viewer ||
      tags?.length !== 1 ||
      tags[0]?.[1] !== coordinate ||
      typeof event.content !== "string" ||
      !verifyEvent(event)
    )
      throw new Error(`Invalid sidebar ${label} head`);
    const key = nip44.v2.utils.getConversationKey(secret, viewer);
    try {
      const plaintext = nip44.v2.decrypt(event.content, key);
      if (Buffer.byteLength(plaintext) > 128 * 1024)
        throw new Error("Sidebar plaintext budget exceeded");
      const blob = JSON.parse(plaintext);
      project(blob, sectionIds);
      return {
        blob: projectSidebarRecord(coordinate, blob),
        createdAt: event.created_at,
      };
    } finally {
      key.fill(0);
    }
  }
  // Each choice uses one encrypted whole-blob LWW record, not per-group
  // conflict resolution. Only choices present in this read can be preserved.
  function prepare(events, intent, secret, now = Date.now()) {
    assertIntent(intent);
    const viewer = getPublicKey(secret);
    const current = parseHead(events, secret, intent.sectionIds);
    const blob = edit(
      current.blob,
      current.createdAt,
      intent.group,
      intent.mode,
      now,
      field === "filters" ? intent.activeWindowSeconds : undefined,
    );
    const projected = project(blob, intent.sectionIds);
    if (Buffer.byteLength(JSON.stringify(blob)) > 128 * 1024)
      throw new Error("Sidebar plaintext budget exceeded");
    const result = {
      groups: projected[field] ?? {},
      ...(field === "filters"
        ? { activeWindowSeconds: projected.activeWindowSeconds ?? {} }
        : {}),
    };
    if (blob === current.blob) return result;
    const key = nip44.v2.utils.getConversationKey(secret, viewer);
    let content;
    try {
      content = nip44.v2.encrypt(JSON.stringify(blob), key);
    } finally {
      key.fill(0);
    }
    return {
      ...result,
      event: finalizeEvent(
        {
          kind: 30078,
          content,
          created_at: Math.max(Math.floor(now / 1000), current.createdAt + 1),
          tags: [
            ["d", coordinate],
            ["t", coordinate],
          ],
        },
        secret,
      ),
    };
  }
  async function mutate(intent, secret, readHead, publish) {
    assertIntent(intent);
    const draft = prepare(await readHead(), intent, secret);
    const result = (value) =>
      field === "filters"
        ? {
            filters: value.groups,
            activeWindowSeconds: value.activeWindowSeconds,
          }
        : value.groups;
    if (!draft.event) return result(draft);
    await publish(draft.event);
    // This checks only the requested group now, not whether the whole-blob write
    // lost another device's intervening change to an unrelated group.
    const heads = await readHead();
    const confirmation =
      field === "sort"
        ? {
            groups:
              project(
                parseHead(heads, secret, intent.sectionIds).blob,
                intent.sectionIds,
              ).sort ?? {},
          }
        : prepare(heads, intent, secret);
    if (
      field === "sort"
        ? (confirmation.groups[intent.group] ?? "alpha") !== intent.mode
        : confirmation.event
    )
      throw new Error(
        `Sidebar ${label} changed on another device; reload and try again`,
      );
    return result(confirmation);
  }

  return { assertIntent, prepare, mutate };
}
