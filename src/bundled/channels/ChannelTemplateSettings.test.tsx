// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { Agents } from "../../features/agents/service";
import { channelTemplates } from "../../features/channel-templates/local";
import { Dialog } from "../../shared/design-system/ui/Dialog";
import { ChannelTemplateSettings } from "./ChannelTemplateSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const snapshot = {
  status: "ready",
  agents: [
    {
      pubkey: "a".repeat(64),
      name: "Ada",
      picture: "https://images.example/ada.png",
      relay: "https://community.example",
    },
    { pubkey: "b".repeat(64), name: "Grace" },
  ],
  running: [],
  teams: [
    { id: "t1", name: "Core", instructions: "", members: [] },
    { id: "t2", name: "Docs", instructions: "", members: [] },
  ],
};
const agents = {
  snapshot: () => snapshot,
  subscribe: () => () => {},
} as unknown as Agents;

it("uses the relay thumbnail for a template agent after community registration", async () => {
  const community = "https://community.example";
  const picture = `${community}/media/${"a".repeat(64)}.png`;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
  );
  const picturedSnapshot = {
    ...snapshot,
    agents: [{ ...snapshot.agents[0], picture }],
  };
  const picturedAgents = {
    ...agents,
    snapshot: () => picturedSnapshot,
  } as unknown as Agents;
  render(
    <ChannelTemplateSettings agents={picturedAgents} active={() => true} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "New template" }));
  await waitFor(() => {
    expect(
      screen
        .getByRole("checkbox", { name: "Ada" })
        .closest("label")
        ?.querySelector("img"),
    ).toHaveAttribute(
      "src",
      `/api/relay/${encodeURIComponent(community)}/media?url=${encodeURIComponent(picture.replace(/\.png$/, ".thumb.jpg"))}`,
    );
  });
});

it("makes, edits and deletes a template of agents, teams and a Canvas", async () => {
  const user = userEvent.setup();
  render(<ChannelTemplateSettings agents={agents} active={() => true} />);
  await user.click(screen.getByRole("button", { name: "New template" }));
  const ada = screen.getByRole("checkbox", { name: "Ada" });
  const artwork = ada.closest("label")?.querySelector("img");
  expect(artwork).toHaveAttribute("src", snapshot.agents[0]?.picture);
  if (!artwork) throw new Error("Missing agent artwork");
  fireEvent.load(artwork);
  expect(artwork).toBeVisible();
  expect(
    screen.getByRole("checkbox", { name: "Grace" }).closest("label"),
  ).toHaveTextContent("GGrace");
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
  await user.click(artwork);
  expect(ada).toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Docs" }));
  await user.type(
    screen.getByRole("textbox", { name: /Starting Canvas/ }),
    "# Goal",
  );
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()).toMatchObject([
    {
      name: "Launch",
      teams: ["t2"],
      agents: ["a".repeat(64)],
      canvas: "# Goal",
    },
  ]);
  expect(screen.getByText("Ada, Docs · Canvas")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  expect(screen.getByRole("checkbox", { name: "Ada" })).toBeChecked();
  const grace = screen.getByRole("checkbox", { name: "Grace" });
  grace.focus();
  await user.keyboard(" ");
  expect(grace).toBeChecked();
  await user.keyboard(" ");
  expect(grace).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Core" }));
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(channelTemplates.snapshot()[0]?.teams).toEqual(["t2", "t1"]);

  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  await user.click(screen.getByRole("button", { name: "Delete" }));
  expect(channelTemplates.snapshot()).toEqual([]);
  expect(screen.getByText("No channel templates yet")).toBeVisible();
});

it.each(["backdrop", "Escape", "Close"])(
  "guards a dirty template draft via %s and only discards explicitly",
  async (dismissal) => {
    const user = userEvent.setup();
    render(<ChannelTemplateSettings agents={agents} active={() => true} />);
    const dismiss = async () => {
      if (dismissal === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else if (dismissal === "Escape") await user.keyboard("{Escape}");
      else
        await user.click(
          screen.getByRole("button", { name: "Close template" }),
        );
    };
    await user.click(screen.getByRole("button", { name: "New template" }));
    await dismiss();
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "New template" }));
    const dialog = screen.getByRole("dialog");
    await user.type(
      screen.getByRole("textbox", { name: "Name" }),
      "R2 Launch kit",
    );
    await user.click(screen.getByRole("checkbox", { name: "Grace" }));
    await user.click(screen.getByRole("checkbox", { name: "Core" }));
    await user.type(
      screen.getByRole("textbox", { name: /Starting Canvas/ }),
      "# Goal",
    );
    for (const back of ["Keep editing", "Escape", "backdrop", "Close"]) {
      await dismiss();
      expect(screen.getAllByRole("dialog")).toEqual([dialog]);
      expect(dialog).toHaveAccessibleName("Discard changes?");
      expect(dialog).toHaveAccessibleDescription(
        "Your template has unsaved changes.",
      );
      expect(
        screen.getByRole("button", { name: "Keep editing" }),
      ).toHaveFocus();
      if (back === "Escape") await user.keyboard("{Escape}");
      else if (back === "backdrop")
        await user.click(
          document.querySelector(".buzz-dialog-backdrop") as Element,
        );
      else
        await user.click(
          screen.getByRole("button", {
            name: back === "Close" ? "Back to template" : back,
          }),
        );
      expect(dialog).toHaveAccessibleName("New template");
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
        "R2 Launch kit",
      );
      expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
      expect(screen.getByRole("checkbox", { name: "Grace" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Core" })).toBeChecked();
      expect(
        screen.getByRole("textbox", { name: /Starting Canvas/ }),
      ).toHaveValue("# Goal");
    }
    await dismiss();
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(channelTemplates.snapshot()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "New template" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Grace" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Core" })).not.toBeChecked();
    expect(
      screen.getByRole("textbox", { name: /Starting Canvas/ }),
    ).toHaveValue("");
  },
);

it("dismisses only the editor's own layer inside a parent dialog", async () => {
  const user = userEvent.setup();
  const onOpenChange = vi.fn();
  render(
    <Dialog
      open
      onOpenChange={onOpenChange}
      title="Settings"
      navigation={{ label: "Settings sections", content: <p>Sections</p> }}
    >
      <ChannelTemplateSettings agents={agents} active={() => true} />
    </Dialog>,
  );
  // The editor's backdrop is the last one; querySelector would find the parent's.
  const outside = () =>
    user.click(
      [...document.querySelectorAll(".buzz-dialog-backdrop")].at(-1) as Element,
    );
  await user.click(screen.getByRole("button", { name: "New template" }));
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Launch");
  await outside();
  expect(
    screen.getByRole("dialog", { name: "Discard changes?" }),
  ).toBeVisible();
  expect(onOpenChange).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  // The parent popup is aria-hidden while the editor is open.
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(
    screen.getByRole("dialog", { name: "Settings", hidden: true }),
  ).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "New template" }));
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(2);
  await outside();
  expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  expect(
    screen.getByRole("dialog", { name: "Settings", hidden: true }),
  ).toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalled();
});

it.each(["Name", "Starting Canvas", "Ada", "Docs"])(
  "protects template edits to %s and closes a reverted draft without a prompt",
  async (field) => {
    const user = userEvent.setup();
    render(<ChannelTemplateSettings agents={agents} active={() => true} />);
    await user.click(screen.getByRole("button", { name: "New template" }));
    const dialog = screen.getByRole("dialog");
    const checkbox = field === "Ada" || field === "Docs";
    const control = () =>
      checkbox
        ? screen.getByRole("checkbox", { name: field })
        : screen.getByRole("textbox", { name: new RegExp(field) });
    // A name of only spaces is still an edit worth protecting.
    if (checkbox) await user.click(control());
    else await user.type(control(), " ");
    await user.keyboard("{Escape}");
    expect(dialog).toHaveAccessibleName("Discard changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    if (checkbox) await user.click(control());
    else await user.type(control(), "{Backspace}");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  },
);

it("treats a saved template's agents as a set, not an order", async () => {
  const user = userEvent.setup();
  channelTemplates.save({
    name: "Launch",
    teams: [],
    agents: ["a".repeat(64), "b".repeat(64)],
    canvas: "",
  });
  render(<ChannelTemplateSettings agents={agents} active={() => true} />);
  await user.click(screen.getByRole("button", { name: "Edit Launch" }));
  const ada = screen.getByRole("checkbox", { name: "Ada" });
  await user.click(ada);
  expect(ada).not.toBeChecked();
  // Re-checking appends Ada after Grace, the reverse of the saved order.
  await user.click(ada);
  expect(ada).toBeChecked();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("compares Edit template with the saved template and keeps a refused Save protected", async () => {
  const user = userEvent.setup();
  const saved = channelTemplates.save({
    name: "Launch",
    teams: ["t1"],
    agents: ["a".repeat(64)],
    canvas: "# Goal",
  });
  render(<ChannelTemplateSettings agents={agents} active={() => true} />);
  const edit = () =>
    user.click(screen.getByRole("button", { name: "Edit Launch" }));
  await edit();
  await user.click(screen.getByRole("button", { name: "Close template" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  await edit();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(screen.getByRole("textbox", { name: /Starting Canvas/ }), {
    target: { value: "x".repeat(24 * 1024 + 1) },
  });
  await user.click(screen.getByRole("button", { name: "Save template" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Canvas is too large");
  await user.keyboard("{Escape}");
  expect(dialog).toHaveAccessibleName("Discard changes?");
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(channelTemplates.snapshot()).toEqual([saved]);
});
