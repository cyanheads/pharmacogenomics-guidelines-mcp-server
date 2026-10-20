/**
 * @fileoverview Fixed-host CPIC queries with literal PostgREST filter encoding.
 * @module services/cpic/query
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { CpicEndpoint, DiplotypeKey } from './records.js';

/** Only these source columns may be filtered by the client. */
export const endpointColumns = {
  pair_view: [
    'pairid',
    'drugid',
    'drugname',
    'genesymbol',
    'guidelineurl',
    'cpiclevel',
    'provisional',
    'pgxtesting',
    'usedforrecommendation',
  ],
  drug: ['drugid', 'name', 'rxnormid', 'atcid', 'guidelineid'],
  guideline: ['id', 'genes'],
  gene: ['symbol'],
  gene_result: ['id', 'genesymbol', 'result', 'activityscore'],
  diplotype: ['genesymbol', 'diplotype'],
  recommendation: [
    'id',
    'lookupkey',
    'drugid',
    'guidelineid',
    'phenotypes',
    'activityscore',
    'allelestatus',
    'population',
  ],
  allele: ['id', 'genesymbol', 'name', 'clinicalfunctionalstatus'],
  population_frequency_view: ['genesymbol', 'name'],
  'rpc/recommendation_lookup': ['recommendationid'],
} as const satisfies Record<CpicEndpoint, readonly string[]>;
const orders: Record<CpicEndpoint, string> = {
  pair_view: 'pairid.asc',
  drug: 'drugid.asc',
  guideline: 'id.asc',
  gene: 'symbol.asc',
  gene_result: 'id.asc',
  diplotype: 'genesymbol.asc,diplotype.asc',
  recommendation: 'id.asc',
  allele: 'id.asc',
  population_frequency_view: 'genesymbol.asc,name.asc,population_group.asc',
  'rpc/recommendation_lookup': 'recommendationid.asc',
};
/** Safe literal operations; never a caller-supplied PostgREST expression. */
export type CpicFilter = { column: string } & (
  | { operator: 'eq' | 'neq'; value: string | number | boolean }
  | { operator: 'substring' | 'iexact'; value: string }
  | { operator: 'in'; value: readonly (string | number)[] }
  | { operator: 'contains'; value: readonly string[] | Record<string, string> }
);
/** Internal query arguments; the endpoint fixes select and stable ordering. */
export interface CpicQuery {
  diplotypeLookup?: DiplotypeKey;
  filters?: readonly CpicFilter[];
  limit?: number;
  offset?: number;
}

/** Quote a PostgREST list/array element, escaping quotation and backslash. */
export function quoteLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** Escape PostgreSQL regex syntax so imatch treats input as literal text. */
export function literalPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function expression(filter: CpicFilter): string {
  switch (filter.operator) {
    case 'eq':
    case 'neq':
      return `${filter.operator}.${filter.value}`;
    case 'substring':
      return `imatch.${literalPattern(filter.value)}`;
    case 'iexact':
      return `imatch.^${literalPattern(filter.value)}$`;
    case 'in':
      return `in.(${filter.value.map((value) => (typeof value === 'string' ? quoteLiteral(value) : value)).join(',')})`;
    case 'contains':
      return `cs.${Array.isArray(filter.value) ? `{${filter.value.map(quoteLiteral).join(',')}}` : JSON.stringify(filter.value)}`;
  }
}

/** Build one GET URL; no host, path, selection, ordering or raw-filter override. */
export function buildCpicUrl(endpoint: CpicEndpoint, query: CpicQuery = {}): string {
  const limit = query.limit ?? 25;
  const offset = query.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 101 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw validationError('Invalid CPIC page bounds.', {
      reason: 'invalid_selector',
      retryable: false,
    });
  }
  const url = new URL(endpoint, 'https://api.cpicpgx.org/v1/');
  url.searchParams.set(
    'select',
    endpoint === 'recommendation'
      ? '*,guideline(*),drug(*)'
      : endpoint === 'allele'
        ? '*,allele_definition(*)'
        : '*',
  );
  url.searchParams.set('order', orders[endpoint]);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  for (const filter of query.filters ?? []) {
    if (!(endpointColumns[endpoint] as readonly string[]).includes(filter.column)) {
      throw validationError('Unsupported CPIC filter column.', {
        reason: 'invalid_selector',
        retryable: false,
      });
    }
    url.searchParams.append(filter.column, expression(filter));
  }
  if (query.diplotypeLookup !== undefined) {
    if (endpoint !== 'rpc/recommendation_lookup') {
      throw validationError('Genotype lookup requires the CPIC lookup endpoint.', {
        reason: 'invalid_selector',
        retryable: false,
      });
    }
    url.searchParams.set('diplotypelookup', JSON.stringify(query.diplotypeLookup));
  }
  return url.href;
}
