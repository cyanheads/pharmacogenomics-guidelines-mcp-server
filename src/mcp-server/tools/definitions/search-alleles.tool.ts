/**
 * @fileoverview Retrieve complete allele function and population-frequency evidence.
 * @module mcp-server/tools/definitions/search-alleles
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  AlleleSchema,
  getCpicService,
  PopulationFrequencySchema,
  provenanceSchema,
  searchAlleles,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
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
    name: z.string().optional().describe('Trimmed exact allele name when supplied.'),
    clinicalFunctionalStatus: z
      .string()
      .optional()
      .describe('Trimmed exact source clinical functional status.'),
    ...paginationFields,
  })
  .describe('Effective allele selectors and page bounds.');
/** Search source alleles and batch-enrich complete frequency rows. */
export const searchAllelesTool = tool('pgx_search_alleles', {
  title: 'Search alleles',
  description:
    'Inspect CPIC allele function, evidence, definition metadata and population frequencies for geneSymbol. Optional name and clinicalFunctionalStatus are exact source filters; discover gene coverage with pgx_list_reference topic genes. Definitions are metadata, not defining-variant interpretation. Frequencies remain source fractions; inferred frequencies are not observed measurements and population frequencies do not establish individual risk. Continue with page.nextOffset.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geneSymbol: geneSymbolSchema,
    name: optionalTextSchema(500, 'Exact source allele name; blank means unset.'),
    clinicalFunctionalStatus: optionalTextSchema(
      100,
      'Exact source clinical functional status; blank means unset.',
    ),
    ...paginationFields,
  }),
  output: z.object({
    items: z
      .array(
        AlleleSchema.extend({
          populationFrequencies: z
            .array(PopulationFrequencySchema)
            .describe('Complete matching population-frequency rows; empty when unavailable.'),
        }).describe('Source allele with population-frequency evidence.'),
      )
      .describe('Source alleles, embedded definitions and population frequencies.'),
    page: pageSchema,
    provenance: provenanceSchema,
  }),
  enrichment: { effectiveQuery: effectiveQuerySchema, ...cappedEnrichmentFields },
  enrichmentTrailer: {
    effectiveQuery: { render: (value) => renderLossless(value, '$.effectiveQuery') },
    notices: { render: (value) => renderLossless(value, '$.notices') },
  },
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
  async handler(input, ctx) {
    const geneSymbol = input.geneSymbol.trim().toUpperCase();
    if (!geneSymbol) throw ctx.fail('invalid_selector');
    const name = optionalText(input.name);
    const clinicalFunctionalStatus = optionalText(input.clinicalFunctionalStatus);
    const effectiveQuery = {
      geneSymbol,
      ...(name !== undefined && { name }),
      ...(clinicalFunctionalStatus !== undefined && { clinicalFunctionalStatus }),
      limit: input.limit,
      offset: input.offset,
    };
    const result = await getCpicService().workflow(ctx, (workflow) =>
      searchAlleles(workflow, effectiveQuery),
    );
    const notices = result.items.length
      ? []
      : [
          'No alleles matched. Call pgx_list_reference with topic genes to check gene coverage, or remove the clinicalFunctionalStatus filter in pgx_search_alleles.',
        ];
    ctx.enrich({
      effectiveQuery,
      notices,
      truncated: result.page.nextOffset !== null,
      shown: result.items.length,
      cap: input.limit,
    });
    return result;
  },
  format: formatLossless,
});
