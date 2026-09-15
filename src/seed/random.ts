/**
 * A seeded random source, so the demo shop is the same shop every time.
 *
 * Mulberry32: tiny, fast, and good enough to decide who bought a mug. `Math.random` would
 * make every reseed a different history — different best-sellers, different ratings — and a
 * screenshot in the docs would stop matching the shop a fresh clone builds.
 */
export function createRandom(seed: number) {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    between: (min: number, max: number) => min + next() * (max - min),
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
    chance: (probability: number) => next() < probability,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    weighted: <T>(items: readonly T[], weight: (item: T) => number): T => {
      const total = items.reduce((sum, item) => sum + weight(item), 0);
      let remaining = next() * total;
      for (const item of items) {
        remaining -= weight(item);
        if (remaining < 0) return item;
      }
      return items[items.length - 1]!;
    },
  };
}

export type Random = ReturnType<typeof createRandom>;
