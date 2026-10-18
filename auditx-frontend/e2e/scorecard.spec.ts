import { expect, test } from "@playwright/test";
import { Company, card, reconcile, seedCompany, signIn, uploadTestFile } from "./support/api";

/* The standard dataset has only TCS. Files 08-10 add Leopards: three COD orders delivered, remitted 1-2 days
 * later and banked. Expected: Leopards A (100); TCS C (~67): 7 days to remit, C2 never remitted. */

let company: Company;
test.beforeAll(async ({ request }) => {
  company = await seedCompany(request);
  await uploadTestFile(request, company.ownerToken, "ecom_orders", "08_erp_orders_leopards.csv");
  await uploadTestFile(request, company.ownerToken, "courier_remittances", "09_courier_leopards.csv");
  await uploadTestFile(request, company.ownerToken, "bank_transactions", "10_bank_statement_leopards.csv");
  await reconcile(request, company.ownerToken);
});

test("UC-20 couriers are graded and ranked, best first", async ({ page }) => {
  await signIn(page, company.auditor);                                       // read-only roles see it too
  const scorecard = card(page, "Courier Scorecard");
  const rows = scorecard.getByTestId("scorecard-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("LEOPARDS");
  await expect(rows.nth(0)).toContainText("A · 100");
  await expect(rows.nth(0)).toContainText("1.7 d");
  await expect(rows.nth(1)).toContainText("TCS");
  await expect(rows.nth(1)).toContainText("C · 67");
  await expect(rows.nth(1)).toContainText("7.0 d");
  await expect(rows.nth(1)).toContainText("50.0%");
  await expect(rows.nth(1)).toContainText("$67.50");
  const leaders = scorecard.getByLabel("Courier leaders");
  await expect(leaders).toContainText("Best overall: LEOPARDS");
  await expect(leaders).toContainText("Fastest to remit: LEOPARDS");
  await expect(leaders).toContainText("Lowest charge: LEOPARDS");
});

test("UC-20 the score breakdown explains the grade", async ({ page }) => {
  await signIn(page, company.owner);
  const scorecard = card(page, "Courier Scorecard");
  await scorecard.getByTestId("scorecard-row").filter({ hasText: "TCS" }).click();
  const breakdown = scorecard.getByLabel("Score breakdown for TCS");
  await expect(breakdown).toContainText("Remittance speed (30%)72");
  await expect(breakdown).toContainText("Remitted on time (20%)50");
  await expect(breakdown).toContainText("Money not owed (15%)0");
  await expect(scorecard.getByTestId("scorecard-detail")).toContainText("1 parcel");           // C2 overdue
});

test("UC-20 the period filter and CSV download", async ({ page }) => {
  await signIn(page, company.owner);
  const scorecard = card(page, "Courier Scorecard");
  await scorecard.getByLabel("Scorecard period").selectOption("30");
  const tcs = scorecard.getByTestId("scorecard-row").filter({ hasText: "TCS" });
  await expect(tcs.locator("td").nth(2)).toHaveText("1");                    // only T9 was booked in the last 30 days
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    scorecard.getByRole("button", { name: "Download CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("courier-scorecard-30d.csv");
  const path = await download.path();
  const text = (await import("node:fs")).readFileSync(path!, "utf8");
  expect(text.split("\n")[0]).toContain("courier_name,grade,score");
  expect(text).toContain("LEOPARDS,A,100.0");
});
