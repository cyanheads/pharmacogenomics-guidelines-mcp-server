/** @fileoverview Candidate discovery beyond complete RPC matches.
 * @module tests/unit/recommendations/partial-candidates.test
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { diplotype, recommendation, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

it('characterizes complete RPC matching without inferred prerequisites', async () => {
  const row = recommendation();
  upstream({ recommendations: [row], diplotypes: [diplotype()], rpc: [{ recommendationid: 1 }] });
  expect(await success({ mode: 'genotype', genotype: { CYP2C19: '*1/*2' } })).toMatchObject({
    status: 'matched',
    items: [row],
  });
});

it('finds partial prerequisites when the real RPC supplies no candidates', async () => {
  const row = recommendation(1, { TPMT: 'Intermediate', NUDT15: 'Normal' });
  upstream({
    recommendations: [row],
    diplotypes: [diplotype('TPMT', '*1/*3A', 'Intermediate')],
    rpc: [],
  });
  expect(await success({ mode: 'genotype', genotype: { TPMT: '*1/*3A' } })).toMatchObject({
    status: 'incomplete',
    items: [],
    incompleteMatches: [{ recommendationId: 1, missingGenes: ['NUDT15'] }],
  });
});
