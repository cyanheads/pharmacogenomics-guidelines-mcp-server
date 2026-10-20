/**
 * @fileoverview Bounded source diplotype resolution and allele evidence joins.
 * @module services/cpic/evidence
 */
import type { CpicPageInfo, CpicWorkflow } from './cpic-service.js';
import { buildCpicUrl, type CpicFilter } from './query.js';
import type { Allele, Diplotype } from './records.js';

const frequencyScanCap = 2000;
const frequencyPageSize = 100;

/** Resolve only source-supported notation; keep every matching source row. */
export async function resolveDiplotype(
  workflow: CpicWorkflow,
  geneSymbol: string,
  diplotype: string,
) {
  const inputDiplotype = diplotype.trim();
  const attempted = new Set<string>();
  let records: Diplotype[] = [];
  let matchedDiplotype: string | null = null;
  async function attempt(value: string): Promise<boolean> {
    if (attempted.has(value)) return false;
    attempted.add(value);
    records = await workflow.scan(
      'diplotype',
      {
        filters: [
          { column: 'genesymbol', operator: 'eq', value: geneSymbol },
          { column: 'diplotype', operator: 'eq', value },
        ],
      },
      2000,
    );
    if (records.length === 0) return false;
    matchedDiplotype = value;
    return true;
  }
  if (!(await attempt(inputDiplotype))) {
    const remainder = inputDiplotype.startsWith(geneSymbol)
      ? inputDiplotype.slice(geneSymbol.length)
      : '';
    const suffix = remainder.trim();
    const prefixed =
      suffix.startsWith('*') || (/^\s/.test(remainder) && suffix.split('/').length === 2);
    const notation = prefixed && !suffix.includes(geneSymbol) ? suffix : inputDiplotype;
    if (!(notation !== inputDiplotype && (await attempt(notation)))) {
      const parts = notation.split('/');
      if (parts.length === 2 && parts.every((part) => part.trim().length > 0)) {
        await attempt(`${parts[1]?.trim()}/${parts[0]?.trim()}`);
      } else if (geneSymbol.startsWith('HLA-')) {
        const status = notation.match(/^(\*\S+)\s+(positive|negative)$/i);
        if (status) await attempt(`${status[1]} ${status[2]?.toLowerCase()}`);
      }
    }
  }
  const guidance =
    records.length === 0
      ? 'Call pgx_search_alleles for this gene and pgx_list_reference with topic phenotypes; supply a supported diplotype or allele-status result.'
      : records.length > 1
        ? 'Call pgx_list_reference with topic phenotypes for this gene; do not infer one gene result from an ambiguous diplotype.'
        : '';
  return {
    found: records.length > 0,
    geneSymbol,
    inputDiplotype,
    matchedDiplotype,
    records,
    guidance,
    provenance: workflow.provenance(),
  };
}

/** Normalized exact allele selectors and public page bounds. */
export interface AlleleSearch {
  clinicalFunctionalStatus?: string;
  geneSymbol: string;
  limit: number;
  name?: string;
  offset: number;
}

/** Join a source allele page to complete bounded population-frequency evidence. */
export async function searchAlleles(
  workflow: CpicWorkflow,
  input: AlleleSearch,
  select: (
    rows: Allele[],
    page: CpicPageInfo,
    frequencyUrls: (count: number) => string[],
  ) => number,
) {
  const filters: CpicFilter[] = [{ column: 'genesymbol', operator: 'eq', value: input.geneSymbol }];
  if (input.name !== undefined) filters.push({ column: 'name', operator: 'eq', value: input.name });
  if (input.clinicalFunctionalStatus !== undefined)
    filters.push({
      column: 'clinicalfunctionalstatus',
      operator: 'iexact',
      value: input.clinicalFunctionalStatus,
    });
  let effectiveName = input.name;
  let result = await workflow.page('allele', {
    filters,
    limit: input.limit,
    offset: input.offset,
  });
  if (input.name !== undefined && result.items.length === 0) {
    const suffix = input.name.toUpperCase().startsWith(input.geneSymbol.toUpperCase())
      ? input.name.slice(input.geneSymbol.length).trimStart()
      : '';
    if (suffix.startsWith('*')) {
      const exactExists =
        result.page.total !== null
          ? result.page.total > 0
          : input.offset > 0 &&
            (await workflow.page('allele', { filters, limit: 1 })).items.length > 0;
      if (!exactExists) {
        effectiveName = suffix;
        result = await workflow.page('allele', {
          filters: filters.map((filter) =>
            filter.column === 'name'
              ? { column: 'name', operator: 'eq' as const, value: suffix }
              : filter,
          ),
          limit: input.limit,
          offset: input.offset,
        });
      }
    }
  }
  // The initial reserve covers the count probe and at least one evidence request.
  let reservedPages = 2;
  const frequencyQuery = (count: number): { filters: CpicFilter[] } => ({
    filters: [
      { column: 'genesymbol', operator: 'eq', value: input.geneSymbol },
      {
        column: 'name',
        operator: 'in',
        value: [...new Set(result.items.slice(0, count).map((row) => row.name))],
      },
    ],
  });
  const frequencyUrls = (count: number) => {
    const names = [...new Set(result.items.slice(0, count).map((row) => row.name))];
    if (!names.length) return [];
    return Array.from({ length: reservedPages }, (_, index) =>
      buildCpicUrl('population_frequency_view', {
        ...frequencyQuery(count),
        limit: frequencyPageSize + 1,
        offset: index * frequencyPageSize,
      }),
    );
  };
  let count = select(result.items, result.page, frequencyUrls);
  if (count > 1) {
    const probe = await workflow.page('population_frequency_view', {
      ...frequencyQuery(count),
      limit: 1,
    });
    // An exact count bounds every narrower prefix; unknown totals retain the scan's full bound.
    reservedPages =
      probe.page.total === null
        ? probe.items.length
          ? frequencyScanCap / frequencyPageSize
          : 0
        : Math.min(
            frequencyScanCap / frequencyPageSize,
            Math.ceil(probe.page.total / frequencyPageSize),
          );
    count = select(result.items.slice(0, count), result.page, frequencyUrls);
  }
  const budgetTrimmed = count < result.items.length;
  result = {
    ...result,
    items: result.items.slice(0, count),
    page: {
      ...result.page,
      returned: count,
      nextOffset: budgetTrimmed ? result.page.offset + count : result.page.nextOffset,
    },
  };
  const names = [...new Set(result.items.map((row) => row.name))];
  const frequencies =
    names.length === 0 || reservedPages === 0
      ? []
      : await workflow.scan(
          'population_frequency_view',
          {
            filters: [
              { column: 'genesymbol', operator: 'eq', value: input.geneSymbol },
              { column: 'name', operator: 'in', value: names },
            ],
          },
          frequencyScanCap,
        );
  return {
    effectiveName,
    budgetTrimmed,
    items: result.items.map((row) =>
      workflow.join(row, {
        populationFrequencies: frequencies.filter(
          (frequency) => frequency.genesymbol === row.genesymbol && frequency.name === row.name,
        ),
      }),
    ),
    page: result.page,
    provenance: workflow.provenance(),
  };
}
