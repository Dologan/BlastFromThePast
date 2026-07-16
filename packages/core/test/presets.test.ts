import { describe, it, expect } from 'vitest';
import { PRESETS } from '../src/presets.js';

describe('PRESETS', () => {
  it('are well-formed recipes with unique ids', () => {
    const ids = new Set<string>();
    for (const p of PRESETS) {
      expect(p.id).toBeTruthy();
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(Array.isArray(p.definition.filters)).toBe(true);
      expect(p.definition.output.limit).toBeGreaterThan(0);
      expect(['tracks', 'albums']).toContain(p.definition.output.mode);
    }
  });

  it('includes an anniversary-based "on this day" preset', () => {
    const onThisDay = PRESETS.find((p) => p.id === 'on-this-day');
    expect(onThisDay?.definition.filters.some((f) => f.type === 'anniversary')).toBe(true);
  });
});
