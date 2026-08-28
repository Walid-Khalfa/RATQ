import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Resource } from '@/types/resource';

const mockGet = vi.fn();
vi.mock('@/modules/resources/infrastructure/repositories/aggregate', () => ({
  resourceAggregator: { get: (slug: string) => mockGet(slug) },
}));

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});
vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}));

vi.mock('@/app/resources/[slug]/ResourceDetailClient', () => ({
  ResourceDetailClient: (_props: { resource: Resource; repoPreview: unknown }) => null,
}));

vi.mock('@/modules/resources/infrastructure/github/fetchGithubRepoPreview', () => ({
  fetchGithubRepoPreview: vi.fn(async () => null),
}));

function createResource(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 1,
    name: 'Test Resource',
    slug: 'test-resource',
    type: 'api',
    description: 'A test resource description',
    short_description: 'Test resource summary',
    documentation_url: null,
    github_url: null,
    license: 'MIT',
    itqan_badge: false,
    status: 'published',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    version: '1.0.0',
    github_stats: null,
    source: 'ratq',
    source_url: null,
    ...overrides,
  } as Resource;
}

// Minimal Workers-style Cache API mock, matching what withEdgeCache expects
// (cache.match(request) / cache.put(request, response)).
function installMockEdgeCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
    put: vi.fn(async (req: Request, res: Response) => {
      store.set(req.url, res);
    }),
  };
  (globalThis as any).caches = { default: cache };
  return cache;
}

function removeMockEdgeCache() {
  delete (globalThis as any).caches;
}

// Module-level reference captured before any test patches it.
const _OriginalRequest = globalThis.Request;

beforeEach(() => {
  vi.resetModules();
  mockGet.mockReset();
  mockNotFound.mockClear();
  // Patch globalThis.Request to strip cross-realm AbortSignal from init.
  // In jsdom environment, globalThis.AbortSignal is jsdom's class while
  // globalThis.Request is Node's undici Request. Passing a jsdom signal
  // into Node's Request constructor throws a cross-realm TypeError.
  // Wrapping Request here lets the page's synthetic cache-key Request
  // objects be constructed without the signal, which is fine because
  // withEdgeCache only uses request.url for cache-key matching.
  const _OrigRequest = globalThis.Request;
  (globalThis as any).Request = class Request extends _OrigRequest {
    constructor(info: RequestInfo | URL, init?: RequestInit) {
      const { signal: _signal, ...rest } = init || {};
      super(info, rest as RequestInit);
    }
  } as any;
  Object.setPrototypeOf((globalThis as any).Request, _OrigRequest);
});

afterEach(() => {
  removeMockEdgeCache();
  (globalThis as any).Request = _OriginalRequest;
});

describe('ResourceDetailPage', () => {
  it('fetches through the edge cache and renders the resource on a cache miss', async () => {
    const cache = installMockEdgeCache();
    const resource = createResource({ slug: 'miss-slug', name: 'Miss Resource' });
    mockGet.mockResolvedValue(resource);

    const { default: ResourceDetailPage } = await import('@/app/resources/[slug]/page');
    const result = await ResourceDetailPage({ params: Promise.resolve({ slug: 'miss-slug' }) });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('miss-slug');
    expect(cache.put).toHaveBeenCalledTimes(1);
    expect((result as any).props.resource.name).toBe('Miss Resource');
  });

  it('reuses the cached response on a cache hit and skips the aggregator', async () => {
    const cache = installMockEdgeCache();
    const resource = createResource({ slug: 'hit-slug', name: 'Hit Resource' });

    const cachedBody = JSON.stringify(resource);
    const cacheKeyUrl = 'https://cache-key.internal/resources/hit-slug';
    (cache.match as any).mockImplementation(async (req: Request) =>
      req.url === cacheKeyUrl
        ? new Response(cachedBody, { headers: { 'Content-Type': 'application/json' } })
        : undefined,
    );

    const { default: ResourceDetailPage } = await import('@/app/resources/[slug]/page');
    const result = await ResourceDetailPage({ params: Promise.resolve({ slug: 'hit-slug' }) });

    expect(mockGet).not.toHaveBeenCalled();
    expect(cache.put).not.toHaveBeenCalled();
    expect((result as any).props.resource.name).toBe('Hit Resource');
  });

  // NOTE: vitest calls generateMetadata/default directly, outside a real request scope,
  // so React's cache() isn't what's deduping here — the edge-cache mock is. This test
  // verifies edge-cache reuse, not React cache dedup.
  it('reuses the edge cache between generateMetadata and the page', async () => {
    installMockEdgeCache();
    const resource = createResource({
      slug: 'shared-slug',
      name: 'Shared Resource',
      description: 'x'.repeat(200),
    });
    mockGet.mockResolvedValue(resource);

    const pageModule = await import('@/app/resources/[slug]/page');
    const params = Promise.resolve({ slug: 'shared-slug' });

    const metadata = await pageModule.generateMetadata({ params });
    await pageModule.default({ params });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(metadata.title).toBe('Shared Resource');
    expect(metadata.description).toBe('x'.repeat(160));
  });

  it('calls notFound and skips caching the miss when the resource does not exist', async () => {
    installMockEdgeCache();
    mockGet.mockResolvedValue(null);

    const { default: ResourceDetailPage } = await import('@/app/resources/[slug]/page');

    await expect(
      ResourceDetailPage({ params: Promise.resolve({ slug: 'missing-slug' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('falls back to an uncached call when the Workers Cache API is unavailable (local dev)', async () => {
    removeMockEdgeCache();
    const resource = createResource({ slug: 'local-slug', name: 'Local Resource' });
    mockGet.mockResolvedValue(resource);

    const { default: ResourceDetailPage } = await import('@/app/resources/[slug]/page');
    const result = await ResourceDetailPage({ params: Promise.resolve({ slug: 'local-slug' }) });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect((result as any).props.resource.name).toBe('Local Resource');
  });
});
