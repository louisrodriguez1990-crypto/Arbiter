import "@/lib/load-env";

export type ListingEvidence = {
  url: string;
  title: string;
  price?: number;
  location?: string;
  source: "craigslist" | "google_cse";
};

export type CompsEvidence = {
  source: "ebay";
  soldMin?: number;
  soldMax?: number;
  soldMedian?: number;
  sampleSoldUrls: string[];
};

export type EvidenceBundle = {
  listings: ListingEvidence[];
  comps: CompsEvidence | null;
  usedSources: string[];
  skippedSources: string[];
};

type CacheEntry<T> = { expiresAt: number; value: T };
const TTL_MS = 5 * 60 * 1000;
const evidenceCache = new Map<string, CacheEntry<EvidenceBundle>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs = TTL_MS) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function fetchTextWithTimeout(url: string, timeoutMs = 8000): Promise<string> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: {
        "User-Agent": "Arbiter/0.1 (+public-evidence-fetch)",
      },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function uniqByUrl(rows: ListingEvidence[]): ListingEvidence[] {
  const seen = new Set<string>();
  const out: ListingEvidence[] = [];
  for (const r of rows) {
    const u = r.url.trim();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push({ ...r, url: u });
  }
  return out;
}

function stripCdata(v: string): string {
  return v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}

function parseCraigslistRss(xml: string): ListingEvidence[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const out: ListingEvidence[] = [];
  for (const item of items) {
    const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1]?.trim();
    if (!link) continue;
    const title = stripCdata(item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? "Craigslist listing");
    const mPrice = title.match(/\$([0-9][0-9,\.]*)/);
    const price = mPrice ? Number(mPrice[1].replace(/[,]/g, "")) : undefined;
    const location = stripCdata(item.match(/<dc:source>([\s\S]*?)<\/dc:source>/i)?.[1] ?? "");
    out.push({ url: link, title, price, location, source: "craigslist" });
  }
  return out;
}

export async function fetchCraigslistListings(query: string, regionHost: string): Promise<ListingEvidence[]> {
  try {
    const rssUrl = `https://${regionHost}/search/sss?format=rss&sort=date&query=${encodeURIComponent(query)}`;
    const xml = await fetchTextWithTimeout(rssUrl, 8000);
    return uniqByUrl(parseCraigslistRss(xml)).slice(0, 15);
  } catch {
    return [];
  }
}

function isAllowedListingUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host.includes("craigslist.org")) return true;
    if (host.includes("mercari.com") && path.includes("/item/")) return true;
    return false;
  } catch {
    return false;
  }
}

export async function fetchGoogleProgrammableListings(query: string, city: string): Promise<ListingEvidence[]> {
  const apiKey = process.env.GOOGLE_CSE_API_KEY?.trim();
  const cx = process.env.GOOGLE_CSE_CX?.trim();
  if (!apiKey || !cx) return [];
  try {
    const q = `${query} ${city} (site:craigslist.org OR site:mercari.com)`;
    const url =
      `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}` +
      `&cx=${encodeURIComponent(cx)}&num=10&q=${encodeURIComponent(q)}`;
    const raw = await fetchTextWithTimeout(url, 8000);
    const json = JSON.parse(raw) as { items?: Array<{ link?: string; title?: string; snippet?: string }> };
    const rows: ListingEvidence[] = [];
    for (const it of json.items ?? []) {
      if (!it.link || !isAllowedListingUrl(it.link)) continue;
      rows.push({
        url: it.link,
        title: it.title?.trim() || "Search result listing",
        location: city,
        source: "google_cse",
      });
    }
    return uniqByUrl(rows).slice(0, 15);
  } catch {
    return [];
  }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function fetchEbayComps(query: string): Promise<CompsEvidence | null> {
  const appId = process.env.EBAY_APP_ID?.trim();
  if (!appId) return null;
  try {
    const url =
      "https://svcs.ebay.com/services/search/FindingService/v1" +
      `?OPERATION-NAME=findCompletedItems&SERVICE-VERSION=1.13.0&SECURITY-APPNAME=${encodeURIComponent(appId)}` +
      "&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD" +
      `&keywords=${encodeURIComponent(query)}` +
      "&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true" +
      "&paginationInput.entriesPerPage=10";
    const raw = await fetchTextWithTimeout(url, 8000);
    const json = JSON.parse(raw) as Record<string, unknown>;
    const arr = (((json["findCompletedItemsResponse"] as unknown[])?.[0] as Record<string, unknown>)?.[
      "searchResult"
    ] as unknown[])?.[0] as Record<string, unknown> | undefined;
    const items = (arr?.["item"] as Array<Record<string, unknown>> | undefined) ?? [];
    const soldPrices: number[] = [];
    const sampleSoldUrls: string[] = [];

    for (const it of items) {
      const viewUrl = ((it["viewItemURL"] as unknown[])?.[0] as string | undefined) ?? "";
      const amountStr =
        ((((it["sellingStatus"] as unknown[])?.[0] as Record<string, unknown> | undefined)?.[
          "currentPrice"
        ] as unknown[])?.[0] as Record<string, unknown> | undefined)?.["__value__"] as string | undefined;
      const amount = amountStr ? Number(amountStr) : NaN;
      if (viewUrl) sampleSoldUrls.push(viewUrl);
      if (Number.isFinite(amount) && amount > 0) soldPrices.push(amount);
    }

    return {
      source: "ebay",
      soldMin: soldPrices.length ? Math.min(...soldPrices) : undefined,
      soldMax: soldPrices.length ? Math.max(...soldPrices) : undefined,
      soldMedian: median(soldPrices),
      sampleSoldUrls: [...new Set(sampleSoldUrls)].slice(0, 8),
    };
  } catch {
    return null;
  }
}

function inferRegionHost(userQuery: string): string {
  const q = userQuery.toLowerCase();
  if (q.includes("orlando")) return "orlando.craigslist.org";
  if (q.includes("austin")) return "austin.craigslist.org";
  if (q.includes("miami")) return "miami.craigslist.org";
  return "orlando.craigslist.org";
}

function inferCity(userQuery: string): string {
  const q = userQuery.toLowerCase();
  if (q.includes("orlando")) return "Orlando, FL";
  if (q.includes("austin")) return "Austin, TX";
  if (q.includes("miami")) return "Miami, FL";
  return "Orlando, FL";
}

export async function getEvidenceForQuery(userQuery: string): Promise<EvidenceBundle> {
  const key = userQuery.trim().toLowerCase();
  const hit = cacheGet(evidenceCache, key);
  if (hit) return hit;

  const usedSources: string[] = [];
  const skippedSources: string[] = [];

  const regionHost = inferRegionHost(userQuery);
  const city = inferCity(userQuery);

  const [craigslist, googleCse, comps] = await Promise.all([
    fetchCraigslistListings(userQuery, regionHost),
    fetchGoogleProgrammableListings(userQuery, city),
    fetchEbayComps(userQuery),
  ]);

  if (craigslist.length > 0) usedSources.push("craigslist");
  else skippedSources.push(`craigslist: no public matches for ${regionHost}`);

  if (process.env.GOOGLE_CSE_API_KEY?.trim() && process.env.GOOGLE_CSE_CX?.trim()) {
    if (googleCse.length > 0) usedSources.push("google_cse");
    else skippedSources.push("google_cse: no whitelisted listing URLs returned");
  } else {
    skippedSources.push("google_cse: missing GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX");
  }

  if (process.env.EBAY_APP_ID?.trim()) {
    if (comps) usedSources.push("ebay_comps");
    else skippedSources.push("ebay_comps: request failed or empty");
  } else {
    skippedSources.push("ebay_comps: missing EBAY_APP_ID");
  }

  const bundle: EvidenceBundle = {
    listings: uniqByUrl([...craigslist, ...googleCse]).slice(0, 15),
    comps,
    usedSources,
    skippedSources,
  };
  cacheSet(evidenceCache, key, bundle);
  return bundle;
}
