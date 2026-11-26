import { z } from "zod";
import { DICT_VERSION } from "./dictionaries.js";

export const PRODUCT_STATUSES = ["available", "unavailable", "unknown", "blocked", "error"];
export const EVIDENCE_VALUES = [
  "error",
  "unavailable",
  "stock-count",
  "snapshot",
  "blocked",
  "official-order",
  "unverified"
];

export const StatusEnum = z.enum(["available", "unavailable", "unknown", "blocked", "error"]);

export const VerificationSchema = z
  .object({
    state: z.enum(["verified", "unverified", "historical"]),
    priceKind: z.enum(["observed", "reference", "historical"]),
    observedAt: z.string().nullable().optional(),
    attemptedAt: z.string().nullable().optional(),
    verifiedAt: z.string().nullable().optional(),
    lastKnownStatus: z.string().nullable().optional(),
    lastVerifiedQuote: z
      .object({
        price: z.string().nullable().optional(),
        priceValue: z.number().nullable().optional(),
        currency: z.string().nullable().optional(),
        at: z.string().nullable().optional()
      })
      .nullable()
      .optional()
  })
  .passthrough();

export const EvidenceLevelObjectSchema = z
  .object({
    value: z.enum(EVIDENCE_VALUES),
    label: z.string().min(1),
    className: z.string().min(1),
    rank: z.number().int().optional()
  })
  .passthrough();

export const RiskTagObjectSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
    severity: z.string().min(1)
  })
  .passthrough();

export const RadarEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["restock", "soldout", "price"]),
    at: z.string().min(1),
    productId: z.string().min(1),
    provider: z.string().min(1),
    providerId: z.string().nullable(),
    name: z.string().min(1),
    region: z.string().nullable(),
    price: z.string().nullable(),
    priceValue: z.number().nonnegative().nullable(),
    previousPrice: z.string().nullable().optional(),
    previousPriceValue: z.number().nonnegative().nullable().optional(),
    currency: z.string().nullable(),
    stockCount: z.number().int().nonnegative().nullable(),
    orderUrl: z.string().nullable()
  })
  .passthrough();

export const FxSnapshotSchema = z
  .object({
    base: z.literal("CNY"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    fetchedAt: z.string().optional(),
    source: z.string().optional(),
    rates: z.record(z.string(), z.number().positive())
  })
  .passthrough();

export const FullProductSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    provider: z.string().min(1),
    providerId: z.string().nullable().optional(),
    category: z.string().min(1),
    adapter: z.string().min(1),
    sourceUrl: z.string().min(1),
    finalUrl: z.string().nullable().optional(),
    fetchedAt: z.string().min(1),
    observedAt: z.string().nullable().optional(),
    status: StatusEnum,
    statusLabel: z.string().min(1),
    stockCount: z.number().int().nonnegative().nullable().optional(),
    price: z.string().nullable().optional(),
    priceValue: z.number().nonnegative().nullable().optional(),
    currency: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    regions: z.array(z.string()).optional(),
    route: z.string().nullable().optional(),
    carrier: z.string().nullable().optional(),
    ipType: z.string().nullable().optional(),
    hardware: z.string().nullable().optional(),
    bandwidth: z.string().nullable().optional(),
    orderUrl: z.string().nullable().optional(),
    evidence: z.string().min(1),
    note: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    diagnostic: z.boolean().optional(),
    httpStatus: z.number().int().nullable().optional(),
    evidenceLevel: EvidenceLevelObjectSchema,
    riskTags: z.array(RiskTagObjectSchema).min(1),
    verification: VerificationSchema.optional(),
    collection: z.record(z.string(), z.unknown()).nullable().optional(),
    raw: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();

export const CompactSourceSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    providerId: z.string().nullable(),
    adapter: z.string().min(1),
    defaultSourceUrl: z.string().min(1)
  })
  .passthrough();

export const CompactProductSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    savedKey: z.string().min(1),
    category: z.string().min(1),
    status: StatusEnum,
    statusLabel: z.string().min(1),
    evidence: z.string().min(1),
    ev: z.union([z.string().min(1), EvidenceLevelObjectSchema]),
    rk: z.array(z.union([z.string().min(1), RiskTagObjectSchema])).min(1),
    provider: z.string().optional(),
    providerId: z.string().nullable().optional(),
    adapter: z.string().optional(),
    sourceUrl: z.string().optional(),
    finalUrl: z.string().nullable().optional(),
    sameFinalUrl: z.boolean().optional(),
    fetchedAt: z.string().optional(),
    observedAt: z.string().nullable().optional(),
    stockCount: z.number().int().nonnegative().nullable().optional(),
    price: z.string().nullable().optional(),
    priceValue: z.number().nonnegative().nullable().optional(),
    currency: z.string().nullable().optional(),
    quote: z
      .object({
        currency: z.string().nullable(),
        amount: z.number().nullable(),
        months: z.number().nullable(),
        period: z.string(),
        baseOnly: z.boolean(),
        monthly: z.number().nullable()
      })
      .optional(),
    name: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    regions: z.array(z.string()).optional(),
    route: z.string().nullable().optional(),
    carrier: z.string().nullable().optional(),
    ipType: z.string().nullable().optional(),
    hardware: z.string().nullable().optional(),
    bandwidth: z.string().nullable().optional(),
    orderUrl: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    error: z.string().nullable().optional(),
    diagnostic: z.boolean().optional(),
    httpStatus: z.number().int().nullable().optional(),
    features: z.unknown().optional(),
    rawFlags: z.record(z.string(), z.unknown()).optional(),
    verification: VerificationSchema.optional(),
    collection: z.record(z.string(), z.unknown()).nullable().optional()
  })
  .passthrough();

export const SummarySchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  error: z.number().int().nonnegative()
});

export const CompactSnapshotSchema = z
  .object({
    schemaVersion: z.literal(2),
    dictVersion: z.literal(DICT_VERSION),
    snapshotId: z.string().min(1),
    v1Sha256: z.string().regex(/^[0-9a-f]{64}$/),
    generatedAt: z.string().min(1),
    publishedAt: z.string().min(1),
    sourceCount: z.number().int().positive(),
    summary: SummarySchema,
    eventTracking: z.object({
      startedAt: z.string().min(1),
      retentionDays: z.literal(7),
      limit: z.literal(300)
    }),
    events: z.array(RadarEventSchema),
    exchangeRates: FxSnapshotSchema.optional(),
    sourceHealth: z.array(z.record(z.string(), z.unknown())).optional(),
    announcements: z.record(z.string(), z.unknown()).optional(),
    sources: z.record(z.string(), CompactSourceSchema),
    products: z.array(CompactProductSchema).min(1)
  })
  .passthrough();

export const SourceAuditSchema = z.object({
  schemaVersion: z.literal(2),
  snapshotId: z.string().min(1),
  sourceId: z.string().min(1),
  generatedAt: z.string().min(1),
  sourceHealth: z.record(z.string(), z.unknown()).nullable().optional(),
  records: z.record(
    z.string(),
    z.object({
      id: z.string().min(1),
      name: z.string().nullable().optional(),
      status: StatusEnum,
      httpStatus: z.number().int().nullable().optional(),
      evidence: z.string(),
      error: z.string().nullable().optional(),
      verification: VerificationSchema.nullable().optional(),
      collection: z.record(z.string(), z.unknown()).nullable().optional(),
      raw: z.record(z.string(), z.unknown()).nullable().optional(),
      observations: z.array(z.record(z.string(), z.unknown())).optional()
    })
  )
});

export const LatestPointerSchema = z.discriminatedUnion("mode", [
  z.object({
    schemaVersion: z.literal(2),
    dictVersion: z.literal(DICT_VERSION),
    mode: z.literal("v2"),
    snapshotId: z.string().min(1),
    v1Sha256: z.string().regex(/^[0-9a-f]{64}$/),
    generatedAt: z.string().min(1),
    publishedAt: z.string().min(1),
    snapshotPath: z.string().min(1),
    auditDirPath: z.string().min(1)
  }),
  z.object({
    schemaVersion: z.literal(2),
    mode: z.literal("v1-fallback"),
    updatedAt: z.string().min(1),
    fallbackPath: z.literal("data/products.json")
  })
]);

export const PublishJournalSchema = z.object({
  schemaVersion: z.literal(2),
  snapId: z.string().min(1),
  generatedAt: z.string().min(1),
  v1Sha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  state: z.enum([
    "staged",
    "quarantining",
    "snapshot_published",
    "v1_committed",
    "completed"
  ]),
  quarantineDir: z.string().nullable().optional(),
  updatedAt: z.string().min(1)
});

export const VisitStatsSchema = z.object({
  schemaVersion: z.literal(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.literal("Asia/Shanghai"),
  todayPv: z.number().int().nonnegative(),
  todayUv: z.number().int().nonnegative(),
  totalPv: z.number().int().nonnegative(),
  totalUv: z.number().int().nonnegative(),
  updatedAt: z.string().min(1)
});
