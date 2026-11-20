import { soundFx } from './sound';
import { BASE_TOWERS, SPEC_TOWERS } from './tdCatalog';
import {
  BUILDABLE_SLOTS_COUNT,
  CASTLE_TILE,
  getPathNeighbors,
  GRID_COLS,
  GRID_ROWS,
  isPathTile,
  SPAWN_TILE,
  TILE_SIZE,
  WORLD_H,
  WORLD_W,
  WORLD_WAYPOINTS,
} from './tdMap';
import {
  BaseTowerType,
  MonsterInstance,
  MonsterKind,
  ProjectileInstance,
  ProjectileVisualKind,
  SpecTowerType,
  TargetMode,
  TowerInstance,
  VisualEffect,
} from './tdTypes';

interface PendingSpawn {
  kind: MonsterKind;
  delay: number;
  hpScale: number;
  speedScale: number;
  reward: number;
}

export interface TdUiSnapshot {
  gold: number;
  castleHp: number;
  castleMaxHp: number;
  castleFortifyLevel: number;
  castleRepairCost: number;
  castleFortifyCost: number;
  wave: number;
  kills: number;
  score: number;
  towerCount: number;
  maxTowers: number;
  activeMonsters: number;
  pendingSpawns: number;
  speedMult: 1 | 2 | 4;
  autoWave: boolean;
  started: boolean;
  paused: boolean;
  gameOver: boolean;
  buildTool: BaseTowerType | null;
  selectedTower: TowerInstance | null;
  previewTile: { col: number; row: number } | null;
  nextWaveCostBonus: number;
}

function hash2d(c: number, r: number, salt = 0): number {
  let n = Math.imul(c + 37, 374761393) + Math.imul(r + 17, 668265263) + Math.imul(salt + 11, 2147483647);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

export class CastleTdEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrainCache: HTMLCanvasElement | null = null;

  private towers: TowerInstance[] = [];
  private monsters: MonsterInstance[] = [];
  private projectiles: ProjectileInstance[] = [];
  private effects: VisualEffect[] = [];
  private spawnQueue: PendingSpawn[] = [];
  private spawnTimer = 0;

  private gold = 240;
  private castleHp = 100;
  private castleMaxHp = 100;
  private castleFortifyLevel = 0;
  private castleHitFlash = 0;
  private screenShake = 0;

  private wave = 0;
  private kills = 0;
  private score = 0;
  private nextEntityId = 1;

  private speedMult: 1 | 2 | 4 = 1;
  private autoWave = true;
  private autoWaveCountdown = 2.5;
  private started = false;
  private paused = false;
  private gameOver = false;

  private buildTool: BaseTowerType | null = 'archer';
  private selectedTowerId: number | null = null;
  private hoverTile: { col: number; row: number } | null = null;
  private previewTile: { col: number; row: number } | null = null;

  private rafId = 0;
  private running = false;
  private lastTs = 0;
  private animTime = 0;
  private lastHudPush = 0;
  private lastGoldPopupAt = 0;
  private onHudUpdate: (snap: TdUiSnapshot) => void;
  private onGameOverCallback?: (wave: number, kills: number, score: number) => void;

  // Render mapping from CSS pixels to world space
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private boundResize = (): void => {
    this.syncCanvasMetrics();
  };
  private boundOrientation = (): void => {
    window.setTimeout(() => this.syncCanvasMetrics(), 90);
  };
  private boundVisibility = (): void => {
    if (!document.hidden) {
      this.lastTs = performance.now();
    }
  };

  constructor(
    canvas: HTMLCanvasElement,
    onHudUpdate: (snap: TdUiSnapshot) => void,
    onGameOver?: (wave: number, kills: number, score: number) => void
  ) {
    this.canvas = canvas;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('2D context unavailable');
    this.ctx = c;
    this.onHudUpdate = onHudUpdate;
    this.onGameOverCallback = onGameOver;
  }

  private syncCanvasMetrics(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    this.dpr = dpr;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.scale = Math.min(rect.width / WORLD_W, rect.height / WORLD_H);
    this.offsetX = (rect.width - WORLD_W * this.scale) * 0.5;
    this.offsetY = (rect.height - WORLD_H * this.scale) * 0.5;
  }

  start(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.running = true;
    this.syncCanvasMetrics();
    window.addEventListener('resize', this.boundResize);
    window.addEventListener('orientationchange', this.boundOrientation);
    document.addEventListener('visibilitychange', this.boundVisibility);

    this.lastTs = performance.now();
    this.pushHud(true);
    const loop = (ts: number): void => {
      if (!this.running) return;
      const rawDt = Math.min(0.05, Math.max(0.001, (ts - this.lastTs) / 1000));
      this.lastTs = ts;
      this.update(rawDt);
      this.render();
      if (ts - this.lastHudPush > 90) {
        this.lastHudPush = ts;
        this.pushHud(false);
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    window.removeEventListener('resize', this.boundResize);
    window.removeEventListener('orientationchange', this.boundOrientation);
    document.removeEventListener('visibilitychange', this.boundVisibility);
    soundFx.clearPending();
  }

  resetGame(autoStart = true): void {
    this.towers = [];
    this.monsters = [];
    this.projectiles = [];
    this.effects = [];
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.gold = 240;
    this.castleHp = 100;
    this.castleMaxHp = 100;
    this.castleFortifyLevel = 0;
    this.castleHitFlash = 0;
    this.screenShake = 0;
    this.wave = 0;
    this.kills = 0;
    this.score = 0;
    this.autoWaveCountdown = 2.5;
    this.started = autoStart;
    this.paused = false;
    this.gameOver = false;
    this.selectedTowerId = null;
    this.buildTool = 'archer';
    this.hoverTile = null;
    this.previewTile = null;
    this.pushHud(true);
  }

  startDefense(): void {
    if (this.started) return;
    this.started = true;
    this.paused = false;
    this.autoWaveCountdown = 2.5;
    this.lastTs = performance.now();
    this.pushHud(true);
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!paused) {
      this.lastTs = performance.now();
    }
    this.pushHud(true);
  }

  isPaused(): boolean {
    return this.paused;
  }

  setBuildTool(tool: BaseTowerType | null): void {
    this.buildTool = tool;
    this.previewTile = null;
    if (tool !== null) this.selectedTowerId = null;
    this.pushHud(true);
  }

  setSpeedMult(mult: 1 | 2 | 4): void {
    this.speedMult = mult;
    this.pushHud(true);
  }

  setAutoWave(enabled: boolean): void {
    this.autoWave = enabled;
    this.pushHud(true);
  }

  selectTower(id: number | null): void {
    this.selectedTowerId = id;
    this.previewTile = null;
    if (id !== null) this.buildTool = null;
    this.pushHud(true);
  }

  getSelectedTower(): TowerInstance | null {
    if (this.selectedTowerId === null) return null;
    return this.towers.find((t) => t.id === this.selectedTowerId) ?? null;
  }

  getUpgradeCost(tower: TowerInstance): number {
    if (tower.baseUpgrades < 10) {
      const baseCost = BASE_TOWERS[tower.baseType].cost;
      return Math.round(baseCost * (0.48 + tower.baseUpgrades * 0.24));
    }
    if (tower.specType && tower.specUpgrades < 10) {
      const specCost = SPEC_TOWERS[tower.specType].cost;
      return Math.round(specCost * (0.42 + tower.specUpgrades * 0.28));
    }
    return 0;
  }

  getTowerStats(tower: TowerInstance): {
    damage: number;
    rangePx: number;
    fireRate: number;
    splashPx: number;
    slowAmount: number;
    freezeChance: number;
    poisonDps: number;
    chainCount: number;
    multiCount: number;
    color: string;
    accent: string;
    title: string;
    emoji: string;
  } {
    const base = BASE_TOWERS[tower.baseType];
    const baseScaleDmg = Math.pow(1.22, tower.baseUpgrades);
    const baseScaleRate = 1 + tower.baseUpgrades * 0.055;
    const baseScaleRange = 1 + tower.baseUpgrades * 0.035;

    let auraSpeedBonus = 0;
    for (const other of this.towers) {
      if (other.id !== tower.id && other.specType === 'chrono') {
        const d = Math.hypot(other.x - tower.x, other.y - tower.y);
        if (d <= TILE_SIZE * 2.8) {
          auraSpeedBonus = Math.max(auraSpeedBonus, 0.28 + other.specUpgrades * 0.025);
        }
      }
    }

    if (!tower.specType) {
      return {
        damage: Math.round(base.damage * baseScaleDmg),
        rangePx: base.range * baseScaleRange * TILE_SIZE,
        fireRate: base.fireRate * baseScaleRate * (1 + auraSpeedBonus),
        splashPx: base.splashRadius * TILE_SIZE,
        slowAmount: base.slowFactor,
        freezeChance: 0,
        poisonDps: 0,
        chainCount: base.chainCount,
        multiCount: 1,
        color: base.color,
        accent: base.accent,
        title: base.name,
        emoji: base.emoji,
      };
    }

    const spec = SPEC_TOWERS[tower.specType];
    const specDmgScale = Math.pow(1.25, tower.specUpgrades);
    const specRateScale = 1 + tower.specUpgrades * 0.065;
    const specRangeScale = 1 + tower.specUpgrades * 0.03;

    const damage = Math.round(base.damage * baseScaleDmg * spec.damageMult * specDmgScale);
    return {
      damage,
      rangePx: base.range * baseScaleRange * spec.rangeMult * specRangeScale * TILE_SIZE,
      fireRate: base.fireRate * baseScaleRate * spec.fireRateMult * specRateScale * (1 + auraSpeedBonus),
      splashPx: spec.splashRadius * (1 + tower.specUpgrades * 0.03) * TILE_SIZE,
      slowAmount: Math.min(0.78, spec.slowFactor + tower.specUpgrades * 0.012),
      freezeChance: Math.min(0.72, spec.freezeChance + (spec.freezeChance > 0 ? tower.specUpgrades * 0.015 : 0)),
      poisonDps: spec.poisonDpsRatio > 0 ? Math.round(damage * spec.poisonDpsRatio * 0.5) : 0,
      chainCount: spec.chainCount > 0 ? spec.chainCount + Math.floor(tower.specUpgrades / 3) : 0,
      multiCount: spec.multiCount > 1 ? spec.multiCount + Math.floor(tower.specUpgrades / 4) : 1,
      color: spec.color,
      accent: spec.accent,
      title: spec.name,
      emoji: spec.emoji,
    };
  }

  private screenToTile(clientX: number, clientY: number): { col: number; row: number } | null {
    if (!(this.scale > 0 && Number.isFinite(this.scale))) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const wx = (clientX - rect.left - this.offsetX) / this.scale;
    const wy = (clientY - rect.top - this.offsetY) / this.scale;
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
    return { col, row };
  }

  handleCanvasHover(clientX: number, clientY: number): void {
    this.hoverTile = this.screenToTile(clientX, clientY);
  }

  clearHover(): void {
    this.hoverTile = null;
  }

  handleTouchPreview(clientX: number, clientY: number): void {
    if (!this.started || this.paused || this.gameOver || !this.buildTool) return;
    const tile = this.screenToTile(clientX, clientY);
    if (!tile || isPathTile(tile.col, tile.row)) {
      this.previewTile = null;
      return;
    }
    const existing = this.towers.find((t) => t.col === tile.col && t.row === tile.row);
    if (existing) {
      this.previewTile = null;
      return;
    }
    this.previewTile = tile;
  }

  clearPreview(): void {
    if (this.previewTile !== null) {
      this.previewTile = null;
      this.pushHud(true);
    }
  }

  confirmPreviewBuild(): void {
    if (!this.previewTile || !this.buildTool || this.gameOver || !this.started) return;
    this.placeTowerAt(this.previewTile.col, this.previewTile.row);
  }

  handleCanvasTap(clientX: number, clientY: number, isTouch = false): void {
    if (!this.started || this.paused || this.gameOver) return;
    const tile = this.screenToTile(clientX, clientY);
    if (!tile) return;
    const { col, row } = tile;

    const existing = this.towers.find((t) => t.col === col && t.row === row);
    if (existing) {
      this.previewTile = null;
      this.selectedTowerId = existing.id;
      this.pushHud(true);
      return;
    }

    if (isPathTile(col, row) || !this.buildTool) {
      this.previewTile = null;
      this.selectedTowerId = null;
      this.pushHud(true);
      return;
    }

    // On touch devices, first tap previews range & placement; second tap on the same tile confirms build!
    if (isTouch) {
      if (!this.previewTile || this.previewTile.col !== col || this.previewTile.row !== row) {
        this.selectedTowerId = null;
        this.previewTile = { col, row };
        this.pushHud(true);
        return;
      }
    }

    this.placeTowerAt(col, row);
  }

  private placeTowerAt(col: number, row: number): void {
    if (!this.buildTool || isPathTile(col, row)) return;
    if (this.towers.some((t) => t.col === col && t.row === row)) return;

    const def = BASE_TOWERS[this.buildTool];
    if (this.gold < def.cost) {
      this.previewTile = null;
      this.pushEffect({
        kind: 'text',
        x: (col + 0.5) * TILE_SIZE,
        y: (row + 0.4) * TILE_SIZE,
        radius: 0,
        maxRadius: 0,
        color: '#f87171',
        text: `Need ${def.cost}g`,
        bold: true,
        life: 0.9,
        maxLife: 0.9,
      });
      this.pushHud(true);
      return;
    }

    this.gold -= def.cost;
    this.previewTile = null;
    const tower: TowerInstance = {
      id: this.nextEntityId++,
      col,
      row,
      x: (col + 0.5) * TILE_SIZE,
      y: (row + 0.5) * TILE_SIZE,
      baseType: this.buildTool,
      specType: null,
      baseUpgrades: 0,
      specUpgrades: 0,
      targetMode: 'first',
      totalSpent: def.cost,
      kills: 0,
      cooldown: 0,
      angle: -Math.PI / 2,
      muzzleFlash: 0,
      recoil: 0,
      beamTargetId: null,
      beamRamp: 0,
    };
    this.towers.push(tower);
    this.pushEffect({
      kind: 'ring',
      x: tower.x,
      y: tower.y,
      radius: 8,
      maxRadius: TILE_SIZE * 0.78,
      color: def.color,
      life: 0.34,
      maxLife: 0.34,
    });
    this.spawnSparks(tower.x, tower.y, def.accent, 8, 95);
    soundFx.place();
    this.pushHud(true);
  }

  upgradeSelectedTower(times = 1): boolean {
    const tower = this.getSelectedTower();
    if (!tower) return false;
    let didAny = false;
    for (let i = 0; i < times; i++) {
      const canBase = tower.baseUpgrades < 10;
      const canSpec = tower.baseUpgrades === 10 && tower.specType !== null && tower.specUpgrades < 10;
      if (!canBase && !canSpec) break;
      const cost = this.getUpgradeCost(tower);
      if (cost <= 0 || this.gold < cost) break;
      this.gold -= cost;
      tower.totalSpent += cost;
      if (canBase) tower.baseUpgrades++;
      else tower.specUpgrades++;
      didAny = true;
    }
    if (didAny) {
      soundFx.upgrade(false);
      this.pushEffect({
        kind: 'ring',
        x: tower.x,
        y: tower.y,
        radius: 10,
        maxRadius: TILE_SIZE * 0.98,
        color: '#facc15',
        life: 0.38,
        maxLife: 0.38,
      });
      this.spawnSparks(tower.x, tower.y, '#fef08a', 10, 120);
      this.pushHud(true);
    }
    return didAny;
  }

  specializeSelectedTower(specId: SpecTowerType): boolean {
    const tower = this.getSelectedTower();
    if (!tower || tower.baseUpgrades < 10 || tower.specType !== null) return false;
    const spec = SPEC_TOWERS[specId];
    if (!spec || spec.parent !== tower.baseType) return false;
    if (this.gold < spec.cost) return false;

    this.gold -= spec.cost;
    tower.totalSpent += spec.cost;
    tower.specType = specId;
    tower.specUpgrades = 0;
    soundFx.upgrade(true);
    this.pushEffect({
      kind: 'ring',
      x: tower.x,
      y: tower.y,
      radius: 12,
      maxRadius: TILE_SIZE * 1.45,
      color: spec.color,
      life: 0.52,
      maxLife: 0.52,
    });
    this.spawnSparks(tower.x, tower.y, spec.accent, 16, 150);
    this.pushHud(true);
    return true;
  }

  cycleSelectedTargetMode(): void {
    const tower = this.getSelectedTower();
    if (!tower) return;
    const order: TargetMode[] = ['first', 'strongest', 'closest'];
    tower.targetMode = order[(order.indexOf(tower.targetMode) + 1) % order.length];
    this.pushHud(true);
  }

  sellSelectedTower(): void {
    const tower = this.getSelectedTower();
    if (!tower) return;
    const refund = Math.round(tower.totalSpent * 0.72);
    this.gold += refund;
    this.towers = this.towers.filter((t) => t.id !== tower.id);
    this.selectedTowerId = null;
    this.pushEffect({
      kind: 'text',
      x: tower.x,
      y: tower.y,
      radius: 0,
      maxRadius: 0,
      color: '#fde047',
      text: `+${refund}g`,
      bold: true,
      life: 0.9,
      maxLife: 0.9,
    });
    this.spawnSparks(tower.x, tower.y, '#facc15', 8, 85);
    this.pushHud(true);
  }

  repairCastle(): void {
    const cost = this.getCastleRepairCost();
    if (this.castleHp >= this.castleMaxHp || this.gold < cost) return;
    this.gold -= cost;
    this.castleHp = Math.min(this.castleMaxHp, this.castleHp + 35);
    soundFx.upgrade(false);
    this.pushEffect({
      kind: 'text',
      x: (CASTLE_TILE.col + 0.5) * TILE_SIZE,
      y: (CASTLE_TILE.row - 0.3) * TILE_SIZE,
      radius: 0,
      maxRadius: 0,
      color: '#4ade80',
      text: '+35 HP',
      bold: true,
      life: 0.95,
      maxLife: 0.95,
    });
    this.pushHud(true);
  }

  fortifyCastle(): void {
    const cost = this.getCastleFortifyCost();
    if (this.gold < cost) return;
    this.gold -= cost;
    this.castleFortifyLevel++;
    this.castleMaxHp += 40;
    this.castleHp += 40;
    soundFx.upgrade(true);
    this.pushEffect({
      kind: 'ring',
      x: (CASTLE_TILE.col + 0.5) * TILE_SIZE,
      y: (CASTLE_TILE.row + 0.5) * TILE_SIZE,
      radius: 16,
      maxRadius: TILE_SIZE * 1.4,
      color: '#38bdf8',
      life: 0.5,
      maxLife: 0.5,
    });
    this.pushHud(true);
  }

  getCastleRepairCost(): number {
    return 75 + this.castleFortifyLevel * 15;
  }

  getCastleFortifyCost(): number {
    return 140 + this.castleFortifyLevel * 95;
  }

  sendNextWaveEarly(): void {
    if (!this.started || this.paused || this.gameOver) return;
    if (this.spawnQueue.length > 600) {
      this.pushEffect({
        kind: 'text',
        x: (SPAWN_TILE.col + 1.4) * TILE_SIZE,
        y: (SPAWN_TILE.row + 0.8) * TILE_SIZE,
        radius: 0,
        maxRadius: 0,
        color: '#fca5a5',
        text: 'Wave Queue Full!',
        bold: true,
        life: 0.85,
        maxLife: 0.85,
      });
      return;
    }
    const earlyBonus = this.spawnQueue.length > 0 || this.monsters.length > 0 ? 35 + this.wave * 6 : 0;
    if (earlyBonus > 0) {
      this.gold += earlyBonus;
      this.pushEffect({
        kind: 'text',
        x: (SPAWN_TILE.col + 1.2) * TILE_SIZE,
        y: (SPAWN_TILE.row + 0.8) * TILE_SIZE,
        radius: 0,
        maxRadius: 0,
        color: '#facc15',
        text: `⚡ +${earlyBonus}g`,
        bold: true,
        life: 1.0,
        maxLife: 1.0,
      });
    }
    this.triggerNextWave();
  }

  private pushEffect(e: VisualEffect): void {
    if (this.effects.length >= 220) {
      this.effects.shift();
    }
    this.effects.push(e);
  }

  private spawnSparks(x: number, y: number, color: string, count: number, speed = 110): void {
    if (this.effects.length > 195) return;
    const n = Math.min(count, 16);
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + (Math.random() - 0.5) * 0.5;
      const sp = speed * (0.45 + Math.random() * 0.7);
      const life = 0.24 + Math.random() * 0.24;
      this.pushEffect({
        kind: 'spark',
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        gravity: 130,
        radius: 1.8 + Math.random() * 2.2,
        maxRadius: 0,
        color,
        life,
        maxLife: life,
      });
    }
  }

  private triggerNextWave(): void {
    this.wave++;
    this.autoWaveCountdown = 3.2;
    soundFx.waveStart();

    // Scale rapidly so players face genuine 100s of monsters & infinite escalation!
    const w = this.wave;
    const count =
      w <= 3
        ? 14 + w * 8
        : w <= 7
          ? 42 + (w - 3) * 16
          : Math.min(480, 105 + (w - 7) * 26);

    const hpScale = Math.pow(1.19, w - 1) * (1 + Math.floor(w / 10) * 0.4);
    const speedScale = Math.min(2.15, 1 + w * 0.018);

    const waveSpawns: PendingSpawn[] = [];
    const baseGap = w >= 10 ? 0.075 : Math.max(0.11, 0.36 - w * 0.025);

    for (let i = 0; i < count; i++) {
      let kind: MonsterKind = 'slime';
      const r = Math.random();
      if (w >= 2 && r > 0.62) kind = 'goblin';
      if (w >= 4 && r > 0.72) kind = 'runner';
      if (w >= 5 && r > 0.78) kind = 'orc';
      if (w >= 7 && r > 0.86) kind = 'knight';
      if (w >= 10 && r > 0.93) kind = 'golem';

      if (i === count - 1 && w % 5 === 0) {
        kind = 'boss';
      } else if (w >= 12 && i % 45 === 44) {
        kind = 'boss';
      }

      const reward = Math.max(2, Math.round((kind === 'boss' ? 45 : 4.2) + w * 0.45));
      waveSpawns.push({
        kind,
        delay: i === 0 ? 0.05 : baseGap * (kind === 'runner' ? 0.65 : 1),
        hpScale,
        speedScale,
        reward,
      });
    }

    this.spawnQueue.push(...waveSpawns);
    this.pushHud(true);
  }

  private spawnMonster(sp: PendingSpawn): void {
    const start = WORLD_WAYPOINTS[0];
    const baseSpecs: Record<
      MonsterKind,
      { hp: number; speed: number; armor: number; dmg: number; radius: number; color: string }
    > = {
      slime: { hp: 38, speed: 62, armor: 0, dmg: 2, radius: 10, color: '#4ade80' },
      goblin: { hp: 56, speed: 78, armor: 1, dmg: 3, radius: 11, color: '#a3e635' },
      runner: { hp: 42, speed: 120, armor: 0, dmg: 3, radius: 9.5, color: '#fbbf24' },
      orc: { hp: 135, speed: 56, armor: 3, dmg: 5, radius: 14, color: '#fb7185' },
      knight: { hp: 220, speed: 50, armor: 9, dmg: 8, radius: 15, color: '#94a3b8' },
      golem: { hp: 420, speed: 42, armor: 14, dmg: 12, radius: 17, color: '#f97316' },
      boss: { hp: 1450, speed: 38, armor: 16, dmg: 25, radius: 22, color: '#c026d3' },
    };

    const spec = baseSpecs[sp.kind];
    const maxHp = Math.max(1, Math.round(spec.hp * sp.hpScale));

    this.monsters.push({
      id: this.nextEntityId++,
      kind: sp.kind,
      x: start.x + (Math.random() - 0.5) * 10,
      y: start.y - 10,
      pathIndex: 0,
      progress: 0,
      hp: maxHp,
      maxHp,
      speed: spec.speed * sp.speedScale,
      armor: spec.armor + Math.floor(this.wave / 6),
      reward: sp.reward,
      castleDmg: spec.dmg,
      radius: spec.radius,
      color: spec.color,
      slowTimer: 0,
      slowAmount: 0,
      freezeTimer: 0,
      poisonDps: 0,
      poisonTimer: 0,
      burnDps: 0,
      burnTimer: 0,
      hitFlash: 0,
      wobbleOffset: Math.random() * Math.PI * 2,
    });
  }

  private update(rawDt: number): void {
    if (!this.started) {
      // Gentle ambient animation on title overlay without launching waves
      this.animTime += rawDt;
      return;
    }
    if (this.paused) return;

    const dt = rawDt * this.speedMult;
    this.animTime += dt;
    if (this.castleHitFlash > 0) this.castleHitFlash = Math.max(0, this.castleHitFlash - rawDt * 2.5);
    if (this.screenShake > 0) this.screenShake = Math.max(0, this.screenShake - rawDt * 3.4);

    if (this.gameOver) return;

    // Auto-wave trigger
    if (this.wave === 0 || (this.autoWave && this.spawnQueue.length === 0 && this.monsters.length === 0)) {
      this.autoWaveCountdown -= dt;
      if (this.autoWaveCountdown <= 0) {
        this.triggerNextWave();
      }
    }

    // Spawn queue processing (supports bursting 100s smoothly!)
    if (this.spawnQueue.length > 0) {
      this.spawnTimer -= dt;
      let guard = 0;
      while (this.spawnQueue.length > 0 && this.spawnTimer <= 0 && guard < 12) {
        const next = this.spawnQueue.shift()!;
        this.spawnMonster(next);
        this.spawnTimer += this.spawnQueue[0]?.delay ?? 0.1;
        guard++;
      }
    }

    // Update monsters
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      const m = this.monsters[i];
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - rawDt * 5.5);

      if (m.poisonTimer > 0) {
        m.poisonTimer -= dt;
        m.hp -= m.poisonDps * dt;
      }
      if (m.burnTimer > 0) {
        m.burnTimer -= dt;
        m.hp -= m.burnDps * dt;
      }

      if (m.hp <= 0) {
        this.handleMonsterDeath(m);
        this.monsters.splice(i, 1);
        continue;
      }

      if (m.freezeTimer > 0) {
        m.freezeTimer -= dt;
        continue;
      }

      let moveMult = 1;
      if (m.slowTimer > 0) {
        m.slowTimer -= dt;
        moveMult = Math.max(0.22, 1 - m.slowAmount);
      }

      let moveDist = m.speed * moveMult * dt;
      while (moveDist > 0 && m.pathIndex < WORLD_WAYPOINTS.length - 1) {
        const target = WORLD_WAYPOINTS[m.pathIndex + 1];
        const dx = target.x - m.x;
        const dy = target.y - m.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= moveDist) {
          m.x = target.x;
          m.y = target.y;
          m.pathIndex++;
          m.progress = m.pathIndex;
          moveDist -= dist;
        } else if (dist > 0.0001) {
          m.x += (dx / dist) * moveDist;
          m.y += (dy / dist) * moveDist;
          m.progress = m.pathIndex + (1 - dist / Math.max(1, TILE_SIZE * 8));
          moveDist = 0;
        } else {
          break;
        }
      }

      if (m.pathIndex >= WORLD_WAYPOINTS.length - 1) {
        // Reached castle!
        this.castleHp = Math.max(0, this.castleHp - m.castleDmg);
        this.castleHitFlash = 1;
        this.screenShake = Math.min(1, this.screenShake + 0.45 + Math.min(0.45, m.castleDmg * 0.025));
        soundFx.castleHit();
        this.pushEffect({
          kind: 'text',
          x: (CASTLE_TILE.col + 0.5) * TILE_SIZE,
          y: CASTLE_TILE.row * TILE_SIZE,
          radius: 0,
          maxRadius: 0,
          color: '#ef4444',
          text: `-${m.castleDmg} ❤️`,
          bold: true,
          life: 0.95,
          maxLife: 0.95,
        });
        this.spawnSparks((CASTLE_TILE.col + 0.5) * TILE_SIZE, (CASTLE_TILE.row + 0.3) * TILE_SIZE, '#f87171', 8, 120);
        this.monsters.splice(i, 1);
        if (this.castleHp <= 0) {
          this.gameOver = true;
          this.pushHud(true);
          this.onGameOverCallback?.(this.wave, this.kills, this.score);
          return;
        }
      }
    }

    // Update towers
    for (const tower of this.towers) {
      if (tower.muzzleFlash > 0) tower.muzzleFlash = Math.max(0, tower.muzzleFlash - rawDt * 6.5);
      if (tower.recoil > 0) tower.recoil = Math.max(0, tower.recoil - rawDt * 7.5);
      tower.cooldown -= dt;
      if (tower.cooldown > 0) continue;

      const stats = this.getTowerStats(tower);
      const targets = this.findTargets(tower, stats.rangePx, stats.multiCount);
      if (targets.length === 0) {
        tower.beamTargetId = null;
        tower.beamRamp = 0;
        continue;
      }

      const primary = targets[0];
      tower.angle = Math.atan2(primary.y - tower.y, primary.x - tower.x);
      tower.cooldown = 1 / Math.max(0.15, stats.fireRate);
      tower.muzzleFlash = 1;
      tower.recoil = 1;

      if (tower.specType === 'laser') {
        if (tower.beamTargetId === primary.id) {
          tower.beamRamp = Math.min(4.5, tower.beamRamp + 0.35);
        } else {
          tower.beamTargetId = primary.id;
          tower.beamRamp = 1;
        }
        const dmg = Math.round(stats.damage * tower.beamRamp);
        this.applyDamage(primary, dmg, tower, true);
        this.pushEffect({
          kind: 'lightning',
          points: [
            { x: tower.x + Math.cos(tower.angle) * 14, y: tower.y + Math.sin(tower.angle) * 14 },
            { x: primary.x, y: primary.y },
          ],
          x: tower.x,
          y: tower.y,
          radius: Math.min(5.5, 2.2 + tower.beamRamp * 0.7),
          maxRadius: 4,
          color: stats.color,
          life: 0.14,
          maxLife: 0.14,
        });
        this.spawnSparks(primary.x, primary.y, '#fbcfe8', 3, 75);
      } else if (tower.specType === 'blizzard' || tower.specType === 'chrono' || (tower.baseType === 'frost' && tower.specType !== 'cryo')) {
        // AoE frost / blizzard / chrono pulse around tower
        this.pushEffect({
          kind: 'ring',
          x: tower.x,
          y: tower.y,
          radius: 16,
          maxRadius: stats.rangePx,
          color: stats.color,
          life: 0.3,
          maxLife: 0.3,
        });
        const hitRadius = Math.max(stats.rangePx, stats.splashPx);
        for (const m of this.monsters) {
          if (Math.hypot(m.x - tower.x, m.y - tower.y) <= hitRadius) {
            this.applyDamage(m, stats.damage, tower, false);
            m.slowAmount = Math.max(m.slowAmount, stats.slowAmount);
            m.slowTimer = Math.max(m.slowTimer, 2.4);
            if (stats.freezeChance > 0 && m.kind !== 'boss' && Math.random() < stats.freezeChance) {
              m.freezeTimer = Math.max(m.freezeTimer, 1.35);
            }
          }
        }
      } else if (stats.chainCount > 0) {
        // Instant chain lightning!
        soundFx.zap();
        const muzzleX = tower.x + Math.cos(tower.angle) * 12;
        const muzzleY = tower.y + Math.sin(tower.angle) * 12;
        const pts: { x: number; y: number }[] = [{ x: muzzleX, y: muzzleY }];
        const hitSet = new Set<number>();
        let currTarget: MonsterInstance | null = primary;
        let dmg = stats.damage;

        for (let c = 0; c < stats.chainCount && currTarget; c++) {
          hitSet.add(currTarget.id);
          pts.push({ x: currTarget.x, y: currTarget.y });
          this.applyDamage(currTarget, Math.round(dmg), tower, false);
          if (stats.slowAmount > 0) {
            currTarget.slowAmount = Math.max(currTarget.slowAmount, stats.slowAmount);
            currTarget.slowTimer = Math.max(currTarget.slowTimer, 1.2);
          }
          if (stats.freezeChance > 0 && currTarget.kind !== 'boss' && Math.random() < stats.freezeChance) {
            currTarget.freezeTimer = Math.max(currTarget.freezeTimer, 0.55);
          }

          // Tesla splash around hit
          if (stats.splashPx > 0) {
            for (const near of this.monsters) {
              if (
                near.id !== currTarget.id &&
                Math.hypot(near.x - currTarget.x, near.y - currTarget.y) <= stats.splashPx * 0.65
              ) {
                this.applyDamage(near, Math.round(dmg * 0.45), tower, false);
              }
            }
          }

          let nextBest: MonsterInstance | null = null;
          let nextDist = TILE_SIZE * 2.8;
          for (const cand of this.monsters) {
            if (hitSet.has(cand.id) || cand.hp <= 0) continue;
            const d = Math.hypot(cand.x - currTarget.x, cand.y - currTarget.y);
            if (d < nextDist) {
              nextDist = d;
              nextBest = cand;
            }
          }
          currTarget = nextBest;
          dmg *= 0.86;
        }

        this.pushEffect({
          kind: 'lightning',
          points: pts,
          x: tower.x,
          y: tower.y,
          radius: 2.2,
          maxRadius: 2.2,
          color: stats.color,
          life: 0.18,
          maxLife: 0.18,
        });
      } else {
        // Projectiles (single, multi-shot, cryo rays, cannon, mortar, inferno)
        const projKind: ProjectileVisualKind =
          tower.specType === 'sniper'
            ? 'sniper'
            : tower.specType === 'venom'
              ? 'venom'
              : tower.specType === 'mortar'
                ? 'mortar'
                : tower.specType === 'inferno'
                  ? 'inferno'
                  : tower.specType === 'cryo'
                    ? 'cryo'
                    : tower.baseType === 'cannon'
                      ? 'cannon'
                      : 'arrow';

        for (const tgt of targets) {
          const isCrit = tower.specType === 'sniper' && Math.random() < 0.35;
          const speed =
            tower.specType === 'sniper'
              ? 640
              : tower.specType === 'cryo'
                ? 440
                : tower.baseType === 'archer'
                  ? 470
                  : 345;
          const dx = tgt.x - tower.x;
          const dy = tgt.y - tower.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          const sx = tower.x + (dx / dist) * 14;
          const sy = tower.y + (dy / dist) * 14;
          if (this.projectiles.length >= 260) {
            this.projectiles.shift();
          }
          this.projectiles.push({
            x: sx,
            y: sy,
            prevX: sx,
            prevY: sy,
            vx: (dx / dist) * speed,
            vy: (dy / dist) * speed,
            targetId: tgt.id,
            targetX: tgt.x,
            targetY: tgt.y,
            speed,
            damage: isCrit ? Math.round(stats.damage * 2.1) : stats.damage,
            color: stats.color,
            radius: projKind === 'mortar' ? 6.8 : tower.baseType === 'cannon' ? 5.2 : projKind === 'cryo' ? 4.6 : 3.8,
            splashRadius: stats.splashPx,
            slowAmount: stats.slowAmount,
            freezeChance: stats.freezeChance,
            poisonDps: tower.specType === 'venom' ? stats.poisonDps : 0,
            burnDps: tower.specType === 'inferno' ? stats.poisonDps : 0,
            isArrow: tower.baseType === 'archer',
            isCrit,
            kind: projKind,
            towerId: tower.id,
            life: 1.6,
          });
        }
      }
    }

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      if (p.life <= 0 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        this.projectiles.splice(i, 1);
        continue;
      }

      p.prevX = p.x;
      p.prevY = p.y;

      const tgt = this.monsters.find((m) => m.id === p.targetId && m.hp > 0) ?? null;
      if (tgt) {
        p.targetX = tgt.x;
        p.targetY = tgt.y;
      }

      const dx = p.targetX - p.x;
      const dy = p.targetY - p.y;
      const d = Math.hypot(dx, dy);
      if (!Number.isFinite(d)) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const hitThreshold = p.speed * dt + (tgt ? tgt.radius + 4 : 6);
      if (d <= hitThreshold) {
        this.detonateProjectile(p, tgt, p.targetX, p.targetY);
        this.projectiles.splice(i, 1);
        continue;
      }

      if (d > 0.001) {
        p.vx = (dx / d) * p.speed;
        p.vy = (dy / d) * p.speed;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // Prune dead monsters killed by tower hits this frame
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      if (this.monsters[i].hp <= 0) {
        this.handleMonsterDeath(this.monsters[i]);
        this.monsters.splice(i, 1);
      }
    }

    // Update effects (rings, lightning, sparks, text)
    if (this.effects.length > 220) {
      this.effects.splice(0, this.effects.length - 220);
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= rawDt;
      if (e.life <= 0) {
        this.effects.splice(i, 1);
        continue;
      }
      if (e.kind === 'spark' && e.vx !== undefined && e.vy !== undefined) {
        e.x += e.vx * rawDt;
        e.y += e.vy * rawDt;
        e.vy += (e.gravity ?? 0) * rawDt;
        e.vx *= 0.96;
      }
    }
  }

  private detonateProjectile(
    p: ProjectileInstance,
    directTarget: MonsterInstance | null,
    impactX: number,
    impactY: number
  ): void {
    const owner = this.towers.find((t) => t.id === p.towerId) ?? null;

    if (p.splashRadius > 0) {
      if (p.kind === 'cannon' || p.kind === 'mortar' || p.kind === 'inferno') {
        soundFx.boom();
      }
      this.pushEffect({
        kind: 'ring',
        x: impactX,
        y: impactY,
        radius: 6,
        maxRadius: p.splashRadius,
        color: p.color,
        life: 0.26,
        maxLife: 0.26,
      });
      this.spawnSparks(
        impactX,
        impactY,
        p.kind === 'cryo' ? '#a5f3fc' : p.kind === 'venom' ? '#bef264' : '#fde047',
        p.kind === 'mortar' ? 10 : 6,
        p.kind === 'mortar' ? 140 : 95
      );

      for (const m of this.monsters) {
        if (m.hp <= 0) continue;
        const d = Math.hypot(m.x - impactX, m.y - impactY);
        if (d <= p.splashRadius + m.radius) {
          const falloff = d <= p.splashRadius * 0.4 ? 1 : 0.72;
          this.applyDamage(m, Math.round(p.damage * falloff), owner, false);
          if (p.slowAmount > 0) {
            m.slowAmount = Math.max(m.slowAmount, p.slowAmount);
            m.slowTimer = Math.max(m.slowTimer, 2.5);
          }
          if (p.freezeChance > 0 && m.kind !== 'boss' && Math.random() < p.freezeChance) {
            m.freezeTimer = Math.max(m.freezeTimer, 1.25);
          }
          if (p.poisonDps > 0) {
            m.poisonDps = Math.max(m.poisonDps, p.poisonDps);
            m.poisonTimer = 4.0;
          }
          if (p.burnDps > 0) {
            m.burnDps = Math.max(m.burnDps, p.burnDps);
            m.burnTimer = 3.5;
          }
        }
      }
    } else if (directTarget) {
      this.applyDamage(directTarget, p.damage, owner, p.isCrit);
      if (p.slowAmount > 0) {
        directTarget.slowAmount = Math.max(directTarget.slowAmount, p.slowAmount);
        directTarget.slowTimer = Math.max(directTarget.slowTimer, 2.5);
      }
      if (p.freezeChance > 0 && directTarget.kind !== 'boss' && Math.random() < p.freezeChance) {
        directTarget.freezeTimer = Math.max(directTarget.freezeTimer, 1.25);
      }
      if (p.poisonDps > 0) {
        directTarget.poisonDps = Math.max(directTarget.poisonDps, p.poisonDps);
        directTarget.poisonTimer = 4.0;
      }
      if (p.burnDps > 0) {
        directTarget.burnDps = Math.max(directTarget.burnDps, p.burnDps);
        directTarget.burnTimer = 3.5;
      }
      if (p.isCrit) {
        this.spawnSparks(directTarget.x, directTarget.y, '#fde047', 6, 115);
      }
    } else {
      // Orphaned single-target projectile reached last known spot
      this.spawnSparks(impactX, impactY, p.color, 3, 65);
    }
  }

  private applyDamage(m: MonsterInstance, rawDmg: number, owner: TowerInstance | null, ignoreArmor: boolean): void {
    if (m.hp <= 0 || !Number.isFinite(rawDmg)) return;
    const effectiveArmor = ignoreArmor ? 0 : m.armor;
    const dmg = Math.max(2, Math.round(rawDmg) - effectiveArmor);
    const wasAlive = m.hp > 0;
    m.hp -= dmg;
    m.hitFlash = 1;
    if (ignoreArmor && this.effects.length < 180) {
      this.pushEffect({
        kind: 'text',
        x: m.x,
        y: m.y - 12,
        radius: 0,
        maxRadius: 0,
        color: '#fde047',
        text: `💥${dmg}`,
        bold: true,
        life: 0.48,
        maxLife: 0.48,
      });
    }
    if (wasAlive && m.hp <= 0 && owner) {
      owner.kills++;
    }
  }

  private handleMonsterDeath(m: MonsterInstance): void {
    this.gold += m.reward;
    this.kills++;
    this.score += m.reward * 5 + this.wave * 2;
    this.pushEffect({
      kind: 'ring',
      x: m.x,
      y: m.y,
      radius: 4,
      maxRadius: m.radius * (m.kind === 'boss' ? 2.6 : 1.85),
      color: m.color,
      life: 0.24,
      maxLife: 0.24,
    });
    this.spawnSparks(m.x, m.y, m.kind === 'boss' ? '#facc15' : m.color, m.kind === 'boss' ? 14 : 5, 105);

    const now = performance.now();
    if (m.kind === 'boss' || now - this.lastGoldPopupAt > 180) {
      this.lastGoldPopupAt = now;
      this.pushEffect({
        kind: 'text',
        x: m.x,
        y: m.y - m.radius * 0.7,
        radius: 0,
        maxRadius: 0,
        color: '#fde047',
        text: `+${m.reward}g`,
        bold: m.kind === 'boss',
        life: 0.65,
        maxLife: 0.65,
      });
    }
  }

  private findTargets(tower: TowerInstance, rangePx: number, count: number): MonsterInstance[] {
    const inRange: { m: MonsterInstance; dist: number }[] = [];
    for (const m of this.monsters) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - tower.x, m.y - tower.y);
      if (d <= rangePx + m.radius) {
        inRange.push({ m, dist: d });
      }
    }
    if (inRange.length === 0) return [];

    inRange.sort((a, b) => {
      if (tower.targetMode === 'strongest') return b.m.hp - a.m.hp;
      if (tower.targetMode === 'closest') return a.dist - b.dist;
      return b.m.progress - a.m.progress;
    });

    return inRange.slice(0, Math.max(1, count)).map((item) => item.m);
  }

  private getTerrainCache(): HTMLCanvasElement {
    if (this.terrainCache) return this.terrainCache;

    const c = document.createElement('canvas');
    c.width = WORLD_W;
    c.height = WORLD_H;
    const g = c.getContext('2d')!;

    // Base rich forest backdrop
    g.fillStyle = '#0f231b';
    g.fillRect(0, 0, WORLD_W, WORLD_H);

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let col = 0; col < GRID_COLS; col++) {
        const x = col * TILE_SIZE;
        const y = r * TILE_SIZE;
        const path = isPathTile(col, r);
        const h1 = hash2d(col, r, 1);
        const h2 = hash2d(col, r, 2);
        const h3 = hash2d(col, r, 3);

        if (path) {
          // Dirt mortar base
          g.fillStyle = (col + r) % 2 === 0 ? '#3a2f26' : '#332920';
          g.fillRect(x, y, TILE_SIZE, TILE_SIZE);

          // Cobblestone blocks
          const rows = 3;
          const cols = 3;
          const cw = TILE_SIZE / cols;
          const ch = TILE_SIZE / rows;
          for (let sr = 0; sr < rows; sr++) {
            for (let sc = 0; sc < cols; sc++) {
              const sh = hash2d(col * 3 + sc, r * 3 + sr, 9);
              const jx = (sh - 0.5) * 3;
              const jy = (hash2d(col * 3 + sc, r * 3 + sr, 13) - 0.5) * 3;
              const bx = x + sc * cw + 2 + jx;
              const by = y + sr * ch + 2 + jy;
              const bw = cw - 4.5;
              const bh = ch - 4.5;
              const tone = Math.floor(72 + sh * 26);
              g.fillStyle = `rgb(${tone + 14}, ${tone + 6}, ${tone - 4})`;
              g.beginPath();
              g.roundRect(bx, by, bw, bh, 4);
              g.fill();
              // Top highlight on stone
              g.fillStyle = 'rgba(255,255,255,0.08)';
              g.fillRect(bx + 2, by + 1, bw - 4, 2);
              // Bottom shadow
              g.fillStyle = 'rgba(0,0,0,0.22)';
              g.fillRect(bx + 1, by + bh - 2, bw - 2, 2);
            }
          }

          // Tiny scattered pebbles on path
          for (let p = 0; p < 3; p++) {
            const px = x + 8 + hash2d(col, r, 30 + p) * (TILE_SIZE - 16);
            const py = y + 8 + hash2d(col, r, 40 + p) * (TILE_SIZE - 16);
            g.fillStyle = 'rgba(226, 209, 185, 0.22)';
            g.beginPath();
            g.arc(px, py, 1.4 + hash2d(col, r, 50 + p) * 1.2, 0, Math.PI * 2);
            g.fill();
          }

          // Raised stone curb borders where path meets grass
          const nb = getPathNeighbors(col, r);
          g.fillStyle = '#5c5346';
          if (!nb.top) g.fillRect(x, y, TILE_SIZE, 4);
          if (!nb.bottom) g.fillRect(x, y + TILE_SIZE - 4, TILE_SIZE, 4);
          if (!nb.left) g.fillRect(x, y, 4, TILE_SIZE);
          if (!nb.right) g.fillRect(x + TILE_SIZE - 4, y, 4, TILE_SIZE);
          g.fillStyle = 'rgba(0,0,0,0.25)';
          if (!nb.top) g.fillRect(x, y + 4, TILE_SIZE, 2);
          if (!nb.left) g.fillRect(x + 4, y, 2, TILE_SIZE);
        } else {
          // Mossy meadow tile
          const greenVar = Math.floor(h1 * 12);
          g.fillStyle =
            (col + r) % 2 === 0
              ? `rgb(${21 + greenVar}, ${54 + greenVar}, ${38 + Math.floor(greenVar * 0.6)})`
              : `rgb(${25 + greenVar}, ${61 + greenVar}, ${43 + Math.floor(greenVar * 0.6)})`;
          g.fillRect(x, y, TILE_SIZE, TILE_SIZE);

          // Soft moss patch
          g.fillStyle = h2 > 0.5 ? 'rgba(74, 222, 128, 0.08)' : 'rgba(16, 185, 129, 0.07)';
          g.beginPath();
          g.ellipse(
            x + 14 + h2 * 26,
            y + 14 + h3 * 26,
            10 + h1 * 8,
            7 + h2 * 6,
            h3 * Math.PI,
            0,
            Math.PI * 2
          );
          g.fill();

          // Grass blade tufts
          g.strokeStyle = 'rgba(134, 239, 172, 0.16)';
          g.lineWidth = 1.2;
          for (let t = 0; t < 2; t++) {
            const tx = x + 10 + hash2d(col, r, 70 + t) * (TILE_SIZE - 20);
            const ty = y + 14 + hash2d(col, r, 80 + t) * (TILE_SIZE - 20);
            g.beginPath();
            g.moveTo(tx, ty);
            g.lineTo(tx - 3, ty - 5);
            g.moveTo(tx, ty);
            g.lineTo(tx + 2.5, ty - 6);
            g.stroke();
          }

          // Occasional wildflower or mossy pebble
          if (h3 > 0.72) {
            const fx = x + 10 + h1 * 36;
            const fy = y + 10 + h2 * 36;
            g.fillStyle = h1 > 0.5 ? '#fde047' : '#e2e8f0';
            g.beginPath();
            g.arc(fx, fy, 1.8, 0, Math.PI * 2);
            g.fill();
          }

          // Subtle tile seam
          g.strokeStyle = 'rgba(0, 0, 0, 0.16)';
          g.lineWidth = 1;
          g.strokeRect(x + 0.5, y + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
        }
      }
    }

    // Castle stone courtyard apron strictly inside CASTLE_TILE (5,14)
    const cx = (CASTLE_TILE.col + 0.5) * TILE_SIZE;
    const cy = (CASTLE_TILE.row + 0.5) * TILE_SIZE;
    const apronGrad = g.createRadialGradient(cx, cy, 6, cx, cy, TILE_SIZE * 0.5);
    apronGrad.addColorStop(0, 'rgba(30, 58, 138, 0.45)');
    apronGrad.addColorStop(1, 'rgba(15, 23, 42, 0)');
    g.fillStyle = apronGrad;
    g.beginPath();
    g.arc(cx, cy, TILE_SIZE * 0.5, 0, Math.PI * 2);
    g.fill();

    this.terrainCache = c;
    return c;
  }

  private render(): void {
    this.syncCanvasMetrics();
    if (this.cssW < 2 || this.cssH < 2 || !(this.scale > 0)) return;

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#070f1d';
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const shakeMag = this.screenShake > 0 ? this.screenShake * this.screenShake * 7 : 0;
    const shakeX = shakeMag > 0 ? (Math.random() - 0.5) * 2 * shakeMag : 0;
    const shakeY = shakeMag > 0 ? (Math.random() - 0.5) * 2 * shakeMag : 0;

    ctx.save();
    ctx.translate(this.offsetX + shakeX, this.offsetY + shakeY);
    ctx.scale(this.scale, this.scale);

    // 1. Static cached battlefield terrain
    ctx.drawImage(this.getTerrainCache(), 0, 0);

    // 2. Buildable tile grid cues & touch/hover range preview
    if (this.buildTool && this.started) {
      ctx.lineWidth = 1.2;
      const pulse = 0.14 + Math.sin(this.animTime * 4) * 0.05;
      ctx.strokeStyle = `rgba(134, 239, 172, ${pulse.toFixed(3)})`;
      for (let r = 0; r < GRID_ROWS; r++) {
        for (let c = 0; c < GRID_COLS; c++) {
          if (isPathTile(c, r)) continue;
          if (this.towers.some((t) => t.col === c && t.row === r)) continue;
          const x = c * TILE_SIZE;
          const y = r * TILE_SIZE;
          ctx.strokeRect(x + 4, y + 4, TILE_SIZE - 8, TILE_SIZE - 8);
        }
      }

      const activePreview = this.previewTile ?? this.hoverTile;
      if (activePreview && !isPathTile(activePreview.col, activePreview.row)) {
        const occ = this.towers.some((t) => t.col === activePreview.col && t.row === activePreview.row);
        if (!occ) {
          const def = BASE_TOWERS[this.buildTool];
          const hx = (activePreview.col + 0.5) * TILE_SIZE;
          const hy = (activePreview.row + 0.5) * TILE_SIZE;
          const rangePx = def.range * TILE_SIZE;
          const canAfford = this.gold >= def.cost;

          // Range circle fill + dashed border
          ctx.beginPath();
          ctx.arc(hx, hy, rangePx, 0, Math.PI * 2);
          ctx.fillStyle = canAfford ? 'rgba(74, 222, 128, 0.12)' : 'rgba(248, 113, 113, 0.12)';
          ctx.fill();
          ctx.strokeStyle = canAfford ? 'rgba(74, 222, 128, 0.72)' : 'rgba(248, 113, 113, 0.72)';
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 5]);
          ctx.lineDashOffset = -this.animTime * 18;
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.lineDashOffset = 0;

          // Highlight tile + translucent tower ghost
          ctx.fillStyle = canAfford ? 'rgba(74, 222, 128, 0.16)' : 'rgba(248, 113, 113, 0.16)';
          ctx.fillRect(activePreview.col * TILE_SIZE + 2, activePreview.row * TILE_SIZE + 2, TILE_SIZE - 4, TILE_SIZE - 4);
          ctx.beginPath();
          ctx.arc(hx, hy, 17, 0, Math.PI * 2);
          ctx.fillStyle = def.color;
          ctx.globalAlpha = 0.55;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = canAfford ? '#4ade80' : '#f87171';
          ctx.lineWidth = 2;
          ctx.stroke();

          // Tap-to-confirm hint badge when using touch preview
          if (this.previewTile) {
            const label = canAfford ? `Tap again • ${def.cost}g` : `Need ${def.cost}g`;
            ctx.font = '800 10px system-ui, sans-serif';
            const tw = ctx.measureText(label).width + 12;
            const by = Math.max(14, hy - 34);
            ctx.fillStyle = 'rgba(2, 6, 23, 0.9)';
            ctx.beginPath();
            ctx.roundRect(hx - tw * 0.5, by - 9, tw, 18, 9);
            ctx.fill();
            ctx.strokeStyle = canAfford ? '#4ade80' : '#f87171';
            ctx.lineWidth = 1.2;
            ctx.stroke();
            ctx.fillStyle = canAfford ? '#bbf7d0' : '#fecaca';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, hx, by);
            ctx.textBaseline = 'alphabetic';
          }
        }
      }
    }

    // 3. Subtle marching guide arrows along path
    ctx.beginPath();
    WORLD_WAYPOINTS.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.16)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 12]);
    ctx.lineDashOffset = -this.animTime * 22;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;

    // 4. Spawn Portal & Shimmering Moat + Castle Keep
    this.drawSpawnPortal(ctx);
    this.drawCastleMoatAndKeep(ctx);

    // 5. Chrono Aura buff links & Selected tower range ring
    for (const t of this.towers) {
      if (t.specType === 'chrono') {
        const auraGrad = ctx.createRadialGradient(t.x, t.y, 12, t.x, t.y, TILE_SIZE * 2.8);
        auraGrad.addColorStop(0, 'rgba(99, 102, 241, 0.10)');
        auraGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
        ctx.fillStyle = auraGrad;
        ctx.beginPath();
        ctx.arc(t.x, t.y, TILE_SIZE * 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const selected = this.getSelectedTower();
    if (selected) {
      const stats = this.getTowerStats(selected);
      const rg = ctx.createRadialGradient(selected.x, selected.y, stats.rangePx * 0.2, selected.x, selected.y, stats.rangePx);
      rg.addColorStop(0, 'rgba(56, 189, 248, 0.04)');
      rg.addColorStop(0.8, 'rgba(56, 189, 248, 0.12)');
      rg.addColorStop(1, 'rgba(56, 189, 248, 0.24)');
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, stats.rangePx, 0, Math.PI * 2);
      ctx.fillStyle = rg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.82)';
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 5]);
      ctx.lineDashOffset = -this.animTime * 20;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }

    // 6. Towers
    for (const tower of this.towers) {
      this.drawTower(ctx, tower, selected?.id === tower.id);
    }

    // 7. Monsters
    for (const m of this.monsters) {
      this.drawMonster(ctx, m);
    }

    // 8. Projectiles (trails + crisp heads)
    this.drawProjectiles(ctx);

    // 9. Visual Effects (rings, lightning/lasers, sparks, floating popups)
    this.drawEffects(ctx);

    ctx.restore();
  }

  private drawSpawnPortal(ctx: CanvasRenderingContext2D): void {
    const x = (SPAWN_TILE.col + 0.5) * TILE_SIZE;
    const y = (SPAWN_TILE.row + 0.5) * TILE_SIZE;
    const pulse = 1 + Math.sin(this.animTime * 4) * 0.09;

    ctx.save();
    ctx.translate(x, y);

    // Obsidian altar ring
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fillStyle = '#1e1b2e';
    ctx.fill();
    ctx.strokeStyle = '#4c1d95';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    // Outer violet energy halo
    const aura = ctx.createRadialGradient(0, 0, 4, 0, 0, 26 * pulse);
    aura.addColorStop(0, 'rgba(216, 180, 254, 0.85)');
    aura.addColorStop(0.55, 'rgba(147, 51, 234, 0.55)');
    aura.addColorStop(1, 'rgba(88, 28, 135, 0)');
    ctx.fillStyle = aura;
    ctx.beginPath();
    ctx.arc(0, 0, 26 * pulse, 0, Math.PI * 2);
    ctx.fill();

    // Rotating arcane rune ticks
    ctx.save();
    ctx.rotate(this.animTime * 1.8);
    ctx.strokeStyle = '#e9d5ff';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.arc(0, 0, 17, a, a + 0.45);
      ctx.stroke();
    }
    ctx.restore();

    // Swirling core
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#581c87';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 4.5 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = '#f5d0fe';
    ctx.fill();

    ctx.restore();
  }

  private drawCastleMoatAndKeep(ctx: CanvasRenderingContext2D): void {
    const cx = (CASTLE_TILE.col + 0.5) * TILE_SIZE;
    const cy = (CASTLE_TILE.row + 0.5) * TILE_SIZE;

    ctx.save();
    ctx.translate(cx, cy);

    // Flowing shimmering moat channel contained cleanly within tile (5,14) [-27..+27]
    ctx.beginPath();
    ctx.roundRect(-27, -27, 54, 54, 11);
    ctx.fillStyle = '#0c4a6e';
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Shimmering animated water waves inside moat
    const waterGrad = ctx.createLinearGradient(-25, -25, 25, 25);
    waterGrad.addColorStop(0, '#0284c7');
    waterGrad.addColorStop(0.5, '#0ea5e9');
    waterGrad.addColorStop(1, '#0369a1');
    ctx.beginPath();
    ctx.roundRect(-25, -25, 50, 50, 9);
    ctx.fillStyle = waterGrad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(186, 230, 253, 0.55)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 4; i++) {
      const phase = this.animTime * 2.6 + i * 1.5;
      const rx = Math.sin(phase) * 15;
      const ry = -20 + (i % 2) * 40;
      ctx.beginPath();
      ctx.moveTo(rx - 5, ry);
      ctx.quadraticCurveTo(rx, ry - 1.8, rx + 5, ry);
      ctx.stroke();
    }

    // Wooden drawbridge spanning north moat from path (5,13) into castle gate
    ctx.fillStyle = '#78350f';
    ctx.fillRect(-8, -27, 16, 15);
    ctx.strokeStyle = '#451a03';
    ctx.lineWidth = 1;
    for (let p = -25; p <= -14; p += 3.5) {
      ctx.beginPath();
      ctx.moveTo(-7, p);
      ctx.lineTo(7, p);
      ctx.stroke();
    }

    // Castle hit/fortify aura (kept inside tile bounds)
    ctx.beginPath();
    ctx.arc(0, 0, 23, 0, Math.PI * 2);
    ctx.fillStyle =
      this.castleHitFlash > 0
        ? 'rgba(239,68,68,0.48)'
        : this.castleFortifyLevel > 0
          ? 'rgba(56,189,248,0.26)'
          : 'rgba(56,189,248,0.14)';
    ctx.fill();

    // Stone Keep shadow + main walls
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(-18, -9, 36, 25);

    ctx.fillStyle = this.castleHitFlash > 0 ? '#fca5a5' : '#cbd5e1';
    ctx.fillRect(-17, -12, 34, 24);
    // Stone masonry lines
    ctx.strokeStyle = 'rgba(51, 65, 85, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(-17, -12, 34, 24);
    ctx.beginPath();
    ctx.moveTo(-17, -4);
    ctx.lineTo(17, -4);
    ctx.moveTo(-17, 4);
    ctx.lineTo(17, 4);
    ctx.stroke();

    // Side towers (extra fortified stone trim when fortified)
    ctx.fillStyle = this.castleFortifyLevel > 0 ? '#64748b' : '#94a3b8';
    ctx.fillRect(-20, -17, 10, 29);
    ctx.fillRect(10, -17, 10, 29);
    ctx.strokeStyle = '#334155';
    ctx.strokeRect(-20, -17, 10, 29);
    ctx.strokeRect(10, -17, 10, 29);

    // Pointed royal roofs
    ctx.fillStyle = '#1d4ed8';
    ctx.beginPath();
    ctx.moveTo(-22, -17);
    ctx.lineTo(-15, -26);
    ctx.lineTo(-8, -17);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(8, -17);
    ctx.lineTo(15, -26);
    ctx.lineTo(22, -17);
    ctx.closePath();
    ctx.fill();

    // Central arched gate
    ctx.fillStyle = '#451a03';
    ctx.beginPath();
    ctx.roundRect(-6, 1, 12, 11, [5, 5, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = '#92400e';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // Animated flickering torches flanking castle gate
    const flicker = 0.8 + Math.sin(this.animTime * 19) * 0.2;
    for (const tx of [-9.5, 9.5]) {
      const tg = ctx.createRadialGradient(tx, 3, 1, tx, 3, 8 * flicker);
      tg.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
      tg.addColorStop(0.5, 'rgba(249, 115, 22, 0.55)');
      tg.addColorStop(1, 'rgba(249, 115, 22, 0)');
      ctx.fillStyle = tg;
      ctx.beginPath();
      ctx.arc(tx, 3, 8 * flicker, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(tx, 3, 1.8 * flicker, 0, Math.PI * 2);
      ctx.fill();
    }

    // Waving royal banner on central spire
    const wave1 = Math.sin(this.animTime * 5.2) * 1.8;
    const wave2 = Math.cos(this.animTime * 5.2) * 1.4;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(-1, -28, 2, 16);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(1, -28);
    ctx.quadraticCurveTo(5, -28 + wave1, 11, -26.5 + wave2);
    ctx.lineTo(9.5, -22.5 + wave2);
    ctx.quadraticCurveTo(5, -23.5 + wave1, 1, -22.5);
    ctx.closePath();
    ctx.fill();

    // Castle HP Bar (centered neatly above castle keep)
    const ratio = Math.max(0, Math.min(1, this.castleHp / Math.max(1, this.castleMaxHp)));
    ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
    ctx.beginPath();
    ctx.roundRect(-24, -37, 48, 7, 3);
    ctx.fill();
    ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.beginPath();
    ctx.roundRect(-23, -36, 46 * ratio, 5, 2);
    ctx.fill();

    ctx.restore();
  }

  private drawTower(ctx: CanvasRenderingContext2D, tower: TowerInstance, isSelected: boolean): void {
    const stats = this.getTowerStats(tower);
    const tier = tower.baseUpgrades; // 0..10
    ctx.save();
    ctx.translate(tower.x, tower.y);

    // Selection glow ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(0, 0, 25 + Math.sin(this.animTime * 6) * 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.6;
      ctx.stroke();
    }

    // Plinth drop shadow
    ctx.beginPath();
    ctx.arc(0, 3, 21, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();

    // Spec aura / max level glow
    if (tower.specType || tier >= 10) {
      const glowColor = tower.specType ? stats.color : '#facc15';
      ctx.beginPath();
      ctx.arc(0, 0, 23, 0, Math.PI * 2);
      ctx.fillStyle = glowColor;
      ctx.globalAlpha = 0.18 + Math.sin(this.animTime * 4 + tower.id) * 0.06;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Evolved base plinth (scales with level 0..10 and specialization)
    const plinthRad = tower.specType ? 20.5 : 18 + Math.min(2, tier * 0.2);
    ctx.beginPath();
    ctx.arc(0, 0, plinthRad, 0, Math.PI * 2);
    ctx.fillStyle = tower.specType ? '#0f172a' : tier >= 6 ? '#1e293b' : '#334155';
    ctx.fill();

    // Rim evolution: rough stone -> iron rivets -> silver -> gold -> spec color
    ctx.lineWidth = tower.specType ? 3.2 : tier >= 6 ? 2.8 : 2.1;
    ctx.strokeStyle = tower.specType
      ? tower.specUpgrades >= 10
        ? '#facc15'
        : stats.color
      : tier >= 10
        ? '#facc15'
        : tier >= 6
          ? '#fbbf24'
          : tier >= 3
            ? '#cbd5e1'
            : '#64748b';
    ctx.stroke();

    // Rivets / crenellation notches on level 3+ towers
    if (tier >= 3 || tower.specType) {
      const pipCount = tower.specType ? 4 + Math.floor(tower.specUpgrades / 3) : tier >= 7 ? 6 : 4;
      ctx.fillStyle = tower.specType ? stats.accent : tier >= 7 ? '#fde047' : '#94a3b8';
      for (let i = 0; i < pipCount; i++) {
        const a = (i * Math.PI * 2) / pipCount + (tower.specType ? this.animTime * 0.7 : 0);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (plinthRad - 2.5), Math.sin(a) * (plinthRad - 2.5), 1.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Chrono rotating clockwork ring
    if (tower.specType === 'chrono') {
      ctx.save();
      ctx.rotate(this.animTime * 1.4);
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(0, 0, 23, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Rotating turret body with recoil kick
    ctx.save();
    ctx.rotate(tower.angle);
    const kick = -tower.recoil * 3.2;
    ctx.translate(kick, 0);

    if (tower.baseType === 'archer') {
      // Crossbow / Ballista turret evolving across levels & specs
      ctx.fillStyle = tower.specType === 'venom' ? '#365314' : '#451a03';
      ctx.beginPath();
      ctx.roundRect(-7, -7, 14, 14, 3);
      ctx.fill();

      // Bow arms (wider/double at higher levels or multishot)
      ctx.strokeStyle = stats.color;
      ctx.lineWidth = tier >= 5 || tower.specType ? 3 : 2.3;
      ctx.beginPath();
      ctx.arc(2, 0, 11, -Math.PI * 0.46, Math.PI * 0.46);
      ctx.stroke();

      if (tower.specType === 'multishot' || tier >= 7) {
        ctx.strokeStyle = stats.accent;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(5, 0, 12.5, -Math.PI * 0.36, Math.PI * 0.36);
        ctx.stroke();
      }

      // Rail / Scope
      ctx.fillStyle = tower.specType === 'sniper' ? '#fde047' : stats.accent;
      ctx.fillRect(-1, -1.5, tower.specType === 'sniper' ? 20 : 14, 3);

      if (tower.specType === 'sniper') {
        // Sniper laser glint
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(6, -4, 2.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (tower.specType === 'venom') {
        // Venom emerald vial
        ctx.fillStyle = '#a3e635';
        ctx.beginPath();
        ctx.arc(-2, 0, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (tower.baseType === 'cannon') {
      // Heavy iron carriage
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.roundRect(-10, -10, 18, 20, 4);
      ctx.fill();

      if (tower.specType === 'gatling') {
        // Triple gatling barrels
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(3, -6, 15, 3);
        ctx.fillRect(3, -1.5, 16, 3);
        ctx.fillRect(3, 3, 15, 3);
        ctx.fillStyle = stats.color;
        ctx.fillRect(8, -6.5, 4, 13);
      } else if (tower.specType === 'mortar') {
        // Flared wide siege bore
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(17, -9);
        ctx.lineTo(17, 9);
        ctx.lineTo(0, 6);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = stats.color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (tower.specType === 'inferno') {
        // Magma furnace barrel
        ctx.fillStyle = '#7c2d12';
        ctx.fillRect(1, -6, 15, 12);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(4, 0, 5 + Math.sin(this.animTime * 12) * 0.8, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Standard evolving cannon barrel
        const barrelLen = 15 + Math.floor(tier / 4) * 2;
        ctx.fillStyle = stats.color;
        ctx.fillRect(2, -4.5, barrelLen, 9);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillRect(barrelLen - 1, -5.5, 3, 11);
      }

      if (tower.muzzleFlash > 0) {
        ctx.beginPath();
        ctx.arc(19, 0, 7.5 * tower.muzzleFlash, 0, Math.PI * 2);
        ctx.fillStyle = tower.specType === 'inferno' ? '#fb923c' : '#fef08a';
        ctx.fill();
      }
    } else if (tower.baseType === 'frost') {
      // Rotating hexagonal crystal spire
      ctx.save();
      ctx.rotate(-tower.angle + this.animTime * (tower.specType ? 1.5 : 0.8));
      const pts = tower.specType === 'blizzard' ? 8 : 6;
      const rad = 11 + Math.min(3, tier * 0.25);
      ctx.fillStyle = stats.color;
      ctx.beginPath();
      for (let k = 0; k < pts; k++) {
        const a = (k * Math.PI * 2) / pts;
        const r = k % 2 === 0 ? rad : rad * 0.72;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = stats.accent;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.restore();

      if (tower.specType === 'cryo') {
        // Twin cryo emitter prongs
        ctx.fillStyle = '#cffafe';
        ctx.fillRect(4, -5.5, 11, 2.5);
        ctx.fillRect(4, 3, 11, 2.5);
      }

      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 4.2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Lightning / Chain / Laser / Tesla coils
      ctx.fillStyle = '#1e1b4b';
      ctx.beginPath();
      ctx.arc(0, 0, 11, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = stats.color;
      ctx.beginPath();
      ctx.arc(0, 0, 8.5, 0, Math.PI * 2);
      ctx.fill();

      if (tower.specType === 'laser') {
        // Focusing ruby prism barrel
        ctx.fillStyle = '#fbcfe8';
        ctx.fillRect(3, -3.5, 14, 7);
        ctx.fillStyle = '#f43f5e';
        ctx.beginPath();
        ctx.arc(16, 0, 3.2, 0, Math.PI * 2);
        ctx.fill();
      } else if (tower.specType === 'chain' || tower.specType === 'tesla') {
        // Twin/triple storm prongs
        ctx.fillStyle = stats.accent;
        ctx.fillRect(4, -6, 11, 2.5);
        ctx.fillRect(4, 3.5, 11, 2.5);
        ctx.beginPath();
        ctx.arc(15, -4.7, 2.3, 0, Math.PI * 2);
        ctx.arc(15, 4.7, 2.3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = stats.accent;
        ctx.fillRect(4, -3, 11, 6);
      }

      // Core orb pulse
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 3.2 + Math.sin(this.animTime * 10) * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Visible miniature crew ("mannetje") operating the tower!
    if (tower.baseType === 'archer') {
      // Hooded Ranger/Archer behind the bow
      ctx.fillStyle = tower.specType === 'venom' ? '#14532d' : '#1e3a8a';
      ctx.beginPath();
      ctx.arc(-5, 0, 5.2, 0, Math.PI * 2);
      ctx.fill();
      // Quiver on back
      ctx.fillStyle = '#78350f';
      ctx.fillRect(-9.5, -3.5, 3, 7);
      // Hooded head + feather on higher upgrades
      ctx.fillStyle = '#fde68a';
      ctx.beginPath();
      ctx.arc(-3.5, 0, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tower.specType ? stats.color : '#15803d';
      ctx.beginPath();
      ctx.arc(-4.2, 0, 3.8, Math.PI * 0.35, Math.PI * 1.65);
      ctx.fill();
      if (tier >= 4 || tower.specType) {
        ctx.fillStyle = '#facc15';
        ctx.fillRect(-8, -4.5, 4, 1.5);
      }
    } else if (tower.baseType === 'cannon') {
      // Goggled Artillery Engineer behind the cannon carriage
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(-7.5, 0, 4.8, 0, Math.PI * 2);
      ctx.fill();
      // Brass helmet & goggles
      ctx.fillStyle = tower.specType === 'inferno' ? '#dc2626' : '#f59e0b';
      ctx.beginPath();
      ctx.arc(-7, 0, 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(-4.8, -2.5, 1.6, 2);
      ctx.fillRect(-4.8, 0.5, 1.6, 2);
    } else if (tower.baseType === 'frost') {
      // Robed Frost/Chrono Mage standing on plinth beside spire
      ctx.save();
      ctx.rotate(-tower.angle);
      ctx.fillStyle = tower.specType === 'chrono' ? '#4338ca' : '#0284c7';
      ctx.beginPath();
      ctx.arc(-7, 7, 4.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bae6fd';
      ctx.beginPath();
      ctx.arc(-7, 7, 2.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tower.specType === 'chrono' ? '#facc15' : '#e0f2fe';
      ctx.beginPath();
      ctx.moveTo(-7, 3);
      ctx.lineTo(-10, 9);
      ctx.lineTo(-4, 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    } else {
      // Storm/Arcane Wizard operator
      ctx.fillStyle = tower.specType === 'laser' ? '#be123c' : '#6d28d9';
      ctx.beginPath();
      ctx.arc(-6.5, 0, 4.6, 0, Math.PI * 2);
      ctx.fill();
      // Pointed wizard hat
      ctx.fillStyle = stats.accent;
      ctx.beginPath();
      ctx.arc(-6, 0, 3.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.moveTo(-5, -1.5);
      ctx.lineTo(-11, 0);
      ctx.lineTo(-5, 1.5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Compact level badge
    const lvlLabel = tower.specType ? `S${tower.specUpgrades}` : `${tower.baseUpgrades}`;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.beginPath();
    ctx.roundRect(-12, 11, 24, 12, 4);
    ctx.fill();
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = tower.specType ? '#facc15' : tower.baseUpgrades >= 10 ? '#4ade80' : '#f8fafc';
    ctx.fillText(lvlLabel, 0, 20);

    ctx.restore();
  }

  private drawMonster(ctx: CanvasRenderingContext2D, m: MonsterInstance): void {
    const bob = Math.sin(this.animTime * 9 + m.wobbleOffset) * (m.kind === 'runner' ? 2.8 : 1.6);
    ctx.save();
    ctx.translate(m.x, m.y);

    // Ground shadow (stays on ground while body bobs)
    ctx.beginPath();
    ctx.ellipse(0, m.radius * 0.85, m.radius * 0.92, m.radius * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fill();

    ctx.translate(0, bob);

    // Boss menacing aura + war banner
    if (m.kind === 'boss') {
      ctx.beginPath();
      ctx.arc(0, 0, m.radius + 5 + Math.sin(this.animTime * 6) * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(192, 38, 211, 0.25)';
      ctx.fill();
      // War banner staff on back
      ctx.strokeStyle = '#fde047';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-m.radius * 0.65, 2);
      ctx.lineTo(-m.radius * 0.65, -m.radius * 1.65);
      ctx.stroke();
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.moveTo(-m.radius * 0.65, -m.radius * 1.65);
      ctx.lineTo(-m.radius * 1.3, -m.radius * 1.42 + Math.sin(this.animTime * 8) * 2);
      ctx.lineTo(-m.radius * 0.65, -m.radius * 1.2);
      ctx.closePath();
      ctx.fill();
    }

    // Winged runner (flapping bat/imp wings!)
    if (m.kind === 'runner') {
      const flap = Math.sin(this.animTime * 22 + m.wobbleOffset) * 5;
      ctx.fillStyle = 'rgba(253, 224, 71, 0.78)';
      ctx.beginPath();
      ctx.moveTo(-4, 0);
      ctx.lineTo(-m.radius - 8, -7 + flap);
      ctx.lineTo(-m.radius - 4, 3 + flap * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(4, 0);
      ctx.lineTo(m.radius + 8, -7 + flap);
      ctx.lineTo(m.radius + 4, 3 + flap * 0.4);
      ctx.closePath();
      ctx.fill();
    }

    // Body color (status tinted)
    let fill = m.color;
    if (m.hitFlash > 0.2) fill = '#ffffff';
    else if (m.freezeTimer > 0) fill = '#67e8f9';
    else if (m.slowTimer > 0) fill = '#38bdf8';
    else if (m.burnTimer > 0) fill = '#fb923c';
    else if (m.poisonTimer > 0) fill = '#84cc16';

    ctx.beginPath();
    if (m.kind === 'golem') {
      // Craggy octagonal golem silhouette
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        const r = m.radius * (i % 2 === 0 ? 1.06 : 0.9);
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.arc(0, 0, m.radius, 0, Math.PI * 2);
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = m.kind === 'boss' ? '#facc15' : m.kind === 'knight' ? '#e2e8f0' : '#0f172a';
    ctx.lineWidth = m.kind === 'boss' ? 2.6 : 1.5;
    ctx.stroke();

    // Slime glossy highlight
    if (m.kind === 'slime' && m.hitFlash <= 0.2) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.beginPath();
      ctx.ellipse(-m.radius * 0.3, -m.radius * 0.35, m.radius * 0.28, m.radius * 0.16, -0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Goblin ears + dagger
    if (m.kind === 'goblin') {
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.moveTo(-m.radius * 0.8, -2);
      ctx.lineTo(-m.radius * 1.4, -6);
      ctx.lineTo(-m.radius * 0.7, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(m.radius * 0.8, -2);
      ctx.lineTo(m.radius * 1.4, -6);
      ctx.lineTo(m.radius * 0.7, 3);
      ctx.fill();
      ctx.fillStyle = '#cbd5e1';
      ctx.fillRect(m.radius * 0.85, -5, 2.2, 6.5);
    }

    // Knight armored shield (with boss emblem) & sword + helm crest
    if (m.kind === 'knight') {
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.roundRect(-m.radius * 0.98, -3, m.radius * 0.72, m.radius * 1.1, 3);
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(-m.radius * 0.62, 2, 1.8, 0, Math.PI * 2);
      ctx.fill();
      // Broadsword
      ctx.fillStyle = '#e2e8f0';
      ctx.fillRect(m.radius * 0.75, -8, 2.6, 11);
      // Plume
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-3, -m.radius - 4, 6, 5);
    }

    // Horns / crown for orc / golem / boss
    if (m.kind === 'orc' || m.kind === 'golem' || m.kind === 'boss') {
      ctx.fillStyle = m.kind === 'boss' ? '#facc15' : '#fef3c7';
      ctx.beginPath();
      ctx.moveTo(-m.radius * 0.65, -m.radius * 0.55);
      ctx.lineTo(-m.radius * 0.35, -m.radius * 1.25);
      ctx.lineTo(-m.radius * 0.1, -m.radius * 0.7);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(m.radius * 0.65, -m.radius * 0.55);
      ctx.lineTo(m.radius * 0.35, -m.radius * 1.25);
      ctx.lineTo(m.radius * 0.1, -m.radius * 0.7);
      ctx.fill();
    }

    // Glowing eyes
    ctx.fillStyle = m.kind === 'boss' ? '#fef08a' : m.kind === 'golem' ? '#fde047' : '#0f172a';
    ctx.fillRect(-m.radius * 0.42, -2.5, 3.2, 3.2);
    ctx.fillRect(m.radius * 0.14, -2.5, 3.2, 3.2);

    // Frozen crystal encasement
    if (m.freezeTimer > 0) {
      ctx.strokeStyle = '#e0f2fe';
      ctx.fillStyle = 'rgba(165, 243, 252, 0.32)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-m.radius - 2, -m.radius - 2, m.radius * 2 + 4, m.radius * 2 + 4, 5);
      ctx.fill();
      ctx.stroke();
    }

    // HP bar if damaged or boss
    if (m.hp < m.maxHp || m.kind === 'boss') {
      const bw = Math.max(18, m.radius * 2);
      const ratio = Math.max(0, Math.min(1, m.hp / Math.max(1, m.maxHp)));
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(-bw * 0.5, -m.radius - 8, bw, 4.5);
      ctx.fillStyle = m.kind === 'boss' ? '#f43f5e' : '#22c55e';
      ctx.fillRect(-bw * 0.5, -m.radius - 8, bw * ratio, 4.5);
    }

    ctx.restore();
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D): void {
    for (const p of this.projectiles) {
      // Glowing trail
      ctx.strokeStyle = p.isCrit ? '#fde047' : p.color;
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = p.isArrow ? 2 : p.radius * 1.1;
      ctx.beginPath();
      ctx.moveTo(p.prevX, p.prevY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.isArrow) {
        const ang = Math.atan2(p.vy, p.vx);
        ctx.rotate(ang);
        ctx.fillStyle = p.isCrit ? '#fde047' : p.color;
        ctx.fillRect(-8, -1.6, 15, 3.2);
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(4, -3.6);
        ctx.lineTo(4, 3.6);
        ctx.closePath();
        ctx.fill();
      } else {
        // Outer glow halo
        ctx.beginPath();
        ctx.arc(0, 0, p.radius * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.28;
        ctx.fill();
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.arc(0, 0, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawEffects(ctx: CanvasRenderingContext2D): void {
    for (const e of this.effects) {
      const t = Math.max(0, Math.min(1, e.life / Math.max(0.001, e.maxLife)));
      if (e.kind === 'ring') {
        const rad = e.radius + (e.maxRadius - e.radius) * (1 - t);
        ctx.beginPath();
        ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = t * 0.8;
        ctx.lineWidth = 2.6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'spark') {
        ctx.globalAlpha = t;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius * (0.4 + t * 0.6), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'lightning' && e.points && e.points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(e.points[0].x, e.points[0].y);
        for (let i = 1; i < e.points.length; i++) {
          const prev = e.points[i - 1];
          const curr = e.points[i];
          const midX = (prev.x + curr.x) * 0.5 + (Math.random() - 0.5) * 14;
          const midY = (prev.y + curr.y) * 0.5 + (Math.random() - 0.5) * 14;
          ctx.lineTo(midX, midY);
          ctx.lineTo(curr.x, curr.y);
        }
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = t;
        ctx.lineWidth = e.radius + 2.2;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'text' && e.text) {
        const py = e.y - (1 - t) * 18;
        ctx.globalAlpha = t;
        ctx.font = e.bold ? '900 14px sans-serif' : 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
        ctx.strokeText(e.text, e.x, py);
        ctx.fillStyle = e.color;
        ctx.fillText(e.text, e.x, py);
        ctx.globalAlpha = 1;
      }
    }
  }

  private pushHud(force: boolean): void {
    if (!force && this.gameOver) return;
    this.onHudUpdate({
      gold: this.gold,
      castleHp: this.castleHp,
      castleMaxHp: this.castleMaxHp,
      castleFortifyLevel: this.castleFortifyLevel,
      castleRepairCost: this.getCastleRepairCost(),
      castleFortifyCost: this.getCastleFortifyCost(),
      wave: this.wave,
      kills: this.kills,
      score: this.score,
      towerCount: this.towers.length,
      maxTowers: BUILDABLE_SLOTS_COUNT,
      activeMonsters: this.monsters.length,
      pendingSpawns: this.spawnQueue.length,
      speedMult: this.speedMult,
      autoWave: this.autoWave,
      started: this.started,
      paused: this.paused,
      gameOver: this.gameOver,
      buildTool: this.buildTool,
      selectedTower: this.getSelectedTower(),
      previewTile: this.previewTile,
      nextWaveCostBonus: this.spawnQueue.length > 0 || this.monsters.length > 0 ? 35 + this.wave * 6 : 0,
    });
  }
}
