import { soundFx } from './sound';
import { BASE_TOWERS, SPEC_TOWERS } from './tdCatalog';
import {
  BUILDABLE_SLOTS_COUNT,
  CASTLE_TILE,
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
  gameOver: boolean;
  buildTool: BaseTowerType | null;
  selectedTower: TowerInstance | null;
  nextWaveCostBonus: number;
}

export class CastleTdEngine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

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

  private wave = 0;
  private kills = 0;
  private score = 0;
  private nextEntityId = 1;

  private speedMult: 1 | 2 | 4 = 1;
  private autoWave = true;
  private autoWaveCountdown = 2.5;
  private gameOver = false;

  private buildTool: BaseTowerType | null = 'archer';
  private selectedTowerId: number | null = null;

  private rafId = 0;
  private lastTs = 0;
  private animTime = 0;
  private lastHudPush = 0;
  private onHudUpdate: (snap: TdUiSnapshot) => void;
  private onGameOverCallback?: (wave: number, kills: number, score: number) => void;

  // Render mapping from CSS pixels to world space
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

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

  start(): void {
    this.lastTs = performance.now();
    this.pushHud(true);
    const loop = (ts: number): void => {
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
    cancelAnimationFrame(this.rafId);
  }

  resetGame(): void {
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
    this.wave = 0;
    this.kills = 0;
    this.score = 0;
    this.autoWaveCountdown = 2.0;
    this.gameOver = false;
    this.selectedTowerId = null;
    this.buildTool = 'archer';
    this.pushHud(true);
  }

  setBuildTool(tool: BaseTowerType | null): void {
    this.buildTool = tool;
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

  handleCanvasTap(clientX: number, clientY: number): void {
    if (this.gameOver) return;
    const rect = this.canvas.getBoundingClientRect();
    const wx = (clientX - rect.left - this.offsetX) / this.scale;
    const wy = (clientY - rect.top - this.offsetY) / this.scale;
    const col = Math.floor(wx / TILE_SIZE);
    const row = Math.floor(wy / TILE_SIZE);
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return;

    const existing = this.towers.find((t) => t.col === col && t.row === row);
    if (existing) {
      this.selectedTowerId = existing.id;
      this.pushHud(true);
      return;
    }

    if (isPathTile(col, row) || !this.buildTool) {
      this.selectedTowerId = null;
      this.pushHud(true);
      return;
    }

    const def = BASE_TOWERS[this.buildTool];
    if (this.gold < def.cost) {
      this.effects.push({
        kind: 'text',
        x: (col + 0.5) * TILE_SIZE,
        y: (row + 0.4) * TILE_SIZE,
        radius: 0,
        maxRadius: 0,
        color: '#f87171',
        text: `Need ${def.cost}g`,
        life: 0.9,
        maxLife: 0.9,
      });
      return;
    }

    this.gold -= def.cost;
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
      beamTargetId: null,
      beamRamp: 0,
    };
    this.towers.push(tower);
    this.effects.push({
      kind: 'ring',
      x: tower.x,
      y: tower.y,
      radius: 8,
      maxRadius: TILE_SIZE * 0.75,
      color: def.color,
      life: 0.32,
      maxLife: 0.32,
    });
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
      if (this.gold < cost) break;
      this.gold -= cost;
      tower.totalSpent += cost;
      if (canBase) tower.baseUpgrades++;
      else tower.specUpgrades++;
      didAny = true;
    }
    if (didAny) {
      soundFx.upgrade(false);
      this.effects.push({
        kind: 'ring',
        x: tower.x,
        y: tower.y,
        radius: 10,
        maxRadius: TILE_SIZE * 0.95,
        color: '#facc15',
        life: 0.36,
        maxLife: 0.36,
      });
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
    this.effects.push({
      kind: 'ring',
      x: tower.x,
      y: tower.y,
      radius: 12,
      maxRadius: TILE_SIZE * 1.4,
      color: spec.color,
      life: 0.5,
      maxLife: 0.5,
    });
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
    this.effects.push({
      kind: 'text',
      x: tower.x,
      y: tower.y,
      radius: 0,
      maxRadius: 0,
      color: '#fde047',
      text: `+${refund}g`,
      life: 0.85,
      maxLife: 0.85,
    });
    this.pushHud(true);
  }

  repairCastle(): void {
    const cost = this.getCastleRepairCost();
    if (this.castleHp >= this.castleMaxHp || this.gold < cost) return;
    this.gold -= cost;
    this.castleHp = Math.min(this.castleMaxHp, this.castleHp + 35);
    soundFx.upgrade(false);
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
    this.pushHud(true);
  }

  getCastleRepairCost(): number {
    return 75 + this.castleFortifyLevel * 15;
  }

  getCastleFortifyCost(): number {
    return 140 + this.castleFortifyLevel * 95;
  }

  sendNextWaveEarly(): void {
    if (this.gameOver) return;
    const earlyBonus = this.spawnQueue.length > 0 || this.monsters.length > 0 ? 35 + this.wave * 6 : 0;
    if (earlyBonus > 0) {
      this.gold += earlyBonus;
      this.effects.push({
        kind: 'text',
        x: (SPAWN_TILE.col + 1.2) * TILE_SIZE,
        y: (SPAWN_TILE.row + 0.8) * TILE_SIZE,
        radius: 0,
        maxRadius: 0,
        color: '#facc15',
        text: `⚡ +${earlyBonus}g`,
        life: 1.0,
        maxLife: 1.0,
      });
    }
    this.triggerNextWave();
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
      runner: { hp: 42, speed: 120, armor: 0, dmg: 3, radius: 9, color: '#fbbf24' },
      orc: { hp: 135, speed: 56, armor: 3, dmg: 5, radius: 14, color: '#fb7185' },
      knight: { hp: 220, speed: 50, armor: 9, dmg: 8, radius: 15, color: '#94a3b8' },
      golem: { hp: 420, speed: 42, armor: 14, dmg: 12, radius: 17, color: '#f97316' },
      boss: { hp: 1450, speed: 38, armor: 16, dmg: 25, radius: 22, color: '#c026d3' },
    };

    const spec = baseSpecs[sp.kind];
    const maxHp = Math.round(spec.hp * sp.hpScale);

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
    const dt = rawDt * this.speedMult;
    this.animTime += dt;
    if (this.castleHitFlash > 0) this.castleHitFlash = Math.max(0, this.castleHitFlash - rawDt * 2.5);

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
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - rawDt * 5);

      if (m.poisonTimer > 0) {
        m.poisonTimer -= dt;
        m.hp -= m.poisonDps * dt;
      }
      if (m.burnTimer > 0) {
        m.burnTimer -= dt;
        m.hp -= m.burnDps * dt;
      }

      if (m.hp <= 0) {
        this.handleMonsterDeath(m, null);
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
        } else {
          m.x += (dx / dist) * moveDist;
          m.y += (dy / dist) * moveDist;
          m.progress = m.pathIndex + (1 - dist / Math.max(1, TILE_SIZE * 8));
          moveDist = 0;
        }
      }

      if (m.pathIndex >= WORLD_WAYPOINTS.length - 1) {
        // Reached castle!
        this.castleHp = Math.max(0, this.castleHp - m.castleDmg);
        this.castleHitFlash = 1;
        soundFx.castleHit();
        this.effects.push({
          kind: 'text',
          x: (CASTLE_TILE.col + 0.5) * TILE_SIZE,
          y: CASTLE_TILE.row * TILE_SIZE,
          radius: 0,
          maxRadius: 0,
          color: '#ef4444',
          text: `-${m.castleDmg} ❤️`,
          life: 0.9,
          maxLife: 0.9,
        });
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
      if (tower.muzzleFlash > 0) tower.muzzleFlash = Math.max(0, tower.muzzleFlash - rawDt * 6);
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

      if (tower.specType === 'laser') {
        if (tower.beamTargetId === primary.id) {
          tower.beamRamp = Math.min(4.5, tower.beamRamp + 0.35);
        } else {
          tower.beamTargetId = primary.id;
          tower.beamRamp = 1;
        }
        const dmg = Math.round(stats.damage * tower.beamRamp);
        this.applyDamage(primary, dmg, tower, true);
        this.effects.push({
          kind: 'lightning',
          points: [
            { x: tower.x, y: tower.y },
            { x: primary.x, y: primary.y },
          ],
          x: tower.x,
          y: tower.y,
          radius: 3,
          maxRadius: 3,
          color: stats.color,
          life: 0.14,
          maxLife: 0.14,
        });
      } else if (tower.specType === 'blizzard' || tower.baseType === 'frost' || tower.specType === 'chrono') {
        // AoE frost pulse around tower / targets
        this.effects.push({
          kind: 'ring',
          x: tower.x,
          y: tower.y,
          radius: 16,
          maxRadius: stats.rangePx,
          color: stats.color,
          life: 0.28,
          maxLife: 0.28,
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
        const pts: { x: number; y: number }[] = [{ x: tower.x, y: tower.y }];
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
              if (near.id !== currTarget.id && Math.hypot(near.x - currTarget.x, near.y - currTarget.y) <= stats.splashPx * 0.65) {
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

        this.effects.push({
          kind: 'lightning',
          points: pts,
          x: tower.x,
          y: tower.y,
          radius: 2,
          maxRadius: 2,
          color: stats.color,
          life: 0.16,
          maxLife: 0.16,
        });
      } else {
        // Projectiles (single or multi-shot)
        for (const tgt of targets) {
          const isCrit = tower.specType === 'sniper' && Math.random() < 0.35;
          const speed = tower.baseType === 'archer' ? 460 : 340;
          const dx = tgt.x - tower.x;
          const dy = tgt.y - tower.y;
          const dist = Math.max(1, Math.hypot(dx, dy));
          this.projectiles.push({
            x: tower.x + (dx / dist) * 14,
            y: tower.y + (dy / dist) * 14,
            vx: (dx / dist) * speed,
            vy: (dy / dist) * speed,
            targetId: tgt.id,
            speed,
            damage: isCrit ? Math.round(stats.damage * 2.1) : stats.damage,
            color: stats.color,
            radius: tower.baseType === 'cannon' ? 5.5 : 3.8,
            splashRadius: stats.splashPx,
            slowAmount: stats.slowAmount,
            freezeChance: stats.freezeChance,
            poisonDps: tower.specType === 'venom' ? stats.poisonDps : 0,
            burnDps: tower.specType === 'inferno' ? stats.poisonDps : 0,
            isArrow: tower.baseType === 'archer',
            isCrit,
            towerId: tower.id,
            life: 1.5,
          });
        }
      }
    }

    // Update projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.projectiles.splice(i, 1);
        continue;
      }

      const tgt = this.monsters.find((m) => m.id === p.targetId);
      if (tgt) {
        const dx = tgt.x - p.x;
        const dy = tgt.y - p.y;
        const d = Math.hypot(dx, dy);
        if (d <= p.speed * dt + tgt.radius + 3) {
          this.detonateProjectile(p, tgt);
          this.projectiles.splice(i, 1);
          continue;
        }
        p.vx = (dx / d) * p.speed;
        p.vy = (dy / d) * p.speed;
      }

      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }

    // Prune dead monsters killed by tower hits this frame
    for (let i = this.monsters.length - 1; i >= 0; i--) {
      if (this.monsters[i].hp <= 0) {
        this.handleMonsterDeath(this.monsters[i], null);
        this.monsters.splice(i, 1);
      }
    }

    // Update effects (cap count to keep 60 FPS with 100s of enemies)
    if (this.effects.length > 140) {
      this.effects.splice(0, this.effects.length - 140);
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.life -= rawDt;
      if (e.life <= 0) {
        this.effects.splice(i, 1);
      }
    }
  }

  private detonateProjectile(p: ProjectileInstance, directTarget: MonsterInstance): void {
    const owner = this.towers.find((t) => t.id === p.towerId) ?? null;

    if (p.splashRadius > 0) {
      soundFx.boom();
      this.effects.push({
        kind: 'ring',
        x: directTarget.x,
        y: directTarget.y,
        radius: 6,
        maxRadius: p.splashRadius,
        color: p.color,
        life: 0.24,
        maxLife: 0.24,
      });

      for (const m of this.monsters) {
        const d = Math.hypot(m.x - directTarget.x, m.y - directTarget.y);
        if (d <= p.splashRadius + m.radius) {
          const falloff = d <= p.splashRadius * 0.4 ? 1 : 0.72;
          this.applyDamage(m, Math.round(p.damage * falloff), owner, false);
          if (p.slowAmount > 0) {
            m.slowAmount = Math.max(m.slowAmount, p.slowAmount);
            m.slowTimer = Math.max(m.slowTimer, 2.5);
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
    } else {
      this.applyDamage(directTarget, p.damage, owner, p.isCrit);
      if (p.slowAmount > 0) {
        directTarget.slowAmount = Math.max(directTarget.slowAmount, p.slowAmount);
        directTarget.slowTimer = Math.max(directTarget.slowTimer, 2.5);
      }
      if (p.poisonDps > 0) {
        directTarget.poisonDps = Math.max(directTarget.poisonDps, p.poisonDps);
        directTarget.poisonTimer = 4.0;
      }
    }
  }

  private applyDamage(m: MonsterInstance, rawDmg: number, owner: TowerInstance | null, ignoreArmor: boolean): void {
    if (m.hp <= 0) return;
    const effectiveArmor = ignoreArmor ? 0 : m.armor;
    const dmg = Math.max(2, rawDmg - effectiveArmor);
    const wasAlive = m.hp > 0;
    m.hp -= dmg;
    m.hitFlash = 1;
    if (ignoreArmor && this.effects.length < 110) {
      this.effects.push({
        kind: 'text',
        x: m.x,
        y: m.y - 12,
        radius: 0,
        maxRadius: 0,
        color: '#fde047',
        text: `💥${dmg}`,
        life: 0.45,
        maxLife: 0.45,
      });
    }
    if (wasAlive && m.hp <= 0 && owner) {
      owner.kills++;
    }
  }

  private handleMonsterDeath(m: MonsterInstance, _owner: TowerInstance | null): void {
    this.gold += m.reward;
    this.kills++;
    this.score += m.reward * 5 + this.wave * 2;
    if (this.effects.length < 110) {
      this.effects.push({
        kind: 'ring',
        x: m.x,
        y: m.y,
        radius: 4,
        maxRadius: m.radius * 1.8,
        color: m.color,
        life: 0.22,
        maxLife: 0.22,
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

  private render(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    const cw = Math.max(1, Math.round(rect.width * dpr));
    const ch = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }

    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0b1322';
    ctx.fillRect(0, 0, rect.width, rect.height);

    this.scale = Math.min(rect.width / WORLD_W, rect.height / WORLD_H);
    this.offsetX = (rect.width - WORLD_W * this.scale) * 0.5;
    this.offsetY = (rect.height - WORLD_H * this.scale) * 0.5;

    ctx.save();
    ctx.translate(this.offsetX, this.offsetY);
    ctx.scale(this.scale, this.scale);

    // Draw grid tiles
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const x = c * TILE_SIZE;
        const y = r * TILE_SIZE;
        const path = isPathTile(c, r);
        if (path) {
          ctx.fillStyle = (c + r) % 2 === 0 ? '#3b332b' : '#352e27';
          ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          ctx.strokeStyle = 'rgba(255,255,255,0.05)';
          ctx.strokeRect(x + 2, y + 2, TILE_SIZE - 4, TILE_SIZE - 4);
        } else {
          ctx.fillStyle = (c + r) % 2 === 0 ? '#162922' : '#193028';
          ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
          if (this.buildTool) {
            ctx.strokeStyle = 'rgba(74, 222, 128, 0.14)';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 3, y + 3, TILE_SIZE - 6, TILE_SIZE - 6);
          }
        }
      }
    }

    // Subtle path center line
    ctx.beginPath();
    WORLD_WAYPOINTS.forEach((p, idx) => {
      if (idx === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.16)';
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 10]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw Spawn Portal
    this.drawSpawnPortal(ctx);

    // Draw Castle at end of path
    this.drawCastle(ctx);

    // Selected tower range circle
    const selected = this.getSelectedTower();
    if (selected) {
      const stats = this.getTowerStats(selected);
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, stats.rangePx, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.72)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw Towers
    for (const tower of this.towers) {
      this.drawTower(ctx, tower, selected?.id === tower.id);
    }

    // Draw Monsters
    for (const m of this.monsters) {
      this.drawMonster(ctx, m);
    }

    // Draw Projectiles
    for (const p of this.projectiles) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.isArrow) {
        const ang = Math.atan2(p.vy, p.vx);
        ctx.rotate(ang);
        ctx.fillStyle = p.isCrit ? '#fde047' : p.color;
        ctx.fillRect(-7, -1.6, 14, 3.2);
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(4, -3.5);
        ctx.lineTo(4, 3.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draw Visual Effects
    for (const e of this.effects) {
      const t = Math.max(0, e.life / e.maxLife);
      if (e.kind === 'ring') {
        const rad = e.radius + (e.maxRadius - e.radius) * (1 - t);
        ctx.beginPath();
        ctx.arc(e.x, e.y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = e.color;
        ctx.globalAlpha = t * 0.75;
        ctx.lineWidth = 2.5;
        ctx.stroke();
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
        ctx.lineWidth = e.radius + 1;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (e.kind === 'text' && e.text) {
        ctx.globalAlpha = t;
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = e.color;
        ctx.fillText(e.text, e.x, e.y - (1 - t) * 18);
        ctx.globalAlpha = 1;
      }
    }

    ctx.restore();
  }

  private drawSpawnPortal(ctx: CanvasRenderingContext2D): void {
    const x = (SPAWN_TILE.col + 0.5) * TILE_SIZE;
    const y = (SPAWN_TILE.row + 0.5) * TILE_SIZE;
    const pulse = 1 + Math.sin(this.animTime * 4) * 0.1;
    ctx.beginPath();
    ctx.arc(x, y, 22 * pulse, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(168, 85, 247, 0.35)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#7e22ce';
    ctx.fill();
    ctx.strokeStyle = '#e9d5ff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  private drawCastle(ctx: CanvasRenderingContext2D): void {
    const cx = (CASTLE_TILE.col + 0.5) * TILE_SIZE;
    const cy = (CASTLE_TILE.row + 0.5) * TILE_SIZE;

    ctx.save();
    ctx.translate(cx, cy);

    // Glow
    ctx.beginPath();
    ctx.arc(0, 0, 32, 0, Math.PI * 2);
    ctx.fillStyle = this.castleHitFlash > 0 ? 'rgba(239,68,68,0.45)' : 'rgba(56,189,248,0.20)';
    ctx.fill();

    // Stone Keep
    ctx.fillStyle = this.castleHitFlash > 0 ? '#ef4444' : '#cbd5e1';
    ctx.fillRect(-23, -15, 46, 30);
    // Side battlements
    ctx.fillStyle = '#94a3b8';
    ctx.fillRect(-26, -21, 13, 36);
    ctx.fillRect(13, -21, 13, 36);
    // Pointed roofs
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.moveTo(-28, -21);
    ctx.lineTo(-19.5, -31);
    ctx.lineTo(-11, -21);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(11, -21);
    ctx.lineTo(19.5, -31);
    ctx.lineTo(28, -21);
    ctx.closePath();
    ctx.fill();
    // Gate
    ctx.fillStyle = '#451a03';
    ctx.fillRect(-8, 1, 16, 14);
    // Flag
    ctx.fillStyle = '#facc15';
    ctx.fillRect(-1, -34, 2, 16);
    ctx.fillRect(1, -34, 10, 6);

    // Castle HP Bar
    const ratio = Math.max(0, this.castleHp / this.castleMaxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(-26, -42, 52, 7);
    ctx.fillStyle = ratio > 0.5 ? '#22c55e' : ratio > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(-25, -41, 50 * ratio, 5);

    ctx.restore();
  }

  private drawTower(ctx: CanvasRenderingContext2D, tower: TowerInstance, isSelected: boolean): void {
    const stats = this.getTowerStats(tower);
    ctx.save();
    ctx.translate(tower.x, tower.y);

    // Selection ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(0, 0, 24, 0, Math.PI * 2);
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Plinth shadow + stone base
    ctx.beginPath();
    ctx.arc(0, 2, 20, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(0, 0, 19, 0, Math.PI * 2);
    ctx.fillStyle = tower.specType ? '#1e293b' : '#334155';
    ctx.fill();

    // Rim color reflects progression (gray -> silver -> gold -> diamond spec!)
    ctx.lineWidth = tower.specType ? 3.2 : 2.2;
    ctx.strokeStyle = tower.specType
      ? tower.specUpgrades >= 10
        ? '#facc15'
        : stats.color
      : tower.baseUpgrades >= 10
        ? '#facc15'
        : tower.baseUpgrades >= 5
          ? '#e2e8f0'
          : '#64748b';
    ctx.stroke();

    // Chrono aura ring
    if (tower.specType === 'chrono') {
      ctx.beginPath();
      ctx.arc(0, 0, 23 + Math.sin(this.animTime * 4) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Rotating turret body
    ctx.save();
    ctx.rotate(tower.angle);
    if (tower.baseType === 'archer') {
      ctx.fillStyle = stats.color;
      ctx.fillRect(-6, -8, 12, 16);
      ctx.strokeStyle = stats.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(3, 0, 10, -Math.PI * 0.45, Math.PI * 0.45);
      ctx.stroke();
      ctx.fillStyle = '#fde047';
      ctx.fillRect(0, -1.5, 13, 3);
    } else if (tower.baseType === 'cannon') {
      ctx.fillStyle = '#475569';
      ctx.fillRect(-9, -9, 16, 18);
      ctx.fillStyle = stats.color;
      ctx.fillRect(2, tower.specType === 'gatling' ? -6 : -4.5, 16, tower.specType === 'gatling' ? 12 : 9);
      if (tower.muzzleFlash > 0) {
        ctx.beginPath();
        ctx.arc(20, 0, 6 * tower.muzzleFlash, 0, Math.PI * 2);
        ctx.fillStyle = '#fef08a';
        ctx.fill();
      }
    } else if (tower.baseType === 'frost') {
      ctx.fillStyle = stats.color;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        const px = Math.cos(a) * 11;
        const py = Math.sin(a) * 11;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = stats.color;
      ctx.beginPath();
      ctx.arc(0, 0, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = stats.accent;
      ctx.fillRect(4, -3, 12, 6);
    }
    ctx.restore();

    // Compact level tag
    const lvlLabel = tower.specType ? `S${tower.specUpgrades}` : `${tower.baseUpgrades}`;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fillRect(-12, 11, 24, 12);
    ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = tower.specType ? '#facc15' : tower.baseUpgrades >= 10 ? '#4ade80' : '#f8fafc';
    ctx.fillText(lvlLabel, 0, 20);

    ctx.restore();
  }

  private drawMonster(ctx: CanvasRenderingContext2D, m: MonsterInstance): void {
    const bob = Math.sin(this.animTime * 9 + m.wobbleOffset) * 1.6;
    ctx.save();
    ctx.translate(m.x, m.y + bob);

    // Shadow
    ctx.beginPath();
    ctx.ellipse(0, m.radius * 0.7, m.radius * 0.9, m.radius * 0.45, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fill();

    // Body color (status tinted)
    let fill = m.color;
    if (m.hitFlash > 0.2) fill = '#ffffff';
    else if (m.freezeTimer > 0) fill = '#67e8f9';
    else if (m.slowTimer > 0) fill = '#38bdf8';
    else if (m.poisonTimer > 0) fill = '#84cc16';

    ctx.beginPath();
    ctx.arc(0, 0, m.radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = m.kind === 'boss' ? '#facc15' : '#0f172a';
    ctx.lineWidth = m.kind === 'boss' ? 2.5 : 1.4;
    ctx.stroke();

    // Horns / crown for orc/knight/boss
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

    // Angry eyes
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(-m.radius * 0.4, -2, 3, 3);
    ctx.fillRect(m.radius * 0.15, -2, 3, 3);

    // HP bar if damaged or boss
    if (m.hp < m.maxHp || m.kind === 'boss') {
      const bw = Math.max(18, m.radius * 2);
      const ratio = Math.max(0, m.hp / m.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(-bw * 0.5, -m.radius - 7, bw, 4);
      ctx.fillStyle = m.kind === 'boss' ? '#f43f5e' : '#22c55e';
      ctx.fillRect(-bw * 0.5, -m.radius - 7, bw * ratio, 4);
    }

    ctx.restore();
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
      gameOver: this.gameOver,
      buildTool: this.buildTool,
      selectedTower: this.getSelectedTower(),
      nextWaveCostBonus: this.spawnQueue.length > 0 || this.monsters.length > 0 ? 35 + this.wave * 6 : 0,
    });
  }
}
