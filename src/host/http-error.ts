/**
 * Structured API error — classification by code, not message matching
 * (message regexes kept mis-bucketing server-side failures as 400s).
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}
