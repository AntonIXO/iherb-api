# iherb-api

Typed, unofficial iHerb product search and supplement-label extraction for Bun
and Node.js 20+.

The package accepts text produced by your OCR pipeline, finds likely iHerb
products, groups package variants, and extracts the complete server-rendered
product label. OCR itself is intentionally out of scope.

## Install

```bash
bun add iherb-api
```

## Capture Chrome cookies

Run the package CLI:

```bash
# After the package is published to npm:
bunx iherb-api
# equivalent:
bun x iherb-api
```

From a cloned repository:

```bash
bun install
bun run cookies
```

The command:

1. finds Chrome/Chromium;
2. starts it with an isolated temporary profile;
3. opens iHerb and waits for browser verification or sign-in;
4. reads only cookies applicable to `*.iherb.com`;
5. closes Chrome, deletes the temporary profile, and prints:

```dotenv
IHERB_COOKIE="..."
IHERB_USER_AGENT="..."
```

Copy both lines into `.env`. The matching User-Agent is exported because some
browser-verification cookies are bound to the browser identity.

The CLI also performs a server-side validation request. Modern Cloudflare
checks can bind access to TLS fingerprint and IP in addition to cookies and
User-Agent. If validation prints a warning, the exported values are still
shown, but they may not make Bun `fetch` pass the challenge. In that case,
`searchProducts()` can use its sitemap fallback, while `getProduct()` reports
`IHerbBlockedError` instead of claiming the protection was bypassed.

Options:

```bash
bunx iherb-api --timeout 300
bunx iherb-api --chrome-path /path/to/chrome
```

The CLI never reads the cookie database of your normal Chrome profile. The
printed values are secrets: do not commit them or paste them into logs.

## Usage

```ts
import { createIHerbClient } from "iherb-api";

const client = createIHerbClient({
  // Supply a session explicitly when iHerb requires browser verification.
  // Never commit this value or print it in logs.
  cookieHeader: process.env.IHERB_COOKIE,
  userAgent: process.env.IHERB_USER_AGENT,
  locale: {
    country: "US",
    language: "en-US",
    currency: "USD",
  },
});

const search = await client.searchProducts(`
  California Gold Nutrition
  Magnesium Bisglycinate Chelate
  100 mg per capsule
  240 veggie capsules
`);

const selected =
  search.families[0]?.selectedVariantId ??
  search.candidates[0]?.productId;

if (selected) {
  // Passing the candidate URL avoids resolving the numeric ID through sitemaps.
  const candidate = search.candidates.find(
    (item) => item.productId === selected,
  );
  const product = await client.getProduct(candidate?.url ?? selected);

  console.log(product.name);
  console.log(product.suggestedUse);
  console.log(product.facts);
  console.log(product.derived.perUnitFacts);
}
```

## Search behavior

`searchProducts()` returns ranked candidates and product families:

```ts
const result = await client.searchProducts(ocrText, {
  limit: 10,
  sitemapFallback: true,
});

result.families[0]?.variants;          // e.g. 60 and 240 capsule SKUs
result.families[0]?.selectedVariantId; // null when OCR is ambiguous
result.candidates[0]?.confidence;
result.candidates[0]?.scoreReasons;
```

Live search reads only the first iHerb results page. Cards with the same
`groupId` are returned as variants of one family. `variantsComplete` remains
`false` because the site does not provide a documented completeness guarantee.

When live search is blocked or yields no candidates, the client can create an
in-memory fuzzy index from iHerb's product sitemaps:

```ts
const snapshot = await client.refreshProductIndex();
await Bun.write("iherb-index.json", JSON.stringify(snapshot));

// On a later process start:
client.importProductIndex(
  JSON.parse(await Bun.file("iherb-index.json").text()),
);
```

The library itself stays portable and does not write index files.

## Extracted product data

`getProduct()` returns:

- product ID, group ID, part number, canonical URL, brand and breadcrumbs;
- package quantity, form factor, price, availability, images and rating;
- serving size and servings per container;
- every row of Supplement Facts, including raw cells and source forms;
- per-unit amounts when the serving size is unambiguous;
- suggested use, other ingredients, warnings and description;
- dimensions, shipping weight, expiration date and country of origin when
  present.

The parser uses iHerb's server-rendered HTML. It prioritizes
`#modelProperties`, `data-cart-info`, the Supplement Facts table and semantic
product-overview sections, with JSON-LD and metadata as fallbacks.

## Cookies and blocking

Pass cookies through `cookieHeader` or a `tough-cookie` `CookieJar`:

```ts
import { CookieJar } from "tough-cookie";
import { createIHerbClient, IHerbBlockedError } from "iherb-api";

const cookieJar = new CookieJar();
const client = createIHerbClient({ cookieJar });

try {
  await client.searchProducts("NOW Foods magnesium glycinate 180 tablets");
} catch (error) {
  if (error instanceof IHerbBlockedError) {
    // Refresh the caller-managed session manually.
  }
}
```

The client persists `Set-Cookie`, but it does not read a browser profile, solve
CAPTCHAs, or bypass a browser-verification challenge. Cookie values are never
included in library error messages.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
```

## Usage notice

This project is not affiliated with or endorsed by iHerb. iHerb's interfaces
are undocumented and can change without notice. Before using the package,
review the current [Terms of Use](https://www.iherb.com/info/terms-of-use),
[robots.txt](https://www.iherb.com/robots.txt), and
[sitemap index](https://www.iherb.com/sitemap_index.xml). The package does not
crawl paginated search or category pages.
