import { expect, test } from "@playwright/test";
import { Company, PASSWORD, card, seedCompany, signIn } from "./support/api";

let company: Company;
test.beforeAll(async ({ request }) => {
  company = await seedCompany(request);
});

test("UC-01 wrong password shows one generic error and stays on the login form", async ({ page }) => {
  await signIn(page, company.owner, "Wrong#Password1");
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("UC-01 owner signs in, sees the command center, and signs out @mobile", async ({ page }) => {
  await signIn(page, company.owner);
  await expect(page.getByText("Open Leakage")).toBeVisible();
  await expect(card(page, "Discrepancy Tracking Matrix")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("UC-01 the session survives a page reload", async ({ page }) => {
  await signIn(page, company.owner);
  await expect(page.getByText("Open Leakage")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Open Leakage")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
});

test("UC-02 a password change keeps this session and signs out the old token", async ({ page, request }) => {
  const old = (await (await request.post(`${process.env.E2E_API_URL ?? "http://localhost:8000"}/api/v1/auth/login`, {
    data: { email: company.analyst, password: PASSWORD } })).json()).access_token as string;
  await page.waitForTimeout(1100);                                          // tokens carry whole-second timestamps
  await signIn(page, company.analyst);
  await page.getByRole("button", { name: "Change password" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Change password" });
  await dialog.getByLabel("Current password").fill(PASSWORD);
  await dialog.getByLabel(/New password/).fill("Brand#New#Pass1");
  await dialog.getByLabel("Repeat new password").fill("Brand#New#Pass1");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("Open Leakage")).toBeVisible();
  const me = await request.get(`${process.env.E2E_API_URL ?? "http://localhost:8000"}/api/v1/me`, { headers: { Authorization: `Bearer ${old}` } });
  expect(me.status()).toBe(401);
});
