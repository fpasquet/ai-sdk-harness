/** `run()`, its failure as a rejection rather than a throw. */
export function attempt(run: () => void): Promise<void> {
  try {
    run();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
