/**
 * @fileoverview Real evidence tool contracts across structured and CommonMark surfaces.
 * @module tests/unit/evidence/evidence-contract.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupDiplotypeTool } from '@/mcp-server/tools/definitions/lookup-diplotype.tool.js';
import { searchAllelesTool } from '@/mcp-server/tools/definitions/search-alleles.tool.js';
import { initCpicService } from '@/services/cpic/cpic-service.js';

type ContractResult = Awaited<ReturnType<typeof runToolContract>>;

function assertTwin(result: ContractResult) {
  expect(result.isError).not.toBe(true);
  const fences: unknown[] = [];
  let prose = '';
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const walker = new Parser().parse(block.text).walker();
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.entering && event.node.type === 'code_block' && event.node.info === 'json') {
        fences.push(JSON.parse(event.node.literal ?? ''));
      }
      if (event.entering && event.node.type === 'text') prose += event.node.literal;
      if (event.entering && (event.node.type === 'softbreak' || event.node.type === 'linebreak'))
        prose += '\n';
      if (!event.entering && event.node.type === 'paragraph') prose += '\n';
    }
  }
  const structured = result.structuredContent as Record<string, unknown>;
  expect(structured).toBeDefined();
  const { effectiveQuery, notices, truncated, shown, cap, ...domain } = structured ?? {};
  expect(fences).toContainEqual(domain);
  expect(fences).toContainEqual(effectiveQuery);
  expect(fences).toContainEqual(notices);
  if (cap !== undefined) {
    expect(prose).toContain(`cap: ${cap}`);
    expect(prose).toContain(`shown: ${shown}`);
    expect(prose).toContain(`truncated: ${truncated}`);
  }
  return structured ?? {};
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

beforeEach(() => initCpicService());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('pgx_lookup_diplotype contract', () => {
  it('does not invent aliases for multi-component or mismatched-gene notation', async () => {
    const attempted: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        attempted.push(new URL(url).searchParams.get('diplotype') ?? '');
        return source([]);
      }),
    );
    const output = assertTwin(
      await runToolContract(lookupDiplotypeTool, { geneSymbol: 'CYP2C19', diplotype: '*1/*2/*3' }),
    );
    expect(output).toMatchObject({ found: false, matchedDiplotype: null, records: [] });
    expect(attempted).toEqual(['eq.*1/*2/*3']);
  });
  const row = {
    genesymbol: 'CYP2C19',
    diplotype: '*1/*2',
    function1: 'SOURCE SLOT ONE',
    function2: 'SOURCE SLOT TWO',
    activityvalue1: null,
    totalactivityscore: 'n/a',
    description: '```\r\n data  \n\n',
    consultationtext: 'Read https://example.org/guideline_(a).',
    generesult: 'Intermediate Metabolizer',
    diplotypekey: { CYP2C19: { '*1': 1, '*2': 1 } },
    lookupkey: { CYP2C19: 'Intermediate Metabolizer' },
  };
  it.each(['*1/*2', '*2/*1', 'CYP2C19 *2/*1'])(
    'resolves %s while preserving source slot assignments',
    async (diplotype) => {
      const attempted: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const params = new URL(input).searchParams;
          expect(params.get('genesymbol')).toBe('eq.CYP2C19');
          const notation = params.get('diplotype')?.slice(3) ?? '';
          attempted.push(notation);
          return source(notation === row.diplotype ? [row] : []);
        }),
      );
      const output = assertTwin(
        await runToolContract(lookupDiplotypeTool, { geneSymbol: ' cyp2c19 ', diplotype }),
      );
      expect(output).toMatchObject({
        found: true,
        matchedDiplotype: '*1/*2',
        records: [row],
        notices: [],
        effectiveQuery: { geneSymbol: 'CYP2C19', diplotype },
      });
      expect(attempted[0]).toBe(diplotype);
      expect(attempted.at(-1)).toBe('*1/*2');
    },
  );
  it.each([
    {
      gene: 'HLA-B',
      input: 'HLA-B*57:01 POSITIVE',
      notation: '*57:01 positive',
      key: { 'HLA-B': { '*57:01': 1 } },
    },
    {
      gene: 'CFTR',
      input: 'F508del/F508del',
      notation: 'F508del/F508del',
      key: { CFTR: { F508del: 2 } },
    },
  ])('preserves source maps for $gene notation', async ({ gene, input, notation, key }) => {
    const record = {
      genesymbol: gene,
      diplotype: notation,
      diplotypekey: key,
      consultationtext: null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        source(new URL(url).searchParams.get('diplotype') === `eq.${notation}` ? [record] : []),
      ),
    );
    const output = assertTwin(
      await runToolContract(lookupDiplotypeTool, { geneSymbol: gene, diplotype: input }),
    );
    expect(output).toMatchObject({ found: true, matchedDiplotype: notation, records: [record] });
  });
  it.each([0, 2])('retains missing or ambiguous source results (%i records)', async (count) => {
    const rows = Array.from({ length: count }, (_, index) => ({
      ...row,
      description: `candidate ${index}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => source(rows)),
    );
    const output = assertTwin(
      await runToolContract(lookupDiplotypeTool, { geneSymbol: 'CYP2C19', diplotype: '*1/*2' }),
    );
    expect(output.records).toEqual(rows);
    expect(output.found).toBe(count > 0);
    expect(output.guidance).toBe(
      count === 0
        ? 'Call pgx_search_alleles for this gene and pgx_list_reference with topic phenotypes; supply a supported diplotype or allele-status result.'
        : 'Call pgx_list_reference with topic phenotypes for this gene; do not infer one gene result from an ambiguous diplotype.',
    );
    expect(output.notices).toEqual([output.guidance]);
  });
});

describe('pgx_search_alleles contract', () => {
  it('keeps nullable and absent definition fields distinct and joins by both source keys', async () => {
    const rows = [
      { id: 1, genesymbol: 'G', name: '*1', definitionid: 1, allele_definition: null },
      { id: 2, genesymbol: 'G', name: '*2', definitionid: 2 },
    ];
    const frequency = {
      genesymbol: 'G',
      name: '*1',
      population_group: 'A',
      freq_min: null,
      freq_max: 0.25,
      freq_avg: 0,
      freq_weighted_avg: 0.125,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname.endsWith('/allele')
          ? source(rows)
          : source([
              frequency,
              { ...frequency, genesymbol: 'OTHER' },
              { ...frequency, name: '*99' },
            ]),
      ),
    );
    const output = assertTwin(
      await runToolContract(searchAllelesTool, { geneSymbol: 'G', clinicalFunctionalStatus: ' ' }),
    );
    expect(output.items).toEqual([
      { ...rows[0], populationFrequencies: [frequency] },
      { ...rows[1], populationFrequencies: [] },
    ]);
  });
  const allele = {
    id: 1,
    genesymbol: 'CYP2C19',
    name: '*2',
    definitionid: 4,
    version: 2,
    frequency: { group: null },
    inferredfrequency: true,
    findings: '\r\n ``` **source**  \n',
    allele_definition: { id: 4, genesymbol: 'CYP2C19', name: '*2', pharmvarid: null, version: 8 },
  };
  it('joins all frequency pages by exact gene and allele without synthesizing sparse values', async () => {
    const frequencies = Array.from({ length: 102 }, (_, index) => ({
      genesymbol: 'CYP2C19',
      name: '*2',
      population_group: `group${index}`,
      freq_weighted_avg: index === 0 ? null : 0.125,
      subjectcount: index === 0 ? null : 8,
    }));
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        requests.push(url);
        if (url.pathname.endsWith('/allele')) {
          expect(url.searchParams.get('select')).toBe('*,allele_definition(*)');
          expect(url.searchParams.get('name')).toBe('eq.*2');
          return source([allele]);
        }
        expect(url.pathname).toBe('/v1/population_frequency_view');
        expect(url.searchParams.get('name')).toBe('in.("*2")');
        const offset = Number(url.searchParams.get('offset'));
        return source(frequencies.slice(offset, offset + 101), frequencies.length, offset);
      }),
    );
    const output = assertTwin(
      await runToolContract(searchAllelesTool, {
        geneSymbol: ' cyp2c19 ',
        name: ' *2 ',
        clinicalFunctionalStatus: ' ',
      }),
    );
    expect(output.items).toEqual([{ ...allele, populationFrequencies: frequencies }]);
    expect(output).toMatchObject({
      truncated: false,
      shown: 1,
      cap: 25,
      effectiveQuery: { geneSymbol: 'CYP2C19', name: '*2', limit: 25, offset: 0 },
    });
    expect(requests).toHaveLength(3);
  });
  it.each([0, 10000])('initializes enrichment on an empty page at offset %i', async (offset) => {
    const fetch = vi.fn(async () =>
      offset === 0
        ? source([])
        : Response.json({ code: 'PGRST103' }, { status: 416, headers: { 'content-range': '*/3' } }),
    );
    vi.stubGlobal('fetch', fetch);
    const output = assertTwin(
      await runToolContract(searchAllelesTool, { geneSymbol: 'CYP2C19', name: '', offset }),
    );
    expect(output).toMatchObject({
      items: [],
      page: { offset, returned: 0, nextOffset: null, total: offset === 0 ? 0 : 3 },
      shown: 0,
      cap: 25,
      truncated: false,
    });
    expect(output.notices).toEqual([
      'No alleles matched. Call pgx_list_reference with topic genes to check gene coverage, or remove the clinicalFunctionalStatus filter in pgx_search_alleles.',
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('returns the full public cap and advertises a valid continuation', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...allele,
      id: index + 1,
      name: `*${index + 1}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        new URL(input).pathname.endsWith('/allele') ? source(rows, 101) : source([]),
      ),
    );
    const output = assertTwin(
      await runToolContract(searchAllelesTool, { geneSymbol: 'CYP2C19', limit: 100 }),
    );
    expect(output).toMatchObject({
      cap: 100,
      shown: 100,
      truncated: true,
      page: { returned: 100, nextOffset: 100 },
    });
    expect(output.items).toHaveLength(100);
    expect(searchAllelesTool.input.safeParse({ geneSymbol: 'CYP2C19', offset: 100 }).success).toBe(
      true,
    );
  });
  it('fails rather than dropping frequency evidence beyond 2000 rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(input);
        if (url.pathname.endsWith('/allele')) return source([allele]);
        const offset = Number(url.searchParams.get('offset'));
        return source(
          Array.from({ length: 101 }, (_, index) => ({
            genesymbol: 'CYP2C19',
            name: '*2',
            population_group: `g${offset + index}`,
          })),
          2001,
          offset,
        );
      }),
    );
    const result = await runToolContract(searchAllelesTool, { geneSymbol: 'CYP2C19' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'query_too_broad', cap: 2000 } },
    });
    expect(JSON.stringify(result.content)).not.toContain('"items"');
  });
});

describe.each([
  { tool: lookupDiplotypeTool, input: { geneSymbol: 'CYP2C19', diplotype: '*1/*2' } },
  { tool: searchAllelesTool, input: { geneSymbol: 'CYP2C19' } },
])('$tool.name declared errors', ({ tool, input }) => {
  it.each([
    ['invalid_selector', 0],
    ['upstream_query_rejected', 400],
    ['upstream_rate_limited', 429],
    ['upstream_unavailable', 503],
    ['query_too_broad', 200],
  ] as const)('returns %s and exact recovery on both surfaces', async (reason, status) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (status !== 200) return Response.json({ message: 'untrusted body' }, { status });
        const offset = Number(new URL(url).searchParams.get('offset'));
        const rows = Array.from({ length: 101 }, (_, index) =>
          tool.name === 'pgx_lookup_diplotype'
            ? { genesymbol: 'CYP2C19', diplotype: '*1/*2' }
            : {
                id: offset + index,
                genesymbol: 'CYP2C19',
                name: '*2',
                definitionid: 1,
                population_group: `g${offset + index}`,
              },
        );
        return source(rows, 2001, offset);
      }),
    );
    const pending = runToolContract(
      tool,
      reason === 'invalid_selector' ? { ...input, geneSymbol: ' ' } : input,
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    const entry = tool.errors?.find((entry) => entry.reason === reason);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: entry?.code, data: { reason, recovery: { hint: entry?.recovery } } },
    });
    expect(JSON.stringify(result.content)).toContain(entry?.recovery);
  });
  it('rejects schema-invalid fields before any network request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(tool, { ...input, geneSymbol: '' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
