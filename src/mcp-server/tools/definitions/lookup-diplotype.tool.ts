/**
 * @fileoverview Translate a source-supported diplotype without clinical inference.
 * @module mcp-server/tools/definitions/lookup-diplotype
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DiplotypeSchema,
  getCpicService,
  provenanceSchema,
  resolveDiplotype,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
import { geneSymbolSchema, sharedEnrichmentFields } from '../shared/schemas.js';

const effectiveQuerySchema = z
  .object({
    geneSymbol: z.string().describe('Normalized exact gene symbol.'),
    diplotype: z.string().describe('Trimmed supplied notation; source responses are unchanged.'),
  })
  .describe('Effective diplotype query.');
/** Resolve source diplotype rows, retaining allele-specific statuses and ambiguity. */
export const lookupDiplotypeTool = tool('pgx_lookup_diplotype', {
  title: 'Look up diplotype',
  description:
    'Translate a CPIC-supported diplotype or allele-status result for one gene. Supply geneSymbol and exact diplotype notation, including star alleles, named HLA positive/negative statuses, or non-star sequences; use pgx_search_alleles and pgx_list_reference with topic phenotypes to inspect supported values. Exact lookup precedes bounded reverse-order or status aliases. Multiple source rows remain ambiguous; no activity score or missing gene result is inferred.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    geneSymbol: geneSymbolSchema,
    diplotype: z
      .string()
      .min(1)
      .max(500)
      .describe(
        'Exact source diplotype or allele-specific status, such as *1/*2 or *15:02 positive.',
      ),
  }),
  output: z.object({
    found: z.boolean().describe('Whether at least one source row matched.'),
    geneSymbol: z.string().describe('Normalized supplied gene symbol.'),
    inputDiplotype: z.string().describe('Trimmed caller notation.'),
    matchedDiplotype: z.string().nullable().describe('Notation matched in the source, or null.'),
    records: z
      .array(DiplotypeSchema)
      .describe('Every matching source row; multiple rows are ambiguous.'),
    guidance: z.string().describe('Recovery guidance for missing or ambiguous source rows.'),
    provenance: provenanceSchema,
  }),
  enrichment: { effectiveQuery: effectiveQuerySchema, ...sharedEnrichmentFields },
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
    const effectiveQuery = {
      geneSymbol: input.geneSymbol.trim().toUpperCase(),
      diplotype: input.diplotype.trim(),
    };
    if (!effectiveQuery.geneSymbol || !effectiveQuery.diplotype) throw ctx.fail('invalid_selector');
    const result = await getCpicService().workflow(ctx, (workflow) =>
      resolveDiplotype(workflow, effectiveQuery.geneSymbol, effectiveQuery.diplotype),
    );
    const notices = result.guidance ? [result.guidance] : [];
    ctx.enrich({ effectiveQuery, notices });
    return result;
  },
  format: formatLossless,
});
