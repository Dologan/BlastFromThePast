import { describe, it, expect } from 'vitest';
import { defaultNameTemplate, renderTemplate, timeValues, validateOrganisePlan } from '../src/organise.js';
import type { Recipe } from '../src/recipe.js';

const base: Recipe = { filters: [{ type: 'likedInDays', days: 730 }], output: { mode: 'tracks', sort: 'random', limit: 50 } };

describe('renderTemplate', () => {
  it('substitutes variables, renders missing ones empty and tidies spacing', () => {
    expect(renderTemplate('{year}-{month} {genre}', { year: '2025', month: '03', genre: 'Metal' })).toBe('2025-03 Metal');
    expect(renderTemplate('{monthName}  {genre} ', { genre: 'Jazz' })).toBe('Jazz');
  });

  it('leaves unknown variables as written', () => {
    expect(renderTemplate('{decade} {genre}', { genre: 'Rock' })).toBe('{decade} Rock');
  });
});

describe('timeValues', () => {
  it('gives year and zero-padded month at month precision, year alone at year precision', () => {
    const midMarch2025 = Math.floor(new Date(2025, 2, 15, 12).getTime() / 1000);
    expect(timeValues(midMarch2025, 'likedMonth')).toEqual({ year: '2025', month: '03', monthName: 'March' });
    expect(timeValues(midMarch2025, 'firstListenYear')).toEqual({ year: '2025' });
  });
});

describe('validateOrganisePlan', () => {
  it('accepts the per-month, per-genre, folder-per-year plan', () => {
    const r = validateOrganisePlan({ base, groupBy: ['likedMonth', 'genreFamily'], folder: '{year}', name: '{monthName} {genre}' });
    expect('plan' in r && r.plan.name).toBe('{monthName} {genre}');
  });

  it('defaults the name template from groupBy', () => {
    expect(defaultNameTemplate(['likedMonth', 'genreFamily'])).toBe('{year}-{month} {genre}');
    const r = validateOrganisePlan({ base, groupBy: ['firstListenYear'] });
    expect('plan' in r && r.plan.name).toBe('{year}');
  });

  it.each([
    [{ base, groupBy: [] }, /at least one/],
    [{ base, groupBy: ['likedMonth', 'likedYear'] }, /one time dimension/],
    [{ base, groupBy: ['genreFamily', 'canonicalGenre'] }, /one genre dimension/],
    [{ base, groupBy: ['decade'] }, /Unknown groupBy/],
    [{ base, groupBy: ['genreFamily'], name: '{year} {genre}' }, /\{year\} isn't provided/],
    [{ base, groupBy: ['likedYear'], name: '{monthName}' }, /\{monthName\} isn't provided/],
    [{ base, groupBy: ['likedMonth', 'genreFamily'], name: '{genre}' }, /must include \{year\}/],
    [{ base, groupBy: ['likedMonth', 'genreFamily'], folder: '{year}', name: '{genre}' }, /\{month\} or \{monthName\}/],
    [{ base, groupBy: ['genreFamily'], name: 'Loves' }, /must include \{genre\}/],
    [{ base, groupBy: ['genreFamily'], name: '{genre} {mood}' }, /Unknown template variable/],
    [{ groupBy: ['genreFamily'] }, /base recipe/],
  ])('rejects %j', (plan, error) => {
    const r = validateOrganisePlan(plan);
    expect('error' in r && r.error).toMatch(error);
  });

  it('keeps only known services in excludePlaylistedOn', () => {
    const r = validateOrganisePlan({ base, groupBy: ['genreFamily'], excludePlaylistedOn: ['tidal', 'napster'] });
    expect('plan' in r && r.plan.excludePlaylistedOn).toEqual(['tidal']);
  });
});
