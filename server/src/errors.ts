/** An HTTP failure. `message` is shown to the student verbatim. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A processing failure with a reason a student can read. Ends the review as FAILED. */
export class PipelineError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "PipelineError";
  }
}
