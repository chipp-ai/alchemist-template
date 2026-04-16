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

async function request<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
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
    // Session expired or not authenticated -- redirect to login.
    // Avoid circular import: set user to null directly and navigate.
    window.location.hash = "#/login";
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
  get<T = unknown>(path: string): Promise<T> {
    return request<T>("GET", path);
  },

  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("POST", path, body);
  },

  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("PATCH", path, body);
  },

  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return request<T>("PUT", path, body);
  },

  delete<T = unknown>(path: string): Promise<T> {
    return request<T>("DELETE", path);
  },
};

export { ApiError };
