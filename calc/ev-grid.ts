import type {
  EVGridConfig,
  EVHeatmapCell,
  EVOffensePlan,
  EVPlan,
  SensitivityMetrics,
  StatsTable,
} from "./types";

export interface EVGridPoint {
  hpEV: number;
  defEV: number;
  atkEV?: number;
  spaEV?: number;
  kind?: "defense" | "offense";
  priorWeight: number;
  weight: number;
  survival?: number;
  koChance?: number;
  observationLikelihood?: number;
  damageRangeLikelihood?: number;
}

interface MetaProfile {
  hpMean: number;
  defMean: number;
  hpSigma: number;
  defSigma: number;
  correlation?: number;
}

const META_PROFILES: Record<string, MetaProfile> = {
  bulky: {
    hpMean: 244,
    defMean: 108,
    hpSigma: 42,
    defSigma: 36,
    correlation: 0.35,
  },
  balanced: {
    hpMean: 196,
    defMean: 92,
    hpSigma: 48,
    defSigma: 40,
    correlation: 0.2,
  },
  agile: {
    hpMean: 164,
    defMean: 68,
    hpSigma: 50,
    defSigma: 34,
    correlation: 0.1,
  },
};

export function buildEVGrid(config: EVGridConfig): EVGridPoint[] {
  const points: EVGridPoint[] = [];
  const [hpMin, hpMax] = config.hpRange;
  const [defMin, defMax] = config.defRange;
  const step = Math.max(4, config.axisStep);

  for (let hpEV = hpMin; hpEV <= hpMax; hpEV += step) {
    for (let defEV = defMin; defEV <= defMax; defEV += step) {
      if (config.maxCombinedEV !== undefined && hpEV + defEV > config.maxCombinedEV) {
        continue;
      }
      const prior = computePriorWeight(config, hpEV, defEV);
      points.push({
        hpEV,
        defEV,
        kind: "defense",
        priorWeight: prior,
        weight: prior,
      });
    }
  }

  normalizeWeights(points);
  return points;
}

export function computePriorWeight(
  config: EVGridConfig,
  hpEV: number,
  defEV: number,
): number {
  const prior = config.prior;
  const type = typeof prior === "string" ? prior : prior.type;
  if (type === "uniform") {
    return 1;
  }

  if (type === "custom") {
    const customWeights = typeof prior === "string" ? undefined : prior.customWeights;
    if (customWeights?.length) {
      const match = customWeights.find(
        (entry) => entry.hpEV === hpEV && entry.defEV === defEV,
      );
      return match ? Math.max(match.weight, 0) : 1e-6;
    }
  }

  const metaProfileKey =
    typeof prior === "string" ? prior : prior.metaProfile ?? "balanced";
  const profile = META_PROFILES[metaProfileKey] ?? META_PROFILES.balanced;
  return computeBivariateGaussian(hpEV, defEV, profile);
}

export function buildOffenseEVGrid(config: EVGridConfig): EVGridPoint[] {
  const points: EVGridPoint[] = [];
  const atkRange = config.atkRange ?? [0, 252];
  const spaRange = config.spaRange ?? [0, 252];
  const step = Math.max(4, config.offenseStep ?? config.axisStep);
  const limit = config.offenseMaxCombinedEV ?? config.maxCombinedEV;

  for (let atkEV = atkRange[0]; atkEV <= atkRange[1]; atkEV += step) {
    for (let spaEV = spaRange[0]; spaEV <= spaRange[1]; spaEV += step) {
      if (limit !== undefined && atkEV + spaEV > limit) {
        continue;
      }
      points.push({
        hpEV: 0,
        defEV: 0,
        atkEV,
        spaEV,
        kind: "offense",
        priorWeight: 1,
        weight: 1,
      });
    }
  }

  normalizeWeights(points);
  return points;
}

function computeBivariateGaussian(
  hpEV: number,
  defEV: number,
  profile: MetaProfile,
): number {
  const x = (hpEV - profile.hpMean) / profile.hpSigma;
  const y = (defEV - profile.defMean) / profile.defSigma;
  const rho = profile.correlation ?? 0;
  const exponent =
    -1 / (2 * (1 - rho * rho)) * (x * x - 2 * rho * x * y + y * y);
  return Math.exp(exponent);
}

export function applyObservationLikelihoods(
  points: EVGridPoint[],
  likelihoods: number[] | undefined,
) {
  if (!likelihoods) {
    normalizeWeights(points);
    return;
  }
  points.forEach((point, index) => {
    const likelihood = Math.max(likelihoods[index] ?? 0, 0);
    point.observationLikelihood = likelihood;
    point.weight = point.priorWeight * likelihood;
  });
  normalizeWeights(points);
}

export function normalizeWeights(points: EVGridPoint[]) {
  const sum = points.reduce((acc, point) => acc + point.weight, 0);
  if (sum <= 0) {
    const uniform = 1 / Math.max(points.length, 1);
    points.forEach((point) => {
      point.weight = uniform;
    });
    return;
  }
  points.forEach((point) => {
    point.weight = point.weight / sum;
  });
}

export function buildHeatmap(
  points: EVGridPoint[],
  mode: "survival" | "damageRange" = "survival",
): EVHeatmapCell[] {
  return points.map((point) => ({
    hpEV: point.hpEV,
    defEV: point.defEV,
    survival:
      mode === "damageRange"
        ? point.damageRangeLikelihood ?? 0
        : point.survival ?? 0,
    weight: point.weight,
    metric: mode,
  }));
}

export function rankTopPlans(
  points: EVGridPoint[],
  target: number | undefined,
): EVPlan[] {
  if (!target || target <= 0) {
    return points
      .slice()
      .sort((a, b) => (b.survival ?? 0) - (a.survival ?? 0))
      .slice(0, 3)
      .map(toPlan);
  }
  const candidates = points.filter(
    (point) => (point.survival ?? 0) >= target - 1e-4,
  );
  candidates.sort((a, b) => {
    const totalA = a.hpEV + a.defEV;
    const totalB = b.hpEV + b.defEV;
    if (totalA !== totalB) {
      return totalA - totalB;
    }
    return (b.survival ?? 0) - (a.survival ?? 0);
  });
  if (!candidates.length) {
    return [];
  }
  const MIN_EV_EPS = 1e-6;
  const minTotal = candidates[0].hpEV + candidates[0].defEV;
  const minimalCandidates = candidates.filter(
    (point) => Math.abs(point.hpEV + point.defEV - minTotal) <= MIN_EV_EPS,
  );
  return minimalCandidates.map((point) => ({
    hpEV: point.hpEV,
    defEV: point.defEV,
    survival: point.survival ?? 0,
    investment: point.hpEV + point.defEV,
    totalEV: point.hpEV + point.defEV,
    meetsTarget: true,
  }));
}

function toPlan(point: EVGridPoint): EVPlan {
  return {
    hpEV: point.hpEV,
    defEV: point.defEV,
    survival: point.survival ?? 0,
    investment: point.hpEV + point.defEV,
    totalEV: point.hpEV + point.defEV,
    meetsTarget: false,
  };
}

export function computeSensitivity(
  points: EVGridPoint[],
  baseEVs: Pick<StatsTable<number>, "hp" | "def">,
  step: number,
): SensitivityMetrics {
  const nearest = findNearestPoint(points, baseEVs.hp, baseEVs.def);
  if (!nearest) {
    return { hpSensitivity: 0, defSensitivity: 0 };
  }

  const hpUp = findNearestPoint(points, nearest.hpEV + step, nearest.defEV);
  const defUp = findNearestPoint(points, nearest.hpEV, nearest.defEV + step);

  const baseSurvival = nearest.survival ?? 0;
  const hpSurvival = hpUp?.survival ?? baseSurvival;
  const defSurvival = defUp?.survival ?? baseSurvival;

  return {
    hpSensitivity: (hpSurvival - baseSurvival) / Math.max(step, 1),
    defSensitivity: (defSurvival - baseSurvival) / Math.max(step, 1),
  };
}

function findNearestPoint(
  points: EVGridPoint[],
  hpEV: number,
  defEV: number,
): EVGridPoint | undefined {
  let best: EVGridPoint | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const distance =
      Math.abs(point.hpEV - hpEV) + Math.abs(point.defEV - defEV);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function aggregateSurvival(points: EVGridPoint[]): number {
  return points.reduce((acc, point) => {
    const survival = point.survival ?? 0;
    return acc + point.weight * survival;
  }, 0);
}

export function aggregateKoChance(points: EVGridPoint[]): number {
  return points.reduce((acc, point) => {
    const koChance = point.koChance ?? 0;
    return acc + point.weight * koChance;
  }, 0);
}

export function rankOffensePlans(
  points: EVGridPoint[],
  target: number | undefined,
): EVOffensePlan[] {
  const offensePoints = points.filter((point) => point.kind === "offense");
  const sortable = offensePoints
    .filter((point) => typeof point.koChance === "number")
    .map((point) => ({
      atkEV: point.atkEV ?? 0,
      spaEV: point.spaEV ?? 0,
      koChance: point.koChance ?? 0,
      totalEV: (point.atkEV ?? 0) + (point.spaEV ?? 0),
    }));

  if (!sortable.length) {
    return [];
  }

  type OffenseEntry = (typeof sortable)[number];

  const meets = (entry: OffenseEntry) =>
    target && target > 0 ? entry.koChance >= target - 1e-4 : false;

  const baseSorted = sortable.sort((a, b) => {
    if (b.koChance !== a.koChance) {
      return b.koChance - a.koChance;
    }
    if (a.totalEV !== b.totalEV) {
      return a.totalEV - b.totalEV;
    }
    if (a.atkEV !== b.atkEV) {
      return a.atkEV - b.atkEV;
    }
    return a.spaEV - b.spaEV;
  });

  let pool = target && target > 0 ? baseSorted.filter(meets) : baseSorted;
  if (!pool.length) {
    pool = baseSorted;
  }

  const KO_EPS = 1e-4;
  const EV_EPS = 1e-6;
  const selected: OffenseEntry[] = [];
  let index = 0;
  while (index < pool.length && selected.length < 3) {
    const currentChance = pool[index].koChance;
    const chanceGroup: OffenseEntry[] = [];
    while (index < pool.length && Math.abs(pool[index].koChance - currentChance) <= KO_EPS) {
      chanceGroup.push(pool[index]);
      index += 1;
    }
    const minEV = Math.min(...chanceGroup.map((entry) => entry.totalEV));
    const minimal = chanceGroup.filter(
      (entry) => Math.abs(entry.totalEV - minEV) <= EV_EPS,
    );
    for (const entry of minimal) {
      selected.push(entry);
      if (selected.length >= 3) {
        break;
      }
    }
  }

  return selected.map((entry) => ({
    ...entry,
    meetsTarget: target && target > 0 ? entry.koChance >= target - 1e-4 : false,
  }));
}

