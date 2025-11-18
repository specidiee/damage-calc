// Import types from @smogon/calc
import type { StatID, StatsTable } from "@smogon/calc";

// Constants
export const MAX_TIMELINE_TURNS = 5;

// Battle sides
export type BattleSide = "player" | "opponent";

// Tera mode
export type TeraMode = "none" | "tera" | "stellar" | "normal";

// Pokemon state
export interface PokemonState {
  id?: string;
  species: string;
  level: number;
  nature: string;
  ability?: string;
  item?: string;
  teraType?: string;
  teraMode?: TeraMode;
  ivs: StatsTable<number>;
  evs: StatsTable<number>;
  boosts?: Partial<StatsTable<number>>;
  currentHP?: number;
  maxHP?: number;
  types?: string[];
  status?: string;
  overrides?: {
    baseStats?: StatsTable<number>;
  };
}

// Field state
export interface FieldState {
  weather?: string;
  terrain?: string;
  trickRoom?: boolean;
  wonderRoom?: boolean;
  magicRoom?: boolean;
  isBeadsOfRuin?: boolean;
  isSwordOfRuin?: boolean;
  isTabletsOfRuin?: boolean;
  isVesselOfRuin?: boolean;
  isAuraBreak?: boolean;
  isFairyAura?: boolean;
  isDarkAura?: boolean;
  isReflect?: boolean;
  isLightScreen?: boolean;
  isAuroraVeil?: boolean;
  isProtected?: Record<BattleSide, boolean>;
  attackerSide?: SideState;
  defenderSide?: SideState;
}

// Side state
export interface SideState {
  isReflect?: boolean;
  isLightScreen?: boolean;
  isAuroraVeil?: boolean;
  isProtected?: boolean;
  isTailwind?: boolean;
  isHelpingHand?: boolean;
  isBattery?: boolean;
  isPowerSpot?: boolean;
  isFriendGuard?: boolean;
  isFlowerGift?: boolean;
  spikes?: number;
}

// Move config
export interface MoveConfig {
  name: string;
  type?: string;
  power?: number;
  category?: "physical" | "special" | "status";
  teraMode?: TeraMode;
  teraType?: string;
  isCrit?: boolean;
  hits?: number;
  priority?: number;
  drainPercent?: number;
  recoilPercent?: number;
  timesUsed?: number;
  timesUsedWithMetronome?: number;
  useZMove?: boolean;
  useMaxMove?: boolean;
  stellarFirstUse?: boolean;
  overrides?: {
    type?: string;
    power?: number;
    category?: "physical" | "special" | "status";
  };
}

// Move overrides
export interface MoveOverrides {
  name?: string;
  type?: string;
  power?: number;
  category?: "physical" | "special" | "status";
}

// Pokemon overrides
export interface PokemonOverrides {
  species?: string;
  level?: number;
  nature?: string;
  ability?: string;
  item?: string;
  teraType?: string;
  types?: string[];
}

// Timeline events
export type TurnTiming = "turn-start" | "action" | "turn-end";

export interface AttackEvent {
  type: "attack";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  move: MoveConfig;
  target: BattleSide;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface HealingEvent {
  type: "healing";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  amount: number | "fraction" | { min: number; max: number };
  fraction?: number;
  fractionNumerator?: number;
  fractionDenominator?: number;
  source?: string;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface HpAdjustmentEvent {
  type: "hp-adjustment";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  target?: BattleSide;
  amount: number;
  isDamage?: boolean;
  mode?: "absolute" | "percent-max" | "percent-last-damage" | "fraction-max" | "fraction-last-damage";
  fractionNumerator?: number;
  fractionDenominator?: number;
  source?: string;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface StatChangeEvent {
  type: "stat-change";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  stat: StatID;
  stages: Partial<Record<StatID, number>>;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface StatusEvent {
  type: "status";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  status?: string;
  clears?: boolean;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface FieldToggleEvent {
  type: "field-toggle";
  actionId: string;
  id?: string;
  label?: string;
  actor?: BattleSide;
  field: {
    weather?: string;
    terrain?: string;
    trickRoom?: boolean;
    wonderRoom?: boolean;
    magicRoom?: boolean;
    isBeadsOfRuin?: boolean;
    isSwordOfRuin?: boolean;
    isTabletsOfRuin?: boolean;
    isVesselOfRuin?: boolean;
    isAuraBreak?: boolean;
    isFairyAura?: boolean;
    isDarkAura?: boolean;
    reflect?: boolean;
    lightScreen?: boolean;
    auroraVeil?: boolean;
  };
  attackerSide?: {
    isReflect?: boolean;
    isLightScreen?: boolean;
    isAuroraVeil?: boolean;
    isTailwind?: boolean;
    isHelpingHand?: boolean;
    isBattery?: boolean;
    isPowerSpot?: boolean;
    isFriendGuard?: boolean;
    isFlowerGift?: boolean;
  };
  defenderSide?: {
    isReflect?: boolean;
    isLightScreen?: boolean;
    isAuroraVeil?: boolean;
    isTailwind?: boolean;
    isHelpingHand?: boolean;
    isBattery?: boolean;
    isPowerSpot?: boolean;
    isFriendGuard?: boolean;
    isFlowerGift?: boolean;
  };
  value?: boolean | string;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface SwitchEvent {
  type: "switch";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  pokemon: PokemonState;
  targetSpecies?: string;
  setHpPercent?: number;
  ability?: string | null;
  item?: string | null;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export interface AbilityActivationEvent {
  type: "ability-activation";
  actionId: string;
  id?: string;
  label?: string;
  actor: BattleSide;
  count: number;
  timing?: TurnTiming;
  relatedActionId?: string;
  notes?: string;
}

export type BattleEvent =
  | AttackEvent
  | HealingEvent
  | HpAdjustmentEvent
  | StatChangeEvent
  | StatusEvent
  | FieldToggleEvent
  | SwitchEvent
  | AbilityActivationEvent;

// Battle actions
export interface MoveAction {
  type: "move";
  id: string;
  actor: BattleSide;
  move: MoveConfig;
  target: BattleSide;
  teraMode?: TeraMode;
  teraType?: string;
  itemChange?: string | null;
  abilityChange?: string | null;
  formChange?: string | null;
  notes?: string;
}

export interface SwitchAction {
  type: "switch";
  id: string;
  actor: BattleSide;
  pokemon?: PokemonState;
  targetSpecies?: string;
  setHpPercent?: number;
  ability?: string | null;
  item?: string | null;
  notes?: string;
}

export interface PassAction {
  type: "pass";
  id: string;
  actor: BattleSide;
  notes?: string;
}

export type BattleAction = MoveAction | SwitchAction | PassAction;

// Timeline
export interface TimelineTurn {
  id?: string;
  label?: string;
  order?: "player" | "opponent";
  turn: number;
  events?: BattleEvent[];
  actions?: BattleAction[];
}

export interface TimelineScenario {
  allowRaidStellar?: boolean;
  turns: TimelineTurn[];
}

export interface TimelineSnapshot {
  turn: number;
  eventId: string;
  hp: Record<BattleSide, number>;
  maxHP: Record<BattleSide, number>;
  probability: number;
  sequence?: number;
  description?: string;
  hpDistribution?: DistributionPoint[];
  opponentHpDistribution?: DistributionPoint[];
  damageRolls?: number[]; // 각 데미지 롤의 실제 데미지 값 (공격 이벤트의 경우)
  deltaHP?: Record<BattleSide, number>;
  maxHPBefore?: Record<BattleSide, number>;
}

// Distribution
export interface DistributionPoint {
  hp: number;
  probability: number;
}

// Simulation options
export type BattleStyle = "singles" | "doubles";

export interface SimulationOptions {
  allowRaidStellar?: boolean;
  maxBranches?: number;
  timeout?: number;
  includeOffensiveMultipliers?: boolean;
  includeDefensiveMultipliers?: boolean;
  timeoutMs?: number;
  batchSize?: number;
  battleStyle?: BattleStyle;
}

// EV Grid
export type EVPriorType = "uniform" | "meta" | "custom";

export interface EVPriorConfig {
  type: EVPriorType;
  customWeights?: Array<{ hpEV: number; defEV: number; weight: number }>;
  metaProfile?: string;
}

export interface EVGridConfig {
  enabled?: boolean;
  targetSide?: BattleSide; // 플레이어 또는 상대 중 어느 쪽에 적용할지
  hpRange: [number, number];
  defRange: [number, number];
  axisStep: number;
  atkRange?: [number, number];
  spaRange?: [number, number];
  offenseStep?: number;
  maxCombinedEV?: number;
  offenseMaxCombinedEV?: number;
  prior: EVPriorType | EVPriorConfig;
  priorParams?: {
    hpMean?: number;
    defMean?: number;
    hpSigma?: number;
    defSigma?: number;
    correlation?: number;
  };
  observationEventId?: string;
  observationPercent?: [number, number];
  targetSurvival?: number;
  // 플레이어 모드 기능 활성화
  enableSurvival?: boolean; // 생존 확률 목표 활성화
  enableKO?: boolean; // KO 확률 목표 활성화
  // 상대 모드 기능 활성화
  enableOpponentAtkRange?: boolean; // 상대 공격력 범위 활성화
  enableOpponentBulkRange?: boolean; // 상대 체력/방어 범위 활성화
  // 플레이어 모드 설정
  targetKO?: number; // 상대를 쓰러뜨릴 확률 목표 (0-1)
  // 상대 모드 설정
  opponentDamageFixed?: number; // 상대가 입힌 데미지 확정값 (%)
  opponentDamageRange?: [number, number]; // 상대가 입은 데미지 범위 (%)
}

export interface EVHeatmapCell {
  hpEV: number;
  defEV: number;
  survival: number;
  weight?: number;
  metric?: "survival" | "damageRange";
}

export interface EVPlan {
  hpEV: number;
  defEV: number;
  survival: number;
  investment: number;
  totalEV?: number;
  meetsTarget?: boolean;
}

export interface EVOffensePlan {
  atkEV: number;
  spaEV: number;
  koChance: number;
  totalEV: number;
  meetsTarget?: boolean;
}

export interface SensitivityMetrics {
  hpSensitivity: number;
  defSensitivity: number;
}

// Simulation worker types
export interface SimulationInput {
  requestId: string;
  scenario: TimelineScenario;
  pokemon: Record<BattleSide, PokemonState>;
  field: FieldState;
  options?: SimulationOptions;
  evConfig?: EVGridConfig;
  evGridConfig?: EVGridConfig;
  observationEventId?: string;
  observationRange?: [number, number];
}

export interface SimulationProgress {
  requestId?: string;
  processed: number;
  total: number;
  elapsedMs: number;
  phase?: "initializing" | "processing" | "finalizing" | "evaluating";
}

export interface SimulationSummary {
  survival: number;
  hpDistribution: DistributionPoint[];
  heatmap?: EVHeatmapCell[];
  topPlans?: EVPlan[];
  koChance?: number;
  koPlans?: EVOffensePlan[];
  sensitivity?: SensitivityMetrics;
  snapshots?: TimelineSnapshot[];
}

export interface SimulationComplete {
  requestId: string;
  summary: SimulationSummary;
}

export interface SimulationCancelled {
  requestId: string;
}

export type WorkerRequestMessage =
  | { type: "run"; payload: SimulationInput }
  | { type: "cancel"; payload: { requestId: string } };

export type WorkerResponseMessage =
  | { type: "progress"; payload: { requestId: string; progress: SimulationProgress } }
  | { type: "complete"; payload: SimulationComplete }
  | { type: "error"; payload: { requestId: string; error: string } }
  | { type: "cancelled"; payload: SimulationCancelled };

// Autocomplete suggestions
export interface AbilitySuggestion {
  id: number | string;
  name: string;
  names: Record<string, string>;
  shortEffect: string | null;
  effect: string | null;
  isHidden?: boolean;
}

export interface PokemonSuggestion {
  id: number;
  nationalDexNumber: number;
  baseSpeciesId: number | null;
  isDefaultForm: boolean | null;
  names: Record<string, string>;
  formNames: Record<string, string> | null;
  types: string[] | null;
  sprite: string;
  fallbackImage: string | null;
  slug: string;
  calcName: string;
  formIndex: number;
}

export interface ItemSuggestion {
  id: number;
  name: string;
  names: Record<string, string>;
  category: string | null;
  sprite: string;
  fallbackImage: string | null;
}

export interface MoveSuggestion {
  id: number;
  name: string;
  names: Record<string, string>;
  type: string;
  category: string | null;
  power: number | null;
  accuracy: number | null;
  pp: number | null;
  priority: number;
}

export type NatureStat = "atk" | "def" | "spa" | "spd" | "spe";

export interface NatureSuggestion {
  id: string;
  name: string;
  names: Record<string, string>;
  plus: NatureStat | null;
  minus: NatureStat | null;
}

export interface TeraTypeOption {
  id?: string;
  value: string;
  label?: string;
  labelKo: string;
  labelEn?: string;
}

// Re-export StatID and StatsTable for convenience
export type { StatID, StatsTable };
