import type { CookieJar } from "tough-cookie";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type IHerbRequestTransport = "fetch" | "curl";

export interface IHerbLocale {
  country: string;
  language: string;
  currency: string;
}

export interface RateLimitOptions {
  concurrency?: number;
  minDelayMs?: number;
  maxRetries?: number;
}

export interface IHerbClientOptions {
  baseUrl?: string;
  locale?: Partial<IHerbLocale>;
  cookieJar?: CookieJar;
  cookieHeader?: string | undefined;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string | undefined;
  catalogProductTransport?: IHerbRequestTransport;
  rateLimit?: RateLimitOptions;
}

export type IHerbImageSize = "c" | "g" | "v" | "y" | "l";

export type IHerbImageVerification =
  | "not_checked"
  | "available"
  | "missing"
  | "inconclusive";

export interface IHerbCatalogImage {
  url: string;
  size: IHerbImageSize;
  source: "catalog_response" | "constructed";
  verification: IHerbImageVerification;
  verificationStatus: number | null;
}

/** External HTML that must be treated as text, sanitized, or parsed. */
export interface UntrustedExternalHtml {
  kind: "untrusted_external_html";
  value: string;
}

export type ProductFormFactor =
  | "capsule"
  | "tablet"
  | "powder"
  | "liquid"
  | "softgel"
  | "gummy"
  | "lozenge"
  | "packet"
  | "spray"
  | "other";

export interface Money {
  amount: number | null;
  formatted: string | null;
  currency: string;
}

export interface ProductImage {
  url: string;
  role: "primary" | "gallery";
}

export interface ProductAvailability {
  status:
    | "in_stock"
    | "low_stock"
    | "out_of_stock"
    | "discontinued"
    | "coming_soon"
    | "unknown";
  availableToPurchase: boolean | null;
  rawStockStatus: number | null;
}

export interface ParsedQuantity {
  amount: number | null;
  unit: string | null;
  raw: string;
}

export interface SupplementFact {
  name: string;
  sourceForms: string[];
  amount: number | null;
  unit: string | null;
  dailyValuePercent: number | null;
  rawAmount: string | null;
  rawDailyValue: string | null;
  rawCells: string[];
}

export interface PerUnitSupplementFact extends SupplementFact {
  perUnitAmount: number | null;
  servingUnits: number | null;
}

export interface ProductPackage {
  quantity: ParsedQuantity | null;
  formFactor: ProductFormFactor;
  partNumber: string | null;
  dimensions: {
    metric: string | null;
    imperial: string | null;
  };
  shippingWeight: {
    metric: string | null;
    imperial: string | null;
  };
}

export interface ProductRating {
  value: number | null;
  count: number | null;
}

export interface IHerbProduct {
  productId: string;
  groupId: string | null;
  partNumber: string | null;
  url: string;
  name: string;
  brand: {
    code: string | null;
    name: string | null;
  };
  category: {
    rootName: string | null;
    rootId: string | null;
    breadcrumbs: string[];
  };
  price: Money;
  availability: ProductAvailability;
  images: ProductImage[];
  rating: ProductRating;
  package: ProductPackage;
  servingSize: ParsedQuantity | null;
  servingsPerContainer: number | null;
  facts: SupplementFact[];
  suggestedUse: string | null;
  otherIngredients: string | null;
  warnings: string | null;
  description: string | null;
  expirationDate: string | null;
  countryOfOrigin: string | null;
  derived: {
    perUnitFacts: PerUnitSupplementFact[];
  };
  diagnostics: string[];
}

export interface CatalogAttribute {
  id: number;
  name: string | null;
  values: string[];
}

export interface CatalogKeyIngredient {
  name: string;
  amount: ParsedQuantity | null;
  rawAmount: string | null;
  source: "ai_comparison";
}

/**
 * Product data available from iHerb's internal JSON catalog endpoints.
 *
 * This is intentionally separate from `IHerbProduct`: the internal endpoints
 * expose useful identity, dosage and availability data, but not the complete
 * Supplement Facts label or directions for every product.
 */
export interface IHerbCatalogProduct {
  productId: string;
  groupId: string | null;
  partNumber: string | null;
  url: string;
  name: string;
  productName: string | null;
  brand: {
    code: string | null;
    name: string | null;
  };
  category: {
    rootName: string | null;
    rootId: string | null;
    comparisonName: string | null;
  };
  price: Money;
  availability: ProductAvailability;
  imageUrl: string | null;
  image: IHerbCatalogImage | null;
  rating: ProductRating;
  package: ProductPackage;
  servingSize: ParsedQuantity | null;
  servingsPerContainer: number | null;
  potency: ParsedQuantity | null;
  keyIngredients: CatalogKeyIngredient[];
  attributes: CatalogAttribute[];
  certifications: string[];
  expirationDate: string | null;
  diagnostics: string[];
}

/** Product content returned directly by `catalog.app.iherb.com/product/{id}`. */
export interface IHerbCatalogProductDetails {
  productId: string;
  url: string | null;
  brand: {
    code: string | null;
    name: string | null;
  };
  displayName: string | null;
  partNumber: string | null;
  primaryImageIndex: number | null;
  imageIndices: number[];
  packageQuantity: string | null;
  imageUrl: string | null;
  image: IHerbCatalogImage | null;
  supplementFacts: UntrustedExternalHtml | null;
  ingredients: UntrustedExternalHtml | null;
  suggestedUse: UntrustedExternalHtml | null;
  warnings: UntrustedExternalHtml | null;
  description: UntrustedExternalHtml | null;
}

export interface CatalogProductRequestOptions {
  signal?: AbortSignal;
  imageSize?: IHerbImageSize;
  verifyImage?: boolean;
}

/**
 * A search candidate reduced to what a product picker can honestly show.
 *
 * Deliberately NOT a `SupplementLabel`: a sitemap candidate carries only a
 * lowercased slug, which has none of the comma structure that separates brand,
 * ingredient and pack size in a real title. Guessing an ingredient name from it
 * produces entries like "Gold C Usp Grade Vitamin C". Fetch the product with
 * `getCatalogProductDetails` and use `extractCatalogLabel` once the user picks
 * one.
 */
export interface ProductSearchSummary {
  productId: string;
  url: string;
  title: string;
  brandName: string | null;
  /** Dose read from the candidate name; often present in the slug. */
  unitDosage: number | null;
  unitMeasure: string;
  formFactor: ProductFormFactor;
  confidence: number;
}

/**
 * One product reduced to the fields a supplement tracker stores.
 *
 * `ingredientName` is the substance ("Vitamin C"), free of brand, dose,
 * pharmacopoeia grade and pack size, so the same molecule from two bottles
 * resolves to one catalog entry. `bottleName` is the complementary half: the
 * mark actually printed on the label ("Gold C", "Quercefit"), which is the only
 * part of a title not already captured by the other fields.
 *
 * `unitDosage` is PER UNIT, not per serving — a serving is frequently two
 * capsules, and storing the serving amount doubles every exposure downstream.
 */
export interface SupplementLabel {
  ingredientName: string;
  bottleName: string;
  brandName: string | null;
  formFactor: ProductFormFactor;
  unitDosage: number | null;
  unitMeasure: string;
  confidence: number;
}

export interface SearchScoreReasons {
  fuzzyName: number;
  brand: number;
  strength: number;
  packageQuantity: number;
  formFactor: number;
  partNumber: number;
}

export interface ProductSearchCandidate {
  productId: string;
  groupId: string | null;
  partNumber: string | null;
  url: string;
  name: string;
  brand: string | null;
  imageUrl: string | null;
  price: Money;
  availability: ProductAvailability;
  packageQuantity: ParsedQuantity | null;
  formFactor: ProductFormFactor;
  confidence: number;
  scoreReasons: SearchScoreReasons;
  source: "live" | "sitemap";
}

export interface ProductFamily {
  familyId: string;
  variants: ProductSearchCandidate[];
  variantsComplete: boolean;
  selectedVariantId: string | null;
  confidence: number;
}

export interface ProductSearchResult {
  query: string;
  normalizedQuery: string;
  families: ProductFamily[];
  candidates: ProductSearchCandidate[];
  source: "live" | "sitemap" | "mixed";
  diagnostics: string[];
}

export interface SearchProductsOptions {
  limit?: number;
  sitemapFallback?: boolean;
  signal?: AbortSignal;
}

export interface SearchProductSummariesOptions extends SearchProductsOptions {
  /**
   * Shortest query that is allowed to reach iHerb (default 3). A one or two
   * character query matches most of the sitemap and is never a useful search.
   */
  minQueryLength?: number;
}

export interface ProductIndexEntry {
  productId: string;
  url: string;
  name: string;
  normalizedName: string;
  lastModified: string | null;
}

export interface ProductIndexSnapshot {
  version: 1;
  generatedAt: string;
  entries: ProductIndexEntry[];
}

export interface RefreshProductIndexOptions {
  signal?: AbortSignal;
}

export interface IHerbClient {
  searchProducts(
    ocrText: string,
    options?: SearchProductsOptions,
  ): Promise<ProductSearchResult>;
  /**
   * Ranked, deduped, display-ready search results. Prefer this over
   * `searchProducts` when driving a product picker: it removes the candidate
   * ranking and slug-title handling every consumer was rewriting.
   */
  searchProductSummaries(
    query: string,
    options?: SearchProductSummariesOptions,
  ): Promise<ProductSearchSummary[]>;
  getProduct(
    productIdOrUrl: string | number,
    options?: { signal?: AbortSignal },
  ): Promise<IHerbProduct>;
  getCatalogProduct(
    productId: string | number,
    options?: CatalogProductRequestOptions,
  ): Promise<IHerbCatalogProduct>;
  getCatalogProductDetails(
    productId: string | number,
    options?: CatalogProductRequestOptions,
  ): Promise<IHerbCatalogProductDetails>;
  refreshProductIndex(
    options?: RefreshProductIndexOptions,
  ): Promise<ProductIndexSnapshot>;
  exportProductIndex(): ProductIndexSnapshot | null;
  importProductIndex(snapshot: ProductIndexSnapshot): void;
}
