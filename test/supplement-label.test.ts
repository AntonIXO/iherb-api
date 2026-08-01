import { describe, expect, test } from "bun:test";

import {
  catalogServingUnits,
  extractCatalogLabel,
  extractProductLabel,
  firstCatalogFact,
  summarizeSearchCandidates,
} from "../src/supplement-label.js";
import type {
  IHerbCatalogProductDetails,
  IHerbProduct,
  ProductSearchCandidate,
  SupplementFact,
} from "../src/types.js";

function fact(
  name: string,
  amount: number | null,
  unit: string | null,
): SupplementFact {
  return {
    name,
    sourceForms: [],
    amount,
    unit,
    dailyValuePercent: null,
    rawAmount: amount && unit ? `${amount} ${unit}` : null,
    rawDailyValue: null,
    rawCells: [name, amount && unit ? `${amount} ${unit}` : ""],
  };
}

function product(overrides: Partial<IHerbProduct> = {}): IHerbProduct {
  const base: IHerbProduct = {
    productId: "103274",
    groupId: null,
    partNumber: null,
    url: "https://www.iherb.com/pr/example/103274",
    name: "California Gold Nutrition, Magnesium Bisglycinate, 200 mg, 240 Veggie Capsules",
    brand: { code: "CGN", name: "California Gold Nutrition" },
    category: { rootName: "Supplements", rootId: null, breadcrumbs: [] },
    price: { amount: 20, formatted: "$20.00", currency: "USD" },
    availability: {
      status: "in_stock",
      availableToPurchase: true,
      rawStockStatus: 1,
    },
    images: [],
    rating: { value: 4.8, count: 100 },
    package: {
      quantity: { amount: 240, unit: "capsules", raw: "240 capsules" },
      formFactor: "capsule",
      partNumber: null,
      dimensions: { metric: null, imperial: null },
      shippingWeight: { metric: null, imperial: null },
    },
    servingSize: { amount: 2, unit: "capsules", raw: "2 capsules" },
    servingsPerContainer: 120,
    facts: [fact("Magnesium Bisglycinate", 200, "mg")],
    suggestedUse: null,
    otherIngredients: null,
    warnings: null,
    description: null,
    expirationDate: null,
    countryOfOrigin: null,
    derived: {
      perUnitFacts: [
        {
          ...fact("Magnesium Bisglycinate", 200, "mg"),
          perUnitAmount: 100,
          servingUnits: 2,
        },
      ],
    },
    diagnostics: [],
  };
  return { ...base, ...overrides };
}

function catalogProduct(
  overrides: Partial<IHerbCatalogProductDetails> = {},
): IHerbCatalogProductDetails {
  const base: IHerbCatalogProductDetails = {
    productId: "137787",
    url: "https://www.iherb.com/pr/example/137787",
    brand: { code: "CGN", name: "California Gold Nutrition" },
    displayName: "Quercetin Phytosome Quercefit®, 250 mg, 60 Veggie Capsules",
    partNumber: "SPN-02429",
    primaryImageIndex: 59,
    imageIndices: [59],
    packageQuantity: "60 count",
    imageUrl: "https://s3.images-iherb.com/spn/spn02429/g/59.jpg",
    image: null,
    supplementFacts: {
      kind: "untrusted_external_html",
      value:
        "<table><tr><td>Supplement Facts</td></tr><tr><td>Serving Size: 1 Capsule</td></tr><tr><td>Servings Per Container: 60</td></tr><tr><td>Quercetin Phospholipid Matrix</td><td>250 mg</td><td>†</td></tr></table>",
    },
    ingredients: null,
    suggestedUse: null,
    warnings: null,
    description: null,
  };
  return { ...base, ...overrides };
}

describe("firstCatalogFact / catalogServingUnits", () => {
  test("skips nutrition-panel rows and reads the serving size", () => {
    const html =
      "<table><tr><td>Serving Size: 2 Capsules</td></tr><tr><td>Calories</td><td>5</td></tr><tr><td>Total Carbohydrate</td><td>1 g</td></tr><tr><td>Vitamin C (as ascorbic acid)</td><td>1,000 mg</td></tr></table>";
    expect(catalogServingUnits(html)).toBe(2);
    // Total Carbohydrate is a panel row; the first ingredient wins.
    expect(firstCatalogFact(html)).toEqual({
      name: "Vitamin C (as ascorbic acid)",
      amount: 1000,
      unit: "mg",
    });
  });
});

describe("extractCatalogLabel", () => {
  test("splits a title into ingredient and bottle mark", () => {
    // The two halves are complementary: "Quercefit" is the branded form of the
    // phytosome, so it names the bottle while the ingredient stays generic.
    expect(extractCatalogLabel(catalogProduct())).toEqual({
      ingredientName: "Quercetin Phytosome",
      bottleName: "Quercefit",
      brandName: "California Gold Nutrition",
      formFactor: "capsule",
      unitDosage: 250,
      unitMeasure: "mg",
      confidence: 0.94,
    });
  });

  test("reads a grouped-thousands dose and drops the pharmacopoeia grade", () => {
    // Live iHerb product 61865. Read as a decimal, "1,000 mg" became 1 mg, and
    // "USP Grade Vitamin C" forked the catalog away from "Vitamin C".
    const label = extractCatalogLabel(
      catalogProduct({
        productId: "61865",
        displayName:
          "Gold C®, USP Grade Vitamin C, 1,000 mg, 240 Veggie Capsules",
        packageQuantity: "240 count",
        supplementFacts: null,
      }),
    );

    expect(label.unitDosage).toBe(1000);
    expect(label.unitMeasure).toBe("mg");
    expect(label.ingredientName).toBe("Vitamin C");
    expect(label.bottleName).toBe("Gold C");
  });

  test("divides a serving amount down to one unit", () => {
    // Serving Size: 2 Capsules with 200 mg per serving is 100 mg per capsule.
    const label = extractCatalogLabel(
      catalogProduct({
        displayName: "Magnesium Bisglycinate, 200 mg, 240 Veggie Capsules",
        supplementFacts: {
          kind: "untrusted_external_html",
          value:
            "<table><tr><td>Serving Size: 2 Capsules</td></tr><tr><td>Magnesium Bisglycinate</td><td>200 mg</td></tr></table>",
        },
      }),
    );
    expect(label.unitDosage).toBe(100);
  });
});

describe("extractProductLabel", () => {
  test("uses the per-unit fact rather than the per-serving amount", () => {
    expect(extractProductLabel(product())).toEqual({
      ingredientName: "Magnesium Bisglycinate",
      bottleName: "Magnesium Bisglycinate",
      brandName: "California Gold Nutrition",
      formFactor: "capsule",
      unitDosage: 100,
      unitMeasure: "mg",
      confidence: 0.99,
    });
  });

  test("skips nutrition-panel rows when picking the primary fact", () => {
    const label = extractProductLabel(
      product({
        name: "California Gold Nutrition, Quercetin Phytosome (Quercefit), 250 mg, 60 Veggie Capsules",
        servingSize: { amount: 1, unit: "capsule", raw: "1 capsule" },
        facts: [
          fact("Calories", 5, null),
          fact("Total Carbohydrate", 1, "g"),
          fact("Quercetin Phytosome", 250, "mg"),
        ],
        derived: { perUnitFacts: [] },
      }),
    );

    expect(label.ingredientName).toBe("Quercetin Phytosome");
    expect(label.unitDosage).toBe(250);
    expect(label.unitMeasure).toBe("mg");
  });

  test("falls back to the title dose and form when facts are absent", () => {
    const label = extractProductLabel(
      product({
        name: "NOW Foods, L-Theanine, 200 mg, 120 Veggie Capsules",
        brand: { code: "NOW", name: "NOW Foods" },
        package: { ...product().package, formFactor: "other" },
        facts: [],
        derived: { perUnitFacts: [] },
      }),
    );

    expect(label).toMatchObject({
      ingredientName: "L-Theanine",
      brandName: "NOW Foods",
      formFactor: "capsule",
      unitDosage: 200,
      unitMeasure: "mg",
    });
  });
});

describe("summarizeSearchCandidates", () => {
  const candidate = (
    over: Partial<ProductSearchCandidate> = {},
  ): ProductSearchCandidate => ({
    productId: "61866",
    groupId: null,
    partNumber: null,
    url: "https://www.iherb.com/pr/example/61866",
    name: "california gold nutrition gold c usp grade vitamin c 500 mg 240 veggie capsules",
    brand: null,
    imageUrl: null,
    price: { amount: null, formatted: null, currency: "USD" },
    availability: {
      status: "unknown",
      availableToPurchase: null,
      rawStockStatus: null,
    },
    packageQuantity: {
      amount: 240,
      unit: "veggie capsules",
      raw: "240 veggie capsules",
    },
    formFactor: "capsule",
    confidence: 0.37,
    scoreReasons: {
      fuzzyName: 0.54,
      brand: 0,
      strength: 0,
      packageQuantity: 0.5,
      formFactor: 0.5,
      partNumber: 0,
    },
    source: "sitemap",
    ...over,
  });

  test("makes a sitemap slug candidate usable in a picker", () => {
    // Deliberately no ingredient name: a slug has no comma structure, so any
    // guess would be "Gold C Usp Grade Vitamin C".
    expect(summarizeSearchCandidates([candidate()])).toEqual([
      {
        productId: "61866",
        url: "https://www.iherb.com/pr/example/61866",
        title:
          "California Gold Nutrition Gold C Usp Grade Vitamin C 500 mg 240 Veggie Capsules",
        brandName: "California Gold Nutrition",
        unitDosage: 500,
        unitMeasure: "mg",
        formFactor: "capsule",
        confidence: 0.37,
      },
    ]);
  });

  test("ranks by confidence, dedupes product ids and honours the limit", () => {
    const summaries = summarizeSearchCandidates(
      [
        candidate({ productId: "1", confidence: 0.2 }),
        candidate({ productId: "2", confidence: 0.9 }),
        candidate({ productId: "2", confidence: 0.8 }),
        candidate({ productId: "3", confidence: 0.5 }),
      ],
      2,
    );
    expect(summaries.map((item) => item.productId)).toEqual(["2", "3"]);
  });

  test("drops candidates without an id or URL rather than emitting a broken link", () => {
    expect(
      summarizeSearchCandidates([
        candidate({ productId: "" }),
        candidate({ url: "" }),
      ]),
    ).toEqual([]);
  });
});
