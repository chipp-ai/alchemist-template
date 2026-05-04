/**
 * Typed API client. Wraps fetch with /api prefix, JSON parsing, and 401 handling.
 */

class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

interface RequestOptions {
  /**
   * If true, do NOT redirect to /login on a 401 response. Required for the
   * `checkAuth()` call on app mount — without it, the very first /auth/me
   * fires before any session exists, returns 401, and the redirect kicks
   * the user from /signup back to /login the moment they land. Also useful
   * for optional auth checks on public pages (share URLs, marketing pages
   * that conditionally render a logged-in CTA).
   */
  silent401?: boolean;
}

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const url = path.startsWith("/api") ? path : `/api${path}`;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });

  if (response.status === 401) {
    if (!opts.silent401) {
      // Session expired or not authenticated -- redirect to login.
      // Avoid circular import: set user to null directly and navigate.
      window.location.hash = "#/login";
    }
    throw new ApiError(401, "Unauthorized");
  }

  // Parse response body (may be empty for 204)
  let data: unknown = null;
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) {
    data = await response.json();
  }

  if (!response.ok) {
    const message =
      (data && typeof data === "object" && "message" in data
        ? (data as { message: string }).message
        : null) ?? `Request failed with status ${response.status}`;
    throw new ApiError(response.status, message, data);
  }

  return data as T;
}

export const api = {
  get<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>("GET", path, undefined, opts);
  },

  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>("POST", path, body, opts);
  },

  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>("PATCH", path, body, opts);
  },

  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return request<T>("PUT", path, body, opts);
  },

  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return request<T>("DELETE", path, undefined, opts);
  },
};

export { ApiError };
