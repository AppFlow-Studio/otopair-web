import { expect, test, type Locator, type Page } from "@playwright/test";

const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";
const LOGIN_WAIT_MS = 5 * 60 * 1000;

async function ensurePortalAccess(page: Page) {
  await page.goto(`${BASE_URL}/schedule`, { waitUntil: "domcontentloaded" });

  const scheduleHeading = page.getByRole("heading", { name: "Schedule" });
  const dashboardHeading = page.getByRole("heading", { name: /dashboard/i });
  const signInMarkers = [
    page.getByRole("button", { name: /sign in/i }),
    page.getByRole("button", { name: /continue/i }),
    page.getByRole("heading", { name: /sign in/i }),
    page.locator("input[name='identifier'], input[name='emailAddress']"),
  ];

  if (await scheduleHeading.isVisible().catch(() => false)) {
    return;
  }

  let signInVisible = false;
  for (const locator of signInMarkers) {
    if (await locator.isVisible().catch(() => false)) {
      signInVisible = true;
      break;
    }
  }

  if (signInVisible) {
    console.log("");
    console.log("Playwright opened the portal login.");
    console.log("Please complete sign-in in the visible browser window.");
    console.log(`Waiting up to ${LOGIN_WAIT_MS / 60000} minutes for portal access...`);
    await Promise.race([
      scheduleHeading.waitFor({ state: "visible", timeout: LOGIN_WAIT_MS }),
      dashboardHeading.waitFor({ state: "visible", timeout: LOGIN_WAIT_MS }),
    ]);
  }

  if (await dashboardHeading.isVisible().catch(() => false)) {
    await page.goto(`${BASE_URL}/schedule`, { waitUntil: "networkidle" });
  }

  await expect(scheduleHeading).toBeVisible({ timeout: 30000 });
}

async function waitForLateStartCard(page: Page, customerName: string) {
  const card = page.getByRole("button", { name: new RegExp(customerName, "i") });
  await expect(card).toBeVisible({ timeout: 30000 });
  return card;
}

async function openReview(page: Page, customerName: string) {
  const card = await waitForLateStartCard(page, customerName);
  await card.click();
  await expect(
    page.getByRole("heading", {
      name: new RegExp(`${customerName} has not started on time`, "i"),
    })
  ).toBeVisible({ timeout: 15000 });
}

async function expectOpenReviewCount(page: Page, expectedCount: number) {
  await expect(page.locator("body")).toContainText("Late Start Decisions");
  await expect(page.locator("body")).toContainText(
    expectedCount === 1
      ? "1 booking chain needs a delay decision"
      : `${expectedCount} booking chains need delay decisions`
  );
}

test.describe("late-start review portal flow", () => {
  test("seeds scenario and exercises accept, deny, and manual delay actions", async ({ page }) => {
    test.setTimeout(LOGIN_WAIT_MS + 180000);

    await ensurePortalAccess(page);

    await page.getByRole("button", { name: "Seed late-start test data" }).click();
    await expect(page.locator("body")).toContainText("Late-start test data seeded", {
      timeout: 30000,
    });

    await expect(page.getByText("Late Start Decisions")).toBeVisible();
    await expectOpenReviewCount(page, 3);

    await openReview(page, "Aaron Accept");
    await expect(page.locator("body")).toContainText("alternate mechanic");
    await expect(page.locator("body")).toContainText("James Openbay");
    await page.getByRole("button", { name: /^accept$/i }).click();
    await expect(page.locator("body")).toContainText("Late-start delay applied", {
      timeout: 30000,
    });
    await expect(page.getByRole("heading", { name: /Aaron Accept has not started on time/i })).toHaveCount(0);
    await expectOpenReviewCount(page, 2);

    await openReview(page, "Carlos Push");
    await expect(page.locator("body")).toContainText("Suggested: 12:45 PM", {
      timeout: 15000,
    });
    await page.getByRole("button", { name: /^deny$/i }).click();
    await expect(page.locator("body")).toContainText("Late-start delay snoozed until the next checkpoint", {
      timeout: 30000,
    });
    await expect(page.getByRole("heading", { name: /Carlos Push has not started on time/i })).toHaveCount(0);
    await expectOpenReviewCount(page, 1);

    await openReview(page, "Ethan Manual");
    await expect(page.locator("body")).toContainText("Automatic delay could not be built safely.", {
      timeout: 15000,
    });
    await expect(page.getByRole("button", { name: /apply manual delay/i })).toBeVisible();
    await page.getByRole("button", { name: /apply manual delay/i }).click();
    await expect(page.locator("body")).toContainText("Manual late-start delay applied", {
      timeout: 30000,
    });

    await expect(page.getByText("Late Start Decisions")).toHaveCount(0);
    await expect(page.locator("body")).toContainText("Late-start delay pending");

    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "networkidle" });
    await expect(page.locator("body")).toContainText(/Late start decisions|Pending actions|Today's schedule/);
  });
});
