import { IHerbNotFoundError, IHerbParseError } from "./errors.js";
import {
  constructIHerbImage,
  verifyIHerbImage,
} from "./internal-catalog.js";
import { IHerbSession } from "./session.js";
import type {
  CatalogProductRequestOptions,
  FetchLike,
  IHerbCatalogProductDetails,
  IHerbImageSize,
  IHerbRequestTransport,
  UntrustedExternalHtml,
} from "./types.js";

const CATALOG_PRODUCT_URL = "https://catalog.app.iherb.com/product";

function validProductId(value: string | number): string {
  const normalized = String(value);
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new IHerbNotFoundError(`Invalid iHerb product ID: ${normalized}`);
  }
  return normalized;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function integerArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = integerOrNull(item);
    return parsed == null ? [] : [parsed];
  });
}

function untrustedHtml(value: unknown): UntrustedExternalHtml | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return { kind: "untrusted_external_html", value };
}

export function parseIHerbCatalogProductDetails(
  expectedProductId: string,
  input: unknown,
  imageSize: IHerbImageSize = "g",
): IHerbCatalogProductDetails | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  if (String(data.id ?? "").trim() !== expectedProductId) return null;

  const partNumber = stringOrNull(data.partNumber);
  const primaryImageIndex = integerOrNull(data.primaryImageIndex);
  const image = partNumber && primaryImageIndex != null
    ? constructIHerbImage(partNumber, primaryImageIndex, imageSize)
    : null;

  return {
    productId: expectedProductId,
    url: stringOrNull(data.url),
    brand: {
      code: stringOrNull(data.brandCode),
      name: stringOrNull(data.brandName),
    },
    displayName: stringOrNull(data.displayName),
    partNumber,
    primaryImageIndex,
    imageIndices: integerArray(data.imageIndices),
    packageQuantity: stringOrNull(data.packageQuantity),
    imageUrl: image?.url ?? null,
    image,
    supplementFacts: untrustedHtml(data.supplementFacts),
    ingredients: untrustedHtml(data.ingredients),
    suggestedUse: untrustedHtml(data.suggestedUse),
    warnings: untrustedHtml(data.warnings),
    description: untrustedHtml(data.description),
  };
}

export class CatalogProductDetailsService {
  constructor(
    private readonly session: IHerbSession,
    private readonly transport: IHerbRequestTransport,
    private readonly fetchImpl?: FetchLike,
  ) {}

  async getProduct(
    input: string | number,
    options: CatalogProductRequestOptions = {},
  ): Promise<IHerbCatalogProductDetails> {
    const productId = validProductId(input);
    const response = await this.session.requestJson<unknown>(
      `${CATALOG_PRODUCT_URL}/${productId}`,
      {
        transport: this.transport,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const product = parseIHerbCatalogProductDetails(
      productId,
      response,
      options.imageSize ?? "g",
    );
    if (!product) {
      throw new IHerbParseError(
        `The catalog product response does not match product ${productId}`,
      );
    }
    if (!options.verifyImage || !product.image) return product;

    const image = await verifyIHerbImage(product.image, {
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ...product, imageUrl: image.url, image };
  }
}
