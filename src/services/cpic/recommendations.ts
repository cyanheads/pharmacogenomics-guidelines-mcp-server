/**
 * @fileoverview Source-only recommendation matching with bounded completeness checks.
 * @module services/cpic/recommendations
 */
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import type { CpicWorkflow } from './cpic-service.js';
import { type DrugSelector, resolveDrug } from './discovery.js';
import { resolveDiplotype } from './evidence.js';
import { clinicalCaveat } from './provenance.js';
import type { CpicFilter } from './query.js';
import type { DiplotypeKey, Recommendation } from './records.js';

/** An explicitly supplied gene result, never inferred from another result kind. */
export type ExplicitGeneResult = {
  kind: 'phenotype' | 'activityScore' | 'alleleStatus';
  value: string;
};
/** Normalized selectors validated by the public tool before any network request. */
export interface RecommendationQuery extends DrugSelector {
  activityScore?: string;
  geneResults?: Record<string, ExplicitGeneResult>;
  geneSymbol?: string;
  genotype?: Record<string, string>;
  limit: number;
  mode: 'drug' | 'genotype';
  offset: number;
  phenotype?: string;
  population?: string;
}
type Resolution = Awaited<ReturnType<typeof resolveDiplotype>>;
type IncompleteMatch = { recommendationId: number; drugId: string | null; missingGenes: string[] };
const noMatch =
  'No recommendations matched. Call pgx_search_pairs to check guideline coverage or pgx_list_reference with topic phenotypes for the supplied gene.';
const incompleteNotice =
  'Recommendations require additional gene results. Supply the listed missingGenes to pgx_get_recommendations; omitted genes are not assumed normal.';
const exploratoryNotice =
  'Exploratory source recommendations: no genotype or phenotype match has been established.';

function decimal(value: string): string | null {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [whole = '', fraction = ''] = unsigned.split('.');
  const integer = whole.replace(/^0+/, '') || '0';
  const tail = fraction.replace(/0+$/, '');
  const magnitude = tail ? `${integer}.${tail}` : integer;
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}
function equalScore(left: string, right: string): boolean {
  return left === right || (decimal(left) !== null && decimal(left) === decimal(right));
}
function statusAlias(gene: string, value: string): string {
  return value.startsWith(gene) && value.slice(gene.length).trim().startsWith('*')
    ? value.slice(gene.length).trim()
    : value;
}
function requireRelations(row: Recommendation): void {
  if (
    !row.guideline ||
    !row.drug ||
    row.guideline.id !== row.guidelineid ||
    row.drug.drugid !== row.drugid
  )
    throw serializationError(
      'CPIC recommendation is missing a required guideline or drug relation.',
      { retryable: false },
    );
  if (!row.lookupkey || Object.keys(row.lookupkey).length === 0)
    throw serializationError('CPIC recommendation has no genetic lookup prerequisites.', {
      retryable: false,
    });
}
function pageRows<T>(rows: T[], input: RecommendationQuery) {
  const items = rows.slice(input.offset, input.offset + input.limit);
  const next = input.offset + items.length;
  return {
    items,
    page: {
      limit: input.limit,
      offset: input.offset,
      returned: items.length,
      total: rows.length,
      nextOffset: next < rows.length ? next : null,
    },
  };
}

async function resolveResults(workflow: CpicWorkflow, inputs: Record<string, ExplicitGeneResult>) {
  const resolved: Record<string, ExplicitGeneResult> = {};
  for (const [gene, input] of Object.entries(inputs)) {
    const references = await workflow.scan('gene_result', {
      filters: [{ column: 'genesymbol', operator: 'eq', value: gene }],
    });
    const values = [
      ...new Set(
        references.flatMap((row) =>
          input.kind === 'activityScore'
            ? row.activityscore == null
              ? []
              : [row.activityscore]
            : [row.result],
        ),
      ),
    ];
    const supplied = input.kind === 'alleleStatus' ? statusAlias(gene, input.value) : input.value;
    const matches = values.filter((value) =>
      input.kind === 'activityScore'
        ? equalScore(value, supplied)
        : value.toLowerCase() === supplied.toLowerCase(),
    );
    const exact = values.find((value) => value === supplied);
    const selected = exact ?? (matches.length === 1 ? matches[0] : undefined);
    if (
      selected === undefined &&
      !(
        input.kind === 'activityScore' &&
        matches.length > 0 &&
        matches.every((value) => equalScore(value, supplied))
      )
    )
      throw validationError('The gene result is unsupported or ambiguous in CPIC source values.', {
        reason: 'unsupported_gene_result',
        geneSymbol: gene,
        retryable: false,
      });
    resolved[gene] = { kind: input.kind, value: selected ?? supplied };
  }
  return resolved;
}
function matchesResult(row: Recommendation, gene: string, result: ExplicitGeneResult): boolean {
  if (result.kind === 'phenotype') return row.phenotypes?.[gene] === result.value;
  if (result.kind === 'activityScore') {
    const score = row.activityscore?.[gene];
    const key = row.lookupkey?.[gene];
    return (
      score !== undefined &&
      key !== undefined &&
      equalScore(score, result.value) &&
      equalScore(key, result.value)
    );
  }
  const status = row.allelestatus?.[gene];
  return (
    row.lookupkey?.[gene] === result.value &&
    status !== undefined &&
    statusAlias(gene, status) === result.value
  );
}

/** Retrieve exploratory source rows or require every genetic prerequisite before matching. */
export async function getRecommendations(workflow: CpicWorkflow, input: RecommendationQuery) {
  const geneResolutions: Resolution[] = [];
  const incompleteMatches: IncompleteMatch[] = [];
  const notices: string[] = [];
  function finish(
    status: 'exploratory' | 'matched' | 'no_match' | 'incomplete' | 'unresolved',
    rows: Recommendation[],
  ) {
    return {
      status,
      ...pageRows(rows, input),
      incompleteMatches,
      geneResolutions,
      clinicalCaveat,
      provenance: workflow.provenance(),
      notices,
    };
  }
  const hasDrug = input.drugId !== undefined || input.drugName !== undefined;
  const drugs = hasDrug ? await resolveDrug(workflow, input) : [];
  if (drugs.length > 1)
    throw validationError('The exact drug name identifies multiple source drugs.', {
      reason: 'ambiguous_drug',
      candidates: drugs,
      retryable: false,
    });
  if (hasDrug && drugs.length === 0) {
    notices.push(noMatch);
    return finish('no_match', []);
  }
  const drug = drugs[0];
  const filters: CpicFilter[] = drug
    ? [{ column: 'drugid', operator: 'eq', value: drug.drugid }]
    : [];
  const hasResult =
    input.phenotype !== undefined ||
    input.activityScore !== undefined ||
    input.geneResults !== undefined;
  if (
    input.mode === 'drug' &&
    !hasResult &&
    input.geneSymbol === undefined &&
    input.population === undefined
  ) {
    const result = await workflow.page('recommendation', {
      filters,
      limit: input.limit,
      offset: input.offset,
    });
    result.items.forEach(requireRelations);
    notices.push(exploratoryNotice);
    if (result.items.length === 0) notices.push(noMatch);
    return {
      status: 'exploratory' as const,
      items: result.items,
      page: result.page,
      incompleteMatches,
      geneResolutions,
      clinicalCaveat,
      provenance: workflow.provenance(),
      notices,
    };
  }
  let rows: Recommendation[];
  const genotypeKeys: Record<string, string> = {};
  if (input.mode === 'genotype') {
    const entries = Object.entries(input.genotype ?? {});
    for (let start = 0; start < entries.length; start += 3) {
      const batch = await Promise.all(
        entries
          .slice(start, start + 3)
          .map(([gene, diplotype]) => resolveDiplotype(workflow, gene, diplotype)),
      );
      geneResolutions.push(...batch);
    }
    if (geneResolutions.some((result) => result.records.length !== 1)) {
      notices.push(
        ...geneResolutions.flatMap((result) => (result.guidance ? [result.guidance] : [])),
      );
      return finish('unresolved', []);
    }
    const diplotypeLookup: DiplotypeKey = {};
    for (const resolution of geneResolutions) {
      const record = resolution.records[0];
      if (
        !record?.diplotypekey?.[resolution.geneSymbol] ||
        !record.lookupkey?.[resolution.geneSymbol]
      )
        throw serializationError(
          'CPIC diplotype lacks its required source genotype or lookup key.',
          { retryable: false },
        );
      for (const [gene, key] of Object.entries(record.diplotypekey)) {
        if (
          !entries.some(([supplied]) => supplied === gene) ||
          (diplotypeLookup[gene] !== undefined &&
            JSON.stringify(diplotypeLookup[gene]) !== JSON.stringify(key))
        )
          throw serializationError(
            'CPIC diplotype contains conflicting or unsupplied genetic prerequisites.',
            { retryable: false },
          );
        diplotypeLookup[gene] = key;
      }
      for (const [gene, key] of Object.entries(record.lookupkey)) {
        if (
          !entries.some(([supplied]) => supplied === gene) ||
          (genotypeKeys[gene] !== undefined && genotypeKeys[gene] !== key)
        )
          throw serializationError(
            'CPIC diplotype contains conflicting or unsupplied lookup keys.',
            { retryable: false },
          );
        genotypeKeys[gene] = key;
      }
    }
    const candidates = await workflow.scan('rpc/recommendation_lookup', { diplotypeLookup });
    const ids = [...new Set(candidates.map((row) => row.recommendationid))];
    const byId = new Map<number, Recommendation>();
    for (let start = 0; start < ids.length; start += 100) {
      const batch = await workflow.scan('recommendation', {
        filters: [{ column: 'id', operator: 'in', value: ids.slice(start, start + 100) }],
      });
      for (const row of batch) byId.set(row.id, row);
    }
    rows = ids.map((id) => {
      const row = byId.get(id);
      if (!row)
        throw serializationError('CPIC lookup refers to a missing recommendation record.', {
          retryable: false,
        });
      return row;
    });
    if (drug) rows = rows.filter((row) => row.drugid === drug.drugid);
  } else rows = await workflow.scan('recommendation', { filters });
  rows.forEach(requireRelations);
  const availableGenes = [...new Set(rows.flatMap((row) => Object.keys(row.lookupkey ?? {})))];
  if (input.population !== undefined)
    rows = rows.filter((row) => row.population?.trim() === input.population);
  if (input.mode === 'drug' && !hasResult) {
    if (input.geneSymbol)
      rows = rows.filter((row) => Object.hasOwn(row.lookupkey ?? {}, input.geneSymbol as string));
    notices.push(exploratoryNotice);
    if (rows.length === 0) notices.push(noMatch);
    return finish('exploratory', rows);
  }
  let supplied = input.geneResults ?? {};
  if (input.phenotype !== undefined || input.activityScore !== undefined) {
    const gene = input.geneSymbol ?? (availableGenes.length === 1 ? availableGenes[0] : undefined);
    if (!gene)
      throw validationError(
        `An explicit gene is required for this result. Available genes: ${JSON.stringify(availableGenes)}.`,
        { reason: 'gene_required', availableGenes, retryable: false },
      );
    supplied = {
      [gene]:
        input.phenotype !== undefined
          ? { kind: 'phenotype', value: input.phenotype }
          : { kind: 'activityScore', value: input.activityScore as string },
    };
  }
  const resolved = input.mode === 'drug' ? await resolveResults(workflow, supplied) : {};
  const resolvedEntries = Object.entries(resolved);
  const matched: Recommendation[] = [];
  for (const row of rows) {
    const keys = Object.entries(row.lookupkey ?? {});
    if (
      input.mode === 'drug' &&
      !resolvedEntries.every(([gene, result]) => matchesResult(row, gene, result))
    )
      continue;
    if (
      input.mode === 'genotype' &&
      keys.some(([gene, value]) => genotypeKeys[gene] !== undefined && genotypeKeys[gene] !== value)
    )
      continue;
    const missingGenes = keys
      .filter(([gene]) =>
        input.mode === 'genotype' ? genotypeKeys[gene] === undefined : resolved[gene] === undefined,
      )
      .map(([gene]) => gene);
    if (missingGenes.length > 0) {
      incompleteMatches.push({
        recommendationId: row.id,
        drugId: row.drugid ?? null,
        missingGenes,
      });
      continue;
    }
    matched.push(row);
  }
  if (incompleteMatches.length) notices.push(incompleteNotice);
  if (!matched.length && !incompleteMatches.length) notices.push(noMatch);
  return finish(
    matched.length ? 'matched' : incompleteMatches.length ? 'incomplete' : 'no_match',
    matched,
  );
}
