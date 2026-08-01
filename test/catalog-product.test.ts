import { describe, expect, test } from "bun:test";

import { parseIHerbCatalogProductDetails } from "../src/catalog-product.js";
import { createIHerbClient } from "../src/client.js";
import { IHerbParseError } from "../src/errors.js";

const catalogResponse = {
  id: 137787,
  url:
    "https://fi.iherb.com/pr/california-gold-nutrition-quercetin-" +
    "phytosome-quercefit-250-mg-60-veggie-capsules/137787",
  brandName: "California Gold Nutrition",
  brandCode: "CGN",
  displayName: "Kversetiini Phytosome Quercefit®",
  partNumber: "SPN-02429",
  primaryImageIndex: 59,
  imageIndices: [59, 64, 67],
  packageQuantity: "60 kpl",
  supplementFacts: "<table><tr><td>Quercetin</td></tr></table>",
  ingredients: "<p>Other ingredients</p>",
  suggestedUse: "<p>Take one capsule daily.</p>",
  warnings: "<p>Keep out of reach of children.</p>",
  description: "<p>Localized description.</p>",
};

describe("direct catalog product details", () => {
  test("maps the real response fields and marks external HTML as untrusted", async () => {
    let requestUrl = "";
    let requestHeaders = new Headers();
    const client = createIHerbClient({
      catalogProductTransport: "fetch",
      cookieHeader: "locale-session=secret-value",
      locale: { country: "FI", language: "fi-FI", currency: "EUR" },
      fetch: async (input, init) => {
        requestUrl = String(input);
        requestHeaders = new Headers(init?.headers);
        return Response.json(catalogResponse);
      },
      rateLimit: { minDelayMs: 0 },
    });

    const product = await client.getCatalogProductDetails(137787, {
      imageSize: "l",
    });

    expect(requestUrl).toBe("https://catalog.app.iherb.com/product/137787");
    expect(requestHeaders.get("accept")).toBe("application/json");
    expect(requestHeaders.get("accept-language")).toContain("fi-FI");
    expect(requestHeaders.get("cookie")).toContain("locale-session=secret-value");
    expect(requestHeaders.get("cookie")).toContain("lan=fi-FI");
    expect(product).toMatchObject({
      productId: "137787",
      brand: { code: "CGN", name: "California Gold Nutrition" },
      partNumber: "SPN-02429",
      primaryImageIndex: 59,
      imageIndices: [59, 64, 67],
      packageQuantity: "60 kpl",
      imageUrl: "https://s3.images-iherb.com/spn/spn02429/l/59.jpg",
      image: {
        source: "constructed",
        verification: "not_checked",
      },
      supplementFacts: {
        kind: "untrusted_external_html",
        value: catalogResponse.supplementFacts,
      },
    });
  });

  test("rejects a response belonging to another product", async () => {
    expect(
      parseIHerbCatalogProductDetails("137787", {
        ...catalogResponse,
        id: 65020,
      }),
    ).toBeNull();

    const client = createIHerbClient({
      catalogProductTransport: "fetch",
      fetch: async () => Response.json({ ...catalogResponse, id: 65020 }),
      rateLimit: { minDelayMs: 0 },
    });

    await expect(client.getCatalogProductDetails(137787)).rejects.toBeInstanceOf(
      IHerbParseError,
    );
  });

  test("does not trust image fields that are absent from the catalog contract", () => {
    const parsed = parseIHerbCatalogProductDetails("137787", {
      ...catalogResponse,
      image: "https://attacker.invalid/image.jpg",
      imageUrl: "https://attacker.invalid/image.jpg",
      images: ["https://attacker.invalid/image.jpg"],
    });

    expect(parsed?.imageUrl).toBe(
      "https://s3.images-iherb.com/spn/spn02429/g/59.jpg",
    );
    expect(parsed?.image?.source).toBe("constructed");
  });
});
