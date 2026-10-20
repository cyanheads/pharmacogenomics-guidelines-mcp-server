/**
 * @fileoverview Browse source recommendations or match explicitly supplied genetic results.
 * @module mcp-server/tools/definitions/get-recommendations
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DiplotypeSchema,
  type ExplicitGeneResult,
  getCpicService,
  getRecommendations,
  provenanceSchema,
  type RecommendationQuery,
  RecommendationSchema,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
import {
  cappedEnrichmentFields,
  drugIdSchema,
  optionalText,
  optionalTextSchema,
  pageSchema,
  recommendationPaginationFields,
} from '../shared/schemas.js';

const resultValue = z
  .string()
  .min(1)
  .max(500)
  .describe('Exact source result or activity-score string; outer whitespace is ignored.');
const geneResultSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z
        .literal('phenotype')
        .describe('Match the source phenotype, retaining every matching score.'),
      value: resultValue,
    }),
    z.strictObject({
      kind: z
        .literal('activityScore')
        .describe('Match a source activity score by exact decimal equivalence.'),
      value: resultValue,
    }),
    z.strictObject({
      kind: z
        .literal('alleleStatus')
        .describe('Match one named allele status, including its allele identity.'),
      value: resultValue,
    }),
  ])
  .describe('An explicit gene result; distinct kinds are never inferred from one another.');
const inputSchema = z.object({
  mode: z
    .enum(['drug', 'genotype', 'results'])
    .describe(
      'drug requires one drugName or drugId; genotype requires genotype; results requires geneResults or geneSymbol with phenotype/activityScore. Genotype/results optionally accept one drug selector.',
    ),
  drugName: optionalTextSchema(
    200,
    'Exact case-insensitive drug name; obtain names with pgx_search_pairs. Blank means unset.',
  ),
  drugId: drugIdSchema,
  geneSymbol: optionalTextSchema(
    100,
    'Gene for a scalar result or exploratory gene filter. Required for a scalar result when the drug has multiple genes.',
  ),
  phenotype: optionalTextSchema(
    500,
    'Source phenotype for geneSymbol; inspect pgx_list_reference topic phenotypes. Excludes activityScore and geneResults.',
  ),
  activityScore: z
    .union([
      z
        .string()
        .max(500)
        .describe('Exact source decimal or nonnumeric score label; blank means unset.'),
      z.number().describe('A supplied numeric source score; no score is calculated.'),
    ])
    .optional()
    .describe('Source activity score for geneSymbol; excludes phenotype and geneResults.'),
  geneResults: z
    .record(
      z.string().min(1).max(100).describe('Gene symbol, normalized to uppercase.'),
      geneResultSchema,
    )
    .optional()
    .describe(
      'Explicit results for 1–10 genes; excludes scalar geneSymbol, phenotype, activityScore and genotype.',
    ),
  genotype: z
    .record(
      z.string().min(1).max(100).describe('Gene symbol, normalized to uppercase.'),
      z
        .string()
        .min(1)
        .max(500)
        .describe('Source-supported diplotype or named allele-status notation.'),
    )
    .optional()
    .describe(
      'Required in genotype mode: 1–10 explicit gene/diplotype entries. Every entry must resolve uniquely before lookup.',
    ),
  population: optionalTextSchema(
    200,
    'Exact source population after outer whitespace trimming; all matching rows are retained.',
  ),
  ...recommendationPaginationFields,
  incompleteLimit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe('Maximum incomplete diagnostics per page (default 25; maximum 100).'),
  incompleteOffset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe(
      'Independent zero-based incomplete diagnostic offset; follow incompletePage.nextOffset.',
    ),
});
const resolutionSchema = z
  .object({
    found: z.boolean().describe('Whether source diplotype rows were found.'),
    geneSymbol: z.string().describe('Normalized supplied gene symbol.'),
    inputDiplotype: z.string().describe('Trimmed caller notation.'),
    matchedDiplotype: z.string().nullable().describe('Source notation that matched, or null.'),
    records: z
      .array(DiplotypeSchema)
      .describe('Every source match; more than one remains ambiguous.'),
    guidance: z.string().describe('Recovery guidance for an unresolved or ambiguous genotype.'),
  })
  .describe('Source resolution of one explicitly supplied genotype.');

/** Retrieve complete source records only after all matched genetic prerequisites are explicit. */
export const getRecommendationsTool = tool('pgx_get_recommendations', {
  title: 'Get recommendations',
  description:
    'Browse CPIC recommendations in drug mode with one exact drugName or drugId. Match across drugs in results mode with geneResults or geneSymbol plus phenotype/activityScore, or genotype mode with 1–10 uniquely resolved gene/diplotype entries. Both matching modes accept an optional drug. Use pgx_list_reference topic phenotypes for source values. Every matched prerequisite must be explicit; omitted genes are never normal or negative. Preserve populations, scores, classifications and source text. Follow page.nextOffset and incompletePage.nextOffset independently; consult linked guidelines before clinical use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: inputSchema,
  output: z.object({
    status: z
      .enum(['exploratory', 'matched', 'no_match', 'incomplete', 'unresolved'])
      .describe(
        'Exploratory browsing, complete genetic match, no match, missing prerequisites, or unresolved genotype.',
      ),
    items: z
      .array(RecommendationSchema)
      .describe(
        'Complete source records; matched rows have every required gene result explicitly supplied.',
      ),
    incompleteMatches: z
      .array(
        z
          .object({
            recommendationId: z.number().int().describe('Source recommendation identifier.'),
            drugId: z.string().nullable().describe('Source drug identifier, or null.'),
            missingGenes: z
              .array(z.string().describe('An explicitly required gene.'))
              .describe('Missing gene results; no default result is assumed.'),
          })
          .describe('Recommendation requiring additional explicit gene results.'),
      )
      .describe(
        'Reference possibilities requiring additional results; never matched prescribing advice.',
      ),
    geneResolutions: z
      .array(resolutionSchema)
      .describe('Per-gene genotype diagnostics, including ambiguity and source records.'),
    page: pageSchema,
    incompletePage: pageSchema.describe(
      'Independent page of incomplete prerequisite diagnostics; totals computed before either page.',
    ),
    clinicalCaveat: z.string().describe('Source limitations and required clinical qualification.'),
    provenance: provenanceSchema,
  }),
  enrichment: {
    effectiveQuery: inputSchema.describe('Normalized selectors and effective page defaults.'),
    ...cappedEnrichmentFields,
  },
  enrichmentTrailer: {
    effectiveQuery: { render: (value) => renderLossless(value, '$.effectiveQuery') },
    notices: { render: (value) => renderLossless(value, '$.notices') },
  },
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Selectors are missing, conflicting, blank or mixed between modes.',
      recovery:
        'Call pgx_list_reference with topic input_formats, then retry this tool with only the selectors required for the chosen mode.',
    },
    {
      reason: 'gene_required',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A scalar result cannot identify a unique gene.',
      recovery:
        'Call pgx_list_reference with topic phenotypes for a gene listed in the error, then retry pgx_get_recommendations with geneSymbol or geneResults.',
    },
    {
      reason: 'ambiguous_drug',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An exact drug name identifies several drug records.',
      recovery:
        'Call pgx_search_pairs with the drugName, then retry pgx_get_recommendations with one returned drugId.',
    },
    {
      reason: 'unsupported_gene_result',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A nonempty supplied result is unsupported or ambiguous for its gene.',
      recovery:
        'Call pgx_list_reference with topic phenotypes for this gene and retry pgx_get_recommendations with a returned value.',
    },
    {
      reason: 'query_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An internal bounded scan or attempt budget is exceeded.',
      recovery:
        'Narrow a supported gene, drug, or allele selector in this tool; call pgx_list_reference with topic input_formats for selectors. If the lookup is already specific, report the bounded lookup failure with its request ID.',
    },
    {
      reason: 'upstream_query_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      thrownBy: 'service',
      when: 'CPIC rejects the generated query.',
      recovery:
        'Call pgx_list_reference with topic input_formats to verify selectors; report this failure if the documented call remains rejected.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      thrownBy: 'service',
      retryable: true,
      when: 'CPIC rate limits requests.',
      recovery:
        'Wait for retryAfter when present, then retry the same pgx tool call without concurrent requests.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      thrownBy: 'service',
      retryable: true,
      when: 'The source is unavailable or returns maintenance HTML.',
      recovery:
        'Retry the same pgx tool call later; use the returned guideline URL directly if already available.',
    },
  ],
  async handler(input, ctx) {
    function normalizeMap<T>(
      map: Record<string, T> | undefined,
      name: 'genotype' | 'geneResults',
      normalize: (value: T, index: number) => T,
    ): Record<string, T> | undefined {
      if (map === undefined) return undefined;
      const entries = Object.entries(map);
      if (entries.length < 1 || entries.length > 10)
        throw ctx.fail('invalid_selector', `${name} has ${entries.length} entries; supply 1–10.`);
      const normalized: Record<string, T> = Object.create(null);
      for (const [index, [key, value]] of entries.entries()) {
        const gene = key.trim().toUpperCase();
        if (!gene)
          throw ctx.fail('invalid_selector', `${name} entry ${index + 1} has a blank gene key.`);
        if (Object.hasOwn(normalized, gene))
          throw ctx.fail(
            'invalid_selector',
            `${name} entry ${index + 1} duplicates a gene after normalization.`,
          );
        normalized[gene] = normalize(value, index);
      }
      return normalized;
    }
    const drugName = optionalText(input.drugName),
      drugId = optionalText(input.drugId);
    const geneSymbol = optionalText(input.geneSymbol)?.toUpperCase(),
      phenotype = optionalText(input.phenotype);
    const activityScore = optionalText(
      input.activityScore === undefined ? undefined : String(input.activityScore),
    );
    const population = optionalText(input.population);
    const genotype = normalizeMap(input.genotype, 'genotype', (value, index) => {
      const result = value.trim();
      if (!result)
        throw ctx.fail('invalid_selector', `genotype entry ${index + 1} has a blank diplotype.`);
      return result;
    });
    const geneResults = normalizeMap<ExplicitGeneResult>(
      input.geneResults,
      'geneResults',
      (result, index) => {
        const value = result.value.trim();
        if (!value)
          throw ctx.fail(
            'invalid_selector',
            `geneResults entry ${index + 1} (${result.kind}) has a blank value.`,
          );
        return { ...result, value };
      },
    );
    if (drugName !== undefined && drugId !== undefined)
      throw ctx.fail('invalid_selector', 'drugName and drugId are mutually exclusive.');
    if (phenotype !== undefined && activityScore !== undefined)
      throw ctx.fail('invalid_selector', 'phenotype and activityScore are mutually exclusive.');
    if (
      geneResults !== undefined &&
      (geneSymbol !== undefined || phenotype !== undefined || activityScore !== undefined)
    )
      throw ctx.fail(
        'invalid_selector',
        'geneResults excludes geneSymbol, phenotype and activityScore.',
      );
    if (input.mode === 'drug' && genotype !== undefined)
      throw ctx.fail('invalid_selector', 'Drug mode excludes genotype.');
    if (input.mode === 'drug' && drugName === undefined && drugId === undefined)
      throw ctx.fail('invalid_selector', 'Drug mode requires one drugName or drugId.');
    if (input.mode === 'genotype' && genotype === undefined)
      throw ctx.fail('invalid_selector', 'Genotype mode requires a genotype map.');
    if (
      input.mode === 'genotype' &&
      (geneSymbol !== undefined ||
        phenotype !== undefined ||
        activityScore !== undefined ||
        geneResults !== undefined)
    )
      throw ctx.fail(
        'invalid_selector',
        'Genotype mode excludes geneSymbol, phenotype, activityScore and geneResults.',
      );
    if (input.mode === 'results' && genotype !== undefined)
      throw ctx.fail('invalid_selector', 'Results mode excludes genotype.');
    if (
      input.mode === 'results' &&
      geneResults === undefined &&
      (geneSymbol === undefined || (phenotype === undefined && activityScore === undefined))
    )
      throw ctx.fail(
        'invalid_selector',
        'Results mode requires geneResults or geneSymbol with one phenotype or activityScore.',
      );
    const effectiveQuery: RecommendationQuery = {
      mode: input.mode,
      limit: input.limit,
      offset: input.offset,
      incompleteLimit: input.incompleteLimit,
      incompleteOffset: input.incompleteOffset,
      ...(drugName !== undefined && { drugName }),
      ...(drugId !== undefined && { drugId }),
      ...(geneSymbol !== undefined && { geneSymbol }),
      ...(phenotype !== undefined && { phenotype }),
      ...(activityScore !== undefined && { activityScore }),
      ...(population !== undefined && { population }),
      ...(genotype !== undefined && { genotype }),
      ...(geneResults !== undefined && { geneResults }),
    };
    const { notices, ...result } = await getCpicService().workflow(ctx, (workflow) =>
      getRecommendations(workflow, effectiveQuery),
    );
    ctx.enrich({
      effectiveQuery,
      notices,
      truncated: result.page.nextOffset !== null,
      shown: result.page.returned,
      cap: input.limit,
    });
    return result;
  },
  format: formatLossless,
});
