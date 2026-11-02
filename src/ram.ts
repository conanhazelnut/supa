// RAM gate for up / restart / switch. Pure. 1.8 GiB is one untrimmed stack.

export const ASSUMED_STACK_MIB = 1.8 * 1024;

export function estimateNewStackMiB(runningMiB: readonly number[]): {
  mib: number;
  assumed: boolean;
} {
  if (runningMiB.length === 0) return { mib: ASSUMED_STACK_MIB, assumed: true };
  const sum = runningMiB.reduce((a, b) => a + b, 0);
  return { mib: sum / runningMiB.length, assumed: false };
}

export interface RamDecision {
  ok: boolean;
  assumed: boolean;
  predictedMiB: number;
  budgetMiB: number;
}

/**
 * `extras` is how many stacks are not already running.
 * Zero extras (restart of a stack that is up) is always allowed.
 */
export function ramDecision(opts: {
  budgetGiB: number;
  currentMiB: number;
  runningMiB: readonly number[];
  extras: number;
}): RamDecision {
  const budgetMiB = opts.budgetGiB * 1024;
  if (opts.extras <= 0) {
    return { ok: true, assumed: false, predictedMiB: opts.currentMiB, budgetMiB };
  }
  const estimate = estimateNewStackMiB(opts.runningMiB);
  const predictedMiB = opts.currentMiB + opts.extras * estimate.mib;
  return {
    ok: predictedMiB <= budgetMiB,
    assumed: estimate.assumed,
    predictedMiB,
    budgetMiB,
  };
}
