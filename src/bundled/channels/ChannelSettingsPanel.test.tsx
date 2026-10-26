// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelSettingsPanel } from "./ChannelSettingsPanel";
import type { ChannelSummary } from "../../features/relay/contracts";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import { PublishRejected } from "../../features/relay/outbox";
import type { Role } from "../../features/communities/roster";
import type { CommunityMembership } from "../moderation/membership";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows known channel details with diagnostics collapsed until requested", async () => {
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{
        id: "alpha",
        name: "Alpha",
        channelType: "stream",
        members: ["one", "two"],
      }}
      close={() => {}}
    >
      <button type="button">Refresh messages</button>
    </ChannelSettingsPanel>,
  );
  expect(
    screen.getByRole("complementary", { name: "Channel settings" }),
  ).toBeVisible();
  expect(screen.getByRole("heading", { name: "Alpha" })).toBeVisible();
  expect(screen.getByText("alpha")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Canvas" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(screen.getByText("2")).toBeVisible();
  expect(screen.queryByText("Who can contribute")).not.toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Channel settings" })).toHaveFocus();
  expect(screen.getByText("Refresh messages")).not.toBeVisible();
  await user.click(screen.getByText("Diagnostics"));
  expect(
    screen.getByRole("button", { name: "Refresh messages" }),
  ).toBeVisible();
});

it("closes with Escape or its close button without swallowing other keys", async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={undefined}
      close={close}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  await user.keyboard("{ArrowDown}");
  expect(close).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
  await user.click(
    screen.getByRole("button", { name: "Close Channel settings tab" }),
  );
  expect(close).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("tab", { name: "Channel settings" }));
  await user.keyboard("{Delete}");
  expect(close).toHaveBeenCalledTimes(3);
});

it("does not invent unknown metadata and still exposes diagnostics without a channel", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ id: "dm", name: "Someone", channelType: "dm" }}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel type")).not.toBeInTheDocument();
  expect(screen.queryByText("Members")).not.toBeInTheDocument();
  // The identity icon follows the sidebar: a chat bubble, not a hash.
  expect(document.querySelector(".tabler-icon-message-circle")).toBeVisible();
  expect(document.querySelector(".tabler-icon-hash")).toBeNull();
  rerender(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={undefined}
      close={() => {}}
    >
      Diagnostics content
    </ChannelSettingsPanel>,
  );
  expect(screen.queryByText("Channel ID")).not.toBeInTheDocument();
  await user.click(screen.getByText("Diagnostics"));
  expect(screen.getByText("Diagnostics content")).toBeVisible();
});

it("opens even an empty members list without an Edit ingress", async () => {
  const openMembers = vi.fn();
  const user = userEvent.setup();
  render(
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ id: "alpha", name: "Alpha", members: [] }}
      openMembers={openMembers}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>,
  );
  const members = screen.getByRole("button", { name: "View members" });
  expect(members).toHaveAccessibleDescription("0");
  expect(members).not.toHaveTextContent("Edit");
  expect(members.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  members.focus();
  await user.keyboard("{Enter}");
  expect(openMembers).toHaveBeenCalledWith(members);
});

function idPanel(id = "11111111-1111-4111-8111-111111111111") {
  return (
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={{ id, name: "Alpha" }}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>
  );
}

it("copies the exact channel ID with keyboard access and reports success", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  render(idPanel());
  const copy = screen.getByRole("button", { name: "Copy channel id" });
  expect(copy).toHaveAttribute("aria-haspopup", "false");
  expect(copy).toHaveTextContent(/^Channel ID$/);
  expect(copy.querySelector("svg")?.parentElement).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  expect(copy.querySelector("svg")).toHaveAttribute("width", "0.875rem");
  await user.hover(copy);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  copy.focus();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(write).toHaveBeenCalledExactlyOnceWith(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Channel ID copied",
  );
  expect(copy).toHaveFocus();
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
  );
  await user.unhover(copy);
  await user.hover(copy);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});

it("keeps the ID visible after clipboard denial and supports retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue();
  render(idPanel("alpha"));
  const copy = screen.getByRole("button", { name: "Copy channel id" });
  await user.click(copy);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t copy channel ID. Try again.",
  );
  expect(screen.getByText("alpha")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Canvas" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(copy).toBeEnabled();
  await user.click(copy);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "Channel ID copied",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(write).toHaveBeenCalledTimes(2);
});

it("reports an unavailable clipboard without throwing", async () => {
  const user = userEvent.setup();
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  if (!descriptor) throw new Error("Missing clipboard test stub");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  try {
    render(idPanel());
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn’t copy channel ID.",
    );
  } finally {
    Object.defineProperty(navigator, "clipboard", descriptor);
  }
});

it.each(["resolve", "reject"])(
  "does not show stale copy feedback after changing channels (%s)",
  async (outcome) => {
    const user = userEvent.setup();
    let resolve!: () => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const write = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(pending)
      .mockResolvedValue();
    const { rerender } = render(idPanel("alpha"));
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    try {
      expect(
        screen.getByRole("button", { name: "Copy channel id" }),
      ).toHaveAttribute("aria-disabled", "true");
      rerender(idPanel("beta"));
      expect(
        screen.getByRole("button", { name: "Copy channel id" }),
      ).toBeEnabled();
    } finally {
      await act(async () =>
        outcome === "resolve" ? resolve() : reject(new Error("denied")),
      );
    }
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy channel id" }));
    expect(write).toHaveBeenLastCalledWith("beta");
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Channel ID copied",
    );
  },
);

function lifecycle(available = true) {
  return {
    available,
    load: vi.fn(),
    run: vi.fn<ChannelLifecycleCapability["run"]>(async () => {}),
    snapshot: () => ({ status: "ready", hidden: [] }),
    subscribe: () => () => {},
    observeRemoval: () => () => {},
    refreshVisibility: async () => {},
  } satisfies ChannelLifecycleCapability;
}
function membership(role: Role | undefined) {
  const release = vi.fn();
  return {
    snapshot: () => ({
      status: "ready",
      members: [],
      ...(role ? { role } : {}),
      refreshing: false,
    }),
    subscribe: () => () => true,
    ensure: vi.fn(() => release),
    refresh: async () => {},
    dispose: () => {},
    release,
  } satisfies CommunityMembership & { release: unknown };
}
const publicStream: ChannelSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Alpha",
  channelType: "stream",
  visibility: "public",
  members: ["one"],
};
function autoJoinPanel(
  channel: ChannelSummary,
  role: Role | undefined,
  capability = lifecycle(),
  roster: CommunityMembership | null = membership(role),
) {
  return (
    <ChannelSettingsPanel
      scope="community:viewer"
      channel={channel}
      lifecycle={capability}
      membership={roster ?? undefined}
      close={() => {}}
    >
      Diagnostics
    </ChannelSettingsPanel>
  );
}
const autoJoinSwitch = () =>
  screen.getByRole("switch", { name: "Starter channel for new members" });
const noAutoJoinSwitch = () =>
  expect(
    screen.queryByRole("switch", { name: "Starter channel for new members" }),
  ).not.toBeInTheDocument();

// [case, channel, community role, switch shown, roster read held]
it.each<[string, ChannelSummary, Role | undefined, boolean, boolean]>([
  [
    "a community owner on a public stream channel",
    publicStream,
    "owner",
    true,
    true,
  ],
  [
    "a community admin on a public stream channel",
    publicStream,
    "admin",
    true,
    true,
  ],
  ["an ordinary community member", publicStream, "member", false, true],
  ["an unknown community role", publicStream, undefined, false, true],
  [
    "a private channel",
    { ...publicStream, visibility: "private" },
    "owner",
    false,
    false,
  ],
  [
    "unknown visibility",
    { ...publicStream, visibility: undefined },
    "owner",
    false,
    false,
  ],
  [
    "a forum channel",
    { ...publicStream, channelType: "forum" },
    "owner",
    false,
    false,
  ],
  [
    "an archived channel",
    { ...publicStream, archived: true },
    "owner",
    false,
    false,
  ],
  [
    "a read-only preview",
    { ...publicStream, readOnly: true },
    "owner",
    false,
    false,
  ],
  [
    "a cached channel",
    { ...publicStream, cached: true },
    "owner",
    false,
    false,
  ],
])(
  "shows the auto-join switch for %s: %s",
  (_, channel, role, shown, ensured) => {
    const roster = membership(role);
    const error = vi.spyOn(console, "error");
    const { unmount } = render(
      autoJoinPanel(channel, role, lifecycle(), roster),
    );
    if (shown) {
      const control = autoJoinSwitch();
      expect(control).toBeVisible();
      expect(control).toHaveAccessibleDescription(
        "New community members are added to this channel automatically.",
      );
      expect(control).not.toBeChecked();
      expect(
        screen.getByText("Visibility").compareDocumentPosition(control),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(control.compareDocumentPosition(screen.getByText("Members"))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    } else noAutoJoinSwitch();
    // The row and the channel ID detail are siblings; their keys must differ.
    expect(error).not.toHaveBeenCalledWith(
      expect.stringContaining("same key"),
      expect.anything(),
    );
    // The role read is held only while a channel-eligible row is mounted.
    expect(roster.ensure).toHaveBeenCalledTimes(ensured ? 1 : 0);
    unmount();
    expect(roster.release).toHaveBeenCalledTimes(ensured ? 1 : 0);
  },
);

it("hides the switch without a membership owner and reflects the signed flag", () => {
  const { rerender } = render(
    autoJoinPanel(publicStream, "owner", lifecycle(), null),
  );
  noAutoJoinSwitch();
  rerender(autoJoinPanel({ ...publicStream, autoJoin: true }, "owner"));
  expect(autoJoinSwitch()).toBeChecked();
});

it("runs the matching command, stays pending until it settles, then follows the metadata", async () => {
  const user = userEvent.setup();
  const capability = lifecycle();
  let settle!: () => void;
  capability.run.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  const { rerender } = render(autoJoinPanel(publicStream, "owner", capability));
  await user.click(autoJoinSwitch());
  try {
    expect(capability.run).toHaveBeenCalledExactlyOnceWith(
      "auto-join-on",
      publicStream.id,
      expect.any(AbortSignal),
    );
    expect(autoJoinSwitch()).toHaveAttribute("aria-disabled", "true");
    expect(autoJoinSwitch()).toHaveAttribute("aria-busy", "true");
    // No optimistic state: the switch follows the signed metadata.
    expect(autoJoinSwitch()).not.toBeChecked();
  } finally {
    await act(async () => settle());
  }
  expect(autoJoinSwitch()).not.toHaveAttribute("aria-disabled");
  expect(autoJoinSwitch()).not.toHaveAttribute("aria-busy");
  rerender(
    autoJoinPanel({ ...publicStream, autoJoin: true }, "owner", capability),
  );
  expect(autoJoinSwitch()).toBeChecked();
  await user.click(autoJoinSwitch());
  expect(capability.run).toHaveBeenLastCalledWith(
    "auto-join-off",
    publicStream.id,
    expect.any(AbortSignal),
  );
});

it.each([
  [
    "the relay's own reason",
    new PublishRejected("rejected", "invalid: actor not authorized"),
    "invalid: actor not authorized",
  ],
  [
    "the default reason",
    new PublishRejected("rejected"),
    "Only community owners and admins can change this.",
  ],
  [
    "refresh guidance for an uncertain outcome",
    new ChannelLifecycleUnconfirmed("connection lost"),
    "The request may have taken effect. Refresh channels before trying again.",
  ],
])(
  "reports %s and lets the switch be tried again",
  async (_, failure, copy) => {
    const user = userEvent.setup();
    const capability = lifecycle();
    capability.run.mockRejectedValueOnce(failure);
    render(autoJoinPanel(publicStream, "owner", capability));
    await user.click(autoJoinSwitch());
    expect(await screen.findByRole("alert")).toHaveTextContent(copy);
    expect(autoJoinSwitch()).not.toHaveAttribute("aria-disabled");
    expect(autoJoinSwitch()).not.toBeChecked();
    await user.click(autoJoinSwitch());
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(capability.run).toHaveBeenCalledTimes(2);
  },
);

it("disables the switch when channel actions are unavailable on this connection", () => {
  render(autoJoinPanel(publicStream, "owner", lifecycle(false)));
  expect(autoJoinSwitch()).toHaveAttribute("aria-disabled", "true");
});
