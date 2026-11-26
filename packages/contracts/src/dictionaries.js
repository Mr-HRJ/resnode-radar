/**
 * Append-only versioned dictionaries for v2 CompactSnapshot encoding.
 * Existing short codes MUST NEVER be reassigned to different meanings.
 * Clients encountering an unknown dictVersion or unknown code MUST fail closed.
 */
export const DICT_VERSION = 1;

function freezeNullProtoDict(entries) {
  const dict = Object.create(null);
  for (const [key, value] of Object.entries(entries)) {
    dict[key] = Object.freeze(value);
  }
  return Object.freeze(dict);
}

export const EVIDENCE_DICT_V1 = freezeNullProtoDict({
  sc: {
    value: "stock-count",
    labelTemplate: "精确库存 {stockCount}",
    fallbackLabel: "精确库存",
    className: "is-count",
    rank: 1
  },
  oo: {
    value: "official-order",
    label: "官方订购入口",
    className: "is-official",
    rank: 2
  },
  sn: {
    value: "snapshot",
    label: "第三方快照",
    className: "is-snapshot",
    rank: 4
  },
  un: {
    value: "unavailable",
    label: "不可订购",
    className: "is-unavailable",
    rank: 5
  },
  bl: {
    value: "blocked",
    label: "直连受阻",
    className: "is-blocked",
    rank: 5
  },
  er: {
    value: "error",
    label: "抓取失败",
    className: "is-error",
    rank: 6
  },
  uv: {
    value: "unverified",
    label: "证据待核验",
    className: "is-unknown",
    rank: 6
  },
  uh: {
    value: "unverified",
    label: "历史资料·库存待核验",
    className: "is-unknown",
    rank: 6
  }
});

export const RISK_TAG_DICT_V1 = freezeNullProtoDict({
  oo: { value: "order-only", label: "仅证明可下单", severity: "medium" },
  su: { value: "stock-unstated", label: "库存未明示", severity: "medium" },
  ts: { value: "third-party-snapshot", label: "第三方快照", severity: "high" },
  db: { value: "direct-blocked", label: "官方直连受阻", severity: "high" },
  fe: { value: "fetch-error", label: "抓取失败", severity: "high" },
  us: { value: "unknown-status", label: "状态未知", severity: "medium" },
  ua: { value: "unavailable", label: "当前不可订购", severity: "high" },
  pm: { value: "price-missing", label: "价格缺失", severity: "medium" },
  if: { value: "incomplete-fields", label: "字段不完整", severity: "medium" },
  ns: { value: "nat-shared", label: "NAT/共享", severity: "medium" },
  ir: { value: "identity-required", label: "需要实名", severity: "high" },
  rl: { value: "refund-limited", label: "退款限制", severity: "medium" },
  mc: { value: "manual-confirm", label: "需客服确认", severity: "medium" },
  ok: { value: "no-extra-risk", label: "未见额外风险", severity: "low" }
});

const RISK_VALUE_TO_CODE = new Map(
  Object.entries(RISK_TAG_DICT_V1).map(([code, def]) => [
    `${def.value}|${def.label}|${def.severity}`,
    code
  ])
);

export function encodeEvidenceLevel(evidenceLevel, stockCount = null) {
  if (!evidenceLevel || typeof evidenceLevel !== "object") return "uv";
  const { value, label, className, rank } = evidenceLevel;
  for (const [code, def] of Object.entries(EVIDENCE_DICT_V1)) {
    const expectedLabel = def.labelTemplate
      ? stockCount !== null && stockCount !== undefined
        ? def.labelTemplate.replace("{stockCount}", String(stockCount))
        : def.fallbackLabel
      : def.label;
    const defRank = def.rank;
    if (
      value === def.value &&
      label === expectedLabel &&
      className === def.className &&
      (rank === undefined || rank === defRank)
    ) {
      if (rank === undefined) {
        return { value, label, className };
      }
      return code;
    }
  }
  return {
    value: String(value ?? "unverified"),
    label: String(label ?? "证据待核验"),
    className: String(className ?? "is-unknown"),
    ...(rank !== undefined ? { rank } : {})
  };
}

export function decodeEvidenceLevel(encoded, stockCount = null, dictVersion = DICT_VERSION) {
  if (dictVersion !== DICT_VERSION) {
    throw new Error(`Unsupported CompactSnapshot dictVersion: ${dictVersion}`);
  }
  if (encoded && typeof encoded === "object" && !Array.isArray(encoded)) {
    return {
      value: encoded.value,
      label: encoded.label,
      className: encoded.className,
      ...(encoded.rank !== undefined ? { rank: encoded.rank } : {})
    };
  }
  const def =
    typeof encoded === "string" && Object.hasOwn(EVIDENCE_DICT_V1, encoded)
      ? EVIDENCE_DICT_V1[encoded]
      : null;
  if (!def) {
    throw new Error(`Unknown evidenceLevel dictionary code: ${String(encoded)}`);
  }
  const label = def.labelTemplate
    ? stockCount !== null && stockCount !== undefined
      ? def.labelTemplate.replace("{stockCount}", String(stockCount))
      : def.fallbackLabel
    : def.label;
  return {
    value: def.value,
    label,
    className: def.className,
    rank: def.rank
  };
}

export function encodeRiskTags(riskTags) {
  if (!Array.isArray(riskTags)) return [];
  return riskTags.filter(Boolean).map((tag) => {
    const key = `${tag.value}|${tag.label}|${tag.severity}`;
    const code = RISK_VALUE_TO_CODE.get(key);
    if (code && Object.keys(tag).length === 3) return code;
    return { ...tag };
  });
}

export function decodeRiskTags(encodedList, dictVersion = DICT_VERSION) {
  if (dictVersion !== DICT_VERSION) {
    throw new Error(`Unsupported CompactSnapshot dictVersion: ${dictVersion}`);
  }
  if (!Array.isArray(encodedList)) {
    throw new Error("Encoded riskTags must be an array");
  }
  return encodedList.map((entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return { ...entry };
    const def =
      typeof entry === "string" && Object.hasOwn(RISK_TAG_DICT_V1, entry)
        ? RISK_TAG_DICT_V1[entry]
        : null;
    if (!def) {
      throw new Error(`Unknown riskTag dictionary code: ${String(entry)}`);
    }
    return { value: def.value, label: def.label, severity: def.severity };
  });
}
