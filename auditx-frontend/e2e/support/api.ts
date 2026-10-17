import { APIRequestContext, Page, expect } from "@playwright/test";

export const API = (process.env.E2E_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
export const PASSWORD = "Str0ng#Passw0rd";

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

/** A small, fully known dataset: 4 findings across all three channels (see docs/testing/BUSINESS_TEST_CASES.md). */
export async function seedCompany(request: APIRequestContext): Promise<Company> {
  const stamp = uniqueStamp();
  const { email: owner, token } = await registerOwner(request, stamp);
  const analyst = `analyst.${stamp}@e2e-auditx.com`;
  const auditor = `auditor.${stamp}@e2e-auditx.com`;
  await addActiveMember(request, token, analyst, "ANALYST", "Asad Analyst");
  await addActiveMember(request, token, auditor, "AUDITOR", "Ayesha Auditor");

  await upload(request, token, "ecom_orders",
    "source_order_number,total_amount,payment_method\nO1,100.00,card\nO2,55.00,card\nO4,80.00,card\nC1,60.00,COD\nC2,70.00,COD\n");
  await upload(request, token, "gateway_transactions",
    "source_order_number,source_transaction_id,gross_amount,fee_amount,processed_at,payout_reference\n" +
      "O1,ch_1,100.00,3.20,2026-09-01T10:00:00Z,po_A\nO3,ch_3,42.00,1.52,2026-09-01T11:00:00Z,po_A\n" +
      "O4,ch_4,75.00,2.48,2026-09-01T12:00:00Z,po_A\n");
  await upload(request, token, "courier_remittances",
    "tracking_number,source_order_number,courier_name,parcel_status,cod_amount,delivery_charges,remittance_reference,booked_at,delivered_at,remitted_at\n" +
      "T1,C1,TCS,Delivered,60.00,2.50,CPR-1,2026-09-01,2026-09-03,2026-09-10\nT2,C2,TCS,Delivered,70.00,2.50,,2026-09-01,2026-09-03,\n" +
      // the courier report runs to 10 Oct, so C2 (delivered 3 Sep, never remitted) is past the COD SLA
      "T9,LATE,TCS,In transit,0,0,,2026-10-10,,\n");
  await upload(request, token, "bank_transactions",
    'transaction_date,description,credit_amount,debit_amount\n2026-09-03,STRIPE PAYOUT po_A,"209.80",\n2026-09-11,TCS CPR-1,"57.50",\n');

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
