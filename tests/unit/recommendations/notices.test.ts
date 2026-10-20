/** @fileoverview Empty recommendation causes and diagnostic lookup boundaries.
 * @module tests/unit/recommendations/notices.test
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { recommendation, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

it('characterizes unresolved drugs as successful no_match', async () => {
  upstream({ drugs: [] });
  expect(await success({ mode: 'drug', drugName: 'typo' })).toMatchObject({
    status: 'no_match',
    items: [],
  });
});

it('explains unresolved drugs rather than suggesting phenotype retries', async () => {
  upstream({ drugs: [] });
  expect(await success({ mode: 'drug', drugName: 'typo' })).toMatchObject({
    notices: [expect.stringContaining('No exact CPIC drug')],
  });
});

it('names source guideline coverage only when the diagnostic relation exists', async () => {
  upstream({ recommendations: [], guidelines: [recommendation().guideline] });
  const result = await success({ mode: 'drug', drugId: 'D1' });
  expect(JSON.stringify(result.notices)).toContain('Source guideline');
  expect(JSON.stringify(result.notices)).toContain('https://example.org/a_(b)?x=1&y=2');
});

it('names exact source populations and distinguishes past-end from missing rows', async () => {
  upstream({ recommendations: [recommendation(), { ...recommendation(2), population: null }] });
  const result = await success({ mode: 'drug', drugId: 'D1', population: 'wrong' });
  expect(JSON.stringify(result.notices)).toContain('Available source populations');
  expect(JSON.stringify(result.notices)).toContain(' general ');
  expect(JSON.stringify(result.notices)).toContain('null');
  expect(await success({ mode: 'drug', drugId: 'D1', offset: 5000 })).toMatchObject({
    notices: expect.arrayContaining([expect.stringContaining('past the last row')]),
  });
});

it('does not invent missing guideline names or make diagnostic failures fatal', async () => {
  for (const guideline of [null, 7]) {
    const { fetch } = upstream({
      recommendations: [],
      drugs: [{ drugid: 'D1', name: 'example', guidelineid: guideline }],
      guidelines: [],
    });
    if (guideline !== null) {
      const original = fetch.getMockImplementation();
      fetch.mockImplementation(async (url: string) =>
        new URL(url).pathname.endsWith('/guideline') ? new Response('not JSON') : original!(url),
      );
    }
    const result = await success({ mode: 'drug', drugId: 'D1' });
    expect(result).toMatchObject({ status: 'exploratory', items: [] });
    expect(JSON.stringify(result.notices)).not.toContain('Source guideline');
    expect(JSON.stringify(result.notices)).toContain('no tabulated recommendation rows');
  }
});
