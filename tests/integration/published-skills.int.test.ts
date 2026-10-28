/**
 * @fileoverview The server entry serves its root `skills/` tree over the MCP
 * Skills extension: launched over stdio from an unrelated working directory, it
 * lists the published guide as a resource, advertises the `skill://{+path}`
 * template, and returns the file's exact bytes on read.
 * @module tests/integration/published-skills.int.test
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Reply {
  error?: { code: number; message: string };
  id: number;
  result?: Record<string, unknown>;
}

const ENTRY = fileURLToPath(new URL('../../src/index.ts', import.meta.url));
const SKILL_FILE = fileURLToPath(
  new URL('../../skills/pharmacogenomics-guidelines-guide/SKILL.md', import.meta.url),
);
const SKILL_URI = 'skill://pharmacogenomics-guidelines-guide/SKILL.md';

/**
 * Spawns the source entry on Bun (it resolves the `@/` alias) from `cwd`,
 * completes the handshake, sends each request, then ends stdin and waits for
 * the exit. A child that outlives the window is killed by its own PID.
 */
async function stdioSession(cwd: string, requests: Array<[string, Record<string, unknown>?]>) {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('MCP_') && !key.startsWith('OTEL_') && key !== 'LOGS_DIR') env[key] = value;
  }
  const child = spawn('bun', [ENTRY], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, MCP_TRANSPORT_TYPE: 'stdio', LOGS_DIR: join(cwd, 'logs') },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stderr = '';
  let buffered = '';
  const waiters = new Map<number, (reply: Reply) => void>();
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf('\n'); at !== -1; at = buffered.indexOf('\n')) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Reply;
      if (typeof message.id === 'number') waiters.get(message.id)?.(message);
    }
  });
  const exited = new Promise<void>((settle) => child.once('exit', () => settle()));
  const send = (id: number, method: string, params: Record<string, unknown> = {}) =>
    new Promise<Reply>((settle, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no reply to ${method}:\n${stderr}`)),
        15_000,
      );
      waiters.set(id, (reply) => {
        clearTimeout(timer);
        settle(reply);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    const handshake = await send(0, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'published-skills-int', version: '0.0.0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const replies: Reply[] = [];
    for (const [index, [method, params]] of requests.entries()) {
      replies.push(await send(index + 1, method, params));
    }
    return { handshake, replies };
  } finally {
    child.stdin.end();
    const timeout = setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null) process.kill(child.pid);
    }, 10_000);
    await exited;
    clearTimeout(timeout);
  }
}

describe('published skills over stdio', () => {
  let cwd: string;
  let session: Awaited<ReturnType<typeof stdioSession>>;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'pgx-skills-int-'));
    session = await stdioSession(cwd, [
      ['resources/list'],
      ['resources/templates/list'],
      ['resources/read', { uri: SKILL_URI }],
    ]);
  });

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('advertises the Skills extension', () => {
    expect(session.handshake.result?.capabilities).toHaveProperty([
      'extensions',
      'io.modelcontextprotocol/skills',
    ]);
  });

  it('lists the guide among resources', () => {
    const [list] = session.replies;
    expect(list?.result?.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: SKILL_URI, mimeType: 'text/markdown' }),
      ]),
    );
  });

  it('advertises the skill:// resource template', () => {
    const [, templates] = session.replies;
    expect(templates?.result?.resourceTemplates).toEqual(
      expect.arrayContaining([expect.objectContaining({ uriTemplate: 'skill://{+path}' })]),
    );
  });

  it('reads back the exact bytes of the published SKILL.md', () => {
    const [, , read] = session.replies;
    const contents = read?.result?.contents as Array<{ uri: string; text?: string }> | undefined;
    expect(contents).toHaveLength(1);
    expect(contents?.[0]?.uri).toBe(SKILL_URI);
    expect(Buffer.from(contents?.[0]?.text ?? '', 'utf8').equals(readFileSync(SKILL_FILE))).toBe(
      true,
    );
  });
});
