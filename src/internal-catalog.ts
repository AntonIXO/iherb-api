import { IHerbNotFoundError, IHerbParseError } from "./errors.js";
import {
  cleanText,
  detectFormFactor,
  parsePackageQuantity,
  parseQuantity,
} from "./normalize.js";
import { IHerbSession } from "./session.js";
import type {
  CatalogAttribute,
  CatalogKeyIngredient,
  IHerbCatalogProduct,
  ParsedQuantity,
  ProductAvailability,
} from "./types.js";

const CATALOG_API_BASE_URL = "https://catalog.app.iherb.com";
const IMAGE_BASE_URL =
  "https://cloudinary.images-iherb.com/image/upload/" +
  "f_auto,q_auto:eco/images";

interface ComparisonFieldResponse {
  context?: unknown;
  contextId?: unknown;
  displayName?: unknown;
}

interface ComparisonAttributeResponse {
  attributeId?: unknown;
  displayNames?: unknown;
}

interface ComparisonProductResponse {
  rootCategoryId?: unknown;
  rootCategoryLabel?: unknown;
  id?: unknown;
  name?: unknown;
  productName?: unknown;
  partNumber?: unknown;
  url?: unknown;
  brandCode?: unknown;
  brandName?: unknown;
  primaryImageIndex?: unknown;
  rating?: unknown;
  ratingCount?: unknown;
  listPrice?: unknown;
  listPriceAmount?: unknown;
  discountedPrice?: unknown;
  discountedPriceAmount?: unknown;
  groupId?: unknown;
  isOutOfStock?: unknown;
  isNotAvailable?: unknown;
  isDiscontinued?: unknown;
  isAvailableToPurchase?: unknown;
  formattedExpirationDate?: unknown;
  packageQuantity?: unknown;
  dimensionsIn?: unknown;
  dimensionsCm?: unknown;
  weightLb?: unknown;
  weightKg?: unknown;
  attributes?: unknown;
}

interface ComparisonResponse {
  fields?: unknown;
  products?: unknown;
  displayRowsThreshold?: unknown;
}

interface AiValueResponse {
  name?: unknown;
  value?: unknown;
}

interface AiItemResponse {
  comparisonDetails?: {
    keyIngredients?: unknown;
  };
  product?: {
    id?: unknown;
    servingSize?: unknown;
    servingPerContainer?: unknown;
  };
}

interface AiComparisonResponse {
  category?: {
    name?: unknown;
  };
  items?: unknown;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? cleanText(value)
    : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function numericStringOrNull(value: unknown): string | null {
  const parsed = numberOrNull(value);
  return parsed == null ? null : String(parsed);
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function validProductId(value: string | number): string {
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new IHerbNotFoundError(`Invalid iHerb product ID: ${normalized}`);
  }
  return normalized;
}

function quantityOrNull(value: unknown): ParsedQuantity | null {
  const text = stringOrNull(value);
  return text ? parseQuantity(text) : null;
}

function rawAttributes(
  value: unknown,
): ComparisonAttributeResponse[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is ComparisonAttributeResponse =>
          item != null && typeof item === "object",
      )
    : [];
}

function attributesFromResponse(
  product: ComparisonProductResponse,
  fields: ComparisonFieldResponse[],
): CatalogAttribute[] {
  const names = new Map<number, string>();
  for (const field of fields) {
    const id = numberOrNull(field.contextId);
    const name = stringOrNull(field.displayName);
    if (id != null && name) names.set(id, name);
  }

  return rawAttributes(product.attributes).flatMap((attribute) => {
    const id = numberOrNull(attribute.attributeId);
    if (id == null) return [];
    const values = Array.isArray(attribute.displayNames)
      ? attribute.displayNames
          .map(stringOrNull)
          .filter((item): item is string => item != null)
      : [];
    return [{ id, name: names.get(id) ?? null, values }];
  });
}

function attributeValues(
  attributes: CatalogAttribute[],
  id: number,
): string[] {
  return attributes.find((attribute) => attribute.id === id)?.values ?? [];
}

function imageUrl(product: ComparisonProductResponse): string | null {
  const brandCode = stringOrNull(product.brandCode)?.toLowerCase();
  const partNumber = stringOrNull(product.partNumber)
    ?.replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
  const index = numberOrNull(product.primaryImageIndex);
  if (!brandCode || !partNumber || index == null) return null;
  return `${IMAGE_BASE_URL}/${brandCode}/${partNumber}/g/${index}.jpg`;
}

function availability(
  product: ComparisonProductResponse,
): ProductAvailability {
  const discontinued = booleanOrNull(product.isDiscontinued);
  const outOfStock = booleanOrNull(product.isOutOfStock);
  const notAvailable = booleanOrNull(product.isNotAvailable);
  const availableToPurchase = booleanOrNull(product.isAvailableToPurchase);

  let status: ProductAvailability["status"] = "unknown";
  if (discontinued) status = "discontinued";
  else if (outOfStock || notAvailable) status = "out_of_stock";
  else if (availableToPurchase) status = "in_stock";

  return {
    status,
    availableToPurchase,
    rawStockStatus: null,
  };
}

function aiItems(value: unknown): AiItemResponse[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is AiItemResponse =>
          item != null && typeof item === "object",
      )
    : [];
}

function keyIngredients(value: unknown): CatalogKeyIngredient[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: AiValueResponse) => {
    if (item == null || typeof item !== "object") return [];
    const name = stringOrNull(item.name);
    if (!name) return [];
    const rawAmount = stringOrNull(item.value);
    return [{
      name,
      amount: rawAmount ? parseQuantity(rawAmount) : null,
      rawAmount,
      source: "ai_comparison" as const,
    }];
  });
}

function parseCatalogProduct(
  productId: string,
  product: ComparisonProductResponse,
  fields: ComparisonFieldResponse[],
  ai: AiComparisonResponse | null,
  currency: string,
): IHerbCatalogProduct {
  const id = numberOrNull(product.id);
  const name = stringOrNull(product.name);
  const url = stringOrNull(product.url);
  if (id == null || !name || !url) {
    throw new IHerbParseError(
      "The internal iHerb catalog response is missing product identity",
    );
  }

  const attributes = attributesFromResponse(product, fields);
  const aiItem =
    aiItems(ai?.items).find(
      (item) => String(numberOrNull(item.product?.id)) === productId,
    ) ?? null;
  const ingredientValues = keyIngredients(
    aiItem?.comparisonDetails?.keyIngredients,
  );
  const servingRaw =
    stringOrNull(aiItem?.product?.servingSize) ??
    attributeValues(attributes, 166)[0] ??
    null;
  const servingsRaw =
    stringOrNull(aiItem?.product?.servingPerContainer) ??
    attributeValues(attributes, 165)[0] ??
    null;
  const packageRaw = stringOrNull(product.packageQuantity);
  const diagnostics = [
    "Internal catalog JSON does not expose complete Supplement Facts, " +
      "suggested use, other ingredients, warnings, or UPC.",
  ];
  if (ingredientValues.length === 0) {
    diagnostics.push(
      "The AI comparison endpoint did not return key ingredients.",
    );
  } else {
    diagnostics.push(
      "Key ingredients come from iHerb AI comparison metadata and are not " +
        "a replacement for label Supplement Facts.",
    );
  }

  return {
    productId: String(id),
    groupId: numericStringOrNull(product.groupId),
    partNumber: stringOrNull(product.partNumber),
    url,
    name,
    productName: stringOrNull(product.productName),
    brand: {
      code: stringOrNull(product.brandCode),
      name: stringOrNull(product.brandName),
    },
    category: {
      rootName: stringOrNull(product.rootCategoryLabel),
      rootId: numericStringOrNull(product.rootCategoryId),
      comparisonName: stringOrNull(ai?.category?.name),
    },
    price: {
      amount:
        numberOrNull(product.discountedPriceAmount) ??
        numberOrNull(product.listPriceAmount),
      formatted:
        stringOrNull(product.discountedPrice) ??
        stringOrNull(product.listPrice),
      currency,
    },
    availability: availability(product),
    imageUrl: imageUrl(product),
    rating: {
      value: numberOrNull(product.rating),
      count: numberOrNull(product.ratingCount),
    },
    package: {
      quantity: packageRaw
        ? (parsePackageQuantity(packageRaw) ?? parseQuantity(packageRaw))
        : null,
      formFactor: detectFormFactor(`${name} ${packageRaw ?? ""}`),
      partNumber: stringOrNull(product.partNumber),
      dimensions: {
        metric: stringOrNull(product.dimensionsCm),
        imperial: stringOrNull(product.dimensionsIn),
      },
      shippingWeight: {
        metric: stringOrNull(product.weightKg),
        imperial: stringOrNull(product.weightLb),
      },
    },
    servingSize: servingRaw ? parseQuantity(servingRaw) : null,
    servingsPerContainer: quantityOrNull(servingsRaw)?.amount ?? null,
    potency: quantityOrNull(attributeValues(attributes, 3)[0]),
    keyIngredients: ingredientValues,
    attributes,
    certifications: attributeValues(attributes, 88),
    expirationDate: stringOrNull(product.formattedExpirationDate),
    diagnostics,
  };
}

export class InternalCatalogService {
  constructor(private readonly session: IHerbSession) {}

  async getProduct(
    input: string | number,
    options: { signal?: AbortSignal } = {},
  ): Promise<IHerbCatalogProduct> {
    const productId = validProductId(input);
    const requestOptions = options.signal ? { signal: options.signal } : {};
    const [comparison, ai] = await Promise.all([
      this.session.requestJson<ComparisonResponse>(
        `${CATALOG_API_BASE_URL}/recommendations/comparison/${productId}`,
        requestOptions,
      ),
      this.session.requestJson<AiComparisonResponse>(
        `${CATALOG_API_BASE_URL}/recommendations/aicomparison/${productId}`,
        requestOptions,
      ).catch((error: unknown) => {
        if (options.signal?.aborted) throw error;
        return null;
      }),
    ]);

    const products = Array.isArray(comparison?.products)
      ? comparison.products.filter(
          (item): item is ComparisonProductResponse =>
            item != null && typeof item === "object",
        )
      : [];
    const product = products.find(
      (item) => String(numberOrNull(item.id)) === productId,
    );
    if (!product) {
      throw new IHerbNotFoundError(
        `Product ${productId} is absent from the internal iHerb catalog response`,
      );
    }
    const fields = Array.isArray(comparison?.fields)
      ? comparison.fields.filter(
          (item): item is ComparisonFieldResponse =>
            item != null && typeof item === "object",
        )
      : [];
    return parseCatalogProduct(
      productId,
      product,
      fields,
      ai,
      this.session.locale.currency,
    );
  }
}
