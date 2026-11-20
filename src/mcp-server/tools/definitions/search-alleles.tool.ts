/**
 * @fileoverview Retrieve complete allele function and population-frequency evidence.
 * @module mcp-server/tools/definitions/search-alleles
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AlleleSchema,
  emptyPageNotice,
  getCpicService,
  PopulationFrequencySchema,
  provenanceSchema,
  searchAlleles,
} from '@/services/cpic/index.js';
import { formatLossless, losslessEnrichmentTrailers } from '../shared/lossless-renderer.js';
import {
  cappedEnrichmentFields,
  geneSymbolSchema,
  optionalText,
  optionalTextSchema,
  pageSchema,
  paginationFields,
} from '../shared/schemas.js';

const effectiveQuerySchema = z
  .object({
    geneSymbol: z.string().describe('Normalized exact gene symbol.'),
    name: z
      .string()
      .optional()
      .describe('Effective literal allele name after any supported gene-prefix fallback.'),
    clinicalFunctionalStatus: z
      .string()
      .optional()
      .describe('Trimmed case-insensitive literal clinical functional status.'),
    includePopulationFrequencies: z
      .boolean()
      .describe('Whether complete population-frequency evidence was requested.'),
    ...paginationFields,
  })
  .describe('Effective allele selectors and page bounds.');
/** Search source alleles and batch-enrich complete frequency rows. */
export const searchAllelesTool = tool('pgx_search_alleles', {
  title: 'Search alleles',
  description:
    'Inspect CPIC allele function, evidence and definition metadata for geneSymbol. Set includePopulationFrequencies=true to join complete source frequencies. Name matches literally first, then a matching gene prefix before a star allele may be removed; clinicalFunctionalStatus matches literal text case-insensitively. Discover genes with pgx_list_reference. Definitions are metadata, not variant interpretation. Frequencies are source fractions; inferred frequencies are not observations and do not establish individual risk. Continue with page.nextOffset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geneSymbol: geneSymbolSchema,
    name: optionalTextSchema(500, 'Exact source allele name; blank means unset.'),
    clinicalFunctionalStatus: optionalTextSchema(
      100,
      'Case-insensitive literal source clinical functional status; blank means unset.',
    ),
    includePopulationFrequencies: z
      .boolean()
      .default(false)
      .describe('Join complete population-frequency evidence for the returned alleles.'),
    ...paginationFields,
  }),
  output: z.object({
    items: z
      .array(
        AlleleSchema.extend({
          populationFrequencies: z
            .array(PopulationFrequencySchema)
            .optional()
            .describe(
              'Complete matching population-frequency rows when requested; empty when unavailable.',
            ),
        }).describe('Source allele with optional population-frequency evidence.'),
      )
      .describe(
        'Complete source allele rows, embedded definitions and requested population frequencies.',
      ),
    page: pageSchema,
    provenance: provenanceSchema,
  }),
  enrichment: { effectiveQuery: effectiveQuerySchema, ...cappedEnrichmentFields },
  enrichmentTrailer: losslessEnrichmentTrailers,
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A required selector is blank after normalization.',
      recovery:
        'Call pgx_list_reference with topic input_formats, then retry this tool with only the selectors required for the chosen mode.',
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
  handler(input, ctx) {
    const geneSymbol = input.geneSymbol.trim().toUpperCase();
    if (!geneSymbol) throw ctx.fail('invalid_selector');
    const name = optionalText(input.name);
    const clinicalFunctionalStatus = optionalText(input.clinicalFunctionalStatus);
    const effectiveQuery = {
      geneSymbol,
      ...(name !== undefined && { name }),
      ...(clinicalFunctionalStatus !== undefined && { clinicalFunctionalStatus }),
      includePopulationFrequencies: input.includePopulationFrequencies,
      limit: Math.min(input.limit, 100),
      offset: input.offset,
    };
    return getCpicService().workflow(ctx, async (workflow) => {
      const { effectiveName, ...result } = await searchAlleles(workflow, effectiveQuery);
      if (effectiveName !== undefined) effectiveQuery.name = effectiveName;
      const suppliedFilters = [
        name !== undefined ? 'name' : '',
        clinicalFunctionalStatus !== undefined ? 'clinicalFunctionalStatus' : '',
      ].filter(Boolean);
      const notices = result.items.length
        ? []
        : [
            emptyPageNotice(
              result.page,
              `No alleles matched. Call pgx_list_reference with topic genes to check gene coverage${suppliedFilters.length ? `, or remove the supplied ${suppliedFilters.join(' and ')} filter${suppliedFilters.length > 1 ? 's' : ''} in pgx_search_alleles` : ''}.`,
            ),
          ];
      ctx.enrich({
        effectiveQuery,
        notices: [
          ...notices,
          ...(input.limit > 100 ? ['Requested limit clamped to the 100-row cap.'] : []),
        ],
        truncated: result.page.nextOffset !== null,
        shown: result.page.returned,
        cap: effectiveQuery.limit,
      });
      return result;
    });
  },
  format: formatLossless,
});
