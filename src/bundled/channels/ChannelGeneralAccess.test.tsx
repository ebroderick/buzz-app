// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ChannelDetailsCapability,
  DetailsAttempt,
} from "../../features/relay/channel-details";
import type { ChannelDetails } from "../../features/relay/channel-details-protocol";
import { ChannelGeneralAccess } from "./ChannelGeneralAccess";

afterEach(cleanup);

it.each(["public", "private"] as const)(
  "shows verified %s access to readers without invoking the editing capability",
  (visibility) => {
    const h = harness();
    h.load.mockRejectedValue(
      new Error("Channel access changed. Reopen channel settings."),
    );
    render(
      <ChannelGeneralAccess
        capability={h.capability}
        channelId="alpha"
        channel={{
          id: "alpha",
          name: "Alpha",
          readOnly: true,
          visibility,
          joinRole: "guest",
        }}
      />,
    );
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent(
      visibility === "public"
        ? "Anyone in the community can read."
        : "Only channel members can read.",
    );
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveTextContent("Viewing only. Ask an owner or admin to participate.");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(h.load).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  },
);

const base: ChannelDetails = {
  channelId: "alpha",
  version: "v1",
  name: "Alpha",
  description: "Description",
  visibility: "public",
  joinRole: "guest",
  canEdit: true,
};
function harness() {
  let attempt: DetailsAttempt | undefined;
  const listeners = new Set<() => void>();
  const load = vi.fn(async () => base);
  const save = vi.fn(async () => {});
  const check = vi.fn(async () => {});
  const capability: ChannelDetailsCapability = {
    available: true,
    load,
    save,
    check,
    snapshot: () => attempt,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return {
    capability,
    load,
    save,
    check,
    setAttempt(next: DetailsAttempt | undefined) {
      attempt = next;
      for (const fn of listeners) fn();
    },
  };
}
async function select(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string,
) {
  const control = screen.getByRole("combobox", { name: field });
  await waitFor(() => expect(control).toBeEnabled());
  await user.click(control);
  await user.click(await screen.findByRole("option", { name: option }));
  return control;
}
it("reviews fresh details before restoring privacy after a title update", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  const renamed = {
    ...base,
    version: "v2",
    name: "New title",
    description: "New description",
  };
  h.load.mockResolvedValue(renamed);
  await select(user, "General access", "Private");
  expect(h.load).toHaveBeenCalledTimes(2);
  expect(h.save).not.toHaveBeenCalled();
  await user.click(
    await screen.findByRole("button", { name: "Change access" }),
  );
  expect(h.save).toHaveBeenCalledExactlyOnceWith(
    renamed,
    { ...renamed, visibility: "private" },
    expect.any(AbortSignal),
  );
});

it("keeps writes and consent closed when the fresh access read fails", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
  h.load.mockRejectedValue(new Error("Could not read current access"));
  await select(user, "General access", "Private");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not read current access",
  );
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(h.save).not.toHaveBeenCalled();
});

it.each([
  { autoJoin: true, option: "Private", note: true },
  { autoJoin: true, option: "View only", note: false },
  { autoJoin: false, option: "Private", note: false },
])(
  "starter channel $autoJoin → $option says new members resume if made public: $note",
  async ({ autoJoin, option, note }) => {
    const h = harness();
    h.load.mockResolvedValue({ ...base, joinRole: "member" });
    const user = userEvent.setup();
    render(
      <ChannelGeneralAccess
        capability={h.capability}
        channelId="alpha"
        channel={{ id: "alpha", name: "Alpha", ...(autoJoin && { autoJoin }) }}
      />,
    );
    await select(user, "General access", option);
    const starter =
      "It’s a starter channel, so new members will be added to it again if it’s made public. To stop that, turn off Starter channel for new members in Settings first.";
    const confirm = await screen.findByRole("alertdialog", {
      name: "Change general access?",
    });
    if (note) expect(confirm).toHaveTextContent(starter);
    else expect(confirm).not.toHaveTextContent(starter);
  },
);

const policies = [
  { visibility: "private", joinRole: "member", label: "Private" },
  { visibility: "private", joinRole: "guest", label: "Private" },
  { visibility: "public", joinRole: "member", label: "Public" },
  { visibility: "public", joinRole: "guest", label: "View only" },
  { visibility: "public", joinRole: undefined, label: "Public" },
] as const;

for (const policy of policies) {
  it.each(["Private", "Public", "View only"])(
    `confirms ${policy.visibility}/${policy.joinRole} → %s without changing existing access`,
    async (option) => {
      const h = harness();
      const current: ChannelDetails = {
        ...base,
        visibility: policy.visibility,
        joinRole: policy.joinRole,
      };
      h.load.mockResolvedValue(current);
      const user = userEvent.setup();
      render(
        <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
      );
      const control = await select(user, "General access", option);
      expect(screen.getAllByRole("combobox", { hidden: true })).toHaveLength(1);
      expect(control).toHaveTextContent(policy.label);
      if (option === policy.label) {
        expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
        expect(h.save).not.toHaveBeenCalled();
        return;
      }
      const confirm = screen.getByRole("alertdialog", {
        name: "Change general access?",
      });
      const visibility =
        option === "Private" ? ("private" as const) : ("public" as const);
      const joinRole =
        option === "Private"
          ? current.joinRole
          : option === "View only"
            ? ("guest" as const)
            : ("member" as const);
      if (visibility !== current.visibility) {
        expect(confirm).toHaveTextContent(
          visibility === "private"
            ? "Only channel members will have access."
            : "Everyone in this community will be able to view this channel’s full history.",
        );
      }
      if (visibility === "public") {
        expect(confirm).toHaveTextContent(
          joinRole === "guest"
            ? "New people will only be able to view."
            : "New people will be able to participate.",
        );
        expect(confirm).toHaveTextContent(
          "People already in the channel keep their access.",
        );
      }
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus(),
      );
      expect(h.save).not.toHaveBeenCalled();
      await user.keyboard("{Escape}");
      await waitFor(() => expect(control).toHaveFocus());
      expect(control).toHaveTextContent(policy.label);
      expect(h.save).not.toHaveBeenCalled();
      await select(user, "General access", option);
      const next = {
        ...current,
        visibility,
        ...(option === "Private" ? {} : { joinRole }),
      };
      h.load.mockResolvedValue(next);
      await user.click(screen.getByRole("button", { name: "Change access" }));
      await waitFor(() => expect(control).toHaveTextContent(option));
      expect(h.save).toHaveBeenCalledExactlyOnceWith(
        current,
        next,
        expect.any(AbortSignal),
      );
    },
  );
}

it.each(["member", "guest", undefined] as const)(
  "shows Private without rewriting its saved %s admission default",
  async (joinRole) => {
    const h = harness();
    h.load.mockResolvedValue({ ...base, visibility: "private", joinRole });
    const user = userEvent.setup();
    render(
      <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
    );
    await select(user, "General access", "Private");
    expect(
      screen.queryByText("Only people you add can read this channel."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "General access" }),
    ).toHaveTextContent(/^Private$/);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(h.save).not.toHaveBeenCalled();
  },
);

it.each(["private", "view-only", "legacy-public"])(
  "offers only View only / Private for a %s Solo chat",
  async (policy) => {
    const h = harness();
    const current: ChannelDetails = {
      ...base,
      visibility: policy === "private" ? "private" : "public",
      joinRole: policy === "legacy-public" ? "member" : "guest",
      labels: ["buzz.solo"],
    };
    h.load.mockResolvedValue(current);
    const user = userEvent.setup();
    render(
      <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
    );
    const control = screen.getByRole("combobox", { name: "General access" });
    await waitFor(() => expect(control).toBeEnabled());
    expect(control).toHaveTextContent(
      policy === "private"
        ? "Private"
        : policy === "legacy-public"
          ? "Public (existing)"
          : "View only",
    );
    await user.click(control);
    expect(
      (await screen.findAllByRole("option")).map((node) =>
        node.getAttribute("aria-label"),
      ),
    ).toEqual(["View only", "Private"]);
    expect(
      screen.getByRole("option", { name: "View only" }),
    ).toHaveAccessibleDescription("Anyone in the community can read.");
    expect(
      screen.queryByRole("option", { name: /^Public$/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(h.save).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("option", {
        name: policy === "view-only" ? "Private" : "View only",
      }),
    );
    const next: ChannelDetails = {
      ...current,
      visibility: policy === "view-only" ? "private" : "public",
      joinRole: "guest",
    };
    expect(h.save).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
      policy === "view-only"
        ? "Only chat members will have access. People who joined while it was View only are members and keep reading until you remove them in People."
        : `Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.${policy === "legacy-public" ? " People already in the chat keep their access." : ""}`,
    );
    h.load.mockResolvedValue(next);
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() =>
      expect(h.save).toHaveBeenCalledExactlyOnceWith(
        current,
        next,
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() =>
      expect(control).toHaveTextContent(
        policy === "view-only" ? "Private" : "View only",
      ),
    );
  },
);

it.each([
  {
    visibility: "private",
    joinRole: "guest",
    option: "View only",
    expected:
      "Everyone in this community will be able to read this chat’s full history and Canvas, including its workspace folders and agent instructions.",
  },
  {
    visibility: "public",
    joinRole: "member",
    option: "Private",
    expected:
      "Only chat members will have access. People who already joined remain members and keep their access until you remove them in People.",
  },
] as const)(
  "explains $visibility/$joinRole → $option with existing members",
  async ({ visibility, joinRole, option, expected }) => {
    const h = harness();
    h.load.mockResolvedValue({
      ...base,
      labels: ["buzz.solo"],
      visibility,
      joinRole,
    });
    const user = userEvent.setup();
    render(
      <ChannelGeneralAccess
        capability={h.capability}
        channelId="alpha"
        mayHaveGuestMembers
      />,
    );
    await select(user, "General access", option);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
      expected,
    );
    expect(h.save).not.toHaveBeenCalled();
  },
);

it("confirms new people's View only/Participate access independently of public reading access", async () => {
  const h = harness();
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  const status = screen.getByRole("status");
  expect(status).toBeEmptyDOMElement();
  await select(user, "General access", "Public");
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    "People already in the channel keep their access.",
  );
  h.load.mockResolvedValue({ ...base, joinRole: "member" });
  await user.click(screen.getByRole("button", { name: "Change access" }));
  await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
  expect(h.save).toHaveBeenCalledWith(
    base,
    { ...base, joinRole: "member" },
    expect.any(AbortSignal),
  );
  expect(
    screen.getByRole("combobox", { name: "General access" }),
  ).toHaveTextContent("Public");
  expect(
    screen.queryByText("Anyone in the community can find and participate."),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Access updated")).toBe(status);
});
it("shows the absent Member default without saving, and a declined save reloads current access", async () => {
  const h = harness();
  const current = { ...base, joinRole: undefined };
  h.load.mockResolvedValue(current);
  h.save.mockRejectedValueOnce(new Error("Channel details changed"));
  const user = userEvent.setup();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "General access" }),
    ).toBeEnabled(),
  );
  expect(
    screen.getByRole("combobox", { name: "General access" }),
  ).toHaveTextContent("Public");
  expect(h.save).not.toHaveBeenCalled();
  await select(user, "General access", "View only");
  await user.click(screen.getByRole("button", { name: "Change access" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Channel details changed",
  );
  let reload!: (details: ChannelDetails) => void;
  const gate = new Promise<ChannelDetails>((resolve) => {
    reload = resolve;
  });
  h.load.mockReturnValueOnce(gate);
  try {
    await user.click(screen.getByRole("button", { name: "Reload access" }));
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveFocus();
  } finally {
    await act(async () => {
      reload({ ...base, canEdit: false });
      await gate;
    });
  }
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "General access" }),
    ).toHaveTextContent("View only"),
  );
  expect(
    screen.getByRole("combobox", { name: "General access" }),
  ).toBeDisabled();
  expect(h.save).toHaveBeenCalledOnce();
  expect(screen.getByRole("region", { name: "General access" })).toHaveFocus();
});
it("locks the choice while saving and recovers an uncertain save after remount without resending", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.save.mockImplementationOnce(async () => {
    await gate;
    h.setAttempt({
      draft: { ...base, joinRole: "member" },
      status: "unconfirmed",
    });
    throw new Error("Readback unavailable");
  });
  const user = userEvent.setup();
  const view = render(
    <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
  );
  await select(user, "General access", "Public");
  try {
    await user.click(screen.getByRole("button", { name: "Change access" }));
    await waitFor(() => expect(h.save).toHaveBeenCalledOnce());
    const status = screen.getByText("Saving access…");
    expect(status).toHaveAttribute("role", "status");
    expect(status.closest("[aria-busy]")).toBeNull();
    for (const control of screen.getAllByRole("combobox"))
      expect(control).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "General access" }),
      ).toHaveFocus(),
    );
  } finally {
    await act(async () => {
      release();
      await gate;
    });
  }
  await screen.findByRole("button", { name: "Check save status" });
  expect(screen.queryByText("Saving access…")).not.toBeInTheDocument();
  view.unmount();
  render(<ChannelGeneralAccess capability={h.capability} channelId="alpha" />);
  const check = await screen.findByRole("button", {
    name: "Check save status",
  });
  await waitFor(() => expect(check).toBeEnabled());
  let finishCheck!: () => void;
  const checking = new Promise<void>((resolve) => {
    finishCheck = resolve;
  });
  h.check.mockImplementationOnce(async () => {
    await checking;
    h.setAttempt(undefined);
  });
  try {
    await user.click(check);
    expect(screen.getByText("Checking save status…")).toHaveAttribute(
      "role",
      "status",
    );
    expect(
      screen.getByRole("region", { name: "General access" }),
    ).toHaveFocus();
  } finally {
    await act(async () => {
      finishCheck();
      await checking;
    });
  }
  await waitFor(() =>
    expect(h.check).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      expect.any(AbortSignal),
    ),
  );
  expect(h.save).toHaveBeenCalledOnce();
  expect(screen.getByText("Access updated")).toHaveAttribute("role", "status");
  expect(screen.getByRole("region", { name: "General access" })).toHaveFocus();
});
it("retires an open confirmation and late reads when the destination changes", async () => {
  const h = harness();
  const user = userEvent.setup();
  const view = render(
    <ChannelGeneralAccess capability={h.capability} channelId="alpha" />,
  );
  await select(user, "General access", "Public");
  const pending = new Promise<ChannelDetails>(() => {});
  h.load.mockReturnValueOnce(pending);
  view.rerender(
    <ChannelGeneralAccess capability={h.capability} channelId="beta" />,
  );
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument(),
  );
  for (const control of screen.getAllByRole("combobox"))
    expect(control).toBeDisabled();
  expect(h.save).not.toHaveBeenCalled();
});

it.each([true, false])(
  "warns Public (existing) → Private retains Members regardless of Guests: %s",
  async (mayHaveGuestMembers) => {
    const h = harness();
    h.load.mockResolvedValue({
      ...base,
      labels: ["buzz.solo"],
      visibility: "public",
      joinRole: "member",
    });
    render(
      <ChannelGeneralAccess
        capability={h.capability}
        channelId="alpha"
        mayHaveGuestMembers={mayHaveGuestMembers}
      />,
    );
    const user = userEvent.setup();
    await select(user, "General access", "Private");
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(
      "Only chat members will have access. People who already joined remain members and keep their access until you remove them in People.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.save).not.toHaveBeenCalled();
  },
);
