/**
 * @fileoverview Serializable input primitives and shared paging/enrichment fields.
 * @module mcp-server/tools/shared/schemas
 */

import { z } from '@cyanheads/mcp-ts-core';

/** Normalize optional caller text; never apply to source response strings. */
export function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Optional text accepts blank client form values; handlers normalize with optionalText. */
export function optionalTextSchema(maxLength: number, description: string) {
  return z.string().max(maxLength).optional().describe(description);
}

/** Gene symbols retain punctuation; handlers uppercase the trimmed input. */
export const geneSymbolSchema = z
  .string()
  .min(1)
  .max(100)
  .describe('Gene symbol, such as CYP2C19 or HLA-B; outer whitespace is ignored.');

/** Exact CPIC drug identifier returned by discovery. */
export const drugIdSchema = optionalTextSchema(
  200,
  'Exact drugId returned by pgx_search_pairs; blank means unset.',
);

/** RxNorm identifier with an optional source prefix and outer whitespace. */
export const rxnormIdSchema = z
  .string()
  .regex(/^(?:\s*|\s*(?:[Rr][Xx][Nn][Oo][Rr][Mm]:)?\d+\s*)$/)
  .optional()
  .describe(
    'Decimal RxNorm ID, optionally prefixed RxNorm: in any casing; outer whitespace is ignored and blank means unset.',
  );

/** Exact ATC membership identifier, not a hierarchy query. */
export const atcIdSchema = z
  .string()
  .regex(/^(?:\s*|\s*(?:[Aa][Tt][Cc]:)?[A-Za-z\d]{1,7}\s*)$/)
  .optional()
  .describe(
    'Exact ATC code (1–7 letters/digits) in any casing, optionally prefixed ATC: in any casing; outer whitespace is ignored and blank means unset.',
  );

/** Shared public list inputs; the caller owns the flat root object. */
export const paginationFields = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(25)
    .describe(
      'Positive safe-integer row limit; values above 100 are clamped to 100 with a notice (default 25).',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0)
    .describe('Zero-based offset; use nextOffset to continue (default 0).'),
};

/** Recommendations have a smaller public page budget. */
export const recommendationPaginationFields = {
  ...paginationFields,
  limit: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(10)
    .describe(
      'Positive safe-integer recommendation limit; values above 50 are clamped to 50 with a notice (default 10).',
    ),
};

/** Allele and guideline callers may request any safe positive limit; handlers clamp to 100. */
export const budgetPaginationFields = paginationFields;

/** Public page metadata preserves unknown counts and past-end offsets. */
export const pageSchema = z
  .object({
    limit: z.number().int().min(1).max(100).describe('Effective requested page size.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .describe('Requested zero-based offset.'),
    returned: z.number().int().min(0).describe('Number of rows returned on this page.'),
    total: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe('Exact filtered source count, or null when unavailable.'),
    nextOffset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable()
      .describe('Offset for the next page, or null when no rows remain.'),
  })
  .describe('Source pagination metadata.');

/** Every successful response initializes notices, including an empty array. */
export const sharedEnrichmentFields = {
  notices: z
    .array(z.string().describe('Source or workflow notice.'))
    .describe('Notices about this result; empty when none apply.'),
};

/** Capped list responses initialize all three fields, including empty pages. */
export const cappedEnrichmentFields = {
  ...sharedEnrichmentFields,
  truncated: z.boolean().describe('Whether more matching rows remain after this page.'),
  shown: z.number().int().min(0).describe('Number of returned rows, equal to page.returned.'),
  cap: z.number().int().min(1).max(100).describe('Effective public page limit.'),
};
