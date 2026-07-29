export { createIHerbClient, DefaultIHerbClient } from "./client.js";
export {
  IHerbBlockedError,
  IHerbError,
  IHerbHttpError,
  IHerbNotFoundError,
  IHerbParseError,
  IHerbRateLimitError,
} from "./errors.js";
export { parseProductPage } from "./product-parser.js";
export { parseSearchPage } from "./search.js";
export {
  dotenvValue,
  formatIHerbEnv,
  iHerbCookieHeader,
} from "./chrome-cookies.js";
export type { ChromeCookie } from "./chrome-cookies.js";
export {
  BrowserCookieError,
  discoverBrowserProfiles,
  extractIHerbBrowserSession,
  listBrowserProfiles,
} from "./browser-session.js";
export type {
  BrowserChoice,
  BrowserProfile,
  BrowserProfileWithCookieCount,
  ExtractBrowserSessionOptions,
  ExtractedBrowserSession,
  SupportedBrowser,
} from "./browser-session.js";
export type {
  FetchLike,
  CatalogAttribute,
  CatalogKeyIngredient,
  IHerbClient,
  IHerbClientOptions,
  IHerbCatalogProduct,
  IHerbLocale,
  IHerbProduct,
  Money,
  ParsedQuantity,
  PerUnitSupplementFact,
  ProductAvailability,
  ProductFamily,
  ProductFormFactor,
  ProductImage,
  ProductIndexEntry,
  ProductIndexSnapshot,
  ProductPackage,
  ProductRating,
  ProductSearchCandidate,
  ProductSearchResult,
  RateLimitOptions,
  RefreshProductIndexOptions,
  SearchProductsOptions,
  SearchScoreReasons,
  SupplementFact,
} from "./types.js";
