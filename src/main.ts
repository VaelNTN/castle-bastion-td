import './style.css';
import {
  fetchTdHighscores,
  getApiUrl,
  getLocalBest,
  getPlayerName,
  HighscoreStatus,
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class CastleBastionApp {
  private root: HTMLElement;
  private engine: CastleTdEngine | null = null;
  private snap: TdUiSnapshot | null = null;
  private lastHudKey = '';
  private showScoresModal = false;
  private showServerConfig = false;
  private secretTapCount = 0;
  private secretTapTimer: number | null = null;
  private highscores: TdHighscoreEntry[] = [];
  private scoreStatus: HighscoreStatus = 'no-server';
  private loadingScores = false;
  private draftName: string | null = null;

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
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') {
        this.engine?.handleCanvasHover(e.clientX, e.clientY);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.engine?.clearHover();
    });
    canvas.addEventListener('pointercancel', () => {
      this.engine?.clearHover();
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
        this.showServerConfig = false;
        this.secretTapCount = 0;
        this.draftName = getPlayerName();
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
    this.engine?.destroy();
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
    const res = await fetchTdHighscores();
    this.highscores = res.entries;
    this.scoreStatus = res.status;
    this.loadingScores = false;
    this.renderModal();
  }

  private closeScoresModal(): void {
    this.showScoresModal = false;
    this.showServerConfig = false;
    this.secretTapCount = 0;
    this.draftName = null;
    if (this.secretTapTimer !== null) {
      window.clearTimeout(this.secretTapTimer);
      this.secretTapTimer = null;
    }
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
        <span class="stat-pill gold" title="Gold">🪙${s.gold}</span>
        <span class="stat-pill hp" title="Castle HP">❤️${s.castleHp}<span class="hide-xs">/${s.castleMaxHp}</span></span>
        <span class="stat-pill wave" title="Wave ${s.wave} (${totalRemaining} remaining)">🌊<span class="hide-xs">Wave </span>${s.wave}</span>
      </div>
      <div class="td-top-actions">
        <button type="button" class="mini-btn accent" id="btn-next-wave" title="Next Wave${s.nextWaveCostBonus > 0 ? ` (+${s.nextWaveCostBonus}g bonus)` : ''}">
          ▶Next${s.nextWaveCostBonus > 0 ? `<span class="hide-sm"> +${s.nextWaveCostBonus}g</span>` : ''}
        </button>
        <button type="button" class="mini-btn active" id="btn-speed" title="Game Speed">${s.speedMult}×</button>
        <button type="button" class="mini-btn ${s.autoWave ? 'active' : ''}" id="btn-autowave" title="Auto-Wave">Auto</button>
        <button type="button" class="mini-btn" id="btn-mute" title="Toggle Sound">${soundFx.muted ? '🔇' : '🔊'}</button>
        <button type="button" class="mini-btn" id="btn-scores" title="Highscores">🏆</button>
      </div>
    `;

    const dock = this.root.querySelector<HTMLElement>('#td-bottom-dock')!;
    if (t) {
      const stats = this.engine.getTowerStats(t);
      const upCost = this.engine.getUpgradeCost(t);
      const needsSpec = t.baseUpgrades === 10 && t.specType === null;
      const isMax = t.specType !== null && t.specUpgrades >= 10;
      const targetLabel =
        t.targetMode === 'first' ? 'First' : t.targetMode === 'strongest' ? 'Strongest' : 'Closest';

      dock.innerHTML = `
        <div class="inspector-box">
          <div class="inspector-head">
            <div>
              <div class="inspector-title">${stats.emoji} ${stats.title} • ${
                t.specType
                  ? `Spec ${t.specUpgrades}/10`
                  : `Base ${t.baseUpgrades}/10`
              }</div>
              <div class="inspector-sub">
                ⚔️ ${stats.damage} dmg • ⚡ ${stats.fireRate.toFixed(1)}/s • 🎯 ${(stats.rangePx / 56).toFixed(1)} • 💀 ${t.kills}
              </div>
            </div>
            <button type="button" class="mini-btn" id="btn-close-sel" title="Close">✕</button>
          </div>

          ${
            needsSpec
              ? `
              <div style="font-size:11px;font-weight:800;color:#e9d5ff;">
                ✨ Base 10/10 reached! Choose a specialization:
              </div>
              <div class="spec-grid">
                ${getSpecsForBase(t.baseType)
                  .map(
                    (sp) => `
                  <button type="button" class="spec-btn spec-card ${s.gold < sp.cost ? 'poor' : ''}" data-spec-id="${sp.id}">
                    <span style="font-size:16px;">${sp.emoji}</span>
                    <strong>${sp.name}</strong>
                    <span style="color:var(--gold);font-weight:800;">🪙 ${sp.cost}</span>
                    <span class="spec-card-desc">${sp.desc}</span>
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
                    ? `<button type="button" class="action-btn" disabled>👑 MAX LEVEL</button>`
                    : `
                    <button type="button" class="action-btn primary" id="btn-up-1" ${s.gold < upCost ? 'disabled' : ''}>
                      ⬆️ Upgrade (${t.specType ? `${t.specUpgrades + 1}/10` : `${t.baseUpgrades + 1}/10`}) • 🪙 ${upCost}
                    </button>
                    <button type="button" class="action-btn" id="btn-up-5" style="flex:0 0 auto;" ${s.gold < upCost ? 'disabled' : ''}>
                      5×
                    </button>
                  `
                }
                <button type="button" class="action-btn" id="btn-target-mode" style="flex:0 0 auto;">🎯 ${targetLabel}</button>
                <button type="button" class="action-btn danger" id="btn-sell-tower" title="Sell Tower">💰 +${Math.round(t.totalSpent * 0.72)}</button>
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
        <span class="castle-towers-count">🗼 Towers ${s.towerCount}/${s.maxTowers}</span>
        <div class="castle-actions">
          <button type="button" class="mini-btn" id="btn-repair-castle" ${
            s.castleHp >= s.castleMaxHp || s.gold < s.castleRepairCost ? 'disabled' : ''
          }>🛠️ Repair +35 HP (${s.castleRepairCost}g)</button>
          <button type="button" class="mini-btn accent" id="btn-fortify-castle" ${
            s.gold < s.castleFortifyCost ? 'disabled' : ''
          }>🏰 Fortify +40 Max (${s.castleFortifyCost}g)</button>
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
            <h2 style="margin:0;">💥 Castle Fallen!</h2>
            <div style="font-size:13px;color:var(--muted);">
              You defended your castle until <strong>Wave ${s.wave}</strong>!
            </div>
            <div class="td-stats">
              <span class="stat-pill wave">🌊 Wave: ${s.wave}</span>
              <span class="stat-pill">💀 Kills: ${s.kills}</span>
              <span class="stat-pill gold">⭐ Score: ${s.score}</span>
            </div>
            <div style="font-size:12px;color:var(--muted);">
              Personal best: Wave ${best.bestWave} • ${best.bestKills} kills
            </div>
            <button type="button" class="action-btn primary" id="btn-restart-td">🔄 Play Again</button>
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
    const currentName = this.draftName ?? getPlayerName();
    slot.innerHTML = `
      <div class="modal-backdrop" id="td-scores-bg">
        <div class="modal-card">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <h2 id="td-scores-heading" style="margin:0;">🏆 Highscores</h2>
            <button type="button" class="mini-btn" id="btn-close-scores" title="Close">✕</button>
          </div>
          <div style="font-size:12px;color:var(--muted);">
            Best Wave: <strong>${best.bestWave}</strong> • Most Kills: <strong>${best.bestKills}</strong> • Best Score: <strong>${best.bestScore}</strong>
          </div>
          <label style="font-size:12px;">Player Name
            <input id="inp-td-name" class="name-input" maxlength="20" value="${escapeHtml(currentName)}" />
          </label>
          ${
            this.showServerConfig
              ? `<label style="font-size:12px;">Leaderboard Server URL
                  <input id="inp-td-api" class="name-input" placeholder="https://example.com" value="${escapeHtml(getApiUrl())}" />
                </label>`
              : ''
          }
          <button type="button" class="action-btn primary" id="btn-save-td-cfg">Save</button>
          <div style="font-size:12px;font-weight:800;margin-top:4px;">Global Leaderboard</div>
          <div style="max-height:180px;overflow-y:auto;font-size:12px;display:flex;flex-direction:column;gap:4px;">
            ${
              this.loadingScores
                ? '<span style="color:var(--muted);">⏳ Connecting...</span>'
                : this.scoreStatus === 'no-server'
                  ? '<span style="color:var(--muted);">Server coming soon — playing in offline mode.</span>'
                  : this.scoreStatus === 'offline'
                    ? '<span style="color:var(--muted);">Offline mode — unable to load scores right now.</span>'
                    : this.highscores.length === 0
                      ? '<span style="color:var(--muted);">No scores yet. Claim the top spot!</span>'
                      : this.highscores
                          .map(
                            (e) =>
                              `<div style="display:flex;justify-content:space-between;background:var(--card-2);padding:5px 8px;border-radius:8px;"><span>#${e.rank} ${escapeHtml(e.playerName)}</span><span>Wave ${e.wave} • ${e.score}</span></div>`
                          )
                          .join('')
            }
          </div>
        </div>
      </div>
    `;

    const nameInput = slot.querySelector<HTMLInputElement>('#inp-td-name');
    nameInput?.addEventListener('input', () => {
      this.draftName = nameInput.value;
    });

    slot.querySelector('#td-scores-heading')?.addEventListener('click', () => {
      this.secretTapCount++;
      if (this.secretTapTimer !== null) {
        window.clearTimeout(this.secretTapTimer);
      }
      if (this.secretTapCount >= 5) {
        this.secretTapCount = 0;
        this.secretTapTimer = null;
        this.showServerConfig = !this.showServerConfig;
        this.renderModal();
        return;
      }
      this.secretTapTimer = window.setTimeout(() => {
        this.secretTapCount = 0;
        this.secretTapTimer = null;
      }, 2500);
    });

    slot.querySelector('#btn-close-scores')?.addEventListener('click', () => {
      this.closeScoresModal();
    });
    slot.querySelector('#td-scores-bg')?.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).id === 'td-scores-bg') {
        this.closeScoresModal();
      }
    });
    slot.querySelector('#btn-save-td-cfg')?.addEventListener('click', () => {
      const nameVal = slot.querySelector<HTMLInputElement>('#inp-td-name')?.value ?? 'Commander';
      setPlayerName(nameVal);
      this.draftName = getPlayerName();
      if (this.showServerConfig) {
        const apiVal = slot.querySelector<HTMLInputElement>('#inp-td-api')?.value ?? '';
        setApiUrl(apiVal);
      }
      void this.loadHighscores();
    });
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new CastleBastionApp(appRoot);
}
