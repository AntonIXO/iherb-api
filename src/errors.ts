export type IHerbErrorCode =
  | "HTTP_ERROR"
  | "BLOCKED"
  | "RATE_LIMITED"
  | "PARSE_ERROR"
  | "NOT_FOUND";

export class IHerbError extends Error {
  readonly code: IHerbErrorCode;

  constructor(message: string, code: IHerbErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class IHerbHttpError extends IHerbError {
  readonly status: number;

  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, "HTTP_ERROR", options);
    this.status = status;
  }
}

export class IHerbBlockedError extends IHerbError {
  readonly status: number;

  constructor(message = "iHerb blocked the request or returned a challenge", status = 403) {
    super(message, "BLOCKED");
    this.status = status;
  }
}

export class IHerbRateLimitError extends IHerbError {
  readonly status = 429;
  readonly retryAfterMs: number | null;

  constructor(retryAfterMs: number | null) {
    super("iHerb rate limit exceeded", "RATE_LIMITED");
    this.retryAfterMs = retryAfterMs;
  }
}

export class IHerbParseError extends IHerbError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, "PARSE_ERROR", options);
  }
}

export class IHerbNotFoundError extends IHerbError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
  }
}
