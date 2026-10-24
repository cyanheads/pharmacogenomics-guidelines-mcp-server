/**
 * @fileoverview Recommendation selectors, pagination and declared recoveries at the HTTP seam.
 * @module tests/unit/recommendations/boundaries.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { failure, recommendation, reference, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('recommendation selector boundaries', () => {
  it.each([
    { mode: 'drug' as const },
    { mode: 'drug' as const, drugName: ' ', drugId: '' },
    { mode: 'drug' as const, drugName: 'example', drugId: 'D1' },
    { mode: 'drug' as const, drugId: 'D1', phenotype: 'Normal', activityScore: 1 },
    { mode: 'drug' as const, drugId: 'D1', genotype: { G: '*1/*1' } },
    { mode: 'drug' as const, drugId: 'D1', geneResults: {} },
    {
      mode: 'drug' as const,
      drugId: 'D1',
      geneResults: { ' ': { kind: 'phenotype' as const, value: 'Normal' } },
    },
    {
      mode: 'drug' as const,
      drugId: 'D1',
      geneResults: { G: { kind: 'phenotype' as const, value: ' ' } },
    },
    {
      mode: 'drug' as const,
      drugId: 'D1',
      geneResults: {
        g: { kind: 'phenotype' as const, value: 'Normal' },
        ' G ': { kind: 'phenotype' as const, value: 'Poor' },
      },
    },
    {
      mode: 'drug' as const,
      drugId: 'D1',
      geneSymbol: 'G',
      geneResults: { G: { kind: 'phenotype' as const, value: 'Normal' } },
    },
    { mode: 'genotype' as const },
    { mode: 'genotype' as const, genotype: {} },
    { mode: 'genotype' as const, genotype: { ' ': '*1/*1' } },
    { mode: 'genotype' as const, genotype: { G: ' ' } },
    { mode: 'genotype' as const, genotype: { g: '*1/*1', ' G ': '*1/*2' } },
    { mode: 'genotype' as const, genotype: { G: '*1/*1' }, phenotype: 'Normal' },
    { mode: 'genotype' as const, genotype: { G: '*1/*1' }, geneSymbol: 'G' },
    {
      mode: 'genotype' as const,
      genotype: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`G${i}`, '*1/*1'])),
    },
  ])('rejects conflicting/empty selectors before fetch: %j', async (input) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await failure(input, 'invalid_selector');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { limit: 0 },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { incompleteLimit: 0 },
    { incompleteLimit: 1.5 },
    { incompleteLimit: Number.MAX_SAFE_INTEGER + 1 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { geneResults: { G: { kind: 'unknown', value: 'Normal' } } },
  ])('rejects schema-invalid inputs %j', async (fields) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(getRecommendationsTool, {
      mode: 'drug',
      drugId: 'D1',
      ...fields,
    } as Parameters<typeof runToolContract<typeof getRecommendationsTool>>[1]);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('recommendation paging', () => {
  it('pages matched totals only after scanning beyond the first candidate page', async () => {
    const rows = Array.from({ length: 157 }, (_, i) =>
      recommendation(i + 1, { CYP2C19: i % 2 ? 'Poor' : 'Normal' }),
    );
    const { calls } = upstream({
      recommendations: rows,
      references: [reference('CYP2C19', 'Normal')],
    });
    const output = await success({
      mode: 'drug',
      drugId: 'D1',
      phenotype: 'Normal',
      limit: 50,
      offset: 25,
    });
    expect(output).toMatchObject({
      status: 'matched',
      items: rows.filter((_, i) => i % 2 === 0).slice(25, 75),
      page: { total: 79, returned: 50, nextOffset: 75 },
      truncated: true,
      shown: 50,
      cap: 50,
    });
    expect(
      calls
        .filter((url) => url.pathname.endsWith('/recommendation'))
        .map((url) => url.searchParams.get('offset')),
    ).toEqual(['0', '100']);
    expect(
      getRecommendationsTool.input.safeParse({ mode: 'drug', drugId: 'D1', offset: 75 }).success,
    ).toBe(true);
  });
  it.each([0, 10000])('returns complete empty enrichment at offset %i', async (offset) => {
    upstream({
      recommendations: offset ? [recommendation()] : [],
      references: [reference('CYP2C19', 'Normal')],
    });
    expect(
      await success({
        mode: 'drug',
        drugId: 'D1',
        geneSymbol: 'CYP2C19',
        phenotype: 'Normal',
        offset,
        limit: 51,
        incompleteLimit: 101,
      }),
    ).toMatchObject({
      items: [],
      page: { total: offset ? 1 : 0, offset, returned: 0, nextOffset: null, limit: 50 },
      incompletePage: { limit: 100 },
      effectiveQuery: { limit: 50, incompleteLimit: 100 },
      cap: 50,
      shown: 0,
      truncated: false,
    });
  });
  it('translates verified exploratory 416 past-end responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname.endsWith('/drug')
          ? Response.json([{ drugid: 'D1', name: 'example' }])
          : Response.json(
              { code: 'PGRST103' },
              { status: 416, headers: { 'content-range': '*/4' } },
            ),
      ),
    );
    expect(await success({ mode: 'drug', drugId: 'D1', offset: 10000 })).toMatchObject({
      status: 'exploratory',
      items: [],
      page: { total: 4, offset: 10000, nextOffset: null },
    });
  });
  it('returns ordinary unknown drug as no_match with recovery notice', async () => {
    upstream({ drugs: [] });
    expect(await success({ mode: 'drug', drugName: 'unknown' })).toMatchObject({
      status: 'no_match',
      items: [],
      notices: [expect.stringContaining('pgx_search_pairs')],
    });
  });
  it('fails scan overflow rather than returning a complete-looking subset', async () => {
    upstream({ recommendations: Array.from({ length: 2001 }, (_, i) => recommendation(i + 1)) });
    await failure({ mode: 'drug', drugId: 'D1', population: 'general' }, 'query_too_broad');
  });
});

describe('upstream declared recoveries', () => {
  it.each([
    ['upstream_query_rejected', 400],
    ['upstream_rate_limited', 429],
    ['upstream_unavailable', 503],
  ] as const)('preserves %s recovery on both surfaces', async (reason, status) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ message: 'untrusted' }, { status, headers: { 'retry-after': '0' } }),
      ),
    );
    const pending = failure({ mode: 'drug', drugId: 'D1' }, reason);
    await vi.runAllTimersAsync();
    await pending;
  });
});
