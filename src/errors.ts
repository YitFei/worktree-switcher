/** Exit codes: 1 = failure, 2 = refused (lock held, unknown process on a port, bad usage). */
export class WtsError extends Error {
  constructor(message: string, readonly exitCode = 1) {
    super(message);
  }
}
