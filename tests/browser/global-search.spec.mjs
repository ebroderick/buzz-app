import { test, expect } from "./fixture.mjs";

const button = (page, name) => page.getByRole("button", { name, exact: true });
// The palette scales in and its content slides in after a delay. Both hold
// still at their start before moving, so Playwright's stable check can pass
// mid-entrance. Finish the entrance before measuring rows or moving the pointer.
const entered = async (dialog) => {
  await expect(dialog).not.toHaveAttribute("data-starting-style");
  await dialog.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().endTime !== Infinity,
        )
        .map((animation) => animation.finished),
    ),
  );
};
test("search arrows traverse the conversation action and recent activity, Enter opens and Escape restores focus", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  const trigger = button(page, "Search Buzz");
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toHaveAttribute("spellcheck", "false");
  await expect(input).toHaveAttribute("autocorrect", "off");
  await expect(input).toHaveAttribute("autocapitalize", "off");
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toBeFocused();
  const first = dialog
    .locator(
      '[role="group"][aria-label="This conversation"], [role="rowgroup"][aria-label="This conversation"]',
    )
    .locator("[data-search-result]");
  const second = dialog
    .locator(
      '[role="group"][aria-label="Recent activity"], [role="rowgroup"][aria-label="Recent activity"]',
    )
    .locator("[data-search-result]")
    .first();
  await expect(second).toBeVisible();
  for (const [key, result] of [
    ["ArrowDown", first],
    ["ArrowDown", second],
    ["ArrowUp", first],
    ["ArrowUp", first],
  ]) {
    await input.press(key);
    await expect(input).toBeFocused();
    await expect(result).toHaveAttribute("aria-selected", "true");
    await expect(result).toHaveAttribute("data-highlighted", "true");
    await expect(input).toHaveAttribute(
      "aria-activedescendant",
      await result.getAttribute("id"),
    );
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const modifier = await page.evaluate(() =>
    /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control",
  );
  await page.keyboard.press(`${modifier}+k`);
  await expect(input).toBeFocused();
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await input.fill("Alpha");
  const alpha = dialog
    .locator(
      '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
    )
    .locator("[data-search-result]")
    .filter({ hasText: /Alpha/ });
  await expect(alpha).toBeVisible();
  // Typed text selects its best match, so Enter needs no arrow keys.
  await expect(input).toBeFocused();
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await alpha.getAttribute("id"),
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
  ).toBeVisible();
});

test("changing search scope returns focus to the input without clearing the query", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const scopeAction = page
    .getByRole("dialog", { name: "Search Buzz" })
    .locator(
      '[role="group"][aria-label="This conversation"], [role="rowgroup"][aria-label="This conversation"]',
    )
    .locator("[data-search-result]");
  await scopeAction.click();

  const scoped = page.getByRole("dialog", { name: "Search this conversation" });
  const scopedInput = scoped.getByRole("combobox", {
    name: "Search this conversation",
  });
  await expect(scopedInput).toBeFocused();
  await page.keyboard.type("hello");
  await expect(scopedInput).toHaveValue("hello");

  const chip = scoped.getByRole("button", {
    name: /Remove .* search scope/,
  });
  await chip.focus();
  await chip.press("Enter");
  const global = page.getByRole("dialog", { name: "Search Buzz" });
  const input = global.getByRole("combobox", { name: "Search Buzz" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("hello");
  // Relevance can put an inline setting or plugin ahead of the scope action.
  const first = global
    .locator("[data-search-result], .search-control-row")
    .first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await first.getAttribute("id"),
  );
});

// Real portal → routed timeline/thread ownership and focus, in both browser engines.
test.describe("public search destination", () => {
  test.use({ openSearch: true, productionBroker: true });
  test("opens a public nonmember exact reply without enabling writes or adding a sidebar row", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    // Waiting for a rendered conversation is an ordering mitigation for the
    // WebKit lost-fill failure. Its root cause is unknown, and the failing
    // schedule has not been reproduced against this change.
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    let previewSurface;
    for (const mode of ["cold", "warm"]) {
      await button(page, "Search Buzz").click();
      const input = page.getByRole("combobox", { name: "Search Buzz" });
      await input.fill("crew-search");
      await expect(input).toHaveValue("crew-search");
      const result = page.getByRole("option", {
        name: /crew-search exact public reply/,
      });
      await expect(result).toBeVisible();
      const start = performance.now();
      await result.click();
      const thread = page.getByRole("region", {
        name: "Thread messages",
        exact: true,
      });
      const row = thread.locator(`[data-message-id="${app.searchTarget.id}"]`);
      await expect(row).toBeVisible();
      await expect(row).toBeFocused();
      if (previewSurface) {
        // A new exact-message route in this channel must keep the preview
        // mounted, rather than flash the access-loading screen and replay entry.
        expect(await previewSurface.evaluate((node) => node.isConnected)).toBe(
          true,
        );
      }
      app.report.measurements.push({
        mode,
        clickToFocusedMs: performance.now() - start,
      });
      await expect(page.getByText("Join channel to send messages")).toHaveCount(
        2,
      );
      previewSurface ??= await page
        .getByRole("article", { name: "Conversation", exact: true })
        .getByRole("region", { name: "Channel preview", exact: true })
        .elementHandle();
      await expect(
        page.getByRole("textbox", { name: "Message #open", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("textbox", { name: "Reply to thread", exact: true }),
      ).toHaveCount(0);
      await expect(
        page
          .getByRole("complementary", { name: "Sidebar", exact: true })
          .getByRole("button", { name: "open", exact: true }),
      ).toHaveCount(0);
    }
    const threadPanel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = threadPanel.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const invitation = threadPanel.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    await history.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => {
        const last = await history
          .locator("[data-message-id]")
          .last()
          .boundingBox();
        const overlay = await invitation.boundingBox();
        return !!last && !!overlay && last.y + last.height <= overlay.y - 20;
      })
      .toBe(true);
    await expect(
      threadPanel.getByRole("button", { name: "Join", exact: true }),
    ).toHaveAttribute("data-size", "sm");
    await threadPanel
      .getByRole("button", { name: "Join", exact: true })
      .click();
    const reply = threadPanel.getByRole("textbox", {
      name: "Reply to thread",
      exact: true,
    });
    await expect(reply).toBeFocused();
    await expect(page.getByText("Join channel to send messages")).toHaveCount(
      0,
    );
    await expect(
      page.getByRole("textbox", { name: "Message #open", exact: true }),
    ).toBeVisible();
    expect(
      app.report.queries
        .filter(({ filter }) => filter.search)
        .every(({ filter }) => !filter["#h"]),
    ).toBe(true);
  });

  test("finds an unjoined public channel by name, previews it, joins it and sends a message", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    await button(page, "Search Buzz").click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    const result = page
      .locator(
        '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: /^open/ });
    await expect(result).toContainText(
      "Public channel · not joined · 3 members",
    );
    await result.click();
    const composer = page.getByRole("textbox", {
      name: "Message #open",
      exact: true,
    });
    await expect(page.getByText("Join channel to send messages")).toBeVisible();
    // Real layout: the invitation overlays history without shortening its
    // viewport, and the last message can still scroll clear of the invitation.
    const history = page.getByRole("region", {
      name: "Channel message history",
      exact: true,
    });
    const notice = page.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    // A short viewport makes this a real scroll-clearance check.
    await page.setViewportSize({ width: 960, height: 260 });
    await expect(history.locator("[data-message-id]").last()).toBeVisible();
    await expect
      .poll(() => history.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    await history.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect
      .poll(async () => {
        const feed = await history.boundingBox();
        const overlay = await notice.boundingBox();
        const last = await history
          .locator("[data-message-id]")
          .last()
          .boundingBox();
        return (
          !!feed &&
          !!overlay &&
          !!last &&
          Math.abs(feed.y + feed.height - overlay.y - overlay.height) < 1 &&
          last.y + last.height <= overlay.y - 20
        );
      })
      .toBe(true);
    await expect(composer).toHaveCount(0);
    const sidebar = page.getByRole("complementary", {
      name: "Sidebar",
      exact: true,
    });
    await expect(
      sidebar.getByRole("button", { name: "open", exact: true }),
    ).toHaveCount(0);
    await button(page, "Join").click();
    await expect(composer).not.toHaveAttribute("aria-disabled", "true");
    await expect(composer).toBeFocused();
    await expect(page.getByText(/Join channel to send messages/)).toHaveCount(
      0,
    );
    await expect(
      sidebar.getByRole("button", { name: "open", exact: true }),
    ).toBeVisible();
    expect(app.report.lifecyclePublications).toEqual([
      expect.objectContaining({
        kind: 9021,
        tags: [["h", app.openChannelId]],
      }),
    ]);
    await composer.pressSequentially("Hello from a new member");
    await composer.press("Enter");
    await expect
      .poll(() =>
        app.report.publications.map(({ event }) => [
          event.kind,
          event.content,
          event.tags.find(([key]) => key === "h")?.[1],
        ]),
      )
      .toContainEqual([9, "Hello from a new member", app.openChannelId]);
  });

  test("focuses the composer when live membership arrives before the join request settles", async ({
    page,
    app,
  }) => {
    const release = app.holdJoin();
    await page.goto(app.origin);
    await button(page, "Search Buzz").click();
    await page.getByRole("combobox", { name: "Search Buzz" }).fill("ope");
    await page
      .locator(
        '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: /^open/ })
      .click();
    const composer = page.getByRole("textbox", {
      name: "Message #open",
      exact: true,
    });
    await expect(composer).toHaveCount(0);
    await button(page, "Join").click();
    await expect(page.getByText(/Join channel to send messages/)).toHaveCount(
      0,
    );
    expect(app.report.lifecyclePublications).toHaveLength(1);
    await expect(composer).not.toHaveAttribute("aria-disabled", "true");
    await expect(composer).toBeFocused();
    release();
    await composer.pressSequentially("Joined");
    await expect(composer).toHaveText("Joined");
  });

  // A rejected Join grows the preview notice, and the thread's end spacer
  // grows with it. A reader at the end of the thread must stay at the end.
  test("a rejected Join keeps a thread reader at its end, clear of the notice", async ({
    page,
    app,
  }) => {
    await page.addInitScript(() => {
      window.revealedRows = [];
      document.addEventListener(
        "reading-positioned",
        () =>
          window.revealedRows.push(document.activeElement?.dataset.messageId),
        true,
      );
    });
    // A short viewport makes the two-message thread scroll.
    await page.setViewportSize({ width: 1100, height: 360 });
    await page.goto(app.origin);
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await button(page, "Search Buzz").click();
    await page
      .getByRole("combobox", { name: "Search Buzz" })
      .fill("crew-search");
    await page
      .getByRole("option", { name: /crew-search exact public reply/ })
      .click();
    const threadPanel = page.getByRole("complementary", {
      name: "Thread",
      exact: true,
    });
    const history = threadPanel.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const notice = threadPanel.getByRole("region", {
      name: "Channel preview",
      exact: true,
    });
    const last = history.locator(`[data-message-id="${app.searchTarget.id}"]`);
    // The exact reveal completes a frame after it focuses the reply. Scroll
    // after it: a later completion would rightly take over the position.
    await expect
      .poll(() => page.evaluate(() => window.revealedRows))
      .toContain(app.searchTarget.id);
    await expect
      .poll(() => history.evaluate((el) => el.scrollHeight > el.clientHeight))
      .toBe(true);
    // The reveal can leave the reply at the end without following it. Scroll
    // away and back as a reader does, so the thread follows its end.
    await history.hover();
    await page.mouse.wheel(0, -2000);
    await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(0);
    await page.mouse.wheel(0, 2000);
    const fromEnd = () =>
      history.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      );
    await expect.poll(fromEnd).toBeLessThan(1);
    const height = () =>
      notice.evaluate((el) => el.getBoundingClientRect().height);
    const before = await height();
    await page.route(
      "**/api/relay/**/channel-lifecycle-publish",
      async (route) => {
        const event = route.request().postDataJSON();
        expect(event.kind).toBe(9021);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            accepted: false,
            event_id: event.id,
            message: "Joining this channel is not allowed",
          }),
        });
      },
      { times: 1 },
    );
    await threadPanel
      .getByRole("button", { name: "Join", exact: true })
      .click();
    await expect(notice.getByRole("alert")).toContainText(
      "Joining this channel is not allowed",
    );
    expect(await height()).toBeGreaterThan(before);
    // The notice grows before ResizeObserver updates the spacer and end-follow.
    await expect
      .poll(async () => {
        const [row, overlay] = await Promise.all([
          last.boundingBox(),
          notice.boundingBox(),
        ]);
        return row.y + row.height - (overlay.y - 20);
      })
      .toBeLessThanOrEqual(0);
    await expect.poll(fromEnd).toBeLessThan(1);
  });
});

test("keyboard selection follows its page while matching conversations arrive", async ({
  page,
  app,
}) => {
  const rail = page.getByRole("button", {
    name: "Community switcher: Primary",
    exact: true,
  });
  // Hold startup membership before navigation so the channel list arrives after
  // the palette opens. A reload here can retire a live stream while its initial
  // control request is still in flight; that race is unrelated to selection.
  const held = [];
  let holding = true;
  await page.route("**/api/relay/*/query", async (route) => {
    const filters = route.request().postDataJSON();
    if (holding && filters.some(({ kinds }) => kinds?.includes(39002)))
      await new Promise((resolve) => held.push(resolve));
    await route.continue();
  });
  try {
    await page.goto(app.origin);
    await expect(rail).toBeVisible();
    await button(page, "Search Buzz").click();
    const dialog = page.getByRole("dialog", {
      name: "Search Buzz",
      exact: true,
    });
    const input = dialog.getByRole("combobox", { name: "Search Buzz" });
    await expect(
      dialog.getByText("Connecting to this community…", { exact: true }),
    ).toHaveCount(0);
    await input.fill("a");
    const recent = dialog
      .locator(
        '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
      )
      .locator("[data-search-result]");
    const projects = dialog
      .locator(
        '[role="group"][aria-label="Pages"], [role="rowgroup"][aria-label="Pages"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: "Messages" });
    await expect(projects).toBeVisible();
    // The connected palette is mounted, but its channel list is still held.
    await expect(
      dialog.getByText("Connecting to this community…", { exact: true }),
    ).toHaveCount(0);
    await expect(recent).toHaveCount(0);
    await entered(dialog);
    const id = await projects.getAttribute("id");
    while ((await input.getAttribute("aria-activedescendant")) !== id)
      await input.press("ArrowDown");
    holding = false;
    for (const resolve of held.splice(0)) resolve();
    await expect(recent.first()).toBeVisible();
    await expect(
      page.getByRole("textbox", {
        name: "Message #Alpha",
        exact: true,
        includeHidden: true,
      }),
    ).toBeAttached();
    await expect(input).toBeFocused();
    // Channel arrival must preserve the explicitly selected page.
    await expect(input).toHaveAttribute("aria-activedescendant", id);
    await input.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message #Alpha", exact: true }),
    ).toBeVisible();
  } finally {
    holding = false;
    for (const resolve of held.splice(0)) resolve();
  }
});

test("a resting pointer does not steal the typed selection when results move under it", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  const rows = dialog.locator("[data-search-result]");
  // Measure where the row stays: after the entrance and recent activity load.
  await expect(
    dialog
      .locator(
        '[role="group"][aria-label="Recent activity"], [role="rowgroup"][aria-label="Recent activity"]',
      )
      .locator("[data-search-result]")
      .filter({ hasText: /Beta/ }),
  ).toBeVisible();
  await entered(dialog);
  const row = rows.nth(2);
  // The first move inside the palette only records the pointer; the next
  // one is a real move and selects.
  await row.hover({ position: { x: 20, y: 10 } });
  const box = await row.boundingBox();
  const y = box.y + 10;
  await page.mouse.move(box.x + 30, y);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await input.fill("a");
  const alpha = dialog
    .locator(
      '[role="group"][aria-label="Channels"], [role="rowgroup"][aria-label="Channels"]',
    )
    .locator("[data-search-result]")
    .filter({ hasText: /Alpha/ });
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  // WebKit replays the resting position when rows move; that is not a hover.
  await page.mouse.move(box.x + 30, y);
  await expect(alpha).toHaveAttribute("aria-selected", "true");
  // A real move selects whichever result is now under the pointer.
  await page.mouse.move(box.x + 40, y);
  const hovered = await page.evaluate(
    ([x, y]) =>
      document.elementFromPoint(x, y)?.closest("[data-search-result]")?.id,
    [box.x + 40, y],
  );
  expect(hovered).toBeTruthy();
  expect(hovered).not.toBe(await alpha.getAttribute("id"));
  await expect(dialog.locator(`[id="${hovered}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(alpha).toHaveAttribute("aria-selected", "false");
});

// The real rendered palette and verified finite reader must carry operator constraints
// into the relay query, rather than filtering a truncated first result page.
test.describe("message search operators", () => {
  test.use({
    openSearch: true,
    productionBroker: true,
    historyCounts: { alpha: 1, beta: 1 },
  });
  test("combines author, channel and inclusive/exclusive day boundaries in the rendered flow", async ({
    page,
    app,
  }) => {
    await page.goto(app.origin);
    // The same unproven ordering mitigation for the WebKit lost-fill failure
    // as the public search destination test above.
    await expect(page.locator("[data-message-id]").first()).toBeVisible();
    await button(page, "Search Buzz").click();
    const input = page.getByRole("combobox", { name: "Search Buzz" });
    const query = `crew-search in:${app.openChannelId} from:${app.searchTarget.pubkey} after:2023-11-14 before:2023-11-15`;
    await input.fill(query);
    // Attribute a missing result to the typed query or to the search.
    await expect(input).toHaveValue(query);
    await expect(
      page
        .locator("[data-search-result]")
        .filter({ hasText: /crew-search exact public reply/ }),
    ).toBeVisible();
    const filter = app.report.queries.find(
      ({ filter }) => filter.search === "crew-search" && filter.authors?.length,
    );
    expect(filter?.filter).toMatchObject({
      "#h": [app.openChannelId],
      authors: [app.searchTarget.pubkey],
      since: Date.UTC(2023, 10, 14) / 1000,
      until: Date.UTC(2023, 10, 15) / 1000 - 1,
    });
    await input.fill(
      `crew-search in:${app.openChannelId} from:${app.searchTarget.pubkey} before:2023-11-14`,
    );
    await expect(
      page
        .locator("[data-search-result]")
        .filter({ hasText: /crew-search exact public reply/ }),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.search === "crew-search" &&
            filter.until === Date.UTC(2023, 10, 14) / 1000 - 1,
        ),
      )
      .toBe(true);
    // `me`, a named channel and a month resolve in the same rendered flow.
    await input.fill("crew-search from:me in:#open during:2023-11");
    await expect(
      page
        .locator("[data-search-result]")
        .filter({ hasText: /crew-search exact public reply/ }),
    ).toBeVisible();
    expect(
      app.report.queries.find(
        ({ filter }) =>
          filter.search === "crew-search" &&
          filter.since === Date.UTC(2023, 10, 1) / 1000,
      )?.filter,
    ).toMatchObject({
      "#h": [app.openChannelId],
      authors: [app.searchTarget.pubkey],
      until: Date.UTC(2023, 11, 1) / 1000 - 1,
    });
    // Quoted operators are phrase text, sent whole as a full-text search.
    const phrase = '"crew-search during:2023-11 from:me"';
    await input.fill(phrase);
    await expect
      .poll(
        () =>
          app.report.queries.find(({ filter }) => filter.search === phrase)
            ?.filter,
      )
      .toEqual({
        kinds: [40002, 40008, 9],
        search: phrase,
        search_mode: "fulltext",
        limit: 20,
      });
  });
});

test("inline search exposes selected grid rows and hands focus to the destination setting", async ({
  page,
  app,
}) => {
  await page.goto(app.origin);
  await button(page, "Search Buzz").click();
  const dialog = page.getByRole("dialog", { name: "Search Buzz" });
  const input = dialog.getByRole("combobox", { name: "Search Buzz" });
  await input.fill("color mode");
  const grid = dialog.getByRole("grid", { name: "Search results" });
  const row = grid.getByRole("row", {
    name: "Appearance — Color mode",
    exact: true,
  });
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    await row.getAttribute("id"),
  );
  const snapshot = await grid.ariaSnapshot();
  expect(snapshot).toContain('rowgroup "Settings"');
  expect(snapshot).toContain('row "Appearance — Color mode" [selected]');
  const mode = row.getByRole("combobox", { name: "Color mode" });
  await mode.click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-color-mode", "dark");
  await expect(dialog).toBeVisible();
  await mode.focus();
  await mode.press("Enter");
  await page.getByRole("option", { name: "Light", exact: true }).focus();
  await page.getByRole("option", { name: "Light", exact: true }).press("Enter");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-mode",
    "light",
  );
  await expect(dialog).toBeVisible();
  await input.focus();
  await input.press("Enter");
  await expect(dialog).toBeHidden();
  const target = page.locator("#setting-mode");
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((node) => node.contains(document.activeElement)),
    )
    .toBe(true);
});
