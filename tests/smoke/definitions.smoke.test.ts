/**
 * @fileoverview Smoke coverage for the retained scaffold echo tool.
 * @module tests/smoke/definitions.smoke.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { echoTool } from '@/mcp-server/tools/definitions/echo.tool.js';

describe('scaffold definition smoke test', () => {
  it('executes and formats the shipped echo tool', async () => {
    const ctx = createMockContext({ errors: echoTool.errors });
    const result = await echoTool.handler(echoTool.input.parse({ message: 'smoke' }), ctx);

    expect(result).toEqual({ message: 'smoke' });
    expect(echoTool.format?.(result)).toEqual([{ type: 'text', text: 'smoke' }]);
  });
});
