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

export const TIMING: Record<Source, Timing> = {
  // You, testing with /chat: fast enough to test, slow enough to feel real.
  test: { read: [3000, 9000], burstExtend: 4000, maxWait: 20000, typingBase: 1200, perChar: 35, typingMax: 6000, gap: [800, 2000] },
  // Simulator: quick, so a whole conversation takes a few minutes.
  sim: { read: [800, 2000], burstExtend: 1000, maxWait: 4000, typingBase: 300, perChar: 5, typingMax: 1500, gap: [300, 800] },
  // Real fans (step 3 onwards).
  fanvue: { read: [30000, 150000], burstExtend: 15000, maxWait: 240000, typingBase: 2000, perChar: 60, typingMax: 20000, gap: [1500, 5000] },
};

export const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);

export function typingTime(t: Timing, text: string): number {
  return Math.min(t.typingMax, t.typingBase + t.perChar * text.length) * (0.85 + Math.random() * 0.3);
}
