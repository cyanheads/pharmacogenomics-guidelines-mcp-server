/** @fileoverview Retrieve complete CPIC guideline coverage by ID, gene or exact drug.
 * @module mcp-server/tools/definitions/pgx-get-guideline.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  clinicalCaveat,
  DrugSchema,
  GuidelineSchema,
  type GuidelineSelector,
  getCpicService,
  getGuideline,
  PairSchema,
  provenanceSchema,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
import {
  drugIdSchema,
  optionalText,
  optionalTextSchema,
  sharedEnrichmentFields,
} from '../shared/schemas.js';

const fields = {
  by: z
    .enum(['id', 'gene', 'drug'])
    .describe(
      'id requires guidelineId; gene requires geneSymbol; drug requires exactly one exact drugName or drugId. Other selectors must be omitted.',
    ),
  guidelineId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Positive source guideline ID; no valid ID range is inferred.'),
  geneSymbol: optionalTextSchema(100, 'Gene symbol for by=gene; blank means unset.'),
  drugName: optionalTextSchema(
    200,
    'Exact case-insensitive source drug name for by=drug; blank means unset.',
  ),
  drugId: drugIdSchema,
};
/** Return every matching guideline and full related source drug and pair records. */
export const pgxGetGuideline = tool('pgx_get_guideline', {
  title: 'Get guideline coverage',
  description:
    'Retrieve guideline coverage by source ID, exact gene symbol or exact drug name/ID. Gene queries return every matching guideline. Drug names resolving to several IDs return candidates for an explicit retry with drugId. Missing coverage is a successful found=false response. Related drugs and pairs are complete bounded lists; consult the linked guideline before clinical use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object(fields),
  output: z.object({
    found: z.boolean().describe('Whether guideline coverage was found.'),
    guidelines: z
      .array(
        z
          .object({
            record: GuidelineSchema.describe('Complete source guideline.'),
            drugs: z.array(DrugSchema).describe('All source drugs assigned to this guideline.'),
            pairs: z.array(PairSchema).describe('All pairs linked by exact guideline URL.'),
          })
          .describe('Guideline and its complete related records.'),
      )
      .describe('Every matching guideline with related records.'),
    candidates: z
      .array(DrugSchema)
      .describe('Exact drug-name candidates when resolution is ambiguous.'),
    guidance: z.string().describe('Next lookup step when missing or ambiguous; empty when found.'),
    clinicalCaveat: z
      .literal(clinicalCaveat)
      .describe('Clinical qualification for source guidance.'),
    provenance: provenanceSchema,
  }),
  enrichment: {
    effectiveQuery: z.object(fields).describe('Normalized guideline selectors.'),
    ...sharedEnrichmentFields,
  },
  enrichmentTrailer: {
    effectiveQuery: { render: (v) => renderLossless(v, 'effectiveQuery') },
    notices: { render: (v) => renderLossless(v, 'notices') },
  },
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Selectors are missing, conflicting or mixed across modes.',
      recovery:
        'Call pgx_list_reference with topic input_formats, then retry this tool with only the selectors required for the chosen mode.',
    },
    {
      reason: 'query_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A bounded source scan or workflow work budget is exceeded.',
      recovery:
        'Narrow a supported gene, drug, or allele selector in this tool; call pgx_list_reference with topic input_formats for selectors. If the failing lookup already identifies one gene and allele, inspect the source request URL in the error and report the bounded lookup failure.',
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
    const geneSymbol = optionalText(input.geneSymbol)?.toUpperCase(),
      drugName = optionalText(input.drugName),
      drugId = optionalText(input.drugId);
    let selector: GuidelineSelector;
    if (input.by === 'id' && input.guidelineId !== undefined && !geneSymbol && !drugName && !drugId)
      selector = { by: 'id', guidelineId: input.guidelineId };
    else if (
      input.by === 'gene' &&
      geneSymbol &&
      input.guidelineId === undefined &&
      !drugName &&
      !drugId
    )
      selector = { by: 'gene', geneSymbol };
    else if (
      input.by === 'drug' &&
      input.guidelineId === undefined &&
      !geneSymbol &&
      drugId &&
      !drugName
    )
      selector = { by: 'drug', drugId };
    else if (
      input.by === 'drug' &&
      input.guidelineId === undefined &&
      !geneSymbol &&
      drugName &&
      !drugId
    )
      selector = { by: 'drug', drugName };
    else
      throw ctx.fail(
        'invalid_selector',
        'Supply only the selectors required for the chosen by mode.',
      );
    const result = await getCpicService().workflow(ctx, (workflow) =>
      getGuideline(workflow, selector),
    );
    ctx.enrich({ effectiveQuery: selector, notices: result.found ? [] : [result.guidance] });
    return { ...result, clinicalCaveat } as const;
  },
  format: formatLossless,
});
