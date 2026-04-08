import * as cheerio from "cheerio";
import { Logger } from "../../utils/logger.js";
import { browserAjax, browserFetch } from "../animekai/lib/browserFetch.js";

const BASE_URL = "https://animelok.xyz";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
let cookieCache = "";
let cookieCacheAt = 0;

async function getSessionCookies(): Promise<string> {
  const now = Date.now();
  if (cookieCache && now - cookieCacheAt < 5 * 60 * 1000) return cookieCache;

  try {
    const res = await fetch(`${BASE_URL}/`, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer: BASE_URL,
        Origin: BASE_URL,
      },
      signal: AbortSignal.timeout(15000),
    });
    const setCookies = (res.headers as any).getSetCookie?.() || [];
    if (Array.isArray(setCookies) && setCookies.length > 0) {
      cookieCache = setCookies.map((c: string) => c.split(";")[0]).join("; ");
      cookieCacheAt = now;
    }
  } catch {
    // best-effort cookie fetch
  }

  return cookieCache;
}

async function fetchHtml(url: string, retries = 3): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: BASE_URL,
          Origin: BASE_URL,
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      // Direct fetch may return CF interstitial pages. Fall back to browser context.
      if (
        html.includes("Checking your connection") ||
        html.includes("challenge-platform") ||
        html.includes("__CF$cv$params")
      ) {
        try {
          return await browserFetch(url, `${BASE_URL}/home`);
        } catch {
          // keep original response if browser context fails
        }
      }

      return html;
    } catch (e) {
      lastErr = e as Error;
      if (i < retries - 1) await new Promise(r => setTimeout(r, 2 ** i * 500));
    }
  }
  throw lastErr!;
}

async function fetchApi(url: string): Promise<any> {
  const parseJsonLoose = (text: string): any => {
    if (!text) return null;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try { return JSON.parse(trimmed); } catch { return null; }
    }
    const fb = trimmed.indexOf("{");
    const lb = trimmed.lastIndexOf("}");
    if (fb !== -1 && lb !== -1 && lb > fb) {
      try { return JSON.parse(trimmed.substring(fb, lb + 1)); } catch { return null; }
    }
    return null;
  };

  const isBlockedPayload = (text: string): boolean => {
    const t = (text || "").toLowerCase();
    return (
      t.includes("unauthorized api access") ||
      t.includes("checking your connection") ||
      t.includes("challenge-platform") ||
      t.includes("__cf$cv$params")
    );
  };

  try {
    const cookieHeader = await getSessionCookies();
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: BASE_URL,
        Origin: BASE_URL,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        "Accept-Encoding": "identity",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      // continue to browser fallback for protected API paths
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await res.text();
    if (!isBlockedPayload(text)) {
      const parsed = parseJsonLoose(text);
      if (parsed) return parsed;
    }

    throw new Error("Direct API blocked or non-JSON payload");
  } catch {
    // Browser-context fallback to reuse CF-cleared session for same-origin API
    try {
      await browserFetch(`${BASE_URL}/home`, BASE_URL);
      const watchLike = url.match(/\/api\/anime\/([^/]+)\/episodes\/(\d+)/i);
      const referer = watchLike
        ? `${BASE_URL}/watch/${watchLike[1]}?ep=${watchLike[2]}`
        : `${BASE_URL}/home`;
      const ajaxRes = await browserAjax(url, {
        method: "GET",
        headers: {
          Accept: "application/json, text/plain, */*",
          "X-Requested-With": "XMLHttpRequest",
          Referer: referer,
        },
      });

      if (typeof ajaxRes === "string") {
        return parseJsonLoose(ajaxRes);
      }
      return ajaxRes || null;
    } catch {
      return null;
    }
  }
}

function extractAnilistId(slug: string): number | null {
  const m = slug.match(/-(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function validateItem(item: any): boolean {
  return !!(item.id && item.title);
}

export async function getHome() {
  const html = await fetchHtml(`${BASE_URL}/home`);
  const $ = cheerio.load(html);
  const sections: any[] = [];

  $("section").each((_, section) => {
    const title =
      $(section).find("h2").first().text().trim() ||
      $(section).find("h3").first().text().trim();
    if (!title) return;

    const items: any[] = [];
    $(section).find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      const animeTitle =
        $(link).find("h3").first().text().trim() ||
        $(link).find(".font-bold").first().text().trim() ||
        $(link).find("[class*='title']").first().text().trim();
      const item = {
        id: slug,
        anilistId,
        title: animeTitle,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
      };
      if (validateItem(item)) items.push(item);
    });

    if (items.length > 0) sections.push({ title, items });
  });

  return { sections };
}

export async function search(q: string) {
  const html = await fetchHtml(`${BASE_URL}/search?keyword=${encodeURIComponent(q)}`);
  const $ = cheerio.load(html);
  const animes: any[] = [];

  $("a[href^='/anime/']").each((_, link) => {
    const url = $(link).attr("href");
    if (!url) return;
    const slug = url.split("/").pop() || "";
    const anilistId = extractAnilistId(slug);
    const title =
      $(link).find("h3, h4").first().text().trim() ||
      $(link).find("[class*='title']").first().text().trim() ||
      $(link).text().trim().split("\n")[0].trim();
    const poster =
      $(link).find("img").attr("src") || $(link).find("img").attr("data-src");
    if (title && slug) {
      animes.push({
        id: slug,
        anilistId,
        title,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
      });
    }
  });

  const unique = Array.from(new Map(animes.map(a => [a.id, a])).values());
  return { animes: unique };
}

export async function getSchedule() {
  const html = await fetchHtml(`${BASE_URL}/schedule`);
  const $ = cheerio.load(html);
  const schedule: any[] = [];
  const dayNames = ["Yesterday", "Today", "Tomorrow", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  $("section").each((_, section) => {
    const dayTitle = $(section).find("h2").first().text().trim();
    const dayMatch = dayNames.find(d => dayTitle.toLowerCase().includes(d.toLowerCase()));
    if (!dayMatch) return;

    const anime: any[] = [];
    $(section).find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const title =
        $(link).find("h3, h4, span").first().text().trim() ||
        $(link).text().trim().split("\n")[0].trim();
      const timeText = $(link).find("div, span").filter((_, el) => !!$(el).text().match(/\d{1,2}:\d{2}/)).first().text().match(/(\d{1,2}:\d{2})/)?.[1];
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      if (title && slug) {
        anime.push({
          id: anilistId?.toString() || slug,
          anilistId,
          title,
          time: timeText,
          poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        });
      }
    });

    if (anime.length > 0) {
      schedule.push({ day: dayMatch, anime: Array.from(new Map(anime.map(a => [a.id, a])).values()) });
    }
  });

  return { schedule };
}

export async function getRegionalSchedule() {
  const html = await fetchHtml(`${BASE_URL}/regional-schedule`);
  const $ = cheerio.load(html);
  const schedule: any[] = [];
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  $("h2, h3").each((_, heading) => {
    const dayTitle = $(heading).text().trim();
    const dayMatch = dayNames.find(d => dayTitle.toLowerCase() === d.toLowerCase() || dayTitle.toLowerCase().includes(d.toLowerCase() + " schedule"));
    if (!dayMatch) return;

    const container = $(heading).closest("section, div.mb-10, div.pb-12");
    const anime: any[] = [];
    container.find("a[href^='/anime/']").each((_, link) => {
      const url = $(link).attr("href");
      if (!url) return;
      const slug = url.split("/").pop() || "";
      const anilistId = extractAnilistId(slug);
      const title =
        $(link).find("h3, h4, span").first().text().trim() ||
        $(link).text().trim().split("\n")[0].trim();
      const timeText = $(link).find("div, span").filter((_, el) => !!$(el).text().match(/\d{1,2}:\d{2}/)).first().text().match(/(\d{1,2}:\d{2})/)?.[1];
      const poster =
        $(link).find("img").attr("src") ||
        $(link).find("img").attr("data-src") ||
        $(link).find("img").attr("data-lazy-src");
      if (title && slug) {
        anime.push({
          id: anilistId?.toString() || slug,
          anilistId,
          title,
          time: timeText,
          poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
          url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        });
      }
    });

    if (anime.length > 0) {
      schedule.push({ day: dayMatch, anime: Array.from(new Map(anime.map(a => [a.id, a])).values()) });
    }
  });

  return { schedule };
}

export async function getLanguages(page = "1") {
  const html = await fetchHtml(`${BASE_URL}/languages?page=${page}`).catch(() => fetchHtml(`${BASE_URL}/home`));
  const $ = cheerio.load(html);
  const languages: any[] = [];

  $("a[href^='/languages/']").each((_, item) => {
    const link = $(item).attr("href");
    if (!link) return;
    const code = link.split("/").pop();
    if (!code || code === "languages") return;
    const name =
      $(item).find("span, h3, h2").first().text().trim() ||
      $(item).text().trim().split("\n")[0].trim();
    const poster =
      $(item).find("img").attr("src") ||
      $(item).find("img").attr("data-src") ||
      $(item).attr("style")?.match(/url\(['"]?([^'"]+)['"]?\)/)?.[1];
    if (name && code) {
      languages.push({
        name,
        code,
        url: link.startsWith("http") ? link : `${BASE_URL}${link}`,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
      });
    }
  });

  const unique = Array.from(new Map(languages.map(l => [l.code, l])).values());
  const hasNextPage =
    $("a, button")
      .filter((_, el) => {
        const t = $(el).text().toLowerCase();
        return (t.includes("next") || t === ">" || t === "»") && !$(el).hasClass("disabled") && !$(el).attr("disabled");
      })
      .length > 0;

  return { page: parseInt(page), languages: unique, hasNextPage };
}

export async function getLanguageAnime(language: string, page = "1") {
  const html = await fetchHtml(`${BASE_URL}/languages/${language}?page=${page}`);
  const $ = cheerio.load(html);
  const anime: any[] = [];

  $("a[href^='/anime/']").each((_, item) => {
    const url = $(item).attr("href");
    if (!url) return;
    const slug = url.split("/").pop() || "";
    const anilistId = extractAnilistId(slug);
    const title =
      $(item).find("h3, h4, .title").first().text().trim() ||
      $(item).text().trim().split("\n")[0].trim();
    const poster =
      $(item).find("img").attr("src") ||
      $(item).find("img").attr("data-src") ||
      $(item).find("img").attr("data-lazy-src");
    const rating = $(item).find("[class*='rating'], [class*='score']").text().trim();
    const year = $(item).find("span").filter((_, el) => !!$(el).text().match(/^\d{4}$/)).text().trim();
    if (title && slug && !["Home", "Movies", "TV Series"].includes(title)) {
      anime.push({
        id: anilistId?.toString() || slug,
        anilistId,
        title,
        poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
        url: url.startsWith("http") ? url : `${BASE_URL}${url}`,
        rating: rating ? parseFloat(rating) : undefined,
        year: year || undefined,
      });
    }
  });

  const unique = Array.from(new Map(anime.filter(a => a.id && a.title).map(a => [a.id, a])).values());
  const hasNextPage =
    $("a, button")
      .filter((_, el) => {
        const t = $(el).text().toLowerCase();
        return (t.includes("next") || t === ">" || t === "»") && !$(el).hasClass("disabled") && !$(el).attr("disabled");
      })
      .length > 0;

  return { language, page: parseInt(page), anime: unique, hasNextPage };
}

export async function getAnimeInfo(id: string) {
  const html = await fetchHtml(`${BASE_URL}/anime/${id}`);
  const $ = cheerio.load(html);
  const anilistId = extractAnilistId(id);

  const title =
    $("h1").first().text().trim() ||
    $("meta[property='og:title']").attr("content")?.split(" - Animelok")[0]?.trim() ||
    "";
  const description =
    $("[class*='description']").first().text().trim() ||
    $("[class*='synopsis']").first().text().trim() ||
    $("meta[property='og:description']").attr("content")?.trim() ||
    "";
  const poster =
    $("img[class*='poster']").attr("src") ||
    $("img[class*='cover']").attr("src") ||
    $("meta[property='og:image']").attr("content") ||
    "";
  const ratingText =
    $("[class*='rating']").first().text().trim() || $("[class*='score']").first().text().trim();
  const rating = ratingText ? parseFloat(ratingText) : undefined;
  const genres: string[] = [];
  $("a[href*='/genres/'], [class*='genre'] a").each((_, el) => {
    const g = $(el).text().trim();
    if (g) genres.push(g);
  });

  // Seasons
  const seasons: any[] = [];
  const seasonsSection = $("h2, h3").filter((_, el) => $(el).text().toLowerCase().includes("season")).first();
  if (seasonsSection.length > 0) {
    seasonsSection.parent().find("a[href^='/anime/']").each((_, link) => {
      const seasonUrl = $(link).attr("href");
      const seasonSlug = seasonUrl?.split("/").pop();
      const seasonTitle = $(link).find("h3, h4").first().text().trim() || $(link).text().trim();
      const seasonPoster = $(link).find("img").attr("src") || $(link).find("img").attr("data-src");
      if (seasonSlug && seasonTitle) {
        seasons.push({
          id: seasonSlug,
          title: seasonTitle,
          poster: seasonPoster?.startsWith("http") ? seasonPoster : seasonPoster ? `${BASE_URL}${seasonPoster}` : undefined,
          url: seasonUrl?.startsWith("http") ? seasonUrl : seasonUrl ? `${BASE_URL}${seasonUrl}` : undefined,
        });
      }
    });
  }

  // Episodes
  let episodes: any[] = [];
  if ($("a[href*='/watch/']").length > 0) {
    $("a[href*='/watch/']").each((_, link) => {
      const epUrl = $(link).attr("href");
      const epMatch = epUrl?.match(/ep[=\/](\d+)/i);
      const epNum = epMatch ? parseInt(epMatch[1], 10) : undefined;
      if (epNum) {
        const epTitle = $(link).text().trim() || `Episode ${epNum}`;
        episodes.push({
          number: epNum,
          title: epTitle,
          url: epUrl?.startsWith("http") ? epUrl : epUrl ? `${BASE_URL}${epUrl}` : undefined,
        });
      }
    });
  } else {
    const apiData = await fetchApi(`${BASE_URL}/api/anime/${id}/episodes-range?page=0&lang=JAPANESE&pageSize=100`);
    if (apiData?.episodes) {
      apiData.episodes.forEach((ep: any) => {
        episodes.push({
          number: ep.number,
          title: ep.name || `Episode ${ep.number}`,
          url: `${BASE_URL}/watch/${id}?ep=${ep.number}`,
          image: ep.img,
          isFiller: ep.isFiller,
        });
      });
    }
  }

  return {
    id,
    anilistId,
    title,
    description,
    poster: poster?.startsWith("http") ? poster : poster ? `${BASE_URL}${poster}` : undefined,
    rating,
    genres: genres.length > 0 ? genres : undefined,
    seasons: seasons.length > 0 ? seasons : undefined,
    episodes: episodes.sort((a, b) => a.number - b.number),
  };
}

export async function watch(id: string, ep: string) {
  let apiUrl = `${BASE_URL}/api/anime/${id}/episodes/${ep}`;
  let apiData = await fetchApi(apiUrl);

  // Fallback: resolve real ID via search
  if (!apiData?.episode) {
    Logger.info(`[Animelok] API failed for ${id}, resolving via search`);
    try {
      const query = id.replace(/-/g, " ");
      const html = await fetchHtml(`${BASE_URL}/search?keyword=${encodeURIComponent(query)}`);
      const $ = cheerio.load(html);
      const firstUrl = $("a[href^='/anime/']").first().attr("href");
      if (firstUrl) {
        const realId = firstUrl.split("/").pop();
        if (realId && realId !== id) {
          Logger.info(`[Animelok] Resolved ${id} → ${realId}`);
          apiData = await fetchApi(`${BASE_URL}/api/anime/${realId}/episodes/${ep}`);
        }
      }
    } catch (e) {
      Logger.warn(`[Animelok] ID resolution failed: ${e}`);
    }
  }

  if (!apiData?.episode) {
    return { id, episode: ep, servers: [], subtitles: [] };
  }

  const episodeData = apiData.episode;

  const parseServers = (raw: any): any[] => {
    if (typeof raw === "string") {
      try {
        const fb = raw.indexOf("[");
        const lb = raw.lastIndexOf("]");
        if (fb !== -1 && lb !== -1) raw = JSON.parse(raw.substring(fb, lb + 1));
        else return [];
      } catch { return []; }
    }
    if (!Array.isArray(raw)) return [];

    return raw.map((s: any) => {
      let language = s.languages?.[0] || s.language || "";
      const lc = s.langCode || "";
      if (lc.includes("TAM")) language = "Tamil";
      else if (lc.includes("MAL")) language = "Malayalam";
      else if (lc.includes("TEL")) language = "Telugu";
      else if (lc.includes("KAN")) language = "Kannada";
      else if (lc.includes("HIN") || s.name?.toLowerCase().includes("cloud") || s.tip?.toLowerCase().includes("cloud")) language = "Hindi";
      else if (lc.includes("ENG") || lc.includes("EN")) language = "English";
      else if (lc.includes("JAP")) language = "Japanese";
      if (!language.trim()) language = "Other";
      if (["eng", "english"].includes(language.toLowerCase())) language = "English";
      language = language.charAt(0).toUpperCase() + language.slice(1).toLowerCase();

      let url = s.url;
      const isM3U8 = s.isM3U8 || (typeof url === "string" && url.toLowerCase().includes(".m3u8"));
      if (typeof url === "string" && url.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(url);
          if (Array.isArray(parsed) && parsed.length > 0) url = parsed[0].url || url;
        } catch { }
      }

      return { name: s.name, url, language, tip: s.tip, isM3U8 };
    }).filter(s => s.url);
  };

  let servers = parseServers(episodeData.servers);

  if (servers.length === 0) {
    const [dubData, subData] = await Promise.all([
      fetchApi(`${BASE_URL}/api/anime/${id}/episodes/${ep}?lang=dub`),
      fetchApi(`${BASE_URL}/api/anime/${id}/episodes/${ep}?lang=sub`),
    ]);
    const dubServers = parseServers(dubData?.episode?.servers).map(s => ({ ...s, language: s.language === "Other" ? "Dub" : s.language }));
    const subServers = parseServers(subData?.episode?.servers).map(s => ({ ...s, language: s.language === "Other" ? "Sub" : s.language }));
    const seen = new Set();
    for (const s of [...dubServers, ...subServers]) {
      if (!seen.has(s.url)) { servers.push(s); seen.add(s.url); }
    }
  }

  const rawSubs = episodeData.subtitles || [];
  const seenSubs = new Set<string>();
  const subtitles = (Array.isArray(rawSubs) ? rawSubs : []).map((sub: any) => ({
    label: sub.name || sub.label || "English",
    src: sub.url || sub.src,
  })).filter((sub: any) => {
    if (!sub.src || seenSubs.has(sub.src)) return false;
    seenSubs.add(sub.src);
    return true;
  });

  // Episode list for navigation
  let episodes: any[] = [];
  try {
    const allEps = await fetchApi(`${BASE_URL}/api/anime/${id}/episodes-range?page=0&lang=JAPANESE&pageSize=1000`);
    if (allEps?.episodes) {
      episodes = allEps.episodes.map((e: any) => ({
        number: e.number,
        title: e.name || `Episode ${e.number}`,
        url: `${BASE_URL}/watch/${id}?ep=${e.number}`,
        isFiller: e.isFiller,
      }));
    }
  } catch { }

  return {
    id,
    anilistId: apiData.anime?.id || extractAnilistId(id),
    animeTitle: apiData.anime?.title || "Unknown Anime",
    episode: ep,
    title: episodeData.name || `Episode ${ep}`,
    servers,
    subtitles,
    episodes: episodes.length > 0 ? episodes : undefined,
  };
}
