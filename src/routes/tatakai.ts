import { Hono } from "hono";
import { HiAnime } from "../vendor/aniwatch/index.js";
import type * as AniwatchTypes from "../vendor/aniwatch/types/index.js";
import type { AZListSortOptions } from "../vendor/aniwatch/utils/constants.js";
import { cache } from "../config/cache.js";
import type { ServerContext } from "../config/context.js";
import { extractCompatServers, extractCompatStreamingInfo } from "../services/hianimeCompat.js";

const hianime = new HiAnime.Scraper();
const tatakaiRouter = new Hono<ServerContext>();

type IdPair = {
    anilistID: number | null;
    malID: number | null;
};

type AnimeMeta = IdPair & {
    poster: string | null;
    banner: string | null;
};

const animeMetaLookupCache = new Map<string, AnimeMeta>();
const animeMetaLookupInflight = new Map<string, Promise<AnimeMeta>>();
const anilistPosterLookupCache = new Map<string, { poster: string | null; banner: string | null } | null>();
const anilistPosterLookupInflight = new Map<string, Promise<{ poster: string | null; banner: string | null } | null>>();

const coerceId = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
};

const findIdsDeep = (data: unknown): IdPair => {
    if (!data || typeof data !== "object") {
        return { anilistID: null, malID: null };
    }

    if (Array.isArray(data)) {
        for (const item of data) {
            const ids = findIdsDeep(item);
            if (ids.anilistID !== null || ids.malID !== null) {
                return ids;
            }
        }
        return { anilistID: null, malID: null };
    }

    const obj = data as Record<string, unknown>;
    const anilistID =
        coerceId(obj.anilistID) ?? coerceId(obj.anilistId) ?? null;
    const malID = coerceId(obj.malID) ?? coerceId(obj.malId) ?? null;

    if (anilistID !== null || malID !== null) {
        return { anilistID, malID };
    }

    for (const value of Object.values(obj)) {
        const ids = findIdsDeep(value);
        if (ids.anilistID !== null || ids.malID !== null) {
            return ids;
        }
    }

    return { anilistID: null, malID: null };
};

const isAnimeSlug = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    if (value.length < 3) return false;
    if (value.includes("?ep=")) return false;
    if (value.includes("/")) return false;
    return /[a-z]/i.test(value) && value.includes("-");
};

const isAnimeLikeObject = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const obj = value as Record<string, unknown>;
    return (
        isAnimeSlug(obj.id) &&
        (typeof obj.name === "string" ||
            typeof obj.jname === "string" ||
            typeof obj.poster === "string")
    );
};

const collectAnimeIds = (value: unknown, out: Set<string>, skipKey?: string) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
        for (const item of value) collectAnimeIds(item, out, skipKey);
        return;
    }

    const obj = value as Record<string, unknown>;
    if (isAnimeLikeObject(obj)) {
        out.add(obj.id as string);
    }

    for (const [key, child] of Object.entries(obj)) {
        if (key === skipKey) continue;
        collectAnimeIds(child, out, skipKey);
    }
};

const resolveAnimeMeta = async (animeId: string): Promise<AnimeMeta> => {
    const cached = animeMetaLookupCache.get(animeId);
    if (cached) return cached;

    const inflight = animeMetaLookupInflight.get(animeId);
    if (inflight) return inflight;

    console.log(`[Tatakai] Resolving meta for: ${animeId}`);
    const promise = (async () => {
        try {
            const info = await hianime.getInfo(animeId);
            const meta: AnimeMeta = {
                anilistID: info?.anime?.info?.anilistId ?? null,
                malID: info?.anime?.info?.malId ?? null,
                poster: null,
                banner: null,
            };
            animeMetaLookupCache.set(animeId, meta);
            return meta;
        } catch (err) {
            console.error(`[Tatakai] Failed to resolve meta for ${animeId}:`, (err as Error).message);
            const meta: AnimeMeta = { anilistID: null, malID: null, poster: null, banner: null };
            animeMetaLookupCache.set(animeId, meta);
            return meta;
        } finally {
            animeMetaLookupInflight.delete(animeId);
        }
    })();

    animeMetaLookupInflight.set(animeId, promise);
    return promise;
};

const resolveAnilistPoster = async (
    ids: IdPair
): Promise<{ poster: string | null; banner: string | null } | null> => {
    const validAniListId = ids.anilistID && ids.anilistID > 0 ? ids.anilistID : null;
    const validMalId = ids.malID && ids.malID > 0 ? ids.malID : null;
    if (!validAniListId && !validMalId) return null;

    const cacheKey = validAniListId
        ? `anilist:${validAniListId}`
        : `mal:${validMalId}`;

    const cached = anilistPosterLookupCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const inflight = anilistPosterLookupInflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
        try {
            const query = validAniListId
                ? `query ($id: Int) { Media(id: $id, type: ANIME) { bannerImage coverImage { extraLarge large medium } } }`
                : `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { bannerImage coverImage { extraLarge large medium } } }`;
            const resp = await fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    query,
                    variables: validAniListId
                        ? { id: validAniListId }
                        : { idMal: validMalId },
                }),
            });

            if (!resp.ok) {
                anilistPosterLookupCache.set(cacheKey, null);
                return null;
            }

            const json = (await resp.json()) as any;

            const poster =
                json?.data?.Media?.coverImage?.extraLarge ||
                json?.data?.Media?.coverImage?.large ||
                json?.data?.Media?.coverImage?.medium ||
                null;

            const banner = json?.data?.Media?.bannerImage || null;

            const result = { poster, banner };
            anilistPosterLookupCache.set(cacheKey, result);
            return result;
        } catch {
            anilistPosterLookupCache.set(cacheKey, null);
            return null;
        } finally {
            anilistPosterLookupInflight.delete(cacheKey);
        }
    })();

    anilistPosterLookupInflight.set(cacheKey, promise);
    return promise;
};

const resolveExternalAnimeId = async (inputAnimeId: string): Promise<string> => {
    let animeId = inputAnimeId.trim();
    if (!(animeId.startsWith("mal-") || animeId.startsWith("anilist-"))) {
        return animeId;
    }

    const isMal = animeId.startsWith("mal-");
    const externalId = parseInt(animeId.replace(/^(mal-|anilist-)/, ""));
    if (isNaN(externalId)) return animeId;

    try {
        const titleQuery = isMal
            ? `query ($id: Int) { Media(idMal: $id, type: ANIME) { title { english romaji native } } }`
            : `query ($id: Int) { Media(id: $id, type: ANIME) { title { english romaji native } } }`;

        const aniResp = await fetch("https://graphql.anilist.co", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: titleQuery, variables: { id: externalId } }),
        });

        if (!aniResp.ok) return animeId;

        const aniJson = (await aniResp.json()) as any;
        const title =
            aniJson?.data?.Media?.title?.english ||
            aniJson?.data?.Media?.title?.romaji ||
            aniJson?.data?.Media?.title?.native;

        if (!title) return animeId;

        const searchResults = await hianime.search(title);
        const foundId = searchResults.animes?.[0]?.id;
        if (foundId) {
            return foundId;
        }
    } catch (err) {
        console.error(`[Mapping] Failed to resolve ${animeId}:`, err);
    }

    return animeId;
};

const addIdsToAnimeObjects = (
    value: unknown,
    lookup: Map<string, AnimeMeta>,
    skipPoster = false
): unknown => {
    if (!value || typeof value !== "object") return value;

    if (Array.isArray(value)) {
        return value.map((item) => addIdsToAnimeObjects(item, lookup, skipPoster));
    }

    const obj = value as Record<string, unknown>;
    const transformed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
        // Special case for spotlightAnimes array: skip poster override for its children
        const shouldSkipPoster = skipPoster || key === "spotlightAnimes";
        transformed[key] = addIdsToAnimeObjects(child, lookup, shouldSkipPoster);
    }

    if (isAnimeLikeObject(obj)) {
        const animeId = obj.id as string;
        const resolved = lookup.get(animeId) || {
            anilistID: null,
            malID: null,
            poster: null,
            banner: null,
        };
        transformed.anilistID =
            coerceId(obj.anilistID) ??
            coerceId(obj.anilistId) ??
            resolved.anilistID;
        transformed.malID =
            coerceId(obj.malID) ?? coerceId(obj.malId) ?? resolved.malID;
        transformed.anilist_id =
            coerceId(obj.anilist_id) ??
            coerceId(obj.anilistId) ??
            resolved.anilistID;
        transformed.mal_id =
            coerceId(obj.mal_id) ?? coerceId(obj.malId) ?? resolved.malID;

        if (!skipPoster) {
            if (resolved.poster) {
                transformed.poster = resolved.poster;
            }
            if (resolved.banner) {
                transformed.banner = resolved.banner;
            }
        }
    }

    return transformed;
};

const enrichAnimeObjectsWithIds = async <T>(data: T): Promise<T> => {
    const ids = new Set<string>();
    collectAnimeIds(data, ids);

    if (ids.size === 0) return data;

    const lookup = new Map<string, AnimeMeta>();
    await Promise.all(
        Array.from(ids).map(async (animeId) => {
            const resolvedMeta = await resolveAnimeMeta(animeId);
            const extra = await resolveAnilistPoster(resolvedMeta);

            lookup.set(animeId, {
                ...resolvedMeta,
                poster: extra?.poster ?? resolvedMeta.poster,
                banner: extra?.banner ?? resolvedMeta.banner,
            });
        })
    );

    return addIdsToAnimeObjects(data, lookup) as T;
};

const attachIdsToPayload = <T>(data: T, ids: IdPair): T => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return data;
    }
    const obj = data as Record<string, unknown>;
    return {
        ...obj,
        anilistID: coerceId(obj.anilistID) ?? ids.anilistID,
        malID: coerceId(obj.malID) ?? ids.malID,
        anilist_id: coerceId(obj.anilist_id) ?? ids.anilistID,
        mal_id: coerceId(obj.mal_id) ?? ids.malID,
    } as T;
};

const ok = async <T>(data: T) => {
    console.log(`[Tatakai] Processing response with ok()`);
    try {
        const enrichedData = await enrichAnimeObjectsWithIds(data);
        const ids = findIdsDeep(enrichedData);
        return {
            status: 200,
            anilistID: ids.anilistID,
            malID: ids.malID,
            anilist_id: ids.anilistID,
            mal_id: ids.malID,
            data: attachIdsToPayload(enrichedData, ids),
        };
    } catch (err) {
        console.error(`[Tatakai] Error in ok():`, err);
        throw err;
    }
};

const normalizeServerName = (name: string) => {
    const serverName = name.trim().toLowerCase();
    switch (serverName) {
        case "megacloud":
        case "rapidcloud":
        case "hd-1":
            return "HD-1";
        case "vidsrc":
        case "vidstreaming":
        case "hd-2":
            return "HD-2";
        case "t-cloud":
        case "hd-3":
            return "HD-3";
        default:
            return name;
    }
};

// /api/v2/hianime
tatakaiRouter.get("/", (c) => c.redirect("/", 301));

// /api/v2/hianime/home
tatakaiRouter.get("/home", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const data = await cache.getOrSet<AniwatchTypes.ScrapedHomePage>(
        hianime.getHomePage,
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/azlist/{sortOption}?page={page}
tatakaiRouter.get("/azlist/:sortOption", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const sortOption = decodeURIComponent(
        c.req.param("sortOption").trim().toLowerCase()
    ) as AZListSortOptions;
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeAZList>(
        async () => hianime.getAZList(sortOption, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/qtip/{animeId}
tatakaiRouter.get("/qtip/:animeId", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const animeId = decodeURIComponent(c.req.param("animeId").trim());

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeQtipInfo>(
        async () => hianime.getQtipInfo(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/category/{name}?page={page}
tatakaiRouter.get("/category/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const categoryName = decodeURIComponent(
        c.req.param("name").trim()
    ) as AniwatchTypes.AnimeCategories;
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeCategory>(
        async () => hianime.getCategoryAnime(categoryName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/genre/{name}?page={page}
tatakaiRouter.get("/genre/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const genreName = decodeURIComponent(c.req.param("name").trim());
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedGenreAnime>(
        async () => hianime.getGenreAnime(genreName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/producer/{name}?page={page}
tatakaiRouter.get("/producer/:name", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const producerName = decodeURIComponent(c.req.param("name").trim());
    const page: number =
        Number(decodeURIComponent(c.req.query("page") || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedProducerAnime>(
        async () => hianime.getProducerAnimes(producerName, page),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/schedule?date={date}&tzOffset={tzOffset}
tatakaiRouter.get("/schedule", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");

    const date = decodeURIComponent(c.req.query("date") || "");
    let tzOffset = Number(
        decodeURIComponent(c.req.query("tzOffset") || "-330")
    );
    tzOffset = isNaN(tzOffset) ? -330 : tzOffset;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedEstimatedSchedule>(
        async () => hianime.getEstimatedSchedule(date, tzOffset),
        `${cacheConfig.key}_${tzOffset}`,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/search?q={query}&page={page}&filters={...filters}
tatakaiRouter.get("/search", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let { q: query, page, ...filters } = c.req.query();

    query = decodeURIComponent(query || "");
    const pageNo = Number(decodeURIComponent(page || "")) || 1;

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeSearchResult>(
        async () => hianime.search(query, pageNo, filters),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/search/suggestion?q={query}
tatakaiRouter.get("/search/suggestion", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const query = decodeURIComponent(c.req.query("q") || "");

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeSearchSuggestion>(
        async () => hianime.searchSuggestions(query),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/anime/{animeId}
tatakaiRouter.get("/anime/:animeId", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());

    console.log(`[Tatakai] GET /anime/${animeId}`);
    animeId = await resolveExternalAnimeId(animeId);

    try {
        const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeAboutInfo>(
            async () => {
                console.log(`[Tatakai] Fetching info from hianime for: ${animeId}`);
                return hianime.getInfo(animeId);
            },
            cacheConfig.key,
            cacheConfig.duration
        );

        console.log(`[Tatakai] Successfully fetched data for: ${animeId}`);
        
        // Enrich with AniList poster
        let enrichedData = data;
        try {
            const anilistId = coerceId(data?.anime?.info?.anilistId ?? data?.anime?.moreInfo?.anilistId);
            const malId = coerceId(data?.anime?.info?.malId ?? data?.anime?.moreInfo?.malId);
            
            if (anilistId || malId) {
                const posterData = await resolveAnilistPoster({ anilistID: anilistId, malID: malId });
                if (posterData?.poster && enrichedData?.anime?.info) {
                    enrichedData = {
                        ...enrichedData,
                        anime: {
                            ...enrichedData.anime,
                            info: {
                                ...enrichedData.anime.info,
                                poster: posterData.poster // Use AniList poster
                            }
                        }
                    };
                }
            }
        } catch (posterErr) {
            console.error(`[Tatakai] Failed to fetch AniList poster for ${animeId}:`, posterErr);
            // Fallback to original data if poster fetch fails
        }
        
        const result = await ok(enrichedData);
        return c.json(result, { status: 200 });
    } catch (err) {
        console.error(`[Tatakai] Failed to handle /anime/${animeId}:`, err);
        return c.json({ error: (err as Error).message, stack: (err as Error).stack }, { status: 500 });
    }
});

// /api/v2/hianime/episode/servers?animeEpisodeId={id}
tatakaiRouter.get("/episode/servers", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );

    const data = await cache.getOrSet<any>(
        async () => extractCompatServers(animeEpisodeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// episodeId=steinsgate-3?ep=230
// /api/v2/hianime/episode/sources?animeEpisodeId={episodeId}?server={server}&category={category (dub or sub)}
tatakaiRouter.get("/episode/sources", async (c) => {
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );
    const server = decodeURIComponent(
        c.req.query("server") || HiAnime.Servers.VidStreaming
    ) as AniwatchTypes.AnimeServers;
    const category = decodeURIComponent(c.req.query("category") || "sub") as
        | "sub"
        | "dub"
        | "raw";

    const data = await (async () => {
        try {
            const streamInfo = await extractCompatStreamingInfo(animeEpisodeId, server, category);

            // Map hianime-api results to AniwatchTypes format expected by frontend
            return {
                sources: streamInfo.streamingLink?.map((s: any) => ({
                    url: s.link,
                    type: s.type || 'hls',
                    isM3U8: String(s.link).includes('.m3u8')
                })) || [],
                subtitles: streamInfo.tracks?.map((t: any) => ({
                    url: t.file,
                    lang: t.label,
                    label: t.label,
                    default: t.default || false
                })) || [],
                intro: streamInfo.intro,
                outro: streamInfo.outro,
                server: streamInfo.server,
                availableServers: streamInfo.servers
            } as AniwatchTypes.ScrapedAnimeEpisodesSources;
        } catch (err) {
            console.error("[TatakaiCore] Stream Proxy Error:", err);
            return { sources: [], subtitles: [] } as any;
        }
    })();

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/episode/stream?animeEpisodeId={episodeId}&server={server}&category={category}
tatakaiRouter.get("/episode/stream", async (c) => {
    const animeEpisodeId = decodeURIComponent(
        c.req.query("animeEpisodeId") || ""
    );
    const server = decodeURIComponent(
        c.req.query("server") || HiAnime.Servers.VidStreaming
    ) as AniwatchTypes.AnimeServers;
    const category = decodeURIComponent(c.req.query("category") || "sub") as
        | "sub"
        | "dub"
        | "raw";

    const [sourcesRaw, serversRaw] = await Promise.all([
        hianime.getEpisodeSources(animeEpisodeId, server, category),
        hianime.getEpisodeServers(animeEpisodeId),
    ]);

    const sources = sourcesRaw as AniwatchTypes.ScrapedAnimeEpisodesSources & {
        tracks?: Array<{
            file: string;
            kind?: string;
            label?: string;
            default?: boolean;
        }>;
        outro?: { start: number; end: number };
    };
    const servers = serversRaw as {
        sub: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
        dub: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
        raw: Array<{ serverName: string; serverId: number | null; dataId?: string | null }>;
    };

    const mergedServers = [
        ...servers.sub.map((item) => ({
            type: "sub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...servers.dub.map((item) => ({
            type: "dub",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
        ...servers.raw.map((item) => ({
            type: "raw",
            data_id: item.dataId || null,
            server_id: item.serverId,
            serverName: normalizeServerName(item.serverName),
        })),
    ];

    const response = {
        streamingLink: [
            {
                link: sources.sources?.[0]?.url || "",
                type: sources.sources?.[0]?.type || "hls",
                server: normalizeServerName(server),
                iframe: sources.embedURL || "",
            },
        ],
        tracks: sources.tracks || [],
        subtitles: sources.subtitles || [],
        intro: sources.intro || null,
        outro: sources.outro || null,
        server: normalizeServerName(server),
        servers: mergedServers,
        anilistID: sources.anilistID ?? null,
        malID: sources.malID ?? null,
    };

    return c.json(await ok(response), { status: 200 });
});

// /api/v2/hianime/anime/{anime-id}/episodes
tatakaiRouter.get("/anime/:animeId/episodes", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());
    animeId = await resolveExternalAnimeId(animeId);

    const data = await cache.getOrSet<AniwatchTypes.ScrapedAnimeEpisodes>(
        async () => hianime.getEpisodes(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

// /api/v2/hianime/anime/{anime-id}/next-episode-schedule
tatakaiRouter.get("/anime/:animeId/next-episode-schedule", async (c) => {
    const cacheConfig = c.get("CACHE_CONFIG");
    let animeId = decodeURIComponent(c.req.param("animeId").trim());
    animeId = await resolveExternalAnimeId(animeId);

    const data = await cache.getOrSet<AniwatchTypes.ScrapedNextEpisodeSchedule>(
        async () => hianime.getNextEpisodeSchedule(animeId),
        cacheConfig.key,
        cacheConfig.duration
    );

    return c.json(await ok(data), { status: 200 });
});

export { tatakaiRouter };
