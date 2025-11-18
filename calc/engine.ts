import {
  Field as CalcField,
  Generations,
  Move as CalcMove,
  Pokemon as CalcPokemon,
  Result,
  calculate,
  calcStat,
  type State,
  type StatsTable as CalcStatsTable,
} from "@smogon/calc";
import type {
  BattleSide,
  FieldState,
  MoveOverrides,
  MoveConfig,
  PokemonOverrides,
  PokemonState,
  SideState,
  StatID,
  StatsTable,
  TeraMode,
} from "./types";

export interface DamageRollOutcome {
  roll: number;
  damage: number;
  percent: number;
  defenderHP: number;
  drain?: number;
  recoil?: number;
}

export interface DamageComputation {
  result: Result;
  rolls: DamageRollOutcome[];
  move: MoveConfig;
  attacker: PokemonState;
  defender: PokemonState;
}

type CalcGeneration = ReturnType<typeof Generations.get>;

let cachedGen9: CalcGeneration | null = null;

export function getGen9() {
  if (!cachedGen9) {
    cachedGen9 = Generations.get(9);
  }
  return cachedGen9;
}

function normalizeStats(stats: StatsTable<number>): CalcStatsTable {
  return {
    hp: stats.hp,
    atk: stats.atk,
    def: stats.def,
    spa: stats.spa,
    spd: stats.spd,
    spe: stats.spe,
  };
}

function normalizeBoosts(
  boosts: Partial<StatsTable<number>> | undefined,
): Partial<CalcStatsTable> {
  if (!boosts) return {};
  const normalized: Partial<CalcStatsTable> = {};
  for (const key of ["atk", "def", "spa", "spd", "spe"] as const) {
    if (boosts[key] !== undefined) {
      normalized[key] = boosts[key];
    }
  }
  return normalized;
}

function buildPokemonOptions(
  pokemon: PokemonState,
  teraModeOverride?: TeraMode,
  teraTypeOverride?: string,
): State.Pokemon {
  const overrides = buildOverrides(pokemon.overrides as PokemonOverrides | undefined);
  return {
    name: pokemon.species as State.Pokemon["name"],
    level: pokemon.level,
    ability: pokemon.ability as State.Pokemon["ability"],
    abilityOn: true,
    item: pokemon.item as State.Pokemon["item"],
    nature: pokemon.nature as State.Pokemon["nature"],
    status: pokemon.status as State.Pokemon["status"],
    ivs: normalizeStats(pokemon.ivs),
    evs: normalizeStats(pokemon.evs),
    boosts: normalizeBoosts(pokemon.boosts ?? undefined),
    teraType: resolveTeraType(pokemon, teraModeOverride, teraTypeOverride),
    overrides,
  };
}

function resolveTeraType(
  pokemon: PokemonState,
  overrideMode?: TeraMode,
  overrideType?: string,
): State.Pokemon["teraType"] | undefined {
  const mode = overrideMode ?? pokemon.teraMode;
  if (mode === "none") {
    return undefined;
  }
  return (overrideType ?? pokemon.teraType) as State.Pokemon["teraType"];
}

function buildField(field: FieldState, actor: BattleSide): State.Field {
  return {
    gameType: "Singles",
    weather: field.weather as State.Field["weather"],
    terrain: field.terrain as State.Field["terrain"],
    attackerSide: convertSide(field.attackerSide),
    defenderSide: convertSide(field.defenderSide),
  };
}

function convertSide(side?: SideState): State.Side {
  if (!side) {
    return {};
  }
  return {
    isReflect: side.isReflect,
    isLightScreen: side.isLightScreen,
    isAuroraVeil: side.isAuroraVeil,
    spikes: side.spikes,
  };
}

function buildMove(move: MoveConfig): State.Move {
  const overrides = buildMoveOverrides(move.overrides);
  return {
    name: move.name as State.Move["name"],
    isCrit: move.isCrit,
    hits: move.hits,
    overrides,
  };
}

function ensurePokemonMaxHP(
  pokemon: PokemonState,
  calcPokemon: CalcPokemon,
): number {
  if (pokemon.maxHP) {
    return pokemon.maxHP;
  }
  return calcPokemon.stats.hp;
}

export function computeDamage(
  actorSide: BattleSide,
  attacker: PokemonState,
  defender: PokemonState,
  move: MoveConfig,
  field: FieldState,
): DamageComputation {
  const gen = getGen9();
  const attackerOptions = buildPokemonOptions(
    attacker,
    move.teraMode,
    move.teraType,
  );
  const defenderOptions = buildPokemonOptions(defender);

  const calcAttacker = new CalcPokemon(
    gen,
    attacker.species,
    attackerOptions,
  );
  const calcDefender = new CalcPokemon(
    gen,
    defender.species,
    defenderOptions,
  );

  const calcMove = new CalcMove(gen, move.name, buildMove(move));

  const fieldState = new CalcField(buildField(field, actorSide));

  const result = calculate(gen, calcAttacker, calcDefender, calcMove, fieldState);

  const defenderMaxHP = ensurePokemonMaxHP(defender, calcDefender);

  const damage = normalizeDamageArray(result.damage);

  const rolls = damage.map((value, index) => {
    const percent = defenderMaxHP ? value / defenderMaxHP : 0;
    return {
      roll: index,
      damage: value,
      percent,
      defenderHP: defenderMaxHP,
      drain: deriveDrain(value, move),
      recoil: deriveRecoil(value, move),
    };
  });

  return {
    result,
    rolls,
    move,
    attacker,
    defender,
  };
}

function deriveDrain(damage: number, move: MoveConfig): number | undefined {
  if (!move.drainPercent || move.drainPercent <= 0) {
    return undefined;
  }
  return Math.ceil(damage * move.drainPercent);
}

function deriveRecoil(damage: number, move: MoveConfig): number | undefined {
  if (!move.recoilPercent || move.recoilPercent <= 0) {
    return undefined;
  }
  return Math.floor(damage * move.recoilPercent);
}

function normalizeDamageArray(damage: Result["damage"]): number[] {
  if (typeof damage === "number") {
    return [damage];
  }
  if (!Array.isArray(damage)) {
    return [0];
  }
  if (
    damage.length > 0 &&
    Array.isArray(damage[0]) &&
    typeof damage[0][0] === "number"
  ) {
    const matrix = damage as number[][];
    const rolls = matrix[0].length;
    const totals: number[] = new Array(rolls).fill(0);
    for (const row of matrix) {
      row.forEach((value, index) => {
        totals[index] += value;
      });
    }
    return totals;
  }
  return damage as number[];
}

export function calculateStatFromEV(
  stat: StatID,
  base: number,
  iv: number,
  ev: number,
  level: number,
  nature?: string,
): number {
  return calcStat(getGen9(), stat, base, iv, ev, level, nature);
}

function buildOverrides(
  overrides?: PokemonOverrides,
): State.Pokemon["overrides"] | undefined {
  if (!overrides) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (overrides.types) {
    result.types =
      overrides.types.length === 1
        ? [overrides.types[0]]
        : [overrides.types[0], overrides.types[1]];
  }
  return Object.keys(result).length > 0
    ? (result as State.Pokemon["overrides"])
    : undefined;
}

function buildMoveOverrides(
  overrides?: MoveOverrides,
): State.Move["overrides"] | undefined {
  if (!overrides) {
    return undefined;
  }
  const result: Record<string, unknown> = {};
  if (overrides.power !== undefined) {
    result.basePower = overrides.power;
  }
  if (overrides.category) {
    result.category = overrides.category;
  }
  if (overrides.type) {
    result.type = overrides.type;
  }
  return Object.keys(result).length > 0
    ? (result as State.Move["overrides"])
    : undefined;
}
