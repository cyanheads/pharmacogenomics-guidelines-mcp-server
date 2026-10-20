/** @fileoverview Discover evaluated gene–drug pairs with complete source drug metadata.
 * @module mcp-server/tools/definitions/pgx-search-pairs.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DrugSchema,
  getCpicService,
  PairSchema,
  provenanceSchema,
  searchPairs,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
import {
  atcIdSchema,
  cappedEnrichmentFields,
  drugIdSchema,
  optionalText,
  optionalTextSchema,
  pageSchema,
  paginationFields,
  rxnormIdSchema,
} from '../shared/schemas.js';

const queryFields = {
  geneSymbol: optionalTextSchema(
    100,
    'Exact gene symbol, case-insensitive input; blank means unset.',
  ),
  drugName: optionalTextSchema(
    200,
    'Literal case-insensitive drug-name substring; blank means unset.',
  ),
  drugId: drugIdSchema,
  rxnormId: rxnormIdSchema,
  atcId: atcIdSchema,
  cpicLevel: z
    .enum(['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D', 'Retired'])
    .optional()
    .describe('Exact source CPIC evaluation level, not a prescribing recommendation.'),
  provisional: z.boolean().optional().describe('Filter by source provisional flag.'),
  pgxTesting: z
    .enum([
      'Actionable PGx',
      'Informative PGx',
      'No Clinical PGx',
      'Testing Recommended',
      'Testing Required',
    ])
    .optional()
    .describe('ClinPGx label-annotation testing level; not an FDA label.'),
  usedForRecommendation: z
    .enum(['Yes', 'No'])
    .optional()
    .describe('Whether the source marks the pair as used for a recommendation.'),
  includeRetired: z
    .boolean()
    .default(false)
    .describe('Include Retired pairs; also included when cpicLevel is Retired.'),
  ...paginationFields,
};
/** Search evaluated pairs; every filter combines with AND. */
export const pgxSearchPairs = tool('pgx_search_pairs', {
  title: 'Search evaluated gene–drug pairs',
  description:
    'Search evaluated gene–drug pairs by gene, literal drug-name substring, exact drug/RxNorm/ATC identifiers, evaluation level or testing label. Filters combine with AND; identifiers never fall back to name-only search. Results include source drug identifiers and guideline links for pgx_get_guideline. A pair evaluation is not a prescribing recommendation. Follow nextOffset to continue.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object(queryFields),
  output: z.object({
    items: z
      .array(
        PairSchema.extend({
          drug: DrugSchema.nullable().describe(
            'Complete related source drug, or null when the pair has no drug identifier.',
          ),
        }).describe('Evaluated pair with its related source drug.'),
      )
      .describe('Complete evaluated pairs and related drugs.'),
    page: pageSchema,
    provenance: provenanceSchema,
  }),
  enrichment: {
    effectiveQuery: z.object(queryFields).describe('Normalized filters and effective paging.'),
    ...cappedEnrichmentFields,
  },
  enrichmentTrailer: {
    effectiveQuery: { render: (v) => renderLossless(v, 'effectiveQuery') },
    notices: { render: (v) => renderLossless(v, 'notices') },
  },
  errors: [
    {
      reason: 'query_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A bounded source scan or workflow work budget is exceeded.',
      recovery:
        'Narrow a supported gene, drug, or allele selector in this tool; call pgx_list_reference with topic input_formats for selectors. If the lookup is already specific, report the bounded lookup failure with its request ID.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_query_rejected',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'CPIC rejects the generated query.',
      recovery:
        'Call pgx_list_reference with topic input_formats to verify selectors; report this failure if the documented call remains rejected.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'CPIC returns HTTP 429.',
      recovery:
        'Wait for retryAfter when present, then retry the same pgx tool call without concurrent requests.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'CPIC is unavailable or returns a maintenance page.',
      recovery:
        'Retry the same pgx tool call later; use the returned guideline URL directly if already available.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const query = { ...input };
    for (const key of ['geneSymbol', 'drugName', 'drugId', 'rxnormId', 'atcId'] as const) {
      const value = optionalText(input[key]);
      if (value === undefined) delete query[key];
      else query[key] = value;
    }
    if (query.geneSymbol) query.geneSymbol = query.geneSymbol.toUpperCase();
    if (query.rxnormId) query.rxnormId = query.rxnormId.replace(/^RxNorm:/i, '');
    if (query.atcId) query.atcId = query.atcId.replace(/^ATC:/i, '').toUpperCase();
    const result = await getCpicService().workflow(ctx, (workflow) => searchPairs(workflow, query));
    const notices: string[] = [];
    if (result.items.length === 0)
      notices.push(
        'No gene–drug pairs matched. Call pgx_list_reference with topic genes or broaden pgx_search_pairs filters.',
      );
    if (!query.includeRetired && query.cpicLevel !== 'Retired')
      notices.push('Retired pairs are excluded; set includeRetired=true to include them.');
    ctx.enrich({
      effectiveQuery: query,
      notices,
      truncated: result.page.nextOffset !== null,
      shown: result.items.length,
      cap: query.limit,
    });
    return result;
  },
  format: formatLossless,
});
