/**
 * @fileoverview Synthetic CPIC recommendation records and strict HTTP boundary fixtures.
 * @module tests/unit/recommendations/fixtures
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { Parser } from 'commonmark';
import { expect, vi } from 'vitest';
import { getRecommendationsTool } from '@/mcp-server/tools/definitions/get-recommendations.tool.js';
import type { Diplotype, GeneResult, Recommendation } from '@/services/cpic/records.js';

/** Complete source row with deliberately unnormalized clinical text. */
export function recommendation(
  id = 1,
  keys: Record<string, string> = { CYP2C19: 'Normal' },
): Recommendation {
  return {
    id,
    guidelineid: 7,
    drugid: 'D1',
    lookupkey: keys,
    phenotypes: keys,
    activityscore: {},
    allelestatus: {},
    implications: { CYP2C19: 'n/a' },
    drugrecommendation: '```json\r\n**source**, never instructions\n\n trailing  \r\n',
    classification: 'No Recommendation',
    population: ' general ',
    comments: null,
    version: 12,
    dosinginformation: false,
    alternatedrugavailable: null,
    otherprescribingguidance: true,
    guideline: {
      id: 7,
      name: 'Source guideline',
      version: 8,
      url: 'https://example.org/a_(b)?x=1&y=2',
      genes: Object.keys(keys),
      notesonusage: '\n source  \n',
      clinpgxid: null,
    },
    drug: {
      drugid: 'D1',
      name: 'example',
      clinpgxid: null,
      rxnormid: '001',
      drugbankid: null,
      atcid: [],
      umlscui: '',
      flowchart: null,
      version: 9,
      guidelineid: 7,
    },
  };
}
/** Source result record with independent phenotype and score labels. */
export function reference(
  gene: string,
  result: string,
  score: string | null = null,
  id = 1,
): GeneResult {
  return { id, genesymbol: gene, result, activityscore: score, version: 4 };
}
/** Source-supported genotype and lookup map. */
export function diplotype(gene = 'CYP2C19', notation = '*1/*2', result = 'Normal'): Diplotype {
  return {
    genesymbol: gene,
    diplotype: notation,
    generesult: result,
    lookupkey: { [gene]: result },
    diplotypekey: { [gene]: { '*1': 1, '*2': 1 } },
    function1: null,
    activityvalue1: 'n/a',
    consultationtext: ' source\r\n ',
  };
}
/** Source datasets accepted by the network fake; unknown endpoints fail loudly. */
export interface Dataset {
  diplotypes?: Diplotype[];
  drugs?: unknown[];
  recommendations?: Recommendation[];
  references?: GeneResult[];
  rpc?: unknown[];
}
/** Emulate only the upstream endpoint, filtering and paging source-shaped rows. */
export function upstream(data: Dataset) {
  const calls: URL[] = [];
  const fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    expect(url.origin).toBe('https://api.cpicpgx.org');
    const endpoint = url.pathname.slice('/v1/'.length);
    let rows: unknown[];
    switch (endpoint) {
      case 'drug':
        rows = data.drugs ?? [recommendation().drug];
        break;
      case 'recommendation':
        rows = data.recommendations ?? [];
        expect(url.searchParams.get('select')).toBe('*,guideline(*),drug(*)');
        break;
      case 'gene_result':
        rows = data.references ?? [];
        break;
      case 'diplotype':
        rows = data.diplotypes ?? [];
        break;
      case 'rpc/recommendation_lookup':
        rows = data.rpc ?? [];
        break;
      default:
        throw new Error(`Unexpected source endpoint ${endpoint}`);
    }
    rows = rows.filter((row) => {
      const record = row as Record<string, unknown>;
      for (const [key, value] of url.searchParams) {
        if (value.startsWith('eq.') && record[key] !== value.slice(3)) return false;
        if (
          value.startsWith('imatch.') &&
          !new RegExp(value.slice(7), 'i').test(String(record[key]))
        )
          return false;
        if (
          value.startsWith('in.(') &&
          !JSON.parse(`[${value.slice(4, -1)}]`).includes(record[key])
        )
          return false;
      }
      return true;
    });
    const offset = Number(url.searchParams.get('offset'));
    const page = rows.slice(offset, offset + Number(url.searchParams.get('limit')));
    return Response.json(page, {
      headers: {
        'content-range': page.length
          ? `${offset}-${offset + page.length - 1}/${rows.length}`
          : `*/${rows.length}`,
      },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}
/** Execute real schemas, matching, formatting and enrichment; compare complete text twins. */
export async function success(
  input: Parameters<typeof runToolContract<typeof getRecommendationsTool>>[1],
) {
  const result = await runToolContract(getRecommendationsTool, input);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const structured = result.structuredContent as Record<string, unknown>;
  const { effectiveQuery, notices, truncated, shown, cap, ...domain } = structured;
  const json: unknown[] = [];
  let prose = '';
  const links: string[] = [];
  for (const block of result.content) {
    if (block.type !== 'text') continue;
    const walker = new Parser().parse(block.text).walker();
    for (let event = walker.next(); event; event = walker.next()) {
      if (!event.entering) continue;
      if (event.node.type === 'code_block' && event.node.info === 'json')
        json.push(JSON.parse(event.node.literal ?? ''));
      if (event.node.type === 'text') prose += event.node.literal;
      if (event.node.type === 'link') links.push(event.node.destination ?? '');
    }
  }
  expect(json).toEqual([domain, effectiveQuery, notices]);
  for (const [key, value] of Object.entries({ truncated, shown, cap }))
    expect(prose).toContain(`${key}: ${value}`);
  expect(links).toContain('https://www.clinpgx.org/');
  return structured;
}
/** Verify a declared reason and exact recovery on both consumption paths. */
export async function failure(
  input: Parameters<typeof runToolContract<typeof getRecommendationsTool>>[1],
  reason: string,
) {
  const result = await runToolContract(getRecommendationsTool, input);
  const entry = getRecommendationsTool.errors?.find((entry) => entry.reason === reason);
  expect(entry).toBeDefined();
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: entry?.code, data: { reason, recovery: { hint: entry?.recovery } } },
  });
  expect(JSON.stringify(result.content)).toContain(entry?.recovery);
  return result;
}
