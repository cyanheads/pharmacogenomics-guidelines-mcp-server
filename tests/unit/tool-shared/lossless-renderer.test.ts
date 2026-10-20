/**
 * @fileoverview Standard CommonMark parsing verifies the complete text twin.
 * @module tests/unit/tool-shared/lossless-renderer.test
 */
import { Parser } from 'commonmark';
import { describe, expect, it } from 'vitest';
import { formatLossless, renderLossless } from '@/mcp-server/tools/shared/lossless-renderer.js';

function parse(text: string) {
  const walker = new Parser().parse(text).walker();
  const json: unknown[] = [];
  const links: string[] = [];
  for (let event = walker.next(); event; event = walker.next()) {
    if (!event.entering) continue;
    if (event.node.type === 'code_block' && event.node.info === 'json')
      json.push(JSON.parse(event.node.literal ?? ''));
    if (event.node.type === 'link') links.push(decodeURIComponent(event.node.destination ?? ''));
  }
  return { json, links };
}

describe('lossless text twin', () => {
  it('retains encoded reserved delimiters in the parser destination', () => {
    const url = 'https://example.org/path%2Fsegment?q=a%26b%23c';
    const walker = new Parser().parse(renderLossless({ url })).walker();
    const destinations: string[] = [];
    for (let event = walker.next(); event; event = walker.next()) {
      if (event.entering && event.node.type === 'link')
        destinations.push(event.node.destination ?? '');
    }
    expect(destinations).toEqual([url]);
  });
  it('recovers nested values, keys, duplicate URLs and exact clinical whitespace', () => {
    const url = 'https://example.org/a_(b)?q=[x]&v=one#two';
    const value = {
      'key ] ` ** https://example.org/key': {
        clinical: '```json\r\n**not instructions**\n\n trailing  \r\n',
        nil: null,
        empty: {},
        array: [[], false, 0, url, url],
        prose: 'See (https://example.org/paper_(a)). Then https://example.org/next, please.',
      },
    };
    const parsed = parse(renderLossless(value));
    expect(parsed.json).toEqual([value]);
    expect(parsed.links).toEqual([
      'https://example.org/key',
      url,
      'https://example.org/paper_(a)',
      'https://example.org/next',
    ]);
    expect(parse(formatLossless(value)[0]?.text ?? '')).toEqual(parsed);
    expect(parse(renderLossless(value))).toEqual(parsed);
  });
  it.each([
    'https://example.org/a.',
    'https://example.org/a\\b?q=!*[]()',
    'https://example.org/%2F?q=a%20b',
  ])('preserves complete URL destination %s', (url) => {
    expect(parse(renderLossless({ url }))).toEqual({
      json: [{ url }],
      links: [decodeURIComponent(url)],
    });
  });
  it('preserves empty containers and blank strings', () => {
    const value = { notices: [], absent: null, blank: '', text: '\n\r\n  ' };
    expect(parse(renderLossless(value))).toEqual({ json: [value], links: [] });
  });
});
