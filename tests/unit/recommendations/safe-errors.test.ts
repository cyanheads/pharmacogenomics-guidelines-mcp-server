/** @fileoverview Actionable recommendation errors without submitted genetic text.
 * @module tests/unit/recommendations/safe-errors.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { ErrorHandler, logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { sanitizeLogBindings } from '../../../node_modules/@cyanheads/mcp-ts-core/dist/utils/internal/logger.js';
import { failure, recommendation, reference, upstream } from './fixtures.js';

beforeEach(() => initCpicService());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('names mutually exclusive selectors before network work', async () => {
  const { fetch } = upstream({});
  const result = await failure(
    { mode: 'drug', drugId: 'D1', drugName: 'example' },
    'invalid_selector',
  );
  expect(JSON.stringify(result.content)).toContain('drugName and drugId are mutually exclusive');
  expect(fetch).not.toHaveBeenCalled();
});

it('locates unsupported middle map values without echoing caller keys or values', async () => {
  upstream({
    recommendations: [recommendation()],
    genes: [
      { symbol: 'CYP2C19', lookupmethod: 'PHENOTYPE' },
      { symbol: 'PRIVATE_GENE_KEY', lookupmethod: 'PHENOTYPE' },
    ],
    references: [reference('CYP2C19', 'Normal')],
  });
  const result = await failure(
    {
      mode: 'drug',
      drugId: 'D1',
      geneResults: {
        CYP2C19: { kind: 'phenotype', value: 'Normal' },
        PRIVATE_GENE_KEY: { kind: 'phenotype', value: 'PRIVATE_GENETIC_VALUE' },
      },
    },
    'unsupported_gene_result',
  );
  expect(JSON.stringify(result.content)).toContain('geneResults entry 2 (phenotype)');
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_GENE_KEY|PRIVATE_GENETIC_VALUE/);
});

it.each(['unsupported value', 'incompatible kind'] as const)(
  'keeps submitted genetics out of the actual framework error log, stack and causes for %s',
  async (scenario) => {
    upstream({
      recommendations: [recommendation()],
      genes: [
        {
          symbol: 'PRIVATE_GENE_KEY',
          lookupmethod: scenario === 'incompatible kind' ? 'ALLELE_STATUS' : 'PHENOTYPE',
        },
      ],
      references:
        scenario === 'incompatible kind'
          ? [reference('PRIVATE_GENE_KEY', 'PRIVATE_GENETIC_VALUE')]
          : [],
    });
    const logs: unknown[] = [];
    vi.spyOn(logger, 'error').mockImplementation((message, context) => {
      logs.push(
        sanitizeLogBindings({ message, ...(context && 'extra' in context ? context.extra : {}) }),
      );
    });
    const input = getRecommendationsTool.input.parse({
      mode: 'results',
      geneResults: { PRIVATE_GENE_KEY: { kind: 'phenotype', value: 'PRIVATE_GENETIC_VALUE' } },
    });
    let thrown: unknown;
    try {
      await getRecommendationsTool.handler(
        input,
        createMockContext({ errors: getRecommendationsTool.errors }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    ErrorHandler.handleError(thrown, { operation: 'safe-genetic-result' });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs)).toContain('geneResults entry 1 (phenotype)');
    expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_GENE_KEY|PRIVATE_GENETIC_VALUE/);
  },
);
