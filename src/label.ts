/**
 * Supplement label naming and dosing.
 *
 * An iHerb title is a specification, not a name: "Brand, Ingredient[, product
 * line, marketing…], dose, count form". Turning it into the three things a
 * consumer actually needs — the ingredient, the mark printed on the bottle,
 * and the per-unit dose — is iHerb domain knowledge, so it lives here rather
 * than being re-derived by every application that reads this package.
 */

const UNIT_TOKENS = "mcg|µg|μg|ug|mg|g|kg|iu|ml|l|fl\\.?\\s*oz|oz|lbs?";
const FORM_TOKENS =
  "capsules?|caps?|vcaps?|tablets?|tabs?|softgels?|gels?|gummies|gummy|lozenges?|packets?|packs?|sticks?|strips?|films?|sprays?|powders?|scoops?|servings?|chewables?|pieces?|count|ct";
const PACKAGING_FILLER_TOKENS =
  "veggie|vegetarian|veg|vegan|plant[-\\s]?based|per|each|approx";

/**
 * A dose as printed on a label. The amount alternatives are ordered on
 * purpose: grouped thousands ("1,000 mg") must win over the decimal reading,
 * otherwise `parseFloat("1.000")` reads a 1000 mg bottle as 1 mg.
 */
export const LABEL_DOSE_PATTERN =
  /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)\s*[-_]?\s*(mcg|µg|μg|ug|mg|g|iu|ml)\b/i;

const DOSE_TOKEN_PATTERN = new RegExp(
  `[\\d.,]+\\s*(?:${UNIT_TOKENS})\\b`,
  "gi",
);
const FORM_TOKEN_PATTERN = new RegExp(`\\b(?:${FORM_TOKENS})\\b`, "gi");
const PACKAGING_FILLER_PATTERN = new RegExp(
  `\\b(?:${PACKAGING_FILLER_TOKENS})\\b`,
  "gi",
);

/**
 * Segments describing how the product is sold rather than what is in it.
 * Deliberately narrow: "Complex", "Blend" and "Formula" are part of real
 * ingredient names ("Vitamin B Complex") and must survive.
 */
const MARKETING_SEGMENT_PATTERNS: RegExp[] = [
  /^(?:triple|double|extra|maximum|max|high|super|advanced|ultra|full|complete)\s+(?:strength|potency|absorption|spectrum)$/i,
  /\bflavou?r(?:ed|s)?$/i,
  /^unflavou?red$/i,
  /^(?:non[-\s]?gmo|gluten[-\s]?free|sugar[-\s]?free|dairy[-\s]?free|soy[-\s]?free|vegan|vegetarian|organic|kosher|halal)$/i,
  /^(?:dietary\s+)?supplements?$/i,
  /\bsupport$/i,
  // Purity claims ("98%+ Purity"), but not "Gold Standard 100% Whey".
  /\d\s*%\+?\s*(?:pure|purity|potency|standardized|concentration)\b/i,
];

/**
 * Pharmacopoeia and purity qualifiers that lead an ingredient name but are not
 * part of the substance: "USP Grade Vitamin C" is Vitamin C. A consumer that
 * keeps the qualifier ends up with two catalog entries for one molecule.
 */
const GRADE_PREFIX_PATTERN =
  /^(?:(?:usp|nf|bp|ep|ph\.?\s*eur\.?|jp|fcc|acs|pharmaceutical|food|reagent|clinical|research|lab(?:oratory)?)\s*(?:grade|verified)?\s+)+/i;

/**
 * Product lines, not ingredients. iHerb writes them as their own segment right
 * after the brand ("California Gold Nutrition, Sport, Creatine…").
 */
const PRODUCT_LINE_SEGMENTS = new Set([
  "sport",
  "sports",
  "gold",
  "premium",
  "platinum",
  "elite",
  "pro",
  "performance",
  "essentials",
  "basics",
  "original",
  "classic",
  "kids",
  "junior",
]);

/**
 * Nutrition-panel rows leading the Supplement Facts table of anything with a
 * calorie count. They are never the ingredient a user is tracking.
 */
const NUTRITION_PANEL_ROW_PATTERN =
  /^(?:calories(?:\s+from\s+fat)?|total\s+(?:fat|carbohydrate|sugars?)|saturated\s+fat|trans\s+fat|cholesterol|sodium|potassium|dietary\s+fiber|(?:added\s+)?sugars?|protein|serving\s+size)$/i;

/** Brands whose names are also ingredient words, or that iHerb abbreviates. */
export const KNOWN_IHERB_BRANDS = [
  "California Gold Nutrition",
  "NOW Foods",
  "NOW",
  "Thorne Research",
  "Thorne",
  "Doctor's Best",
  "Life Extension",
  "Jarrow Formulas",
  "Solgar",
  "Source Naturals",
  "Nature's Way",
  "Sports Research",
  "Lake Avenue Nutrition",
  "Super Nutrition",
  "Solaray",
  "Swanson",
  "MegaFood",
  "Bluebonnet Nutrition",
  "Nordic Naturals",
  "21st Century",
  "Carlson",
  "EVLution Nutrition",
  "EVLution",
  "MRM Nutrition",
  "MRM",
  "Codeage",
  "Force Factor",
  "Amazing Nutrition",
  "Nootropics Depot",
  "Garden of Life",
  "Optimum Nutrition",
  "Vital Proteins",
  "Pure Encapsulations",
  "Solumeve",
  "Paradise Herbs",
  "Natural Factors",
  "ALLMAX Nutrition",
  "ALLMAX",
];

const PRESERVED_ACRONYMS = new Set([
  "HTP",
  "NMN",
  "NMNH",
  "EPA",
  "DHA",
  "COQ10",
  "PQQ",
  "B12",
  "B6",
  "B3",
  "B1",
  "IU",
  "NOW",
  "CGN",
]);

const CASED_UNITS = new Set(["mg", "mcg", "g", "ml"]);

/**
 * A number as written on a label. "1,000" is one thousand, "0,5" is a half:
 * a comma before exactly three trailing digits groups, anything else is a
 * decimal separator.
 */
export function parseLabelNumber(value: string): number {
  const compact = String(value ?? "").replace(/\s/g, "");
  const normalized = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(compact)
    ? compact.replace(/,/g, "")
    : compact.replace(",", ".");
  return Number.parseFloat(normalized);
}

function positiveNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Canonical spelling of a dose unit; `""` when the token is not a unit. */
export function normalizeLabelUnit(value: string | null | undefined): string {
  const unit = String(value ?? "").trim();
  if (/^(?:µg|μg|ug|mcg)\b/i.test(unit)) return "mcg";
  if (/^mg\b/i.test(unit)) return "mg";
  if (/^g\b/i.test(unit)) return "g";
  if (/^iu\b/i.test(unit)) return "IU";
  if (/^ml\b/i.test(unit)) return "ml";
  return "";
}

/** The first dose in a label string: `{ amount: 1000, unit: "mg" }`. */
export function parseLabelDose(value: string): {
  amount: number | null;
  unit: string;
} {
  const match = String(value ?? "").match(LABEL_DOSE_PATTERN);
  if (!match) return { amount: null, unit: "" };
  return {
    amount: positiveNumber(parseLabelNumber(match[1] as string)),
    unit: normalizeLabelUnit(match[2]),
  };
}

/** True for Supplement Facts rows that are nutrition panel lines, not actives. */
export function isNutritionPanelRow(name: string): boolean {
  return NUTRITION_PANEL_ROW_PATTERN.test(String(name ?? "").trim());
}

/** Title case that respects supplement acronyms and unit symbols. */
export function titleCaseLabel(value: string): string {
  if (!value) return "";
  return value
    .replace(/\b[a-z0-9]+\b/gi, (word) => {
      const upper = word.toUpperCase();
      if (PRESERVED_ACRONYMS.has(upper)) return upper;
      const lower = word.toLowerCase();
      if (lower === "as") return "as";
      if (CASED_UNITS.has(lower)) return lower;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .replace(/'\S\b/g, (match) => match.toLowerCase());
}

/**
 * The brand for a title or slug. A supplied candidate wins (normalised to its
 * canonical spelling when known); otherwise the title's leading known brand.
 */
export function inferIHerbBrand(
  titleOrSlug: string,
  candidateBrand?: string | null,
): string | null {
  const normalizedCandidateBrand = String(candidateBrand ?? "").trim();
  if (normalizedCandidateBrand) {
    const matchedCanonical = KNOWN_IHERB_BRANDS.find(
      (brand) =>
        brand.toLowerCase().replace(/[^a-z0-9]/g, "") ===
        normalizedCandidateBrand.toLowerCase().replace(/[^a-z0-9]/g, ""),
    );
    return matchedCanonical ?? titleCaseLabel(normalizedCandidateBrand);
  }

  const alphaNumericInput = String(titleOrSlug ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!alphaNumericInput) return null;

  for (const brand of KNOWN_IHERB_BRANDS) {
    if (alphaNumericInput.startsWith(brand.toLowerCase().replace(/[^a-z0-9]/g, ""))) {
      return brand;
    }
  }
  return null;
}

/**
 * Split a title on its top-level commas. Commas inside parentheses
 * ("as Cholecalciferol, from Lanolin") and inside grouped numbers ("1,000 mg")
 * are not separators — splitting on them turned "Vitamin D3" into
 * "Vitamin D3 (as Cholecalciferol".
 */
export function splitTitleSegments(value: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let current = "";

  const text = String(value ?? "");
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);

    const insideNumber =
      /\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "");
    if (char === "," && depth === 0 && !insideNumber) {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current.trim());

  return segments.filter(Boolean);
}

/**
 * True when a segment says how much or how many rather than what: "250 mg",
 * "60 Veggie Capsules", "16 oz (454 g)". Detected by deletion — strip every
 * dose, count, package word and qualifier and see whether a word survives.
 */
function isPackagingSegment(segment: string): boolean {
  return (
    segment
      .replace(/\([^)]*\)/g, " ")
      .replace(DOSE_TOKEN_PATTERN, " ")
      .replace(FORM_TOKEN_PATTERN, " ")
      .replace(PACKAGING_FILLER_PATTERN, " ")
      .replace(/[^a-z]/gi, " ")
      .trim().length === 0
  );
}

function isMarketingSegment(segment: string): boolean {
  return MARKETING_SEGMENT_PATTERNS.some((pattern) => pattern.test(segment));
}

function isProductLineSegment(segment: string): boolean {
  return PRODUCT_LINE_SEGMENTS.has(segment.trim().toLowerCase());
}

/** Trademark and copyright symbols are noise in a stored name. */
function stripMarks(value: string): string {
  return value.replace(/[™®©]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Drop a trailing trademarked token from an ingredient segment.
 *
 * "Quercetin Phytosome Quercefit®" describes its ingredient and then names the
 * branded form of it; the ingredient is everything before the mark. Exactly the
 * rule `bottleMark` uses to pick the mark, applied in reverse. Two-word marks
 * are left alone — there the mark IS the whole segment ("Gold C®").
 */
function stripTrailingMark(segment: string): string {
  if (!/[™®]/.test(segment.trimEnd().slice(-1))) return stripMarks(segment);
  const words = stripMarks(segment).split(/\s+/);
  return words.length >= 3
    ? words.slice(0, -1).join(" ")
    : words.join(" ");
}

function stripGradePrefix(value: string): string {
  return value.replace(GRADE_PREFIX_PATTERN, "").trim() || value;
}

function stripDoseAndFormTail(value: string): string {
  return value
    .replace(/^(?:supplement facts?|dietary supplement)\s*[:–—-]\s*/i, "")
    .replace(
      /\s*[,|;–—-]?\s*(?:\d+\s*)?(?:veggie|vegetarian|veg)?\s*(?:capsules?|caps?|vcaps?|tablets?|tabs?|softgels?|powders?|liquids?|gummies?|lozenges?|packets?|sprays?|strips?|films?)\s*$/i,
      "",
    )
    .replace(new RegExp(`\\s*${LABEL_DOSE_PATTERN.source}\\b`, "gi"), "")
    .replace(/^[\s,|:;–—-]+|[\s,|:;–—-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a product string to its active-ingredient name.
 *
 * Supplement Facts row names arrive here too and are already just the
 * ingredient, so the segment surgery only fires on strings that look like a
 * bottle title — that is, that carry a dose or package segment.
 */
export function canonicalIngredientName(
  value: string | null | undefined,
  brand?: string | null,
): string {
  // Marks are kept until after segmentation: a ™/® is the strongest available
  // signal for "this segment names the product line, not the ingredient".
  let compound = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  const inferredBrand = inferIHerbBrand(stripMarks(compound), brand);
  let brandStripped = false;
  if (inferredBrand) {
    const withoutBrand = compound.replace(
      new RegExp(
        `^\\s*${inferredBrand.replace(/[^a-z0-9]/gi, "[^a-z0-9]?")}(?:\\s*[,|:–—-]\\s*|\\s+)`,
        "i",
      ),
      "",
    );
    brandStripped = withoutBrand !== compound;
    compound = withoutBrand;
  }

  const segments = splitTitleSegments(compound);
  const looksLikeBottleTitle = segments.some(isPackagingSegment);
  const informative = segments.filter(
    (segment) => !isPackagingSegment(segment) && !isMarketingSegment(segment),
  );

  // A ™/® segment is a mark, not an ingredient. When the title carries both
  // kinds, the unmarked segments ARE the ingredient and the leading-segment
  // heuristic below must not run: catalog display names have no brand prefix,
  // so "Magnesium Bisglycinate Chelate, Albion TRAACS®" would otherwise answer
  // "Albion TRAACS", while "Gold C®, USP Grade Vitamin C" needs the second
  // segment. Splitting on the trademark gets both right.
  const unmarked = informative.filter((segment) => !/[™®]/.test(segment));
  if (unmarked.length > 0 && unmarked.length < informative.length) {
    return titleCaseLabel(
      stripGradePrefix(stripDoseAndFormTail(stripMarks(unmarked[0] as string))),
    );
  }

  const candidates = (informative.length > 0 ? informative : segments).map(
    stripTrailingMark,
  );
  if (candidates.length === 0) return "";

  // A bottle title always opens with the brand. When the known-brand list did
  // not recognise it, the leading segment is still the brand — drop it, but
  // only for strings carrying a dose/package tail, so multi-ingredient fact
  // names ("Calcium, Magnesium, Zinc") stay whole.
  if (brandStripped || looksLikeBottleTitle) {
    const remaining = candidates.slice(brandStripped ? 0 : 1);
    const picked =
      remaining.find((segment) => !isProductLineSegment(segment)) ??
      remaining[0] ??
      (candidates[0] as string);
    return titleCaseLabel(stripGradePrefix(stripDoseAndFormTail(picked)));
  }

  return titleCaseLabel(
    stripGradePrefix(stripDoseAndFormTail(candidates.join(", "))),
  );
}

/**
 * The mark printed on the bottle: "Gold C", "Quercefit", "Albion TRAACS".
 *
 * Brand, ingredient, dose and pack size are all separately available, so
 * repeating the whole title as a product name carries no information. What is
 * NOT available elsewhere is the product line / trademark the bottle is sold
 * under, and that is what this returns.
 *
 * The first segment carrying a ® or ™ is the trademarked mark; otherwise the
 * first segment that says something other than dose or packaging. A
 * trademarked phrase of three or more words describes its ingredient before
 * naming it ("Quercetin Phytosome Quercefit®"), so only the trademarked token
 * survives; a two-word mark IS the mark ("Gold C®", "Albion TRAACS®").
 *
 * The label's own casing is preserved: a mark is a proper noun, and title
 * casing turns "Albion TRAACS" into "Albion Traacs".
 */
export function bottleMark(
  title: string | null | undefined,
  brand?: string | null,
): string {
  const raw = String(title ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";

  const inferredBrand = inferIHerbBrand(raw, brand);
  const withoutBrand = inferredBrand
    ? raw.replace(
        new RegExp(
          `^\\s*${inferredBrand.replace(/[^a-z0-9]/gi, "[^a-z0-9]?")}(?:\\s*[,|:–—-]\\s*|\\s+)`,
          "i",
        ),
        "",
      )
    : raw;

  const segments = splitTitleSegments(withoutBrand);
  const informative = segments.filter(
    (segment) => !isPackagingSegment(segment) && !isMarketingSegment(segment),
  );
  const trademarked = informative.find((segment) => /[™®]/.test(segment));
  const picked = trademarked ?? informative[0] ?? segments[0] ?? "";
  if (!picked) return "";

  if (trademarked) {
    const words = picked.replace(/[™®©]/g, "").trim().split(/\s+/);
    if (words.length >= 3 && /[™®]/.test(picked.trimEnd().slice(-1))) {
      return words[words.length - 1] as string;
    }
  }

  return stripDoseAndFormTail(picked.replace(/[™®©]/g, "").trim());
}

/**
 * Readable title for a search candidate. Sitemap-sourced candidates carry a
 * lowercased slug as their name, which is unusable in a product picker.
 */
export function searchCandidateTitle(name: string): string {
  return String(name ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[\p{L}\p{N}]+\b/gu, (word) => {
      const lower = word.toLowerCase();
      if (CASED_UNITS.has(lower)) return lower;
      if (/^\d/.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
}
