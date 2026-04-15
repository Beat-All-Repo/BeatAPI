import { fetchLocalMapperChapters, fetchLocalMapperPages } from "./localMapper.js";

export const MANGA_MAPPER_PROVIDERS = [
  "mangadex",
  "asurascans",
  "mangapark",
  "mangabuddy",
  "mangakakalot",
  "mangaball",
  "allmanga",
  "atsu",
  "mangafire",
] as const;

export type MangaMapperProvider = (typeof MANGA_MAPPER_PROVIDERS)[number];

export interface MapperChapter {
  id: string;
  title?: string;
  number?: number | string;
  volume?: number | string;
  url?: string;
  date?: string;
  language?: string;
  scanlator?: string;
  providerMangaId?: string;
}

export interface MapperPage {
  url: string;
  index?: number;
  width?: number;
  height?: number;
}

export interface MapperFetchResult<T> {
  provider: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  data: T;
  error?: string;
}

const resolveDefaultMapperBaseUrl = () => {
  const rawHostname = String(process.env.ANIWATCH_API_HOSTNAME || "").trim();
  const hostname = rawHostname.replace(/^https?:\/\//i, "").replace(/\/+$/g, "");

  const origin = hostname.length > 0
    ? `https://${hostname}`
    : `http://localhost:${String(process.env.ANIWATCH_API_PORT || 4000).trim()}`;

  return `${origin}/api/v2/manga`;
};

const MANGA_MAPPER_DEFAULT_BASE_URL = resolveDefaultMapperBaseUrl();
const MANGA_MAPPER_DEFAULT_TIMEOUT_MS = 8000;

const now = () => Date.now();

const readBaseUrl = () => {
  return String(process.env.MANGA_MAPPER_BASE_URL || MANGA_MAPPER_DEFAULT_BASE_URL).replace(/\/+$/, "");
};

const readTimeoutMs = () => {
  const parsed = Number.parseInt(String(process.env.MANGA_MAPPER_TIMEOUT_MS || MANGA_MAPPER_DEFAULT_TIMEOUT_MS), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return MANGA_MAPPER_DEFAULT_TIMEOUT_MS;
  return parsed;
};

const parseJsonSafely = async (response: Response): Promise<any> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const extractChapterRows = (payload: any, provider: string): MapperChapter[] => {
  const direct = Array.isArray(payload?.chapters)
    ? payload.chapters
    : Array.isArray(payload?.[provider]?.chapters)
      ? payload[provider].chapters
      : Array.isArray(payload?.data?.chapters)
        ? payload.data.chapters
        : Array.isArray(payload?.data)
          ? payload.data
        : Array.isArray(payload)
          ? payload
          : [];

  const chapters: MapperChapter[] = direct
    .map((chapter: any): MapperChapter => ({
      id: String(chapter?.id || chapter?.chapterId || ""),
      title: chapter?.title ? String(chapter.title) : undefined,
      number: chapter?.number ?? chapter?.chapter ?? chapter?.chapterNumber,
      volume: chapter?.volume,
      url: chapter?.url ? String(chapter.url) : undefined,
      date: chapter?.date ? String(chapter.date) : undefined,
      language: chapter?.language ? String(chapter.language) : undefined,
      scanlator: chapter?.scanlator ? String(chapter.scanlator) : undefined,
      providerMangaId: chapter?.providerMangaId ? String(chapter.providerMangaId) : undefined,
    }));

  return chapters.filter((chapter: MapperChapter) => chapter.id.length > 0);
};

const extractPageRows = (payload: any): MapperPage[] => {
  const direct = Array.isArray(payload?.pages)
    ? payload.pages
    : Array.isArray(payload?.data?.pages)
      ? payload.data.pages
      : Array.isArray(payload?.data)
        ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

  const pages: MapperPage[] = direct
    .map((page: any, index: number): MapperPage => ({
      url: String(page?.url || page?.image || page?.img || ""),
      index: Number.isFinite(Number(page?.index)) ? Number(page.index) : index,
      width: Number.isFinite(Number(page?.width)) ? Number(page.width) : undefined,
      height: Number.isFinite(Number(page?.height)) ? Number(page.height) : undefined,
    }));

  return pages.filter((page: MapperPage) => page.url.length > 0);
};

const fetchMapperPath = async (path: string) => {
  const start = now();
  const baseUrl = readBaseUrl();
  const timeoutMs = readTimeoutMs();

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
      },
    });

    const payload = await parseJsonSafely(response);
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: now() - start,
      payload,
      error: response.ok
        ? undefined
        : String(payload?.message || payload?.error || `Mapper request failed with ${response.status}`),
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 503,
      latencyMs: now() - start,
      payload: null,
      error: error?.message || "Mapper request failed",
    };
  }
};

export const fetchMapperChapters = async (
  provider: string,
  anilistId: number,
  language?: string
): Promise<MapperFetchResult<MapperChapter[]>> => {
  const safeProvider = provider.toLowerCase();
  const local = await fetchLocalMapperChapters(safeProvider, anilistId, language);
  if (local) {
    return local;
  }

  const normalizedLanguage = String(language || "").trim();
  const query = normalizedLanguage ? `?lang=${encodeURIComponent(normalizedLanguage)}` : "";
  const result = await fetchMapperPath(`/mapper/${safeProvider}/chapters/${anilistId}${query}`);

  if (!result.ok) {
    return {
      provider: safeProvider,
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      data: [],
      error: result.error,
    };
  }

  return {
    provider: safeProvider,
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    data: extractChapterRows(result.payload, safeProvider),
  };
};

export const fetchMapperPages = async (
  provider: string,
  chapterId: string
): Promise<MapperFetchResult<MapperPage[]>> => {
  const safeProvider = provider.toLowerCase();
  const local = await fetchLocalMapperPages(safeProvider, chapterId);
  if (local) {
    return local;
  }

  const encodedChapterId = encodeURIComponent(chapterId);
  const result = await fetchMapperPath(`/mapper/${safeProvider}/pages/${encodedChapterId}`);

  if (!result.ok) {
    return {
      provider: safeProvider,
      ok: false,
      status: result.status,
      latencyMs: result.latencyMs,
      data: [],
      error: result.error,
    };
  }

  return {
    provider: safeProvider,
    ok: true,
    status: result.status,
    latencyMs: result.latencyMs,
    data: extractPageRows(result.payload),
  };
};

export const fetchAllMapperChapters = async (
  anilistId: number,
  providers: readonly string[] = MANGA_MAPPER_PROVIDERS,
  language?: string
) => {
  const settled = await Promise.allSettled(
    providers.map((provider) => fetchMapperChapters(provider, anilistId, language))
  );

  const success: MapperFetchResult<MapperChapter[]>[] = [];
  const failed: MapperFetchResult<MapperChapter[]>[] = [];

  for (const result of settled) {
    if (result.status === "fulfilled") {
      if (result.value.ok) {
        success.push(result.value);
      } else {
        failed.push(result.value);
      }
      continue;
    }

    failed.push({
      provider: "unknown",
      ok: false,
      status: 503,
      latencyMs: 0,
      data: [],
      error: result.reason instanceof Error ? result.reason.message : "Mapper promise rejected",
    });
  }

  return { success, failed };
};

export const isSupportedMangaMapperProvider = (provider: string) =>
  MANGA_MAPPER_PROVIDERS.includes(provider.toLowerCase() as MangaMapperProvider);

export const getMapperBridgeConfig = () => ({
  baseUrl: readBaseUrl(),
  timeoutMs: readTimeoutMs(),
});
