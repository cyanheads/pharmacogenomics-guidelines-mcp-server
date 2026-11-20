/** @fileoverview Allele-specific prerequisites and complete per-drug diagnostics. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { diplotype, failure, recommendation, reference, success, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

const hla = 'HLA-B';
const negative = '*57:01 negative';
const positive = '*57:01 positive';
const other = '*15:02 negative';

function hlaRow(id: number, alleleStatus: string, extra: Record<string, string> = {}) {
  const row = recommendation(id, { [hla]: alleleStatus, ...extra });
  return {
    ...row,
    allelestatus: { [hla]: `${hla}${alleleStatus}` },
    genes: Object.keys(row.lookupkey ?? {}),
    phenotype: row.phenotypes,
    cdscontext: 'Post-test',
    alerttext: ['WITHHELD ALERT'],
  };
}

const supplied = { [hla]: { kind: 'alleleStatus', value: negative } } as const;

it.each(['recommendations', 'test_alerts'] as const)(
  'preserves exact allele matches and excludes a same-allele conflict in %s',
  async (view) => {
    const rows = [hlaRow(1, negative), hlaRow(2, positive)];
    upstream({ recommendations: rows, alerts: rows, references: [reference(hla, negative)] });
    const result = await success({ mode: 'drug', drugId: 'D1', view, geneResults: supplied });
    expect(result).toMatchObject({ status: 'matched', incompletePage: { total: 0 } });
    expect(result[view === 'recommendations' ? 'items' : 'alerts']).toMatchObject([{ id: 1 }]);
  },
);

it.each(['recommendations', 'test_alerts'] as const)(
  'reports the other named allele but preserves conflicts and no-result states in %s',
  async (view) => {
    const rows = [
      hlaRow(1, negative),
      hlaRow(2, other),
      hlaRow(3, positive),
      hlaRow(4, 'No *15:02 result on file'),
      hlaRow(5, other, { TPMT: 'Normal' }),
      hlaRow(6, other, { OTHER: 'Normal' }),
    ];
    upstream({
      recommendations: rows,
      alerts: rows,
      references: [reference(hla, negative), reference('TPMT', 'Poor')],
      diplotypes: [diplotype(hla, negative, negative), diplotype('TPMT', '*1/*2', 'Poor')],
    });
    const collection = view === 'recommendations' ? 'incompleteMatches' : 'incompleteAlerts';
    const id = view === 'recommendations' ? 'recommendationId' : 'testAlertId';
    const geneResults = { ...supplied, TPMT: { kind: 'phenotype', value: 'Poor' } } as const;
    for (const input of [
      { mode: 'drug', drugId: 'D1', geneResults },
      { mode: 'results', geneResults },
      { mode: 'genotype', genotype: { [hla]: negative, TPMT: '*1/*2' } },
    ] as const) {
      const first = await success({ ...input, view, incompleteLimit: 1 });
      expect(first).toMatchObject({
        status: 'matched',
        [collection]: [
          {
            [id]: 2,
            drugName: 'example',
            missingGenes: [],
            missingAlleles: [{ geneSymbol: hla, allele: '*15:02' }],
          },
        ],
        incompletePage: { total: 2, nextOffset: 1 },
        incompleteDrugs: [
          {
            drugId: 'D1',
            drugName: 'example',
            rowCount: 2,
            missingGenes: ['OTHER'],
            missingAlleles: [{ geneSymbol: hla, allele: '*15:02' }],
          },
        ],
      });
      const second = await success({ ...input, view, incompleteLimit: 1, incompleteOffset: 1 });
      expect(second).toMatchObject({
        [collection]: [{ [id]: 6, missingGenes: ['OTHER'] }],
        incompletePage: { total: 2, nextOffset: null },
        incompleteDrugs: first.incompleteDrugs,
      });
      const end = await success({ ...input, view, incompleteOffset: 2, offset: 1 });
      expect(end).toMatchObject({
        [collection]: [],
        incompletePage: { total: 2, nextOffset: null },
        incompleteDrugs: first.incompleteDrugs,
      });
    }
    await failure(
      {
        view,
        mode: 'results',
        geneResults: { [hla]: { kind: 'alleleStatus', value: '*99:99 negative' } },
      },
      'unsupported_gene_result',
    );
  },
);

it('batches alert names, keeps unknown and absent IDs, and withholds all alert text', async () => {
  const base = hlaRow(1, other);
  const alerts = [
    base,
    { ...base, id: 2, drugid: 'D2' },
    { ...base, id: 3, drugid: 'unknown' },
    { ...base, id: 4, drugid: null },
  ];
  const { calls } = upstream({
    alerts,
    references: [reference(hla, negative)],
    drugs: [base.drug, { ...base.drug, drugid: 'D2', name: 'another name' }],
  });
  const input = { view: 'test_alerts', mode: 'results', geneResults: supplied } as const;
  const result = await success({ ...input, incompleteLimit: 101 });
  expect(result).toMatchObject({
    status: 'incomplete',
    alerts: [],
    incompleteAlerts: [
      { testAlertId: 1, drugId: 'D1', drugName: 'example' },
      { testAlertId: 2, drugId: 'D2', drugName: 'another name' },
      { testAlertId: 3, drugId: 'unknown' },
      { testAlertId: 4, drugId: null },
    ],
    incompleteDrugs: [
      { drugId: 'D1', drugName: 'example' },
      { drugId: 'D2', drugName: 'another name' },
      { drugId: 'unknown', rowCount: 1 },
    ],
    incompletePage: { limit: 100, total: 4 },
  });
  expect(JSON.stringify(result)).not.toContain('WITHHELD ALERT');
  expect(result.incompleteAlerts).not.toContainEqual(
    expect.objectContaining({ testAlertId: 3, drugName: expect.any(String) }),
  );
  expect(result.incompleteAlerts).not.toContainEqual(
    expect.objectContaining({ testAlertId: 4, drugName: expect.any(String) }),
  );
  const names = calls.filter((url) => url.pathname === '/v1/drug');
  expect(names.map((url) => url.searchParams.get('drugid'))).toEqual(['in.("D1","D2","unknown")']);
  expect(result.provenance).toMatchObject({
    requestUrls: expect.arrayContaining([names[0]?.href]),
  });

  upstream({ alerts: [], references: [reference(hla, negative)] });
  expect(await success(input)).toMatchObject({ status: 'no_match', incompleteDrugs: [] });
});
