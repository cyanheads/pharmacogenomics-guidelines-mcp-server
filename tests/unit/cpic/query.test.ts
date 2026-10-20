/**
 * @fileoverview CPIC query semantics at the real workflow HTTP seam.
 * @module tests/unit/cpic/query.test
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CpicService } from '@/services/cpic/cpic-service.js';

afterEach(() => vi.unstubAllGlobals());
describe('CPIC scalar query semantics', () => {
  it.each([
    ['eq', 'clopidogrel', 'eq.clopidogrel'],
    ['neq', 'clopidogrel', 'neq.clopidogrel'],
    ['substring', 'c.*', 'imatch.c\\.\\*'],
    ['iexact', 'ClOpIdOgReL', 'imatch.^ClOpIdOgReL$'],
  ] as const)(
    'sends literal %s without PostgREST scalar quotes',
    async (operator, value, expected) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const filter = new URL(input).searchParams.get('name');
          return Response.json(
            filter === expected ? [{ drugid: 'RxNorm:32968', name: value }] : [],
          );
        }),
      );
      const result = await new CpicService().workflow(createMockContext(), (workflow) =>
        workflow.page('drug', { filters: [{ column: 'name', operator, value }] }),
      );
      expect(result.items).toEqual([{ drugid: 'RxNorm:32968', name: value }]);
    },
  );
  it('quotes separators within in-list elements', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        expect(new URL(input).searchParams.get('drugid')).toBe('in.("a,b","x\\"y","z\\\\q")');
        return Response.json([]);
      }),
    );
    await new CpicService().workflow(createMockContext(), (workflow) =>
      workflow.page('drug', {
        filters: [{ column: 'drugid', operator: 'in', value: ['a,b', 'x"y', 'z\\q'] }],
      }),
    );
  });
});
