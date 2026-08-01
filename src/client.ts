import { CatalogProductDetailsService } from "./catalog-product.js";
import { IHerbNotFoundError } from "./errors.js";
import { InternalCatalogService } from "./internal-catalog.js";
import { productIdFromUrl } from "./normalize.js";
import { parseProductPage } from "./product-parser.js";
import { ProductSearchService } from "./search.js";
import { IHerbSession } from "./session.js";
import { summarizeSearchCandidates } from "./supplement-label.js";
import type {
  CatalogProductRequestOptions,
  IHerbClient,
  IHerbClientOptions,
  IHerbCatalogProduct,
  IHerbCatalogProductDetails,
  IHerbProduct,
  ProductIndexSnapshot,
  ProductSearchResult,
  ProductSearchSummary,
  RefreshProductIndexOptions,
  SearchProductSummariesOptions,
  SearchProductsOptions,
} from "./types.js";

export class DefaultIHerbClient implements IHerbClient {
  private readonly session: IHerbSession;
  private readonly searchService: ProductSearchService;
  private readonly internalCatalog: InternalCatalogService;
  private readonly catalogProductDetails: CatalogProductDetailsService;

  constructor(options: IHerbClientOptions = {}) {
    this.session = new IHerbSession(options);
    this.searchService = new ProductSearchService(this.session);
    this.internalCatalog = new InternalCatalogService(
      this.session,
      options.fetch,
    );
    this.catalogProductDetails = new CatalogProductDetailsService(
      this.session,
      options.catalogProductTransport ?? "curl",
      options.fetch,
    );
  }

  searchProducts(
    ocrText: string,
    options?: SearchProductsOptions,
  ): Promise<ProductSearchResult> {
    return this.searchService.search(ocrText, {
      sitemapFallback: true,
      ...options,
    });
  }

  /**
   * Display-ready search results for a product picker.
   *
   * Never rejects on an upstream failure: a blocked or slow iHerb must degrade
   * to "nothing found", not break the caller's UI. A query shorter than
   * `minQueryLength` is answered locally without a request.
   */
  async searchProductSummaries(
    query: string,
    options: SearchProductSummariesOptions = {},
  ): Promise<ProductSearchSummary[]> {
    const { minQueryLength = 3, limit = 8, ...searchOptions } = options;
    const text = String(query ?? "").trim();
    if (text.length < minQueryLength) return [];

    try {
      const result = await this.searchProducts(text, {
        ...searchOptions,
        limit: limit * 2,
      });
      return summarizeSearchCandidates(result.candidates ?? [], limit);
    } catch {
      return [];
    }
  }

  async getProduct(
    productIdOrUrl: string | number,
    options: { signal?: AbortSignal } = {},
  ): Promise<IHerbProduct> {
    let url: string;
    if (
      typeof productIdOrUrl === "number" ||
      /^\d+$/.test(String(productIdOrUrl))
    ) {
      const productId = String(productIdOrUrl);
      const resolved = await this.searchService.resolveProductUrl(
        productId,
        options.signal,
      );
      if (!resolved) {
        throw new IHerbNotFoundError(
          `Product ${productId} is absent from the iHerb product sitemap`,
        );
      }
      url = resolved;
    } else {
      const parsed = new URL(productIdOrUrl);
      if (!/^(?:www\.)?iherb\.com$/i.test(parsed.hostname)) {
        throw new IHerbNotFoundError("Only iherb.com product URLs are supported");
      }
      if (!productIdFromUrl(parsed.href)) {
        throw new IHerbNotFoundError("The URL does not contain an iHerb product ID");
      }
      url = parsed.href;
    }

    const html = await this.session.requestText(url, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return parseProductPage(html, url, this.session.locale.currency);
  }

  getCatalogProduct(
    productId: string | number,
    options: CatalogProductRequestOptions = {},
  ): Promise<IHerbCatalogProduct> {
    return this.internalCatalog.getProduct(productId, options);
  }

  getCatalogProductDetails(
    productId: string | number,
    options: CatalogProductRequestOptions = {},
  ): Promise<IHerbCatalogProductDetails> {
    return this.catalogProductDetails.getProduct(productId, options);
  }

  refreshProductIndex(
    options?: RefreshProductIndexOptions,
  ): Promise<ProductIndexSnapshot> {
    return this.searchService.refresh(options);
  }

  exportProductIndex(): ProductIndexSnapshot | null {
    return this.searchService.export();
  }

  importProductIndex(snapshot: ProductIndexSnapshot): void {
    this.searchService.import(snapshot);
  }
}

export function createIHerbClient(
  options: IHerbClientOptions = {},
): IHerbClient {
  return new DefaultIHerbClient(options);
}
