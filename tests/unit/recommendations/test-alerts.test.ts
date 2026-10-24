/** @fileoverview Opt-in source alerts and unchanged default recommendation contract.
 * @module tests/unit/recommendations/test-alerts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { diplotype, failure, recommendation, reference, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

function alert(id = 1, keys: Record<string, string> = { CYP2C19: 'Poor' }) {
  return {
    id,
    drugid: 'D1',
    population: 'general',
    cdscontext: 'Post-test',
    genes: Object.keys(keys),
    phenotype: keys,
    lookupkey: keys,
    activityscore: {},
    allelestatus: {},
    alerttext: ['First **source**\r\n', 'Second\n\nordered  ', 'n/a'],
    version: 3,
  };
}

it('returns ordered complete alert records without recommendation joins', async () => {
  const row = alert();
  const { calls } = upstream({ alerts: [row] });
  const result = await success({ mode: 'drug', drugId: 'D1', view: 'test_alerts' });
  expect(result).toMatchObject({
    status: 'exploratory',
    alerts: [row],
    items: [],
    incompleteMatches: [],
    incompleteAlerts: [],
    shown: 1,
  });
  expect(calls.map((url) => url.pathname)).toEqual(['/v1/drug', '/v1/test_alert']);
  expect(result.provenance).toMatchObject({
    rowVersions: [{ path: '/alerts/0', requestIndex: 1, version: 3 }],
  });
});

it('matches singular phenotypes with row-local conflicts and independent incomplete pages', async () => {
  const rows = [
    alert(1),
    alert(2, { CYP2C19: 'Poor', TPMT: 'Normal' }),
    alert(3, { CYP2C19: 'Poor', TPMT: 'Poor' }),
    alert(4, { CYP2C19: 'Normal', TPMT: 'Normal' }),
    alert(5, { OTHER: 'Poor' }),
  ];
  upstream({
    alerts: rows,
    references: [reference('CYP2C19', 'Poor'), reference('TPMT', 'Normal')],
  });
  const input = {
    mode: 'results' as const,
    view: 'test_alerts' as const,
    geneResults: { CYP2C19: { kind: 'phenotype' as const, value: 'Poor' } },
    incompleteLimit: 1,
  };
  const first = await success(input);
  expect(first).toMatchObject({
    status: 'matched',
    alerts: [rows[0]],
    items: [],
    incompleteMatches: [],
    incompleteAlerts: [{ testAlertId: 2, drugId: 'D1', missingGenes: ['TPMT'] }],
    incompletePage: { total: 2, nextOffset: 1 },
  });
  expect(JSON.stringify(first)).not.toContain('testAlertId":4');
  const second = await success({ ...input, incompleteOffset: 1, offset: 99 });
  expect(second).toMatchObject({
    alerts: [],
    page: { total: 1, nextOffset: null },
    incompleteAlerts: [{ testAlertId: 3 }],
    incompletePage: { total: 2, nextOffset: null },
  });
  expect(second.notices).toEqual(expect.arrayContaining([expect.stringContaining('offset')]));
  expect(
    await success({
      ...input,
      geneResults: { ...input.geneResults, TPMT: { kind: 'phenotype', value: 'Normal' } },
    }),
  ).toMatchObject({ alerts: [rows[0], rows[1]], incompleteAlerts: [] });
});

it('discovers genotype alerts directly, deduplicates shared candidates and never infers omitted genes', async () => {
  const rows = [
    alert(1),
    alert(2, { CYP2C19: 'Poor', TPMT: 'Normal' }),
    alert(3, { CYP2C19: 'Poor', TPMT: 'No Result' }),
  ];
  const { calls } = upstream({
    alerts: rows,
    diplotypes: [diplotype('CYP2C19', '*1/*2', 'Poor'), diplotype('TPMT', '*1/*1', 'Normal')],
  });
  expect(
    await success({ mode: 'genotype', view: 'test_alerts', genotype: { CYP2C19: '*1/*2' } }),
  ).toMatchObject({
    alerts: [rows[0]],
    incompleteAlerts: [{ testAlertId: 2 }, { testAlertId: 3 }],
  });
  expect(
    await success({
      mode: 'genotype',
      view: 'test_alerts',
      genotype: { CYP2C19: '*1/*2', TPMT: '*1/*1' },
    }),
  ).toMatchObject({ alerts: [rows[0], rows[1]], incompleteAlerts: [] });
  expect(calls.some((url) => url.pathname.includes('recommendation'))).toBe(false);
});

it('preserves sparse fields, No CDS, explicit No Result and n/a during browsing', async () => {
  const sparse = {
    id: 1,
    drugid: 'D1',
    cdscontext: 'No CDS',
    alerttext: ['n/a'],
    genes: null,
    lookupkey: null,
    version: null,
  };
  const noResult = alert(2, { CYP2C19: 'No Result' });
  upstream({ alerts: [sparse, noResult] });
  expect(await success({ mode: 'drug', drugId: 'D1', view: 'test_alerts' })).toMatchObject({
    alerts: [sparse, noResult],
  });
});

it('retains HLA allele identity and rejects unsupported result kinds', async () => {
  const row = {
    ...alert(1, { 'HLA-B': '*57:01 positive' }),
    phenotype: {},
    allelestatus: { 'HLA-B': '*57:01 positive' },
  };
  upstream({
    alerts: [row],
    references: [reference('HLA-B', '*57:01 positive'), reference('HLA-B', '*15:02 positive')],
  });
  expect(
    await success({
      mode: 'results',
      view: 'test_alerts',
      geneResults: { 'HLA-B': { kind: 'alleleStatus', value: 'HLA-B *57:01 positive' } },
    }),
  ).toMatchObject({ alerts: [row] });
  expect(
    await success({
      mode: 'results',
      view: 'test_alerts',
      geneResults: { 'HLA-B': { kind: 'alleleStatus', value: '*15:02 positive' } },
    }),
  ).toMatchObject({ alerts: [], status: 'no_match' });
  await failure(
    {
      mode: 'results',
      view: 'test_alerts',
      geneResults: { 'HLA-B': { kind: 'phenotype', value: '*57:01 positive' } },
    },
    'unsupported_gene_result',
  );
});

it('characterizes the default response without an injected view or alert fields', async () => {
  const row = recommendation();
  upstream({ recommendations: [row] });
  const result = await success({ mode: 'drug', drugId: 'D1' });
  expect(Object.keys(result).sort()).toEqual([
    'cap',
    'clinicalCaveat',
    'effectiveQuery',
    'geneResolutions',
    'incompleteMatches',
    'incompletePage',
    'items',
    'notices',
    'page',
    'provenance',
    'shown',
    'status',
    'truncated',
  ]);
  expect(result.effectiveQuery).toEqual({
    mode: 'drug',
    drugId: 'D1',
    limit: 10,
    offset: 0,
    incompleteLimit: 25,
    incompleteOffset: 0,
  });
  expect(result.items).toEqual([row]);
  expect(result.page).toEqual({ limit: 10, offset: 0, returned: 1, total: 1, nextOffset: null });
  const explicit = await success({ mode: 'drug', drugId: 'D1', view: 'recommendations' });
  expect(explicit.items).toEqual(result.items);
  expect(explicit).not.toHaveProperty('alerts');
});

it('pages first, second, last and past-end alerts and keeps population/cap notices truthful', async () => {
  const rows = Array.from({ length: 51 }, (_, i) => alert(i + 1));
  upstream({ alerts: rows });
  const query = {
    mode: 'drug' as const,
    drugId: 'D1',
    view: 'test_alerts' as const,
    population: 'general',
    limit: 25,
  };
  for (const [offset, count, next] of [
    [0, 25, 25],
    [25, 25, 50],
    [50, 1, null],
    [51, 0, null],
  ] as const) {
    expect(await success({ ...query, offset })).toMatchObject({
      alerts: rows.slice(offset, offset + count),
      page: { offset, returned: count, total: 51, nextOffset: next },
      shown: count,
      truncated: next !== null,
    });
  }
  expect(await success({ ...query, limit: 999, incompleteLimit: 999 })).toMatchObject({
    page: { limit: 50, returned: 50 },
    incompletePage: { limit: 100 },
    notices: expect.arrayContaining([
      expect.stringContaining('50-row cap'),
      expect.stringContaining('100-row cap'),
    ]),
  });
  expect(await success({ ...query, population: 'absent' })).toMatchObject({
    alerts: [],
    notices: [
      expect.stringContaining('Available source populations'),
      expect.stringContaining('Exploratory source test alerts'),
    ],
  });
});

it('distinguishes empty alert tables and invalid selectors before querying alerts', async () => {
  const { calls } = upstream({});
  const empty = await success({ mode: 'drug', drugId: 'D1', view: 'test_alerts' });
  expect(empty).toMatchObject({
    alerts: [],
    page: { total: 0 },
    notices: expect.arrayContaining([expect.stringContaining('no tabulated test alerts')]),
  });
  expect(JSON.stringify(empty.notices)).not.toContain('recommendation rows');
  await failure({ mode: 'drug', view: 'test_alerts' }, 'invalid_selector');
  const invalid = await runToolContract(getRecommendationsTool, {
    mode: 'drug',
    drugId: 'D1',
    view: 'test_alerts',
    limit: 0,
  });
  expect(invalid.isError).toBe(true);
  expect(calls.map((url) => url.pathname)).toEqual(['/v1/drug', '/v1/test_alert']);
});

it('supports phenotype and decimal score matching for source ACTIVITY_SCORE genes without conversion', async () => {
  const rows = ['0.5', '1.0'].map((score, i) => ({
    ...alert(i + 1, { CYP2D6: score }),
    phenotype: { CYP2D6: 'Intermediate' },
    activityscore: { CYP2D6: score },
  }));
  upstream({
    alerts: rows,
    references: [
      reference('CYP2D6', 'Intermediate', '0.5'),
      reference('CYP2D6', 'Intermediate', '1.0'),
    ],
  });
  expect(
    await success({
      mode: 'results',
      view: 'test_alerts',
      geneSymbol: 'CYP2D6',
      phenotype: 'Intermediate',
    }),
  ).toMatchObject({ alerts: rows });
  expect(
    await success({
      mode: 'results',
      view: 'test_alerts',
      geneSymbol: 'CYP2D6',
      activityScore: '+01.00',
    }),
  ).toMatchObject({ alerts: [rows[1]] });
});

it('fails closed on scan overflow and source shape failures at the HTTP seam', async () => {
  upstream({
    alerts: Array.from({ length: 2001 }, (_, i) => alert(i + 1)),
    references: [reference('CYP2C19', 'Poor')],
  });
  await failure(
    { mode: 'results', view: 'test_alerts', geneSymbol: 'CYP2C19', phenotype: 'Poor' },
    'query_too_broad',
  );
  upstream({
    alerts: [{ id: 1, drugid: 'D1', cdscontext: 'Post-test', alerttext: 'wrong shape' }],
  });
  const result = await runToolContract(getRecommendationsTool, {
    mode: 'drug',
    drugId: 'D1',
    view: 'test_alerts',
  });
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.SerializationError },
  });
});

it('preserves caller cancellation during candidate discovery and does not fetch later genes', async () => {
  const controller = new AbortController();
  const { fetch, calls } = upstream({
    alerts: [alert()],
    references: [reference('CYP2C19', 'Poor'), reference('TPMT', 'Normal')],
  });
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url: string) => {
    const result = await original(url);
    if (new URL(url).pathname.endsWith('/test_alert')) controller.abort();
    return result;
  });
  const result = await runToolContract(
    getRecommendationsTool,
    {
      mode: 'results',
      view: 'test_alerts',
      geneResults: {
        CYP2C19: { kind: 'phenotype', value: 'Poor' },
        TPMT: { kind: 'phenotype', value: 'Normal' },
      },
    },
    { context: { signal: controller.signal } },
  );
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(calls.filter((url) => url.pathname.endsWith('/test_alert'))).toHaveLength(1);
});

it.each([undefined, 'test_alerts'] as const)(
  'reports unknown caller genes as unsupported in view %s',
  async (view) => {
    const { calls } = upstream({ genes: [] });
    await failure(
      { mode: 'results', ...(view && { view }), geneSymbol: 'ZZZNOSUCHGENE', phenotype: 'Poor' },
      'unsupported_gene_result',
    );
    await failure(
      {
        mode: 'results',
        ...(view && { view }),
        geneResults: { ZZZNOSUCHGENE: { kind: 'phenotype', value: 'Poor' } },
      },
      'unsupported_gene_result',
    );
    expect(calls.map((url) => url.pathname)).toEqual(['/v1/gene', '/v1/gene']);
  },
);

it('uses source lookup keys for genotype alerts without requiring RPC-only allele counts', async () => {
  const resolved = diplotype('CYP2C19', '*1/*2', 'Poor');
  const { diplotypekey: _counts, ...withoutCounts } = resolved;
  upstream({ alerts: [alert()], diplotypes: [withoutCounts] });
  expect(
    await success({ mode: 'genotype', view: 'test_alerts', genotype: { CYP2C19: '*1/*2' } }),
  ).toMatchObject({ alerts: [alert()], status: 'matched' });
});

it('never substitutes the recommendation phenotype column for a missing alert phenotype', async () => {
  const { phenotype: _phenotype, ...row } = { ...alert(), phenotypes: { CYP2C19: 'Poor' } };
  upstream({ alerts: [row], references: [reference('CYP2C19', 'Poor')] });
  expect(
    await success({
      mode: 'drug',
      drugId: 'D1',
      view: 'test_alerts',
      geneSymbol: 'CYP2C19',
      phenotype: 'Poor',
    }),
  ).toMatchObject({ status: 'no_match', alerts: [] });
});

it('withholds every incomplete alert text and preserves diagnostic past-end totals', async () => {
  const row = {
    ...alert(1, { CYP2C19: 'Poor', TPMT: 'Normal' }),
    alerttext: ['WITHHELD source alert'],
  };
  upstream({ alerts: [row], references: [reference('CYP2C19', 'Poor')] });
  const input = {
    mode: 'results' as const,
    view: 'test_alerts' as const,
    geneSymbol: 'CYP2C19',
    phenotype: 'Poor',
  };
  const first = await success(input);
  expect(first).toMatchObject({
    status: 'incomplete',
    alerts: [],
    incompleteAlerts: [{ testAlertId: 1, missingGenes: ['TPMT'] }],
  });
  expect(JSON.stringify(first)).not.toContain('WITHHELD');
  expect(await success({ ...input, incompleteOffset: 999 })).toMatchObject({
    status: 'incomplete',
    alerts: [],
    incompleteAlerts: [],
    incompletePage: { total: 1, nextOffset: null },
  });
});

it('fails closed when a source trigger gene is missing from the alert lookup key', async () => {
  upstream({
    alerts: [{ ...alert(), genes: ['CYP2C19', 'TPMT'] }],
    references: [reference('CYP2C19', 'Poor')],
  });
  const result = await runToolContract(getRecommendationsTool, {
    mode: 'results',
    view: 'test_alerts',
    geneSymbol: 'CYP2C19',
    phenotype: 'Poor',
  });
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.SerializationError },
  });
});
