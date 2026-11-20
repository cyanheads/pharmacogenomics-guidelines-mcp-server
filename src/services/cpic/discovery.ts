/**
 * @fileoverview Bounded CPIC pair discovery, exact drug resolution and guideline joins.
 * @module services/cpic/discovery
 */
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { CpicPageInfo, CpicWorkflow } from './cpic-service.js';
import type { CpicFilter } from './query.js';
import type { Drug, Guideline } from './records.js';

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
    return workflow.join(pair, { drug: drug ?? null });
  });
  return { items, page: result.page, provenance: workflow.provenance() };
}

/** Validated guideline selector. */
export type GuidelineSelector =
  | { by: 'id'; guidelineId: number }
  | { by: 'gene'; geneSymbol: string }
  | ({ by: 'drug' } & DrugSelector);

/** Return the exact source guidelines linked to a resolved drug. */
export async function findDrugGuidelines(workflow: CpicWorkflow, drug: Drug) {
  const [direct, pairs] = await Promise.all([
    drug.guidelineid == null
      ? []
      : workflow
          .page('guideline', {
            filters: [{ column: 'id', operator: 'eq', value: drug.guidelineid }],
            limit: 1,
          })
          .then((result) => result.items),
    workflow.scan('pair_view', {
      filters: [{ column: 'drugid', operator: 'eq', value: drug.drugid }],
    }),
  ]);
  const urls = [
    ...new Set(pairs.flatMap((pair) => (pair.guidelineurl ? [pair.guidelineurl] : []))),
  ];
  const linked = await findByBatches(workflow, 'guideline', 'url', urls, 25);
  return [...new Map([...direct, ...linked].map((record) => [record.id, record])).values()].sort(
    (a, b) => a.id - b.id,
  );
}

/** Keep source in-list request targets short while retaining every match. */
async function findByBatches<E extends 'drug' | 'guideline' | 'pair_view'>(
  workflow: CpicWorkflow,
  endpoint: E,
  column: string,
  values: readonly (string | number)[],
  batchSize: number,
) {
  const rows = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    rows.push(
      ...(await workflow.scan(endpoint, {
        filters: [{ column, operator: 'in', value: values.slice(offset, offset + batchSize) }],
      })),
    );
  }
  return rows;
}

function relatedPage<T>(rows: T[], { limit, offset }: { limit: number; offset: number }) {
  const items = rows.slice(offset, offset + limit);
  const end = offset + items.length;
  return {
    items,
    page: {
      limit,
      offset,
      returned: items.length,
      total: rows.length,
      nextOffset: end < rows.length ? end : null,
    },
  };
}

async function guidelineRelations(workflow: CpicWorkflow, records: Guideline[]) {
  const urls = [...new Set(records.flatMap((record) => (record.url ? [record.url] : [])))];
  const [directDrugs, pairs] = await Promise.all([
    findByBatches(
      workflow,
      'drug',
      'guidelineid',
      records.map((record) => record.id),
      100,
    ),
    findByBatches(workflow, 'pair_view', 'guidelineurl', urls, 25),
  ]);
  const drugsById = new Map(directDrugs.map((drug) => [drug.drugid, drug]));
  const missingDrugIds = [
    ...new Set(
      pairs.flatMap((pair) => (pair.drugid && !drugsById.has(pair.drugid) ? [pair.drugid] : [])),
    ),
  ];
  for (const drug of await findByBatches(workflow, 'drug', 'drugid', missingDrugIds, 100))
    drugsById.set(drug.drugid, drug);

  const directByGuideline = Map.groupBy(directDrugs, (drug) => drug.guidelineid);
  const pairsByUrl = Map.groupBy(pairs, (pair) => pair.guidelineurl);
  return records.map((record) => {
    const linkedPairs = record.url ? (pairsByUrl.get(record.url) ?? []) : [];
    const linkedDrugs = new Map(
      (directByGuideline.get(record.id) ?? []).map((drug) => [drug.drugid, drug]),
    );
    for (const pair of linkedPairs) {
      const drug = pair.drugid == null ? undefined : drugsById.get(pair.drugid);
      if (drug) linkedDrugs.set(drug.drugid, drug);
    }
    const drugs = [...linkedDrugs.values()].sort((a, b) =>
      a.drugid < b.drugid ? -1 : Number(a.drugid > b.drugid),
    );
    return { record, drugs, pairs: linkedPairs };
  });
}

/** Page guideline descriptors and one selected related collection by exact source IDs/URLs. */
export async function getGuideline(
  workflow: CpicWorkflow,
  input: GuidelineSelector,
  paging: { view: 'summary' | 'drugs' | 'pairs'; limit: number; offset: number },
) {
  const guidance = 'Call pgx_search_pairs to find a gene or drug and its guideline coverage.';
  let source: { items: Guideline[]; page: CpicPageInfo };
  if (input.by === 'drug') {
    const candidates = await resolveDrug(workflow, input);
    const [drug, anotherDrug] = candidates;
    if (!drug || anotherDrug) {
      const result = relatedPage(candidates, paging);
      return {
        found: false,
        guidelines: [],
        candidates: result.items,
        page: result.page,
        guidance: anotherDrug ? 'Retry pgx_get_guideline with one candidate drugId.' : guidance,
        provenance: workflow.provenance(),
      };
    }
    source = relatedPage(await findDrugGuidelines(workflow, drug), paging);
  } else {
    source = await workflow.page('guideline', {
      filters:
        input.by === 'id'
          ? [{ column: 'id', operator: 'eq', value: input.guidelineId }]
          : [{ column: 'genes', operator: 'contains', value: [input.geneSymbol] }],
      limit: paging.view === 'summary' ? paging.limit : 1,
      offset: paging.view === 'summary' ? paging.offset : 0,
    });
  }
  const relations = await guidelineRelations(workflow, source.items);
  const drugs =
    paging.view === 'drugs' ? relatedPage(relations[0]?.drugs ?? [], paging) : undefined;
  const pairs =
    paging.view === 'pairs' ? relatedPage(relations[0]?.pairs ?? [], paging) : undefined;
  const found = source.items.length > 0 || (source.page.total ?? 0) > 0;
  return {
    found,
    guidelines: relations.map(({ record, drugs, pairs }) => ({
      record,
      drugCount: drugs.length,
      pairCount: pairs.length,
    })),
    ...(drugs && { drugs: drugs.items }),
    ...(pairs && { pairs: pairs.items }),
    page: drugs?.page ?? pairs?.page ?? source.page,
    candidates: [],
    guidance: found ? '' : guidance,
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
