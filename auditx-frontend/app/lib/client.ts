/* Shared API client and browser session for the AuditX dashboard and the invite page. */

export const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const SESSION_KEY = "auditx.session";
export const MIN_PASSWORD_LENGTH = 10;

export interface Session {
  token: string;
  companyName: string;
  role: string;
  mustChangePassword?: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  org_id: string;
  user_id: string;
  role: string;
  company_name: string;
  must_change_password?: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function describe(detail: unknown): string {
  if (typeof detail === "string") return detail;
  // Pydantic validation errors: show the first message in plain words.
  if (Array.isArray(detail) && detail.length > 0 && typeof detail[0] === "object" && detail[0] && "msg" in detail[0]) {
    return String((detail[0] as { msg: unknown }).msg);
  }
  return JSON.stringify(detail);
}

export async function api<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(0, `Cannot reach the AuditX API at ${API_BASE}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "detail" in body) detail = describe((body as { detail: unknown }).detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function sessionFromToken(res: TokenResponse): Session {
  return {
    token: res.access_token,
    companyName: res.company_name,
    role: res.role,
    mustChangePassword: !!res.must_change_password,
  };
}

export function loadSession(): Session | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  try {
    if (session) window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable (private mode) — session lives in memory only */
  }
}
