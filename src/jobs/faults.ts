/** The `factory-paused` reason once GitHub refuses a call in a way waiting won't fix: a missing permission, a repo it can't see. */
export const GITHUB_REFUSED = "github-refused";

/**
 * Factory faults a start lifts: whatever hit one checks again before anything is spent (a check
 * secret before its commands run, the sign-in before the model's first turn, the Merge gate's
 * GitHub calls), and pauses again if it's still wrong.
 */
export const RECHECKED_ON_START = ["check-secret-missing", "sign-in-mismatch", GITHUB_REFUSED] as const;

/** What to do about a pause a start lifts. */
export const RESTART_TO_LIFT = "Once it's fixed, restart the Factory.";

export const liftedOnStart = (reason: unknown): boolean => (RECHECKED_ON_START as readonly unknown[]).includes(reason);
