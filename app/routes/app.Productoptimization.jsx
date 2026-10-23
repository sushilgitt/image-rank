import PageHeader from "../components/PageHeader";
import { ImageMagicIcon } from "@shopify/polaris-icons";
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useLoaderData, useFetcher, useRevalidator } from 'react-router';
import { authenticate } from '../shopify.server';
import { getBillingStateCached } from '../billing.server';
import { getUsage, getRemaining } from '../usage.server';
import { entitled } from '../plans.server';
import db from '../db.server';
import { mapLimit, optimizeBatch } from '../optimize.server';
import { graphqlPaced, fetchRestOfImages } from '../catalog.server';
import {
  Page,
  Layout,
  Button,
  Badge,
  Checkbox,
  Text,
  Box,
  Thumbnail,
  Banner,
  ProgressBar,
  Select,
  EmptyState
} from '@shopify/polaris';

/* -------------------------------------------------------------------------- */
/*  Product fetching (loader only)                                            */
/* -------------------------------------------------------------------------- */

// Sized to stay under Shopify's 1,000-point single-query cost cap (~27 points
// per product). Image sizes come from `originalSource.fileSize`, so the loader
// no longer downloads/HEADs every image, and thumbnails are requested at
// thumbnail size instead of the full-resolution original.
const PRODUCTS_PER_PAGE = 30;
const MEDIA_PER_PRODUCT = 10;
// Background page requests fetch several pages each, to cut round trips.
const PAGES_PER_REQUEST = 3;

const PRODUCTS_QUERY = `#graphql
  query OptimizerProducts($cursor: String) {
    products(first: ${PRODUCTS_PER_PAGE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        featuredMedia { preview { image { url(transform: { maxWidth: 120, maxHeight: 120 }) } } }
        summary: metafield(namespace: "image_optimization", key: "optimization_summary") { value }
        media(first: ${MEDIA_PER_PRODUCT}, query: "media_type:IMAGE") {
          pageInfo { hasNextPage endCursor }
          nodes { ... on MediaImage { alt originalSource { fileSize } } }
        }
      }
    }
  }
`;

function parseSummary(product) {
  if (!product.summary?.value) return null;
  try {
    return JSON.parse(product.summary.value);
  } catch {
    return null;
  }
}

function toRow(product, images) {
  const imageCount = images.length;
  const imagesWithAlt = images.filter(img => img.alt && img.alt.length > 10).length;

  // Optimized products carry measured totals in their summary metafield;
  // the rest use Shopify's recorded original file sizes.
  const summary = parseSummary(product);
  const processed = Math.min(summary?.optimizedImages || 0, imageCount);
  const totalOriginalSize = summary
    ? summary.totalOriginalSizeMB || 0
    : images.reduce((s, img) => s + (img.originalSource?.fileSize || 0), 0) / (1024 * 1024);
  const totalOptimizedSize = summary ? summary.totalOptimizedSizeMB || 0 : totalOriginalSize;

  const score = imageCount > 0 ? Math.round((processed / imageCount) * 100) : 0;
  const sizeSavedMB = Math.max(0, totalOriginalSize - totalOptimizedSize);
  const compressionRate = totalOriginalSize > 0
    ? Math.max(0, Math.round((sizeSavedMB / totalOriginalSize) * 100))
    : 0;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    status: product.status,
    imageCount,
    imagesWithAlt,
    optimizedImages: processed,
    score,
    totalOriginalSizeMB: totalOriginalSize,
    totalOptimizedSizeMB: totalOptimizedSize,
    sizeSavedMB,
    compressionRate,
    featuredImageUrl: product.featuredMedia?.preview?.image?.url || null,
    needsOptimization: score < 100,
  };
}

// Fetch up to `pages` pages of products starting at `cursor`, as UI rows.
// Returns { products, nextCursor } (nextCursor null when the catalog is done).
async function fetchProductRows(admin, cursor, pages) {
  const rows = [];
  for (let i = 0; i < pages; i++) {
    const json = await graphqlPaced(admin, PRODUCTS_QUERY, { cursor });
    const conn = json.data.products;
    const pageRows = await mapLimit(conn.nodes, 4, async (product) => {
      const images = product.media.nodes.filter(Boolean);
      if (product.media.pageInfo.hasNextPage) {
        images.push(...await fetchRestOfImages(
          admin, product.id, product.media.pageInfo.endCursor, 'alt originalSource { fileSize }'
        ));
      }
      return toRow(product, images);
    });
    rows.push(...pageRows);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (!cursor) break;
  }
  return { products: rows, nextCursor: cursor };
}

/* -------------------------------------------------------------------------- */
/*  Loader                                                                    */
/* -------------------------------------------------------------------------- */

// The first page of products renders immediately; the client then pulls the
// rest of the catalog in the background via `?cursor=` (see the UI below), so
// the page no longer waits for the whole catalog before showing anything.
export async function loader({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);

  const cursor = url.searchParams.get('cursor');
  if (cursor) {
    try {
      return { kind: 'catalogPage', ...(await fetchProductRows(admin, cursor, PAGES_PER_REQUEST)) };
    } catch (error) {
      console.error('Error loading products page:', error);
      return { kind: 'catalogPage', products: [], nextCursor: null, error: 'Failed to load some products' };
    }
  }

  const filter = url.searchParams.get('filter') || 'all';
  const sortBy = url.searchParams.get('sortBy') || 'score_asc';

  // Plan, usage and per-shop settings drive the quota meter + auto-optimize UI.
  // Run them alongside the first product page rather than one after another.
  const planPromise = getBillingStateCached(admin, session.shop)
    .then(s => s.plan)
    .catch(() => null); // fall through to Free defaults below
  const usagePromise = Promise.all([
    getUsage(session.shop),
    db.shopSettings.findUnique({ where: { shop: session.shop } }),
  ]).catch(() => null); // usage/settings tables not ready yet — default to zero/off
  const firstPagePromise = fetchProductRows(admin, null, 1).catch((error) => {
    console.error('Error loading products:', error);
    return null;
  });

  const [plan, usageAndSettings, firstPage] = await Promise.all([planPromise, usagePromise, firstPagePromise]);
  const usage = usageAndSettings?.[0] || { period: '', imagesUsed: 0 };
  const autoOptimize = usageAndSettings?.[1]?.autoOptimize ?? false;

  return {
    products: firstPage?.products || [],
    nextCursor: firstPage?.nextCursor || null,
    filter,
    sortBy,
    plan: {
      tier: plan?.tier || 'free',
      name: plan?.name || 'Free',
      monthlyImages: plan?.monthlyImages ?? 100,
      autoOptimizeAllowed: entitled(plan, 'autoOptimize'),
    },
    usage,
    autoOptimize,
    error: firstPage ? null : 'Failed to load products',
  };
}

// Each optimize batch / settings toggle is a fetcher POST; by default React
// Router would re-run this loader (the whole catalog) after every one of them.
// Live progress already updates the UI, so only revalidate on explicit request
// (revalidator.revalidate() when a queue finishes) or navigation.
export function shouldRevalidate({ formMethod, defaultShouldRevalidate }) {
  if (formMethod && formMethod !== 'GET') return false;
  return defaultShouldRevalidate;
}

/* -------------------------------------------------------------------------- */
/*  Action — toggles auto-optimize, or processes ONE optimization batch       */
/* -------------------------------------------------------------------------- */

export async function action({ request }) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get('actionType');

  if (actionType === 'setAutoOptimize') {
    const enabled = formData.get('enabled') === 'true';
    // Enabling is gated by plan entitlement; disabling is always allowed.
    if (enabled) {
      try {
        const { plan } = await getBillingStateCached(admin, session.shop);
        if (!entitled(plan, 'autoOptimize')) {
          return { success: false, settingUpdated: true, error: 'Upgrade to Growth to auto-optimize new products.' };
        }
      } catch { /* if billing check fails, fall through and block enabling */
        return { success: false, settingUpdated: true, error: 'Could not verify your plan. Try again.' };
      }
    }
    await db.shopSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, autoOptimize: enabled },
      update: { autoOptimize: enabled },
    });
    return { success: true, settingUpdated: true, autoOptimize: enabled };
  }

  if (actionType === 'optimizeProduct') {
    const productId = formData.get('productId');
    try {
      const { plan } = await getBillingStateCached(admin, session.shop);
      const remainingQuota = await getRemaining(session.shop, plan);
      return await optimizeBatch(admin, productId, {
        shop: session.shop,
        remainingQuota,
        genAlt: entitled(plan, 'altText'),
      });
    } catch (error) {
      const msg = error?.graphQLErrors?.[0]?.message || error?.message || 'unknown error';
      console.error('[OPTIMIZE] product failed:', msg);
      return { success: false, productId, error: 'Failed to optimize product: ' + msg };
    }
  }

  return { success: false, error: 'Invalid action' };
}

/* -------------------------------------------------------------------------- */
/*  UI                                                                        */
/* -------------------------------------------------------------------------- */

export default function ProductOptimization() {
  const {
    products: firstPageProducts, nextCursor: firstCursor, filter: initialFilter, sortBy: initialSortBy,
    error: loadError, plan, usage, autoOptimize: initialAutoOptimize,
  } = useLoaderData();
  const fetcher = useFetcher();
  const settingsFetcher = useFetcher();
  const pageFetcher = useFetcher();
  const revalidator = useRevalidator();
  const [error, setError] = useState(loadError);

  // Rest of the catalog, pulled page by page in the background after the first
  // page renders. Only done once per visit: a later revalidation refreshes the
  // first page, and live progress keeps the remaining rows current.
  const [moreProducts, setMoreProducts] = useState([]);
  const [loadingMore, setLoadingMore] = useState(Boolean(firstCursor));
  const pagingStartedRef = useRef(false);

  useEffect(() => {
    if (pagingStartedRef.current || !firstCursor) return;
    pagingStartedRef.current = true;
    pageFetcher.load(`/app/productoptimization?cursor=${encodeURIComponent(firstCursor)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstCursor]);

  useEffect(() => {
    if (pageFetcher.state !== 'idle' || pageFetcher.data?.kind !== 'catalogPage') return;
    const page = pageFetcher.data;
    setMoreProducts(prev => [...prev, ...page.products]);
    if (page.error) setError(page.error);
    if (page.nextCursor) {
      pageFetcher.load(`/app/productoptimization?cursor=${encodeURIComponent(page.nextCursor)}`);
    } else {
      setLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageFetcher.state, pageFetcher.data]);

  const products = useMemo(() => {
    const ids = new Set(firstPageProducts.map(p => p.id));
    return [...firstPageProducts, ...moreProducts.filter(p => !ids.has(p.id))];
  }, [firstPageProducts, moreProducts]);

  const stats = useMemo(() => ({
    total: products.length,
    needsOptimization: products.filter(p => p.needsOptimization).length,
    totalImages: products.reduce((s, p) => s + p.imageCount, 0),
    potentialSavingsMB: products.reduce((s, p) => s + p.sizeSavedMB, 0),
  }), [products]);

  const [filter, setFilter] = useState(initialFilter);
  const [sortBy, setSortBy] = useState(initialSortBy);
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [successMessage, setSuccessMessage] = useState(null);
  const [autoOptimize, setAutoOptimize] = useState(initialAutoOptimize);

  // Live per-product progress, keyed by product id, updated after every batch.
  const [liveProgress, setLiveProgress] = useState({});
  const [activeId, setActiveId] = useState(null);
  const queueRef = useRef([]);
  const activeRef = useRef(null);

  // Track images optimized this session so the usage meter moves without a reload.
  const [sessionImages, setSessionImages] = useState(0);
  const lastOptimizedRef = useRef({}); // productId -> optimized count last seen

  // A revalidation brings a fresh usage count that already includes this
  // session's images, so restart the session delta to avoid double counting.
  useEffect(() => { setSessionImages(0); }, [usage]);

  const startNext = useCallback(() => {
    const next = queueRef.current.shift();
    if (!next) {
      activeRef.current = null;
      setActiveId(null);
      // Quietly re-run the loader in place (no full-page reload). The live
      // numbers in liveProgress remain authoritative for display, so stale
      // read-after-write metafield lag can't flip a finished product back to
      // "needs optimization".
      revalidator.revalidate();
      return;
    }
    activeRef.current = next;
    setActiveId(next);
    fetcher.submit({ actionType: 'optimizeProduct', productId: next }, { method: 'post' });
  }, [fetcher, revalidator]);

  // Drive the batch loop: each completed batch either continues the same
  // product or advances to the next queued product.
  useEffect(() => {
    if (fetcher.state !== 'idle' || !fetcher.data) return;
    const data = fetcher.data;
    if (!data.productId || data.productId !== activeRef.current) return;

    if (data.success === false) {
      setError(data.error || 'Optimization failed');
      startNext();
      return;
    }

    setLiveProgress(prev => ({ ...prev, [data.productId]: data }));

    // Increment the session usage meter by the newly-optimized image delta.
    const prevSeen = lastOptimizedRef.current[data.productId] || 0;
    const delta = Math.max(0, (data.optimized || 0) - prevSeen);
    if (delta > 0) {
      lastOptimizedRef.current[data.productId] = data.optimized;
      setSessionImages(s => s + delta);
    }

    // Monthly quota hit — stop the whole queue and prompt to upgrade.
    if (data.quotaExceeded) {
      setError('Monthly image quota reached. Upgrade your plan to optimize more images this month.');
      queueRef.current = [];
      startNext();
      return;
    }

    if (data.done) {
      setSuccessMessage(data.message);
      setTimeout(() => setSuccessMessage(null), 4000);
      startNext();
    } else if (!data.advanced) {
      // A whole batch failed (e.g. unreachable images) — stop to avoid looping.
      setError(`Some images for "${data.title}" couldn't be processed (${data.remaining} remaining). Try again.`);
      startNext();
    } else {
      fetcher.submit({ actionType: 'optimizeProduct', productId: data.productId }, { method: 'post' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);

  // Reflect the saved auto-optimize setting (or surface a gating error).
  useEffect(() => {
    if (settingsFetcher.state !== 'idle' || !settingsFetcher.data) return;
    const d = settingsFetcher.data;
    if (!d.settingUpdated) return;
    if (d.success) {
      setAutoOptimize(d.autoOptimize);
    } else {
      setError(d.error || 'Could not update setting.');
      setAutoOptimize(false); // revert optimistic flip
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFetcher.state, settingsFetcher.data]);

  const beginQueue = useCallback((ids) => {
    if (!ids.length || activeRef.current) return;
    setError(null);
    queueRef.current = [...ids];
    startNext();
  }, [startNext]);

  // Filter/sort are pure client-side transforms of the already-loaded product
  // list — no server roundtrip, so the list updates instantly.
  const handleFilterChange = useCallback((value) => setFilter(value), []);
  const handleSortChange = useCallback((value) => setSortBy(value), []);

  const handleToggleAutoOptimize = useCallback((checked) => {
    setAutoOptimize(checked); // optimistic
    setError(null);
    settingsFetcher.submit(
      { actionType: 'setAutoOptimize', enabled: String(checked) },
      { method: 'post' }
    );
  }, [settingsFetcher]);

  const displayedProducts = useMemo(() => {
    let list = products;
    if (filter === 'needs_optimization') list = list.filter(p => p.needsOptimization);
    else if (filter === 'optimized') list = list.filter(p => !p.needsOptimization);
    else if (filter === 'no_alt_text') list = list.filter(p => p.imagesWithAlt === 0);

    // Sort a copy so we never mutate loader data (which would corrupt the next
    // filter pass). Score reflects live progress, so re-sorts stay correct.
    const sorted = [...list];
    if (sortBy === 'score_asc') sorted.sort((a, b) => a.score - b.score);
    else if (sortBy === 'score_desc') sorted.sort((a, b) => b.score - a.score);
    else if (sortBy === 'size_desc') sorted.sort((a, b) => b.totalOriginalSizeMB - a.totalOriginalSizeMB);
    else if (sortBy === 'images_desc') sorted.sort((a, b) => b.imageCount - a.imageCount);
    return sorted;
  }, [products, filter, sortBy]);

  const handleSelectProduct = useCallback((id) => {
    setSelectedProducts(prev => prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id]);
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedProducts(selectedProducts.length === displayedProducts.length ? [] : displayedProducts.map(p => p.id));
  }, [selectedProducts.length, displayedProducts]);

  const handleOptimizeProduct = useCallback((id) => beginQueue([id]), [beginQueue]);
  const handleOptimizeSelected = useCallback(() => {
    beginQueue(selectedProducts);
    setSelectedProducts([]);
  }, [beginQueue, selectedProducts]);

  const isBusy = activeId !== null;

  // Usage meter: loader baseline + images optimized live this session.
  const quota = plan?.monthlyImages ?? 100;
  const usedImages = (usage?.imagesUsed ?? 0) + sessionImages;
  const usagePct = quota > 0 ? Math.min(100, Math.round((usedImages / quota) * 100)) : 0;
  const quotaReached = usedImages >= quota;

  const formatBytes = (mb) => {
    const v = mb || 0;
    if (v >= 1000) return `${(v / 1000).toFixed(1)} GB`;
    if (v >= 1) return `${v.toFixed(1)} MB`;
    if (v > 0) return `${Math.max(1, Math.round(v * 1024))} KB`;
    return `0 KB`;
  };

  const filterOptions = [
    { label: 'All Products', value: 'all' },
    { label: 'Needs Optimization', value: 'needs_optimization' },
    { label: 'Optimized', value: 'optimized' },
    { label: 'No Alt Text', value: 'no_alt_text' },
  ];
  const sortOptions = [
    { label: 'Score: Low to High', value: 'score_asc' },
    { label: 'Score: High to Low', value: 'score_desc' },
    { label: 'Size: Largest First', value: 'size_desc' },
    { label: 'Most Images First', value: 'images_desc' },
  ];

  // Merge loader values with any live progress for a product.
  const view = (product) => {
    const lp = liveProgress[product.id];
    if (!lp) return product;
    return {
      ...product,
      score: lp.score,
      optimizedImages: lp.optimized,
      totalOriginalSizeMB: lp.originalSizeMB || product.totalOriginalSizeMB,
      sizeSavedMB: lp.sizeSavedMB,
      compressionRate: lp.compressionRate,
      needsOptimization: lp.score < 100,
    };
  };

  const liveSavings = stats.potentialSavingsMB
    + Object.entries(liveProgress).reduce((sum, [id, lp]) => {
        const base = products.find(p => p.id === id)?.sizeSavedMB || 0;
        return sum + Math.max(0, (lp.sizeSavedMB || 0) - base);
      }, 0);

  const filterCounts = {
    all: products.length,
    needs_optimization: products.filter(p => view(p).needsOptimization).length,
    optimized: products.filter(p => !view(p).needsOptimization).length,
    no_alt_text: products.filter(p => p.imagesWithAlt === 0).length,
  };
  const allSelected = selectedProducts.length === displayedProducts.length && displayedProducts.length > 0;

  const kpis = [
    { label: 'Products', value: stats.total.toLocaleString() },
    { label: 'Need work', value: stats.needsOptimization.toLocaleString(), tone: stats.needsOptimization > 0 ? 'warn' : undefined },
    { label: 'Images', value: stats.totalImages.toLocaleString() },
    { label: 'Saved so far', value: formatBytes(liveSavings), tone: 'good' },
  ];

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <PageHeader icon={ImageMagicIcon} eyebrow="Optimize" title="Image Optimizer" subtitle="WebP conversion & smart compression — optimized images replace the originals" />
        </Layout.Section>

        {error && (
          <Layout.Section>
            <Banner title="Error" tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
          </Layout.Section>
        )}
        {successMessage && (
          <Layout.Section>
            <Banner title="Success" tone="success" onDismiss={() => setSuccessMessage(null)}>{successMessage}</Banner>
          </Layout.Section>
        )}

        {/* KPI strip */}
        <Layout.Section>
          <div className="ir-kpis">
            {kpis.map(k => (
              <div key={k.label} className="ir-kpi">
                <p className={`ir-kpi-value${k.tone ? ` ir-kpi-${k.tone}` : ''}`}>{k.value}</p>
                <p className="ir-kpi-label">{k.label}</p>
              </div>
            ))}
          </div>
        </Layout.Section>

        {/* Sidebar: usage + automation */}
        <Layout.Section variant="oneThird">
          <div className="ir-side-card">
            <div className="ir-side-block">
              <div className="ir-side-row">
                <span className="ir-side-title">Monthly usage</span>
                <Badge tone={plan?.tier === 'free' ? undefined : 'success'}>{`${plan?.name || 'Free'} plan`}</Badge>
              </div>
              <p className="ir-side-big">
                {usedImages.toLocaleString()}
                <span>{` / ${quota.toLocaleString()}`}</span>
              </p>
              <ProgressBar progress={usagePct} size="small" tone={quotaReached ? 'critical' : 'primary'} />
              {quotaReached && (
                <Text variant="bodySm" as="p" tone="critical">
                  Monthly quota used. Upgrade your plan to optimize more images.
                </Text>
              )}
            </div>
            <div className="ir-side-block">
              <div className="ir-side-row">
                <span className="ir-side-title">Auto-optimize</span>
                {plan?.autoOptimizeAllowed
                  ? <Badge tone={autoOptimize ? 'success' : undefined}>{autoOptimize ? 'On' : 'Off'}</Badge>
                  : <Badge tone="attention">Growth & up</Badge>}
              </div>
              <p className="ir-side-note">Optimize images on every new product automatically, in the background.</p>
              {plan?.autoOptimizeAllowed ? (
                <Checkbox
                  label="Enable for new products"
                  checked={autoOptimize}
                  onChange={handleToggleAutoOptimize}
                  disabled={settingsFetcher.state !== 'idle'}
                />
              ) : (
                <Text variant="bodySm" as="p" tone="subdued">Available on the Growth plan and above.</Text>
              )}
            </div>
          </div>
        </Layout.Section>

        {/* Product list */}
        <Layout.Section>
          <div className="ir-list">
            <div className="ir-toolbar">
              <div className="ir-pills" role="tablist" aria-label="Filter products">
                {filterOptions.map(o => (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={filter === o.value}
                    className={`ir-pill${filter === o.value ? ' is-active' : ''}`}
                    onClick={() => handleFilterChange(o.value)}
                    disabled={isBusy}
                  >
                    {o.label}
                    <span className="ir-pill-count">{filterCounts[o.value]}</span>
                  </button>
                ))}
              </div>
              <Box width="210px">
                <Select label="Sort by" labelInline options={sortOptions} value={sortBy} onChange={handleSortChange} disabled={isBusy} />
              </Box>
            </div>

            <div className="ir-row ir-row-head">
              <Checkbox
                label="Select all"
                labelHidden
                checked={allSelected}
                onChange={handleSelectAll}
                disabled={isBusy || displayedProducts.length === 0}
              />
              <span />
              <span>Product</span>
              <span>Optimized</span>
              <span>Saved</span>
              <span>Score</span>
              <span />
            </div>

            {displayedProducts.length === 0 ? (
              <EmptyState heading="No products found" image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png">
                <p>Try a different filter to see products.</p>
              </EmptyState>
            ) : (
              displayedProducts.map((raw) => {
                const product = view(raw);
                const isActive = activeId === product.id;
                const selected = selectedProducts.includes(product.id);
                const scoreTone = product.score >= 80 ? 'good' : product.score >= 60 ? 'warn' : 'bad';
                return (
                  <div key={product.id} className={`ir-row${selected ? ' is-selected' : ''}${isActive ? ' is-active' : ''}`}>
                    <Checkbox
                      label={`Select ${product.title}`}
                      labelHidden
                      checked={selected}
                      onChange={() => handleSelectProduct(product.id)}
                      disabled={isBusy}
                    />
                    <Thumbnail source={product.featuredImageUrl || ImageMagicIcon} alt={product.title} size="small" />
                    <div className="ir-row-main">
                      <p className="ir-row-title">{product.title}</p>
                      <p className="ir-row-meta">
                        {`${product.status.toLowerCase()} · ${product.imageCount} images · alt text ${product.imagesWithAlt}/${product.imageCount}`}
                        {isActive && <span className="ir-live-dot">Optimizing</span>}
                      </p>
                    </div>
                    <div className="ir-row-progress">
                      <span>{`${product.optimizedImages}/${product.imageCount}`}</span>
                      <div className="ir-bar"><i style={{ width: `${product.score}%` }} /></div>
                    </div>
                    <div className="ir-row-saved">
                      <strong>{formatBytes(product.sizeSavedMB)}</strong>
                      <span>{`of ${formatBytes(product.totalOriginalSizeMB)}`}</span>
                    </div>
                    <div className={`ir-score ir-score-${scoreTone}`} style={{ '--pct': product.score }}>
                      <span>{product.score}</span>
                    </div>
                    <div className="ir-row-action">
                      {product.needsOptimization ? (
                        <Button size="slim" variant="primary" onClick={() => handleOptimizeProduct(product.id)} loading={isActive} disabled={isBusy || quotaReached}>
                          Optimize
                        </Button>
                      ) : (
                        <Badge tone="success">Done</Badge>
                      )}
                    </div>
                  </div>
                );
              })
            )}
            {loadingMore && (
              <div className="ir-row-loading">
                <Text variant="bodySm" as="p" tone="subdued">
                  {`Loading more products… ${products.length.toLocaleString()} loaded`}
                </Text>
              </div>
            )}
          </div>
        </Layout.Section>
      </Layout>

      {selectedProducts.length > 0 && (
        <div className="ir-bulkbar" role="region" aria-label="Bulk actions">
          <span>{`${selectedProducts.length} product${selectedProducts.length === 1 ? '' : 's'} selected`}</span>
          <div className="ir-bulkbar-actions">
            <button type="button" className="ir-btn ir-btn-ghost" onClick={() => setSelectedProducts([])} disabled={isBusy}>Clear</button>
            <button type="button" className="ir-btn ir-btn-lime" onClick={handleOptimizeSelected} disabled={isBusy || quotaReached}>
              {isBusy ? 'Optimizing…' : 'Optimize selected'}
            </button>
          </div>
        </div>
      )}
    </Page>
  );
}
