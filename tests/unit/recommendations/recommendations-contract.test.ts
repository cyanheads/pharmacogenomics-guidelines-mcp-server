/**
 * @fileoverview Recommendation matching, clinical completeness and complete output contracts.
 * @module tests/unit/recommendations/recommendations-contract.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { diplotype, failure, recommendation, reference, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('explicit recommendation matches', () => {
  it('matches an explicit mapped score without converting a phenotype or inequality label', async () => {
    const row = {
      ...recommendation(1, { CYP2D6: '>1' }),
      activityscore: { CYP2D6: '>1' },
      phenotypes: { CYP2D6: 'Normal' },
    };
    upstream({ recommendations: [row], references: [reference('CYP2D6', 'Normal', '>1')] });
    expect(
      await success({
        mode: 'drug',
        drugId: 'D1',
        geneResults: { CYP2D6: { kind: 'activityScore', value: '>1' } },
      }),
    ).toMatchObject({ status: 'matched', items: [row] });
    await failure(
      {
        mode: 'drug',
        drugId: 'D1',
        geneResults: { CYP2D6: { kind: 'activityScore', value: 'Normal' } },
      },
      'unsupported_gene_result',
    );
    await failure(
      {
        mode: 'drug',
        drugId: 'D1',
        geneResults: { CYP2D6: { kind: 'activityScore', value: '1' } },
      },
      'unsupported_gene_result',
    );
  });
  it.each([{ drugName: ' EXAMPLE ' }, { drugId: ' D1 ' }])(
    'browses exploratory full source records using %j',
    async (selector) => {
      const row = recommendation();
      const { calls } = upstream({ recommendations: [row] });
      const output = await success({ mode: 'drug', ...selector });
      expect(output).toMatchObject({
        status: 'exploratory',
        items: [row],
        incompleteMatches: [],
        shown: 1,
        cap: 10,
        truncated: false,
      });
      expect(calls).toHaveLength(2);
      expect(output.provenance).toMatchObject({
        rowVersions: expect.arrayContaining([
          expect.objectContaining({ version: 12 }),
          expect.objectContaining({ version: 8 }),
          expect.objectContaining({ version: 9 }),
        ]),
      });
    },
  );
  it('retains every phenotype-matching score and exact source strings, including n/a', async () => {
    const rows = ['0.25', '0.50', '>1'].map((score, index) => ({
      ...recommendation(index + 1, { CYP2D6: score }),
      phenotypes: { CYP2D6: 'Intermediate' },
      activityscore: { CYP2D6: score },
      classification: index === 2 ? 'n/a' : 'No Recommendation',
    }));
    upstream({
      recommendations: rows,
      references: rows.map((row) =>
        reference('CYP2D6', 'Intermediate', row.activityscore.CYP2D6, row.id),
      ),
    });
    expect(
      await success({ mode: 'drug', drugId: 'D1', phenotype: ' intermediate ' }),
    ).toMatchObject({
      status: 'matched',
      items: rows,
      effectiveQuery: { phenotype: 'intermediate' },
    });
  });
  it.each([1, '01.000', '+1.0'])(
    'compares decimal %s without collapsing source ranges',
    async (activityScore) => {
      const rows = ['1', '1.0', '>1', '1–2'].map((score, index) => ({
        ...recommendation(index + 1, { CYP2D6: score }),
        activityscore: { CYP2D6: score },
      }));
      upstream({
        recommendations: rows,
        references: rows.map((row) =>
          reference('CYP2D6', 'Normal', row.activityscore.CYP2D6, row.id),
        ),
      });
      expect(await success({ mode: 'drug', drugId: 'D1', activityScore })).toMatchObject({
        status: 'matched',
        items: rows.slice(0, 2),
      });
    },
  );
  it('withholds multi-gene advice until every nested prerequisite is supplied', async () => {
    const row = recommendation(1, { TPMT: 'Indeterminate', NUDT15: 'Normal' });
    upstream({
      recommendations: [row],
      references: [reference('TPMT', 'Indeterminate'), reference('NUDT15', 'Normal')],
    });
    const partial = await success({
      mode: 'drug',
      drugId: 'D1',
      geneResults: { tpmt: { kind: 'phenotype', value: 'Indeterminate' } },
    });
    expect(partial).toMatchObject({
      status: 'incomplete',
      items: [],
      incompleteMatches: [{ recommendationId: 1, drugId: 'D1', missingGenes: ['NUDT15'] }],
    });
    expect(JSON.stringify(partial)).not.toContain(row.drugrecommendation);
    expect(
      await success({
        mode: 'drug',
        drugId: 'D1',
        geneResults: {
          TPMT: { kind: 'phenotype', value: 'Indeterminate' },
          NUDT15: { kind: 'phenotype', value: 'Normal' },
        },
      }),
    ).toMatchObject({ status: 'matched', items: [row] });
  });
  it('requires scalar gene from the lookup-key universe before population narrowing', async () => {
    upstream({
      recommendations: [
        recommendation(),
        { ...recommendation(2, { TPMT: 'Normal' }), population: 'other' },
      ],
    });
    const result = await failure(
      { mode: 'drug', drugId: 'D1', phenotype: 'Normal', population: 'general' },
      'gene_required',
    );
    expect(result.structuredContent).toMatchObject({
      error: { data: { availableGenes: ['CYP2C19', 'TPMT'] } },
    });
  });
  it('names every available gene in the text error while retaining the structured list', async () => {
    upstream({ recommendations: [recommendation(1, { TPMT: 'Normal', NUDT15: 'Normal' })] });
    const result = await failure(
      { mode: 'drug', drugId: 'D1', phenotype: 'Normal' },
      'gene_required',
    );
    expect(result.structuredContent).toMatchObject({
      error: { data: { availableGenes: ['TPMT', 'NUDT15'] } },
    });
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain('TPMT');
    expect(text).toContain('NUDT15');
  });
  it('matches named HLA status across prefix differences but never another allele', async () => {
    const rows = ['*57:01 positive', '*15:02 positive'].map((status, i) => ({
      ...recommendation(i + 1, { 'HLA-B': status }),
      phenotypes: {},
      allelestatus: { 'HLA-B': `HLA-B${status}` },
    }));
    upstream({
      recommendations: rows,
      references: rows.map((row) => reference('HLA-B', row.lookupkey?.['HLA-B'] ?? '')),
    });
    expect(
      await success({
        mode: 'drug',
        drugId: 'D1',
        geneResults: { 'hla-b': { kind: 'alleleStatus', value: 'HLA-B*57:01 positive' } },
      }),
    ).toMatchObject({ status: 'matched', items: [rows[0]] });
  });
  it('filters all trimmed populations while preserving their source strings', async () => {
    const rows = [' general ', 'general', 'children'].map((population, i) => ({
      ...recommendation(i + 1),
      population,
    }));
    upstream({ recommendations: rows });
    expect(
      await success({
        mode: 'drug',
        drugName: 'example',
        population: ' general ',
        geneSymbol: ' cyp2c19 ',
      }),
    ).toMatchObject({ status: 'exploratory', items: rows.slice(0, 2) });
  });
  it.each(['Unknown', 'NORMAL'])(
    'rejects unsupported or ambiguous source result %s',
    async (phenotype) => {
      upstream({
        recommendations: [recommendation()],
        references: [reference('CYP2C19', 'Normal'), reference('CYP2C19', 'normal', null, 2)],
      });
      await failure({ mode: 'drug', drugId: 'D1', phenotype }, 'unsupported_gene_result');
    },
  );
  it('returns no match when a supported result differs from every candidate', async () => {
    upstream({ recommendations: [recommendation()], references: [reference('CYP2C19', 'Poor')] });
    expect(await success({ mode: 'drug', drugId: 'D1', phenotype: 'Poor' })).toMatchObject({
      status: 'no_match',
      items: [],
      shown: 0,
    });
  });
  it('never selects the first exact-name drug candidate', async () => {
    upstream({
      drugs: [
        { drugid: 'A', name: 'example' },
        { drugid: 'B', name: 'EXAMPLE' },
      ],
    });
    await failure({ mode: 'drug', drugName: 'example' }, 'ambiguous_drug');
  });
});

describe('genotype source matching', () => {
  it.each([{ drugName: 'example' }, { drugId: 'D1' }])(
    'filters cross-drug RPC results with %j',
    async (selector) => {
      const first = recommendation();
      const second = { ...recommendation(2), drugid: 'D2', drug: { drugid: 'D2', name: 'other' } };
      upstream({
        recommendations: [first, second],
        diplotypes: [diplotype()],
        rpc: [{ recommendationid: 2 }, { recommendationid: 1 }],
      });
      expect(
        await success({ mode: 'genotype', genotype: { CYP2C19: '*1/*2' }, ...selector }),
      ).toMatchObject({ status: 'matched', items: [first] });
    },
  );
  it('merges all ten explicitly supplied source maps before RPC and complete matching', async () => {
    const genes = Array.from({ length: 10 }, (_, index) => `G${index}`);
    const keys = Object.fromEntries(genes.map((gene) => [gene, 'Normal']));
    const records = genes.map((gene) => diplotype(gene));
    const row = recommendation(1, keys);
    const { calls } = upstream({
      recommendations: [row],
      diplotypes: records,
      rpc: [{ recommendationid: 1 }],
    });
    expect(
      await success({
        mode: 'genotype',
        genotype: Object.fromEntries(genes.map((gene) => [gene, '*1/*2'])),
      }),
    ).toMatchObject({
      status: 'matched',
      items: [row],
      geneResolutions: records.map((record) => ({ records: [record] })),
    });
    const rpc = calls.find((url) => url.pathname.endsWith('/recommendation_lookup'));
    expect(JSON.parse(rpc?.searchParams.get('diplotypelookup') ?? '')).toEqual(
      Object.assign({}, ...records.map((record) => record.diplotypekey)),
    );
  });
  it.each([
    { ...diplotype(), diplotypekey: null },
    { ...diplotype(), lookupkey: null },
    { ...diplotype(), diplotypekey: { CYP2C19: { '*1': 1 }, UNSUPPLIED: { '*1': 1 } } },
    { ...diplotype(), lookupkey: { CYP2C19: 'Normal', UNSUPPLIED: 'Normal' } },
  ])('fails before RPC for invalid source genotype prerequisites %#', async (record) => {
    const { calls } = upstream({ diplotypes: [record] });
    const result = await runToolContract(getRecommendationsTool, {
      mode: 'genotype',
      genotype: { CYP2C19: '*1/*2' },
    });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
    expect(calls).toHaveLength(1);
  });
  it.each([
    { gene: 'CYP2C19', input: '*2/*1', source: diplotype() },
    {
      gene: 'HLA-B',
      input: 'HLA-B*57:01 POSITIVE',
      source: {
        ...diplotype('HLA-B', '*57:01 positive', '*57:01 positive'),
        diplotypekey: { 'HLA-B': { '*57:01 positive': 1 } },
      },
    },
    {
      gene: 'CFTR',
      input: '2789+5G->A/2789+5G->A',
      source: {
        ...diplotype('CFTR', '2789+5G->A/2789+5G->A', 'responsive'),
        diplotypekey: { CFTR: { '2789+5G->A': 2 } },
      },
    },
  ])(
    'uses unchanged $gene source genotype maps and full joins in RPC order',
    async ({ gene, input, source }) => {
      const keys = source.lookupkey ?? {};
      const rows = [recommendation(1, keys), recommendation(2, keys)];
      const { calls } = upstream({
        recommendations: rows,
        diplotypes: [source],
        rpc: [{ recommendationid: 2 }, { recommendationid: 1 }, { recommendationid: 2 }],
      });
      const output = await success({ mode: 'genotype', genotype: { [gene.toLowerCase()]: input } });
      expect(output).toMatchObject({
        status: 'matched',
        items: [rows[1], rows[0]],
        geneResolutions: [{ records: [source] }],
      });
      const rpc = calls.find((url) => url.pathname.endsWith('/recommendation_lookup'));
      expect(JSON.parse(rpc?.searchParams.get('diplotypelookup') ?? '')).toEqual(
        source.diplotypekey,
      );
      expect(calls.at(-1)?.searchParams.get('id')).toBe('in.(2,1)');
    },
  );
  it.each([0, 2])(
    'prevents RPC when one of two supplied genes has %i resolutions',
    async (count) => {
      const { calls } = upstream({
        diplotypes: [
          diplotype(),
          ...Array.from({ length: count }, () => diplotype('TPMT', '*1/*1')),
        ],
      });
      expect(
        await success({ mode: 'genotype', genotype: { CYP2C19: '*1/*2', TPMT: '*1/*1' } }),
      ).toMatchObject({ status: 'unresolved', items: [], geneResolutions: expect.any(Array) });
      expect(calls.every((url) => url.pathname.endsWith('/diplotype'))).toBe(true);
    },
  );
  it('withholds RPC candidates requiring omitted genes and mismatched same-gene statuses', async () => {
    const genotype = diplotype('HLA-B', '*57:01 positive', '*57:01 positive');
    upstream({
      diplotypes: [genotype],
      rpc: [{ recommendationid: 1 }, { recommendationid: 2 }],
      recommendations: [
        recommendation(1, { 'HLA-B': '*57:01 positive', 'HLA-A': '*31:01 negative' }),
        recommendation(2, { 'HLA-B': '*15:02 negative' }),
      ],
    });
    expect(
      await success({ mode: 'genotype', genotype: { 'HLA-B': '*57:01 positive' } }),
    ).toMatchObject({
      status: 'incomplete',
      items: [],
      incompleteMatches: [{ recommendationId: 1, missingGenes: ['HLA-A'] }],
    });
  });
  it.each(['guideline', 'drug', 'lookupkey'] as const)(
    'fails closed for missing %s',
    async (field) => {
      const row = { ...recommendation(), [field]: null };
      upstream({ recommendations: [row] });
      const result = await runToolContract(getRecommendationsTool, { mode: 'drug', drugId: 'D1' });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.SerializationError },
      });
    },
  );
  it('fails when RPC refers to a missing full record', async () => {
    upstream({ diplotypes: [diplotype()], rpc: [{ recommendationid: 999 }] });
    expect(
      (
        await runToolContract(getRecommendationsTool, {
          mode: 'genotype',
          genotype: { CYP2C19: '*1/*2' },
        })
      ).structuredContent,
    ).toMatchObject({ error: { code: JsonRpcErrorCode.SerializationError } });
  });
});
