import { expect, test } from "@playwright/test";
import { Company, card, seedCompany, signIn, uploadTestFile } from "./support/api";

/* The standard dataset leaves one claimable finding: TCS delivered C2 (70.00 COD, 2.50 charges) and never
 * remitted the 67.50 it owes. These specs claim it back from TCS three ways. */

async function draftClaimForTcs(page: import("@playwright/test").Page) {
  const recovery = card(page, "Recovery & Claims");
  await expect(recovery.getByRole("tab", { name: /Claimable \(1\)/ })).toBeVisible();
  const tcs = recovery.getByTestId("claimable-group").filter({ hasText: "TCS" });
  await expect(tcs).toContainText("COD Not Remitted");
  await expect(tcs).toContainText("$67.50");
  await tcs.getByRole("button", { name: /Create claim/ }).click();
  await expect(recovery.getByText("CLM-0001 drafted for TCS: $67.50.")).toBeVisible();
  return recovery;
}

test.describe("UC-14/15 claim a courier's debt and record the money coming back", () => {
  test.describe.configure({ mode: "serial" });
  let company: Company;
  test.beforeAll(async ({ request }) => {
    company = await seedCompany(request);
  });

  test("UC-14 an analyst drafts a claim with a ready letter and sends it", async ({ page }) => {
    await signIn(page, company.analyst);
    const recovery = await draftClaimForTcs(page);
    const detail = recovery.getByTestId("claim-detail");
    await expect(detail).toContainText("Outstanding");
    await detail.getByRole("button", { name: "View letter" }).click();
    const letter = detail.getByTestId("claim-letter");
    await expect(letter).toContainText("Claim number: CLM-0001");
    await expect(letter).toContainText("Order C2 / CN T2 - Cash collected on delivery but not remitted");
    await expect(letter).toContainText("Total claimed: USD 67.50");

    await detail.getByRole("button", { name: "Mark as sent" }).click();
    await expect(recovery.getByText("CLM-0001 marked as sent to TCS.")).toBeVisible();
    await expect(recovery.getByTestId("claim-row").first()).toContainText("Sent");

    const matrix = card(page, "Discrepancy Tracking Matrix");
    await matrix.getByLabel("Search findings").fill("C2");
    await expect(matrix.locator("tbody > tr").filter({ hasText: "C2" }).first()).toContainText("Claimed · CLM-0001");
    await expect(recovery.getByRole("tab", { name: /Claimable \(0\)/ })).toBeVisible();   // not claimable twice
  });

  test("UC-15 a part payment, then the rest; full recovery sends C2 to a checker", async ({ page }) => {
    await signIn(page, company.analyst);
    const recovery = card(page, "Recovery & Claims");
    await recovery.getByRole("tab", { name: /Claims/ }).click();
    await recovery.getByTestId("claim-row").filter({ hasText: "CLM-0001" }).getByRole("button").first().click();
    const detail = recovery.getByTestId("claim-detail");
    await detail.getByLabel("Amount received").fill("30.00");
    await detail.getByLabel("Payment reference").fill("IBFT-7781");
    await detail.getByRole("button", { name: "Record payment" }).click();
    await expect(recovery.getByText("$30.00 recorded on CLM-0001; $37.50 still outstanding.")).toBeVisible();
    await expect(recovery.getByTestId("claim-row").first()).toContainText("Partly recovered");

    await expect(detail.getByLabel("Amount received")).toHaveValue("37.50");               // prefilled with the balance
    await detail.getByRole("button", { name: "Record payment" }).click();
    await expect(recovery.getByText("CLM-0001 fully recovered. 1 finding sent to a checker to close.")).toBeVisible();
    await expect(recovery.getByText("$67.50 recovered this month")).toBeVisible();
    await expect(detail.getByLabel("Claim timeline")).toContainText("Payment received · $30.00 · ref IBFT-7781");

    const approvals = card(page, "Approvals · Maker-Checker");
    await approvals.getByLabel("Proposed by filter").selectOption("USER");
    await expect(approvals.locator("li").filter({ hasText: "C2" })).toContainText("Withdraw");      // analyst = maker
  });

  test("UC-15 an auditor sees the recovery, approves the close-out, but cannot create claims", async ({ page }) => {
    await signIn(page, company.auditor);
    const recovery = card(page, "Recovery & Claims");
    await expect(recovery.getByText("Recovered to date")).toBeVisible();
    await expect(recovery.getByText("100.00% of amounts claimed")).toBeVisible();
    await expect(recovery.getByRole("button", { name: /Create claim/ })).toHaveCount(0);

    const approvals = card(page, "Approvals · Maker-Checker");
    await approvals.getByLabel("Proposed by filter").selectOption("USER");
    const item = approvals.locator("li").filter({ hasText: "C2" });
    await item.getByRole("button", { name: "Approve" }).click();
    await expect(approvals.getByText("Nothing is waiting for approval.")).toBeVisible();
    const matrix = card(page, "Discrepancy Tracking Matrix");
    await matrix.getByLabel("Status filter").selectOption("");
    await matrix.getByLabel("Search findings").fill("C2");
    await expect(matrix.locator("tbody > tr").filter({ hasText: "C2" }).first()).toContainText("Resolved");
  });
});

test("UC-16 AuditX spots the recovery in the courier's next report by itself", async ({ page, request }) => {
  const company = await seedCompany(request);
  await signIn(page, company.analyst);
  const recovery = await draftClaimForTcs(page);
  await recovery.getByTestId("claim-detail").getByRole("button", { name: "Mark as sent" }).click();
  await expect(recovery.getByText("CLM-0001 marked as sent to TCS.")).toBeVisible();

  // A week later TCS's report shows C2 remitted under CPR-2 and the bank statement shows the credit.
  await uploadTestFile(request, company.ownerToken, "courier_remittances", "05_courier_update_c2_remitted.csv");
  await uploadTestFile(request, company.ownerToken, "bank_transactions", "06_bank_statement_update.csv");

  await page.getByRole("button", { name: "Run reconciliation + auto-heal" }).click();
  await expect(page.getByRole("button", { name: "Run reconciliation + auto-heal" })).toBeEnabled({ timeout: 45_000 });
  await expect(recovery.getByText("$67.50 recovered this month")).toBeVisible({ timeout: 20_000 });

  await recovery.getByRole("tab", { name: /Claims/ }).click();
  await recovery.getByLabel("Claim status filter").selectOption("RECOVERED");
  const row = recovery.getByTestId("claim-row").filter({ hasText: "CLM-0001" });
  await expect(row).toContainText("Recovered");
  await row.getByRole("button").first().click();
  await expect(recovery.getByTestId("claim-detail").getByLabel("Claim timeline")).toContainText(
    "Payment seen in courier / bank data · $67.50",
  );
  await expect(recovery.getByTestId("claim-detail")).toContainText("Cleared in data");
});
