import { FullProductSchema } from "@resnode-radar/contracts/schemas";

export const REGISTERED_ADAPTERS = Object.freeze([
  "aaitr_store",
  "lagom_product_list",
  "public_catalog",
  "racknerd_kvm",
  "vircs_inertia_product",
  "whmcs_group",
  "whmcs_pid_watch",
  "zlidc_product_wrap"
]);

export const REGISTERED_CATALOG_FORMATS = Object.freeze([
  "100tb",
  "berohost",
  "breacloud",
  "bwh",
  "dmit",
  "evoxt",
  "flawlessnode",
  "goldcloud",
  "greencloud",
  "halocloud",
  "hhost",
  "hostbill-onestep",
  "hosthatch",
  "jdidc",
  "kfchost",
  "lazycat",
  "lightnode",
  "miraigrid",
  "misaka",
  "moonvm",
  "neburst",
  "nmcloud",
  "nodemach",
  "nosla",
  "panstar",
  "paymenter",
  "shandun",
  "sixclouds",
  "skyline",
  "spartan",
  "usvps24",
  "vmiss",
  "vps",
  "zgovps"
]);

const ADAPTER_SET = new Set(REGISTERED_ADAPTERS);
const FORMAT_SET = new Set(REGISTERED_CATALOG_FORMATS);

/**
 * Verifies that every configured source in sources.json maps to a registered
 * top-level adapter and (if specified) a registered catalogFormat handler.
 */
export function verifySourcesCoverage(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error("Sources configuration must be a non-empty array");
  }
  const seenIds = new Set();
  for (const source of sources) {
    if (!source?.id || seenIds.has(source.id)) {
      throw new Error(`Duplicate or missing source id: ${String(source?.id)}`);
    }
    seenIds.add(source.id);
    if (!ADAPTER_SET.has(source.adapter)) {
      throw new Error(`Source ${source.id} uses unregistered adapter: ${String(source.adapter)}`);
    }
    if (source.catalogFormat && !FORMAT_SET.has(source.catalogFormat)) {
      throw new Error(
        `Source ${source.id} uses unregistered catalogFormat: ${String(source.catalogFormat)}`
      );
    }
  }
  return {
    sourceCount: sources.length,
    adapters: [...new Set(sources.map((s) => s.adapter))].sort(),
    catalogFormats: [...new Set(sources.map((s) => s.catalogFormat).filter(Boolean))].sort()
  };
}

/**
 * Enforces per-source Zod record boundary validation so a malformed record from one
 * upstream adapter converts cleanly into an isolated diagnostic error record without
 * poisoning or aborting the remaining 160 sources.
 */
export function validateSourceRecords(source, records, enrichFn, makeErrorRecord) {
  if (!Array.isArray(records) || records.length === 0) {
    return [enrichFn(makeErrorRecord(source, new Error(`Adapter ${source.adapter} returned 0 records`)))];
  }
  const validated = [];
  for (const rawRecord of records) {
    const enriched = enrichFn(rawRecord);
    const parsed = FullProductSchema.safeParse(enriched);
    if (parsed.success) {
      validated.push(enriched);
    } else {
      const issue = parsed.error.issues[0];
      const diag = enrichFn({
        ...makeErrorRecord(
          source,
          new Error(
            `Adapter schema violation on ${String(rawRecord?.id ?? source.id)}: ${issue?.path?.join(".") || "record"} ${issue?.message || "invalid"}`
          )
        ),
        id: `${source.id}:schema-diagnostic`,
        diagnostic: true
      });
      validated.push(diag);
      break;
    }
  }
  return validated;
}
