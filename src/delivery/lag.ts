import { attachFault, type Fault, transient } from "../fault.js";
import { GITHUB_LAG_MS } from "../github-client.js";

/** When this process first saw each postcondition not hold. */
const firstSeen = new Map<string, number>();

/**
 * A delivery postcondition that does not hold yet (a merge GitHub has not
 * shown, an ancestry check after a merge): transient while GitHub may still
 * lag, then `after`. The window starts when this process first saw it.
 */
export function notYet(
  key: string,
  message: string,
  after: Fault = { kind: "defect", detail: message },
  now = Date.now(),
): Error {
  const since = firstSeen.get(key) ?? now;
  firstSeen.set(key, since);
  return attachFault(
    new Error(message),
    now - since < GITHUB_LAG_MS ? transient(message, false) : after,
  );
}

/** The postcondition held: a later failure starts a new window. */
export function settled(key: string): void {
  firstSeen.delete(key);
}
