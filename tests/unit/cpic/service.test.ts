/**
 * @fileoverview Real CPIC workflow behavior with the outbound fetch boundary faked.
 * @module tests/unit/cpic/service.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { ErrorHandler, logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CpicService } from '@/services/cpic/cpic-service.js';
import { recordSchemas } from '@/services/cpic/records.js';
import { sanitizeLogBindings } from '../../../node_modules/@cyanheads/mcp-ts-core/dist/utils/internal/logger.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const service = new CpicService();

describe('CPIC workflow paging', () => {
  it('follows two exact-count pages and captures nested row versions', async () => {
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Prefer: 'count=exact' });
      const offset = Number(new URL(input).searchParams.get('offset'));
      return Response.json(
        offset === 0
          ? [{ id: 1, version: 2, guideline: { id: 3, name: 'G', version: 4 } }, { id: 2 }]
          : [{ id: 3 }],
        { status: 206, headers: { 'content-range': offset === 0 ? '0-1/3' : '2-2/3' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    await service.workflow(createMockContext(), async (workflow) => {
      const first = await workflow.page('recommendation', { limit: 2 });
      expect(first.page).toEqual({ limit: 2, offset: 0, returned: 2, total: 3, nextOffset: 2 });
      const second = await workflow.page('recommendation', { limit: 2, offset: 2 });
      expect(second.page.nextOffset).toBeNull();
      expect(workflow.provenance().rowVersions).toEqual([
        { path: '$[0]', requestUrl: first.requestUrl, version: 2 },
        { path: '$[0].guideline', requestUrl: first.requestUrl, version: 4 },
      ]);
      expect(workflow.provenance().requestUrls).toEqual([first.requestUrl, second.requestUrl]);
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('uses an extra row for unknown counts and fails on scan overflow', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }])),
    );
    await service.workflow(createMockContext(), async (workflow) => {
      expect((await workflow.page('gene', { limit: 2 })).page).toEqual({
        limit: 2,
        offset: 0,
        returned: 2,
        total: null,
        nextOffset: 2,
      });
      await expect(workflow.scan('gene', {}, 2)).rejects.toMatchObject({
        data: { reason: 'query_too_broad', cap: 2 },
      });
    });
  });
  it.each([0, 8])('translates only verified past-end responses with total %i', async (total) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { code: 'PGRST103' },
          { status: 416, headers: { 'content-range': `*/${total}` } },
        ),
      ),
    );
    const result = await service.workflow(createMockContext(), (workflow) =>
      workflow.page('gene', { offset: 100 }),
    );
    expect(result.items).toEqual([]);
    expect(result.page).toEqual({ limit: 25, offset: 100, returned: 0, total, nextOffset: null });
  });
  it('keeps other 416 responses as failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ code: 'other' }, { status: 416, headers: { 'content-range': '*/8' } }),
      ),
    );
    await expect(
      service.workflow(createMockContext(), (workflow) => workflow.page('gene', { offset: 100 })),
    ).rejects.toMatchObject({ data: { status: 416 } });
  });
  it('preserves sparse nested source records without inventing defaults', () => {
    const row = {
      id: 1,
      comments: '\r\n ',
      activityscore: { CYP2D6: 'n/a' },
      guideline: { id: 2, name: 'G', url: null, extension: { values: [null, ''] } },
      drug: null,
    };
    expect(recordSchemas.recommendation.parse(row)).toEqual(row);
    expect(recordSchemas.gene.parse({ symbol: 'HLA-B' })).toEqual({ symbol: 'HLA-B' });
    expect(
      recordSchemas.recommendation.safeParse({ id: 1, guideline: { id: 'bad' } }).success,
    ).toBe(false);
  });
});

describe('CPIC failures and work bounds', () => {
  it.each(['scan', 'attempts'])(
    'omits genetic query URLs from %s budget failures',
    async (mode) => {
      const ctx = createMockContext();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json(mode === 'scan' ? [{ recommendationid: 1 }, { recommendationid: 2 }] : []),
        ),
      );
      const error = await service
        .workflow(ctx, async (workflow) => {
          const query = { diplotypeLookup: { CYP2D6: { '*1': 1, '*4': 1 } } };
          if (mode === 'scan') await workflow.scan('rpc/recommendation_lookup', query, 1);
          else
            for (let i = 0; i < 101; i++) await workflow.page('rpc/recommendation_lookup', query);
        })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'query_too_broad', cap: mode === 'scan' ? 1 : 100 },
      });
      expect(JSON.stringify(error)).not.toMatch(/requestUrl|CYP2D6|cpicpgx|diplotypelookup/);
      const logs: unknown[] = [];
      vi.spyOn(logger, 'error').mockImplementation((message, context) => {
        logs.push(
          sanitizeLogBindings({ message, ...(context && 'extra' in context ? context.extra : {}) }),
        );
      });
      ErrorHandler.handleError(error, {
        operation: 'pgx_get_recommendations',
        includeStack: false,
      });
      expect(logs).toHaveLength(1);
      expect(JSON.stringify(logs)).not.toMatch(/requestUrl|CYP2D6|cpicpgx|diplotypelookup/);
      expect(JSON.stringify((ctx.log as MockContextLogger).calls)).not.toMatch(
        /CYP2D6|cpicpgx|diplotypelookup/,
      );
    },
  );
  it('times out body consumption and stops the retry ladder at its attempt bound', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(stream);
    });
    vi.stubGlobal('fetch', fetch);
    const pending = service
      .workflow(createMockContext(), (workflow) => workflow.page('gene'))
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('retries HTML maintenance pages without accepting them as empty JSON', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('<!doctype html><html>maintenance</html>'));
    vi.stubGlobal('fetch', fetch);
    const pending = service
      .workflow(createMockContext(), (workflow) => workflow.page('gene'))
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ data: { reason: 'upstream_unavailable' } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('sanitizes raw network failures before retry logging', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext();
    const fetch = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'SECRET CYP2D6 https://api.cpicpgx.org/v1/rpc/recommendation_lookup?genotype=private',
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const pending = service
      .workflow(ctx, (workflow) => workflow.page('gene'))
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ data: { reason: 'upstream_unavailable' } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.stringify((ctx.log as MockContextLogger).calls)).not.toMatch(
      /SECRET|CYP2D6|api\.cpicpgx/,
    );
  });
  it.each([
    [400, 'upstream_query_rejected'],
    [404, 'upstream_unavailable'],
    [403, undefined],
  ] as const)(
    'sanitizes source status %i without retaining clinical bodies or URLs',
    async (status, reason) => {
      const ctx = createMockContext();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ message: 'SECRET clinical genotype CYP2D6 *1/*4' }, { status }),
        ),
      );
      const error = await service
        .workflow(ctx, (workflow) =>
          workflow.page('rpc/recommendation_lookup', {
            diplotypeLookup: { CYP2D6: { '*1': 1, '*4': 1 } },
          }),
        )
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ data: { status, ...(reason && { reason }) } });
      expect(JSON.stringify(error)).not.toMatch(/SECRET|CYP2D6|api\.cpicpgx/);
      expect(JSON.stringify((ctx.log as MockContextLogger).calls)).not.toMatch(
        /SECRET|CYP2D6|api\.cpicpgx/,
      );
    },
  );
  it.each(['{bad', '{}', '[{"symbol":7}]'])(
    'rejects malformed or incompatible successful body %s',
    async (body) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body)),
      );
      await expect(
        service.workflow(createMockContext(), (workflow) => workflow.page('gene')),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.SerializationError });
    },
  );
  it('retries rate limiting with Retry-After and does not leak retry logs', async () => {
    vi.useFakeTimers();
    const ctx = createMockContext();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { message: 'SECRET genotype' },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      )
      .mockResolvedValueOnce(Response.json([]));
    vi.stubGlobal('fetch', fetch);
    const pending = service.workflow(ctx, (workflow) => workflow.page('gene'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ items: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((ctx.log as MockContextLogger).calls)).not.toContain('SECRET');
  });
  it('stops pending work and later requests on cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_input: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          controller.abort();
        }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.workflow(createMockContext({ signal: controller.signal }), async (workflow) => {
        await workflow.page('gene');
        await workflow.page('drug');
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces the workflow deadline across sequential pages', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.workflow(createMockContext(), async (workflow) => {
        await workflow.page('gene');
        vi.setSystemTime(Date.now() + 45_001);
        await workflow.page('gene');
      }),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.Timeout });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('limits each workflow to 100 HTTP attempts', async () => {
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    await expect(
      service.workflow(createMockContext(), async (workflow) => {
        for (let i = 0; i < 101; i++) await workflow.page('gene');
      }),
    ).rejects.toMatchObject({ data: { reason: 'query_too_broad', cap: 100 } });
    expect(fetch).toHaveBeenCalledTimes(100);
  });
  it('allows only three simultaneous HTTP requests', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return Response.json([]);
      }),
    );
    const pending = service.workflow(createMockContext(), (workflow) =>
      Promise.all(Array.from({ length: 7 }, () => workflow.page('gene'))),
    );
    for (let batch = 0; batch < 3; batch++) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      for (const release of releases.splice(0)) release();
    }
    await pending;
    expect(peak).toBe(3);
  });
});
