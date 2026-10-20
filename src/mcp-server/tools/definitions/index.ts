/** @fileoverview Registered pharmacogenomics source tool definitions.
 * @module mcp-server/tools/definitions
 */
import { getRecommendationsTool } from './get-recommendations.tool.js';
import { lookupDiplotypeTool } from './lookup-diplotype.tool.js';
import { pgxGetGuideline } from './pgx-get-guideline.tool.js';
import { pgxListReference } from './pgx-list-reference.tool.js';
import { pgxSearchPairs } from './pgx-search-pairs.tool.js';
import { searchAllelesTool } from './search-alleles.tool.js';

export {
  getRecommendationsTool,
  lookupDiplotypeTool,
  pgxGetGuideline,
  pgxListReference,
  pgxSearchPairs,
  searchAllelesTool,
};
/** Complete callable tool surface. */
export const allToolDefinitions = [
  pgxSearchPairs,
  pgxGetGuideline,
  lookupDiplotypeTool,
  getRecommendationsTool,
  searchAllelesTool,
  pgxListReference,
];
