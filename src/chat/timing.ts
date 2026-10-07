// Human-like rhythm. All times in milliseconds.

import type { Source } from "../db";

export interface Timing {
  /** Pause before she "reads" a new message. */
  read: [number, number];
  /** Each extra message he sends while she hasn't read yet pushes reading back by this much... */
  burstExtend: number;
  /** ...but never longer than this after his first unread message. */
  maxWait: number;
  /** Typing time = base + per character, capped. */
  typingBase: number;
  perChar: number;
  typingMax: number;
  /** Pause between two of her messages in a row. */
  gap: [number, number];
}

export const TIMING: Record<Source | "fanvueFast", Timing> = {
  // You, testing with /chat: fast enough to test, slow enough to feel real.
  test: { read: [3000, 9000], burstExtend: 4000, maxWait: 20000, typingBase: 1200, perChar: 35, typingMax: 6000, gap: [800, 2000] },
  // Simulator: quick, so a whole conversation takes a few minutes.
  sim: { read: [800, 2000], burstExtend: 1000, maxWait: 4000, typingBase: 300, perChar: 5, typingMax: 1500, gap: [300, 800] },
  // Real fans (step 3 onwards).
  fanvue: { read: [15000, 75000], burstExtend: 10000, maxWait: 120000, typingBase: 2000, perChar: 50, typingMax: 15000, gap: [1500, 4000] },
  // Real fans, "fast" reply speed in /sales.
  fanvueFast: { read: [5000, 15000], burstExtend: 5000, maxWait: 30000, typingBase: 1500, perChar: 35, typingMax: 8000, gap: [1000, 2500] },
};

export const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);

export function typingTime(t: Timing, text: string): number {
  return Math.min(t.typingMax, t.typingBase + t.perChar * text.length) * (0.85 + Math.random() * 0.3);
}
