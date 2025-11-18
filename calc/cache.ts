import type {
  BattleSide,
  FieldState,
  MoveConfig,
  PokemonState,
} from "./types";
import type { DamageComputation } from "./engine";

export interface DamageCacheKey {
  attacker: PokemonState;
  defender: PokemonState;
  move: MoveConfig;
  field: FieldState;
  actorSide: BattleSide;
}

const DEFAULT_LIMIT = 512;

export class DamageCache {
  private readonly limit: number;
  private readonly store = new Map<string, DamageComputation>();

  constructor(limit: number = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  public get(key: DamageCacheKey): DamageComputation | undefined {
    const id = serializeKey(key);
    const cached = this.store.get(id);
    if (!cached) {
      return undefined;
    }
    this.store.delete(id);
    this.store.set(id, cached);
    return cached;
  }

  public set(key: DamageCacheKey, value: DamageComputation) {
    const id = serializeKey(key);
    if (this.store.has(id)) {
      this.store.delete(id);
    }
    this.store.set(id, value);
    if (this.store.size > this.limit) {
      const iterator = this.store.keys().next();
      if (!iterator.done) {
        this.store.delete(iterator.value);
      }
    }
  }

  public clear() {
    this.store.clear();
  }
}

function serializeKey(key: DamageCacheKey): string {
  return JSON.stringify({
    actorSide: key.actorSide,
    attacker: pickPokemonSignature(key.attacker),
    defender: pickPokemonSignature(key.defender),
    move: pickMoveSignature(key.move),
    field: pickFieldSignature(key.field),
  });
}

function pickPokemonSignature(pokemon: PokemonState) {
  return {
    species: pokemon.species,
    level: pokemon.level,
    ability: pokemon.ability,
    item: pokemon.item,
    nature: pokemon.nature,
    status: pokemon.status,
    teraMode: pokemon.teraMode,
    teraType: pokemon.teraType,
    ivs: pokemon.ivs,
    evs: pokemon.evs,
    boosts: pokemon.boosts,
    overrides: pokemon.overrides,
  };
}

function pickMoveSignature(move: MoveConfig) {
  return {
    name: move.name,
    isCrit: move.isCrit,
    hits: move.hits,
    priority: move.priority,
    drainPercent: move.drainPercent,
    recoilPercent: move.recoilPercent,
    overrides: move.overrides,
    teraMode: move.teraMode,
    teraType: move.teraType,
  };
}

function pickFieldSignature(field: FieldState) {
  return {
    weather: field.weather,
    terrain: field.terrain,
    trickRoom: field.trickRoom,
  };
}

