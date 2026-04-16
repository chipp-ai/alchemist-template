/**
 * Custom Error Classes
 *
 * Type-safe error handling with proper HTTP status codes.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  public readonly statusCode: ContentfulStatusCode;
  public readonly code: string;

  constructor(message: string, statusCode: ContentfulStatusCode, code: string) {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with ID '${id}' not found` : `${resource} not found`;
    super(message, 404, "NOT_FOUND");
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400, "BAD_REQUEST");
    this.name = "BadRequestError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
    this.name = "ConflictError";
  }
}

export class ExternalServiceError extends AppError {
  public readonly service: string;

  constructor(service: string, message: string) {
    super(`${service}: ${message}`, 502, "EXTERNAL_SERVICE_ERROR");
    this.name = "ExternalServiceError";
    this.service = service;
  }
}
