import { plain, providerInitial } from "@resnode-radar/contracts";

export function shortProviderLabel(name) {
  const s = plain(name);
  if (/搬瓦工/i.test(s)) return "搬瓦工";
  if (/GreenCloud/i.test(s)) return "绿云 GreenCloud";
  if (/V\.PS/i.test(s)) return "V.PS 小秘书";
  if (/RFCHOST/i.test(s)) return "RFCHOST 花卷";
  if (/SaltyFish/i.test(s)) return "咸鱼云 SaltyFish";
  if (/BestVM/i.test(s)) return "富婆 BestVM";
  if (/Neburst/i.test(s)) return "奶爸 Neburst";
  if (/YUNYOO/i.test(s)) return "云悠 YUNYOO";
  if (/ZgoCloud/i.test(s)) return "ZgoCloud";
  if (/Spartan/i.test(s)) return "斯巴达 Spartan";
  if (/Boil/i.test(s)) return "Boil 港仔";
  if (/NodeMach/i.test(s)) return "NodeMach";
  if (/BreaCloud/i.test(s)) return "破云 BreaCloud";
  if (/六六云/i.test(s)) return "六六云 666";
  if (/WePC/i.test(s)) return "WePC 车库云";
  return s.replace(/\s*[（(][^）)]*[）)]$/, "").trim() || s;
}

function compactHwParts(plan) {
  const ns = plan._numSpecs || {};
  const s = plan._specs || {};

  let c = "";
  if (Number.isFinite(ns.cpuCores)) {
    c = `${ns.cpuCores}C`;
  } else if (s.cpu && s.cpu !== "未标明") {
    const vpsUnitMatch = s.cpu.match(/^(\d+)\s*[x×]\s*(?:AMD|Intel|Xeon|EPYC)\b/i);
    c = vpsUnitMatch
      ? `${vpsUnitMatch[1]}C`
      : s.cpu
          .replace(/\(\s*\)|（\s*）/g, "")
          .replace(/\s*(?:x\s*)?v?\s*(?:cpus?|cores?)\b/gi, "C")
          .replace(/核(?:心)?/g, "C")
          .replace(/\s+/g, "")
          .slice(0, 8);
  }

  let m = "";
  if (Number.isFinite(ns.memoryGb)) {
    if (ns.memoryGb >= 1) {
      m = `${Number.isInteger(ns.memoryGb) ? ns.memoryGb : Number(ns.memoryGb.toFixed(1))}G`;
    } else {
      m = `${Math.round(ns.memoryGb * 1024)}M`;
    }
  } else if (s.memory && s.memory !== "未标明") {
    m = s.memory
      .replace(/\s*Gi?B\b/gi, "G")
      .replace(/\s*Mi?B\b/gi, "M")
      .replace(/\s*DDR\d*.*$/i, "")
      .trim();
  }

  let d = "";
  if (Number.isFinite(ns.diskGb)) {
    if (ns.diskGb >= 1024 && ns.diskGb % 1024 === 0) {
      d = `${ns.diskGb / 1024}T`;
    } else {
      d = `${Number.isInteger(ns.diskGb) ? ns.diskGb : Number(ns.diskGb.toFixed(1))}G`;
    }
  } else if (s.disk && s.disk !== "未标明") {
    d = s.disk
      .replace(/\s*Gi?B\b/gi, "G")
      .replace(/\s*Ti?B\b/gi, "T")
      .replace(/\b(?:RAID(?:[- ]?\d+)?|SSD|NVMe|HDD|disk|storage)\b/gi, "")
      .replace(/高性能|固态|硬盘/g, "")
      .trim();
  }

  const tuple = [c, m, d].filter(Boolean).join(" / ");
  const rawBlob = [s.cpu, s.memory, s.disk, plain(plan.hardware)]
    .filter((v) => v && v !== "未标明")
    .join(" ");
  const notes = [];
  if (/9950x/i.test(rawBlob)) notes.push("Ryzen 9950X");
  else if (/7950x/i.test(rawBlob)) notes.push("Ryzen 7950X");
  else if (/ryzen/i.test(rawBlob)) notes.push("Ryzen");
  else if (/epyc/i.test(rawBlob)) notes.push("EPYC");
  else if (/xeon/i.test(rawBlob)) notes.push("Xeon");
  else if (/\bamd\b/i.test(rawBlob)) notes.push("AMD");

  if (/\bnvme\b/i.test(rawBlob)) notes.push("NVMe");
  else if (/\bssd\b/i.test(rawBlob)) notes.push("SSD");
  else if (/\bhdd\b/i.test(rawBlob)) notes.push("HDD");

  if (/raid[- ]?10/i.test(rawBlob)) notes.push("RAID10");
  else if (/ddr5/i.test(rawBlob)) notes.push("DDR5");

  return { tuple, hwSub: notes.slice(0, 2).join(" · ") };
}

function compactBwText(bw) {
  if (!bw) return "";
  const m = bw.match(/^(\d+(?:\.\d+)?)\s*Mbps$/);
  if (m && Number(m[1]) >= 1000 && Number(m[1]) % 1000 === 0) {
    return `${Number(m[1]) / 1000} Gbps`;
  }
  return bw.replace(/\s+/g, " ").trim();
}

function compactTrafficText(tr) {
  if (!tr) return "";
  return tr
    .replace(/\s*Gi?B\b/gi, "G")
    .replace(/\s*Ti?B\b/gi, "T")
    .replace(/\/mo(?:nth)?\b/gi, "/月")
    .replace(/\((?:in\+out|双向|雙向)\)/gi, "")
    .trim();
}

export function renderSpecsParts(plan) {
  const s = plan._specs || {};
  const fullHw = [s.cpu, s.memory, s.disk].filter((v) => v && v !== "未标明").join(" / ");
  const { tuple, hwSub } = compactHwParts(plan);
  const fallbackHw = plain(plan.hardware);
  const hwChipText = tuple || fallbackHw || "";

  const rawBw = s.bandwidth && s.bandwidth !== "未标明" ? s.bandwidth : "";
  const rawTraffic = s.traffic && s.traffic !== "未标明" ? s.traffic : "";
  const bw = compactBwText(rawBw);
  const traffic = compactTrafficText(rawTraffic);
  const fallbackNet = plain(plan.bandwidth);
  const hasStructuredNet = Boolean(bw || traffic);

  return {
    hwChipText,
    hwSub,
    fullHw: fullHw || fallbackHw || "配置未标明",
    bw,
    traffic,
    isUnlimited: Boolean(plan._numSpecs?.unlimitedTraffic || rawTraffic === "不限流量"),
    fallbackNet: !hasStructuredNet ? fallbackNet : "",
    compactHw: tuple ? `${tuple}${hwSub ? ` (${hwSub})` : ""}` : fullHw || fallbackHw || "配置未标明",
    compactNet: [bw, traffic].filter(Boolean).join(" · ") || fallbackNet || "带宽流量未标明"
  };
}

export function routeChipClass(tone) {
  if (tone === "cn2") return "net-micro-tag is-cn2";
  if (tone === "9929") return "net-micro-tag is-9929";
  if (tone === "cmin2") return "net-micro-tag is-cmin2";
  if (tone === "4837") return "net-micro-tag is-4837";
  if (tone === "jp") return "net-micro-tag is-jp";
  if (tone === "home") return "net-micro-tag is-home";
  if (tone === "native") return "net-micro-tag is-native";
  if (tone === "warn") return "net-micro-tag is-warn";
  if (tone === "bgp") return "net-micro-tag is-bgp";
  return "net-micro-tag is-muted";
}

export function roleSolidBadgeClass(tone) {
  if (tone === "home") return "badge-solid badge-solid-home";
  if (tone === "opt") return "badge-solid badge-solid-opt";
  if (tone === "native") return "badge-solid badge-solid-native";
  return "badge-solid badge-solid-landing";
}

export function formatLiveClockText(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const pad = (n) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${time} ${date}`;
}

export function computeSyncProgressRatio(lastFetchAt, loadState, intervalMs = 5 * 60_000, now = Date.now()) {
  if (!lastFetchAt || loadState !== "ready") return 0.08;
  const elapsed = Math.max(0, now - lastFetchAt);
  return Math.min(1, Math.max(0.04, elapsed / intervalMs));
}

export function smartBrandMonogram(provider) {
  const idUpper = String(provider?.id || "").toUpperCase();
  if (/^[A-Z0-9]{2,3}$/.test(idUpper)) return idUpper;
  const parenMatch = String(provider?.name || "").match(/[（(]([A-Za-z0-9]{2,4})[）)]/);
  if (parenMatch) return parenMatch[1].toUpperCase();
  const init = providerInitial(provider?.name);
  if (/[\u4e00-\u9fff]/.test(init)) return [...init][0];
  return init;
}
