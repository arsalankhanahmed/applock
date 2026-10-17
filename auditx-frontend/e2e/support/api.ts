import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APIRequestContext, Page, expect } from "@playwright/test";

export const API = (process.env.E2E_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
export const PASSWORD = "Str0ng#Passw0rd";

/** Test data lives as plain CSV files in e2e/test-data (see its README for the expected findings). */
const DATA_DIR = join(__dirname, "..", "test-data");
const TEST_DATA: Array<[target: string, file: string]> = [
  ["ecom_orders", "01_erp_orders.csv"],
  ["gateway_transactions", "02_gateway_transactions.csv"],
  ["courier_remittances", "03_courier_remittances.csv"],
  ["bank_transactions", "04_bank_statement.csv"],
];

export type Company = { owner: string; analyst: string; auditor: string; ownerToken: string; stamp: string };

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function uniqueStamp(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function ok<T>(res: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(res.ok(), `${res.url()} -> ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()) as T;
}

export async function registerOwner(request: APIRequestContext, stamp: string): Promise<{ email: string; token: string }> {
  const email = `owner.${stamp}@e2e-auditx.com`;
  const body = await ok<{ access_token: string }>(
    await request.post(`${API}/api/v1/auth/register`, {
      data: { company_name: `E2E Retail ${stamp}`, full_name: "Olivia Owner", email, password: PASSWORD, brand_currency: "USD" },
    }),
  );
  return { email, token: body.access_token };
}

/** Adds a member with a temporary password, then completes their first-login password change. */
export async function addActiveMember(request: APIRequestContext, ownerToken: string, email: string, role: string, name: string) {
  const temporary = "Temporary#12345";
  await ok(await request.post(`${API}/api/v1/users`, {
    headers: bearer(ownerToken), data: { full_name: name, email, password: temporary, role },
  }));
  const login = await ok<{ access_token: string }>(await request.post(`${API}/api/v1/auth/login`, { data: { email, password: temporary } }));
  await ok(await request.post(`${API}/api/v1/me/password`, {
    headers: bearer(login.access_token), data: { current_password: temporary, new_password: PASSWORD },
  }));
}

async function upload(request: APIRequestContext, token: string, target: string, csv: string) {
  const res = await request.post(`${API}/api/v1/ingest/${target}`, {
    headers: bearer(token),
    multipart: { file: { name: `${target}.csv`, mimeType: "text/csv", buffer: Buffer.from(csv) } },
  });
  expect(res.status()).toBe(202);
  await waitForJob(request, token, (await res.json()).job_id);
}

async function waitForJob(request: APIRequestContext, token: string, jobId: string) {
  await expect
    .poll(async () => (await ok<{ status: string }>(await request.get(`${API}/api/v1/jobs/${jobId}`, { headers: bearer(token) }))).status,
      { timeout: 30_000, intervals: [250, 500, 1000] })
    .toBe("SUCCEEDED");
}

/** Registers a fresh company, adds a maker and a checker, uploads e2e/test-data and reconciles it (4 known findings). */
export async function seedCompany(request: APIRequestContext): Promise<Company> {
  const stamp = uniqueStamp();
  const { email: owner, token } = await registerOwner(request, stamp);
  const analyst = `analyst.${stamp}@e2e-auditx.com`;
  const auditor = `auditor.${stamp}@e2e-auditx.com`;
  await addActiveMember(request, token, analyst, "ANALYST", "Asad Analyst");
  await addActiveMember(request, token, auditor, "AUDITOR", "Ayesha Auditor");

  for (const [target, file] of TEST_DATA) {
    await upload(request, token, target, readFileSync(join(DATA_DIR, file), "utf8"));
  }

  const run = await request.post(`${API}/api/v1/reconciliation/run`, { headers: bearer(token), data: { auto_heal: true } });
  expect(run.status()).toBe(202);
  await waitForJob(request, token, (await run.json()).job_id);
  return { owner, analyst, auditor, ownerToken: token, stamp };
}

export async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/dashboard");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export const card = (page: Page, title: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
