/**
 * Label extraction: one product, whatever its source, reduced to the fields an
 * intake tracker stores.
 *
 * Every consumer of this package was writing the same adapter — pick the first
 * real Supplement Facts row, divide by serving size, fall back to the title
 * dose, strip the brand off the ingredient. That logic is iHerb-specific and
 * belongs here, not in each application.
 */

import {
  bottleMark,
  canonicalIngredientName,
  inferIHerbBrand,
  isNutritionPanelRow,
  normalizeLabelUnit,
  parseLabelDose,
  parseLabelNumber,
  searchCandidateTitle,
} from "./label.js";
import { detectFormFactor } from "./normalize.js";
import type {
  IHerbCatalogProductDetails,
  IHerbProduct,
  ProductFormFactor,
  ProductSearchCandidate,
  ProductSearchSummary,
  SupplementLabel,
} from "./types.js";

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence)) return 0;
  return Math.min(Math.max(confidence, 0), 1);
}

function catalogHtmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Servings the Supplement Facts amounts are stated per, from raw label HTML. */
export function catalogServingUnits(html: string): number | null {
  const match = catalogHtmlText(html).match(
    /\bserving\s+size\s*:?\s*(\d+(?:[.,]\d+)?)/i,
  );
  return match ? positiveNumber(parseLabelNumber(match[1] as string)) : null;
}

/** First Supplement Facts row naming an actual ingredient, from raw label HTML. */
export function firstCatalogFact(
  html: string,
): { name: string; amount: number; unit: string } | null {
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(
      (row[1] ?? "").matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi),
      (cell) => catalogHtmlText(cell[1] ?? ""),
    );
    const name = cells[0]?.trim() ?? "";
    const dose = parseLabelDose(cells[1] ?? "");
    if (!name || isNutritionPanelRow(name) || !dose.amount || !dose.unit) {
      continue;
    }
    return { name, amount: dose.amount, unit: dose.unit };
  }
  return null;
}

/**
 * Label fields for a catalog product (`getCatalogProductDetails`).
 *
 * Per-unit dose is the whole point: Supplement Facts state an amount per
 * SERVING, and a serving is frequently two capsules. Storing the serving
 * amount as the capsule amount doubles every exposure downstream.
 */
export function extractCatalogLabel(
  product: IHerbCatalogProductDetails,
): SupplementLabel {
  const productName = String(product.displayName ?? "").trim();
  const brandName = inferIHerbBrand(productName, product.brand?.name ?? null);
  const factsHtml = product.supplementFacts?.value ?? null;
  const fact = factsHtml ? firstCatalogFact(factsHtml) : null;
  const servingUnits = factsHtml ? catalogServingUnits(factsHtml) : null;
  const titleDose = parseLabelDose(productName);
  const perUnit =
    fact && servingUnits
      ? positiveNumber(fact.amount / servingUnits)
      : (fact?.amount ?? null);
  const ingredientName = canonicalIngredientName(
    productName || fact?.name || "",
    brandName,
  );

  return {
    ingredientName,
    bottleName: bottleMark(productName, brandName) || ingredientName,
    brandName,
    formFactor: detectFormFactor(
      `${productName} ${product.packageQuantity ?? ""}`,
    ),
    unitDosage: perUnit ?? titleDose.amount,
    unitMeasure: fact?.unit || titleDose.unit || "mg",
    confidence: fact ? 0.94 : 0.88,
  };
}

/** Label fields for a parsed product page (`getProduct`). */
export function extractProductLabel(product: IHerbProduct): SupplementLabel {
  const facts = Array.isArray(product.facts) ? product.facts : [];
  const perUnitFacts = Array.isArray(product.derived?.perUnitFacts)
    ? product.derived.perUnitFacts
    : [];
  const productName = String(product.name ?? "").trim();
  const brandName = inferIHerbBrand(productName, product.brand?.name ?? null);

  // The first Supplement Facts row of anything with a calorie count is
  // "Calories", not the ingredient — take the first row that names one.
  const fact =
    facts.find((item) => !isNutritionPanelRow(String(item.name ?? ""))) ??
    facts[0];
  const perUnitFact =
    perUnitFacts.find(
      (item) =>
        fact?.name &&
        item.name.trim().toLowerCase() === fact.name.trim().toLowerCase(),
    ) ?? perUnitFacts[0];

  const titleDose = parseLabelDose(productName);
  const servingUnits =
    positiveNumber(perUnitFact?.servingUnits) ??
    positiveNumber(product.servingSize?.amount);
  const factAmount =
    positiveNumber(perUnitFact?.perUnitAmount) ??
    (positiveNumber(fact?.amount) && servingUnits
      ? positiveNumber((fact?.amount ?? 0) / servingUnits)
      : positiveNumber(fact?.amount));
  const ingredientName = canonicalIngredientName(
    fact?.name ?? perUnitFact?.name ?? productName,
    brandName,
  );
  const unitDosage = factAmount ?? titleDose.amount;

  const declaredForm = product.package?.formFactor;
  const formFactor: ProductFormFactor =
    !declaredForm || declaredForm === "other"
      ? detectFormFactor(productName)
      : declaredForm;

  return {
    ingredientName,
    bottleName: bottleMark(productName, brandName) || ingredientName,
    brandName,
    formFactor,
    unitDosage,
    unitMeasure:
      normalizeLabelUnit(perUnitFact?.unit ?? fact?.unit) ||
      titleDose.unit ||
      "mg",
    confidence: clampConfidence(
      0.76 +
        (ingredientName ? 0.08 : 0) +
        (brandName ? 0.04 : 0) +
        (unitDosage ? 0.06 : 0) +
        (fact || perUnitFact ? 0.05 : 0),
    ),
  };
}

/**
 * A search candidate reduced to what a picker can honestly display.
 *
 * No ingredient name is derived here on purpose: a sitemap candidate is a
 * lowercased slug with none of the comma structure a real title has, so
 * `canonicalIngredientName` on it yields "Gold C Usp Grade Vitamin C". Resolve
 * the real label by fetching the product and calling `extractCatalogLabel`.
 */
export function summarizeSearchCandidate(
  candidate: ProductSearchCandidate,
): ProductSearchSummary {
  const title = searchCandidateTitle(candidate.name ?? "");
  const dose = parseLabelDose(title);

  return {
    productId: candidate.productId,
    url: candidate.url,
    title,
    brandName: inferIHerbBrand(title, candidate.brand ?? null),
    unitDosage: dose.amount,
    unitMeasure: dose.unit || "mg",
    formFactor:
      candidate.formFactor && candidate.formFactor !== "other"
        ? candidate.formFactor
        : detectFormFactor(title),
    confidence: clampConfidence(candidate.confidence),
  };
}

/**
 * Rank, dedupe and summarise raw search candidates for a product picker.
 * Candidates without an id or URL are dropped rather than rendered as a
 * broken link.
 */
export function summarizeSearchCandidates(
  candidates: ProductSearchCandidate[],
  limit = 8,
): ProductSearchSummary[] {
  const seen = new Set<string>();
  const summaries: ProductSearchSummary[] = [];

  for (const candidate of [...(candidates ?? [])].sort(
    (a, b) => clampConfidence(b?.confidence) - clampConfidence(a?.confidence),
  )) {
    if (!candidate?.productId || !candidate.url) continue;
    if (seen.has(candidate.productId)) continue;
    seen.add(candidate.productId);
    summaries.push(summarizeSearchCandidate(candidate));
    if (summaries.length >= limit) break;
  }

  return summaries;
}
