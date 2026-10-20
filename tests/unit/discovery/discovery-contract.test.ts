/**
 * @fileoverview Discovery contracts through real schemas, HTTP workflows and CommonMark output.
 * @module tests/unit/discovery/discovery-contract.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgxGetGuideline } from '@/mcp-server/tools/definitions/pgx-get-guideline.tool.js';
import { pgxListReference } from '@/mcp-server/tools/definitions/pgx-list-reference.tool.js';
import { pgxSearchPairs } from '@/mcp-server/tools/definitions/pgx-search-pairs.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';

type Result = Awaited<ReturnType<typeof runToolContract>>;
function twin(result: Result) {
  expect(result.isError).not.toBe(true);
  const fences: unknown[] = [];
  let text = '';
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const walker = new Parser().parse(block.text).walker();
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.entering && event.node.type === 'code_block' && event.node.info === 'json')
        fences.push(JSON.parse(event.node.literal ?? ''));
      if (event.entering && event.node.type === 'text') text += event.node.literal;
    }
  }
  const structured = result.structuredContent as Record<string, unknown>;
  const { effectiveQuery, notices, truncated, shown, cap, ...domain } = structured;
  expect(fences).toEqual([domain, effectiveQuery, notices]);
  expect(notices).toEqual(expect.any(Array));
  if (cap !== undefined) {
    expect(text).toContain(`cap: ${cap}`);
    expect(text).toContain(`shown: ${shown}`);
    expect(text).toContain(`truncated: ${truncated}`);
  }
  return structured;
}
function source(rows: unknown[], total = rows.length, offset = 0) {
  return Response.json(rows, {
    headers: {
      'content-range': rows.length
        ? `${offset}-${offset + rows.length - 1}/${total}`
        : `*/${total}`,
    },
  });
}
function network(route: (url: URL) => Response) {
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.origin).toBe('https://api.cpicpgx.org');
      requests.push(url);
      return route(url);
    }),
  );
  return requests;
}
const clinicalText = '  **source**\r\n```json\n{}\n```\n\nRead https://example.org/a_(b).  ';
const drug = {
  drugid: 'D1',
  name: 'Drug',
  rxnormid: null,
  atcid: ['B01AC04'],
  guidelineid: 1,
  version: 2,
  future: { nested: [null, clinicalText] },
};
const guideline = {
  id: 1,
  name: 'Guideline',
  url: 'https://example.org/g1',
  notesonusage: clinicalText,
  version: 3,
  future: { raw: '' },
};
const pair = {
  pairid: 1,
  drugid: 'D1',
  genesymbol: 'G',
  guidelineurl: guideline.url,
  cpiclevel: 'A',
  future: { clinicalText },
};
beforeEach(() => initCpicService());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pgx_search_pairs', () => {
  it('combines identifiers with AND, normalizes prefixes, escapes literal patterns and batches drugs', async () => {
    const requests = network((url) =>
      url.pathname.endsWith('/drug') ? source([drug]) : source([pair, { ...pair, pairid: 2 }]),
    );
    const output = twin(
      await runToolContract(pgxSearchPairs, {
        geneSymbol: ' g ',
        drugName: 'a.*(b)[c]$|?',
        drugId: ' D1 ',
        rxnormId: ' rxnorm:32968 ',
        atcId: ' atc:b01ac04 ',
        cpicLevel: 'A/B',
        pgxTesting: 'Testing Required',
        usedForRecommendation: 'Yes',
        provisional: false,
      }),
    );
    expect(requests).toHaveLength(3);
    expect(Object.fromEntries(requests[0]?.searchParams ?? [])).toMatchObject({
      drugid: 'eq.D1',
      rxnormid: 'eq.32968',
      atcid: 'cs.{"B01AC04"}',
    });
    expect(Object.fromEntries(requests[1]?.searchParams ?? [])).toMatchObject({
      genesymbol: 'eq.G',
      drugname: 'imatch.a\\.\\*\\(b\\)\\[c\\]\\$\\|\\?',
      cpiclevel: 'neq.Retired',
      provisional: 'eq.false',
      pgxtesting: 'eq.Testing Required',
      usedforrecommendation: 'eq.Yes',
      drugid: 'in.("D1")',
    });
    expect(requests[1]?.searchParams.getAll('cpiclevel')).toEqual(['eq.A/B', 'neq.Retired']);
    expect(output.items).toEqual([
      { ...pair, drug },
      { ...pair, pairid: 2, drug },
    ]);
    expect(output).toMatchObject({
      shown: 2,
      cap: 25,
      truncated: false,
      effectiveQuery: { geneSymbol: 'G', rxnormId: '32968', atcId: 'B01AC04' },
    });
  });
  it.each([{ includeRetired: true }, { cpicLevel: 'Retired' }] as const)(
    'includes retired rows for %j',
    async (input) => {
      const requests = network(() => source([{ pairid: 1, drugid: null, cpiclevel: 'Retired' }]));
      const output = twin(await runToolContract(pgxSearchPairs, input));
      expect(requests[0]?.searchParams.getAll('cpiclevel')).not.toContain('neq.Retired');
      expect(output.notices).toEqual([]);
      expect(output.items).toEqual([{ pairid: 1, drugid: null, cpiclevel: 'Retired', drug: null }]);
    },
  );
  it('does not fall back when an identifier has no matching drug', async () => {
    const requests = network(() => source([]));
    const output = twin(
      await runToolContract(pgxSearchPairs, { rxnormId: '999', drugName: 'Drug' }),
    );
    expect(requests).toHaveLength(1);
    expect(output).toMatchObject({ items: [], shown: 0, page: { total: 0, nextOffset: null } });
  });
  it('fails closed when a pair names a missing drug', async () => {
    network((url) => source(url.pathname.endsWith('/pair_view') ? [pair] : []));
    const result = await runToolContract(pgxSearchPairs, {});
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.SerializationError },
    });
  });
});

describe('pgx_get_guideline', () => {
  it.each([
    { by: 'id', guidelineId: 1 },
    { by: 'gene', geneSymbol: ' g ' },
    { by: 'drug', drugId: ' D1 ' },
    { by: 'drug', drugName: ' Drug.* ' },
  ] as const)('resolves %j and preserves full related data', async (input) => {
    const requests = network((url) =>
      source(
        url.pathname.endsWith('/guideline')
          ? [guideline]
          : url.pathname.endsWith('/drug')
            ? [drug]
            : [pair],
      ),
    );
    const output = twin(await runToolContract(pgxGetGuideline, input));
    expect(output).toMatchObject({
      found: true,
      guidelines: [{ record: guideline, drugCount: 1, pairCount: 1 }],
      candidates: [],
      notices: [],
    });
    if ('drugName' in input)
      expect(requests[0]?.searchParams.get('name')).toBe('imatch.^Drug\\.\\*$');
    if (input.by === 'gene') expect(requests[0]?.searchParams.get('genes')).toBe('cs.{"G"}');
  });
  it('joins multiple guidelines and related pages beyond the first hundred rows', async () => {
    const records = [guideline, { ...guideline, id: 2, url: 'https://example.org/g2' }];
    const drugs = Array.from({ length: 102 }, (_, i) => ({
      ...drug,
      drugid: `D${i}`,
      guidelineid: i === 101 ? 2 : 1,
    }));
    const pairs = Array.from({ length: 102 }, (_, i) => ({
      ...pair,
      pairid: i,
      guidelineurl: records[i === 101 ? 1 : 0]?.url,
    }));
    network((url) => {
      const rows = url.pathname.endsWith('/guideline')
        ? records
        : url.pathname.endsWith('/drug')
          ? drugs.filter((d) => `eq.${d.guidelineid}` === url.searchParams.get('guidelineid'))
          : pairs.filter((p) => `eq.${p.guidelineurl}` === url.searchParams.get('guidelineurl'));
      const offset = Number(url.searchParams.get('offset'));
      return source(rows.slice(offset, offset + 101), rows.length, offset);
    });
    const output = twin(await runToolContract(pgxGetGuideline, { by: 'gene', geneSymbol: 'G' }));
    expect(output.guidelines).toEqual(
      records.map((record) => ({
        record,
        drugCount: drugs.filter((d) => d.guidelineid === record.id).length,
        pairCount: pairs.filter((p) => p.guidelineurl === record.url).length,
      })),
    );
  });
  it.each([
    { rows: [] },
    { rows: [{ ...drug, guidelineid: null }] },
    { rows: [drug, { ...drug, drugid: 'D2' }] },
  ])('retains missing/ambiguous drug candidates $rows', async ({ rows }) => {
    network(() => source(rows));
    const output = twin(await runToolContract(pgxGetGuideline, { by: 'drug', drugName: 'Drug' }));
    expect(output).toMatchObject({
      found: false,
      guidelines: [],
      candidates: rows.length > 1 ? rows : [],
    });
    expect(output.notices).toEqual([output.guidance]);
  });
  it('returns missing numeric guideline as successful absence', async () => {
    network(() => source([]));
    expect(
      twin(await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 100420 })),
    ).toMatchObject({ found: false, guidelines: [], candidates: [] });
  });
  it.each([
    { by: 'id' },
    { by: 'gene', geneSymbol: ' ' },
    { by: 'drug', drugId: 'D1', drugName: 'Drug' },
    { by: 'id', guidelineId: 1, geneSymbol: 'G' },
    { by: 'gene', geneSymbol: 'G', drugId: 'D1' },
    { by: 'drug', drugName: 'Drug', guidelineId: 1 },
  ] as const)('rejects mixed or missing selectors %j before fetch', async (input) => {
    const requests = network(() => source([]));
    const result = await runToolContract(pgxGetGuideline, input);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_selector',
          recovery: { hint: pgxGetGuideline.errors?.[0]?.recovery },
        },
      },
    });
    expect(requests).toEqual([]);
  });
});

describe('pgx_list_reference', () => {
  it.each(['cpic_levels', 'pgx_testing', 'classifications', 'input_formats'] as const)(
    'returns complete static %s without network or fabricated access time',
    async (topic) => {
      const requests = network(() => {
        throw new Error('static topic fetched');
      });
      const output = twin(
        await runToolContract(pgxListReference, { topic, geneSymbol: ' ', offset: 999, limit: 1 }),
      );
      expect(output).toMatchObject({
        page: { offset: 0, limit: 100, nextOffset: null },
        provenance: { verificationDate: '2026-10-19', requestUrls: [] },
        truncated: false,
      });
      expect(output.provenance).not.toHaveProperty('accessedAt');
      expect(requests).toEqual([]);
      if (topic === 'classifications')
        expect(output.items).toEqual(
          expect.arrayContaining(
            ['Strong', 'Moderate', 'Optional', 'No Recommendation', 'n/a'].map((value) =>
              expect.objectContaining({ value }),
            ),
          ),
        );
      if (topic === 'cpic_levels') expect(output.items).toHaveLength(8);
    },
  );
  it.each(['genes', 'phenotypes'] as const)(
    'preserves sparse, nested, nullable %s source rows',
    async (topic) => {
      const rows =
        topic === 'genes'
          ? [
              {
                symbol: 'G',
                notesondiplotype: clinicalText,
                lookupmethod: 'ACTIVITY_SCORE',
                future: { x: [null, ''] },
              },
            ]
          : [
              {
                id: 1,
                genesymbol: 'G',
                result: 'Intermediate Metabolizer',
                activityscore: '0.25',
                frequency: { A: null, B: 0 },
                consultationtext: clinicalText,
              },
              { id: 2, genesymbol: 'G', result: 'Intermediate Metabolizer', activityscore: '0.5' },
            ];
      const requests = network(() => source(rows));
      const output = twin(await runToolContract(pgxListReference, { topic, geneSymbol: ' g ' }));
      expect(output.items).toEqual(rows);
      expect(requests[0]?.searchParams.get(topic === 'genes' ? 'symbol' : 'genesymbol')).toBe(
        'eq.G',
      );
    },
  );
  it.each([
    { topic: 'phenotypes' },
    { topic: 'phenotypes', geneSymbol: ' ' },
    { topic: 'cpic_levels', geneSymbol: 'G' },
  ] as const)('rejects invalid selector %j', async (input) => {
    const requests = network(() => source([]));
    const result = await runToolContract(pgxListReference, input);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_selector' } },
    });
    expect(requests).toEqual([]);
  });
});

describe.each([
  { tool: pgxSearchPairs, input: {} },
  { tool: pgxListReference, input: { topic: 'genes' } },
])('$tool.name page boundaries', ({ tool, input }) => {
  it.each([0, 10000])('returns empty offset %i with complete enrichment', async (offset) => {
    network(() =>
      offset
        ? Response.json({ code: 'PGRST103' }, { status: 416, headers: { 'content-range': '*/3' } })
        : source([]),
    );
    expect(
      twin(
        await runToolContract(tool, {
          ...input,
          offset,
          geneSymbol: ' ',
          ...(tool.name === 'pgx_search_pairs'
            ? { drugName: '', drugId: '', rxnormId: '', atcId: '' }
            : {}),
        }),
      ),
    ).toMatchObject({
      items: [],
      shown: 0,
      cap: 25,
      truncated: false,
      page: { offset, total: offset ? 3 : 0, nextOffset: null },
    });
  });
  it('returns all 100 rows and a valid nextOffset without a source count', async () => {
    const rows = Array.from({ length: 101 }, (_, i) =>
      tool.name === 'pgx_search_pairs' ? { pairid: i, drugid: null } : { symbol: `G${i}` },
    );
    network(() => Response.json(rows));
    const output = twin(await runToolContract(tool, { ...input, limit: 100 }));
    expect(output).toMatchObject({
      shown: 100,
      cap: 100,
      truncated: true,
      page: { total: null, returned: 100, nextOffset: 100 },
    });
    expect(output.items).toHaveLength(100);
  });
});

describe.each([
  { tool: pgxSearchPairs, input: {} },
  { tool: pgxGetGuideline, input: { by: 'id', guidelineId: 1 } },
  { tool: pgxListReference, input: { topic: 'genes' } },
] as const)('$tool.name upstream contracts', ({ tool, input }) => {
  it.each([
    ['upstream_query_rejected', 400],
    ['upstream_rate_limited', 429],
    ['upstream_unavailable', 503],
  ] as const)(
    'returns %s with exact declared recovery on both surfaces',
    async (reason, status) => {
      vi.useFakeTimers();
      network(() =>
        Response.json(
          { message: 'untrusted clinical body' },
          { status, headers: { 'retry-after': '1' } },
        ),
      );
      const pending =
        tool.name === 'pgx_search_pairs'
          ? runToolContract(pgxSearchPairs, {})
          : tool.name === 'pgx_get_guideline'
            ? runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1 })
            : runToolContract(pgxListReference, { topic: 'genes' });
      await vi.runAllTimersAsync();
      const result = await pending;
      const entry = tool.errors?.find((e) => e.reason === reason);
      expect(result.structuredContent).toMatchObject({
        error: { code: entry?.code, data: { reason, recovery: { hint: entry?.recovery } } },
      });
      expect(JSON.stringify(result.content)).toContain(entry?.recovery);
      expect(JSON.stringify(result)).not.toContain('untrusted clinical body');
    },
  );
  it('rejects invalid schema fields before fetch', async () => {
    const requests = network(() => source([]));
    const result = await runToolContract(tool, { ...input, limit: 101, guidelineId: -1 });
    expect(result.isError).toBe(true);
    expect(requests).toEqual([]);
  });
});

describe('bounded discovery scans', () => {
  it.each(['drug', 'pair_view'] as const)(
    'rejects related %s coverage above 2000 rows',
    async (endpoint) => {
      network((url) => {
        if (url.pathname.endsWith('/guideline')) return source([guideline]);
        if (!url.pathname.endsWith(`/${endpoint}`)) return source([]);
        const offset = Number(url.searchParams.get('offset'));
        return Response.json(
          Array.from({ length: 101 }, (_, i) =>
            endpoint === 'drug'
              ? { ...drug, drugid: `D${offset + i}` }
              : { ...pair, pairid: offset + i },
          ),
        );
      });
      const result = await runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1 });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'query_too_broad', cap: 2000 } },
      });
      expect(JSON.stringify(result.content)).not.toContain('"guidelines"');
    },
  );
  it.each([{ tool: pgxSearchPairs, input: { drugId: 'D1' }, cap: 500, endpoint: 'drug' }])(
    'fails rather than returning a partial $endpoint scan',
    async ({ tool, input, cap, endpoint }) => {
      network((url) => {
        const offset = Number(url.searchParams.get('offset'));
        return source(
          Array.from({ length: 101 }, (_, i) =>
            endpoint === 'drug'
              ? { ...drug, drugid: `D${offset + i}` }
              : { ...guideline, id: offset + i },
          ),
          cap + 1,
          offset,
        );
      });
      const result = await runToolContract(tool, input);
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'query_too_broad',
            cap,
          },
        },
      });
      expect(JSON.stringify(result.content)).toContain(
        tool.errors?.find((e) => e.reason === 'query_too_broad')?.recovery,
      );
      expect(JSON.stringify(result)).not.toContain('requestUrl');
      expect(JSON.stringify(result)).not.toContain('source request URL');
    },
  );
});

describe('discovery source failure boundaries', () => {
  it('stops a multi-step join when the request is cancelled', async () => {
    const controller = new AbortController();
    const requests = network(() => {
      controller.abort();
      return source([guideline]);
    });
    const result = await runToolContract(
      pgxGetGuideline,
      { by: 'id', guidelineId: 1 },
      { context: { signal: controller.signal } },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(requests).toHaveLength(1);
  });
  it('bounds stalled HTTP attempts without starting related lookups', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const pending = runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(3);
    expect(fetch.mock.calls.every(([url]) => new URL(url).pathname.endsWith('/guideline'))).toBe(
      true,
    );
  });
  it.each([
    {
      name: 'malformed JSON',
      response: () => new Response('{'),
      code: JsonRpcErrorCode.SerializationError,
    },
    {
      name: 'incompatible successful shape',
      response: () => Response.json([{ wrong: true }]),
      code: JsonRpcErrorCode.SerializationError,
    },
    {
      name: 'endpoint 404',
      response: () => Response.json({ code: '42P01' }, { status: 404 }),
      code: JsonRpcErrorCode.ServiceUnavailable,
    },
    {
      name: 'HTML maintenance',
      response: () => new Response('<!doctype html><html>maintenance</html>'),
      code: JsonRpcErrorCode.ServiceUnavailable,
    },
    {
      name: 'unauthorized source',
      response: () => new Response('', { status: 401 }),
      code: JsonRpcErrorCode.Unauthorized,
    },
    {
      name: 'forbidden source',
      response: () => new Response('', { status: 403 }),
      code: JsonRpcErrorCode.Forbidden,
    },
  ])('keeps $name distinct from missing coverage', async ({ response, code }) => {
    vi.useFakeTimers();
    network(response);
    const pending = runToolContract(pgxGetGuideline, { by: 'id', guidelineId: 1 });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code } });
    expect(JSON.stringify(result)).not.toContain('API key');
  });
  it('documents the complete tool chain in static input formats', async () => {
    network(() => {
      throw new Error('Unexpected source request');
    });
    const output = twin(await runToolContract(pgxListReference, { topic: 'input_formats' }));
    for (const name of [
      'pgx_list_reference',
      'pgx_search_pairs',
      'pgx_get_guideline',
      'pgx_lookup_diplotype',
      'pgx_get_recommendations',
      'pgx_search_alleles',
    ])
      expect(JSON.stringify(output.items)).toContain(name);
  });
});
