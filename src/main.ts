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
  private showPauseModal = false;
  private confirmRestart = false;
  private showScoresModal = false;
  private showMoreGamesModal = false;
  private showServerConfig = false;
  private secretTapCount = 0;
  private secretTapTimer: number | null = null;
  private highscores: TdHighscoreEntry[] = [];
  private scoreStatus: HighscoreStatus = 'no-server';
  private loadingScores = false;
  private draftName: string | null = null;

  // Touch drag-to-preview tracking
  private activeTouchId: number | null = null;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchDragged = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderShell();
    this.initEngine();
    this.bindGlobalKeys();
  }

  private bindGlobalKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.snap?.started && !this.snap.gameOver) {
        if (this.showScoresModal || this.showMoreGamesModal) {
          this.closeAllModals();
        } else if (this.showPauseModal) {
          this.closeAllModals();
        } else {
          this.openPauseModal();
        }
      }
    });
  }

  private syncAutoPause(): void {
    if (!this.engine || !this.snap?.started) return;
    const anyModalOpen = this.showPauseModal || this.showScoresModal || this.showMoreGamesModal;
    this.engine.setPaused(anyModalOpen);
  }

  private openPauseModal(): void {
    this.showPauseModal = true;
    this.confirmRestart = false;
    this.showScoresModal = false;
    this.showMoreGamesModal = false;
    this.syncAutoPause();
    this.renderModal();
  }

  private openScoresModal(): void {
    this.showScoresModal = true;
    this.showPauseModal = false;
    this.showMoreGamesModal = false;
    this.confirmRestart = false;
    this.showServerConfig = false;
    this.secretTapCount = 0;
    this.draftName = getPlayerName();
    this.syncAutoPause();
    this.renderModal();
    void this.loadHighscores();
  }

  private openMoreGamesModal(): void {
    this.showMoreGamesModal = true;
    this.showPauseModal = false;
    this.showScoresModal = false;
    this.confirmRestart = false;
    this.syncAutoPause();
    this.renderModal();
  }

  private closeAllModals(): void {
    this.showPauseModal = false;
    this.confirmRestart = false;
    this.showScoresModal = false;
    this.showMoreGamesModal = false;
    this.showServerConfig = false;
    this.secretTapCount = 0;
    this.draftName = null;
    if (this.secretTapTimer !== null) {
      window.clearTimeout(this.secretTapTimer);
      this.secretTapTimer = null;
    }
    this.syncAutoPause();
    this.renderModal();
  }

  private renderShell(): void {
    this.root.innerHTML = `
      <div class="td-shell">
        <div class="td-stage-wrap">
          <canvas id="td-canvas"></canvas>
          <div class="td-stage-badges" id="td-stage-badges"></div>
          <div class="td-preview-bar" id="td-preview-bar"></div>
        </div>
        <aside class="td-side-panel">
          <div class="td-topbar" id="td-topbar"></div>
          <div class="td-bottom-dock" id="td-bottom-dock"></div>
          <div class="td-inspector-layer" id="td-inspector-layer"></div>
        </aside>
        <div id="td-modal-slot"></div>
      </div>
    `;

    const topbar = this.root.querySelector<HTMLElement>('#td-topbar')!;
    const dock = this.root.querySelector<HTMLElement>('#td-bottom-dock')!;
    const inspector = this.root.querySelector<HTMLElement>('#td-inspector-layer')!;
    const previewBar = this.root.querySelector<HTMLElement>('#td-preview-bar')!;
    const canvas = this.root.querySelector<HTMLCanvasElement>('#td-canvas')!;

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        this.activeTouchId = e.pointerId;
        this.touchStartX = e.clientX;
        this.touchStartY = e.clientY;
        this.touchDragged = false;
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        if (this.activeTouchId === e.pointerId) {
          const dist = Math.hypot(e.clientX - this.touchStartX, e.clientY - this.touchStartY);
          if (dist > 10) {
            this.touchDragged = true;
            this.engine?.handleTouchPreview(e.clientX, e.clientY);
          }
        }
      } else {
        this.engine?.handleCanvasHover(e.clientX, e.clientY);
      }
    });

    canvas.addEventListener('pointerup', (e) => {
      if (e.pointerType === 'touch') {
        if (this.activeTouchId === e.pointerId) {
          this.activeTouchId = null;
          if (this.touchDragged) {
            this.engine?.handleTouchPreview(e.clientX, e.clientY);
          } else {
            this.engine?.handleCanvasTap(e.clientX, e.clientY, true);
          }
          this.touchDragged = false;
        }
      } else if (e.button === 0) {
        this.engine?.handleCanvasTap(e.clientX, e.clientY, false);
      }
    });

    canvas.addEventListener('pointerleave', () => {
      this.engine?.clearHover();
    });

    canvas.addEventListener('pointercancel', () => {
      this.activeTouchId = null;
      this.touchDragged = false;
      this.engine?.clearHover();
    });

    previewBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
      if (!btn || !this.engine) return;
      if (btn.id === 'btn-confirm-preview') {
        this.engine.confirmPreviewBuild();
      } else if (btn.id === 'btn-cancel-preview') {
        this.engine.clearPreview();
      }
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
      } else if (btn.id === 'btn-pause') {
        if (this.snap.started && !this.snap.gameOver) {
          this.openPauseModal();
        }
      } else if (btn.id === 'btn-scores') {
        this.openScoresModal();
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
      if (btn.id === 'btn-repair-castle') {
        this.engine.repairCastle();
        return;
      }
      if (btn.id === 'btn-fortify-castle') {
        this.engine.fortifyCastle();
        return;
      }
    });

    inspector.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('button');
      if (!btn || !this.engine) return;

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
    });
  }

  private initEngine(): void {
    this.engine?.destroy();
    const canvas = this.root.querySelector<HTMLCanvasElement>('#td-canvas')!;
    this.engine = new CastleTdEngine(
      canvas,
      (snap) => {
        const wasStarted = this.snap?.started ?? false;
        this.snap = snap;
        this.renderHud();
        if (!wasStarted && !snap.started) {
          this.renderModal();
        }
      },
      (wave, kills, score) => {
        updateLocalBest(wave, kills, score);
        void submitTdScore(wave, kills, score);
        this.renderModal();
      }
    );
    this.engine.start();
    this.renderModal();
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
      s.started,
      s.paused,
      s.buildTool,
      s.gameOver,
      s.previewTile ? [s.previewTile.col, s.previewTile.row] : null,
      soundFx.muted,
      t ? [t.id, t.baseUpgrades, t.specType, t.specUpgrades, t.targetMode, t.kills] : null,
    ]);
    if (key === this.lastHudKey) return;
    this.lastHudKey = key;

    const topbar = this.root.querySelector<HTMLElement>('#td-topbar')!;
    const stageBadges = this.root.querySelector<HTMLElement>('#td-stage-badges')!;
    const previewBar = this.root.querySelector<HTMLElement>('#td-preview-bar')!;
    const dock = this.root.querySelector<HTMLElement>('#td-bottom-dock')!;
    const inspectorLayer = this.root.querySelector<HTMLElement>('#td-inspector-layer')!;

    const totalRemaining = s.activeMonsters + s.pendingSpawns;

    // Stage corner status badges (enemy counter + pause status)
    if (s.started && !s.gameOver) {
      const enemyBadge =
        totalRemaining > 0
          ? `<span class="stage-badge enemies">👾 ${totalRemaining} left</span>`
          : s.wave === 0
            ? `<span class="stage-badge ready">⚔️ Wave 1 incoming</span>`
            : `<span class="stage-badge clear">✨ Wave ${s.wave} clear</span>`;
      const pauseBadge = s.paused ? `<span class="stage-badge paused">⏸ Paused</span>` : '';
      stageBadges.innerHTML = `${enemyBadge}${pauseBadge}`;
    } else {
      stageBadges.innerHTML = '';
    }

    // Touch preview quick-confirm bar
    if (s.started && !s.paused && !s.gameOver && s.previewTile && s.buildTool) {
      const def = BASE_TOWERS[s.buildTool];
      const canAfford = s.gold >= def.cost;
      previewBar.innerHTML = `
        <div class="preview-pill">
          <button type="button" class="action-btn primary preview-confirm-btn" id="btn-confirm-preview" ${
            canAfford ? '' : 'disabled'
          }>✓ Place ${def.emoji} ${def.name} (${def.cost}g)</button>
          <button type="button" class="mini-btn" id="btn-cancel-preview" title="Cancel">✕</button>
        </div>
      `;
      previewBar.classList.add('visible');
    } else {
      previewBar.innerHTML = '';
      previewBar.classList.remove('visible');
    }

    topbar.innerHTML = `
      <div class="td-stats">
        <span class="stat-pill gold" title="Gold">🪙${s.gold}</span>
        <span class="stat-pill hp" title="Castle HP">❤️${s.castleHp}<span class="hide-xs">/${s.castleMaxHp}</span></span>
        <span class="stat-pill wave" title="Wave ${s.wave}">🌊<span class="hide-xs">W</span>${s.wave}</span>
      </div>
      <div class="td-top-actions">
        <button type="button" class="mini-btn accent" id="btn-next-wave" ${
          !s.started || s.paused || s.gameOver ? 'disabled' : ''
        } title="Send Next Wave${s.nextWaveCostBonus > 0 ? ` (+${s.nextWaveCostBonus}g bonus)` : ''}">
          ▶Next${s.nextWaveCostBonus > 0 ? `<span class="hide-sm"> +${s.nextWaveCostBonus}g</span>` : ''}
        </button>
        <button type="button" class="mini-btn active" id="btn-speed" title="Game Speed">${s.speedMult}×</button>
        <button type="button" class="mini-btn ${s.autoWave ? 'active' : ''}" id="btn-autowave" title="Auto-Wave">Auto</button>
        <button type="button" class="mini-btn hide-xxs" id="btn-mute" title="Toggle Sound">${soundFx.muted ? '🔇' : '🔊'}</button>
        <button type="button" class="mini-btn" id="btn-scores" title="Highscores">🏆</button>
        <button type="button" class="mini-btn" id="btn-pause" title="Pause Menu" ${
          !s.started || s.gameOver ? 'disabled' : ''
        }>⏸</button>
      </div>
    `;

    // Always render fixed-height build dock so canvas NEVER resizes or jumps!
    const baseList = Object.values(BASE_TOWERS);
    dock.innerHTML = `
      <div class="castle-row">
        <span class="castle-towers-count">🗼 ${s.towerCount}/${s.maxTowers}</span>
        <div class="castle-actions">
          <button type="button" class="mini-btn" id="btn-repair-castle" ${
            !s.started || s.castleHp >= s.castleMaxHp || s.gold < s.castleRepairCost ? 'disabled' : ''
          }>🛠️ <span class="hide-xs">Repair </span>+35 (${s.castleRepairCost}g)</button>
          <button type="button" class="mini-btn accent" id="btn-fortify-castle" ${
            !s.started || s.gold < s.castleFortifyCost ? 'disabled' : ''
          }>🏰 <span class="hide-xs">Fortify </span>+40 (${s.castleFortifyCost}g)</button>
        </div>
      </div>
      <div class="td-build-row">
        ${baseList
          .map(
            (b) => `
          <button type="button" class="tower-card-btn ${s.buildTool === b.type ? 'active' : ''} ${
            s.gold < b.cost ? 'poor' : ''
          }" data-build-tool="${b.type}">
            <span class="tower-card-emoji">${b.emoji}</span>
            <span class="tower-card-name">${b.name}</span>
            <span class="tower-card-cost">🪙${b.cost}</span>
          </button>
        `
          )
          .join('')}
      </div>
    `;

    // Overlay tower inspector / Lv.10 specialization sheet without resizing the stage!
    if (t) {
      const stats = this.engine.getTowerStats(t);
      const upCost = this.engine.getUpgradeCost(t);
      const needsSpec = t.baseUpgrades === 10 && t.specType === null;
      const isMax = t.specType !== null && t.specUpgrades >= 10;
      const targetLabel =
        t.targetMode === 'first' ? 'First' : t.targetMode === 'strongest' ? 'Strongest' : 'Closest';

      inspectorLayer.classList.add('open');
      inspectorLayer.innerHTML = `
        <div class="inspector-box">
          <div class="inspector-head">
            <div class="inspector-head-info">
              <div class="inspector-title">${stats.emoji} ${stats.title} • ${
                t.specType ? `Spec ${t.specUpgrades}/10` : `Lv.${t.baseUpgrades}/10`
              }</div>
              <div class="inspector-sub">
                ⚔️ ${stats.damage} • ⚡ ${stats.fireRate.toFixed(1)}/s • 🎯 ${(stats.rangePx / 56).toFixed(1)} • 💀 ${t.kills}
              </div>
            </div>
            <button type="button" class="mini-btn" id="btn-close-sel" title="Close">✕</button>
          </div>

          ${
            needsSpec
              ? `
              <div class="spec-banner">
                ✨ Lv.10 reached! Choose a specialization:
              </div>
              <div class="spec-grid">
                ${getSpecsForBase(t.baseType)
                  .map(
                    (sp) => `
                  <button type="button" class="spec-btn spec-card ${s.gold < sp.cost ? 'poor' : ''}" data-spec-id="${sp.id}">
                    <span class="spec-emoji">${sp.emoji}</span>
                    <strong>${sp.name}</strong>
                    <span class="spec-cost">🪙 ${sp.cost}</span>
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
                      ⬆️ Up (${t.specType ? `${t.specUpgrades + 1}/10` : `${t.baseUpgrades + 1}/10`}) • 🪙${upCost}
                    </button>
                    <button type="button" class="action-btn compact-btn" id="btn-up-5" ${s.gold < upCost ? 'disabled' : ''}>
                      5×
                    </button>
                  `
                }
                <button type="button" class="action-btn compact-btn" id="btn-target-mode">🎯 ${targetLabel}</button>
                <button type="button" class="action-btn danger" id="btn-sell-tower" title="Sell Tower">💰+${Math.round(
                  t.totalSpent * 0.72
                )}</button>
              </div>
            `
          }
        </div>
      `;
    } else {
      inspectorLayer.classList.remove('open');
      inspectorLayer.innerHTML = '';
    }
  }

  private renderModal(): void {
    const slot = this.root.querySelector<HTMLElement>('#td-modal-slot')!;
    const s = this.snap;

    // 1. Game Over modal
    if (s?.gameOver) {
      const best = getLocalBest();
      slot.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-card">
            <h2 class="modal-title">💥 Castle Fallen!</h2>
            <div class="modal-subtitle">
              You defended the keep until <strong>Wave ${s.wave}</strong>!
            </div>
            <div class="td-stats">
              <span class="stat-pill wave">🌊 Wave: ${s.wave}</span>
              <span class="stat-pill">💀 Kills: ${s.kills}</span>
              <span class="stat-pill gold">⭐ Score: ${s.score}</span>
            </div>
            <div class="modal-meta">
              Personal best: Wave ${best.bestWave} • ${best.bestKills} kills • ${best.bestScore} pts
            </div>
            <button type="button" class="action-btn primary" id="btn-restart-td">🔄 Play Again</button>
            <div class="modal-btn-row">
              <button type="button" class="action-btn" id="btn-go-scores">🏆 Highscores</button>
              <button type="button" class="action-btn" id="btn-go-more">🎮 More Games</button>
            </div>
          </div>
        </div>
      `;
      slot.querySelector('#btn-restart-td')?.addEventListener('click', () => {
        this.engine?.resetGame(true);
        this.closeAllModals();
      });
      slot.querySelector('#btn-go-scores')?.addEventListener('click', () => {
        this.openScoresModal();
      });
      slot.querySelector('#btn-go-more')?.addEventListener('click', () => {
        this.openMoreGamesModal();
      });
      return;
    }

    // 2. Highscores & Settings modal
    if (this.showScoresModal) {
      const best = getLocalBest();
      const currentName = this.draftName ?? getPlayerName();
      slot.innerHTML = `
        <div class="modal-backdrop" id="td-scores-bg">
          <div class="modal-card">
            <div class="modal-header-row">
              <h2 id="td-scores-heading" class="modal-title">🏆 Highscores</h2>
              <button type="button" class="mini-btn" id="btn-close-scores" title="Close">✕</button>
            </div>
            <div class="modal-meta">
              Best Wave: <strong>${best.bestWave}</strong> • Most Kills: <strong>${best.bestKills}</strong> • Best Score: <strong>${best.bestScore}</strong>
            </div>
            <label class="modal-field-label">Player Name
              <input id="inp-td-name" class="name-input" maxlength="20" value="${escapeHtml(currentName)}" />
            </label>
            ${
              this.showServerConfig
                ? `<label class="modal-field-label">Leaderboard Server URL
                    <input id="inp-td-api" class="name-input" placeholder="https://example.com" value="${escapeHtml(getApiUrl())}" />
                  </label>`
                : ''
            }
            <button type="button" class="action-btn primary" id="btn-save-td-cfg">Save</button>
            <div class="modal-section-title">Global Leaderboard</div>
            <div class="scores-list">
              ${
                this.loadingScores
                  ? '<span class="modal-meta">⏳ Connecting...</span>'
                  : this.scoreStatus === 'no-server'
                    ? '<span class="modal-meta">Server coming soon — playing in offline mode.</span>'
                    : this.scoreStatus === 'offline'
                      ? '<span class="modal-meta">Offline mode — unable to load scores right now.</span>'
                      : this.highscores.length === 0
                        ? '<span class="modal-meta">No scores yet. Claim the top spot!</span>'
                        : this.highscores
                            .map(
                              (e) =>
                                `<div class="score-row"><span>#${e.rank} ${escapeHtml(e.playerName)}</span><span>Wave ${e.wave} • ${e.score}</span></div>`
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
        this.closeAllModals();
      });
      slot.querySelector('#td-scores-bg')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'td-scores-bg') {
          this.closeAllModals();
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
      return;
    }

    // 3. More Games by VaelNTN modal (featuring Starforge Survivors)
    if (this.showMoreGamesModal) {
      slot.innerHTML = `
        <div class="modal-backdrop" id="td-more-bg">
          <div class="modal-card">
            <div class="modal-header-row">
              <h2 class="modal-title">🎮 More Games by VaelNTN</h2>
              <button type="button" class="mini-btn" id="btn-close-more" title="Close">✕</button>
            </div>
            <a class="promo-card featured" href="https://github.com/VaelNTN/starforge-survivors" target="_blank" rel="noopener noreferrer">
              <div class="promo-badge">⭐ FEATURED</div>
              <div class="promo-title">🚀 Starforge Survivors</div>
              <div class="promo-desc">Survive endless cosmic swarms, forge weapon evolutions, and conquer the galaxy!</div>
              <div class="promo-link">Play / Get APK →</div>
            </a>
            <a class="promo-card" href="https://github.com/VaelNTN/fish-eater-game" target="_blank" rel="noopener noreferrer">
              <div class="promo-title">🐟 Fish Eater</div>
              <div class="promo-desc">Dive into a 3D reef, eat smaller fish, and outgrow relentless 1% hunters.</div>
            </a>
            <a class="promo-card" href="https://github.com/VaelNTN/arcade-100-hub" target="_blank" rel="noopener noreferrer">
              <div class="promo-title">🕹️ Arcade 100 Hub</div>
              <div class="promo-desc">Explore the full VaelNTN arcade collection in one place.</div>
            </a>
          </div>
        </div>
      `;
      slot.querySelector('#btn-close-more')?.addEventListener('click', () => {
        this.closeAllModals();
      });
      slot.querySelector('#td-more-bg')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'td-more-bg') {
          this.closeAllModals();
        }
      });
      return;
    }

    // 4. Pause Menu modal (with mid-game restart confirmation)
    if (this.showPauseModal && s?.started) {
      slot.innerHTML = `
        <div class="modal-backdrop" id="td-pause-bg">
          <div class="modal-card">
            <div class="modal-header-row">
              <h2 class="modal-title">⏸ Paused</h2>
              <button type="button" class="mini-btn" id="btn-resume-x" title="Resume">✕</button>
            </div>
            <div class="td-stats">
              <span class="stat-pill wave">🌊 Wave ${s.wave}</span>
              <span class="stat-pill">💀 ${s.kills} kills</span>
              <span class="stat-pill gold">⭐ ${s.score}</span>
            </div>
            <button type="button" class="action-btn primary" id="btn-resume-td">▶ Resume Defense</button>
            <button type="button" class="action-btn" id="btn-pause-mute">${
              soundFx.muted ? '🔇 Sound: OFF' : '🔊 Sound: ON'
            }</button>
            <button type="button" class="action-btn" id="btn-pause-scores">🏆 Highscores & Name</button>
            <button type="button" class="action-btn" id="btn-pause-more">🎮 More Games by VaelNTN</button>
            ${
              this.confirmRestart
                ? `
                <div class="confirm-box">
                  <div class="confirm-text">Restart from Wave 1? All current towers will be cleared.</div>
                  <div class="modal-btn-row">
                    <button type="button" class="action-btn danger" id="btn-confirm-restart" style="flex:1;">✓ Yes, Restart</button>
                    <button type="button" class="action-btn" id="btn-cancel-restart">Cancel</button>
                  </div>
                </div>
              `
                : `<button type="button" class="action-btn danger" id="btn-ask-restart" style="width:100%;">🔄 Restart Run</button>`
            }
          </div>
        </div>
      `;
      slot.querySelector('#btn-resume-td')?.addEventListener('click', () => this.closeAllModals());
      slot.querySelector('#btn-resume-x')?.addEventListener('click', () => this.closeAllModals());
      slot.querySelector('#td-pause-bg')?.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).id === 'td-pause-bg') this.closeAllModals();
      });
      slot.querySelector('#btn-pause-mute')?.addEventListener('click', () => {
        soundFx.muted = !soundFx.muted;
        this.lastHudKey = '';
        this.renderHud();
        this.renderModal();
      });
      slot.querySelector('#btn-pause-scores')?.addEventListener('click', () => this.openScoresModal());
      slot.querySelector('#btn-pause-more')?.addEventListener('click', () => this.openMoreGamesModal());
      slot.querySelector('#btn-ask-restart')?.addEventListener('click', () => {
        this.confirmRestart = true;
        this.renderModal();
      });
      slot.querySelector('#btn-cancel-restart')?.addEventListener('click', () => {
        this.confirmRestart = false;
        this.renderModal();
      });
      slot.querySelector('#btn-confirm-restart')?.addEventListener('click', () => {
        this.engine?.resetGame(true);
        this.closeAllModals();
      });
      return;
    }

    // 5. Start / Title Overlay (prevents Wave 1 from auto-launching before player is ready!)
    if (s && !s.started) {
      const best = getLocalBest();
      slot.innerHTML = `
        <div class="modal-backdrop title-backdrop">
          <div class="modal-card title-card">
            <div class="title-crest">🏰</div>
            <h1 class="title-heading">Castle Bastion TD</h1>
            <p class="title-tagline">
              Build 4 tower classes, upgrade to Lv.10, and unlock 12 deadly specializations to hold back endless monster waves.
            </p>
            ${
              best.bestWave > 0
                ? `<div class="td-stats" style="justify-content:center;">
                    <span class="stat-pill wave">🌊 Best Wave ${best.bestWave}</span>
                    <span class="stat-pill gold">⭐ ${best.bestScore}</span>
                  </div>`
                : ''
            }
            <button type="button" class="action-btn primary title-start-btn" id="btn-start-defense">
              ⚔️ Defend Castle
            </button>
            <div class="modal-btn-row">
              <button type="button" class="action-btn" id="btn-title-scores">🏆 Highscores</button>
              <button type="button" class="action-btn" id="btn-title-more">🎮 More Games</button>
            </div>
            <div class="title-tip">Tip: On touch, tap a tile to preview range — tap again to build.</div>
          </div>
        </div>
      `;
      slot.querySelector('#btn-start-defense')?.addEventListener('click', () => {
        soundFx.waveStart();
        this.engine?.startDefense();
        this.renderModal();
      });
      slot.querySelector('#btn-title-scores')?.addEventListener('click', () => this.openScoresModal());
      slot.querySelector('#btn-title-more')?.addEventListener('click', () => this.openMoreGamesModal());
      return;
    }

    slot.innerHTML = '';
  }
}

const appRoot = document.getElementById('app');
if (appRoot) {
  new CastleBastionApp(appRoot);
}
