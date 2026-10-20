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
import { formatLossless } from '../shared/lossless-renderer.js';
import {
  budgetNotices,
  budgetResponse,
  budgetTrailers,
  slicedPage,
} from '../shared/response-budget.js';
import {
  budgetPaginationFields,
  cappedEnrichmentFields,
  drugIdSchema,
  optionalText,
  optionalTextSchema,
  pageSchema,
  paginationFields,
} from '../shared/schemas.js';

const fields = {
  view: z
    .enum(['summary', 'drugs', 'pairs'])
    .default('summary')
    .describe(
      'Summary pages guideline descriptors; drugs or pairs requires by=id and pages only that related collection.',
    ),
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
    .describe(
      'Positive source guideline ID from pgx_get_guideline by=gene or by=drug results; no valid ID range is inferred.',
    ),
  geneSymbol: optionalTextSchema(100, 'Gene symbol for by=gene; blank means unset.'),
  drugName: optionalTextSchema(
    200,
    'Exact case-insensitive source drug name for by=drug; blank means unset.',
  ),
  drugId: drugIdSchema,
};
/** Page guideline descriptors or one selected complete related collection. */
export const pgxGetGuideline = tool('pgx_get_guideline', {
  title: 'Get guideline coverage',
  description:
    'Retrieve guideline coverage by source ID, exact gene symbol or exact drug name/ID. Default summary pages complete guideline records with exact drugCount/pairCount. view=drugs or pairs requires by=id and pages only that related collection, retaining its guideline descriptor. Ambiguous drug names page candidates for retry with drugId. Follow page.nextOffset; the 24,000-byte soft budget cuts only between complete rows, with oversizedRow for an indivisible exception. Missing coverage is found=false. Consult linked guidelines before clinical use.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({ ...fields, ...budgetPaginationFields }),
  output: z.object({
    view: z.enum(['summary', 'drugs', 'pairs']).describe('Selected guideline view.'),
    oversizedRow: z
      .boolean()
      .describe('Whether one complete indivisible row exceeds the soft byte budget.'),
    page: pageSchema,
    found: z.boolean().describe('Whether guideline coverage was found.'),
    guidelines: z
      .array(
        z
          .object({
            record: GuidelineSchema.describe('Complete source guideline.'),
            drugCount: z.number().int().min(0).describe('Exact number of related source drugs.'),
            pairCount: z
              .number()
              .int()
              .min(0)
              .describe('Exact number of pairs linked by guideline URL.'),
          })
          .describe('Complete guideline record with exact related-record counts.'),
      )
      .describe(
        'Paged complete guideline descriptors, or the retained descriptor for a related view.',
      ),
    drugs: z.array(DrugSchema).optional().describe('Selected drugs page; omitted in other views.'),
    pairs: z.array(PairSchema).optional().describe('Selected pairs page; omitted in other views.'),
    candidates: z
      .array(DrugSchema)
      .describe(
        'Paged exact drug-name candidates when resolution is ambiguous; page and shown then refer to candidates.',
      ),
    guidance: z.string().describe('Next lookup step when missing or ambiguous; empty when found.'),
    clinicalCaveat: z
      .literal(clinicalCaveat)
      .describe('Clinical qualification for source guidance.'),
    provenance: provenanceSchema,
  }),
  enrichment: {
    effectiveQuery: z
      .object({ ...fields, ...paginationFields })
      .describe('Normalized guideline selectors and effective page bounds.'),
    ...cappedEnrichmentFields,
  },
  enrichmentTrailer: budgetTrailers,
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
  handler(input, ctx) {
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
    if (input.view !== 'summary' && selector.by !== 'id')
      throw ctx.fail(
        'invalid_selector',
        'Related drugs or pairs views require by=id and guidelineId.',
      );
    const limit = Math.min(input.limit, 100);
    const effectiveQuery = { ...selector, view: input.view, limit, offset: input.offset };
    return getCpicService().workflow(ctx, async (workflow) => {
      const result = await getGuideline(workflow, selector, {
        view: input.view,
        limit,
        offset: input.offset,
      });
      const returned = result.page.returned;
      const selected = budgetResponse(returned, (count, oversizedRow, trimmed) => {
        const domain = {
          found: result.found,
          view: input.view,
          oversizedRow,
          guidelines:
            input.view === 'summary' ? result.guidelines.slice(0, count) : result.guidelines,
          ...(input.view === 'drugs' && { drugs: result.drugs?.slice(0, count) ?? [] }),
          ...(input.view === 'pairs' && { pairs: result.pairs?.slice(0, count) ?? [] }),
          candidates: result.candidates.slice(0, count),
          guidance: result.guidance,
          clinicalCaveat: clinicalCaveat as typeof clinicalCaveat,
          page: slicedPage(result.page, count),
          provenance: result.provenance,
        };
        domain.provenance = workflow.provenance(domain);
        return {
          domain,
          enrichment: {
            effectiveQuery,
            notices: [
              ...(result.found ? [] : [result.guidance]),
              ...(input.limit > 100 ? ['Requested limit clamped to the 100-row cap.'] : []),
              ...budgetNotices(oversizedRow, trimmed),
            ],
            truncated: domain.page.nextOffset !== null,
            shown: count,
            cap: limit,
          },
        };
      });
      ctx.enrich(selected.enrichment);
      return selected.domain;
    });
  },
  format: formatLossless,
});
