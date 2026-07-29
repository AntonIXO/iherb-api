import type { CheerioAPI } from "cheerio";
import { load } from "cheerio";

import { IHerbParseError } from "./errors.js";
import {
  cleanText,
  detectFormFactor,
  parsePackageQuantity,
  parseQuantity,
  productIdFromUrl,
} from "./normalize.js";
import type {
  IHerbProduct,
  ParsedQuantity,
  ProductAvailability,
  ProductImage,
  SupplementFact,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function parseJsonLd($: CheerioAPI): unknown[] {
  const values: unknown[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      values.push(JSON.parse($(element).text()) as unknown);
    } catch {
      // Invalid analytics JSON-LD should not prevent extraction.
    }
  });
  return values;
}

function flattenJsonLd(values: unknown[]): JsonRecord[] {
  const flattened: JsonRecord[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    flattened.push(record);
    if (Array.isArray(record["@graph"])) record["@graph"].forEach(visit);
  };
  values.forEach(visit);
  return flattened;
}

function jsonLdType(record: JsonRecord, type: string): boolean {
  const value = record["@type"];
  return Array.isArray(value) ? value.includes(type) : value === type;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? cleanText(value) : null;
}

function attrOrNull(
  $: CheerioAPI,
  selector: string,
  attribute: string,
): string | null {
  return stringOrNull($(selector).first().attr(attribute));
}

function metaContent($: CheerioAPI, selector: string): string | null {
  return stringOrNull($(selector).first().attr("content"));
}

function sectionByHeading($: CheerioAPI, heading: string): string | null {
  let result: string | null = null;
  $("h2, h3, h4").each((_index, element) => {
    if (result) return;
    const title = cleanText($(element).text()).toLowerCase();
    if (title !== heading.toLowerCase()) return;
    const container = $(element).parent();
    const content = container
      .find(".prodOverviewDetail, .prodOverviewIngred")
      .first();
    const source = content.length > 0 ? content : $(element).next();
    const paragraphs = source
      .find("p, li")
      .map((_paragraphIndex, paragraph) => cleanText($(paragraph).text()))
      .get()
      .filter(Boolean);
    result = paragraphs.length > 0
      ? paragraphs.join("\n")
      : cleanText(source.text()) || null;
  });
  return result;
}

function parseServingRows(
  $: CheerioAPI,
): {
  servingSize: ParsedQuantity | null;
  servingsPerContainer: number | null;
  facts: SupplementFact[];
} {
  const table = $(".supplement-facts-container table").first();
  if (table.length === 0) {
    return { servingSize: null, servingsPerContainer: null, facts: [] };
  }

  let servingSize: ParsedQuantity | null = null;
  let servingsPerContainer: number | null = null;
  const facts: SupplementFact[] = [];

  table.find("tr").each((_index, row) => {
    const cells = $(row)
      .find("th, td")
      .map((_cellIndex, cell) => cleanText($(cell).text()))
      .get();
    if (cells.length === 0) return;
    const rowText = cells.join(" ");
    const servingMatch = rowText.match(/serving size\s*:?\s*(.+)/i);
    if (servingMatch?.[1]) {
      servingSize = parseQuantity(servingMatch[1]);
      return;
    }
    const containerMatch = rowText.match(
      /servings?\s+per\s+container\s*:?\s*(\d+(?:[.,]\d+)?)/i,
    );
    if (containerMatch?.[1]) {
      servingsPerContainer = numberOrNull(containerMatch[1]);
      return;
    }
    if (
      /supplement facts|amount per serving|daily value/i.test(rowText) ||
      cells.length < 2
    ) {
      return;
    }

    const name = cells[0] ?? "";
    const rawAmount = cells[1] || null;
    const rawDailyValue = cells.at(-1) || null;
    if (!name || !rawAmount || !/\d/.test(rawAmount)) return;
    const amount = parseQuantity(rawAmount);
    const dailyValueMatch = rawDailyValue?.match(/(\d+(?:[.,]\d+)?)\s*%/);
    const sourceForms = [...name.matchAll(/\(([^)]+)\)/g)]
      .map((match) => cleanText(match[1] ?? ""))
      .filter(Boolean);

    facts.push({
      name,
      sourceForms,
      amount: amount.amount,
      unit: amount.unit,
      dailyValuePercent: dailyValueMatch?.[1]
        ? numberOrNull(dailyValueMatch[1])
        : null,
      rawAmount,
      rawDailyValue,
      rawCells: cells,
    });
  });

  return { servingSize, servingsPerContainer, facts };
}

function availabilityFromModel(
  stockStatus: number | null,
  discontinued: boolean,
  available: boolean | null,
  comingSoon: boolean,
): ProductAvailability {
  let status: ProductAvailability["status"] = "unknown";
  if (discontinued) status = "discontinued";
  else if (comingSoon || stockStatus === 8 || stockStatus === 9) status = "coming_soon";
  else if (stockStatus === 1 || stockStatus === 2) status = "low_stock";
  else if ([3, 4, 5, 6, 7].includes(stockStatus ?? -1)) status = "out_of_stock";
  else if ([0, 10, 11].includes(stockStatus ?? -1)) status = "in_stock";
  return {
    status,
    availableToPurchase: available,
    rawStockStatus: stockStatus,
  };
}

function booleanAttr(value: string | null | undefined): boolean | null {
  if (value == null || value === "") return null;
  if (value.toLowerCase() === "true") return true;
  if (value.toLowerCase() === "false") return false;
  return null;
}

function productImages(
  $: CheerioAPI,
  productLd: JsonRecord | null,
): ProductImage[] {
  const urls: string[] = [];
  const ldImages = productLd?.image ?? productLd?.logo;
  if (Array.isArray(ldImages)) {
    for (const image of ldImages) {
      if (typeof image === "string") urls.push(image);
    }
  } else if (typeof ldImages === "string") {
    urls.push(ldImages);
  }
  $("meta[property='og:image']").each((_index, element) => {
    const content = $(element).attr("content");
    if (content) urls.push(content);
  });
  const primary = attrOrNull($, "#modelProperties", "data-product-primary-image-url");
  if (primary) urls.unshift(primary);
  return [...new Set(urls)].map((url, index) => ({
    url,
    role: index === 0 ? "primary" : "gallery",
  }));
}

function breadcrumbs(records: JsonRecord[]): string[] {
  const breadcrumb = records.find((record) =>
    jsonLdType(record, "BreadcrumbList"),
  );
  if (!breadcrumb || !Array.isArray(breadcrumb.itemListElement)) return [];
  return breadcrumb.itemListElement
    .map(asRecord)
    .map((item) => asRecord(item?.item)?.name)
    .filter((name): name is string => typeof name === "string")
    .map(cleanText);
}

export function parseProductPage(
  html: string,
  requestedUrl: string,
  currency: string,
): IHerbProduct {
  const $ = load(html);
  const model = $("#modelProperties").first();
  const jsonLd = flattenJsonLd(parseJsonLd($));
  const productLd =
    jsonLd.find((record) => jsonLdType(record, "Product")) ?? null;

  const productId =
    stringOrNull(model.attr("data-product-id")) ??
    stringOrNull(productLd?.productID) ??
    productIdFromUrl(requestedUrl);
  const name =
    stringOrNull(model.attr("data-product-name")) ??
    stringOrNull(productLd?.name) ??
    stringOrNull(cleanText($("h1").first().text()));
  if (!productId || !name) {
    throw new IHerbParseError("The page is not a recognizable iHerb product page");
  }

  const canonical =
    attrOrNull($, "link[rel='canonical']", "href") ??
    metaContent($, "meta[property='og:url']") ??
    requestedUrl;
  const brandRecord = asRecord(productLd?.brand);
  const offers = asRecord(
    Array.isArray(productLd?.offers) ? productLd.offers[0] : productLd?.offers,
  );
  const aggregateRating = asRecord(productLd?.aggregateRating);
  const modelPrice =
    stringOrNull(model.attr("data-discounted-price")) ??
    stringOrNull(model.attr("data-list-price"));
  const stockStatus = numberOrNull(model.attr("data-stock-status"));
  const available = booleanAttr(model.attr("data-available-to-purchase"));
  const discontinued = booleanAttr(model.attr("data-is-discontinued")) ?? false;
  const comingSoon = booleanAttr(model.attr("data-is-coming-soon")) ?? false;
  const serving = parseServingRows($);
  const packageRaw =
    stringOrNull(model.attr("data-package-quantity-kg")) ??
    parsePackageQuantity(name)?.raw ??
    null;
  const packageQuantity = packageRaw
    ? (parsePackageQuantity(packageRaw) ?? parseQuantity(packageRaw))
    : null;
  const diagnostics: string[] = [];
  if (serving.facts.length === 0) {
    diagnostics.push("No structured Supplement Facts table was found.");
  }
  if (serving.servingSize?.amount == null) {
    diagnostics.push("Per-unit amounts could not be derived from serving size.");
  }

  const perUnitFacts = serving.facts.map((fact) => ({
    ...fact,
    perUnitAmount:
      fact.amount != null &&
      serving.servingSize?.amount != null &&
      serving.servingSize.amount > 0
        ? fact.amount / serving.servingSize.amount
        : null,
    servingUnits: serving.servingSize?.amount ?? null,
  }));

  return {
    productId,
    groupId: stringOrNull(model.attr("data-group-id")),
    partNumber:
      stringOrNull(model.attr("data-part-number")) ??
      stringOrNull(productLd?.mpn),
    url: new URL(canonical, requestedUrl).href,
    name,
    brand: {
      code: stringOrNull(model.attr("data-brand-code")),
      name:
        stringOrNull(model.attr("data-brand-name")) ??
        stringOrNull(brandRecord?.name),
    },
    category: {
      rootName:
        stringOrNull(model.attr("data-en-root-category-name")) ??
        stringOrNull(model.attr("data-root-category-name")),
      rootId: stringOrNull(model.attr("data-root-category-id")),
      breadcrumbs: breadcrumbs(jsonLd),
    },
    price: {
      amount:
        numberOrNull(model.attr("data-numeric-discounted-price")) ??
        numberOrNull(model.attr("data-numeric-list-price")) ??
        numberOrNull(offers?.price),
      formatted: modelPrice,
      currency: stringOrNull(offers?.priceCurrency) ?? currency,
    },
    availability: availabilityFromModel(
      stockStatus,
      discontinued,
      available,
      comingSoon,
    ),
    images: productImages($, productLd),
    rating: {
      value: numberOrNull(aggregateRating?.ratingValue),
      count: numberOrNull(aggregateRating?.reviewCount),
    },
    package: {
      quantity: packageQuantity,
      formFactor: detectFormFactor(`${name} ${packageRaw ?? ""}`),
      partNumber:
        stringOrNull(model.attr("data-part-number")) ??
        stringOrNull(productLd?.mpn),
      dimensions: {
        metric: stringOrNull(model.attr("data-dimensions-cm")),
        imperial: stringOrNull(model.attr("data-dimensions-in")),
      },
      shippingWeight: {
        metric: stringOrNull(model.attr("data-shipping-weight-kg")),
        imperial: stringOrNull(model.attr("data-shipping-weight-lb")),
      },
    },
    servingSize: serving.servingSize,
    servingsPerContainer: serving.servingsPerContainer,
    facts: serving.facts,
    suggestedUse: sectionByHeading($, "Suggested use"),
    otherIngredients: sectionByHeading($, "Other ingredients"),
    warnings: sectionByHeading($, "Warnings"),
    description:
      sectionByHeading($, "Description") ??
      stringOrNull(productLd?.description) ??
      metaContent($, "meta[name='description']"),
    expirationDate: stringOrNull(model.attr("data-earlier-date-expire")),
    countryOfOrigin: stringOrNull(model.attr("data-country-of-origin")),
    derived: { perUnitFacts },
    diagnostics,
  };
}
