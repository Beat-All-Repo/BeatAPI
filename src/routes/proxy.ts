import { Hono } from "hono";
import { ProxyBalancer } from "../lib/proxyBalancer.js";

const proxyRouter = new Hono();

const configuredProxyUrls = (process.env.STREAM_PROXY_URLS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

if (configuredProxyUrls.length === 0) {
    configuredProxyUrls.push(
      "http://localhost:9000/api/proxy/m3u8-streaming-proxy",

        "https://kira.tatakai.me"
    );
}

const isSelfProxyNode = (url: string) => {
    const normalized = url.toLowerCase();
    return (
        (normalized.includes("localhost:9000") || normalized.includes("127.0.0.1:9000")) &&
        normalized.includes("/api/proxy/m3u8-streaming-proxy")
    );
};

const balancerUrls = configuredProxyUrls.filter((url) => !isSelfProxyNode(url));

const DEFAULT_REFERER = process.env.STREAM_PROXY_REFERER || "https://megacloud.club/";
const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const balancer = new ProxyBalancer(balancerUrls);

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                controller.signal.addEventListener("abort", () => reject(new Error("timeout")));
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
};

const probeProxyNode = async (url: string) => {
    const start = performance.now();
    try {
        const probeUrl = isSelfProxyNode(url)
            ? "http://localhost:9000/health"
            : `${url}${url.includes("?") ? "&" : "?"}url=${encodeURIComponent("https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8")}`;
        const resp = await withTimeout(fetch(probeUrl, { method: "GET" }), 4000);
        const latency = Math.round(performance.now() - start);
        const status = resp.status >= 500 ? "offline" : resp.status >= 400 ? "degraded" : "online";
        return { latency, status };
    } catch {
        return { latency: 0, status: "offline" as const };
    }
};

proxyRouter.get("/status", async (c) => {
    const now = Date.now();
    const balancerStats = balancer.getStats();
    const byUrl = new Map(balancerStats.map((node) => [node.url, node]));

    const nodes = await Promise.all(
        configuredProxyUrls.map(async (url, idx) => {
            const existing = byUrl.get(url);
            if (existing) {
                return {
                    ...existing,
                    status:
                        existing.cooldownUntil > now
                            ? "offline"
                            : existing.failures > 0
                              ? "degraded"
                              : "online",
                };
            }

            const probe = await probeProxyNode(url);
            return {
                id: `proxy-${idx + 1}`,
                url,
                failures: probe.status === "offline" ? 1 : 0,
                successes: probe.status === "online" ? 1 : 0,
                lastLatencyMs: probe.latency,
                cooldownUntil: 0,
                status: probe.status,
            };
        })
    );

    return c.json({
        success: true,
        hasNodes: nodes.length > 0,
        timestamp: now,
        nodes,
    });
});

const resolveUrl = (target: string, base: string) => {
    try {
        return new URL(target, base).toString();
    } catch {
        return target;
    }
};

const rewritePlaylistUrls = (playlistText: string, baseUrl: string, referer: string, userAgent?: string) => {
    return playlistText
        .split("\n")
        .map((line) => {
            const trimmed = line.trim();
            if (trimmed === "") return line;

            const rewrite = (targetUrl: string) => {
                const resolved = resolveUrl(targetUrl, baseUrl);
                const params = new URLSearchParams({ url: resolved });
                if (referer) params.set("referer", referer);
                if (userAgent) params.set("userAgent", userAgent);
                params.set("type", "video");
                return `/api/proxy/m3u8-streaming-proxy?${params.toString()}`;
            };

            if (trimmed.startsWith("#")) {
                return trimmed.replace(/URI="([^"]+)"/g, (_match, p1) => `URI="${rewrite(p1)}"`);
            }

            return rewrite(trimmed);
        })
        .join("\n");
};

proxyRouter.get("/m3u8-streaming-proxy", async (c) => {
    const safeDecode = (value?: string) => {
        if (!value) return "";
        try {
            return decodeURIComponent(value);
        } catch {
            return value;
        }
    };

    const targetUrl = safeDecode(c.req.query("url")).trim();
    const referer = safeDecode(c.req.query("referer")).trim() || DEFAULT_REFERER;
    const requestedUserAgent = safeDecode(c.req.query("userAgent")).trim() || DEFAULT_USER_AGENT;
    const requestedRange = c.req.header("range") || "";

    if (!targetUrl) {
        return c.json({ success: false, message: "Missing url query param" }, 400);
    }

    let targetOrigin = "";
    try {
        targetOrigin = new URL(targetUrl).origin;
    } catch {
        targetOrigin = "";
    }

    const refererCandidates = Array.from(
        new Set(
            [
                referer,
                DEFAULT_REFERER,
                targetOrigin ? `${targetOrigin}/` : "",
                referer.replace("megacloud.blog", "megacloud.club"),
                referer.replace("megacloud.club", "megacloud.blog"),
                "https://megacloud.club/",
                "https://megacloud.blog/",
                "https://megacloud.tv/",
                "https://megaup.cc/",
                "https://rrr.megaup.cc/",
            ].filter(Boolean)
        )
    );

    const buildHeaders = (ref: string): Record<string, string> => {
        const headers: Record<string, string> = {
            "User-Agent": requestedUserAgent,
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            Pragma: "no-cache",
        };
        if (requestedRange) headers.Range = requestedRange;
        if (ref) {
            headers.Referer = ref;
            try {
                headers.Origin = new URL(ref).origin;
            } catch {
                // noop
            }
        }
        return headers;
    };

    const isPlaylistLike = (response: Response) => {
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        return targetUrl.toLowerCase().includes(".m3u8") || contentType.includes("mpegurl") || contentType.includes("x-mpegurl");
    };

    const hasPlaylistPayload = async (response: Response) => {
        try {
            return (await response.clone().text()).trim().length > 0;
        } catch {
            return false;
        }
    };

    try {
        let upstream: Response | null = null;
        let successfulReferer = referer;

        const isAcceptableResponse = async (response: Response) => {
            if (!(response.ok || response.status === 206)) return false;

            if (isPlaylistLike(response)) {
                const validPayload = await hasPlaylistPayload(response);
                if (!validPayload) {
                    return false;
                }
            }

            return true;
        };

        for (const ref of refererCandidates) {
            const headers = buildHeaders(ref);

            if (balancer.hasNodes) {
                try {
                    const viaBalancer = await balancer.fetch(
                        targetUrl,
                        { method: "GET", headers },
                        12000,
                        {
                            referer: ref,
                            userAgent: requestedUserAgent,
                            type: "video",
                        }
                    );
                    if (await isAcceptableResponse(viaBalancer)) {
                        upstream = viaBalancer;
                        successfulReferer = ref;
                        break;
                    }
                } catch {
                    // try direct fallback with same headers
                }
            }

            try {
                const direct = await fetch(targetUrl, { method: "GET", headers });
                if (await isAcceptableResponse(direct)) {
                    upstream = direct;
                    successfulReferer = ref;
                    break;
                }
            } catch {
                // try next referer candidate
            }
        }

        if (!upstream) {
            throw new Error("All proxy/direct attempts failed for upstream stream URL");
        }

        const contentType = upstream.headers.get("content-type") || "";
        const isPlaylist = contentType.includes("mpegurl") || targetUrl.includes(".m3u8");

        if (isPlaylist) {
            const playlist = await upstream.text();
            if (!playlist.trim()) {
                throw new Error("Upstream playlist response was empty");
            }

            const rewritten = rewritePlaylistUrls(playlist, targetUrl, successfulReferer, requestedUserAgent);
            return new Response(rewritten, {
                status: 200,
                headers: {
                    "Content-Type": "application/vnd.apple.mpegurl",
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-store",
                },
            });
        }

        return new Response(upstream.body, {
            status: upstream.status,
            headers: {
                "Content-Type": contentType || "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-store",
                ...(upstream.headers.get("content-length")
                    ? { "Content-Length": upstream.headers.get("content-length") as string }
                    : {}),
                ...(upstream.headers.get("accept-ranges")
                    ? { "Accept-Ranges": upstream.headers.get("accept-ranges") as string }
                    : {}),
                ...(upstream.headers.get("content-range")
                    ? { "Content-Range": upstream.headers.get("content-range") as string }
                    : {}),
            },
        });
    } catch (err) {
        return c.json(
            {
                success: false,
                message: (err as Error).message || "Proxy request failed",
                balancer: balancer.getStats(),
            },
            502
        );
    }
});

export { proxyRouter };
