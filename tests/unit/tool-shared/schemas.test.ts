/**
 * @fileoverview Shared input primitives preserve blank forms and safe paging bounds.
 * @module tests/unit/tool-shared/schemas.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  atcIdSchema,
  optionalText,
  paginationFields,
  recommendationPaginationFields,
  rxnormIdSchema,
} from '@/mcp-server/tools/shared/schemas.js';
import { buildCpicUrl } from '@/services/cpic/query.js';
import { recordSchemas } from '@/services/cpic/records.js';

describe('shared input boundaries', () => {
  it.each([
    { schema: rxnormIdSchema, prefix: 'RxNorm', codes: ['32968'] },
    { schema: atcIdSchema, prefix: 'ATC', codes: ['B01AC04', 'b01ac04'] },
  ])('advertises the runtime casing contract for $prefix', ({ schema, prefix, codes }) => {
    const pattern = z.toJSONSchema(schema).pattern;
    expect(pattern).toBeTypeOf('string');
    const advertised = new RegExp(pattern!);
    const prefixes = Array.from({ length: 2 ** prefix.length }, (_, mask) =>
      [...prefix]
        .map((char, i) => (mask & (1 << i) ? char.toUpperCase() : char.toLowerCase()))
        .join(''),
    );
    for (const code of codes)
      for (const label of ['', ...prefixes.map((value) => `${value}:`)])
        for (const whitespace of ['', ' \t', '\r\n']) {
          const value = `${whitespace}${label}${code}${whitespace}`;
          expect(advertised.test(value), value).toBe(true);
          expect(schema.safeParse(value).success, value).toBe(true);
        }
    for (const value of [
      '',
      ' \r\n ',
      '!',
      ' RxNorm:12x ',
      'ATC:B01AC041',
      'ATC:',
      'rxnorm:',
      '1\n2',
      ' ATC:B01AC04! ',
    ])
      expect(advertised.test(value), value).toBe(schema.safeParse(value).success);
  });
  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
    'keeps runtime source integer validation for %s',
    (id) => {
      expect(recordSchemas.guideline.safeParse({ id, name: 'G' }).success).toBe(false);
      expect(recordSchemas.guideline.safeParse({ id: 1, name: 'G', version: id }).success).toBe(
        false,
      );
    },
  );
  it('advertises unconstrained source integers without safe-range metadata', () => {
    const schema = z.toJSONSchema(recordSchemas.guideline);
    expect(schema.properties?.id).toEqual({
      type: 'integer',
      description: 'Source record identifier.',
    });
    expect(JSON.stringify(schema.properties?.version)).not.toContain('9007199254740991');
    expect(z.toJSONSchema(paginationFields.limit)).toMatchObject({
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });
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
    expect(recommendationPaginationFields.limit.parse(51)).toBe(51);
    expect(paginationFields.offset.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])(
    'rejects invalid caller limit %s at the shared schema seam',
    (limit) => {
      expect(paginationFields.limit.safeParse(limit).success).toBe(false);
      expect(recommendationPaginationFields.limit.safeParse(limit).success).toBe(false);
    },
  );
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
