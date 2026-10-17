import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { Company, card, seedCompany, signIn } from "./support/api";

/* Alerts are optional: off for every company until its owner / admin switches them on at the client's request.
 * Run the API with WHATSAPP_PROVIDER=log so WhatsApp messages are recorded instead of really sent. */

const [good, local] = readFileSync(join(__dirname, "test-data", "07_alert_recipients.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [name, channel, address] = line.split(",");
    return { name, channel, address };
  });

test.describe("UC-17/18 optional WhatsApp alerts", () => {
  test.describe.configure({ mode: "serial" });
  let company: Company;
  test.beforeAll(async ({ request }) => {
    company = await seedCompany(request);
  });

  test("UC-17 alerts are off by default; the owner switches them on for this client", async ({ page }) => {
    await signIn(page, company.owner);
    const panel = card(page, "WhatsApp Alerts");
    await expect(panel.getByText("Off", { exact: true })).toBeVisible();
    await expect(panel.getByText("WhatsApp ready (log only: test mode)")).toBeVisible();
    await expect(panel.getByLabel("Send alerts")).not.toBeChecked();

    await panel.getByLabel("Send alerts").check();
    await panel.getByLabel("Send hour").selectOption("8");
    await panel.getByRole("button", { name: "Save alert settings" }).click();
    await expect(panel.getByText("Alerts are on.")).toBeVisible();
    await expect(panel.getByText("On · daily at 08:00")).toBeVisible();
  });

  test("UC-18 a WhatsApp recipient needs consent and an international number", async ({ page }) => {
    await signIn(page, company.owner);
    const panel = card(page, "WhatsApp Alerts");
    await panel.getByLabel("Recipient name").fill(local.name);
    await panel.getByLabel("Recipient address").fill(local.address);
    await expect(panel.getByRole("button", { name: "Add recipient" })).toBeDisabled();       // no consent yet
    await panel.getByLabel("Recipient consent").check();
    await panel.getByRole("button", { name: "Add recipient" }).click();
    await expect(panel.getByText(/international format/)).toBeVisible();

    await panel.getByLabel("Recipient name").fill(good.name);
    await panel.getByLabel("Recipient address").fill(good.address);
    await panel.getByLabel("Recipient consent").check();
    await panel.getByRole("button", { name: "Add recipient" }).click();
    await expect(panel.getByText(`${good.name} will receive alerts on WhatsApp (+923001234567).`)).toBeVisible();
    await expect(panel.getByTestId("alert-recipient")).toHaveCount(1);
  });

  test("UC-18 the preview shows what needs attention and a test message is delivered", async ({ page }) => {
    await signIn(page, company.owner);
    const panel = card(page, "WhatsApp Alerts");
    const preview = panel.getByTestId("alert-preview");
    await expect(preview).toContainText("TCS holds USD 67.50 COD for 1 order");
    await expect(preview).toContainText("1 fix worth USD 5 waiting for a checker");
    await expect(preview).toContainText("USD 67.50 can be claimed back");

    await preview.getByRole("button", { name: "Send test now" }).click();
    await expect(panel.getByText(`Sent to ${good.name} (WhatsApp via log)`)).toBeVisible();
    const log = panel.getByLabel("Alert deliveries");
    await expect(log).toContainText("Sent");
    await expect(log).toContainText("+923******567");
    await expect(log).not.toContainText("+923001234567");                                    // the log is masked
  });

  test("UC-17 analysts do not see or change alert settings", async ({ page }) => {
    await signIn(page, company.analyst);
    await expect(page.getByText("Open Leakage")).toBeVisible();
    await expect(card(page, "WhatsApp Alerts")).toHaveCount(0);
  });
});
