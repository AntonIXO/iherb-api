import { describe, expect, test } from "bun:test";

import { createIHerbClient } from "../src/client.js";
import { parseSearchPage } from "../src/search.js";

const fixture = await Bun.file(
  new URL("./fixtures/search-magnesium.html", import.meta.url),
).text();

describe("iHerb search", () => {
  test("ranks the matching package size and exposes group IDs", () => {
    const candidates = parseSearchPage(
      fixture,
      "California Gold Nutrition magnesium bisglycinate 100 mg 240 capsules",
      "USD",
    );
    expect(candidates[0]?.productId).toBe("103274");
    expect(candidates[0]?.groupId).toBe("8227");
    expect(candidates[0]?.packageQuantity?.amount).toBe(240);
  });

  test("groups 60 and 240 count variants in one family", async () => {
    const client = createIHerbClient({
      fetch: async () =>
        new Response(fixture, {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      rateLimit: { minDelayMs: 0 },
    });

    const result = await client.searchProducts(
      "California Gold Nutrition Magnesium Bisglycinate 60 capsules 100 mg",
    );
    expect(result.source).toBe("live");
    expect(result.families[0]?.familyId).toBe("group:8227");
    expect(result.families[0]?.variants).toHaveLength(2);
    expect(result.families[0]?.selectedVariantId).toBe("103273");
  });

  test("uses product sitemaps when live search has no candidates", async () => {
    const responses = new Map<string, string>([
      [
        "https://www.iherb.com/search?kw=doctor+best+htp+100+mg+60+capsules",
        "<html><body>No products</body></html>",
      ],
      [
        "https://www.iherb.com/sitemap_index.xml",
        `<?xml version="1.0"?><sitemapindex>
          <sitemap><loc>https://www.iherb.com/sitemaps/products-0-www-0.xml</loc></sitemap>
        </sitemapindex>`,
      ],
      [
        "https://www.iherb.com/sitemaps/products-0-www-0.xml",
        `<?xml version="1.0"?><urlset>
          <url>
            <loc>https://www.iherb.com/pr/doctor-s-best-5-htp-100-mg-60-veggie-caps/1</loc>
            <lastmod>2026-07-27T08:10:50+00:00</lastmod>
          </url>
        </urlset>`,
      ],
    ]);
    const client = createIHerbClient({
      fetch: async (input) => {
        const url = String(input);
        const body = responses.get(url);
        return new Response(body ?? "missing", { status: body ? 200 : 404 });
      },
      rateLimit: { minDelayMs: 0 },
    });

    const result = await client.searchProducts(
      "Doctor's Best 5 HTP 100 mg 60 capsules",
    );
    expect(result.source).toBe("sitemap");
    expect(result.candidates[0]?.productId).toBe("1");
  });
});
