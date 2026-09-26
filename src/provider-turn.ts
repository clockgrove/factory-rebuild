export const DEFAULT_PROVIDER_TURN_IDLE_TIMEOUT_MS = 15 * 60 * 1_000;

export class ProviderTurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Provider turn produced no progress for ${timeoutMs} ms`);
    this.name = "ProviderTurnTimeoutError";
  }
}

export class ProviderTurnIncompleteError extends Error {
  constructor() {
    super("Provider stream ended without turn.completed");
    this.name = "ProviderTurnIncompleteError";
  }
}

export class ProviderTurnGuard {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private ended = false;
  private timeoutError: ProviderTurnTimeoutError | undefined;
  private readonly timeout: Promise<never>;
  private rejectTimeout: (error: ProviderTurnTimeoutError) => void = () =>
    undefined;

  constructor(private readonly idleTimeoutMs: number) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0)
      throw new Error("Provider turn idle timeout must be a positive integer");
    this.timeout = new Promise<never>((_resolve, reject) => {
      this.rejectTimeout = reject;
    });
    this.reset();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  progress(): void {
    if (this.ended || this.controller.signal.aborted) return;
    if (this.timer) clearTimeout(this.timer);
    this.reset();
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    try {
      return await Promise.race([operation, this.timeout]);
    } catch (error) {
      throw this.timeoutError ?? error;
    }
  }

  finish(): void {
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private reset(): void {
    // Progress reschedules the deadline, not the promise observed by a race
    // already waiting on a callback-driven provider operation.
    this.timer = setTimeout(() => {
      this.timeoutError = new ProviderTurnTimeoutError(this.idleTimeoutMs);
      this.controller.abort(this.timeoutError);
      this.rejectTimeout(this.timeoutError);
    }, this.idleTimeoutMs);
  }
}

export function requireCompletedProviderTurn(completed: boolean): void {
  if (!completed) throw new ProviderTurnIncompleteError();
}

export async function closeProviderEventStream(
  events: AsyncIterator<unknown>,
  turn: ProviderTurnGuard,
  wait: boolean,
): Promise<void> {
  let closing: Promise<unknown>;
  try {
    closing = Promise.resolve(events.return?.());
  } catch (error) {
    if (wait) throw error;
    return;
  }
  if (wait) {
    await turn.race(closing);
    return;
  }
  void closing.catch(() => undefined);
}
