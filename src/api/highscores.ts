export interface TdHighscoreEntry {
  rank: number;
  deviceId: string;
  playerName: string;
  wave: number;
  kills: number;
  score: number;
  updatedAt: string;
}

const KEY_DEVICE = 'castle_bastion_device_id_v1';
const KEY_NAME = 'castle_bastion_player_name_v1';
const KEY_API = 'castle_bastion_api_url_v1';
const KEY_LOCAL_BEST = 'castle_bastion_local_best_v1';

export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(KEY_DEVICE);
    if (!id) {
      id = `td-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
      localStorage.setItem(KEY_DEVICE, id);
    }
    return id;
  } catch {
    return 'td-local';
  }
}

export function getPlayerName(): string {
  try {
    return localStorage.getItem(KEY_NAME) || 'Kasteelheer';
  } catch {
    return 'Kasteelheer';
  }
}

export function setPlayerName(name: string): void {
  try {
    localStorage.setItem(KEY_NAME, name.trim().slice(0, 20) || 'Kasteelheer');
  } catch {
    // ignore
  }
}

export function getApiUrl(): string {
  try {
    const saved = localStorage.getItem(KEY_API);
    if (saved) return saved;
  } catch {
    // ignore
  }
  const envUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL || '';
  return envUrl.trim().replace(/\/+$/, '');
}

export function setApiUrl(url: string): void {
  try {
    localStorage.setItem(KEY_API, url.trim().replace(/\/+$/, ''));
  } catch {
    // ignore
  }
}

export interface LocalBest {
  bestWave: number;
  bestKills: number;
  bestScore: number;
}

export function getLocalBest(): LocalBest {
  try {
    const raw = localStorage.getItem(KEY_LOCAL_BEST);
    if (raw) return JSON.parse(raw) as LocalBest;
  } catch {
    // ignore
  }
  return { bestWave: 0, bestKills: 0, bestScore: 0 };
}

export function updateLocalBest(wave: number, kills: number, score: number): LocalBest {
  const prev = getLocalBest();
  const next: LocalBest = {
    bestWave: Math.max(prev.bestWave, wave),
    bestKills: Math.max(prev.bestKills, kills),
    bestScore: Math.max(prev.bestScore, score),
  };
  try {
    localStorage.setItem(KEY_LOCAL_BEST, JSON.stringify(next));
  } catch {
    // ignore
  }
  return next;
}

export async function submitTdScore(wave: number, kills: number, score: number): Promise<void> {
  const base = getApiUrl();
  if (!base || score <= 0) return;
  try {
    await fetch(`${base}/api/castle-bastion/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: getDeviceId(),
        playerName: getPlayerName(),
        wave,
        kills,
        score,
      }),
    });
  } catch {
    // offline
  }
}

export async function fetchTdHighscores(): Promise<TdHighscoreEntry[]> {
  const base = getApiUrl();
  if (!base) return [];
  try {
    const res = await fetch(`${base}/api/castle-bastion/highscores?limit=30&deviceId=${encodeURIComponent(getDeviceId())}`);
    if (!res.ok) return [];
    const data = (await res.json()) as { entries?: TdHighscoreEntry[] };
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}
