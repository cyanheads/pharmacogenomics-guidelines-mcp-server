/**
 * @fileoverview Large-panel opt-out, boundary errors and count-only telemetry.
 * @module tests/unit/recommendations/panel-policy.test
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';

const { add } = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const utils = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...utils,
    createCounter: (name: string, description: string, unit?: string) =>
      name === 'pgx.large_gene_panels' ? { add } : utils.createCounter(name, description, unit),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  add.mockClear();
});

it.each(['genotype', 'geneResults'] as const)(
  'enforces the configured %s cap before fetching and records only accepted map dimensions',
  async (name) => {
    for (const enabled of [false, true]) {
      vi.stubEnv('PGX_LARGE_GENE_PANELS', String(enabled));
      vi.resetModules();
      const { getRecommendationsTool: tool } = await import(
        '@/mcp-server/tools/definitions/get-recommendations.tool.js'
      );
      const { initCpicService } = await import('@/services/cpic/cpic-service.js');
      initCpicService();
      const fetch = vi.fn(async () => Response.json([]));
      vi.stubGlobal('fetch', fetch);
      const ctx = createMockContext({ errors: tool.errors });
      const info = vi.spyOn(ctx.log, 'info');
      for (const view of ['recommendations', 'test_alerts']) {
        for (const count of [10, 11, 26]) {
          add.mockClear();
          info.mockClear();
          fetch.mockClear();
          const value =
            name === 'genotype'
              ? 'PRIVATE_DIPLOTYPE'
              : { kind: 'phenotype', value: 'PRIVATE_RESULT' };
          const map = Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`GENE${i}`, value]),
          );
          const input = tool.input.parse({
            view,
            mode: name === 'genotype' ? name : 'results',
            [name]: map,
          });
          const result = tool.handler(input, ctx);
          if (count > (enabled ? 25 : 10)) {
            await expect(result).rejects.toMatchObject({
              message: `${name} has ${count} entries; supply 1–${enabled ? 25 : 10}.`,
              data: { reason: 'invalid_selector' },
            });
            expect(fetch).not.toHaveBeenCalled();
          } else {
            if (name === 'genotype')
              await expect(result).resolves.toMatchObject({ status: 'unresolved' });
            else
              await expect(result).rejects.toMatchObject({
                data: { reason: 'unsupported_gene_result' },
              });
            expect(fetch).toHaveBeenCalled();
          }
          if (count === 11 && enabled) {
            expect(add.mock.calls).toEqual([[1, { mapName: name, entryCount: 11 }]]);
            expect(info.mock.calls).toEqual([
              ['Accepted large gene panel', { mapName: name, entryCount: 11 }],
            ]);
          } else {
            expect(add).not.toHaveBeenCalled();
            expect(info).not.toHaveBeenCalled();
          }
        }
      }
    }
  },
);
