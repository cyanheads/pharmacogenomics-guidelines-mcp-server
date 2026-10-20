/**
 * @fileoverview Bounded CPIC pair discovery, exact drug resolution and guideline joins.
 * @module services/cpic/discovery
 */
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { CpicWorkflow } from './cpic-service.js';
import { clinicalCaveat } from './provenance.js';
import type { CpicFilter } from './query.js';
import type { Drug } from './records.js';

/** Exact name or ID selector, reusable by recommendation workflows. */
export interface DrugSelector {
  drugId?: string;
  drugName?: string;
}
/** Resolve every exact candidate; callers must handle ambiguity explicitly. */
export function resolveDrug(workflow: CpicWorkflow, selector: DrugSelector): Promise<Drug[]> {
  const filters: CpicFilter[] =
    selector.drugId !== undefined
      ? [{ column: 'drugid', operator: 'eq', value: selector.drugId }]
      : [{ column: 'name', operator: 'iexact', value: selector.drugName ?? '' }];
  return workflow.scan('drug', { filters }, 500);
}

/** Normalized discovery selectors. Identifier filters combine with AND. */
export interface PairSearch {
  atcId?: string | undefined;
  cpicLevel?: string | undefined;
  drugId?: string | undefined;
  drugName?: string | undefined;
  geneSymbol?: string | undefined;
  includeRetired: boolean;
  limit: number;
  offset: number;
  pgxTesting?: string | undefined;
  provisional?: boolean | undefined;
  rxnormId?: string | undefined;
  usedForRecommendation?: string | undefined;
}
/** Search a pair page, then enrich all returned drug IDs in one bounded batch. */
export async function searchPairs(workflow: CpicWorkflow, input: PairSearch) {
  const filters: CpicFilter[] = [];
  for (const [key, column] of [
    ['geneSymbol', 'genesymbol'],
    ['cpicLevel', 'cpiclevel'],
    ['pgxTesting', 'pgxtesting'],
    ['usedForRecommendation', 'usedforrecommendation'],
  ] as const) {
    const value = input[key];
    if (value !== undefined) filters.push({ column, operator: 'eq', value });
  }
  if (input.drugName !== undefined)
    filters.push({ column: 'drugname', operator: 'substring', value: input.drugName });
  if (input.provisional !== undefined)
    filters.push({ column: 'provisional', operator: 'eq', value: input.provisional });
  if (!input.includeRetired && input.cpicLevel !== 'Retired')
    filters.push({ column: 'cpiclevel', operator: 'neq', value: 'Retired' });
  if (input.drugId !== undefined || input.rxnormId !== undefined || input.atcId !== undefined) {
    const drugFilters: CpicFilter[] = [];
    if (input.drugId !== undefined)
      drugFilters.push({ column: 'drugid', operator: 'eq', value: input.drugId });
    if (input.rxnormId !== undefined)
      drugFilters.push({ column: 'rxnormid', operator: 'eq', value: input.rxnormId });
    if (input.atcId !== undefined)
      drugFilters.push({ column: 'atcid', operator: 'contains', value: [input.atcId] });
    const drugs = await workflow.scan('drug', { filters: drugFilters }, 500);
    if (drugs.length === 0)
      return {
        items: [],
        page: { limit: input.limit, offset: input.offset, returned: 0, total: 0, nextOffset: null },
        provenance: workflow.provenance(),
      };
    filters.push({ column: 'drugid', operator: 'in', value: drugs.map((d) => d.drugid) });
  }
  const result = await workflow.page('pair_view', {
    filters,
    limit: input.limit,
    offset: input.offset,
  });
  const ids = [...new Set(result.items.flatMap((p) => (p.drugid ? [p.drugid] : [])))];
  const drugs = ids.length
    ? await workflow.scan(
        'drug',
        { filters: [{ column: 'drugid', operator: 'in', value: ids }] },
        500,
      )
    : [];
  const byId = new Map(drugs.map((d) => [d.drugid, d]));
  const items = result.items.map((pair) => {
    const drug = pair.drugid ? byId.get(pair.drugid) : undefined;
    if (pair.drugid && !drug)
      throw serializationError('CPIC pair refers to a missing drug record.', { retryable: false });
    return { ...pair, drug: drug ?? null };
  });
  return { items, page: result.page, provenance: workflow.provenance() };
}

/** Validated guideline selector. */
export type GuidelineSelector =
  | { by: 'id'; guidelineId: number }
  | { by: 'gene'; geneSymbol: string }
  | ({ by: 'drug' } & DrugSelector);
/** Resolve all matching guidelines and join complete related records by source IDs/URLs. */
export async function getGuideline(workflow: CpicWorkflow, input: GuidelineSelector) {
  const candidates = input.by === 'drug' ? await resolveDrug(workflow, input) : [];
  const guidance = 'Call pgx_search_pairs to find a gene or drug and its guideline coverage.';
  if (input.by === 'drug' && candidates.length !== 1)
    return {
      found: false,
      guidelines: [],
      candidates,
      guidance:
        candidates.length > 1 ? 'Retry pgx_get_guideline with one candidate drugId.' : guidance,
      clinicalCaveat,
      provenance: workflow.provenance(),
    };
  const filters: CpicFilter[] =
    input.by === 'id'
      ? [{ column: 'id', operator: 'eq', value: input.guidelineId }]
      : input.by === 'gene'
        ? [{ column: 'genes', operator: 'contains', value: [input.geneSymbol] }]
        : [
            {
              column: 'id',
              operator: 'in',
              value: candidates.flatMap((d) => (d.guidelineid == null ? [] : [d.guidelineid])),
            },
          ];
  if (input.by === 'drug' && candidates[0]?.guidelineid == null)
    return {
      found: false,
      guidelines: [],
      candidates: [],
      guidance,
      clinicalCaveat,
      provenance: workflow.provenance(),
    };
  const records = await workflow.scan('guideline', { filters }, 100);
  const ids = records.map((r) => r.id),
    urls = records.flatMap((r) => (r.url ? [r.url] : []));
  const drugs = ids.length
    ? await workflow.scan('drug', {
        filters: [{ column: 'guidelineid', operator: 'in', value: ids }],
      })
    : [];
  const pairs = urls.length
    ? await workflow.scan('pair_view', {
        filters: [{ column: 'guidelineurl', operator: 'in', value: urls }],
      })
    : [];
  return {
    found: records.length > 0,
    guidelines: records.map((record) => ({
      record,
      drugs: drugs.filter((d) => d.guidelineid === record.id),
      pairs: pairs.filter((p) => record.url != null && p.guidelineurl === record.url),
    })),
    candidates: [],
    guidance: records.length ? '' : guidance,
    clinicalCaveat,
    provenance: workflow.provenance(),
  };
}

/** Read one live reference page using the caller's shared workflow budget. */
export async function listReference(
  workflow: CpicWorkflow,
  input: { topic: 'genes' | 'phenotypes'; geneSymbol?: string; limit: number; offset: number },
) {
  if (input.topic === 'genes') {
    const result = await workflow.page('gene', {
      limit: input.limit,
      offset: input.offset,
      filters: input.geneSymbol
        ? [{ column: 'symbol', operator: 'eq', value: input.geneSymbol }]
        : [],
    });
    return { items: result.items, page: result.page, provenance: workflow.provenance() };
  }
  const result = await workflow.page('gene_result', {
    limit: input.limit,
    offset: input.offset,
    filters: [{ column: 'genesymbol', operator: 'eq', value: input.geneSymbol ?? '' }],
  });
  return { items: result.items, page: result.page, provenance: workflow.provenance() };
}
