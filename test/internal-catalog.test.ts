import { describe, expect, test } from "bun:test";

import { createIHerbClient } from "../src/client.js";
import { IHerbNotFoundError } from "../src/errors.js";
import {
  constructIHerbImage,
  IHERB_IMAGE_SIZE_PIXELS,
  verifyIHerbImage,
} from "../src/internal-catalog.js";

const comparisonResponse = {
  fields: [
    { context: "Attribute", contextId: 72, displayName: "Package quantity" },
    { context: "Attribute", contextId: 166, displayName: "Serving size" },
    {
      context: "Attribute",
      contextId: 165,
      displayName: "Servings per container",
    },
    { context: "Attribute", contextId: 3, displayName: "Potency" },
    {
      context: "Attribute",
      contextId: 88,
      displayName: "Certification and diet",
    },
  ],
  products: [
    {
      rootCategoryId: 1855,
      rootCategoryLabel: "Supplements",
      id: 103274,
      name:
        "California Gold Nutrition, Magnesium Bisglycinate Chelate, " +
        "240 Veggie Capsules",
      productName: "Magnesium Bisglycinate Chelate, 240 Veggie Capsules",
      partNumber: "CGN-01902",
      url: "https://www.iherb.com/pr/example/103274",
      brandCode: "CGN",
      brandName: "California Gold Nutrition",
      primaryImageIndex: 106,
      rating: 4.8,
      ratingCount: 26554,
      listPrice: "$28.42",
      listPriceAmount: 28.42,
      discountedPrice: "$28.42",
      discountedPriceAmount: 28.42,
      groupId: 8227,
      isOutOfStock: false,
      isNotAvailable: false,
      isDiscontinued: false,
      isAvailableToPurchase: true,
      formattedExpirationDate: "03/2028",
      packageQuantity: "240 count",
      dimensionsIn: "5.65 x 3.05 x 3.05 in",
      dimensionsCm: "14.4 x 7.7 x 7.7 cm",
      weightLb: "0.53 lb",
      weightKg: "0.24 kg",
      attributes: [
        { attributeId: 72, displayNames: ["240 count"] },
        { attributeId: 166, displayNames: ["2 capsules"] },
        { attributeId: 165, displayNames: ["120"] },
        { attributeId: 3, displayNames: ["200 mg"] },
        {
          attributeId: 88,
          displayNames: ["Gluten-free", "Vegan"],
        },
      ],
    },
  ],
  displayRowsThreshold: 7,
};

const aiComparisonResponse = {
  category: { name: "Magnesium Glycinate" },
  items: [
    {
      comparisonDetails: {
        keyIngredients: [
          { name: "Magnesium Glycinate", value: "200 mg" },
        ],
      },
      product: {
        id: 103274,
        servingSize: "2 capsules",
        servingPerContainer: "120 serving",
      },
    },
  ],
};

describe("internal iHerb catalog", () => {
  test("maps direct comparison JSON into a useful product shape", async () => {
    const requestHeaders: Headers[] = [];
    const client = createIHerbClient({
      fetch: async (input, init) => {
        requestHeaders.push(new Headers(init?.headers));
        return String(input).includes("/aicomparison/")
          ? Response.json(aiComparisonResponse)
          : Response.json(comparisonResponse);
      },
      rateLimit: { concurrency: 2, minDelayMs: 0 },
    });

    const product = await client.getCatalogProduct(103274);

    expect(product.productId).toBe("103274");
    expect(product.groupId).toBe("8227");
    expect(product.brand.name).toBe("California Gold Nutrition");
    expect(product.servingSize).toMatchObject({
      amount: 2,
      unit: "capsules",
    });
    expect(product.servingsPerContainer).toBe(120);
    expect(product.potency).toMatchObject({ amount: 200, unit: "mg" });
    expect(product.keyIngredients[0]).toMatchObject({
      name: "Magnesium Glycinate",
      amount: { amount: 200, unit: "mg" },
      source: "ai_comparison",
    });
    expect(product.certifications).toEqual(["Gluten-free", "Vegan"]);
    expect(product.imageUrl).toContain("/cgn/cgn01902/g/106.jpg");
    expect(product.image).toMatchObject({
      source: "constructed",
      size: "g",
      verification: "not_checked",
    });
    expect(product.availability.status).toBe("in_stock");

    expect(requestHeaders).toHaveLength(2);
    for (const headers of requestHeaders) {
      expect(headers.get("accept")).toBe("application/json");
      expect(headers.get("cookie")).toContain("iher-pref1=");
    }
  });

  test("uses the part-number prefix when it differs from brandCode", async () => {
    const response = structuredClone(comparisonResponse);
    Object.assign(response.products[0]!, {
      id: 137787,
      brandCode: "CGN",
      partNumber: "SPN-02429",
      primaryImageIndex: 59,
    });
    const client = createIHerbClient({
      fetch: async (input) =>
        String(input).includes("/aicomparison/")
          ? new Response(null, { status: 204 })
          : Response.json(response),
      rateLimit: { concurrency: 2, minDelayMs: 0 },
    });

    const product = await client.getCatalogProduct(137787, { imageSize: "y" });

    expect(product.imageUrl).toBe(
      "https://s3.images-iherb.com/spn/spn02429/y/59.jpg",
    );
    expect(product.image).toMatchObject({
      size: "y",
      source: "constructed",
      verification: "not_checked",
    });
  });

  test("optionally verifies a constructed image with HEAD", async () => {
    const methods: Array<string | undefined> = [];
    const client = createIHerbClient({
      fetch: async (input, init) => {
        methods.push(init?.method);
        if (String(input).startsWith("https://s3.images-iherb.com/")) {
          return new Response(null, { status: 200 });
        }
        return String(input).includes("/aicomparison/")
          ? Response.json(aiComparisonResponse)
          : Response.json(comparisonResponse);
      },
      rateLimit: { concurrency: 2, minDelayMs: 0 },
    });

    const product = await client.getCatalogProduct(103274, {
      verifyImage: true,
    });

    expect(methods).toContain("HEAD");
    expect(product.image).toMatchObject({
      verification: "available",
      verificationStatus: 200,
    });
  });

  test("keeps core catalog data when AI comparison has no content", async () => {
    const client = createIHerbClient({
      fetch: async (input) =>
        String(input).includes("/aicomparison/")
          ? new Response(null, { status: 204 })
          : Response.json(comparisonResponse),
      rateLimit: { concurrency: 2, minDelayMs: 0 },
    });

    const product = await client.getCatalogProduct("103274");

    expect(product.keyIngredients).toEqual([]);
    expect(product.diagnostics).toContain(
      "The AI comparison endpoint did not return key ingredients.",
    );
  });

  test("reports IDs absent from the catalog response", async () => {
    const client = createIHerbClient({
      fetch: async (input) =>
        String(input).includes("/aicomparison/")
          ? new Response(null, { status: 204 })
          : Response.json({ fields: [], products: [] }),
      rateLimit: { concurrency: 2, minDelayMs: 0 },
    });

    await expect(client.getCatalogProduct(999999999)).rejects.toBeInstanceOf(
      IHerbNotFoundError,
    );
  });
});

describe("iHerb image URL construction", () => {
  test("constructs known CDN paths from part numbers", () => {
    expect(constructIHerbImage("SPN-02429", 59, "y")?.url).toBe(
      "https://s3.images-iherb.com/spn/spn02429/y/59.jpg",
    );
    expect(constructIHerbImage("CLL-02413", 3)?.url).toBe(
      "https://s3.images-iherb.com/cll/cll02413/g/3.jpg",
    );
    expect(constructIHerbImage("EAT-06940", 1)?.url).toBe(
      "https://s3.images-iherb.com/eat/eat06940/g/1.jpg",
    );
  });

  test("exports only the verified size segments", () => {
    expect(IHERB_IMAGE_SIZE_PIXELS).toEqual({
      c: 160,
      g: 400,
      v: 600,
      y: 800,
      l: 1600,
    });
    expect(IHERB_IMAGE_SIZE_PIXELS).not.toHaveProperty("p");
  });

  test("keeps failed HEAD checks explicit", async () => {
    const image = constructIHerbImage("SPN-02429", 59)!;
    const missing = await verifyIHerbImage(image, {
      fetch: async (_input, init) => {
        expect(init?.method).toBe("HEAD");
        return new Response(null, { status: 404 });
      },
    });

    expect(missing).toMatchObject({
      source: "constructed",
      verification: "missing",
      verificationStatus: 404,
    });
  });
});
