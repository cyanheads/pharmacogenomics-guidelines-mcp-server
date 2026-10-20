/** @fileoverview Cross-drug explicit results and independent missing-gene pages.
 * @module tests/unit/recommendations/results-mode.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { failure, recommendation, reference, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

it('fails closed when individually bounded scans exceed the combined candidate cap', async () => {
  upstream({
    recommendations: Array.from({ length: 2200 }, (_, i) =>
      recommendation(i + 1, { [i < 1100 ? 'G' : 'H']: 'Poor' }),
    ),
    references: [reference('G', 'Poor'), reference('H', 'Poor')],
  });
  await failure(
    {
      mode: 'results',
      geneResults: {
        G: { kind: 'phenotype', value: 'Poor' },
        H: { kind: 'phenotype', value: 'Poor' },
      },
    },
    'query_too_broad',
  );
});

it('cancels the shared candidate workflow without scanning later genes', async () => {
  const controller = new AbortController();
  const { fetch, calls } = upstream({
    recommendations: [recommendation(1, { G: 'Poor' })],
    references: [reference('G', 'Poor'), reference('H', 'Poor')],
  });
  const original = fetch.getMockImplementation();
  fetch.mockImplementation(async (url: string) => {
    const response = await original!(url);
    if (new URL(url).pathname.endsWith('/recommendation')) controller.abort();
    return response;
  });
  const result = await runToolContract(
    getRecommendationsTool,
    {
      mode: 'results',
      geneResults: {
        G: { kind: 'phenotype', value: 'Poor' },
        H: { kind: 'phenotype', value: 'Poor' },
      },
    },
    { context: { signal: controller.signal } },
  );
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(JSON.stringify(result.content)).toMatch(/abort|cancel/i);
  expect(calls.filter((url) => url.pathname.endsWith('/recommendation'))).toHaveLength(1);
});

it('matches row-local prerequisites while ignoring unrelated panel genes', async () => {
  const rows = [
    recommendation(1, { CYP2C19: 'Poor' }),
    recommendation(2, { CYP2C19: 'Poor', TPMT: 'Normal' }),
    recommendation(3, { TPMT: 'Normal' }),
  ];
  upstream({
    recommendations: rows,
    references: [reference('CYP2C19', 'Poor'), reference('OTHER', 'Normal')],
  });
  expect(
    await success({
      mode: 'results',
      geneResults: {
        CYP2C19: { kind: 'phenotype', value: 'Poor' },
        OTHER: { kind: 'phenotype', value: 'Normal' },
      },
    }),
  ).toMatchObject({
    status: 'matched',
    items: [rows[0]],
    incompleteMatches: [{ recommendationId: 2, missingGenes: ['TPMT'] }],
    incompletePage: { total: 1, returned: 1, nextOffset: null },
  });
});

it('pages matched and incomplete results independently without losing global status', async () => {
  const rows = Array.from({ length: 107 }, (_, i) =>
    recommendation(i + 1, i < 3 ? { G: 'Poor' } : { G: 'Poor', MISSING: 'Normal' }),
  );
  const { calls } = upstream({ recommendations: rows, references: [reference('G', 'Poor')] });
  const input = {
    mode: 'results' as const,
    geneSymbol: 'G',
    phenotype: 'Poor',
    limit: 1,
    incompleteLimit: 100,
  };
  expect(await success(input)).toMatchObject({
    items: [rows[0]],
    page: { total: 3, nextOffset: 1 },
    incompletePage: { total: 104, returned: 100, nextOffset: 100 },
  });
  expect(await success({ ...input, offset: 2, incompleteOffset: 100 })).toMatchObject({
    items: [rows[2]],
    page: { nextOffset: null },
    incompletePage: { returned: 4, nextOffset: null },
  });
  expect(await success({ ...input, offset: 1000, incompleteOffset: 1000 })).toMatchObject({
    status: 'matched',
    items: [],
    incompleteMatches: [],
    incompletePage: { total: 104, returned: 0, nextOffset: null },
  });
  expect(calls.some((url) => url.searchParams.get('offset') === '100')).toBe(true);
});

it('retains decimal-equivalent scores and phenotype distinctions without inferring scores', async () => {
  const rows = ['0', '0.0', '>0'].map((score, i) => ({
    ...recommendation(i + 1, { G: score }),
    activityscore: { G: score },
    phenotypes: { G: 'Poor' },
  }));
  upstream({
    recommendations: rows,
    references: rows.map((row) => reference('G', 'Poor', row.activityscore.G, row.id)),
  });
  expect(await success({ mode: 'results', geneSymbol: 'G', activityScore: 0 })).toMatchObject({
    items: rows.slice(0, 2),
  });
  expect(await success({ mode: 'results', geneSymbol: 'G', phenotype: 'Poor' })).toMatchObject({
    items: rows,
  });
});

it('excludes conflicts, preserves complete HLA identities and honors a drug filter', async () => {
  const row = {
    ...recommendation(1, { 'HLA-B': '*57:01 positive', G: 'Normal' }),
    allelestatus: { 'HLA-B': 'HLA-B*57:01 positive' },
  };
  upstream({
    recommendations: [
      row,
      { ...row, id: 2, drugid: 'D2', drug: { ...row.drug, drugid: 'D2', name: 'other' } },
    ],
    references: [reference('HLA-B', '*57:01 positive'), reference('G', 'Poor')],
  });
  expect(
    await success({
      mode: 'results',
      drugId: 'D1',
      geneResults: { 'HLA-B': { kind: 'alleleStatus', value: 'HLA-B*57:01 positive' } },
    }),
  ).toMatchObject({
    status: 'incomplete',
    items: [],
    incompleteMatches: [{ recommendationId: 1, missingGenes: ['G'] }],
  });
  expect(
    await success({
      mode: 'results',
      geneResults: {
        'HLA-B': { kind: 'alleleStatus', value: '*57:01 positive' },
        G: { kind: 'phenotype', value: 'Poor' },
      },
    }),
  ).toMatchObject({ status: 'no_match', items: [], incompleteMatches: [] });
});

it.each([
  { mode: 'results' as const },
  { mode: 'results' as const, phenotype: 'Poor' },
  { mode: 'results' as const, geneSymbol: 'G' },
  { mode: 'results' as const, genotype: { G: '*1/*1' } },
])('rejects invalid result combinations before fetch: %j', async (input) => {
  const { fetch } = upstream({});
  await failure(input, 'invalid_selector');
  expect(fetch).not.toHaveBeenCalled();
});
