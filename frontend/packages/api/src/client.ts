import { InputError, type AdminLogin, type SessionTokens } from "./contracts";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(
      code === "INVALID_AUTHORIZATION"
        ? "This email code is invalid or expired. Request a new email."
        : code === "INVALID_CREDENTIALS"
          ? "Sign-in could not be verified. Check your details and email verification."
          : status === 429
            ? "Too many attempts. Wait before trying again."
            : status === 401 || status === 403
              ? "Access expired, revoked or unavailable. Sign in again or request a new share."
              : status === 404
                ? "This item is unavailable. It may have been deleted, restricted or not yet generated."
                : status === 503
                  ? "This service is unavailable in the current environment."
                  : status === 413
                    ? "This file exceeds the server upload limit."
                    : status === 415
                      ? "Unsupported file. Choose a valid PDF, JPG, JPEG or PNG."
                      : status === 400 || status === 409 || status === 422
                        ? "Check the fields and source readiness, then try again."
                        : status === 0
                          ? "Connection interrupted or request timed out. Try again."
                          : "The request could not be completed.",
    );
  }
}
export interface SecureStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  remove(): Promise<void>;
}
export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
/** Secrets and medical responses remain in memory; only the native adapter stores a refresh credential. */
export class ApiClient {
  protected token = "";
  protected epoch = 0;
  private controllers = new Set<AbortController>();
  private listeners = new Set<() => void>();
  readonly baseUrl: string;
  protected transport: typeof fetch;
  private timeoutMs: number;
  constructor(options: ClientOptions) {
    const base = options.baseUrl.replace(/\/$/, "");
    if (base && (!/^https?:\/\//.test(base) || /[?#]/.test(base)))
      throw new Error("Invalid API base URL");
    this.baseUrl = base;
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 20000;
  }
  /** Whether a protected response of this status ends the session. Admin sessions override this: a 403 there means "your role may not do this", not "signed out". */
  protected endsSession(status: number) {
    return status === 401 || status === 403;
  }
  onClear(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  get authorized() {
    return !!this.token;
  }
  clear() {
    this.epoch++;
    this.token = "";
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    for (const fn of this.listeners) fn();
  }
  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    protectedRequest = true,
    binary = false,
  ): Promise<T> {
    if (!path.startsWith("/api/v1/") || path.includes("://"))
      throw new Error("Invalid API path");
    const epoch = this.epoch,
      controller = new AbortController();
    this.controllers.add(controller);
    const deadline = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Accept: binary ? "*/*" : "application/json",
      };
      if (protectedRequest) {
        if (!this.token) throw new ApiError(401, "SESSION_REQUIRED");
        headers.Authorization = "Bearer " + this.token;
      }
      const multipart =
        typeof FormData !== "undefined" && body instanceof FormData;
      if (body !== undefined && !multipart)
        headers["Content-Type"] = "application/json";
      const response = await this.transport(this.baseUrl + path, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : multipart
              ? (body as FormData)
              : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
      if (epoch !== this.epoch) throw new ApiError(401, "SESSION_CHANGED");
      if (!response.ok) {
        let code = "REQUEST_FAILED";
        try {
          const data = await response.json();
          if (typeof data?.error?.code === "string") code = data.error.code;
        } catch {
          /* no server details */
        }
        if (protectedRequest && this.endsSession(response.status))
          this.clear();
        throw new ApiError(response.status, code);
      }
      const result = binary ? await response.blob() : await response.json();
      if (epoch !== this.epoch) throw new ApiError(401, "SESSION_CHANGED");
      return result as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, "NETWORK_ERROR");
    } finally {
      clearTimeout(deadline);
      this.controllers.delete(controller);
    }
  }
}
export class PatientSession extends ApiClient {
  private refreshToken = "";
  private expiresAt = 0;
  private renewing?: Promise<void>;
  private storageQueue: Promise<void> = Promise.resolve();
  constructor(
    options: ClientOptions,
    private storage: SecureStorage,
  ) {
    super(options);
  }
  private store(value: string | null) {
    const operation = this.storageQueue
      .catch(() => {})
      .then(() =>
        value === null ? this.storage.remove() : this.storage.write(value),
      );
    this.storageQueue = operation;
    return operation;
  }
  override clear() {
    this.refreshToken = "";
    this.expiresAt = 0;
    super.clear();
    void this.store(null).catch(() => {});
  }
  private async accept(tokens: SessionTokens, epoch: number) {
    if (epoch !== this.epoch) throw new ApiError(401, "SESSION_CHANGED");
    this.token = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.expiresAt = Date.now() + tokens.expires_in * 1000;
    try {
      await this.store(tokens.refresh_token);
    } catch {
      this.clear();
      throw new ApiError(0, "SECURE_STORAGE_UNAVAILABLE");
    }
  }
  async login(email: string, password: string) {
    const epoch = this.epoch;
    const r = await super.request<SessionTokens>(
      "/api/v1/auth/login",
      "POST",
      { email, password },
      false,
    );
    await this.accept(r, epoch);
  }
  async restore() {
    const epoch = this.epoch;
    try {
      const raw = await this.storage.read();
      if (epoch !== this.epoch) return false;
      this.refreshToken = raw ?? "";
      if (!raw) return false;
      await this.renew();
      return this.authorized;
    } catch {
      this.clear();
      return false;
    }
  }
  private renew() {
    if (this.renewing) return this.renewing;
    const epoch = this.epoch,
      refresh = this.refreshToken;
    if (!refresh) {
      this.clear();
      return Promise.reject(new ApiError(401, "SESSION_EXPIRED"));
    }
    this.renewing = (async () => {
      try {
        const r = await super.request<SessionTokens>(
          "/api/v1/auth/refresh",
          "POST",
          { refresh_token: refresh },
          false,
        );
        await this.accept(r, epoch);
      } catch (e) {
        if (epoch === this.epoch) this.clear();
        throw e;
      }
    })().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }
  override async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
    protectedRequest = true,
    binary = false,
  ): Promise<T> {
    if (protectedRequest && Date.now() >= this.expiresAt - 15000)
      await this.renew();
    return super.request<T>(path, method, body, protectedRequest, binary);
  }
  async logout() {
    try {
      await this.request("/api/v1/auth/logout", "POST", {});
    } finally {
      this.clear();
      await this.storageQueue;
    }
  }
  async reset(token: string, new_password: string) {
    await super.request(
      "/api/v1/auth/reset-password",
      "POST",
      { token, new_password },
      false,
    );
    this.clear();
  }
}
export class DoctorSession extends ApiClient {
  private expiry?: ReturnType<typeof setTimeout>;
  authorize(token: string, expiresAt: string) {
    this.clear();
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0)
      throw new ApiError(403, "SHARE_EXPIRED");
    this.token = token;
    this.expiry = setTimeout(
      () => this.clear(),
      Math.min(remaining, 2147483647),
    );
  }
  override clear() {
    clearTimeout(this.expiry);
    super.clear();
  }
}

export type AdminSessionEnd = "expired" | "signed_out" | "denied";
/** Admin access tokens are short-lived and there is no refresh: the token lives only in memory and the session ends, with a stated reason, when it runs out. */
export class AdminSession extends ApiClient {
  private expiry?: ReturnType<typeof setTimeout>;
  private reason?: AdminSessionEnd;
  private until = 0;
  protected override endsSession(status: number) {
    return status === 401;
  }
  /** When the access token stops working (milliseconds since the epoch), or 0 when signed out. */
  get expiresAt() {
    return this.token ? this.until : 0;
  }
  /** Why the last session ended; valid inside an onClear listener. */
  get endReason(): AdminSessionEnd | undefined {
    return this.reason;
  }
  async login(email: string, password: string) {
    const epoch = this.epoch;
    const result = await super.request<AdminLogin>(
      "/api/v1/admin/auth/login",
      "POST",
      { email, password },
      false,
    );
    if (epoch !== this.epoch) throw new ApiError(401, "SESSION_CHANGED");
    if (!(result.expires_in > 0)) throw new ApiError(0, "BAD_SESSION");
    this.reason = undefined;
    this.token = result.access_token;
    this.until = Date.now() + result.expires_in * 1000;
    this.expiry = setTimeout(
      () => this.end("expired"),
      Math.min(result.expires_in * 1000, 2147483647),
    );
  }
  end(reason: AdminSessionEnd) {
    this.reason = reason;
    this.clear();
  }
  signOut() {
    this.end("signed_out");
  }
  override clear() {
    clearTimeout(this.expiry);
    this.reason ??= "denied";
    super.clear();
  }
}

export function adminMessage(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (!(error instanceof ApiError))
    return "Something went wrong. Try again.";
  switch (error.code) {
    case "INVALID_CREDENTIALS":
      return "Sign-in failed. Check your email and password.";
    case "FORBIDDEN":
      return "Your admin role is not allowed to do this.";
    case "ACCOUNT_STATE_CONFLICT":
      return "That account is not in a state that allows this action. Reload and check its status.";
    case "JOB_NOT_RETRYABLE":
      return "This job cannot be retried right now. It may already be queued, running, completed or out of attempts.";
    case "SETTING_NOT_PERMITTED":
      return "This setting cannot be changed from the Admin Dashboard.";
    case "SETTING_UNCHANGED":
      return "That is already the value in effect. Enter a different value.";
    case "INVALID_SETTING_VALUE":
      return "That value is not allowed. Check the range, and that the idle refresh lifetime does not exceed the absolute one.";
    case "SELF_APPROVAL_FORBIDDEN":
      return "You proposed this change, so a different admin must approve it.";
    case "DECISION_EXISTS":
      return "A decision is already recorded for this version. Reload to see it.";
    case "APPROVAL_NOT_REQUIRED":
      return "This version does not need approval.";
    case "VERSION_SUPERSEDED":
      return "A newer version is already in effect, so this one can no longer be approved.";
    case "CLINICAL_APPROVAL_FORBIDDEN":
      return "Clinical approval cannot be set from the Admin Dashboard. Rules saved here are never clinically approved.";
    case "SESSION_REQUIRED":
    case "SESSION_CHANGED":
      return "Your session ended. Sign in again.";
  }
  if (error.status === 429)
    return "Too many attempts. Wait a few minutes and try again.";
  if (error.status === 404) return "That record was not found.";
  if (error.status === 400) return "Check the values you entered.";
  if (error.status === 401) return "Your session ended. Sign in again.";
  if (error.status === 503)
    return "The service is unavailable right now. Try again later.";
  if (error.status === 0)
    return "Connection problem. Check that the server is running, then try again.";
  return "The request could not be completed.";
}

export function safeMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof InputError
    ? error.message
    : "Unable to complete this action. Check the fields and try again.";
}
