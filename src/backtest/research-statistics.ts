// Descriptive session-block uncertainty, never a probability that a trade wins.
export interface SessionUncertainty {
  readonly sessions: number;
  readonly meanNetPerSession: number;
  readonly lowerBoundNetPerSession: number;
  readonly upperBoundNetPerSession: number;
  readonly tailProbability: number;
  readonly blockSessions: number;
  readonly replicates: number;
  readonly method: "circular-session-block-bootstrap-descriptive";
}

export function sessionUncertainty(values: readonly number[], seed = 20260917): SessionUncertainty {
  if (values.length < 15 || values.some(v => !Number.isFinite(v)) || !Number.isSafeInteger(seed)) throw new Error("Need at least fifteen finite session values for multiple five-session blocks, and an integer seed");
  const replicates = 10_000;
  const blockSessions = 5;
  const tailProbability = 0.0125; // Frozen 0.05 / four candidate families, one-sided lower bound.
  let state = seed >>> 0;
  const random = (): number => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const means: number[] = [];
  for (let r = 0; r < replicates; r++) {
    let count = 0;
    let total = 0;
    while (count < values.length) {
      const start = Math.floor(random() * values.length);
      for (let j = 0; j < blockSessions && count < values.length; j++, count++) total += values[(start + j) % values.length];
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return { sessions: values.length, meanNetPerSession: values.reduce((a, b) => a + b, 0) / values.length,
    lowerBoundNetPerSession: means[Math.floor(replicates * tailProbability)],
    upperBoundNetPerSession: means[Math.min(replicates - 1, Math.floor(replicates * (1 - tailProbability)))],
    tailProbability, blockSessions, replicates, method: "circular-session-block-bootstrap-descriptive" };
}
