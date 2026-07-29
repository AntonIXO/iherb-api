import { load } from "cheerio";
import Fuse from "fuse.js";

import {
  IHerbBlockedError,
  IHerbHttpError,
  IHerbParseError,
} from "./errors.js";
import {
  cleanText,
  compactOcrQuery,
  detectFormFactor,
  normalizeText,
  parsePackageQuantity,
  productFamilyKey,
  productIdFromUrl,
  productNameFromUrl,
  scoreProductMatch,
} from "./normalize.js";
import type { IHerbSession } from "./session.js";
import type {
  ProductAvailability,
  ProductFamily,
  ProductIndexEntry,
  ProductIndexSnapshot,
  ProductSearchCandidate,
  ProductSearchResult,
  RefreshProductIndexOptions,
  SearchProductsOptions,
} from "./types.js";

const PRODUCT_SITEMAP_PATTERN = /\/sitemaps\/products-[^/]+\.xml$/i;

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const number = Number(value.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function parseAvailability(
  isOutOfStock: string | undefined,
  isDiscontinued: string | undefined,
  inventoryStatus: string | undefined,
): ProductAvailability {
  const discontinued = isDiscontinued?.toLowerCase() === "true";
  const outOfStock = isOutOfStock?.toLowerCase() === "true";
  const rawStockStatus = inventoryStatus ? Number(inventoryStatus) : null;
  return {
    status: discontinued
      ? "discontinued"
      : outOfStock
        ? "out_of_stock"
        : "in_stock",
    availableToPurchase: discontinued || outOfStock ? false : true,
    rawStockStatus:
      rawStockStatus != null && Number.isFinite(rawStockStatus)
        ? rawStockStatus
        : null,
  };
}

export function parseSearchPage(
  html: string,
  ocrText: string,
  currency: string,
): ProductSearchCandidate[] {
  const $ = load(html);
  const candidates: ProductSearchCandidate[] = [];
  const seen = new Set<string>();

  $(".product.ga-product, .product[itemid^='pid_']").each((_index, element) => {
    const card = $(element);
    const link = card.find("a.product-link[href*='/pr/']").first();
    const href = link.attr("href");
    if (!href) return;

    const productId =
      link.attr("data-product-id") ??
      card.attr("id")?.replace(/^pid_/, "") ??
      productIdFromUrl(href);
    if (!productId || seen.has(productId)) return;

    const name = cleanText(
      link.attr("title") ?? link.attr("aria-label") ?? card.find(".product-title").text(),
    );
    if (!name) return;

    const cartInfoRaw = card.find("[data-cart-info]").first().attr("data-cart-info");
    let cartInfo: Record<string, unknown> | null = null;
    if (cartInfoRaw) {
      try {
        cartInfo = JSON.parse(cartInfoRaw) as Record<string, unknown>;
      } catch {
        cartInfo = null;
      }
    }
    const lineItem = (
      Array.isArray(cartInfo?.lineItems) ? cartInfo.lineItems[0] : null
    ) as Record<string, unknown> | null;

    const brand =
      link.attr("data-ga-brand-name") ??
      (typeof lineItem?.BrandName === "string" ? lineItem.BrandName : null);
    const partNumber =
      link.attr("data-part-number") ??
      (typeof lineItem?.PartNumber === "string" ? lineItem.PartNumber : null);
    const groupId =
      lineItem?.groupId != null ? String(lineItem.groupId) : null;
    const formattedPrice =
      (typeof lineItem?.discountPrice === "string"
        ? lineItem.discountPrice
        : null) ??
      card.find(".price, .price-olp").first().text().trim() ??
      null;
    const amount =
      typeof lineItem?.discountPriceDecimal === "number"
        ? lineItem.discountPriceDecimal
        : parseNumber(link.attr("data-ga-discount-price") ?? formattedPrice ?? undefined);
    const imageUrl =
      (typeof lineItem?.iURLMedium === "string" ? lineItem.iURLMedium : null) ??
      card.find("img").first().attr("src") ??
      null;
    const packageQuantity = parsePackageQuantity(name);
    const formFactor = detectFormFactor(name);
    const scored = scoreProductMatch(ocrText, {
      name,
      brand,
      partNumber,
      packageQuantity,
      formFactor,
    });

    seen.add(productId);
    candidates.push({
      productId,
      groupId,
      partNumber,
      url: new URL(href, "https://www.iherb.com").href,
      name,
      brand,
      imageUrl,
      price: {
        amount,
        formatted: formattedPrice ? cleanText(formattedPrice) : null,
        currency,
      },
      availability: parseAvailability(
        link.attr("data-ga-is-out-of-stock"),
        link.attr("data-ga-is-discontinued"),
        link.attr("data-ga-inventory-status"),
      ),
      packageQuantity,
      formFactor,
      confidence: scored.confidence,
      scoreReasons: scored.reasons,
      source: "live",
    });
  });

  return candidates.sort((left, right) => right.confidence - left.confidence);
}

function buildFamilies(candidates: ProductSearchCandidate[]): ProductFamily[] {
  const groups = new Map<string, ProductSearchCandidate[]>();
  for (const candidate of candidates) {
    const key =
      candidate.groupId != null && candidate.groupId !== "0"
        ? `group:${candidate.groupId}`
        : `family:${productFamilyKey(candidate.name)}`;
    const values = groups.get(key) ?? [];
    values.push(candidate);
    groups.set(key, values);
  }

  return [...groups.entries()]
    .map(([familyId, variants]) => {
      variants.sort((left, right) => right.confidence - left.confidence);
      const first = variants[0];
      const second = variants[1];
      const selectedVariantId =
        first &&
        (first.confidence >= 0.72 ||
          !second ||
          first.confidence - second.confidence >= 0.08)
          ? first.productId
          : null;
      return {
        familyId,
        variants,
        variantsComplete: false,
        selectedVariantId,
        confidence: first?.confidence ?? 0,
      };
    })
    .sort((left, right) => right.confidence - left.confidence);
}

function indexCandidate(
  entry: ProductIndexEntry,
  ocrText: string,
  currency: string,
): ProductSearchCandidate {
  const packageQuantity = parsePackageQuantity(entry.name);
  const formFactor = detectFormFactor(entry.name);
  const scored = scoreProductMatch(ocrText, {
    name: entry.name,
    brand: null,
    partNumber: null,
    packageQuantity,
    formFactor,
  });
  return {
    productId: entry.productId,
    groupId: null,
    partNumber: null,
    url: entry.url,
    name: entry.name,
    brand: null,
    imageUrl: null,
    price: { amount: null, formatted: null, currency },
    availability: {
      status: "unknown",
      availableToPurchase: null,
      rawStockStatus: null,
    },
    packageQuantity,
    formFactor,
    confidence: scored.confidence,
    scoreReasons: scored.reasons,
    source: "sitemap",
  };
}

export class ProductSearchService {
  private snapshot: ProductIndexSnapshot | null = null;

  constructor(private readonly session: IHerbSession) {}

  async search(
    ocrText: string,
    options: SearchProductsOptions = {},
  ): Promise<ProductSearchResult> {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const normalizedQuery = compactOcrQuery(ocrText);
    if (!normalizedQuery) {
      throw new IHerbParseError("OCR text does not contain searchable tokens");
    }

    const diagnostics: string[] = [];
    let liveCandidates: ProductSearchCandidate[] = [];
    try {
      const searchUrl = new URL("/search", this.session.baseUrl);
      searchUrl.searchParams.set("kw", normalizedQuery);
      const html = await this.session.requestText(searchUrl, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      liveCandidates = parseSearchPage(
        html,
        ocrText,
        this.session.locale.currency,
      );
    } catch (error) {
      if (
        !options.sitemapFallback ||
        !(
          error instanceof IHerbBlockedError ||
          error instanceof IHerbHttpError
        )
      ) {
        throw error;
      }
      diagnostics.push("Live search was blocked; used the product sitemap index.");
    }

    if (liveCandidates.length > 0) {
      const candidates = liveCandidates.slice(0, limit);
      return {
        query: ocrText,
        normalizedQuery,
        families: buildFamilies(candidates),
        candidates,
        source: "live",
        diagnostics,
      };
    }

    if (options.sitemapFallback === false) {
      return {
        query: ocrText,
        normalizedQuery,
        families: [],
        candidates: [],
        source: "live",
        diagnostics,
      };
    }

    if (!this.snapshot) {
      await this.refresh({
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    const entries = this.snapshot?.entries ?? [];
    const fuse = new Fuse(entries, {
      keys: ["name"],
      threshold: 0.58,
      ignoreLocation: true,
      includeScore: true,
    });
    const fuzzyCandidates = fuse
      .search(normalizedQuery, { limit: limit * 2 })
      .map((result) =>
        indexCandidate(result.item, ocrText, this.session.locale.currency),
      );
    const tokenCandidates = entries
      .map((entry) =>
        indexCandidate(entry, ocrText, this.session.locale.currency),
      )
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, limit * 2);
    const merged = new Map<string, ProductSearchCandidate>();
    for (const candidate of [...fuzzyCandidates, ...tokenCandidates]) {
      const existing = merged.get(candidate.productId);
      if (!existing || candidate.confidence > existing.confidence) {
        merged.set(candidate.productId, candidate);
      }
    }
    const candidates = [...merged.values()]
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, limit);
    diagnostics.push("Product candidates came from the sitemap index.");
    return {
      query: ocrText,
      normalizedQuery,
      families: buildFamilies(candidates),
      candidates,
      source: "sitemap",
      diagnostics,
    };
  }

  async refresh(
    options: RefreshProductIndexOptions = {},
  ): Promise<ProductIndexSnapshot> {
    const sitemapIndex = await this.session.requestText("/sitemap_index.xml", {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const $index = load(sitemapIndex, { xmlMode: true });
    const sitemapUrls = $index("sitemap > loc")
      .map((_index, element) => $index(element).text().trim())
      .get()
      .filter((url) => PRODUCT_SITEMAP_PATTERN.test(new URL(url).pathname));
    if (sitemapUrls.length === 0) {
      throw new IHerbParseError("No iHerb product sitemaps were found");
    }

    const documents = await Promise.all(
      sitemapUrls.map((url) =>
        this.session.requestText(url, {
          ...(options.signal ? { signal: options.signal } : {}),
        }),
      ),
    );
    const entries: ProductIndexEntry[] = [];
    for (const document of documents) {
      const $ = load(document, { xmlMode: true });
      $("url").each((_index, element) => {
        const url = $(element).find("loc").text().trim();
        const productId = productIdFromUrl(url);
        if (!productId) return;
        const name = productNameFromUrl(url);
        entries.push({
          productId,
          url,
          name,
          normalizedName: normalizeText(name),
          lastModified: $(element).find("lastmod").text().trim() || null,
        });
      });
    }
    this.snapshot = {
      version: 1,
      generatedAt: new Date().toISOString(),
      entries,
    };
    return this.snapshot;
  }

  export(): ProductIndexSnapshot | null {
    return this.snapshot == null
      ? null
      : {
          ...this.snapshot,
          entries: [...this.snapshot.entries],
        };
  }

  import(snapshot: ProductIndexSnapshot): void {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
      throw new IHerbParseError("Unsupported product index snapshot");
    }
    this.snapshot = {
      version: 1,
      generatedAt: snapshot.generatedAt,
      entries: [...snapshot.entries],
    };
  }

  async resolveProductUrl(
    productId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!this.snapshot) {
      await this.refresh({ ...(signal ? { signal } : {}) });
    }
    return (
      this.snapshot?.entries.find((entry) => entry.productId === productId)?.url ??
      null
    );
  }
}
