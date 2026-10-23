// Shared Admin GraphQL helpers for walking the product catalog (server only).
//
// Shopify rejects any single query whose *requested* cost exceeds 1,000 points
// (nested connections multiply: products(first:50){ media(first:250) } is far
// over), and throttles an app that drains its cost bucket. Every catalog query
// in the app is therefore sized to stay under the cap, and goes through
// `graphqlPaced`, which waits out the throttle instead of failing the page.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isThrottled(err) {
  const s = JSON.stringify(err?.body?.errors || err?.response?.errors || err?.message || "");
  return /THROTTLED|Throttled/.test(s);
}

// Run a query and return the parsed JSON. Retries THROTTLED errors with backoff,
// and after a successful call sleeps just long enough for the bucket to refill
// to this query's requested cost, so the NEXT page doesn't get throttled.
export async function graphqlPaced(admin, query, variables) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await admin.graphql(query, { variables });
      const json = await res.json();
      const cost = json?.extensions?.cost;
      const t = cost?.throttleStatus;
      if (t && cost.requestedQueryCost > t.currentlyAvailable) {
        const waitMs = ((cost.requestedQueryCost - t.currentlyAvailable) / (t.restoreRate || 50)) * 1000;
        await sleep(Math.min(waitMs, 10000));
      }
      return json;
    } catch (err) {
      if (err instanceof Response || !isThrottled(err) || attempt >= 4) throw err;
      await sleep(1000 * (attempt + 1));
    }
  }
}

// Fetch the rest of one product's IMAGE media after `cursor`, using the given
// MediaImage field selection. Used for the (rare) products with more images
// than the catalog query's first page of media.
export async function fetchRestOfImages(admin, productId, cursor, selection) {
  const query = `#graphql
    query RestOfImages($id: ID!, $after: String) {
      product(id: $id) {
        media(first: 100, after: $after, query: "media_type:IMAGE") {
          pageInfo { hasNextPage endCursor }
          nodes { ... on MediaImage { ${selection} } }
        }
      }
    }`;
  const nodes = [];
  let after = cursor;
  for (let i = 0; i < 10 && after; i++) {
    const json = await graphqlPaced(admin, query, { id: productId, after });
    const conn = json?.data?.product?.media;
    if (!conn) break;
    nodes.push(...conn.nodes.filter(Boolean));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return nodes;
}

// Fetch every page of a `products` connection query. `query` must take a
// `$cursor` variable and select `products { pageInfo { hasNextPage endCursor }
// nodes { ... } }`. Returns { nodes, truncated }.
export async function fetchAllProducts(admin, query, { maxPages = 400 } = {}) {
  const nodes = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const json = await graphqlPaced(admin, query, { cursor });
    const conn = json.data.products;
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return { nodes, truncated: false };
    cursor = conn.pageInfo.endCursor;
  }
  return { nodes, truncated: true };
}
