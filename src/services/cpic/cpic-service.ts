/**
 * @fileoverview Bounded, request-scoped CPIC HTTP workflows with source provenance.
 * @module services/cpic/cpic-service
 */
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  requestCancelled,
  serializationError,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { buildCpicUrl, type CpicQuery } from './query.js';
import { type CpicEndpoint, type CpicRecord, recordSchemas } from './records.js';

const pacer = createPacer({ name: 'cpic', maxConcurrent: 3 });

/** Keep both header and body consumption under the attempt clock, without logging error bodies. */
async function request(
  requestUrl: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ text: string; headers: Headers }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = AbortSignal.any([controller.signal, signal]);
  try {
    const response = await fetch(requestUrl, {
      signal: combined,
      redirect: 'error',
      headers: { Accept: 'application/json', Prefer: 'count=exact' },
    });
    if (!response.ok)
      throw await httpErrorFromResponse(response, {
        service: 'CPIC',
        errorHeaders: ['content-range'],
      });
    return { text: await response.text(), headers: response.headers };
  } catch (error) {
    if (signal.aborted) {
      if (signal.reason instanceof Error && signal.reason.name === 'TimeoutError') {
        throw timeout('CPIC workflow deadline exceeded.', { errorSource: 'FetchSignalTimeout' });
      }
      throw requestCancelled('CPIC request cancelled.');
    }
    if (controller.signal.aborted)
      throw timeout('CPIC request timed out.', { errorSource: 'FetchTimeout' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
/** Public page metadata, using only real source counts. */
export interface CpicPageInfo {
  limit: number;
  nextOffset: number | null;
  offset: number;
  returned: number;
  total: number | null;
}
/** A validated source page and the exact URL that produced it. */
export interface CpicPage<E extends CpicEndpoint> {
  items: CpicRecord<E>[];
  page: CpicPageInfo;
  requestUrl: string;
}
/** Source versions identify returned records by RFC 6901 JSON Pointer. */
export interface CpicRowVersion {
  path: string;
  requestIndex: number;
  version: number;
}
/** Public data provenance; request URLs belong in responses, never logs. */
export interface CpicProvenance {
  accessedAt: string;
  apiVersion: 'v1';
  licenseUrl: string;
  policyUrl: string;
  primarySourceUrl: 'https://www.clinpgx.org/';
  requestUrls: string[];
  rowVersions: CpicRowVersion[];
  source: 'CPIC Database';
}

/** Explicit scan/attempt bounds fail rather than returning incomplete results. */
export function queryTooBroad(cap: number): McpError {
  return validationError('CPIC lookup exceeded its bounded work budget.', {
    reason: 'query_too_broad',
    retryable: false,
    cap,
  });
}

function contentRange(value: string | null): { total: number | null; start: number | null } {
  const match = value?.match(/^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/);
  if (!match) return { total: null, start: null };
  const total = match[3] === '*' ? null : Number(match[3]);
  const start = match[1] === undefined ? null : Number(match[1]);
  if (
    (total !== null && !Number.isSafeInteger(total)) ||
    (start !== null && !Number.isSafeInteger(start))
  ) {
    throw serializationError('CPIC returned an invalid row range.', { retryable: false });
  }
  return { total, start };
}

function pastEnd(error: unknown): number | undefined {
  if (!(error instanceof McpError) || error.data?.status !== 416) return;
  const headers = error.data.headers;
  if (typeof headers !== 'object' || headers === null || !('content-range' in headers)) return;
  const range = headers['content-range'];
  if (typeof range !== 'string' || !/^\*\/\d+$/.test(range)) return;
  const body = error.data.body;
  if (typeof body !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('code' in parsed) ||
    parsed.code !== 'PGRST103'
  )
    return;
  return contentRange(range).total ?? undefined;
}

/** Classify upstream failures without retaining source bodies, query text or causes. */
function classify(error: unknown): McpError {
  if (!(error instanceof McpError)) {
    return serviceUnavailable('CPIC could not complete the request.', {
      reason: 'upstream_unavailable',
      retryable: true,
    });
  }
  if (error.code === JsonRpcErrorCode.RequestCancelled) return error;
  if (error.code === JsonRpcErrorCode.Timeout && error.data?.status === undefined) return error;
  const status = error.data?.status;
  const retryAfter = error.data?.retryAfter;
  const safe = {
    ...(typeof status === 'number' && { status }),
    ...(typeof retryAfter === 'string' && { retryAfter }),
  };
  if (error.code === JsonRpcErrorCode.Timeout)
    return timeout('CPIC timed out while processing the request.', { ...safe, retryable: true });
  if (status === 400)
    return invalidParams('CPIC rejected the generated query.', {
      ...safe,
      reason: 'upstream_query_rejected',
      retryable: false,
    });
  if (status === 429)
    return rateLimited('CPIC rate limited the request.', {
      ...safe,
      reason: 'upstream_rate_limited',
      retryable: true,
    });
  if (status === 401 || status === 403)
    return new McpError(error.code, 'CPIC denied access to its public endpoint.', {
      ...safe,
      retryable: false,
    });
  if (status === 404 || (typeof status === 'number' && status >= 500)) {
    return serviceUnavailable('CPIC endpoint is unavailable.', {
      ...safe,
      reason: 'upstream_unavailable',
      retryable: status !== 404 && status !== 501,
    });
  }
  if (typeof status === 'number')
    return new McpError(error.code, 'CPIC rejected the request.', { ...safe, retryable: false });
  if (
    error.data?.reason === 'query_too_broad' ||
    error.code === JsonRpcErrorCode.SerializationError ||
    error.data?.reason === 'invalid_selector'
  )
    return error;
  return serviceUnavailable('CPIC could not complete the request.', {
    reason: 'upstream_unavailable',
    retryable: true,
  });
}

/** One tool invocation's shared clock, HTTP-attempt count and provenance. */
export class CpicWorkflow {
  private attempts = 0;
  private readonly urls = new Set<string>();
  private readonly origins = new WeakMap<object, string>();
  private readonly accessedAt = new Date().toISOString();

  constructor(
    private readonly ctx: Context,
    private readonly signal: AbortSignal,
    private readonly expiresAt: number,
  ) {}

  /** Snapshot provenance after all of the workflow's source calls finish. */
  provenance(value?: unknown): CpicProvenance {
    const requestUrls = [...this.urls];
    const rowVersions: CpicRowVersion[] = [];
    const visit = (current: unknown, path: string): void => {
      if (typeof current !== 'object' || current === null) return;
      const origin = this.origins.get(current);
      if (origin && 'version' in current && typeof current.version === 'number')
        rowVersions.push({
          path,
          requestIndex: requestUrls.indexOf(origin),
          version: current.version,
        });
      for (const [key, nested] of Object.entries(current)) {
        if (path === '' && key === 'provenance') continue;
        visit(nested, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
      }
    };
    visit(value, '');
    return {
      source: 'CPIC Database',
      primarySourceUrl: 'https://www.clinpgx.org/',
      apiVersion: 'v1',
      accessedAt: this.accessedAt,
      requestUrls,
      licenseUrl: 'https://github.com/cpicpgx/cpic-data/blob/master/LICENSE.md',
      policyUrl: 'https://www.clinpgx.org/page/dataUsagePolicy',
      rowVersions,
    };
  }

  /** Preserve source origin when adding joined evidence to a source record. */
  join<T extends object, U extends object>(record: T, additions: U): T & U {
    const joined = { ...record, ...additions };
    const origin = this.origins.get(record);
    if (origin) this.origins.set(joined, origin);
    return joined;
  }

  private remember(value: unknown, requestUrl: string): void {
    if (typeof value !== 'object' || value === null) return;
    this.origins.set(value, requestUrl);
    for (const nested of Object.values(value)) this.remember(nested, requestUrl);
  }

  /** Fetch one page, probing one extra row when the source omits an exact count. */
  async page<E extends CpicEndpoint>(endpoint: E, query: CpicQuery = {}): Promise<CpicPage<E>> {
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw validationError('CPIC public pages are limited to 100 rows.', {
        reason: 'invalid_selector',
        retryable: false,
      });
    const requestUrl = buildCpicUrl(endpoint, { ...query, limit: limit + 1 });
    this.urls.add(requestUrl);
    const remaining = this.expiresAt - Date.now();
    if (remaining <= 0)
      throw timeout('CPIC workflow deadline exceeded.', {
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
      });
    const result = await withRetry(
      async ({ signal, remainingMs }) =>
        pacer.run(
          async () => {
            const attemptBudget = Math.min(10_000, remainingMs, this.expiresAt - Date.now());
            if (attemptBudget <= 0)
              throw timeout('CPIC workflow deadline exceeded.', {
                reason: 'retry_deadline_exceeded',
                deadlineMs: 45_000,
              });
            if (this.attempts >= 100) throw queryTooBroad(100);
            this.attempts++;
            try {
              const response = await request(requestUrl, attemptBudget, signal);
              const text = response.text;
              if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(text)) {
                throw serviceUnavailable('CPIC returned a maintenance page.', {
                  reason: 'upstream_unavailable',
                  retryable: true,
                });
              }
              let json: unknown;
              try {
                json = JSON.parse(text);
              } catch {
                throw serializationError('CPIC returned malformed JSON.', { retryable: false });
              }
              const parsed = recordSchemas[endpoint].array().safeParse(json);
              if (!parsed.success)
                throw serializationError('CPIC returned an incompatible record shape.', {
                  retryable: false,
                });
              const range = contentRange(response.headers.get('content-range'));
              if (range.start !== null && range.start !== offset)
                throw serializationError('CPIC returned a different page offset.', {
                  retryable: false,
                });
              // Generic schema lookup is validated above; the endpoint fixes the record type.
              return { rows: parsed.data as CpicRecord<E>[], total: range.total };
            } catch (error) {
              const total = pastEnd(error);
              if (total !== undefined && offset >= total)
                return { rows: [] as CpicRecord<E>[], total };
              throw classify(error);
            }
          },
          { signal },
        ),
      {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        operation: 'CPIC request',
        context: this.ctx,
        signal: this.signal,
        deadlineMs: remaining,
      },
    );
    const items = result.rows.slice(0, limit);
    this.remember(items, requestUrl);
    const next = offset + items.length;
    const more = result.total === null ? result.rows.length > limit : next < result.total;
    const nextOffset = more && Number.isSafeInteger(next) && next > offset ? next : null;
    if (more && nextOffset === null)
      throw serializationError('CPIC page cannot advance safely.', { retryable: false });
    return {
      items,
      page: { limit, offset, returned: items.length, total: result.total, nextOffset },
      requestUrl,
    };
  }

  /** Read an exact source count, scanning only when count metadata is unavailable. */
  async count<E extends CpicEndpoint>(
    endpoint: E,
    query: Omit<CpicQuery, 'limit' | 'offset'> = {},
  ): Promise<number> {
    const first = await this.page(endpoint, { ...query, limit: 1 });
    if (first.page.total !== null) return first.page.total;
    if (first.page.nextOffset === null) return first.items.length;
    return (await this.scan(endpoint, query)).length;
  }

  /** Exhaust a bounded related list; overflow fails instead of dropping source rows. */
  async scan<E extends CpicEndpoint>(
    endpoint: E,
    query: Omit<CpicQuery, 'limit' | 'offset'> = {},
    cap = 2000,
  ): Promise<CpicRecord<E>[]> {
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 2000)
      throw validationError('Invalid CPIC scan cap.', {
        reason: 'invalid_selector',
        retryable: false,
      });
    const items: CpicRecord<E>[] = [];
    let offset = 0;
    for (;;) {
      const result = await this.page(endpoint, {
        ...query,
        offset,
        limit: Math.min(100, cap - items.length),
      });
      items.push(...result.items);
      if (result.page.nextOffset === null) return items;
      if (items.length >= cap) throw queryTooBroad(cap);
      offset = result.page.nextOffset;
    }
  }
}

/** CPIC workflow entry point; every tool call must use one workflow. */
export class CpicService {
  /** Bound the complete tool workflow, including all requests, queues and retries. */
  workflow<T>(ctx: Context, run: (workflow: CpicWorkflow) => Promise<T>): Promise<T> {
    return withRetry(
      async ({ signal }) => {
        const workflow = new CpicWorkflow(ctx, signal, Date.now() + 45_000);
        const result = await run(workflow);
        if (typeof result === 'object' && result !== null && 'provenance' in result)
          result.provenance = workflow.provenance(result);
        return result;
      },
      {
        maxRetries: 0,
        signal: ctx.signal,
        deadlineMs: 45_000,
        operation: 'CPIC workflow',
        context: ctx,
      },
    );
  }
}
let service: CpicService | undefined;
/** Initialize once from createApp setup; no storage or host configuration. */
export function initCpicService(): void {
  service ??= new CpicService();
}
/** Access the initialized service from a tool handler. */
export function getCpicService(): CpicService {
  if (!service) throw new Error('CpicService not initialized — call initCpicService() in setup().');
  return service;
}
/** Release queued HTTP work during application shutdown. */
export function disposeCpicService(): void {
  pacer.dispose();
}
