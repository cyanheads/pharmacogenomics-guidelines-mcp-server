/**
 * @fileoverview Bounded source diplotype resolution and allele evidence joins.
 * @module services/cpic/evidence
 */
import type { CpicWorkflow } from './cpic-service.js';
import type { CpicFilter } from './query.js';
import type { Diplotype } from './records.js';

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
export async function searchAlleles(workflow: CpicWorkflow, input: AlleleSearch) {
  const filters: CpicFilter[] = [{ column: 'genesymbol', operator: 'eq', value: input.geneSymbol }];
  if (input.name !== undefined) filters.push({ column: 'name', operator: 'eq', value: input.name });
  if (input.clinicalFunctionalStatus !== undefined)
    filters.push({
      column: 'clinicalfunctionalstatus',
      operator: 'eq',
      value: input.clinicalFunctionalStatus,
    });
  const result = await workflow.page('allele', {
    filters,
    limit: input.limit,
    offset: input.offset,
  });
  const names = [...new Set(result.items.map((row) => row.name))];
  const frequencies =
    names.length === 0
      ? []
      : await workflow.scan(
          'population_frequency_view',
          {
            filters: [
              { column: 'genesymbol', operator: 'eq', value: input.geneSymbol },
              { column: 'name', operator: 'in', value: names },
            ],
          },
          2000,
        );
  return {
    items: result.items.map((row) => ({
      ...row,
      populationFrequencies: frequencies.filter(
        (frequency) => frequency.genesymbol === row.genesymbol && frequency.name === row.name,
      ),
    })),
    page: result.page,
    provenance: workflow.provenance(),
  };
}
