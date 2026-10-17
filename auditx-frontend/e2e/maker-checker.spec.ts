import { expect, test } from "@playwright/test";
import { Company, card, seedCompany, signIn } from "./support/api";

let company: Company;
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ request }) => {
  company = await seedCompany(request);
});

test("UC-05 an analyst's resolution goes to a checker instead of closing the finding", async ({ page }) => {
  await signIn(page, company.analyst);
  const matrix = card(page, "Discrepancy Tracking Matrix");
  await matrix.getByLabel("Status filter").selectOption("");             // keep the row visible after it moves to pending
  await matrix.getByLabel("Search findings").fill("O2");
  const row = matrix.locator("tbody > tr").filter({ hasText: "O2" }).first();
  page.once("dialog", (d) => d.accept("Customer paid by bank transfer"));
  await row.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("O2 sent to a checker for approval.")).toBeVisible();
  await expect(row).toContainText("Awaiting checker");

  const approvals = card(page, "Approvals · Maker-Checker");
  await approvals.getByLabel("Proposed by filter").selectOption("USER");
  await expect(approvals.getByRole("button", { name: "Withdraw" })).toBeVisible();      // makers can only withdraw
  await expect(approvals.getByRole("button", { name: "Approve" })).toHaveCount(0);
});

test("UC-06 an auditor approves it and the finding is resolved", async ({ page }) => {
  await signIn(page, company.auditor);
  const approvals = card(page, "Approvals · Maker-Checker");
  await approvals.getByLabel("Proposed by filter").selectOption("USER");
  const item = approvals.locator("li").filter({ hasText: "O2" });
  await item.getByRole("button", { name: "Approve" }).click();
  await expect(approvals.getByText("Nothing is waiting for approval.")).toBeVisible();

  const matrix = card(page, "Discrepancy Tracking Matrix");
  await matrix.getByLabel("Status filter").selectOption("");
  await matrix.getByLabel("Search findings").fill("O2");
  await expect(matrix.locator("tbody > tr").filter({ hasText: "O2" }).first()).toContainText("Resolved");
});

test("UC-06 an auditor rejects the AI fix with a reason and it reopens", async ({ page }) => {
  await signIn(page, company.auditor);
  const approvals = card(page, "Approvals · Maker-Checker");
  await approvals.getByLabel("Proposed by filter").selectOption("AI");
  const item = approvals.locator("li").filter({ hasText: "O4" });
  page.once("dialog", (d) => d.accept("Promo code was never valid"));
  await item.getByRole("button", { name: "Reject" }).click();
  await expect(approvals.getByText("Nothing is waiting for approval.")).toBeVisible();
  await approvals.getByLabel("Approval status filter").selectOption("REJECTED");
  await expect(approvals.getByText(/Promo code was never valid/)).toBeVisible();
});
