/**
 * @fileoverview Render complete JSON payloads and clickable source URL occurrences.
 * @module mcp-server/tools/shared/lossless-renderer
 */

import { markdown } from '@cyanheads/mcp-ts-core/utils';

function embeddedUrl(candidate: string): string {
  let url = candidate.replace(/[.,;:!?]+$/, '');
  const brackets: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  while (url.length > 0) {
    const closing = url.at(-1) as string;
    const opening = brackets[closing];
    if (!opening) break;
    const opens = [...url].filter((character) => character === opening).length;
    const closes = [...url].filter((character) => character === closing).length;
    if (closes <= opens) break;
    url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return url;
}

/** Render JSON without changing source strings, with path-labelled HTTP links. */
export function renderLossless(value: unknown, path = '$'): string {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new TypeError('The rendered value must be JSON-serializable.');
  const result = markdown().codeBlock(json, 'json');
  const linked = new Set<string>();

  function visit(current: unknown, currentPath: string): void {
    if (typeof current === 'string') {
      for (const [index, match] of [...current.matchAll(/https?:\/\/[^\s<>"`]+/g)].entries()) {
        const destination = match[0] === current ? match[0] : embeddedUrl(match[0]);
        if (linked.has(destination)) continue;
        linked.add(destination);
        result
          .blankLine()
          .link(`${currentPath} [${index + 1}]`, destination)
          .blankLine();
      }
    } else if (Array.isArray(current)) {
      current.forEach((entry: unknown, index: number) => {
        visit(entry, `${currentPath}[${index}]`);
      });
    } else if (current !== null && typeof current === 'object') {
      for (const [key, entry] of Object.entries(current)) {
        const entryPath = `${currentPath}[${JSON.stringify(key)}]`;
        visit(key, `${entryPath} (key)`);
        visit(entry, entryPath);
      }
    }
  }

  visit(value, path);
  return result.build();
}

/** Adapt the lossless renderer to a tool's text content format callback. */
export function formatLossless(value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: renderLossless(value) }];
}
