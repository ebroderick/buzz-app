// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSection } from "./SidebarSection";

afterEach(cleanup);

it("chooses a filter with the keyboard and appends hidden channels below its options", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const select = vi.fn();
  const toggle = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open={false}
      onToggle={toggle}
      filter={{ value: "unreads", change }}
      channels={{ rows: [{ id: "quiet", name: "Quiet channel" }], select }}
    >
      <p>No channels match this filter.</p>
    </SidebarSection>,
  );
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  await user.click(trigger);
  expect(
    within(
      await screen.findByRole("menu", { name: "More actions for Channels" }),
    ).getAllByRole("menuitem")[0],
  ).toHaveTextContent("Filter");
  await user.keyboard("{ArrowDown}{ArrowRight}");
  expect(
    await screen.findByRole("menuitemradio", { name: "Unreads" }),
  ).toHaveAttribute("aria-checked", "true");
  await user.click(
    screen.getByRole("menuitemradio", { name: /Active in the last/ }),
  );
  expect(change).not.toHaveBeenCalled();
  await user.click(await screen.findByRole("button", { name: "Apply" }));
  expect(change).toHaveBeenCalledExactlyOnceWith("active", 30 * 86400);
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.click(trigger);
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  const quiet = await screen.findByRole("menuitem", { name: "Quiet channel" });
  expect(
    within(screen.getByRole("group", { name: "No unread messages" })).getByRole(
      "menuitem",
      { name: "Quiet channel" },
    ),
  ).toBe(quiet);
  const popup = quiet.closest('[role="menu"]');
  expect(popup?.querySelectorAll('[role^="menuitem"]')).toHaveLength(4);
  expect(popup?.querySelector('[role="separator"]')).toBeInTheDocument();
  expect(
    screen
      .getByRole("menuitemradio", { name: /Active in the last/ })
      .compareDocumentPosition(quiet) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  // jsdom has no submenu geometry; browser checks own pointer travel/focus.
  fireEvent.click(quiet);
  expect(select).toHaveBeenCalledExactlyOnceWith("quiet");
  expect(toggle).toHaveBeenCalledExactlyOnceWith(true);
  expect(change).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "keeps Starred creation independent of collapse and respects availability (%s)",
  async (available) => {
    const user = userEvent.setup();
    const open = vi.fn();
    const toggle = vi.fn();
    render(
      <SidebarSection
        sectionKey="starred"
        title="Starred"
        open={false}
        onToggle={toggle}
        createChannel={{ available, open }}
      >
        <button type="button">General</button>
      </SidebarSection>,
    );
    const trigger = screen.getByRole("button", { name: "Create channel" });
    if (available) {
      trigger.focus();
      await user.keyboard("{Enter}");
      expect(open).toHaveBeenCalledExactlyOnceWith(trigger);
    } else {
      expect(trigger).toBeDisabled();
      await user.click(trigger);
      expect(open).not.toHaveBeenCalled();
    }
    expect(toggle).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("Starred").closest("details"),
    ).not.toHaveAttribute("open");
  },
);

function Section({
  sort,
}: {
  sort?: {
    value: import("../../features/relay/sidebar-sort").SidebarSortMode;
    change: (
      value: import("../../features/relay/sidebar-sort").SidebarSortMode,
    ) => void;
  };
} = {}) {
  const [open, setOpen] = useState(true);
  const [revision, setRevision] = useState(0);
  return (
    <>
      <SidebarSection
        sectionKey="channels"
        title="Channels"
        open={open}
        onToggle={setOpen}
        newMessage={() => {}}
        sort={sort}
      >
        <button type="button">General</button>
      </SidebarSection>
      <button type="button" onClick={() => setRevision(revision + 1)}>
        Update {revision}
      </button>
    </>
  );
}
it("keeps section actions independent of disclosure and supports menu keyboard dismissal", async () => {
  const user = userEvent.setup();
  render(<Section sort={{ value: "alpha", change: vi.fn() }} />);
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  await user.click(screen.getByLabelText("Channels"));
  expect(
    screen.getByLabelText("Channels").closest("details"),
  ).not.toHaveAttribute("open");
  const section = trigger.closest("[data-sidebar-section]");
  expect(section).not.toHaveAttribute("data-menu-open");
  await user.click(trigger);
  await waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  expect(
    screen.queryByRole("menuitem", { name: "Expand section" }),
  ).not.toBeInTheDocument();
  expect(section).toHaveAttribute("data-menu-open");
  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(section).not.toHaveAttribute("data-menu-open");
  expect(trigger).toHaveFocus();
  await user.click(screen.getByLabelText("Channels"));
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});
it("keeps one controlled actions menu, closes it after sorting, and restores trigger focus", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(<Section sort={{ value: "alpha", change }} />);
  const trigger = screen.getByRole("button", {
    name: "More actions for Channels",
  });
  expect(screen.queryByRole("button", { name: "Sort Channels" })).toBeNull();
  await user.click(trigger);
  const actions = await screen.findByRole("menu", {
    name: "More actions for Channels",
  });
  expect(actions).toHaveTextContent("Sort");
  expect(
    within(actions).queryByRole("menuitem", { name: "Collapse section" }),
  ).not.toBeInTheDocument();
  await user.keyboard("{ArrowDown}{ArrowRight}");
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Recent" }),
  );
  expect(change).toHaveBeenCalledWith("recent");
  await waitFor(() => expect(actions).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("orders header actions before section rows for keyboard navigation", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  summary.focus();
  await user.tab();
  expect(
    screen.getByRole("button", { name: "More actions for Channels" }),
  ).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "New message" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "General" })).toHaveFocus();
});
it("retains an expansion requested by an offscreen unread cue on subsequent renders", async () => {
  const user = userEvent.setup();
  render(<Section />);
  const summary = screen.getByLabelText("Channels");
  await user.click(summary);
  const details = summary.closest("details");
  if (!details) throw new Error("Missing section disclosure");
  fireEvent.click(summary);
  await user.click(screen.getByRole("button", { name: "Update 0" }));
  expect(details).toHaveAttribute("open");
  expect(screen.getByRole("button", { name: "General" })).toBeVisible();
});

it("offers confirmed removal for custom sections", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
      channelCount={1}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  const confirmation = screen.getByRole("dialog", { name: "Remove Work?" });
  expect(confirmation).toHaveAccessibleDescription(
    "1 channel will move back to Channels. This does not delete any channels.",
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    within(confirmation).getByRole("button", { name: "Cancel" }),
  );
  expect(remove).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  await user.click(
    within(screen.getByRole("dialog", { name: "Remove Work?" })).getByRole(
      "button",
      { name: "Remove section" },
    ),
  );
  expect(remove).toHaveBeenCalledOnce();
});

it("holds confirmation while removing, shows failure, and permits explicit retry", async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const remove = vi
    .fn()
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce(undefined);
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Work" }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: "Remove section" }),
  );
  const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
  try {
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "waiting for confirmation",
    );
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
  } finally {
    reject(new Error("Publication not confirmed"));
  }
  expect(await within(dialog).findByRole("alert")).toHaveTextContent(
    "Publication not confirmed",
  );
  // The modal deliberately makes the retained sidebar aria-hidden.
  expect(screen.getByText("General", { exact: true })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  await user.click(
    within(dialog).getByRole("button", { name: "Remove section" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(remove).toHaveBeenCalledTimes(2);
});
it.each(["Cancel", "Escape"])(
  "restores section focus after failure then %s",
  async (dismiss) => {
    const user = userEvent.setup();
    const remove = vi
      .fn()
      .mockRejectedValue(new Error("Publication not confirmed"));
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={remove}
      >
        <button type="button">General</button>
      </SidebarSection>,
    );
    const trigger = screen.getByRole("button", {
      name: "More actions for Work",
    });
    await user.click(trigger);
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove section" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Remove Work?" });
    await user.click(
      within(dialog).getByRole("button", { name: "Remove section" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Publication not confirmed",
    );
    if (dismiss === "Cancel")
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    else await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(remove).toHaveBeenCalledOnce();
  },
);

it("never offers removal for built-in sections even when a callback is supplied", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      onRemove={remove}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menu", { name: "More actions for Channels" });
  expect(screen.queryByRole("menuitem", { name: "Remove section" })).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it.each([0, 2])(
  "describes %s channels in removal confirmation",
  async (count) => {
    const user = userEvent.setup();
    render(
      <SidebarSection
        sectionKey="group:work"
        title="Work"
        open
        onToggle={() => {}}
        onRemove={() => {}}
        channelCount={count}
      >
        <span>Rows</span>
      </SidebarSection>,
    );
    await user.click(
      screen.getByRole("button", { name: "More actions for Work" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove section" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Remove Work?" }),
    ).toHaveAccessibleDescription(
      `${count} channels will move back to Channels. This does not delete any channels.`,
    );
  },
);

it("offers Move up and Move down for reorderable groups, disabled at each end", async () => {
  const user = userEvent.setup();
  const down = vi.fn();
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      move={{ down }}
    >
      <button type="button">General</button>
    </SidebarSection>,
  );
  const trigger = screen.getByRole("button", { name: "More actions for Work" });
  await user.click(trigger);
  expect(
    await screen.findByRole("menuitem", { name: "Move up" }),
  ).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("menuitem", { name: "Move down" }));
  expect(down).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("never offers moves without a move capability", async () => {
  const user = userEvent.setup();
  render(<Section />);
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menu", { name: "More actions for Channels" });
  expect(screen.queryByRole("menuitem", { name: "Move up" })).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Move down" })).toBeNull();
});

it("keeps hidden-channel navigation available when filter choices are read-only", async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  const select = vi.fn();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      filter={{ value: "unreads", disabled: true, change }}
      channels={{ rows: [{ id: "quiet", name: "Quiet channel" }], select }}
    >
      <p>No channels match this filter.</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  expect(screen.queryByRole("menuitem", { name: "View All" })).toBeNull();
  await user.click(await screen.findByRole("menuitem", { name: "Filter" }));
  for (const choice of await screen.findAllByRole("menuitemradio"))
    expect(choice).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Quiet channel" }),
  );
  expect(select).toHaveBeenCalledExactlyOnceWith("quiet");
  expect(change).not.toHaveBeenCalled();
});

it("renames a saved section from its menu and keeps the dialog open on failure", async () => {
  const user = userEvent.setup();
  const rename = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(undefined);
  render(
    <SidebarSection
      sectionKey="group:work"
      title="Work"
      open
      onToggle={() => {}}
      onRename={rename}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  const trigger = screen.getByRole("button", { name: "More actions for Work" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Rename section" }),
  );
  const dialog = await screen.findByRole("dialog", { name: "Rename section" });
  const input = within(dialog).getByRole("textbox", { name: "Section name" });
  expect(input).toHaveValue("Work");
  await user.clear(input);
  await user.type(input, " Projects ");
  await user.click(within(dialog).getByRole("button", { name: "Rename" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("offline");
  await user.click(within(dialog).getByRole("button", { name: "Rename" }));
  expect(rename).toHaveBeenNthCalledWith(2, "Projects");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
});

it("offers rename only for saved sections with a rename writer", async () => {
  const user = userEvent.setup();
  render(
    <SidebarSection
      sectionKey="channels"
      title="Channels"
      open
      onToggle={() => {}}
      onRename={() => {}}
      move={{}}
    >
      <p>Rows</p>
    </SidebarSection>,
  );
  await user.click(
    screen.getByRole("button", { name: "More actions for Channels" }),
  );
  await screen.findByRole("menuitem", { name: "Move up" });
  expect(screen.queryByRole("menuitem", { name: "Rename section" })).toBeNull();
});
