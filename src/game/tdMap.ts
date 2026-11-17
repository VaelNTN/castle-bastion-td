export const GRID_COLS = 11;
export const GRID_ROWS = 15;
export const TILE_SIZE = 56;
export const WORLD_W = GRID_COLS * TILE_SIZE;
export const WORLD_H = GRID_ROWS * TILE_SIZE;

export const PATH_WAYPOINTS: { col: number; row: number }[] = [
  { col: 1, row: 0 },
  { col: 1, row: 2 },
  { col: 9, row: 2 },
  { col: 9, row: 5 },
  { col: 1, row: 5 },
  { col: 1, row: 8 },
  { col: 9, row: 8 },
  { col: 9, row: 11 },
  { col: 2, row: 11 },
  { col: 2, row: 13 },
  { col: 5, row: 13 },
  { col: 5, row: 14 },
];

export const CASTLE_TILE = { col: 5, row: 14 };
export const SPAWN_TILE = { col: 1, row: 0 };

export const PATH_TILE_SET: Set<string> = (() => {
  const s = new Set<string>();
  for (let i = 0; i < PATH_WAYPOINTS.length - 1; i++) {
    const a = PATH_WAYPOINTS[i];
    const b = PATH_WAYPOINTS[i + 1];
    const dc = Math.sign(b.col - a.col);
    const dr = Math.sign(b.row - a.row);
    let c = a.col;
    let r = a.row;
    s.add(`${c},${r}`);
    while (c !== b.col || r !== b.row) {
      c += dc;
      r += dr;
      s.add(`${c},${r}`);
    }
  }
  return s;
})();

export const BUILDABLE_SLOTS_COUNT = GRID_COLS * GRID_ROWS - PATH_TILE_SET.size;

export const WORLD_WAYPOINTS: { x: number; y: number }[] = PATH_WAYPOINTS.map((p) => ({
  x: (p.col + 0.5) * TILE_SIZE,
  y: (p.row + 0.5) * TILE_SIZE,
}));

export function isPathTile(col: number, row: number): boolean {
  return PATH_TILE_SET.has(`${col},${row}`);
}
