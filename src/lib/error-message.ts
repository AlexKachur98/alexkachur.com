// The text of whatever was thrown, which need not be an Error.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
