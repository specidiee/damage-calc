import type { PokemonState } from "@/lib/calc/types";

/**
 * 기술 사용으로 폼 체인지 가능 여부 확인
 * 예: Meloetta + Relic Song, Rayquaza + Dragon Ascent
 */
export function canChangeFormByMove(pokemon: PokemonState | undefined): boolean {
  if (!pokemon?.species) return false;

  const speciesName = pokemon.species.toLowerCase();

  // Meloetta는 Relic Song으로 폼 체인지 가능
  if (speciesName.includes("meloetta")) {
    return true;
  }

  // Rayquaza는 Dragon Ascent로 폼 체인지 가능
  if (speciesName.includes("rayquaza")) {
    return true;
  }

  // 기타 기술 기반 폼 체인지 가능 포켓몬들
  // (추가 필요시 여기에 추가)

  return false;
}

/**
 * 기믹 사용으로 폼 체인지 가능 여부 확인
 * 예: Ogerpon Tera, 특수 폼 타입이 있는 포켓몬들
 */
export function canChangeFormByGimmick(pokemon: PokemonState | undefined): boolean {
  if (!pokemon) return false;

  // specialFormType이 있는 경우 (mega, primal, ultra_burst, gigantamax, exclusive_terastal)
  // baseSpeciesId로 같은 종족의 다른 폼이 있는지 확인
  // Ogerpon의 경우 exclusive_terastal 타입이 있고, 테라스탈 시 폼 체인지

  const speciesName = pokemon.species?.toLowerCase() ?? "";

  // Ogerpon은 테라스탈 시 폼 체인지
  if (speciesName.includes("ogerpon")) {
    return true;
  }

  // Terapagos는 스텔라 테라 시 폼 체인지
  if (speciesName.includes("terapagos")) {
    return true;
  }

  // baseSpeciesId가 있고, specialFormType이 있는 경우
  // (DB에서 확인 필요하지만, 일단 하드코딩된 리스트 사용)
  const gimmickFormPokemon = [
    "ogerpon",
    "terapagos",
    // 메가진화 가능 포켓몬들 (Gen 6-7)
    "venusaur",
    "charizard",
    "blastoise",
    "alakazam",
    "gengar",
    "kangaskhan",
    "pinsir",
    "gyarados",
    "aerodactyl",
    "mewtwo",
    "ampharos",
    "scizor",
    "heracross",
    "houndoom",
    "tyranitar",
    "blaziken",
    "gardevoir",
    "mawile",
    "aggron",
    "medicham",
    "manectric",
    "banette",
    "absol",
    "garchomp",
    "lucario",
    "abomasnow",
    "beedrill",
    "pidgeot",
    "slowbro",
    "steelix",
    "sceptile",
    "swampert",
    "sableye",
    "sharpedo",
    "camerupt",
    "altaria",
    "glalie",
    "salamence",
    "metagross",
    "latias",
    "latios",
    "rayquaza",
    "lopunny",
    "gallade",
    "audino",
    "diancie",
    // 원시회귀
    "groudon",
    "kyogre",
    // 울트라버스트
    "necrozma",
    // 거다이맥스
    "charizard",
    "butterfree",
    "pikachu",
    "meowth",
    "machamp",
    "gengar",
    "kingler",
    "lapras",
    "eevee",
    "snorlax",
    "garbodor",
    "melmetal",
    "rillaboom",
    "cinderace",
    "inteleon",
    "corviknight",
    "orbeetle",
    "drednaw",
    "coalossal",
    "flapple",
    "appletun",
    "sandaconda",
    "toxtricity",
    "centiskorch",
    "hatterene",
    "grimmsnarl",
    "alcremie",
    "copperajah",
    "duraludon",
    "urshifu",
  ];

  return gimmickFormPokemon.some((name) => speciesName.includes(name));
}

