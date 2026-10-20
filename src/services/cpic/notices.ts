/** @fileoverview Distinguish empty pages from empty source result sets.
 * @module services/cpic/notices
 */
import type { CpicPageInfo } from './cpic-service.js';

/** Explain a verified past-end page, retaining a workflow-specific fallback otherwise. */
export function emptyPageNotice(page: CpicPageInfo, fallback: string): string {
  return page.total !== null && page.total > 0 && page.offset >= page.total
    ? `Offset ${page.offset} is past the last row (total ${page.total}); retry with a smaller offset.`
    : fallback;
}
