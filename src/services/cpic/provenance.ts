/** @fileoverview Shared clinical qualification and source provenance schemas.
 * @module services/cpic/provenance
 */
import { z } from '@cyanheads/mcp-ts-core';
/** Required qualification accompanying every guideline and prescribing response. */
export const clinicalCaveat =
  'CPIC database/API tables may omit guideline nuances and may lag guideline updates. Consult the linked guideline and its updates before clinical use. Recommendations are limited to their stated genes, drugs, populations, and indications; treatment decisions remain with the clinician and patient.';
const attribution = {
  source: z.literal('CPIC Database').describe('Source database.'),
  primarySourceUrl: z.literal('https://www.clinpgx.org/').describe('Primary clinical source.'),
  apiVersion: z.literal('v1').describe('API interface version, not a database release.'),
  requestUrls: z.array(z.string()).describe('Exact requests made during this workflow.'),
  licenseUrl: z.string().describe('Source licence URL.'),
  policyUrl: z.string().describe('ClinPGx usage policy URL.'),
  rowVersions: z
    .array(
      z
        .object({
          path: z.string().describe('Source row location.'),
          requestUrl: z.string().describe('Request producing this row.'),
          version: z.number().describe('Source row version.'),
        })
        .describe('Version of one retrieved source record.'),
    )
    .describe('Available source record versions.'),
};
/** Complete caller-facing live source attribution. */
export const provenanceSchema = z
  .object({
    ...attribution,
    accessedAt: z.string().describe('UTC access timestamp for live requests.'),
  })
  .describe('Live source attribution and retrieval details.');
/** Static vocabulary provenance uses verification date, never a fictitious fetch timestamp. */
export const staticProvenanceSchema = z
  .object({
    ...attribution,
    verificationDate: z.string().describe('Date static vocabulary was verified.'),
  })
  .describe('Static vocabulary source attribution.');
/** Static vocabulary attribution without an upstream request. */
export function staticProvenance() {
  return {
    source: 'CPIC Database' as const,
    primarySourceUrl: 'https://www.clinpgx.org/' as const,
    apiVersion: 'v1' as const,
    requestUrls: [],
    licenseUrl: 'https://github.com/cpicpgx/cpic-data/blob/master/LICENSE.md',
    policyUrl: 'https://www.clinpgx.org/page/dataUsagePolicy',
    rowVersions: [],
    verificationDate: '2026-10-19',
  };
}
