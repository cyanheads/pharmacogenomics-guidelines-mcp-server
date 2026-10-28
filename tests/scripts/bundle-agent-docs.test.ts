/**
 * @fileoverview The bundle cleaner and the packaging check select the same
 * dependency agent docs: package-root skill trees and stray `SKILL.md` files go,
 * while runtime modules under a nested `skills/` directory (the MCP SDK's
 * `dist/ext/skills/`) stay, or the cleaned `.mcpb` fails to start.
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

/**
 * Loaded by URL at run time: `lint-packaging.ts` holds a repository-only
 * fallback import that a static import would pull into this project's `tsc`
 * program (cyanheads/mcp-ts-core#797).
 */
const lintPackagingUrl = new URL('../../scripts/lint-packaging.ts', import.meta.url).href;
const lintPackaging: Record<string, unknown> = await import(lintPackagingUrl);
const lintAgentDocEntry = lintPackaging.AGENT_DOC_ENTRY;
if (!(lintAgentDocEntry instanceof RegExp)) {
  throw new TypeError('scripts/lint-packaging.ts must export AGENT_DOC_ENTRY as a RegExp.');
}

const runtimeEntries = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/some-pkg/lib/skills/loader.js',
  'node_modules/@acme/skills/index.js',
  'node_modules/skills/index.js',
];

const agentDocEntries = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/api-utils/references/formatting.md',
  'node_modules/some-pkg/skills/review/SKILL.md',
  'node_modules/some-pkg/skills/review/references/checklist.md',
  'node_modules/some-pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/guide.md',
  'node_modules/some-pkg/node_modules/@scope/pkg/skills/guide/SKILL.md',
  'node_modules/some-pkg/node_modules/other-pkg/.claude/commands/run.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it('keeps the cleaner and the packaging check identical', () => {
    expect(String(lintAgentDocEntry)).toBe(String(AGENT_DOC_ENTRY));
  });

  it.each(runtimeEntries)('retains runtime entry %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([]);
    expect(lintAgentDocEntry.test(entry)).toBe(false);
  });

  it.each(agentDocEntries)('strips agent doc %s', (entry) => {
    expect(filterAgentDocEntries([entry])).toEqual([entry]);
    expect(lintAgentDocEntry.test(entry)).toBe(true);
  });
});
