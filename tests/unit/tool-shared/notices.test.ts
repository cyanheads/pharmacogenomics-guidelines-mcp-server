/** @fileoverview Shared past-end semantics and per-tool notice wiring.
 * @module tests/unit/tool-shared/notices.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pgxListReference } from '@/mcp-server/tools/definitions/pgx-list-reference.tool.js';
import { pgxSearchPairs } from '@/mcp-server/tools/definitions/pgx-search-pairs.tool.js';
import { searchAllelesTool } from '@/mcp-server/tools/definitions/search-alleles.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';
import { emptyPageNotice } from '@/services/cpic/notices.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

it.each([null, 0])('does not call unknown/zero totals past-end: %s', (total) => {
  expect(
    emptyPageNotice({ limit: 25, offset: 100, returned: 0, total, nextOffset: null }, 'No rows'),
  ).toBe('No rows');
});

it('wires real 416 past-end notices across pair, allele and live-reference tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ code: 'PGRST103' }, { status: 416, headers: { 'content-range': '*/3' } }),
    ),
  );
  const outputs = [
    await runToolContract(pgxSearchPairs, { offset: 100 }),
    await runToolContract(searchAllelesTool, { geneSymbol: 'G', offset: 100 }),
    await runToolContract(pgxListReference, { topic: 'genes', offset: 100 }),
  ];
  for (const output of outputs) {
    expect(output.isError).not.toBe(true);
    expect(JSON.stringify(output.structuredContent)).toContain('past the last row (total 3)');
    expect(JSON.stringify(output.content)).toContain('past the last row (total 3)');
    expect(JSON.stringify(output)).not.toContain('broaden');
  }
});
