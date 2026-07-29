import type {
  ParsedQuantity,
  ProductFormFactor,
  SearchScoreReasons,
} from "./types.js";

const OCR_STOP_WORDS = new Set([
  "supplement",
  "facts",
  "serving",
  "size",
  "amount",
  "daily",
  "value",
  "ingredients",
  "ingredient",
  "suggested",
  "use",
  "directions",
  "warning",
  "warnings",
  "distributed",
  "manufactured",
  "dietary",
  "nutrition",
  "contains",
]);

const FORM_PATTERNS: Array<[ProductFormFactor, RegExp]> = [
  ["softgel", /\b(?:softgels?|soft gels?)\b/i],
  ["capsule", /\b(?:capsules?|veggie capsules?|veg capsules?|veggie caps?|veg caps?)\b/i],
  ["tablet", /\b(?:tablets?|tabs?)\b/i],
  ["powder", /\bpowder\b/i],
  ["liquid", /\b(?:liquid|fl oz|fluid ounces?)\b/i],
  ["gummy", /\b(?:gummies|gummy)\b/i],
  ["lozenge", /\b(?:lozenges?|troches?)\b/i],
  ["packet", /\b(?:packets?|sachets?)\b/i],
  ["spray", /\bsprays?\b/i],
];

const COUNT_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(capsules?|veggie capsules?|veg capsules?|veggie caps?|veg caps?|softgels?|soft gels?|tablets?|tabs?|gummies|gummy|lozenges?|packets?|sachets?|servings?|count|ct)\b/i;

const STRENGTH_PATTERN =
  /(\d+(?:[.,]\d+)?)\s*(mcg|μg|ug|mg|g|iu|ml)\b/gi;

export function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function normalizeText(value: string): string {
  return cleanText(
    value
      .normalize("NFKD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[®™©]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .toLowerCase(),
  );
}

export function compactOcrQuery(value: string): string {
  const tokens = normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !OCR_STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 18).join(" ").slice(0, 180);
}

export function detectFormFactor(value: string): ProductFormFactor {
  for (const [form, pattern] of FORM_PATTERNS) {
    if (pattern.test(value)) return form;
  }
  return "other";
}

export function parsePackageQuantity(value: string): ParsedQuantity | null {
  const match = value.match(COUNT_PATTERN);
  if (!match) return null;
  return {
    amount: Number(match[1]?.replace(",", ".")) || null,
    unit: match[2]?.toLowerCase() ?? null,
    raw: cleanText(match[0]),
  };
}

export function parseQuantity(value: string): ParsedQuantity {
  const cleaned = cleanText(value);
  const match = cleaned.match(
    /(\d+(?:[.,]\d+)?(?:\s*\/\s*\d+(?:[.,]\d+)?)?)\s*([^\d,;()]+)?/i,
  );
  if (!match) return { amount: null, unit: null, raw: cleaned };

  const numeric = match[1]?.replace(/\s/g, "").replace(",", ".") ?? "";
  let amount: number | null;
  if (numeric.includes("/")) {
    const [left, right] = numeric.split("/").map(Number);
    amount = left != null && right ? left / right : null;
  } else {
    const parsed = Number(numeric);
    amount = Number.isFinite(parsed) ? parsed : null;
  }

  return {
    amount,
    unit: cleanText(match[2] ?? "").toLowerCase() || null,
    raw: cleaned,
  };
}

export function extractStrengths(value: string): string[] {
  const strengths: string[] = [];
  for (const match of value.matchAll(STRENGTH_PATTERN)) {
    const amount = match[1]?.replace(",", ".");
    const unit = match[2]?.toLowerCase().replace("μg", "mcg").replace("ug", "mcg");
    if (amount && unit) strengths.push(`${Number(amount)}${unit}`);
  }
  return [...new Set(strengths)];
}

export function extractPartNumber(value: string): string | null {
  return value.match(/\b[A-Z]{2,5}[-\s]\d{3,8}\b/i)?.[0]?.toUpperCase().replace(" ", "-") ?? null;
}

export function productFamilyKey(name: string): string {
  return normalizeText(name)
    .replace(
      /\b\d+(?:[.,]\d+)?\s*(?:capsules?|caps?|softgels?|tablets?|tabs?|gummies|lozenges?|packets?|sachets?|count|ct)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSimilarity(query: string, candidate: string): number {
  const queryTokens = new Set(normalizeText(query).split(" ").filter(Boolean));
  const candidateTokens = new Set(
    normalizeText(candidate).split(" ").filter(Boolean),
  );
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of candidateTokens) {
    if (queryTokens.has(token)) overlap += 1;
  }
  const candidateCoverage = overlap / candidateTokens.size;
  const queryCoverage = overlap / Math.min(queryTokens.size, candidateTokens.size);
  return candidateCoverage * 0.7 + queryCoverage * 0.3;
}

export function scoreProductMatch(
  ocrText: string,
  candidate: {
    name: string;
    brand: string | null;
    partNumber: string | null;
    packageQuantity: ParsedQuantity | null;
    formFactor: ProductFormFactor;
  },
): { confidence: number; reasons: SearchScoreReasons } {
  const normalizedOcr = normalizeText(ocrText);
  const fuzzyName = tokenSimilarity(ocrText, candidate.name);
  const brand = candidate.brand
    ? Number(normalizedOcr.includes(normalizeText(candidate.brand)))
    : 0;
  const requestedStrengths = extractStrengths(ocrText);
  const candidateStrengths = extractStrengths(candidate.name);
  const strength =
    requestedStrengths.length === 0
      ? 0.5
      : Number(requestedStrengths.some((item) => candidateStrengths.includes(item)));
  const requestedPackage = parsePackageQuantity(ocrText);
  const packageQuantity =
    requestedPackage?.amount == null
      ? 0.5
      : Number(requestedPackage.amount === candidate.packageQuantity?.amount);
  const requestedForm = detectFormFactor(ocrText);
  const formFactor =
    requestedForm === "other"
      ? 0.5
      : Number(requestedForm === candidate.formFactor);
  const requestedPartNumber = extractPartNumber(ocrText);
  const partNumber =
    requestedPartNumber == null
      ? 0
      : Number(requestedPartNumber === candidate.partNumber);

  const reasons: SearchScoreReasons = {
    fuzzyName,
    brand,
    strength,
    packageQuantity,
    formFactor,
    partNumber,
  };
  const confidence = Math.min(
    1,
    fuzzyName * 0.52 +
      brand * 0.12 +
      strength * 0.12 +
      packageQuantity * 0.12 +
      formFactor * 0.05 +
      partNumber * 0.25,
  );
  return { confidence, reasons };
}

export function productIdFromUrl(url: string): string | null {
  return new URL(url, "https://www.iherb.com").pathname.match(/\/(\d+)\/?$/)?.[1] ?? null;
}

export function productNameFromUrl(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const slug = parts.at(-2) ?? "";
  return slug
    .split("-")
    .map((part) => (/^\d+$/.test(part) ? part : part))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
