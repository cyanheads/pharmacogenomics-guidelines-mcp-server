/** @fileoverview Whole-result budgeting for complete allele and guideline rows.
 * @module mcp-server/tools/shared/response-budget
 */

import type { CpicPageInfo } from '@/services/cpic/index.js';
import { formatLossless, renderLossless } from './lossless-renderer.js';

/** The same renderers feed measurement and the framework enrichment trailer. */
export const budgetTrailers = {
  effectiveQuery: { render: (value: unknown) => renderLossless(value, '$.effectiveQuery') },
  notices: { render: (value: unknown) => renderLossless(value, '$.notices') },
};

/** Mirror the framework's success envelope for these two lossless list definitions. */
export function completeResult(domain: object, enrichment: Record<string, unknown>) {
  const trailer = Object.entries(enrichment)
    .map(([key, value]) => {
      if (key === 'effectiveQuery' || key === 'notices') return budgetTrailers[key].render(value);
      return `**${key}:** ${String(value)}`;
    })
    .join('\n');
  return {
    structuredContent: { ...domain, ...enrichment },
    content: [...formatLossless(domain), { type: 'text' as const, text: `\n\n${trailer}` }],
  };
}

/** Retain source continuation even when the source has no exact total. */
export function slicedPage(page: CpicPageInfo, returned: number): CpicPageInfo {
  return {
    ...page,
    returned,
    nextOffset: returned < page.returned ? page.offset + returned : page.nextOffset,
  };
}

/** Find a fitting prefix, or retain the complete first indivisible oversized row. */
export function budgetResponse<T extends { domain: object; enrichment: Record<string, unknown> }>(
  count: number,
  candidate: (count: number, oversizedRow: boolean, trimmed: boolean) => T,
): T {
  const fits = (value: T) =>
    new TextEncoder().encode(JSON.stringify(completeResult(value.domain, value.enrichment)))
      .byteLength <= 24_000;
  const full = candidate(count, false, false);
  if (fits(full)) return full;
  if (count === 0) return candidate(0, true, false);
  const first = candidate(1, false, count > 1);
  if (!fits(first)) return candidate(1, true, count > 1);
  let best = first,
    low = 2,
    high = count - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = candidate(middle, false, true);
    if (fits(value)) {
      best = value;
      low = middle + 1;
    } else high = middle - 1;
  }
  return best;
}

/** Budget notices are part of each measured candidate, never appended afterward. */
export function budgetNotices(oversizedRow: boolean, trimmed: boolean): string[] {
  return [
    ...(trimmed
      ? [
          'Page shortened to fit the 24,000-byte complete-result soft budget; continue with page.nextOffset.',
        ]
      : []),
    ...(oversizedRow
      ? [
          'One complete indivisible row or retained descriptor exceeds the 24,000-byte soft budget; no source fields were clipped.',
        ]
      : []),
  ];
}
