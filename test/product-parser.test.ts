import { describe, expect, test } from "bun:test";

import { parseProductPage } from "../src/product-parser.js";

const fixture = await Bun.file(
  new URL("./fixtures/product-magnesium.html", import.meta.url),
).text();

describe("parseProductPage", () => {
  test("extracts identity, label facts and per-unit dosage", () => {
    const product = parseProductPage(
      fixture,
      "https://www.iherb.com/pr/example/103273",
      "USD",
    );

    expect(product.productId).toBe("103273");
    expect(product.groupId).toBe("8227");
    expect(product.brand.name).toBe("California Gold Nutrition");
    expect(product.category.breadcrumbs).toEqual([
      "Categories",
      "Supplements",
      "Magnesium",
    ]);
    expect(product.package.formFactor).toBe("capsule");
    expect(product.package.quantity?.amount).toBe(60);
    expect(product.servingSize).toMatchObject({
      amount: 2,
      unit: "capsules",
    });
    expect(product.servingsPerContainer).toBe(30);
    expect(product.facts).toHaveLength(1);
    expect(product.facts[0]).toMatchObject({
      amount: 200,
      unit: "mg",
      dailyValuePercent: 48,
    });
    expect(product.derived.perUnitFacts[0]?.perUnitAmount).toBe(100);
    expect(product.suggestedUse).toBe("Take 2 capsules daily, with food.");
    expect(product.otherIngredients).toContain("Modified Cellulose");
    expect(product.warnings).toBe("Keep out of reach of children.");
    expect(product.availability.status).toBe("in_stock");
    expect(product.images[0]?.role).toBe("primary");
    expect(product.rating).toEqual({ value: 4.8, count: 26550 });
  });

  test("keeps working when structured label facts are absent", () => {
    const html = fixture.replace(
      /<div class="supplement-facts-container">[\s\S]*?<\/table>\s*<\/div>/,
      "",
    );
    const product = parseProductPage(
      html,
      "https://www.iherb.com/pr/example/103273",
      "USD",
    );
    expect(product.facts).toEqual([]);
    expect(product.diagnostics).toContain(
      "No structured Supplement Facts table was found.",
    );
  });

  test("preserves every active ingredient in a multi-ingredient label", () => {
    const html = fixture
      .replace("2 Capsules", "1 Capsule")
      .replace(
        `<tr>
          <td>Magnesium (from Magnesium Bisglycinate Chelate, Magnesium Oxide)</td>
          <td>200 mg</td>
          <td>48%</td>
        </tr>`,
        `<tr><td>Vitamin D3 (as Cholecalciferol)</td><td>125 mcg</td><td>625%</td></tr>
         <tr><td>Vitamin K2 (as Menaquinone-7)</td><td>120 mcg</td><td>100%</td></tr>`,
      );
    const product = parseProductPage(
      html,
      "https://www.iherb.com/pr/example/103273",
      "USD",
    );
    expect(product.facts.map((fact) => fact.name)).toEqual([
      "Vitamin D3 (as Cholecalciferol)",
      "Vitamin K2 (as Menaquinone-7)",
    ]);
    expect(product.derived.perUnitFacts.map((fact) => fact.perUnitAmount)).toEqual([
      125,
      120,
    ]);
  });

  test("detects powder products without relying on the facts table", () => {
    const html = fixture
      .replace(
        /California Gold Nutrition, Magnesium Bisglycinate Chelate, 60 Veggie Capsules \(100 mg per Capsule\)/g,
        "Doctor's Best, MSM Powder, 8.8 oz (250 g)",
      )
      .replace('data-package-quantity-kg="60 count"', 'data-package-quantity-kg="250 g"');
    const product = parseProductPage(
      html,
      "https://www.iherb.com/pr/example/103273",
      "USD",
    );
    expect(product.package.formFactor).toBe("powder");
  });
});
