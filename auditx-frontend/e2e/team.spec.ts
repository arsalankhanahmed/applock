import { expect, test } from "@playwright/test";
import { Company, PASSWORD, card, seedCompany, signIn, uniqueStamp } from "./support/api";

let company: Company;
test.beforeAll(async ({ request }) => {
  company = await seedCompany(request);
});

test("UC-09 owner invites an auditor by link and the invitee joins", async ({ page, browser }) => {
  const email = `invitee.${uniqueStamp()}@e2e-auditx.com`;
  await signIn(page, company.owner);
  const team = card(page, "Team");
  await team.getByRole("button", { name: "Add member" }).click();
  await team.getByRole("button", { name: "Send email invite" }).click();
  const form = team.locator("form");
  await form.getByLabel("Work email").fill(email);
  await form.getByRole("combobox").selectOption("AUDITOR");
  await form.getByRole("button", { name: "Send invite" }).click();
  const link = team.getByText(/\/invite\?token=/);
  await expect(link).toBeVisible();
  const url = new URL((await link.textContent())!.trim());

  const guest = await browser.newPage();
  await guest.goto(`${url.pathname}${url.search}`);
  await expect(guest.getByText(/invited you as/)).toContainText("Auditor");
  await guest.getByLabel("Full name").fill("Imran Invitee");
  await guest.getByLabel(/Choose a password/).fill(PASSWORD);
  await guest.getByLabel("Repeat password").fill(PASSWORD);
  await guest.getByRole("button", { name: "Join and sign in" }).click();
  await expect(guest.getByText("Open Leakage")).toBeVisible();

  await guest.goto(`${url.pathname}${url.search}`);                        // the link works only once
  await expect(guest.getByText(/not valid|already used|expired/i)).toBeVisible();
  await guest.close();
});

test("UC-10 a member added with a temporary password must choose their own", async ({ page, browser }) => {
  const email = `temp.${uniqueStamp()}@e2e-auditx.com`;
  await signIn(page, company.owner);
  const team = card(page, "Team");
  await team.getByRole("button", { name: "Add member" }).click();
  await team.getByRole("button", { name: "Set a temporary password" }).click();
  const form = team.locator("form");
  await form.getByLabel(/Full name/).fill("Tariq Temp");
  await form.getByLabel("Work email").fill(email);
  await form.getByRole("combobox").selectOption("ANALYST");
  await form.getByRole("button", { name: "Generate" }).click();
  const temporary = await form.getByLabel(/Temporary password/).inputValue();
  await form.getByRole("button", { name: "Add to team" }).click();
  await expect(team.getByText(`${email} · ${temporary}`)).toBeVisible();

  const member = await browser.newPage();
  await signIn(member, email, temporary);
  await expect(member.getByRole("heading", { name: "Choose your own password" })).toBeVisible();
  await member.getByLabel("Current password").fill(temporary);
  await member.getByLabel(/New password/).fill(PASSWORD);
  await member.getByLabel("Repeat new password").fill(PASSWORD);
  await member.getByRole("button", { name: "Change password" }).click();
  await expect(member.getByText("Open Leakage")).toBeVisible();
  await member.close();
});

test("UC-11 analysts and viewers do not get team management controls", async ({ page }) => {
  await signIn(page, company.analyst);
  await expect(page.getByText("Open Leakage")).toBeVisible();
  await expect(card(page, "Team").getByRole("button", { name: "Add member" })).toHaveCount(0);
});
