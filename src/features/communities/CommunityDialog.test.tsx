// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import { Context } from "@deepseek-ai/cordis";
import { createCommunities, type Communities } from "./service";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { federatedFixture } from "../federated-identity/testing";
import { readView } from "../../shared/view-state";

stubAvatarBrowserApis();

const api = vi.hoisted(() => ({
  inspectProfile: vi.fn<typeof import("./api").inspectProfile>(),
  publishProfile: vi.fn<typeof import("./api").publishProfile>(),
}));
api.inspectProfile.mockRejectedValue(new Error("Relay read failed (403)"));
api.publishProfile.mockResolvedValue();
vi.mock("./api", async (actual) => ({
  ...(await actual<typeof import("./api")>()),
  inspectProfile: api.inspectProfile,
  publishProfile: api.publishProfile,
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("publishes a description-only edit to an existing community profile", async () => {
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "Before" },
      profile: { name: "Fixture", picture: "", about: "Before" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about: "After" },
      profile: { name: "Fixture", picture: "", about: "After" },
    });
  const user = userEvent.setup();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  const close = vi.fn();
  render(
    <CommunityDialog communities={communities} mode="join" close={close} />,
  );
  expect(
    screen.getByRole("dialog", { name: "Join a community" }),
  ).toHaveAccessibleDescription(
    "Use your identity across communities. Your profile and conversations stay separate in each one.",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Community URL")).toHaveFocus(),
  );
  // Continue contacts the destination with the viewer's identity before joining.
  expect(screen.getByLabelText("Community URL")).toHaveAccessibleDescription(
    "Paste your community link. Continue shares your Buzz identity with the community so you can preview it before joining.",
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const description = await screen.findByLabelText(
    "Profile description (optional)",
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Display name")).toHaveFocus(),
  );
  expect(screen.queryByText("https://relay.example")).not.toBeInTheDocument();
  await user.clear(description);
  await user.type(description, "After");
  // A stray outside click keeps the dialog and the typed profile.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  expect(description).toHaveValue("After");
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    { name: "Fixture", picture: "", about: "After" },
    { name: "Fixture", about: "Before" },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it.each([false, true])(
  "opens with an unchanged over-limit profile and allows correction (onboarding=%s)",
  async (onboarding) => {
    const about = "a".repeat(800);
    api.inspectProfile.mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", about },
      profile: { name: "Fixture", picture: "", about },
    });
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info")
          return Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        onboarding={onboarding}
        close={() => {}}
      />,
    );
    await user.type(
      screen.getByLabelText("Community URL"),
      "wss://relay.example",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const name = await screen.findByLabelText("Display name");
    await user.type(name, " Renamed");
    expect(
      screen.getByRole("button", { name: "Publish profile & open" }),
    ).toBeDisabled();
    const description = screen.getByLabelText("Profile description (optional)");
    expect(description).toHaveValue(about);
    expect(
      screen.getByText(
        "Shorten the description to 500 characters before saving.",
      ),
    ).toBeVisible();
    await user.clear(description);
    await user.type(description, "Repaired");
    expect(
      screen.getByRole("button", { name: "Publish profile & open" }),
    ).toBeEnabled();
    // The correction field remains available after its validation error clears.
    expect(description).toBeVisible();
    await user.clear(description);
    fireEvent.change(description, { target: { value: about } });
    await user.clear(name);
    await user.type(name, "Fixture");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.publishProfile).not.toHaveBeenCalled();
    expect(communities.joined).toHaveBeenCalledWith(
      expect.objectContaining({ id: "https://relay.example" }),
      { name: "Fixture", picture: "", about },
    );
  },
);

it("names exact relay claim refusals and keeps other failures generic", async () => {
  const user = userEvent.setup();
  let refusal = "invite_exhausted";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      if (route === "claim")
        return Response.json({ error: refusal }, { status: 403 });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Invite code"), "v2.abc");
  expect(screen.getByText("https://relay.example")).toBeVisible();
  for (const [code, shown] of [
    [
      "invite_exhausted",
      "This invite has reached its use limit. Ask for a new invite.",
    ],
    ["invite_expired", "This invite code has expired — ask for a new one."],
    ["invite_invalid", "This invite code is not valid for this community."],
    ["Relay request failed (403)", "Relay request failed (403)"],
  ] as const) {
    refusal = code;
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(shown);
  }
});

it.each([
  "https://relay.example/media/avatar.png",
  "https://RELAY.example:443/media/avatar.png",
])(
  "keeps %s out of first-join local defaults without changing the published profile",
  async (picture) => {
    api.inspectProfile.mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", membershipRequired: true },
      profile: {
        name: "Fixture",
        picture,
        about: "",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info")
          return Response.json({ name: "Fixture", membershipRequired: true });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByLabelText("Community URL"),
      "wss://relay.example",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Display name");
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(api.publishProfile).not.toHaveBeenCalled();
    expect(communities.joined).toHaveBeenCalledWith(
      expect.objectContaining({ id: "https://relay.example" }),
      { name: "Fixture", picture: "", about: "" },
    );
  },
);

it("explains an inherited invalid avatar when editing at join and recovers on replacement", async () => {
  const picture = "http://images.example/avatar.png";
  api.inspectProfile
    .mockResolvedValueOnce({
      exists: true,
      existing: { name: "Fixture", picture },
      profile: { name: "Fixture", picture, about: "" },
    })
    .mockResolvedValueOnce({
      exists: true,
      existing: {},
      profile: {
        name: "Fixture changed",
        picture: "https://images.example/new.png",
        about: "",
      },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/register")) return Response.json({ id: "x" });
      if (url.endsWith("/info"))
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog communities={communities} mode="join" close={() => {}} />,
  );
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(await screen.findByLabelText("Display name"), " changed");
  expect(
    screen.getByRole("button", { name: "Publish profile & open" }),
  ).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Use an HTTPS image URL");
  await user.click(screen.getByRole("button", { name: "Edit avatar" }));
  const input = await screen.findByLabelText("Picture URL (optional)");
  expect(input).toHaveAccessibleDescription(/Use an HTTPS image URL/);
  await user.clear(input);
  await user.type(input, "https://images.example/new.png");
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(api.publishProfile).toHaveBeenCalledWith(
    "https://relay.example",
    {
      name: "Fixture changed",
      picture: "https://images.example/new.png",
      about: "",
    },
    { name: "Fixture", picture },
  );
  await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
});

it("keeps join unavailable after native identity hydration, but still saves a local profile", async () => {
  const ctx = new Context();
  vi.stubGlobal("fetch", vi.fn());
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve("d".repeat(64)),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    const view = render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    expect(
      screen.getByText(/connecting to communities is not available/),
    ).toBeVisible();
    expect(screen.queryByLabelText("Community URL")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    const form = screen.getByRole("dialog").querySelector("form");
    if (!form) throw new Error("Join dialog form is missing");
    fireEvent.submit(form);
    expect(fetch).not.toHaveBeenCalled();
    expect(api.inspectProfile).not.toHaveBeenCalled();
    view.unmount();
    const close = vi.fn();
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={communities}
        mode="profile"
        close={close}
      />,
    );
    await user.type(screen.getByLabelText("Display name"), "Local only");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(communities.snapshot().profile.name).toBe("Local only");
    expect(fetch).not.toHaveBeenCalled();
    expect(api.publishProfile).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
    localStorage.clear();
  }
});

it.each(["", "not-a-relay"])(
  "shows inline relay validation for %j without contacting a relay",
  async (value) => {
    const user = userEvent.setup();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
      />,
    );
    const input = screen.getByLabelText("Community URL");
    if (value) await user.type(input, value);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a wss:// or https:// relay URL",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      /Enter a wss:\/\/ or https:\/\/ relay URL/,
    );
    expect(fetch).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "wss://relay.example");
    expect(screen.queryByRole("alert")).toBeNull();
  },
);

it("prefills an invite but requires explicit discovery and claim before membership", async () => {
  const user = userEvent.setup();
  const requests = vi.fn(async (url: string, init?: RequestInit) => {
    const route = String(url).split("/").at(-1);
    if (route === "register") return Response.json({ id: "x" });
    if (route === "info")
      return Response.json({ name: "Fixture", membershipRequired: true });
    if (route === "claim") {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        code: "v2.abc",
      });
      return Response.json({ error: "invite_expired" }, { status: 403 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
    joined: vi.fn(),
  } as unknown as Communities;
  render(
    <CommunityDialog
      communities={communities}
      mode="join"
      close={() => {}}
      invite={{
        community: "https://relay.example",
        code: "v2.abc",
      }}
    />,
  );
  expect(screen.getByLabelText("Community URL")).toHaveValue(
    "https://relay.example",
  );
  expect(requests).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Invite code")).toHaveValue("v2.abc");
  expect(
    requests.mock.calls.some(([url]) => String(url).endsWith("/claim")),
  ).toBe(false);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "This invite code has expired — ask for a new one.",
  );
  expect(communities.joined).not.toHaveBeenCalled();
});

it.each([
  ["joined", "pending"],
  ["already_member", undefined],
])(
  "a %s claim leaves the default-channel marker %s",
  async (status, marker) => {
    const user = userEvent.setup();
    const viewer = "b".repeat(64);
    api.inspectProfile
      .mockRejectedValueOnce(new Error("not admitted"))
      .mockResolvedValueOnce({
        exists: true,
        existing: { name: "Fixture" },
        profile: { name: "Fixture", picture: "", about: "" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const route = String(url).split("/").at(-1);
        if (route === "register") return Response.json({ id: "x" });
        if (route === "info") return Response.json({ name: "Fixture" });
        if (route === "claim") return Response.json({ status });
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        viewer,
        profile: { name: "", picture: "" },
      }),
      joined: vi.fn(),
    } as unknown as Communities;
    render(
      <CommunityDialog
        communities={communities}
        mode="join"
        close={() => {}}
        invite={{ community: "https://relay.example", code: "v2.abc" }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Invite code (if required)");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(
      await screen.findByRole("button", { name: "Open community" }),
    );
    await waitFor(() => expect(communities.joined).toHaveBeenCalledOnce());
    expect(
      readView(
        `https://relay.example:${viewer}`,
        "default-channels",
        undefined,
      ),
    ).toBe(marker);
  },
);

it("renews policy acceptance after an expired receipt instead of replaying it", async () => {
  const user = userEvent.setup();
  let version = "v1";
  let acceptance = 0;
  const receipts: string[] = [];
  const requests = vi.fn(async (url: string, init?: RequestInit) => {
    const route = String(url).split("/").at(-1);
    if (route === "register") return Response.json({ id: "x" });
    if (route === "info")
      return Response.json({
        name: "Fixture",
        policy: {
          version,
          terms_markdown: "Terms",
          age_attestation_required: false,
        },
      });
    if (route === "accept-policy") {
      expect(JSON.parse(String(init?.body)).policy_version).toBe(version);
      return Response.json({ receipt: `fresh-${++acceptance}` });
    }
    if (route === "claim") {
      const body = JSON.parse(String(init?.body));
      expect(body.code).toBe("v2.abc");
      receipts.push(body.policy_receipt);
      return acceptance === 1
        ? Response.json({ error: "join_policy_required" }, { status: 403 })
        : Response.json({ status: "joined" });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", requests);
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "", picture: "" },
    }),
  } as unknown as Communities;
  render(
    <CommunityDialog
      communities={communities}
      mode="join"
      close={() => {}}
      invite={{ community: "https://relay.example", code: "v2.abc" }}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Invite code");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "current policy acceptance",
  );
  version = "v2";
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Invite code");
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(receipts).toEqual(["fresh-1", "fresh-2"]));
  expect(
    requests.mock.calls.filter(([url]) =>
      String(url).endsWith("/accept-policy"),
    ),
  ).toHaveLength(2);
  expect(screen.queryByText(/current policy acceptance/)).toBeNull();
});

it("opens a checked connection address separately without replacing or removing the original", async () => {
  const viewer = "e".repeat(64);
  const original = "https://old.example";
  const ctx = new Context();
  const profile = { name: "You", picture: "", about: "" };
  api.inspectProfile.mockResolvedValueOnce({
    exists: true,
    existing: profile,
    profile,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({});
      if (route === "info")
        return Response.json({ name: "New community", policy: null });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer),
  );
  try {
    await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
    communities.joined({ id: original, name: "Original" }, profile);
    const connected = {
      ...communities,
      snapshot: () => ({ ...communities.snapshot(), relayAvailable: true }),
    };
    const user = userEvent.setup();
    render(
      <CommunityDialog
        communities={connected}
        mode="join"
        connectionFrom={original}
        close={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Enter a wss:// or https:// relay address without a path. Changing the connection URL does not rename or move this community.",
    );
    const address = screen.getByLabelText("Community URL");
    expect(address).toHaveValue(original);
    fireEvent.change(address, { target: { value: "wss://new.example" } });
    expect(address).toHaveValue("wss://new.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(communities.snapshot().selected).toBe(original);
    await screen.findByLabelText("Display name");
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(communities.snapshot().selected).toBe("https://new.example"),
    );
    expect(communities.snapshot().memberships.map((entry) => entry.id)).toEqual(
      [original, "https://new.example"],
    );
    expect(api.publishProfile).not.toHaveBeenCalled();
  } finally {
    cleanup();
    await ctx.fiber.dispose();
    localStorage.clear();
  }
});

it("offers federated sign-in when joining refuses for it, then lets Continue run the current step", async () => {
  const user = userEvent.setup();
  let refuse = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info" && refuse)
        return Response.json(
          { error: "Federated sign-in is required" },
          { status: 401 },
        );
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const communities = {
    snapshot: () => ({
      status: "ready",
      relayAvailable: true,
      profile: { name: "Local", picture: "" },
    }),
  } as unknown as Communities;
  const h = federatedFixture();
  render(
    <CommunityDialog
      communities={communities}
      federatedIdentity={h.service}
      mode="join"
      close={() => {}}
    />,
  );
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://relay.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  const signIn = await screen.findByRole("button", { name: "Sign in" });
  refuse = false;
  const requests = vi.mocked(fetch).mock.calls.length;
  await user.click(signIn);
  expect(h.service.signIn).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull(),
  );
  // Completing login replays nothing captured before it.
  expect(vi.mocked(fetch).mock.calls.length).toBe(requests);
  await user.clear(screen.getByLabelText("Community URL"));
  await user.type(
    screen.getByLabelText("Community URL"),
    "wss://other.example",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toContain(
    "other.example",
  );
  expect(await screen.findByLabelText("Invite code")).toBeInTheDocument();
});

it.each(["edit", "close"])(
  "replays nothing captured before a pending sign-in (%s)",
  async (change) => {
    const user = userEvent.setup();
    const requests = vi.fn(async (url: string) => {
      const route = String(url).split("/").at(-1);
      if (route === "register") return Response.json({ id: "x" });
      if (route === "info" && requests.mock.calls.length < 3)
        return Response.json(
          { error: "Federated sign-in is required" },
          { status: 401 },
        );
      if (route === "info")
        return Response.json({ name: "Fixture", membershipRequired: true });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", requests);
    const communities = {
      snapshot: () => ({
        status: "ready",
        relayAvailable: true,
        profile: { name: "Local", picture: "" },
      }),
    } as unknown as Communities;
    const h = federatedFixture();
    let finish = () => {};
    vi.mocked(h.service.signIn).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => {
            h.publish({ status: "signed-in" });
            resolve(h.service.snapshot());
          };
        }),
    );
    const view = render(
      <CommunityDialog
        communities={communities}
        federatedIdentity={h.service}
        mode="join"
        close={() => {}}
      />,
    );
    const field = screen.getByLabelText("Community URL");
    await user.type(field, "wss://old.example");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    if (change === "close") view.unmount();
    else {
      await user.clear(field);
      await user.type(field, "wss://new.example");
    }
    const before = requests.mock.calls.length;
    await act(async () => finish());
    expect(requests.mock.calls.length).toBe(before);
    expect(api.publishProfile).not.toHaveBeenCalled();
    if (change === "edit") {
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await waitFor(() =>
        expect(String(requests.mock.calls.at(-1)?.[0])).toContain(
          "new.example",
        ),
      );
    }
  },
);
