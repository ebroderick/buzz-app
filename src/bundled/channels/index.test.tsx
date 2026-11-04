// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { apply } from "./index";

vi.mock("./canvas-panel", () => ({ registerCanvas: () => {} }));

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});
function registered() {
  const shortcuts = { register: vi.fn() };
  apply({
    shortcuts,
    conversation: {
      registerCompletion() {},
      registerTabs() {},
      registerMessageAction() {},
    },
    settingsCards: { register() {} },
    pages: { register() {} },
    navigation: {},
    relay: {},
    panels: {},
    agents: {},
    adminAccess: { membership: undefined },
    communityReader: {},
  } as unknown as Parameters<typeof apply>[0]);
  return new Map(
    shortcuts.register.mock.calls.map(([shortcut]) => [shortcut.id, shortcut]),
  );
}
function sidebar(...rows: string[]) {
  document.body.innerHTML = `<nav aria-label="Subscribed channels">${rows
    .map(
      (row) =>
        `<button data-channel-id="${row.replace("*", "")}" ${row.startsWith("*") ? 'aria-current="page"' : ""}>${row}</button>`,
    )
    .join("")}</nav>`;
}

it.each([
  ["previous-conversation", "ArrowUp", false],
  ["next-conversation", "ArrowDown", false],
  ["previous-unread-conversation", "ArrowUp", true],
  ["next-unread-conversation", "ArrowDown", true],
])("registers %s as Option+Arrow that works while typing", (id, key, shift) => {
  const shortcut = registered().get(id);
  expect(shortcut).toMatchObject({
    binding: { key, alt: true, shift },
    allowInEditable: true,
  });
  expect(shortcut.allowInModal).toBeUndefined();
});

it("steps only while the sidebar renders rows, and not from a terminal", () => {
  const next = registered().get("next-conversation");
  expect(next.when()).toBe(false);
  sidebar("a", "*b", "c");
  expect(next.when()).toBe(true);
  const clicked = vi.fn();
  document
    .querySelector('[data-channel-id="c"]')
    ?.addEventListener("click", clicked);
  next.run();
  expect(clicked).toHaveBeenCalledOnce();
  document.body.insertAdjacentHTML(
    "beforeend",
    '<div class="xterm"><textarea id="term"></textarea></div>',
  );
  document.querySelector<HTMLElement>("#term")?.focus();
  expect(next.when()).toBe(false);
});

it("registers a plain Escape that waits for an open conversation to mark read", () => {
  const shortcut = registered().get("mark-read");
  expect(shortcut).toMatchObject({
    binding: { key: "Escape" },
    allowInEditable: true,
  });
  expect(shortcut.allowInModal).toBeUndefined();
  expect(shortcut.when()).toBe(false);
  expect(() => shortcut.run()).not.toThrow();
});
