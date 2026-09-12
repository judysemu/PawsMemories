const COMMUNITY_GRID_DEGREES = 0.002; // roughly 220m latitude; prevents house-level disclosure

export function publicCoordinate(value: number): number {
  return Math.round(value / COMMUNITY_GRID_DEGREES) * COMMUNITY_GRID_DEGREES;
}

export function mapCoordinate(value: number, precise: boolean): number {
  return precise ? value : publicCoordinate(value);
}

export const PRESENCE_TTL_MINUTES = 15;
