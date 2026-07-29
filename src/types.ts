import type { CookieJar } from "tough-cookie";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
  rateLimit?: RateLimitOptions;
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
  getProduct(
    productIdOrUrl: string | number,
    options?: { signal?: AbortSignal },
  ): Promise<IHerbProduct>;
  refreshProductIndex(
    options?: RefreshProductIndexOptions,
  ): Promise<ProductIndexSnapshot>;
  exportProductIndex(): ProductIndexSnapshot | null;
  importProductIndex(snapshot: ProductIndexSnapshot): void;
}
