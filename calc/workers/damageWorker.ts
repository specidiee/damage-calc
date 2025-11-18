// @ts-nocheck
import { Dex } from "@pkmn/dex";
import {
  aggregateKoChance,
  aggregateSurvival,
  applyObservationLikelihoods,
  buildEVGrid,
  buildHeatmap,
  buildOffenseEVGrid,
  computeSensitivity,
  normalizeWeights,
  rankOffensePlans,
  rankTopPlans,
  type EVGridPoint,
} from "../ev-grid";
import { DamageCache } from "../cache";
import {
  simulateTimeline,
  type TimelineExecutionOptions,
  type TimelineExecutionResult,
} from "../timeline";
import { calculateStatFromEV } from "../engine";
import type {
  BattleSide,
  DistributionPoint,
  FieldState,
  SimulationOptions,
  SimulationComplete,
  SimulationInput,
  SimulationProgress,
  SimulationSummary,
  TimelineScenario,
  TimelineSnapshot,
  WorkerRequestMessage,
  WorkerResponseMessage,
} from "../types";
import type { PokemonState } from "../types";

const dex = Dex.forGen(9);

interface ActiveJob {
  requestId: string;
  cancelled: boolean;
}

let activeJob: ActiveJob | null = null;

self.onmessage = (event: MessageEvent<WorkerRequestMessage>) => {
  const message = event.data;
  if (message.type === "run") {
    console.log("[damageWorker] Received run request:", {
      requestId: message.payload.requestId,
      hasScenario: !!message.payload.scenario,
      hasPokemon: !!message.payload.pokemon,
      hasField: !!message.payload.field,
      hasEvConfig: !!message.payload.evConfig,
      scenarioTurns: message.payload.scenario?.turns?.length ?? 0,
      playerSpecies: message.payload.pokemon?.player?.species,
      opponentSpecies: message.payload.pokemon?.opponent?.species,
    });
    runSimulation(message.payload).catch((error) => {
      console.error("[damageWorker] Simulation error:", error);
      const payload: WorkerResponseMessage = {
        type: "error",
        payload: {
          requestId: message.payload.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      self.postMessage(payload);
    });
  } else if (message.type === "cancel") {
    if (activeJob && activeJob.requestId === message.payload.requestId) {
      activeJob.cancelled = true;
    }
  }
};

async function runSimulation(input: SimulationInput) {
  activeJob = { requestId: input.requestId, cancelled: false };
  const start = performance.now();

  try {
    console.log("[damageWorker] Starting simulation:", {
      requestId: input.requestId,
      hasEvConfig: !!input.evConfig,
      hasEvGridConfig: !!input.evGridConfig,
      evConfigEnabled: input.evConfig?.enabled,
      playerSpecies: input.pokemon.player.species,
      opponentSpecies: input.pokemon.opponent.species,
      scenarioTurns: input.scenario.turns.length,
    });
    
    const evConfig = input.evConfig ?? input.evGridConfig;
    if (!evConfig) {
      throw new Error("EV grid config is required");
    }
    
    console.log("[damageWorker] EV config:", {
      enabled: evConfig.enabled,
      hpRange: evConfig.hpRange,
      defRange: evConfig.defRange,
      axisStep: evConfig.axisStep,
    });
    
    // 즉시 초기 progress 메시지 전송 (타임아웃 방지)
    postProgress({
      requestId: input.requestId,
      processed: 0,
      total: 0,
      elapsedMs: 0,
      phase: "initializing",
    });
    
    const targetSide = evConfig?.targetSide ?? "player";
    const cache = new DamageCache();

    const basePokemon = {
      player: clonePokemonState(input.pokemon.player),
      opponent: clonePokemonState(input.pokemon.opponent),
    };

    const playerSpecies = dex.species.get(input.pokemon.player.species);
    if (!playerSpecies) {
      throw new Error(`Unknown species: ${input.pokemon.player.species}`);
    }
    const opponentSpecies = dex.species.get(input.pokemon.opponent.species);
    if (!opponentSpecies) {
      throw new Error(`Unknown species: ${input.pokemon.opponent.species}`);
    }
    const targetSpecies = targetSide === "player" ? playerSpecies : opponentSpecies;

    const batchSize = Math.max(1, input.options?.batchSize ?? 100);
    const timeoutAt = start + (input.options?.timeoutMs ?? 30000);
    const execution: TimelineExecutionOptions = {
      observationEventId: evConfig?.observationEventId,
      observationRange: normalizeObservation(evConfig?.observationPercent),
      allowRaidStellar: input.scenario.allowRaidStellar,
    };

    const needDefenseGrid = Boolean(
      evConfig.enabled && (!evConfig.enableKO || evConfig.enableSurvival),
    );
    const needOffenseGrid = Boolean(evConfig.enabled && evConfig.enableKO);

    const needDamageRangeHeatmap = Boolean(
      evConfig.enabled &&
      evConfig.targetSide === "opponent" &&
      evConfig.enableOpponentBulkRange &&
      evConfig.opponentDamageRange,
    );

    if (!evConfig.enabled && !needOffenseGrid) {
      const deterministicResult = simulateTimeline(
        input.scenario,
        basePokemon,
        input.field,
        cache,
        input.options ?? {},
        execution,
      );
      const summary = buildDeterministicSummary(deterministicResult);
      const complete: SimulationComplete = {
        requestId: input.requestId,
        summary,
      };
      self.postMessage({
        type: "complete",
        payload: complete,
      } satisfies WorkerResponseMessage);
      return;
    }

    let defenseEvaluation: GridEvaluation | undefined;
    let defenseConfigForEval: SimulationInput["evConfig"] | undefined = evConfig;

    if (needDefenseGrid) {
      defenseConfigForEval = adjustOpponentBulkConfig(
        evConfig,
        basePokemon[targetSide],
        needDamageRangeHeatmap,
      );
      const defensePoints = evConfig.enabled
        ? buildEVGrid(defenseConfigForEval)
        : buildDeterministicDefensePoints(basePokemon[targetSide]);
      const result = await evaluateGridPoints({
        gridPoints: defensePoints,
        optimizeOffense: false,
        basePokemon,
        targetSide,
        targetSpecies,
        scenario: input.scenario,
        field: input.field,
        cache,
        options: input.options ?? {},
        execution,
        evConfig: defenseConfigForEval,
        requestId: input.requestId,
        batchSize,
        start,
        timeoutAt,
      });
      if (!result) return;
      defenseEvaluation = result;
    }

    let offenseEvaluation: GridEvaluation | undefined;
    if (needOffenseGrid) {
      const offensePoints = buildOffenseEVGrid(evConfig);
      const result = await evaluateGridPoints({
        gridPoints: offensePoints,
        optimizeOffense: true,
        basePokemon,
        targetSide,
        targetSpecies,
        scenario: input.scenario,
        field: input.field,
        cache,
        options: input.options ?? {},
        execution,
        evConfig,
        requestId: input.requestId,
        batchSize,
        start,
        timeoutAt,
      });
      if (!result) return;
      offenseEvaluation = result;
    }

    let summary: SimulationSummary | undefined;
    if (defenseEvaluation) {
      summary = buildSummary(
        defenseEvaluation.points,
        defenseEvaluation.pointResults,
        basePokemon[targetSide],
        defenseConfigForEval!,
        needDamageRangeHeatmap,
      );
      if (offenseEvaluation) {
        summary.koChance = aggregateKoChance(offenseEvaluation.points);
        summary.koPlans = rankOffensePlans(offenseEvaluation.points, evConfig?.targetKO);
      }
    } else if (offenseEvaluation) {
      summary = buildSummary(
        offenseEvaluation.points,
        offenseEvaluation.pointResults,
        basePokemon[targetSide],
        evConfig!,
        needDamageRangeHeatmap,
      );
      summary.koChance = aggregateKoChance(offenseEvaluation.points);
      summary.koPlans = rankOffensePlans(offenseEvaluation.points, evConfig?.targetKO);
    }

    if (!summary) {
      throw new Error("Failed to build simulation summary");
    }

    const complete: SimulationComplete = {
      requestId: input.requestId,
      summary,
    };

    self.postMessage({
      type: "complete",
      payload: complete,
    } satisfies WorkerResponseMessage);
  } catch (error) {
    console.error("[damageWorker] Simulation failed:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stackTrace = error instanceof Error ? error.stack : undefined;
    console.error("[damageWorker] Error stack:", stackTrace);
    
    const payload: WorkerResponseMessage = {
      type: "error",
      payload: {
        requestId: input.requestId,
        error: errorMessage,
      },
    };
    self.postMessage(payload);
  } finally {
    if (activeJob && activeJob.requestId === input.requestId) {
      activeJob = null;
    }
  }
}

function applyEVPoint(
  base: PokemonState,
  point: EVGridPoint,
  baseStats: Record<string, number>,
  mode: "defense" | "offense",
): PokemonState {
  const pokemon = clonePokemonState(base);
  if (mode === "offense") {
    if (typeof point.atkEV === "number") {
      pokemon.evs.atk = point.atkEV;
    }
    if (typeof point.spaEV === "number") {
      pokemon.evs.spa = point.spaEV;
    }
    return pokemon;
  }

  pokemon.evs.hp = point.hpEV;
  pokemon.evs.def = point.defEV;

  const hp = calculateStatFromEV(
    "hp",
    baseStats.hp,
    pokemon.ivs.hp,
    point.hpEV,
    pokemon.level,
    pokemon.nature,
  );

  pokemon.maxHP = hp;
  pokemon.currentHP = hp;
  return pokemon;
}

async function evaluateGridPoints(params: EvaluateGridParams): Promise<GridEvaluation | null> {
  const {
    gridPoints,
    optimizeOffense,
    basePokemon,
    targetSide,
    targetSpecies,
    scenario,
    field,
    cache,
    options,
    execution,
    evConfig,
    requestId,
    batchSize,
    start,
    timeoutAt,
  } = params;

  if (!evConfig?.enabled && !optimizeOffense) {
    const result = simulateTimeline(scenario, basePokemon, field, cache, options, execution);
    if (!gridPoints.length) {
      gridPoints.push({
        hpEV: basePokemon[targetSide].evs.hp,
        defEV: basePokemon[targetSide].evs.def,
        priorWeight: 1,
        weight: 1,
        kind: "defense",
        survival: result.survival,
        damageRangeLikelihood: computeDamageRangeLikelihood(result, evConfig, targetSide),
      });
    } else {
      gridPoints[0].survival = result.survival;
      gridPoints[0].damageRangeLikelihood = computeDamageRangeLikelihood(
        result,
        evConfig,
        targetSide,
      );
    }
    return {
      points: gridPoints,
      pointResults: [
        {
          hpDistribution: result.hpDistribution,
          snapshots: result.snapshots,
        },
      ],
    };
  }

  const total = gridPoints.length;
  const pointResults: TimelineResultSnapshot[] = new Array(total);
  const observationLikelihoods = optimizeOffense ? undefined : new Array(total).fill(0);
  const needDamageRangeMetric = Boolean(
    evConfig?.targetSide === "opponent" &&
      evConfig?.enableOpponentBulkRange &&
      evConfig?.opponentDamageRange,
  );

  postProgress({
    requestId,
    processed: 0,
    total,
    elapsedMs: performance.now() - start,
    phase: "processing",
  });

  for (let index = 0; index < total; index += 1) {
    if (!activeJob || activeJob.requestId !== requestId) {
      return null;
    }
    if (activeJob.cancelled) {
      notifyCancelled(requestId);
      return null;
    }

    const point = gridPoints[index];
    const evMode: "defense" | "offense" = optimizeOffense ? "offense" : "defense";
    const pokemon = {
      player:
        targetSide === "player"
          ? applyEVPoint(basePokemon.player, point, targetSpecies.baseStats, evMode)
          : clonePokemonState(basePokemon.player),
      opponent:
        targetSide === "opponent"
          ? applyEVPoint(basePokemon.opponent, point, targetSpecies.baseStats, evMode)
          : clonePokemonState(basePokemon.opponent),
    };

    const result = simulateTimeline(scenario, pokemon, field, cache, options, execution);

    point.survival = result.survival;
    if (optimizeOffense) {
      point.koChance = 1 - (result.opponentSurvival ?? 0);
    }
    if (needDamageRangeMetric) {
      point.damageRangeLikelihood = computeDamageRangeLikelihood(
        result,
        evConfig,
        targetSide,
      );
    }
    pointResults[index] = {
      hpDistribution: result.hpDistribution,
      snapshots: result.snapshots,
    };
    if (!optimizeOffense && observationLikelihoods) {
      observationLikelihoods[index] = result.observationLikelihood;
    }

    const processed = index + 1;
    if (processed % batchSize === 0 || processed === total) {
      const elapsed = performance.now() - start;
      postProgress({
        requestId,
        processed,
        total,
        elapsedMs: elapsed,
        phase: processed === total ? "finalizing" : "evaluating",
      });
      await tick();
    }

    if (performance.now() > timeoutAt) {
      notifyTimeout(requestId, index + 1, total, start);
      return null;
    }
  }

  if (!optimizeOffense && observationLikelihoods) {
    applyObservationLikelihoods(gridPoints, evConfig?.enabled ? observationLikelihoods : undefined);
  }

  return {
    points: gridPoints,
    pointResults,
  };
}

interface TimelineResultSnapshot {
  hpDistribution: DistributionPoint[];
  snapshots: TimelineSnapshot[];
}

interface GridEvaluation {
  points: EVGridPoint[];
  pointResults: TimelineResultSnapshot[];
}

interface EvaluateGridParams {
  gridPoints: EVGridPoint[];
  optimizeOffense: boolean;
  basePokemon: Record<BattleSide, PokemonState>;
  targetSide: BattleSide;
  targetSpecies: ReturnType<typeof dex.species.get>;
  scenario: TimelineScenario;
  field: FieldState;
  cache: DamageCache;
  options: SimulationOptions;
  execution: TimelineExecutionOptions;
  evConfig: SimulationInput["evConfig"];
  requestId: string;
  batchSize: number;
  start: number;
  timeoutAt: number;
}

function buildSummary(
  points: EVGridPoint[],
  results: TimelineResultSnapshot[],
  basePokemon: PokemonState,
  evConfig: SimulationInput["evConfig"],
  useDamageRangeHeatmap: boolean,
): SimulationSummary {
  const gridEnabled = Boolean(evConfig?.enabled);
  const optimizeOffense = Boolean(evConfig?.enableKO && !evConfig?.enableSurvival);
  const overallSurvival = aggregateSurvival(points);
  const showDefenseInsights = gridEnabled && !optimizeOffense;
  const heatmapMode: "survival" | "damageRange" =
    useDamageRangeHeatmap && showDefenseInsights ? "damageRange" : "survival";
  const heatmap = showDefenseInsights ? buildHeatmap(points, heatmapMode) : undefined;

  const hpDistribution = combineDistributions(points, results);
  const snapshots = combineSnapshots(points, results);

  const shouldIncludeTopPlans = Boolean(
    gridEnabled && evConfig?.enableSurvival && !optimizeOffense,
  );
  const topPlans = shouldIncludeTopPlans ? rankTopPlans(points, evConfig?.targetSurvival) : [];
  const koChance = optimizeOffense ? aggregateKoChance(points) : undefined;
  const koPlans = optimizeOffense ? rankOffensePlans(points, evConfig?.targetKO) : undefined;
  const sensitivity = showDefenseInsights
    ? computeSensitivity(
        points,
        { hp: basePokemon.evs.hp, def: basePokemon.evs.def },
        evConfig?.axisStep ?? 8,
      )
    : undefined;

  return {
    survival: overallSurvival,
    hpDistribution,
    heatmap,
    topPlans,
    koChance,
    koPlans,
    sensitivity,
    snapshots,
  };
}

function computeDamageRangeLikelihood(
  result: TimelineExecutionResult,
  evConfig: SimulationInput["evConfig"] | undefined,
  targetSide: BattleSide,
): number | undefined {
  if (
    targetSide !== "opponent" ||
    !evConfig?.enableOpponentBulkRange ||
    !evConfig.opponentDamageRange
  ) {
    return undefined;
  }

  const snapshots = result.snapshots.filter(
    (snapshot) => snapshot.damageRolls && snapshot.damageRolls.length > 0,
  );
  if (snapshots.length === 0) {
    return undefined;
  }

  let targetSnapshot =
    (evConfig.observationEventId
      ? snapshots.find((snapshot) => snapshot.eventId === evConfig.observationEventId)
      : undefined) ??
    snapshots.find((snapshot) => extractActor(snapshot.description) === "player") ??
    snapshots[0];

  const actor = extractActor(targetSnapshot.description);
  const defender: BattleSide | undefined =
    actor === "player" ? "opponent" : actor === "opponent" ? "player" : undefined;
  if (!defender) {
    return undefined;
  }

  const maxHP = targetSnapshot.maxHP[defender];
  const rolls = targetSnapshot.damageRolls ?? [];
  if (!maxHP || !rolls.length) {
    return undefined;
  }

  const [minPercent, maxPercent] = evConfig.opponentDamageRange;
  const minRatio = minPercent / 100;
  const maxRatio = maxPercent / 100;
  const matches = rolls.filter((roll) => {
    const percent = roll / maxHP;
    return percent >= minRatio && percent <= maxRatio;
  }).length;
  return matches / rolls.length;
}

function extractActor(description: string | undefined): BattleSide | undefined {
  if (!description) {
    return undefined;
  }
  if (description.startsWith("플레이어")) {
    return "player";
  }
  if (description.startsWith("상대")) {
    return "opponent";
  }
  return undefined;
}

function buildDeterministicSummary(result: TimelineExecutionResult): SimulationSummary {
  return {
    survival: result.survival,
    hpDistribution: result.hpDistribution,
    snapshots: result.snapshots,
  };
}

function adjustOpponentBulkConfig(
  evConfig: SimulationInput["evConfig"],
  basePokemon: PokemonState,
  useDamageRangeHeatmap: boolean,
): SimulationInput["evConfig"] {
  if (
    !useDamageRangeHeatmap ||
    evConfig?.targetSide !== "opponent" ||
    !evConfig.enableOpponentBulkRange
  ) {
    return evConfig;
  }
  const step = Math.max(evConfig.axisStep ?? 4, 8);
  const span = Math.max(step * 6, 48);
  if (step <= evConfig.axisStep && evConfig.hpRange.length === 2 && evConfig.defRange.length === 2) {
    return evConfig;
  }

  const baseHpEV = basePokemon.evs.hp ?? 0;
  const baseDefEV = basePokemon.evs.def ?? 0;

  const clampAround = (
    [min, max]: [number, number],
    center: number,
  ): [number, number] => {
    const half = Math.max(span, step * 3);
    const nextMin = Math.max(min, center - half);
    const nextMax = Math.min(max, center + half);
    const width = nextMax - nextMin;
    if (width < step * 3) {
      return [min, max];
    }
    return [nextMin, nextMax];
  };

  const [nextHpMin, nextHpMax] = clampAround(evConfig.hpRange, baseHpEV);
  const [nextDefMin, nextDefMax] = clampAround(evConfig.defRange, baseDefEV);
  const nextCombined = Math.min(evConfig.maxCombinedEV ?? 252, 252);

  return {
    ...evConfig,
    axisStep: step,
    hpRange: [nextHpMin, nextHpMax],
    defRange: [nextDefMin, nextDefMax],
    maxCombinedEV: nextCombined,
  };
}

function combineDistributions(
  points: EVGridPoint[],
  results: TimelineResultSnapshot[],
): DistributionPoint[] {
  const map = new Map<number, number>();
  points.forEach((point, index) => {
    const weight = point.weight;
    const distribution = results[index]?.hpDistribution ?? [];
    distribution.forEach((entry) => {
      const current = map.get(entry.hp) ?? 0;
      map.set(entry.hp, current + entry.probability * weight);
    });
  });
  return Array.from(map.entries())
    .map(([hp, probability]) => ({ hp, probability }))
    .sort((a, b) => a.hp - b.hp);
}

function combineSnapshots(
  points: EVGridPoint[],
  results: TimelineResultSnapshot[],
): TimelineSnapshot[] {
  const aggregated = new Map<string, {
    description: string;
    playerDistribution: Map<number, number>;
    opponentDistribution: Map<number, number>;
    playerMaxHP: Map<number, number>;
    opponentMaxHP: Map<number, number>;
    turn: number;
    totalProbability: number;
    sequence: number;
    playerDeltaSum: number;
    opponentDeltaSum: number;
    playerMaxBeforeSum: number;
    opponentMaxBeforeSum: number;
  }>();

  points.forEach((point, index) => {
    const weight = point.weight;
    const snapshots = results[index]?.snapshots ?? [];
    snapshots.forEach((snapshot) => {
      if (!snapshot.eventId) return;
      const eventId = snapshot.eventId;
      let entry = aggregated.get(eventId);
      if (!entry) {
        entry = {
          description: snapshot.description ?? "",
          playerDistribution: new Map<number, number>(),
          opponentDistribution: new Map<number, number>(),
          playerMaxHP: new Map<number, number>(),
          opponentMaxHP: new Map<number, number>(),
          turn: snapshot.turn ?? 0,
          totalProbability: 0,
          sequence: snapshot.sequence ?? Number.MAX_SAFE_INTEGER,
          playerDeltaSum: 0,
          opponentDeltaSum: 0,
          playerMaxBeforeSum: 0,
          opponentMaxBeforeSum: 0,
        };
        aggregated.set(eventId, entry);
      }

      if (snapshot.sequence !== undefined) {
        entry.sequence = Math.min(entry.sequence, snapshot.sequence);
      }

      const snapshotContribution = (snapshot.probability ?? 1) * weight;
      entry.totalProbability += snapshotContribution;

      accumulateDistribution(
        entry.playerDistribution,
        snapshot.hpDistribution,
        snapshotContribution,
        () => Math.max(0, Math.round(snapshot.hp.player)),
      );
      accumulateDistribution(
        entry.opponentDistribution,
        snapshot.opponentHpDistribution,
        snapshotContribution,
        () => Math.max(0, Math.round(snapshot.hp.opponent)),
      );

      accumulateMaxHP(entry.playerMaxHP, snapshot.maxHP.player, snapshotContribution);
      accumulateMaxHP(entry.opponentMaxHP, snapshot.maxHP.opponent, snapshotContribution);

      if (snapshot.deltaHP) {
        entry.playerDeltaSum += (snapshot.deltaHP.player ?? 0) * snapshotContribution;
        entry.opponentDeltaSum += (snapshot.deltaHP.opponent ?? 0) * snapshotContribution;
      }
      if (snapshot.maxHPBefore) {
        entry.playerMaxBeforeSum += (snapshot.maxHPBefore.player ?? 0) * snapshotContribution;
        entry.opponentMaxBeforeSum += (snapshot.maxHPBefore.opponent ?? 0) * snapshotContribution;
      }
    });
  });

  return Array.from(aggregated.entries())
    .map(([eventId, data]) => {
      const totalProbability = data.totalProbability || 1;
      const playerDistribution = normalizeDistributionMap(data.playerDistribution, totalProbability);
      const opponentDistribution = normalizeDistributionMap(
        data.opponentDistribution,
        totalProbability,
      );
      const playerAvgHP = weightedAverage(playerDistribution);
      const opponentAvgHP = weightedAverage(opponentDistribution);
      const playerAvgMaxHP = averageFromMaxMap(data.playerMaxHP, totalProbability);
      const opponentAvgMaxHP = averageFromMaxMap(data.opponentMaxHP, totalProbability);
      const deltaHP =
        data.playerDeltaSum !== 0 || data.opponentDeltaSum !== 0
          ? {
              player: data.playerDeltaSum / totalProbability,
              opponent: data.opponentDeltaSum / totalProbability,
            }
          : undefined;
      const maxHPBefore =
        data.playerMaxBeforeSum !== 0 || data.opponentMaxBeforeSum !== 0
          ? {
              player: data.playerMaxBeforeSum / totalProbability,
              opponent: data.opponentMaxBeforeSum / totalProbability,
            }
          : undefined;

      return {
        turn: data.turn,
        eventId,
        sequence: data.sequence,
        hp: {
          player: Math.round(playerAvgHP),
          opponent: Math.round(opponentAvgHP),
        },
        maxHP: {
          player: Math.round(playerAvgMaxHP),
          opponent: Math.round(opponentAvgMaxHP),
        },
        probability: data.totalProbability,
        description: data.description,
        hpDistribution: playerDistribution,
        opponentHpDistribution: opponentDistribution,
        damageRolls: points
          .map((point, index) => results[index]?.snapshots ?? [])
          .flat()
          .find((snapshot) => snapshot.eventId === eventId)?.damageRolls,
        deltaHP,
        maxHPBefore,
      };
    })
    .sort((a, b) => {
      const seqA = a.sequence ?? 0;
      const seqB = b.sequence ?? 0;
      if (seqA !== seqB) {
        return seqA - seqB;
      }
      return a.turn - b.turn;
    });
}

function accumulateDistribution(
  bucket: Map<number, number>,
  distribution: DistributionPoint[] | undefined,
  contribution: number,
  fallback: () => number,
) {
  if (distribution && distribution.length > 0) {
    distribution.forEach((dp) => {
      const current = bucket.get(dp.hp) ?? 0;
      bucket.set(dp.hp, current + dp.probability * contribution);
    });
    return;
  }
  const hp = fallback();
  bucket.set(hp, (bucket.get(hp) ?? 0) + contribution);
}

function accumulateMaxHP(bucket: Map<number, number>, value: number, contribution: number) {
  bucket.set(value, (bucket.get(value) ?? 0) + contribution);
}

function normalizeDistributionMap(
  bucket: Map<number, number>,
  total: number,
): DistributionPoint[] {
  if (bucket.size === 0 || total <= 0) {
    return [];
  }
  return Array.from(bucket.entries())
    .map(([hp, probability]) => ({ hp, probability: probability / total }))
    .sort((a, b) => a.hp - b.hp);
}

function averageFromMaxMap(map: Map<number, number>, total: number): number {
  if (map.size === 0 || total <= 0) {
    return 0;
  }
  return Array.from(map.entries()).reduce((acc, [value, prob]) => acc + value * (prob / total), 0);
}

function weightedAverage(distribution: DistributionPoint[]): number {
  if (!distribution.length) {
    return 0;
  }
  return distribution.reduce((acc, entry) => acc + entry.hp * entry.probability, 0);
}

function buildDeterministicDefensePoints(pokemon: PokemonState): EVGridPoint[] {
  const point: EVGridPoint = {
    hpEV: pokemon.evs.hp,
    defEV: pokemon.evs.def,
    kind: "defense",
    priorWeight: 1,
    weight: 1,
  };
  const points = [point];
  normalizeWeights(points);
  return points;
}

function clonePokemonState(pokemon: PokemonState): PokemonState {
  return {
    ...pokemon,
    ivs: { ...pokemon.ivs },
    evs: { ...pokemon.evs },
    boosts: { ...pokemon.boosts },
    overrides: pokemon.overrides
      ? {
          baseStats: pokemon.overrides.baseStats
            ? { ...pokemon.overrides.baseStats }
            : undefined,
        }
      : undefined,
  };
}

function normalizeObservation(
  percent: [number, number] | undefined,
): [number, number] | undefined {
  if (!percent) {
    return undefined;
  }
  return [
    Math.max(0, percent[0] / 100),
    Math.min(1, percent[1] / 100),
  ];
}

function postProgress(progress: SimulationProgress) {
  self.postMessage({
    type: "progress",
    payload: { requestId: progress.requestId ?? "", progress },
  });
}

function notifyTimeout(
  requestId: string,
  processed: number,
  total: number,
  start: number,
) {
  const payload: WorkerResponseMessage = {
    type: "error",
    payload: {
      requestId,
      error: `Simulation timeout after ${Math.round((performance.now() - start) / 1000)}s (processed ${processed}/${total} points)`,
    },
  };
  self.postMessage(payload);
}

function notifyCancelled(requestId: string) {
  const payload: WorkerResponseMessage = {
    type: "cancelled",
    payload: {
      requestId,
    },
  };
  self.postMessage(payload);
}

function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export {};
