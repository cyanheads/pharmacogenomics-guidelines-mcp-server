/** @fileoverview Inspect source gene/result vocabulary and supported input conventions.
 * @module mcp-server/tools/definitions/pgx-list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  emptyPageNotice,
  GeneResultSchema,
  GeneSchema,
  getCpicService,
  listReference,
  provenanceSchema,
  staticProvenance,
  staticProvenanceSchema,
} from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from '../shared/lossless-renderer.js';
import {
  cappedEnrichmentFields,
  optionalText,
  optionalTextSchema,
  pageSchema,
  paginationFields,
} from '../shared/schemas.js';

const topicSchema = z
  .enum(['genes', 'phenotypes', 'cpic_levels', 'pgx_testing', 'classifications', 'input_formats'])
  .describe(
    'genes lists source gene records; phenotypes requires geneSymbol and lists full gene-result rows; other topics return verified static vocabulary.',
  );
const fields = {
  topic: topicSchema,
  geneSymbol: optionalTextSchema(
    100,
    'Exact gene symbol; required for phenotypes, optional for genes, omit for static topics.',
  ),
  ...paginationFields,
};
const referenceSchema = z
  .object({
    value: z.string().describe('Exact source vocabulary label or input format.'),
    meaning: z.string().describe('Meaning or usage guidance.'),
    sourceUrl: z.string().describe('Source vocabulary or interface reference URL.'),
  })
  .describe('Verified static reference entry.');
const levelUrl = 'https://cpicpgx.org/prioritization-of-cpic-guidelines/';
const apiUrl = 'https://api.cpicpgx.org/v1/';
const staticRows = {
  cpic_levels: ['A', 'A/B', 'B', 'B/C', 'C', 'C/D', 'D', 'Retired'].map((value) => ({
    value,
    meaning:
      'Source pair evaluation level; consult the source definitions. A level is not a prescribing recommendation.',
    sourceUrl: levelUrl,
  })),
  pgx_testing: [
    'Actionable PGx',
    'Informative PGx',
    'No Clinical PGx',
    'Testing Recommended',
    'Testing Required',
  ].map((value) => ({
    value,
    meaning:
      'ClinPGx label-annotation testing level, preserved as a source label; not an FDA label supplied by this API.',
    sourceUrl: 'https://www.clinpgx.org/page/drugLabelLegend',
  })),
  classifications: ['Strong', 'Moderate', 'Optional', 'No Recommendation', 'n/a'].map((value) => ({
    value,
    meaning:
      'Source recommendation classification. Preserve this label together with the guideline, population and genetic prerequisites.',
    sourceUrl: 'https://cpicpgx.org/guidelines/',
  })),
  input_formats: [
    {
      value: 'recommendation views',
      meaning:
        'pgx_get_recommendations defaults to view=recommendations. view=test_alerts uses the same selectors to retrieve complete source CDS examples directly, without recommendation or guideline joins. alerts and incompleteAlerts use page and incompletePage independently; items and incompleteMatches remain empty. Ordered alerttext, No CDS and n/a are preserved. Missing genetics never become No Result; explicit source No Result rows remain browsable.',
      sourceUrl: apiUrl,
    },
    {
      value: 'geneSymbol',
      meaning:
        'Trim outer whitespace and uppercase the gene symbol; preserve punctuation such as HLA-B.',
      sourceUrl: apiUrl,
    },
    {
      value: 'drugId / drugName',
      meaning:
        'Use the exact drugId returned by pgx_search_pairs. pgx_get_guideline by=drug accepts exactly one drugId or exact case-insensitive drugName; pgx_search_pairs drugName is a literal substring.',
      sourceUrl: apiUrl,
    },
    {
      value: 'RxNorm / ATC',
      meaning:
        'rxnormId accepts digits or RxNorm: followed by digits. atcId accepts an optional ATC: prefix and 1–7 letters/digits; exact ATC membership only, not hierarchy expansion. Prefixes and ATC letters accept any casing; outer whitespace is ignored and blank means unset.',
      sourceUrl: apiUrl,
    },
    {
      value: 'guideline selectors',
      meaning:
        'pgx_get_guideline by=id requires guidelineId; by=gene requires geneSymbol; by=drug requires exactly one drugName or drugId. Omit other-mode selectors. Default view=summary pages complete guideline records with exact related counts. view=drugs or pairs requires by=id and pages only that collection; follow page.nextOffset. Ambiguous drug names page candidates instead.',
      sourceUrl: apiUrl,
    },
    {
      value: 'allele and guideline paging',
      meaning:
        'limit defaults to 25; positive safe integers above 100 clamp to 100 with a notice. Nonpositive, fractional or unsafe limits fail before fetching. The 24,000-byte complete-result soft budget includes both surfaces and enrichment; rows and nested frequencies remain complete. oversizedRow marks one indivisible exception. Follow page.nextOffset, not offset plus limit.',
      sourceUrl: apiUrl,
    },
    {
      value: 'pair, reference and recommendation paging',
      meaning:
        'Positive safe-integer limits clamp with notices to 100 for pairs and live references, 50 for recommendations, and independently 100 for incompleteLimit. Defaults remain 25, 25, 10 and 25 respectively. Nonpositive, fractional and unsafe limits fail before fetching. Static reference topics always return complete vocabulary at effective limit 100 and offset 0. Follow matched and incomplete continuation offsets independently.',
      sourceUrl: apiUrl,
    },
    {
      value: 'source result notation',
      meaning:
        'Source-supported diplotypes include star alleles, HLA allele-specific positive/negative status and non-star sequence names. Gene lookupmethod determines result kinds: PHENOTYPE permits phenotype; ACTIVITY_SCORE permits phenotype or activityScore; ALLELE_STATUS permits alleleStatus. Inspect genes and phenotypes topics; never infer omitted genes or convert a phenotype to a score.',
      sourceUrl: apiUrl,
    },
    {
      value: 'recommendation selectors',
      meaning:
        'pgx_get_recommendations mode=drug requires one drugName or drugId; result filters are phenotype/activityScore with geneSymbol, or geneResults. mode=genotype requires 1–10 explicit gene/diplotype entries. mode=results requires geneResults or geneSymbol with phenotype/activityScore. Genotype/results optionally accept one drug selector. Follow page.nextOffset and incompletePage.nextOffset independently. Omit fields belonging to other modes.',
      sourceUrl: apiUrl,
    },
    {
      value: 'source lookup workflow',
      meaning:
        'Call pgx_list_reference for genes and gene-specific phenotypes, pgx_search_pairs for evaluated pairs and identifiers, and pgx_get_guideline for coverage. Inspect allele evidence with pgx_search_alleles, translate supported notation with pgx_lookup_diplotype, then use pgx_get_recommendations to browse or match explicit results. Pair evaluation does not establish a prescribing recommendation; missing genes are never assumed normal or negative.',
      sourceUrl: apiUrl,
    },
  ],
};
/** List live reference rows or verified static vocabulary without a fictitious fetch. */
export const pgxListReference = tool('pgx_list_reference', {
  title: 'List pharmacogenomics reference values',
  description:
    'Inspect gene symbols, gene-specific source results, CPIC levels, ClinPGx testing labels, recommendation classifications and input formats. phenotypes requires geneSymbol and preserves distinct activity-score rows, frequencies and consultation text. Live genes/phenotypes support paging; static topics return their complete vocabulary without upstream requests. Use returned values in subsequent discovery, diplotype and recommendation calls.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object(fields),
  output: z.object({
    items: z
      .array(
        z
          .union([GeneSchema, GeneResultSchema, referenceSchema])
          .describe('Gene, gene result, or static reference entry.'),
      )
      .describe('Full live gene/result rows or complete static vocabulary entries.'),
    page: pageSchema,
    provenance: z
      .union([provenanceSchema, staticProvenanceSchema])
      .describe('Live access provenance or static verification provenance.'),
  }),
  enrichment: {
    effectiveQuery: z
      .object(fields)
      .describe('Normalized topic, gene selector and effective paging.'),
    ...cappedEnrichmentFields,
  },
  enrichmentTrailer: {
    effectiveQuery: { render: (v) => renderLossless(v, 'effectiveQuery') },
    notices: { render: (v) => renderLossless(v, 'notices') },
  },
  errors: [
    {
      reason: 'invalid_selector',
      code: JsonRpcErrorCode.ValidationError,
      when: 'phenotypes lacks a gene or a static topic receives a gene selector.',
      recovery:
        'Call pgx_list_reference with topic input_formats, then retry this tool with only the selectors required for the chosen mode.',
    },
    {
      reason: 'query_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The workflow work budget is exceeded.',
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
    const geneSymbol = optionalText(input.geneSymbol)?.toUpperCase();
    const live = input.topic === 'genes' || input.topic === 'phenotypes';
    if ((input.topic === 'phenotypes' && !geneSymbol) || (!live && geneSymbol))
      throw ctx.fail(
        'invalid_selector',
        'phenotypes requires geneSymbol; static topics do not accept a gene selector.',
      );
    if (input.topic === 'genes' || input.topic === 'phenotypes') {
      const query = {
        topic: input.topic,
        ...(geneSymbol ? { geneSymbol } : {}),
        limit: Math.min(input.limit, 100),
        offset: input.offset,
      };
      const result = await getCpicService().workflow(ctx, (workflow) =>
        listReference(workflow, query),
      );
      ctx.enrich({
        effectiveQuery: query,
        notices: [
          ...(input.limit > 100 ? ['Requested limit clamped to the 100-row cap.'] : []),
          ...(result.items.length
            ? []
            : [
                emptyPageNotice(
                  result.page,
                  'No reference rows matched. Call pgx_list_reference with topic genes without a gene filter to inspect available coverage.',
                ),
              ]),
        ],
        truncated: result.page.nextOffset !== null,
        shown: result.items.length,
        cap: query.limit,
      });
      return result;
    }
    const items = staticRows[input.topic];
    const page = {
      limit: 100,
      offset: 0,
      returned: items.length,
      total: items.length,
      nextOffset: null,
    };
    ctx.enrich({
      effectiveQuery: { topic: input.topic, limit: 100, offset: 0 },
      notices: ['Static vocabulary verified 2026-10-19; no upstream request was made.'],
      truncated: false,
      shown: items.length,
      cap: 100,
    });
    return { items, page, provenance: staticProvenance() };
  },
  format: formatLossless,
});
