import { Dex } from "@pkmn/dex";
import type { DamageCache, DamageCacheKey } from "./cache";
import { computeDamage } from "./engine";
import type {
  AttackEvent,
  BattleAction,
  BattleEvent,
  BattleSide,
  DistributionPoint,
  FieldState,
  FieldToggleEvent,
  HealingEvent,
  HpAdjustmentEvent,
  MoveAction,
  MoveConfig,
  SimulationOptions,
  StatChangeEvent,
  StatusEvent,
  SwitchAction,
  SwitchEvent,
  TimelineScenario,
  TimelineSnapshot,
  TimelineTurn,
  TurnTiming,
} from "./types";
import type { PokemonState, SideState, StatsTable } from "./types";
import { MAX_TIMELINE_TURNS } from "./types";

const BRANCH_KEY_DELIMITER = "|";
const dex = Dex.forGen(9);

interface BranchState {
  pokemon: Record<BattleSide, PokemonState>;
  hp: Record<BattleSide, number>;
  maxHP: Record<BattleSide, number>;
  teraMode: Record<BattleSide, string>;
  teraType: Record<BattleSide, string | undefined>;
  stellarUsage: Record<BattleSide, Set<string>>;
  lastDamage: Record<BattleSide, number>;
  field: FieldState;
  probability: number;
  terminated: boolean;
}

interface SimulationContext {
  pokemon: Record<BattleSide, PokemonState>;
  field: FieldState;
  cache: DamageCache;
  options: SimulationOptions;
  execution: TimelineExecutionOptions;
}

interface SnapshotBranchState {
  hp: Record<BattleSide, number>;
  maxHP: Record<BattleSide, number>;
  probability: number;
}

function captureSnapshotState(branches: BranchState[]): SnapshotBranchState[] {
  return branches.map((branch) => ({
    hp: { ...branch.hp },
    maxHP: { ...branch.maxHP },
    probability: branch.probability,
  }));
}

function resolveFractionValue(
  numerator?: number,
  denominator?: number,
  fallback?: number,
): number | undefined {
  if (typeof fallback === "number" && Number.isFinite(fallback)) {
    return fallback;
  }
  if (typeof denominator === "number" && denominator !== 0) {
    const num = typeof numerator === "number" && Number.isFinite(numerator) ? numerator : 1;
    return num / denominator;
  }
  return undefined;
}

export interface TimelineExecutionOptions {
  observationEventId?: string;
  observationRange?: [number, number];
  allowRaidStellar?: boolean;
}

export interface TimelineExecutionResult {
  survival: number;
  opponentSurvival: number;
  hpDistribution: DistributionPoint[];
  snapshots: TimelineSnapshot[];
  observationLikelihood: number;
}

interface EventResult {
  branches: BranchState[];
  observationContribution: number;
  damageRolls?: number[]; // 공격 이벤트의 경우 각 롤의 데미지 값
}

export function simulateTimeline(
  scenario: TimelineScenario,
  pokemon: Record<BattleSide, PokemonState>,
  field: FieldState,
  cache: DamageCache,
  options: SimulationOptions,
  execution: TimelineExecutionOptions = {},
): TimelineExecutionResult {
  const context: SimulationContext = {
    pokemon,
    field,
    cache,
    options,
    execution,
  };

  let branches: BranchState[] = [createInitialBranch(pokemon, field)];
  const snapshots: TimelineSnapshot[] = [];
  let observationLikelihood = 0;
  let snapshotSequence = 0;

  const limitedTurns = scenario.turns.slice(0, MAX_TIMELINE_TURNS);
  const nextSnapshotSequence = () => snapshotSequence++;

  for (const turn of limitedTurns) {
    const turnEvents = (turn.events ?? []).map(normalizeEvent);

    if (
      runEventSequence(
        turnEvents.filter(
          (event) => resolveTiming(event) === "turn-start" && !event.relatedActionId,
        ),
        context,
        execution,
        snapshots,
        () => branches,
        (updated) => {
          branches = updated;
        },
        (value) => {
          observationLikelihood = value;
        },
        nextSnapshotSequence,
      )
    ) {
      break;
    }

    const orderedActions = orderActions(turn, context);
    for (const action of orderedActions) {
      const beforeAction = captureSnapshotState(branches);
      const actionResult = processAction(action, branches, context);
      branches = mergeBranches(actionResult.branches);

      if (action.id === execution.observationEventId) {
        observationLikelihood = actionResult.observationContribution;
      }

      const actionSnapshot = buildSnapshotFromBranches({
        branches,
        prevBranches: beforeAction,
        turn: turn.turn,
        eventId: action.id,
        description: describeAction(action),
        damageRolls: actionResult.damageRolls,
        sequence: nextSnapshotSequence(),
      });
      if (actionSnapshot) {
        snapshots.push(actionSnapshot);
      }

      if (
        runEventSequence(
          turnEvents.filter(
            (event) =>
              resolveTiming(event) === "action" &&
              event.relatedActionId === action.id,
          ),
          context,
          execution,
          snapshots,
          () => branches,
          (updated) => {
            branches = updated;
          },
          (value) => {
            observationLikelihood = value;
          },
          nextSnapshotSequence,
        )
      ) {
        break;
      }

      if (allBranchesTerminated(branches)) {
        break;
      }
    }

    if (allBranchesTerminated(branches)) {
      break;
    }

    if (
      runEventSequence(
        turnEvents.filter(
          (event) =>
            resolveTiming(event) === "action" && !event.relatedActionId,
        ),
        context,
        execution,
        snapshots,
        () => branches,
        (updated) => {
          branches = updated;
        },
        (value) => {
          observationLikelihood = value;
        },
        nextSnapshotSequence,
      )
    ) {
      break;
    }

    // 턴 종료 이벤트 처리 전에 Leftovers 회복 적용
    branches = applyLeftoversRecovery(branches, context);

    if (
      runEventSequence(
        turnEvents.filter((event) => resolveTiming(event) === "turn-end"),
        context,
        execution,
        snapshots,
        () => branches,
        (updated) => {
          branches = updated;
        },
        (value) => {
          observationLikelihood = value;
        },
        nextSnapshotSequence,
      )
    ) {
      break;
    }

    if (allBranchesTerminated(branches)) {
      break;
    }
  }

  const survival = branches.reduce((acc, branch) => {
    const hp = branch.hp.player;
    return hp > 0 ? acc + branch.probability : acc;
  }, 0);
  const opponentSurvival = branches.reduce((acc, branch) => {
    const hp = branch.hp.opponent;
    return hp > 0 ? acc + branch.probability : acc;
  }, 0);

  return {
    survival,
    opponentSurvival,
    hpDistribution: toDistribution(branches, "player"),
    snapshots,
    observationLikelihood,
  };
}

function createInitialBranch(
  pokemon: Record<BattleSide, PokemonState>,
  field: FieldState,
): BranchState {
  const player = clonePokemonState(pokemon.player);
  const opponent = clonePokemonState(pokemon.opponent);
  const playerMax = player.maxHP ?? player.currentHP ?? 1;
  const opponentMax = opponent.maxHP ?? opponent.currentHP ?? 1;

  const branch: BranchState = {
    pokemon: {
      player,
      opponent,
    },
    hp: {
      player: player.currentHP ?? playerMax,
      opponent: opponent.currentHP ?? opponentMax,
    },
    maxHP: {
      player: playerMax,
      opponent: opponentMax,
    },
    teraMode: {
      player: player.teraMode ?? "none",
      opponent: opponent.teraMode ?? "none",
    },
    teraType: {
      player: player.teraType,
      opponent: opponent.teraType,
    },
    stellarUsage: {
      player: new Set<string>(),
      opponent: new Set<string>(),
    },
    lastDamage: {
      player: 0,
      opponent: 0,
    },
    field: cloneFieldState(field),
    probability: 1,
    terminated: false,
  };

  branch.pokemon.player.currentHP = branch.hp.player;
  branch.pokemon.opponent.currentHP = branch.hp.opponent;
  branch.pokemon.player.maxHP = branch.maxHP.player;
  branch.pokemon.opponent.maxHP = branch.maxHP.opponent;

  return branch;
}

function runEventSequence(
  events: BattleEvent[],
  context: SimulationContext,
  execution: TimelineExecutionOptions,
  snapshots: TimelineSnapshot[],
  getBranches: () => BranchState[],
  setBranches: (branches: BranchState[]) => void,
  setObservation: (value: number) => void,
  nextSequence: () => number,
): boolean {
  for (const rawEvent of events) {
    const event = normalizeEvent(rawEvent);
    const before = captureSnapshotState(getBranches());
    const result = processEvent(event, getBranches(), context);
    const merged = mergeBranches(result.branches);
    setBranches(merged);

    if (event.id === execution.observationEventId) {
      setObservation(result.observationContribution);
    }

    const eventSnapshot = buildSnapshotFromBranches({
      branches: merged,
      prevBranches: before,
      turn: 0,
      eventId: event.id ?? crypto.randomUUID(),
      description: event.label ?? event.id ?? "이벤트",
      damageRolls: result.damageRolls,
      sequence: nextSequence(),
    });
    if (eventSnapshot) {
      snapshots.push(eventSnapshot);
    }

    if (allBranchesTerminated(merged)) {
      return true;
    }
  }
  return false;
}

interface SnapshotBuildParams {
  branches: BranchState[];
  prevBranches?: SnapshotBranchState[];
  turn: number;
  eventId?: string;
  description?: string;
  damageRolls?: number[];
  sequence: number;
}

function buildSnapshotFromBranches(params: SnapshotBuildParams): TimelineSnapshot | null {
  const { branches } = params;
  if (!branches.length) {
    return null;
  }
  const playerDistribution = toDistribution(branches, "player");
  const opponentDistribution = toDistribution(branches, "opponent");
  const probability = branches.reduce((acc, branch) => acc + branch.probability, 0);
  const first = branches[0];
  const fallbackHp = first.hp;
  const playerAvgHP =
    playerDistribution.length > 0 ? weightedAverage(playerDistribution) : fallbackHp.player;
  const opponentAvgHP =
    opponentDistribution.length > 0 ? weightedAverage(opponentDistribution) : fallbackHp.opponent;

  let deltaHP: Record<BattleSide, number> | undefined;
  let maxHPBefore: Record<BattleSide, number> | undefined;
  if (params.prevBranches && params.prevBranches.length > 0) {
    const prevTotal = params.prevBranches.reduce((acc, branch) => acc + branch.probability, 0) || 1;
    const prevPlayerHP =
      params.prevBranches.reduce((acc, branch) => acc + branch.hp.player * branch.probability, 0) /
      prevTotal;
    const prevOpponentHP =
      params.prevBranches.reduce((acc, branch) => acc + branch.hp.opponent * branch.probability, 0) /
      prevTotal;
    const prevPlayerMax =
      params.prevBranches.reduce((acc, branch) => acc + branch.maxHP.player * branch.probability, 0) /
      prevTotal;
    const prevOpponentMax =
      params.prevBranches.reduce((acc, branch) => acc + branch.maxHP.opponent * branch.probability, 0) /
      prevTotal;
    deltaHP = {
      player: prevPlayerHP - playerAvgHP,
      opponent: prevOpponentHP - opponentAvgHP,
    };
    maxHPBefore = {
      player: prevPlayerMax,
      opponent: prevOpponentMax,
    };
  }

  return {
    turn: params.turn,
    eventId: params.eventId ?? crypto.randomUUID(),
    sequence: params.sequence,
    hp: {
      player: Math.round(playerAvgHP),
      opponent: Math.round(opponentAvgHP),
    },
    maxHP: {
      player: first.maxHP.player,
      opponent: first.maxHP.opponent,
    },
    probability,
    description: params.description ?? params.eventId ?? "이벤트",
    hpDistribution: playerDistribution,
    opponentHpDistribution: opponentDistribution,
    damageRolls: params.damageRolls,
    deltaHP,
    maxHPBefore,
  };
}

function weightedAverage(distribution: DistributionPoint[]): number {
  if (!distribution.length) {
    return 0;
  }
  return distribution.reduce((acc, entry) => acc + entry.hp * entry.probability, 0);
}

function orderActions(turn: TimelineTurn, context: SimulationContext): BattleAction[] {
  const actions = turn.actions ?? [];
  if (actions.length === 0) {
    return [];
  }
  if (context.options.battleStyle === "doubles") {
    return [...actions];
  }
  const first = turn.order;
  const second: BattleSide = first === "player" ? "opponent" : "player";
  const firstActions = actions.filter((action) => action.actor === first);
  const secondActions = actions.filter((action) => action.actor === second);
  const neutralActions = actions.filter(
    (action) => action.actor !== first && action.actor !== second,
  );
  return [...firstActions, ...secondActions, ...neutralActions];
}

function describeAction(action: BattleAction): string {
  switch (action.type) {
    case "move":
      return `${action.actor === "player" ? "플레이어" : "상대"}: ${action.move.name}`;
    case "switch":
      return `${action.actor === "player" ? "플레이어" : "상대"} 교체 → ${action.targetSpecies}`;
    case "pass":
    default:
      return `${action.actor === "player" ? "플레이어" : "상대"} 행동 없음`;
  }
}

function processAction(
  action: BattleAction,
  branches: BranchState[],
  context: SimulationContext,
): EventResult {
  switch (action.type) {
    case "move": {
      const attackEvent: AttackEvent = {
        id: action.id,
        label: describeAction(action),
        type: "attack",
        actionId: action.id,
        timing: "action",
        actor: action.actor,
        target: action.target ?? (action.actor === "player" ? "opponent" : "player"),
        move: action.move,
      };
      if (action.teraMode !== undefined) {
        attackEvent.move = {
          ...attackEvent.move,
          teraMode: action.teraMode,
          teraType: action.teraType ?? attackEvent.move.teraType,
        };
      }
      return processAttack(attackEvent, branches, context);
    }
    case "switch": {
      const switchEvent: SwitchEvent = {
        id: action.id,
        label: describeAction(action),
        type: "switch",
        actionId: action.id,
        timing: "action",
        actor: action.actor,
        pokemon: {
          species: action.targetSpecies ?? "",
          level: 50,
          nature: "Hardy",
          ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
          evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
        },
        targetSpecies: action.targetSpecies,
        setHpPercent: action.setHpPercent,
        ability: action.ability ?? undefined,
        item: action.item ?? undefined,
      };
      return {
        branches: processSwitchEvent(switchEvent, branches),
        observationContribution: 0,
      };
    }
    case "pass":
    default:
      return {
        branches,
        observationContribution: 0,
      };
  }
}

function processEvent(
  event: BattleEvent,
  branches: BranchState[],
  context: SimulationContext,
): EventResult {
  switch (event.type) {
    case "attack":
      return processAttack(event, branches, context);
    case "stat-change":
      return {
        branches: processStatChange(event, branches),
        observationContribution: 0,
      };
    case "hp-adjustment":
      return {
        branches: processHpAdjustment(event, branches),
        observationContribution: 0,
      };
    case "healing":
      return {
        branches: processHealingEvent(event, branches),
        observationContribution: 0,
      };
    case "switch":
      return {
        branches: processSwitchEvent(event, branches),
        observationContribution: 0,
      };
    case "field-toggle":
      return {
        branches: processFieldToggle(event, branches),
        observationContribution: 0,
      };
    case "status":
      return {
        branches: processStatusEvent(event, branches),
        observationContribution: 0,
      };
    default:
      return {
        branches,
        observationContribution: 0,
      };
  }
}

function processAttack(
  event: AttackEvent,
  branches: BranchState[],
  context: SimulationContext,
): EventResult {
  const newBranches: BranchState[] = [];
  let observationContribution = 0;
  const damageRolls: number[] = []; // 모든 롤의 데미지 수집
  const target: BattleSide =
    event.target ?? (event.actor === "player" ? "opponent" : "player");

  for (const branch of branches) {
    if (branch.terminated) {
      newBranches.push(branch);
      continue;
    }

    if (branch.hp[event.actor] <= 0 || branch.hp[target] <= 0) {
      const terminated = { ...branch, terminated: true };
      newBranches.push(terminated);
      continue;
    }

    const attacker = clonePokemonState(branch.pokemon[event.actor]);
    const defender = clonePokemonState(branch.pokemon[target]);

    attacker.currentHP = branch.hp[event.actor];
    attacker.maxHP = branch.maxHP[event.actor];
    defender.currentHP = branch.hp[target];
    defender.maxHP = branch.maxHP[target];

    const moveForCalc = prepareMoveForBranch(
      event.move,
      attacker,
      branch,
      event.actor,
      context.execution,
    );

    const field = branch.field;

    const cacheKey: DamageCacheKey = {
      attacker,
      defender,
      move: moveForCalc,
      field,
      actorSide: event.actor,
    };

    const cached = context.cache.get(cacheKey);
    const computation = cached ?? computeDamage(
      event.actor,
      attacker,
      defender,
      moveForCalc,
      field,
    );

    if (!cached) {
      context.cache.set(cacheKey, computation);
    }

    const rolls = computation.rolls;
    const rollProbability = branch.probability / rolls.length;
    const moveType = resolveMoveType(moveForCalc, attacker);

    // 첫 번째 브랜치에서만 롤 정보 수집 (중복 방지)
    if (damageRolls.length === 0) {
      rolls.forEach((roll) => {
        damageRolls.push(roll.damage);
      });
    }

    for (const roll of rolls) {
      const newBranch = cloneBranch(branch);
      newBranch.probability = rollProbability;
      newBranch.field = field;

      const damage = Math.min(roll.damage, newBranch.hp[target]);
      newBranch.hp[target] = Math.max(0, newBranch.hp[target] - damage);
      newBranch.lastDamage[target] = damage;
      newBranch.pokemon[target].currentHP = newBranch.hp[target];

      if (roll.drain) {
        newBranch.hp[event.actor] = Math.min(
          newBranch.maxHP[event.actor],
          newBranch.hp[event.actor] + roll.drain,
        );
        newBranch.pokemon[event.actor].currentHP = newBranch.hp[event.actor];
      }

      if (roll.recoil) {
        newBranch.hp[event.actor] = Math.max(
          0,
          newBranch.hp[event.actor] - roll.recoil,
        );
        newBranch.pokemon[event.actor].currentHP = newBranch.hp[event.actor];
      }

      if (
        event.id === context.execution.observationEventId &&
        context.execution.observationRange
      ) {
        const percent = damage / newBranch.maxHP[target];
        if (
          percent >= context.execution.observationRange[0] &&
          percent <= context.execution.observationRange[1]
        ) {
          observationContribution += rollProbability;
        }
      }

      if (moveForCalc.teraMode && moveForCalc.teraMode !== branch.teraMode[event.actor]) {
        newBranch.teraMode[event.actor] = moveForCalc.teraMode;
        newBranch.teraType[event.actor] = moveForCalc.teraType ?? attacker.teraType;
        newBranch.pokemon[event.actor] = {
          ...newBranch.pokemon[event.actor],
          teraMode: moveForCalc.teraMode,
          teraType: moveForCalc.teraType ?? attacker.teraType,
        };
      }

      if (moveForCalc.teraMode === "stellar" && !context.execution.allowRaidStellar) {
        newBranch.stellarUsage[event.actor].add(moveType);
      }


      if (newBranch.hp[target] <= 0 || newBranch.hp[event.actor] <= 0) {
        newBranch.terminated = true;
      }

      newBranches.push(newBranch);
    }
  }

  return {
    branches: newBranches,
    observationContribution,
    damageRolls: damageRolls.length > 0 ? damageRolls : undefined,
  };
}

function processStatChange(
  event: StatChangeEvent,
  branches: BranchState[],
): BranchState[] {
  if (!event.actor) {
    return branches;
  }
  const updated: BranchState[] = [];
  for (const branch of branches) {
    if (branch.terminated) {
      updated.push(branch);
      continue;
    }
    const clone = cloneBranch(branch);
    const side = event.actor;
    const boosts = { ...(clone.pokemon[side].boosts ?? {}) };
    for (const stat of Object.keys(event.stages) as Array<keyof StatsTable<number>>) {
      const delta = event.stages[stat];
      if (delta === undefined || delta === null) continue;
      const current = boosts[stat] ?? 0;
      const next = clampStage(current + delta);
      if (next === 0) {
        delete boosts[stat];
      } else {
        boosts[stat] = next;
      }
    }
    clone.pokemon[side] = {
      ...clone.pokemon[side],
      boosts,
    };
    updated.push(clone);
  }
  return updated;
}

function processHpAdjustment(
  event: HpAdjustmentEvent,
  branches: BranchState[],
): BranchState[] {
  const updated: BranchState[] = [];
  for (const branch of branches) {
    if (branch.terminated) {
      updated.push(branch);
      continue;
    }
    const clone = cloneBranch(branch);
    const targetSide = event.target ?? event.actor;
    const maxHP = clone.maxHP[targetSide];
    const lastDamage = clone.lastDamage[targetSide] || 0;
    let amount = event.amount;
    const fraction = resolveFractionValue(event.fractionNumerator, event.fractionDenominator);

    switch (event.mode) {
      case "percent-max":
        amount = Math.floor((maxHP * (Number.isFinite(amount) ? amount : 0)) / 100);
        break;
      case "percent-last-damage":
        amount = Math.floor((lastDamage * (Number.isFinite(amount) ? amount : 0)) / 100);
        break;
      case "fraction-max": {
        if (fraction !== undefined) {
          amount = Math.floor(maxHP * Math.max(0, fraction));
        }
        break;
      }
      case "fraction-last-damage": {
        if (fraction !== undefined) {
          amount = Math.floor(lastDamage * Math.max(0, fraction));
        }
        break;
      }
      default: {
        break;
      }
    }

    if (event.isDamage) {
      const damage = Math.max(0, Math.min(amount, clone.hp[targetSide]));
      clone.hp[targetSide] -= damage;
      clone.lastDamage[targetSide] = damage;
      clone.pokemon[targetSide].currentHP = clone.hp[targetSide];
      if (clone.hp[targetSide] <= 0) {
        clone.terminated = true;
      }
    } else {
      const heal = Math.abs(amount);
      clone.hp[targetSide] = Math.min(clone.maxHP[targetSide], clone.hp[targetSide] + heal);
      clone.pokemon[targetSide].currentHP = clone.hp[targetSide];
    }
    updated.push(clone);
  }
  return updated;
}

function processHealingEvent(
  event: HealingEvent,
  branches: BranchState[],
): BranchState[] {
  if (!event.actor) {
    return branches;
  }
  const updated: BranchState[] = [];
  for (const branch of branches) {
    if (branch.terminated) {
      updated.push(branch);
      continue;
    }
    const clone = cloneBranch(branch);
    const side = event.actor;
    const amount = computeHealingAmount(event, clone.maxHP[side]);
    clone.hp[side] = Math.min(clone.maxHP[side], clone.hp[side] + amount);
    clone.pokemon[side].currentHP = clone.hp[side];
    updated.push(clone);
  }
  return updated;
}

function computeHealingAmount(event: HealingEvent, maxHP: number): number {
  if (event.amount === "fraction") {
    const ratio = resolveFractionValue(event.fractionNumerator, event.fractionDenominator, event.fraction) ?? 0;
    const heal = Math.floor(maxHP * Math.max(0, ratio));
    return Math.max(heal, 1);
  }
  if (typeof event.amount === "number") {
    return event.amount;
  }
  return event.amount.min;
}

function processStatusEvent(
  event: StatusEvent,
  branches: BranchState[],
): BranchState[] {
  if (!event.actor) {
    return branches;
  }
  const updated: BranchState[] = [];
  for (const branch of branches) {
    const clone = cloneBranch(branch);
    const side = event.actor;
    const nextStatus = event.clears ? undefined : event.status;
    clone.pokemon[side] = {
      ...clone.pokemon[side],
      status: nextStatus ?? undefined,
    };
    updated.push(clone);
  }
  return updated;
}

function processSwitchEvent(
  event: SwitchEvent,
  branches: BranchState[],
): BranchState[] {
  if (!event.actor) {
    return branches;
  }
  const updated: BranchState[] = [];
  for (const branch of branches) {
    if (branch.terminated) {
      updated.push(branch);
      continue;
    }
    const clone = cloneBranch(branch);
    const side = event.actor;
    const updatedState = applySwitchState(
      clone.pokemon[side],
      event,
      clone,
      side,
    );
    clone.pokemon[side] = updatedState;
    clone.teraMode[side] = "none";
    clone.teraType[side] = undefined;
    clone.lastDamage[side] = 0;
    updated.push(clone);
  }
  return updated;
}

function processFieldToggle(
  event: FieldToggleEvent,
  branches: BranchState[],
): BranchState[] {
  const updated: BranchState[] = [];
  for (const branch of branches) {
    const clone = cloneBranch(branch);
    clone.field = mergeFieldStates(clone.field, event.field ?? {});
    updated.push(clone);
  }
  return updated;
}

function normalizeEvent<T extends BattleEvent>(event: T): T {
  const timing = event.timing ?? resolveTiming(event);
  if (event.timing === timing) {
    return event;
  }
  return {
    ...event,
    timing,
  };
}

function resolveTiming(event: BattleEvent): TurnTiming {
  if (event.timing) {
    return event.timing;
  }
  return "action";
}

function resolvePhaseFromTiming(timing: TurnTiming) {
  switch (timing) {
    case "turn-start":
      return "priority";
    case "turn-end":
      return "residual";
    case "action":
    default:
      return "main";
  }
}

function prepareMoveForBranch(
  move: MoveConfig,
  attacker: PokemonState,
  branch: BranchState,
  side: BattleSide,
  execution: TimelineExecutionOptions,
): MoveConfig {
  const clone: MoveConfig = {
    ...move,
    overrides: move.overrides ? { ...move.overrides } : undefined,
  };
  const currentMode = branch.teraMode[side];
  clone.teraMode = clone.teraMode ?? (currentMode as MoveConfig["teraMode"]);
  clone.teraType = clone.teraType ?? branch.teraType[side] ?? attacker.teraType;

  if (clone.teraMode === "stellar") {
    if (execution.allowRaidStellar) {
      clone.stellarFirstUse = true;
    } else {
      const type = resolveMoveType(clone, attacker);
      clone.stellarFirstUse = !branch.stellarUsage[side].has(type);
    }
  }
  return clone;
}

function resolveMoveType(move: MoveConfig, attacker: PokemonState): string {
  if (move.overrides?.type) {
    return move.overrides.type;
  }
  if (move.name === "Tera Blast" && (move.teraType ?? attacker.teraType)) {
    return move.teraType ?? attacker.teraType ?? "Normal";
  }
  const dexMove = dex.moves.get(move.name);
  return dexMove?.type ?? "Normal";
}

function applyFieldAdjustments(
  base: FieldState,
  adjustments: FieldState | undefined,
  actor: BattleSide,
): FieldState {
  if (!adjustments) {
    return base;
  }

  const next = cloneFieldState(base);

  if (adjustments.weather !== undefined) {
    next.weather = adjustments.weather;
  }
  if (adjustments.terrain !== undefined) {
    next.terrain = adjustments.terrain;
  }
  if (adjustments.trickRoom !== undefined) {
    next.trickRoom = adjustments.trickRoom;
  }

  // Side state adjustments are not supported in FieldState

  return next;
}

function mergeFieldStates(base: FieldState, updates: FieldState): FieldState {
  const merged = cloneFieldState(base);
  if (updates.weather !== undefined) {
    merged.weather = updates.weather;
  }
  if (updates.terrain !== undefined) {
    merged.terrain = updates.terrain;
  }
  if (updates.trickRoom !== undefined) {
    merged.trickRoom = updates.trickRoom;
  }
  // Side state updates are not supported in FieldState
  return merged;
}

function cloneSideState(side: SideState | undefined): SideState | undefined {
  if (!side) return undefined;
  return { ...side };
}

function mergeSideState(
  current: SideState | undefined,
  updates: SideState | undefined,
): SideState | undefined {
  if (!updates) {
    return current ? { ...current } : undefined;
  }
  const next: Record<string, boolean | number | undefined> = { ...(current ?? {}) };
  for (const key of Object.keys(updates) as Array<keyof NonNullable<typeof updates>>) {
    const value = updates[key];
    if (value === undefined) {
      delete next[key as string];
    } else {
      next[key as string] = value;
    }
  }
  return Object.keys(next).length > 0 ? (next as FieldState["attackerSide"]) : undefined;
}

function processSwitchState(
  base: PokemonState,
  payload: Pick<SwitchEvent, "targetSpecies" | "setHpPercent" | "ability" | "item">,
  branch: BranchState,
  side: BattleSide,
): PokemonState {
  const updated: PokemonState = {
    ...base,
    species: payload.targetSpecies ?? base.species,
    ability: payload.ability ?? base.ability ?? undefined,
    item: payload.item ?? base.item ?? undefined,
    status: undefined,
    boosts: undefined,
    teraMode: "none",
    teraType: undefined,
  };

  if (payload.setHpPercent !== undefined && payload.setHpPercent !== null) {
    const percent = Math.max(0, Math.min(100, payload.setHpPercent));
    const maxHP = branch.maxHP[side];
    const hp = Math.round((maxHP * percent) / 100);
    branch.hp[side] = Math.max(0, Math.min(maxHP, hp));
  } else {
    branch.hp[side] = branch.maxHP[side];
  }
  updated.maxHP = branch.maxHP[side];
  updated.currentHP = branch.hp[side];
  return updated;
}

function applySwitchState(
  base: PokemonState,
  payload: Pick<SwitchEvent, "targetSpecies" | "setHpPercent" | "ability" | "item">,
  branch: BranchState,
  side: BattleSide,
): PokemonState {
  return processSwitchState(base, payload, branch, side);
}

function clonePokemonState(state: PokemonState): PokemonState {
  return {
    ...state,
    ivs: { ...state.ivs },
    evs: { ...state.evs },
    boosts: { ...(state.boosts ?? {}) },
    overrides: state.overrides
      ? {
          ...state.overrides,
          baseStats: state.overrides.baseStats
            ? { ...state.overrides.baseStats }
            : undefined,
        }
      : undefined,
    types: state.types ? [...state.types] : state.types,
  };
}


function cloneFieldState(field: FieldState): FieldState {
  return {
    ...field,
    attackerSide: field.attackerSide ? cloneSideState(field.attackerSide) : undefined,
    defenderSide: field.defenderSide ? cloneSideState(field.defenderSide) : undefined,
  };
}

function applyLeftoversRecovery(
  branches: BranchState[],
  context: SimulationContext,
): BranchState[] {
  const updated: BranchState[] = [];
  for (const branch of branches) {
    if (branch.terminated) {
      updated.push(branch);
      continue;
    }
    const clone = cloneBranch(branch);
    
    // Leftovers 회복: ⌊MaxHP/16⌋ (최소 1)
    for (const side of ["player", "opponent"] as BattleSide[]) {
      const pokemon = clone.pokemon[side];
      if (pokemon.item === "Leftovers" && clone.hp[side] > 0 && clone.hp[side] < clone.maxHP[side]) {
        const recovery = Math.max(1, Math.floor(clone.maxHP[side] / 16));
        clone.hp[side] = Math.min(clone.maxHP[side], clone.hp[side] + recovery);
        clone.pokemon[side].currentHP = clone.hp[side];
      }
    }
    
    updated.push(clone);
  }
  return updated;
}

function cloneBranch(branch: BranchState): BranchState {
  return {
    pokemon: {
      player: clonePokemonState(branch.pokemon.player),
      opponent: clonePokemonState(branch.pokemon.opponent),
    },
    hp: { ...branch.hp },
    maxHP: { ...branch.maxHP },
    teraMode: { ...branch.teraMode },
    teraType: { ...branch.teraType },
    stellarUsage: {
      player: new Set(branch.stellarUsage.player),
      opponent: new Set(branch.stellarUsage.opponent),
    },
    lastDamage: { ...branch.lastDamage },
    field: cloneFieldState(branch.field),
    probability: branch.probability,
    terminated: branch.terminated,
  };
}

function mergeBranches(branches: BranchState[]): BranchState[] {
  const merged = new Map<string, BranchState>();
  for (const branch of branches) {
    const key = buildBranchKey(branch);
    const existing = merged.get(key);
    if (existing) {
      existing.probability += branch.probability;
    } else {
      merged.set(key, branch);
    }
  }
  return Array.from(merged.values());
}

function buildBranchKey(branch: BranchState): string {
  const stellarPlayer = Array.from(branch.stellarUsage.player).sort().join(",");
  const stellarOpponent = Array.from(branch.stellarUsage.opponent).sort().join(",");
  const boostsPlayer = serializeBoosts(branch.pokemon.player.boosts ?? {});
  const boostsOpponent = serializeBoosts(branch.pokemon.opponent.boosts ?? {});
  const fieldSignature = serializeFieldState(branch.field);

  return [
    branch.hp.player,
    branch.hp.opponent,
    branch.teraMode.player,
    branch.teraMode.opponent,
    branch.teraType.player ?? "",
    branch.teraType.opponent ?? "",
    branch.pokemon.player.ability ?? "",
    branch.pokemon.opponent.ability ?? "",
    branch.pokemon.player.item ?? "",
    branch.pokemon.opponent.item ?? "",
    branch.pokemon.player.status ?? "",
    branch.pokemon.opponent.status ?? "",
    boostsPlayer,
    boostsOpponent,
    stellarPlayer,
    stellarOpponent,
    fieldSignature,
    branch.lastDamage.player,
    branch.lastDamage.opponent,
    branch.terminated ? 1 : 0,
  ].join(BRANCH_KEY_DELIMITER);
}

function serializeBoosts(boosts: Partial<StatsTable<number>>): string {
  return Object.entries(boosts)
    .filter(([, value]) => value !== undefined && value !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat}:${value}`)
    .join(",");
}

function serializeFieldState(field: FieldState): string {
  return JSON.stringify({
    weather: field.weather ?? null,
    terrain: field.terrain ?? null,
    trickRoom: field.trickRoom ?? null,
    attackerSide: field.attackerSide ?? null,
    defenderSide: field.defenderSide ?? null,
  });
}

function toDistribution(branches: BranchState[], side: BattleSide): DistributionPoint[] {
  const map = new Map<number, number>();
  for (const branch of branches) {
    const hp = Math.max(0, Math.round(branch.hp[side]));
    const existing = map.get(hp) ?? 0;
    map.set(hp, existing + branch.probability);
  }
  const total = Array.from(map.values()).reduce((acc, value) => acc + value, 0);
  if (total <= 0) {
    return [];
  }
  return Array.from(map.entries())
    .map(([hp, probability]) => ({ hp, probability: probability / total }))
    .sort((a, b) => a.hp - b.hp);
}

function allBranchesTerminated(branches: BranchState[]): boolean {
  return branches.every((branch) => branch.terminated);
}

function clampStage(value: number): number {
  return Math.max(-6, Math.min(6, value));
}
