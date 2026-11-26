export function transportErrorDetails(error, url) {
  const rawCode = error.cause?.code ?? error.code;
  const code = /^[A-Z][A-Z0-9_]+$/.test(rawCode ?? "") ? rawCode : null;
  const hostname = error.cause?.hostname ?? error.hostname ?? (url && URL.canParse(url) ? new URL(url).hostname : null);
  const message = code === "ENOTFOUND"
    ? `官网域名 ${hostname ?? ""} 无法解析，未取得套餐；不能据此判断售罄 [ENOTFOUND]`
    : code === "EAI_AGAIN"
      ? `DNS 临时解析失败：${hostname ?? ""}，稍后重试 [EAI_AGAIN]`
      : `${error.message}${code ? ` [${code}]` : ""}`;
  return { message, code, hostname };
}
