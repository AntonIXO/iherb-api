import { describe, expect, test } from "bun:test";

import {
  bottleMark,
  canonicalIngredientName,
  inferIHerbBrand,
  isNutritionPanelRow,
  normalizeLabelUnit,
  parseLabelDose,
  parseLabelNumber,
  searchCandidateTitle,
  splitTitleSegments,
  titleCaseLabel,
} from "../src/label.js";

describe("parseLabelNumber", () => {
  test("groups thousands and keeps a decimal comma decimal", () => {
    // "1,000 mg" read as a decimal turns a 1000 mg bottle into a 1 mg one.
    expect(parseLabelNumber("1,000")).toBe(1000);
    expect(parseLabelNumber("12,500.5")).toBe(12500.5);
    expect(parseLabelNumber("0,5")).toBe(0.5);
    expect(parseLabelNumber("250")).toBe(250);
  });
});

describe("parseLabelDose", () => {
  test("reads the amount and normalises the unit", () => {
    expect(parseLabelDose("Gold C®, USP Grade Vitamin C, 1,000 mg")).toEqual({
      amount: 1000,
      unit: "mg",
    });
    expect(parseLabelDose("Vitamin B12, 1000 µg, 100 Lozenges")).toEqual({
      amount: 1000,
      unit: "mcg",
    });
    expect(parseLabelDose("Vitamin D3, 5000 IU")).toEqual({
      amount: 5000,
      unit: "IU",
    });
    expect(parseLabelDose("240 Veggie Capsules")).toEqual({
      amount: null,
      unit: "",
    });
  });
});

describe("normalizeLabelUnit", () => {
  test("maps every microgram spelling to mcg and rejects non-units", () => {
    for (const unit of ["µg", "μg", "ug", "mcg", "MCG"]) {
      expect(normalizeLabelUnit(unit)).toBe("mcg");
    }
    expect(normalizeLabelUnit("iu")).toBe("IU");
    expect(normalizeLabelUnit("capsule")).toBe("");
  });
});

describe("splitTitleSegments", () => {
  test("does not split inside parentheses or grouped numbers", () => {
    expect(
      splitTitleSegments(
        "Vitamin D3 (as Cholecalciferol, from Lanolin), 1,000 IU, 90 Softgels",
      ),
    ).toEqual([
      "Vitamin D3 (as Cholecalciferol, from Lanolin)",
      "1,000 IU",
      "90 Softgels",
    ]);
  });
});

describe("inferIHerbBrand", () => {
  test("canonicalises a supplied brand and reads one from a title", () => {
    expect(inferIHerbBrand("anything", "now foods")).toBe("NOW Foods");
    expect(
      inferIHerbBrand("Doctor's Best, Quercetin Bromelain, 180 Veggie Caps"),
    ).toBe("Doctor's Best");
    expect(inferIHerbBrand("Unknown Label, Creatine, 500 g")).toBeNull();
  });
});

describe("canonicalIngredientName", () => {
  test("reduces a bottle title to the active ingredient", () => {
    expect(
      canonicalIngredientName("Nutricost, Quercetin, 500 mg, 120 Capsules"),
    ).toBe("Quercetin");
    expect(
      canonicalIngredientName(
        "Sports Research, Omega-3 Fish Oil, Triple Strength, 1250 mg, 90 Softgels",
      ),
    ).toBe("Omega-3 Fish Oil");
    expect(
      canonicalIngredientName(
        "California Gold Nutrition, Sport, Creatine Monohydrate, 5 g, 16 oz (454 g)",
        "California Gold Nutrition",
      ),
    ).toBe("Creatine Monohydrate");
  });

  test("drops a pharmacopoeia grade so one substance stays one entry", () => {
    // "USP Grade Vitamin C" and "Vitamin C" are the same molecule.
    expect(
      canonicalIngredientName(
        "Gold C®, USP Grade Vitamin C, 1,000 mg, 240 Veggie Capsules",
        "California Gold Nutrition",
      ),
    ).toBe("Vitamin C");
  });

  test("keeps multi-ingredient Supplement Facts rows intact", () => {
    expect(canonicalIngredientName("Calcium, Magnesium, Zinc")).toBe(
      "Calcium, Magnesium, Zinc",
    );
    expect(
      canonicalIngredientName("Vitamin D (as Cholecalciferol, from Lanolin)"),
    ).toBe("Vitamin D (as Cholecalciferol, From Lanolin)");
  });

  test("prefers an unmarked segment over a trademarked one", () => {
    // Live iHerb product 103273. The ® segment is the ingredient supplier's
    // brand; the ingredient is the segment WITHOUT the mark. Without this the
    // answer was "Albion Traacs".
    expect(
      canonicalIngredientName(
        "Magnesium Bisglycinate Chelate, Albion TRAACS®, 60 Veggie Capsules (100 mg per Capsule)",
        "California Gold Nutrition",
      ),
    ).toBe("Magnesium Bisglycinate Chelate");
  });

  test("drops a trailing trademarked token from the ingredient", () => {
    // Live iHerb product 137787: the ingredient is the phytosome, "Quercefit"
    // is the branded form of it and belongs in the bottle name instead.
    expect(
      canonicalIngredientName(
        "Quercetin Phytosome Quercefit®, 250 mg, 60 Veggie Capsules",
        "California Gold Nutrition",
      ),
    ).toBe("Quercetin Phytosome");
    // Two words: the mark IS the segment, so nothing is dropped.
    expect(
      canonicalIngredientName(
        "Gold C®, 1,000 mg, 240 Veggie Capsules",
        "California Gold Nutrition",
      ),
    ).toBe("Gold C");
  });
});

describe("bottleMark", () => {
  test("keeps only the mark printed on the bottle", () => {
    expect(
      bottleMark(
        "Gold C®, USP Grade Vitamin C, 1,000 mg, 240 Veggie Capsules",
        "California Gold Nutrition",
      ),
    ).toBe("Gold C");
    expect(
      bottleMark(
        "Quercetin Phytosome Quercefit®, 250 mg, 60 Veggie Capsules",
        "California Gold Nutrition",
      ),
    ).toBe("Quercefit");
  });

  test("preserves the label's own casing for a proper noun", () => {
    expect(
      bottleMark(
        "Magnesium Bisglycinate Chelate, Albion TRAACS®, 60 Veggie Capsules (100 mg per Capsule)",
        "California Gold Nutrition",
      ),
    ).toBe("Albion TRAACS");
  });

  test("falls back to the leading informative segment and to nothing", () => {
    expect(
      bottleMark(
        "Life Extension, Two-Per-Day Multivitamin, 120 Capsules",
        "Life Extension",
      ),
    ).toBe("Two-Per-Day Multivitamin");
    expect(bottleMark("", "NOW Foods")).toBe("");
  });
});

describe("titleCaseLabel and isNutritionPanelRow", () => {
  test("preserves acronyms and unit casing", () => {
    expect(titleCaseLabel("5-htp with epa and dha 500 MG")).toBe(
      "5-HTP With EPA And DHA 500 mg",
    );
  });

  test("recognises nutrition panel rows", () => {
    expect(isNutritionPanelRow("Calories")).toBe(true);
    expect(isNutritionPanelRow("Total Carbohydrate")).toBe(true);
    expect(isNutritionPanelRow("Quercetin Phytosome")).toBe(false);
  });
});

describe("searchCandidateTitle", () => {
  test("makes a lowercase sitemap slug readable", () => {
    expect(
      searchCandidateTitle(
        "california gold nutrition gold c usp grade vitamin c 1000 mg",
      ),
    ).toBe("California Gold Nutrition Gold C Usp Grade Vitamin C 1000 mg");
  });
});
