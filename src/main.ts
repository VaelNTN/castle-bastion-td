import './style.css';
import {
  fetchTdHighscores,
  getApiUrl,
  getLocalBest,
  getPlayerName,
  setApiUrl,
  setPlayerName,
  submitTdScore,
  TdHighscoreEntry,
  updateLocalBest,
} from './api/highscores';
import { soundFx } from './game/sound';
import { BASE_TOWERS, getSpecsForBase } from './game/tdCatalog';
import { CastleTdEngine, TdUiSnapshot } from './game/tdEngine';
import { BaseTowerType, SpecTowerType } from './game/tdTypes';

class CastleBastionApp {
  private root: HTMLElement;
  private engine: CastleTdEngine | null = null;
  private snap: TdUiSnapshot | null = null;
  private lastHudKey = '';
  private showScoresModal = false;
  private highscores: TdHighscoreEntry[] = [];
  private loadingScores = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderShell();
    this.initEngine();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="td-shell">
        <div class="td-topbar" id="td-topbar"></div>
        <div class="td-stage-wrap">
          <canvas id="td-canvas"></canvas>
        </div>
        <div class="td-bottom-dock" id="td-bottom-dock"></div>
        <div id="td-modal-slot"></div>
      </div>
    `;

    const topbar = this.root.querySelector<HTMLElement>('#td-topbar')!;
    const dock = this.root.querySelector<HTMLElement>('#td-bottom-dock')!;
    const canvas = this.root.querySelector<HTMLCanvasElement>('#td-canvas')!;

    canvas.addEventListener('click', (e) => {
      this.engine?.handleCanvasTap(e.clientX, e.clientY);
    });

    topbar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
      if (!btn || !this.engine || !this.snap) return;

      if (btn.id === 'btn-speed') {
        const next: 1 | 2 | 4 = this.snap.speedMult === 1 ? 2 : this.snap.speedMult === 2 ? 4 : 1;
        this.engine.setSpeedMult(next);
      } else if (btn.id === 'btn-autowave') {
        this.engine.setAutoWave(!this.snap.autoWave);
      } else if (btn.id === 'btn-mute') {
        soundFx.muted = !soundFx.muted;
        this.lastHudKey = '';
        this.renderHud();
      } else if (btn.id === 'btn-scores') {
        this.showScoresModal = true;
        this.renderModal();
        void this.loadHighscores();
      } else if (btn.id === 'btn-next-wave') {
        this.engine.sendNextWaveEarly();
      }
    });

    dock.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
      if (!btn || !this.engine) return;

      const tool = btn.dataset.buildTool as BaseTowerType | undefined;
      if (tool) {
        this.engine.setBuildTool(this.snap?.buildTool === tool ? null : tool);
        return;
      }
      if (btn.id === 'btn-close-sel') {
        this.engine.selectTower(null);
        return;
      }
      if (btn.id === 'btn-up-1') {
        this.engine.upgradeSelectedTower(1);
        return;
      }
      if (btn.id === 'btn-up-5') {
        this.engine.upgradeSelectedTower(5);
        return;
      }
      const specId = btn.dataset.specId as SpecTowerType | undefined;
      if (specId) {
        this.engine.specializeSelectedTower(specId);
        return;
      }
      if (btn.id === 'btn-target-mode') {
        this.engine.cycleSelectedTargetMode();
        return;
      }
      if (btn.id === 'btn-sell-tower') {
        this.engine.sellSelectedTower();
        return;
      }
      if (btn.id === 'btn-repair-castle') {
        this.engine.repairCastle();
        return;
      }
      if (btn.id === 'btn-fortify-castle') {
        this.engine.fortifyCastle();
        return;
      }
    });
  }

  private initEngine(): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>('#td-canvas')!;
    this.engine = new CastleTdEngine(
      canvas,
      (snap) => {
        this.snap = snap;
        this.renderHud();
      },
      (wave, kills, score) => {
        updateLocalBest(wave, kills, score);
        void submitTdScore(wave, kills, score);
        this.renderModal();
      }
    );
    this.engine.start();
  }

  private async loadHighscores(): Promise<void> {
    this.loadingScores = true;
    this.renderModal();
    this.highscores = await fetchTdHighscores();
    this.loadingScores = false;
    this.renderModal();
  }

  private renderHud(): void {
    if (!this.snap || !this.engine) return;
    const s = this.snap;
    const t = s.selectedTower;
    const key = JSON.stringify([
      s.gold,
      s.castleHp,
      s.castleMaxHp,
      s.wave,
      s.kills,
      s.towerCount,
      s.activeMonsters,
      s.pendingSpawns,
      s.speedMult,
      s.autoWave,
      s.buildTool,
      s.gameOver,
      soundFx.muted,
      t ? [t.id, t.baseUpgrades, t.specType, t.specUpgrades, t.targetMode, t.kills] : null,
    ]);
    if (key === this.lastHudKey) return;
    this.lastHudKey = key;

    const topbar = this.root.querySelector<HTMLElement>('#td-topbar')!;
    const totalRemaining = s.activeMonsters + s.pendingSpawns;

    topbar.innerHTML = `
      <div class="td-stats">
        <span class="stat-pill gold">🪙 ${s.gold}</span>
        <span class="stat-pill hp">🏰 ${s.castleHp}/${s.castleMaxHp}</span>
        <span class="stat-pill wave">🌊 Golf ${s.wave} (${totalRemaining})</span>
        <span class="stat-pill">🗼 ${s.towerCount}/${s.maxTowers}</span>
      </div>
      <div class="td-top-actions">
        <button type="button" class="mini-btn accent" id="btn-next-wave" title="Volgende golf meteen starten">
          ⚔️ +Golf${s.nextWaveCostBonus > 0 ? ` (+${s.nextWaveCostBonus}g)` : ''}
        </button>
        <button type="button" class="mini-btn active" id="btn-speed">${s.speedMult}×</button>
        <button type="button" class="mini-btn ${s.autoWave ? 'active' : ''}" id="btn-autowave">∞</button>
        <button type="button" class="mini-btn" id="btn-mute">${soundFx.muted ? '🔇' : '🔊'}</button>
        <button type="button" class="mini-btn" id="btn-scores">🏆</button>
      </div>
    `;

    const dock = this.root.querySelector<HTMLElement>('#td-bottom-dock')!;
    if (t) {
      const stats = this.engine.getTowerStats(t);
      const upCost = this.engine.getUpgradeCost(t);
      const needsSpec = t.baseUpgrades === 10 && t.specType === null;
      const isMax = t.specType !== null && t.specUpgrades >= 10;
      const targetLabel =
        t.targetMode === 'first' ? 'Eerste' : t.targetMode === 'strongest' ? 'Sterkste' : 'Dichtbij';

      dock.innerHTML = `
        <div class="inspector-box">
          <div class="inspector-head">
            <div>
              <div class="inspector-title">${stats.emoji} ${stats.title} • ${
                t.specType
                  ? `Spec ${t.specUpgrades}/10`
                  : `Basis ${t.baseUpgrades}/10`
              }</div>
              <div class="inspector-sub">
                ⚔️ ${stats.damage} dmg • ⚡ ${stats.fireRate.toFixed(1)}/s • 🎯 ${(stats.rangePx / 56).toFixed(1)} • 💀 ${t.kills}
              </div>
            </div>
            <button type="button" class="mini-btn" id="btn-close-sel">✕</button>
          </div>

          ${
            needsSpec
              ? `
              <div style="font-size:11px;font-weight:800;color:#e9d5ff;">
                ✨ Basis 10/10 bereikt! Kies 1 van de 3 specialisaties (met nog eens 10 upgrades):
              </div>
              <div class="spec-grid">
                ${getSpecsForBase(t.baseType)
                  .map(
                    (sp) => `
                  <button type="button" class="spec-btn ${s.gold < sp.cost ? 'poor' : ''}" data-spec-id="${sp.id}">
                    <span style="font-size:16px;">${sp.emoji}</span>
                    <strong>${sp.name}</strong>
                    <span style="color:var(--gold);font-weight:800;">🪙 ${sp.cost}</span>
                    <span style="font-size:9px;color:var(--muted);">${sp.desc}</span>
                  </button>
                `
                  )
                  .join('')}
              </div>
            `
              : `
              <div class="inspector-actions">
                ${
                  isMax
                    ? `<button type="button" class="action-btn" disabled>👑 MAX LEVEL (10/10 + 10/10)</button>`
                    : `
                    <button type="button" class="action-btn primary" id="btn-up-1" ${s.gold < upCost ? 'disabled' : ''}>
                      ⬆️ Upgrade (${t.specType ? `${t.specUpgrades + 1}/10 Spec` : `${t.baseUpgrades + 1}/10`}) • 🪙 ${upCost}
                    </button>
                    <button type="button" class="action-btn" id="btn-up-5" style="flex:0 0 auto;" ${s.gold < upCost ? 'disabled' : ''}>
                      5×
                    </button>
                  `
                }
                <button type="button" class="action-btn" id="btn-target-mode" style="flex:0 0 auto;">🎯 ${targetLabel}</button>
                <button type="button" class="action-btn danger" id="btn-sell-tower">💰 +${Math.round(t.totalSpent * 0.72)}</button>
              </div>
            `
          }
        </div>
      `;
      return;
    }

    const baseList = Object.values(BASE_TOWERS);
    dock.innerHTML = `
      <div class="castle-row">
        <span style="font-size:11px;color:var(--muted);">Tik op een groen vakje om torens te bouwen (50+ mogelijk!)</span>
        <div style="display:flex;gap:5px;">
          <button type="button" class="mini-btn" id="btn-repair-castle" ${
            s.castleHp >= s.castleMaxHp || s.gold < s.castleRepairCost ? 'disabled' : ''
          }>🛠️ +35 HP (${s.castleRepairCost}g)</button>
          <button type="button" class="mini-btn accent" id="btn-fortify-castle" ${
            s.gold < s.castleFortifyCost ? 'disabled' : ''
          }>🏰 +40 Max (${s.castleFortifyCost}g)</button>
        </div>
      </div>
      <div class="td-build-row">
        ${baseList
          .map(
            (b) => `
          <button type="button" class="tower-card-btn ${s.buildTool === b.type ? 'active' : ''} ${
            s.gold < b.cost ? 'poor' : ''
          }" data-build-tool="${b.type}">
            <span style="font-size:17px;">${b.emoji}</span>
            <span>${b.name}</span>
            <span style="color:var(--gold);">🪙 ${b.cost}</span>
          </button>
        `
          )
          .join('')}
      </div>
    `;
  }

  private renderModal(): void {
    const slot = this.root.querySelector<HTMLElement>('#td-modal-slot')!;
    const s = this.snap;

    if (s?.gameOver) {
      const best = getLocalBest();
      slot.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-card">
            <h2 style="margin:0;">💥 Kasteel Gevallen!</h2>
            <div style="font-size:13px;color:var(--muted);">
              Je hebt je kasteel verdedigd tot <strong>Golf ${s.wave}</strong>!
            </div>
            <div class="td-stats">
              <span class="stat-pill wave">🌊 Golf: ${s.wave}</span>
              <span class="stat-pill">💀 Kills: ${s.kills}</span>
              <span class="stat-pill gold">⭐ Score: ${s.score}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);">
              Persoonlijk record: Golf ${best.bestWave} • ${best.bestKills} kills
            </div>
            <button type="button" class="action-btn primary" id="btn-restart-td">🔄 Opnieuw Spelen</button>
          </div>
        </div>
      `;
      slot.querySelector('#btn-restart-td')?.addEventListener('click', () => {
        this.engine?.resetGame();
        slot.innerHTML = '';
      });
      return;
    }

    if (!this.showScoresModal) {
      slot.innerHTML = '';
      return;
    }

    const best = getLocalBest();
    slot.innerHTML = `
      <div class="modal-backdrop" id="td-scores-bg">
        <div class="modal-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h2 style="margin:0;">🏆 Records & Instellingen</h2>
            <button type="button" class="mini-btn" id="btn-close-scores">✕</button>
          </div>
          <div style="font-size:12px;color:var(--muted);">
            Beste golf: <strong>${best.bestWave}</strong> • Meeste kills: <strong>${best.bestKills}</strong> • Beste score: <strong>${best.bestScore}</strong>
          </div>
          <label style="font-size:12px;">Spelersnaam
            <input id="inp-td-name" class="name-input" value="${getPlayerName().replace(/"/g, '&quot;')}" />
          </label>
          <label style="font-size:12px;">Highscore Server URL (optioneel)
            <input id="inp-td-api" class="name-input" placeholder="https://arcade-highscores-api....workers.dev" value="${getApiUrl().replace(/"/g, '&quot;')}" />
          </label>
          <button type="button" class="action-btn primary" id="btn-save-td-cfg">Opslaan</button>
          <div style="font-size:12px;font-weight:800;margin-top:4px;">Wereldwijde Top</div>
          <div style="max-height:180px;overflow-y:auto;font-size:12px;display:flex;flex-direction:column;gap:4px;">
            ${
              this.loadingScores
                ? '⏳ Laden...'
                : this.highscores.length === 0
                  ? '<span style="color:var(--muted);">Nog geen online scores (of geen server URL ingesteld).</span>'
                  : this.highscores
                      .map(
                        (e) =>
                          `<div style="display:flex;justify-content:space-between;background:var(--card-2);padding:5px 8px;border-radius:8px;"><span>#${e.rank} ${e.playerName}</span><span>Golf ${e.wave} • ${e.score}</span></div>`
                      )
                      .join('')
            }
          </div>
        </div>
      </div>
    `;

    slot.querySelector('#btn-close-scores')?.addEventListener('click', () => {
      this.showScoresModal = false;
      this.renderModal();
    });
    slot.querySelector('#td-scores-bg')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'td-scores-bg') {
        this.showScoresModal = false;
        this.renderModal();
      }
    });
    slot.querySelector('#btn-save-td-cfg')?.addEventListener('click', () => {
      const nameVal = slot.querySelector<HTMLInputElement>('#inp-td-name')?.value || 'Kasteelheer';
      const apiVal = slot.querySelector<HTMLInputElement>('#inp-td-api')?.value || '';
      setPlayerName(nameVal);
      setApiUrl(apiVal);
      void this.loadHighscores();
    });
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new CastleBastionApp(appRoot);
}
