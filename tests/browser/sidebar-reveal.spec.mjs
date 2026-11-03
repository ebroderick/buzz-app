import { expect, test } from "./playwright-test.mjs";
import { build, preview } from "./vite-server.mjs";
import react from "@vitejs/plugin-react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchPageErrors } from "./page-errors.mjs";

let server;
let directory;
let url;

test.beforeAll(async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  directory = await mkdtemp(join(tmpdir(), "buzz-sidebar-reveal-"));
  const config = {
    root,
    configFile: false,
    envFile: false,
    logLevel: "error",
    plugins: [react()],
    build: {
      rollupOptions: {
        input: join(root, "tests/browser/sidebar-reveal.html"),
      },
      outDir: join(directory, "dist"),
      emptyOutDir: true,
      target: "esnext",
    },
  };
  await build(config);
  server = await preview({
    ...config,
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
  });
  url = `http://127.0.0.1:${server.httpServer.address().port}/tests/browser/sidebar-reveal.html`;
});
test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.httpServer.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

const key = `buzz-view.v1:${JSON.stringify(["fixture", "channel-sidebar"])}`;
// Scroll events dispatch in the rendering step, before animation frames.
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const update = (page, next) =>
  page.evaluate((next) => window.sidebar.update(next), next);
const rows = (page, count) =>
  page.evaluate(
    (count) => window.sidebar.update({ rows: window.sidebar.rows(count) }),
    count,
  );

// jsdom does not reject focus inside hidden/inert content. Use the real row
// and disclosure owners here; preference-refresh permutations stay in Vitest.
test("focus skips a row relocated into a collapsed section", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  await update(page, { relocated: false });
  const beta = page.locator('button[data-channel-id="beta"]');
  await beta.focus();
  await expect(beta).toBeFocused();

  await update(page, { relocated: true });

  await expect(
    page.locator('[data-sidebar-section="starred"] [data-channel-id="beta"]'),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "gamma", exact: true }),
  ).toBeFocused();
  expect(errors).toEqual([]);
});

test("restoring the saved position does not cancel a delayed entry's reveal", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [key, { collapsed: [], scrollTop: 800, width: 260, location: "row:5" }],
  );
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  // Remount at another destination whose entry is still being looked up.
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "row:45",
      rows: window.sidebar.rows(45),
    }),
  );
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(800);
  // Let the restoration's scroll event dispatch before the entry arrives.
  await settle(page);
  await rows(page, 50);
  await expect(sidebar.locator('[data-row="45"]')).toBeInViewport({
    ratio: 1,
  });
  expect(errors).toEqual([]);
});

test("a user scroll before a delayed entry renders keeps that position for its destination", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await rows(page, 45);
  await update(page, { mounted: true });
  await expect(sidebar.locator('[data-row="0"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await update(page, { at: "row:45" });
  // The user scrolls before the destination's entry renders.
  await sidebar.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(200);
  await settle(page);
  await rows(page, 50);
  await expect(sidebar.locator('[data-row="45"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await settle(page);
  // The user's scroll wins over the late reveal.
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  // Leave (Settings replaces the sidebar) and come back to the same place.
  await update(page, { mounted: false });
  await update(page, { mounted: true });
  await expect(sidebar.locator('[data-row="45"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  await settle(page);
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  expect(errors).toEqual([]);
});

test("late contributed rows retry the sidebar reveal without moving the owner", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "conversation:late",
      rows: window.sidebar.rows(50),
    }),
  );
  const contributedRow = sidebar.getByRole("button", { name: "Late item" });
  await expect(contributedRow).toHaveCount(0);

  // This external-store publication rerenders SectionContents, not Sidebar.
  await page.evaluate(() =>
    window.sidebar.publishContributionRows([
      { id: "late", label: "Late item" },
    ]),
  );
  await expect(contributedRow).toBeInViewport({ ratio: 0.9 });
  await expect(contributedRow).toHaveAttribute("aria-current", "page");
  expect(errors).toEqual([]);
});

test("a user scroll before contributed rows arrive cancels their reveal", async ({
  page,
}) => {
  const { errors } = watchPageErrors(page);
  await page.goto(url);
  const sidebar = page.getByRole("navigation", {
    name: "Sidebar",
    exact: true,
  });
  await page.evaluate(() =>
    window.sidebar.update({
      mounted: true,
      at: "conversation:late",
      rows: window.sidebar.rows(50),
    }),
  );
  await sidebar.hover();
  await page.mouse.wheel(0, 200);
  await expect
    .poll(() => sidebar.evaluate((element) => element.scrollTop))
    .toBe(200);
  await settle(page);

  await page.evaluate(() =>
    window.sidebar.publishContributionRows([
      { id: "late", label: "Late item" },
    ]),
  );
  const contributedRow = sidebar.getByRole("button", { name: "Late item" });
  await expect(contributedRow).toHaveAttribute("aria-current", "page");
  await settle(page);
  expect(await sidebar.evaluate((element) => element.scrollTop)).toBe(200);
  await expect(contributedRow).not.toBeInViewport();
  expect(errors).toEqual([]);
});
