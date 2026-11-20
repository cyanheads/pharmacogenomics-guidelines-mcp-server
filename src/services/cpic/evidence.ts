/**
 * @fileoverview Bounded source diplotype resolution and allele evidence joins.
 * @module services/cpic/evidence
 */
import type { CpicWorkflow } from './cpic-service.js';
import type { CpicFilter } from './query.js';
import type { Diplotype } from './records.js';

const frequencyScanCap = 2000;

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
    const parts = inputDiplotype.split('/');
    const [first, second] = parts;
    if (parts.length === 2 && first?.trim() && second?.trim()) {
      const normalize = (part: string, allowPairPrefix: boolean) => {
        const allele = part.trim();
        if (!allele.toUpperCase().startsWith(geneSymbol)) return allele;
        const suffix = allele.slice(geneSymbol.length);
        // Retain the established whitespace-delimited prefix on a full non-star pair.
        return suffix.trimStart().startsWith('*') || (allowPairPrefix && /^\s+\S/.test(suffix))
          ? suffix.trimStart()
          : allele;
      };
      const left = normalize(first, true);
      const right = normalize(second, false);
      if (!(await attempt(`${left}/${right}`))) await attempt(`${right}/${left}`);
    } else if (parts.length === 1) {
      const suffix = inputDiplotype.toUpperCase().startsWith(geneSymbol)
        ? inputDiplotype.slice(geneSymbol.length).trimStart()
        : inputDiplotype;
      if (suffix.startsWith('*') && !(await attempt(suffix)) && geneSymbol.startsWith('HLA-')) {
        const status = suffix.match(/^(\*\S+)\s+(positive|negative)$/i);
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
  includePopulationFrequencies: boolean;
  limit: number;
  name?: string;
  offset: number;
}

/** Read a source allele page and optionally join complete bounded population-frequency evidence. */
export async function searchAlleles(workflow: CpicWorkflow, input: AlleleSearch) {
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
  if (!input.includePopulationFrequencies || result.items.length === 0) {
    return {
      effectiveName,
      items: result.items,
      page: result.page,
      provenance: workflow.provenance(),
    };
  }
  const names = [...new Set(result.items.map((row) => row.name))];
  const frequencies = await workflow.scan(
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
