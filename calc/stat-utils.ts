import { Dex } from "@pkmn/dex";
import { Generations, calcStat } from "@smogon/calc";
import type { StatsTable, StatID, PokemonState } from "./types";

const dex = Dex.forGen(9);
let cachedGen9: ReturnType<typeof Generations.get> | null = null;

function getGen9() {
  if (!cachedGen9) {
    cachedGen9 = Generations.get(9);
  }
  return cachedGen9;
}

/**
 * Sum all EV values in a StatsTable
 */
export function sumEVs(evs: StatsTable<number>): number {
  return evs.hp + evs.atk + evs.def + evs.spa + evs.spd + evs.spe;
}

/**
 * Get base stats for a Pokemon species
 */
export function getBaseStats(species: string): StatsTable<number> | null {
  const speciesData = dex.species.get(species);
  if (!speciesData) return null;
  return {
    hp: speciesData.baseStats.hp,
    atk: speciesData.baseStats.atk,
    def: speciesData.baseStats.def,
    spa: speciesData.baseStats.spa,
    spd: speciesData.baseStats.spd,
    spe: speciesData.baseStats.spe,
  };
}

/**
 * Compute actual stats from base stats, EVs, IVs, and nature
 */
export function computeActualStats(
  pokemon: PokemonState,
  base: StatsTable<number>,
): StatsTable<number> | null {
  const gen = getGen9();
  const stats: StatsTable<number> = {
    hp: 0,
    atk: 0,
    def: 0,
    spa: 0,
    spd: 0,
    spe: 0,
  };

  const statIDs: StatID[] = ["hp", "atk", "def", "spa", "spd", "spe"];
  for (const stat of statIDs) {
    stats[stat] = calcStat(
      gen,
      stat,
      base[stat],
      pokemon.ivs[stat] ?? 31,
      pokemon.evs[stat] ?? 0,
      pokemon.level,
      pokemon.nature,
    );
  }

  return stats;
}

/**
 * Calculate minimum EV required to achieve a target stat value
 * Uses binary search for efficiency
 */
export function computeMinEVForStat(
  stat: StatID,
  targetStat: number,
  base: number,
  iv: number,
  level: number,
  nature?: string,
): number {
  const gen = getGen9();
  
  // Binary search for minimum EV
  let low = 0;
  let high = 252;
  let minEV = 252;
  
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const calculatedStat = calcStat(gen, stat, base, iv, mid, level, nature);
    
    if (calculatedStat >= targetStat) {
      minEV = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  
  // Round to nearest step (4 EV)
  return Math.ceil(minEV / 4) * 4;
}
