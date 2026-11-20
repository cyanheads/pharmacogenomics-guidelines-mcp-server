/** @fileoverview Source-page completeness at the HTTP/service/formatter seam.
 * @module tests/unit/tool-shared/pagination-contract.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pgxGetGuideline } from '@/mcp-server/tools/definitions/pgx-get-guideline.tool.js';
import { searchAllelesTool } from '@/mcp-server/tools/definitions/search-alleles.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';

beforeEach(() => initCpicService());
afterEach(() => vi.unstubAllGlobals());

function network(size = 40, text = '東京🧬'.repeat(160), unknown = false) {
  const alleles = Array.from({ length: size }, (_, id) => ({
    id,
    definitionid: id,
    genesymbol: 'G',
    name: `*${id}`,
    version: 1,
    clinicalfunctionalstatus: text,
  }));
  const frequencies = alleles.flatMap((row) =>
    Array.from({ length: 3 }, (_, i) => ({
      genesymbol: 'G',
      name: row.name,
      population_group: `P${i}`,
      freq_avg: i / 10,
      version: 2,
      nested: { complete: [null, text], 'a/b~c': { version: 3 } },
    })),
  );
  const guidelines = [
    { id: 1, name: 'G', url: `https://example.org/${'long'.repeat(100)}`, version: 3 },
  ];
  const drugs = alleles.map((row) => ({
    drugid: `D${String(row.id).padStart(3, '0')}`,
    name: row.name,
    guidelineid: 1,
    version: 1,
    notes: text,
  }));
  const pairs = alleles.map((row) => ({
    pairid: row.id,
    drugid: `D${String(row.id).padStart(3, '0')}`,
    guidelineurl: guidelines[0]?.url,
    version: 2,
    notes: text,
  }));
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input),
      offset = Number(url.searchParams.get('offset') ?? 0),
      limit = Number(url.searchParams.get('limit') ?? 100);
    const endpoint = url.pathname.split('/').at(-1);
    let rows: unknown[] =
      endpoint === 'allele'
        ? alleles
        : endpoint === 'population_frequency_view'
          ? frequencies
          : endpoint === 'guideline'
            ? guidelines
            : endpoint === 'drug'
              ? drugs
              : pairs;
    if (endpoint === 'population_frequency_view')
      rows = frequencies.filter((row) =>
        (url.searchParams.get('name') ?? '').includes(`"${row.name}"`),
      );
    const page = rows.slice(offset, offset + limit);
    return Response.json(page, {
      headers: unknown
        ? {}
        : {
            'content-range': page.length
              ? `${offset}-${offset + page.length - 1}/${rows.length}`
              : `*/${rows.length}`,
          },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { alleles, frequencies, guidelines, drugs, pairs, fetch };
}

it('characterizes complete sparse nested frequency rows and real formatter output', async () => {
  const { alleles, frequencies } = network(1, 'source\r\ntext');
  const result = await runToolContract(searchAllelesTool, {
    geneSymbol: 'G',
    includePopulationFrequencies: true,
  });
  expect(result.isError).not.toBe(true);
  expect(assertSurfaces(result).items).toEqual([
    { ...alleles[0], populationFrequencies: frequencies },
  ]);
});

it('returns a complete multibyte allele page and advances through unknown totals', async () => {
  network(40, undefined, true);
  const result = await runToolContract(searchAllelesTool, { geneSymbol: 'G', limit: 25 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    truncated: true,
    page: { total: null, nextOffset: 25, returned: 25 },
  });
});

it('defaults guidelines to counted descriptors and independently pages related pairs', async () => {
  network();
  const summary = await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1 });
  expect((summary.structuredContent as Record<string, unknown>)?.guidelines).toMatchObject([
    { drugCount: 40, pairCount: 40 },
  ]);
  expect((summary.structuredContent as Record<string, unknown>)?.guidelines).not.toMatchObject([
    { drugs: expect.any(Array) },
  ]);
  const detail = await runToolContract(pgxGetGuideline, {
    by: 'id',
    guidelineId: 1,
    view: 'pairs',
    limit: 2,
    offset: 4,
  });
  expect(detail.structuredContent).toMatchObject({
    pairs: [{ pairid: 4 }, { pairid: 5 }],
    page: { offset: 4, returned: 2, total: 40, nextOffset: 6 },
  });
});

it('clamps safe positive limits before fetching', async () => {
  const { fetch } = network(1, 'small');
  const result = await runToolContract(searchAllelesTool, { geneSymbol: 'G', limit: 101 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    cap: 100,
    effectiveQuery: { limit: 100 },
    notices: [expect.stringContaining('100')],
  });
  expect(new URL(fetch.mock.calls[0]?.[0] ?? '').searchParams.get('limit')).toBe('101');
});

function assertSurfaces(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const structured = result.structuredContent as Record<string, unknown>;
  const { effectiveQuery, notices, truncated, shown, cap, ...domain } = structured;
  const fences: unknown[] = [];
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const walker = new Parser().parse(block.text).walker();
    for (let event = walker.next(); event; event = walker.next())
      if (event.entering && event.node.type === 'code_block' && event.node.info === 'json')
        fences.push(JSON.parse(event.node.literal ?? ''));
  }
  expect(fences).toEqual([domain, effectiveQuery, notices]);
  const trailer = result.content.at(-1);
  expect(trailer).toMatchObject({ type: 'text' });
  if (trailer?.type !== 'text') throw new Error('Expected text enrichment');
  for (const [key, value] of Object.entries({ truncated, shown, cap })) {
    expect(trailer.text).toContain(`**${key}:** ${String(value)}`);
  }
  expect(structured).not.toHaveProperty('oversizedRow');
  const provenance = structured.provenance as {
    rowVersions: { path: string; requestIndex: number; version: number }[];
    requestUrls: string[];
  };
  for (const entry of provenance.rowVersions) {
    const value = entry.path
      .split('/')
      .slice(1)
      .reduce(
        (current: unknown, key) =>
          (current as Record<string, unknown>)[key.replace(/~1/g, '/').replace(/~0/g, '~')],
        structured,
      );
    expect(value).toMatchObject({ version: entry.version });
    expect(provenance.requestUrls[entry.requestIndex]).toEqual(expect.any(String));
  }
  return structured;
}

it.each([false, true])(
  'reconstructs complete nested frequency evidence over repeated pages (unknown=%s)',
  async (unknown) => {
    const { alleles, frequencies } = network(19, '東京🧬'.repeat(160), unknown);
    const recovered: unknown[] = [];
    let offset: number | null = 0,
      pages = 0;
    while (offset !== null) {
      const result = await runToolContract(searchAllelesTool, {
        geneSymbol: 'G',
        limit: 9,
        includePopulationFrequencies: true,
        offset,
      });
      const output = assertSurfaces(result);
      const page = output.page as { nextOffset: number | null; returned: number };
      expect(output.shown).toBe(page.returned);
      expect(output.truncated).toBe(page.nextOffset !== null);
      recovered.push(...(output.items as unknown[]));
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
      if (++pages > 30) throw new Error('Continuation failed to terminate');
    }
    expect(pages).toBe(3);
    expect(recovered).toEqual(
      alleles.map((row) => ({
        ...row,
        populationFrequencies: frequencies.filter((f) => f.name === row.name),
      })),
    );
  },
);

it('retains all large allele and frequency rows without a byte-budget notice', async () => {
  const { alleles, frequencies } = network(2, '東京🧬'.repeat(1000));
  const result = await runToolContract(searchAllelesTool, {
    geneSymbol: 'G',
    includePopulationFrequencies: true,
  });
  const output = assertSurfaces(result);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(24000);
  expect(output).toMatchObject({
    shown: 2,
    truncated: false,
    page: { returned: 2, nextOffset: null },
    notices: [],
  });
  expect(output.items).toEqual(
    alleles.map((row) => ({
      ...row,
      populationFrequencies: frequencies.filter((frequency) => frequency.name === row.name),
    })),
  );
});

it.each(['summary', 'drugs', 'pairs'] as const)(
  'reconstructs guideline %s independently with exact counts and source links',
  async (view) => {
    const data = network(17);
    const rows: unknown[] = [];
    let offset: number | null = 0,
      pages = 0;
    while (offset !== null) {
      const result = await runToolContract(pgxGetGuideline, {
        by: 'id',
        guidelineId: 1,
        view,
        limit: 7,
        offset,
      });
      const output = assertSurfaces(result),
        page = output.page as { returned: number; nextOffset: number | null; total: number };
      expect(output).not.toHaveProperty(view === 'drugs' ? 'pairs' : 'drugs');
      expect(output.guidelines).toEqual([
        { record: data.guidelines[0], drugCount: 17, pairCount: 17 },
      ]);
      expect(output.shown).toBe(page.returned);
      rows.push(...(output[view === 'summary' ? 'guidelines' : view] as unknown[]));
      offset = page.nextOffset;
      if (++pages > 30) throw new Error('Continuation failed to terminate');
    }
    expect(rows).toEqual(
      view === 'summary'
        ? [{ record: data.guidelines[0], drugCount: 17, pairCount: 17 }]
        : data[view],
    );
  },
);

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity])(
  'rejects invalid limit %s before fetch on both tools',
  async (limit) => {
    const { fetch } = network();
    for (const result of [
      await runToolContract(searchAllelesTool, { geneSymbol: 'G', limit }),
      await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1, limit }),
    ]) {
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('limit');
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each(['drugs', 'pairs'] as const)(
  'rejects %s without by=id using declared recovery before fetch',
  async (view) => {
    const { fetch } = network();
    const result = await runToolContract(pgxGetGuideline, { by: 'gene', geneSymbol: 'G', view });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_selector',
          recovery: { hint: pgxGetGuideline.errors?.[0]?.recovery },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain(pgxGetGuideline.errors?.[0]?.recovery);
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([0, 1000])('preserves empty and past-end metadata at offset %s', async (offset) => {
  network(0);
  for (const result of [
    await runToolContract(searchAllelesTool, { geneSymbol: 'G', offset }),
    await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1, view: 'drugs', offset }),
  ]) {
    expect(assertSurfaces(result)).toMatchObject({
      shown: 0,
      truncated: false,
      page: { offset, returned: 0, total: 0, nextOffset: null },
    });
  }
});

it('pages ambiguous candidates without duplicate, skipped or split records', async () => {
  const { drugs } = network(21);
  const recovered: unknown[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await runToolContract(pgxGetGuideline, {
      by: 'drug',
      drugName: 'ambiguous',
      limit: 8,
      offset,
    });
    const output = assertSurfaces(result),
      page = output.page as { nextOffset: number | null; returned: number };
    expect(output).toMatchObject({ found: false, guidelines: [], shown: page.returned });
    recovered.push(...(output.candidates as unknown[]));
    offset = page.nextOffset;
  }
  expect(recovered).toEqual(drugs);
  const output = assertSurfaces(
    await runToolContract(pgxGetGuideline, { by: 'drug', drugName: 'ambiguous', offset: 999 }),
  );
  expect(output).toMatchObject({
    candidates: [],
    shown: 0,
    truncated: false,
    page: { offset: 999, total: 21, nextOffset: null },
  });
});

it('counts distinct drugs and retains the selected known-total pairs page', async () => {
  const { fetch } = network(140, 'small');
  const result = await runToolContract(pgxGetGuideline, {
    by: 'id',
    guidelineId: 1,
    view: 'pairs',
    limit: 101,
    offset: 100,
  });
  const output = assertSurfaces(result);
  expect(output).toMatchObject({
    cap: 100,
    effectiveQuery: { limit: 100 },
    guidelines: [{ drugCount: 140, pairCount: 140 }],
    page: {
      offset: 100,
      total: 140,
      returned: 40,
      nextOffset: null,
    },
  });
  const urls = fetch.mock.calls.map((call) => new URL(call[0]));
  expect(
    urls
      .filter((url) => url.pathname.endsWith('/drug'))
      .at(-1)
      ?.searchParams.get('offset'),
  ).toBe('100');
  expect(urls.find((url) => url.pathname.endsWith('/pair_view'))?.searchParams.get('limit')).toBe(
    '101',
  );
});

it('counts unknown-total related collections through bounded multi-page scans', async () => {
  network(107, 'small', true);
  const output = assertSurfaces(
    await runToolContract(pgxGetGuideline, {
      by: 'id',
      guidelineId: 1,
      view: 'drugs',
      offset: 102,
      limit: 3,
    }),
  );
  expect(output).toMatchObject({
    guidelines: [{ drugCount: 107, pairCount: 107 }],
    drugs: [{ drugid: 'D102' }, { drugid: 'D103' }, { drugid: 'D104' }],
    page: { offset: 102, returned: 3, total: 107, nextOffset: 105 },
  });
});

it('records real provenance and omits joins when the flag is explicitly false', async () => {
  const { alleles, fetch } = network(100);
  const result = await runToolContract(searchAllelesTool, {
    geneSymbol: 'G',
    limit: 101,
    includePopulationFrequencies: false,
  });
  const output = assertSurfaces(result);
  expect(output).toMatchObject({
    cap: 100,
    shown: 100,
    truncated: false,
    effectiveQuery: { includePopulationFrequencies: false },
  });
  expect(output.items).toEqual(alleles);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(output.provenance).toMatchObject({ requestUrls: fetch.mock.calls.map(([url]) => url) });
});

it.each([false, true])(
  'reconstructs source-paged guideline summary descriptors (unknown=%s)',
  async (unknown) => {
    const records = Array.from({ length: 9 }, (_, id) => ({
      id,
      name: `Guideline${id}`,
      notesonusage: '界'.repeat(1500),
      version: 1,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input),
          offset = Number(url.searchParams.get('offset') ?? 0),
          limit = Number(url.searchParams.get('limit') ?? 100);
        const rows = url.pathname.endsWith('/guideline') ? records : [];
        const page = rows.slice(offset, offset + limit);
        return Response.json(page, {
          headers: unknown
            ? {}
            : {
                'content-range': page.length
                  ? `${offset}-${offset + page.length - 1}/${rows.length}`
                  : `*/${rows.length}`,
              },
        });
      }),
    );
    const recovered: unknown[] = [];
    let offset: number | null = 0,
      pages = 0;
    while (offset !== null) {
      const result = await runToolContract(pgxGetGuideline, {
        by: 'gene',
        geneSymbol: 'G',
        offset,
        limit: 4,
      });
      const output = assertSurfaces(result),
        page = output.page as { nextOffset: number | null };
      recovered.push(...(output.guidelines as unknown[]));
      if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
      if (++pages > 12) throw new Error('Summary continuation did not terminate');
    }
    expect(pages).toBeGreaterThan(2);
    expect(recovered).toEqual(records.map((record) => ({ record, drugCount: 0, pairCount: 0 })));
  },
);

it.each([25, 100])('fills allele pages of %i and recovers every source row', async (limit) => {
  const { alleles, fetch } = network(208);
  const recovered: unknown[] = [];
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const result = await runToolContract(searchAllelesTool, { geneSymbol: 'G', limit, offset });
    const output = assertSurfaces(result);
    const page = output.page as { returned: number; nextOffset: number | null };
    expect(output.items).toEqual(alleles.slice(offset, offset + limit));
    expect(output.effectiveQuery).toMatchObject({ includePopulationFrequencies: false });
    expect(page.returned).toBe(Math.min(limit, alleles.length - offset));
    recovered.push(...(output.items as unknown[]));
    offset = page.nextOffset;
    if (++pages > Math.ceil(alleles.length / limit))
      throw new Error('Continuation did not terminate');
  }
  expect(recovered).toEqual(alleles);
  expect(fetch.mock.calls.every(([url]) => new URL(url).pathname.endsWith('/allele'))).toBe(true);
});

it('returns a complete guideline pairs page above the former byte budget', async () => {
  const { pairs } = network(33);
  const output = assertSurfaces(
    await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1, view: 'pairs', limit: 100 }),
  );
  expect(output).toMatchObject({ pairs, page: { returned: 33, nextOffset: null }, notices: [] });
});

it.each(['summary', 'drugs', 'pairs', 'candidates'] as const)(
  'reports past-end offset for %s',
  async (view) => {
    network(17);
    const input =
      view === 'candidates'
        ? { by: 'drug' as const, drugName: 'ambiguous' }
        : { by: 'id' as const, guidelineId: 1, view };
    const output = assertSurfaces(await runToolContract(pgxGetGuideline, { ...input, offset: 99 }));
    expect(output.page).toMatchObject({ returned: 0, total: view === 'summary' ? 1 : 17 });
    expect(output.notices).toContain(
      `Offset 99 is past the last row (total ${view === 'summary' ? 1 : 17}); retry with a smaller offset.`,
    );
    if (view === 'candidates')
      expect(output.notices).toContain('Retry pgx_get_guideline with one candidate drugId.');
  },
);

it.each([false, true])(
  'keeps the no-coverage guidance for an empty summary (unknown=%s)',
  async (unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([], {
          headers: unknown ? {} : { 'content-range': '*/0' },
        }),
      ),
    );
    const output = assertSurfaces(
      await runToolContract(pgxGetGuideline, { by: 'gene', geneSymbol: 'G', offset: 99 }),
    );
    expect(output).toMatchObject({
      found: false,
      page: { total: unknown ? null : 0, returned: 0, nextOffset: null },
      notices: ['Call pgx_search_pairs to find a gene or drug and its guideline coverage.'],
    });
  },
);
