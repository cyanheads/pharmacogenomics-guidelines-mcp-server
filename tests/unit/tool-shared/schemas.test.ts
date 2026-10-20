/**
 * @fileoverview Shared input primitives preserve blank forms and safe paging bounds.
 * @module tests/unit/tool-shared/schemas.test
 */
import { describe, expect, it } from 'vitest';
import {
  atcIdSchema,
  optionalText,
  paginationFields,
  recommendationPaginationFields,
  rxnormIdSchema,
} from '@/mcp-server/tools/shared/schemas.js';
import { buildCpicUrl } from '@/services/cpic/query.js';

describe('shared input boundaries', () => {
  it.each([rxnormIdSchema, atcIdSchema])(
    'rejects long malformed identifiers promptly',
    (schema) => {
      const started = performance.now();
      expect(schema.safeParse(' '.repeat(60_000) + '!').success).toBe(false);
      expect(performance.now() - started).toBeLessThan(250);
      expect(schema.parse(' '.repeat(60_000))).toBe(' '.repeat(60_000));
    },
  );
  it('accepts optional form blanks and trims only caller text', () => {
    expect(optionalText(' \r\n ')).toBeUndefined();
    expect(optionalText(' HLA-B ')).toBe('HLA-B');
    expect(rxnormIdSchema.parse(' RxNorm:123 ')).toBe(' RxNorm:123 ');
    expect(rxnormIdSchema.safeParse('12x').success).toBe(false);
    expect(atcIdSchema.safeParse(' ATC:B01AC04 ').success).toBe(true);
    expect(atcIdSchema.safeParse('B01AC041').success).toBe(false);
  });
  it('defaults list pages and accepts safe offsets without an invented ceiling', () => {
    expect(paginationFields.limit.parse(undefined)).toBe(25);
    expect(recommendationPaginationFields.limit.parse(undefined)).toBe(10);
    expect(recommendationPaginationFields.limit.safeParse(51).success).toBe(false);
    expect(paginationFields.offset.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([
    { limit: 0 },
    { limit: 102 },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 1.5 },
  ])('rejects invalid network page bounds %j', (query) => {
    expect(() => buildCpicUrl('gene', query)).toThrow();
  });
  it('rejects arbitrary filter columns and genotype on an unrelated endpoint', () => {
    expect(() =>
      buildCpicUrl('gene', { filters: [{ column: 'or', operator: 'eq', value: 'x' }] }),
    ).toThrow();
    expect(() => buildCpicUrl('gene', { diplotypeLookup: {} })).toThrow();
  });
});
