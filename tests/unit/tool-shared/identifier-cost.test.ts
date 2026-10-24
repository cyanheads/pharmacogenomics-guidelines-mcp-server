/** @fileoverview CPU bounds for the advertised identifier patterns over adversarial caller text.
 * @module tests/unit/tool-shared/identifier-cost.test
 */
import { threadCpuUsage } from 'node:process';
import { z } from '@cyanheads/mcp-ts-core';
import { expect, it } from 'vitest';
import { atcIdSchema, rxnormIdSchema } from '@/mcp-server/tools/shared/schemas.js';

it.each([
  { name: 'RxNorm', schema: rxnormIdSchema },
  { name: 'ATC', schema: atcIdSchema },
])('bounds $name identifier rejection across 64x input growth', ({ name, schema }) => {
  const regex = new RegExp(z.toJSONSchema(schema).pattern!);
  const shapes = [
    (n: number) => `${' '.repeat(n)}!`,
    (n: number) => `${' '.repeat(n)}123!`,
    (n: number) => `${'1'.repeat(n)}!`,
    (n: number) => `${' '.repeat(n)}!\n`,
    (n: number) => `${'\n '.repeat(n)}!`,
  ];
  for (const [shape, input] of shapes.entries()) {
    // Warm every measured length before collecting CPU samples across the same tier.
    const values = Array.from({ length: 7 }, (_, i) => input(5000 * 2 ** i));
    for (let warm = 0; warm < 20; warm++) for (const value of values) regex.test(value);
    const samples = values.map((value, i) => {
      const before = threadCpuUsage();
      for (let repeat = 0; repeat < 16; repeat++) expect(regex.test(value)).toBe(false);
      const elapsed = threadCpuUsage(before);
      const cpuUs = elapsed.user + elapsed.system;
      expect(cpuUs, `${name} shape ${shape}, length ${5000 * 2 ** i}`).toBeLessThan(150_000);
      return cpuUs;
    });
    expect(samples[6]! / Math.max(1, samples[0]!)).toBeLessThan(256);
    console.info(
      JSON.stringify({
        identifier: name,
        shape,
        lengths: values.map((value) => value.length),
        cpuUs: samples,
      }),
    );
  }
});
