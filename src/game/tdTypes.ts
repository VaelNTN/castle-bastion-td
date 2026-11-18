export type BaseTowerType = 'archer' | 'cannon' | 'frost' | 'lightning';

export type SpecTowerType =
  | 'sniper'
  | 'multishot'
  | 'venom'
  | 'mortar'
  | 'gatling'
  | 'inferno'
  | 'blizzard'
  | 'cryo'
  | 'chrono'
  | 'chain'
  | 'laser'
  | 'tesla';

export type TargetMode = 'first' | 'strongest' | 'closest';

export interface BaseTowerDef {
  type: BaseTowerType;
  name: string;
  emoji: string;
  cost: number;
  color: string;
  accent: string;
  range: number; // in tile units
  damage: number;
  fireRate: number; // shots per second
  splashRadius: number;
  slowFactor: number;
  chainCount: number;
  desc: string;
}

export interface SpecTowerDef {
  id: SpecTowerType;
  parent: BaseTowerType;
  name: string;
  emoji: string;
  cost: number;
  color: string;
  accent: string;
  damageMult: number;
  rangeMult: number;
  fireRateMult: number;
  splashRadius: number;
  slowFactor: number;
  freezeChance: number;
  poisonDpsRatio: number;
  chainCount: number;
  multiCount: number;
  auraBuff: number;
  desc: string;
}

export interface TowerInstance {
  id: number;
  col: number;
  row: number;
  x: number;
  y: number;
  baseType: BaseTowerType;
  specType: SpecTowerType | null;
  baseUpgrades: number; // 0..10
  specUpgrades: number; // 0..10 (unlocked after picking specialization)
  targetMode: TargetMode;
  totalSpent: number;
  kills: number;
  cooldown: number;
  angle: number;
  muzzleFlash: number;
  recoil: number;
  beamTargetId: number | null;
  beamRamp: number;
}

export type MonsterKind = 'slime' | 'goblin' | 'orc' | 'knight' | 'runner' | 'golem' | 'boss';

export interface MonsterInstance {
  id: number;
  kind: MonsterKind;
  x: number;
  y: number;
  pathIndex: number;
  progress: number;
  hp: number;
  maxHp: number;
  speed: number;
  armor: number;
  reward: number;
  castleDmg: number;
  radius: number;
  color: string;
  slowTimer: number;
  slowAmount: number;
  freezeTimer: number;
  poisonDps: number;
  poisonTimer: number;
  burnDps: number;
  burnTimer: number;
  hitFlash: number;
  wobbleOffset: number;
}

export type ProjectileVisualKind = 'arrow' | 'sniper' | 'venom' | 'cannon' | 'mortar' | 'inferno' | 'cryo';

export interface ProjectileInstance {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx: number;
  vy: number;
  targetId: number;
  speed: number;
  damage: number;
  color: string;
  radius: number;
  splashRadius: number;
  slowAmount: number;
  freezeChance: number;
  poisonDps: number;
  burnDps: number;
  isArrow: boolean;
  isCrit: boolean;
  kind: ProjectileVisualKind;
  towerId: number;
  life: number;
}

export interface VisualEffect {
  kind: 'ring' | 'lightning' | 'text' | 'spark';
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  gravity?: number;
  x2?: number;
  y2?: number;
  points?: { x: number; y: number }[];
  radius: number;
  maxRadius: number;
  color: string;
  text?: string;
  bold?: boolean;
  life: number;
  maxLife: number;
}
