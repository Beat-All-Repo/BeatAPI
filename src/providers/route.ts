import { Hono } from "hono";
import { animekaiRoutes } from "./animekai/route.js";
import { animepaheRoutes } from "./animepahe/route.js";
import { toonstreamRoutes } from "./toonstream/route.js";
import { animeyaRoutes } from "./animeya/route.js";
import { animelokRoutes } from "./animelok/route.js";
import { watchawRoutes } from "./watchaw/route.js";
import { desidubanimeRoutes } from "./desidubanime/route.js";
import { aniworldRoutes } from "./aniworld/route.js";
import { hindidubbedRoutes } from "./hindidubbed/route.js";
import { techinmindRoutes } from "./techinmind/route.js";
import { toonworldRoutes } from "./toonworld/route.js";
import { mapperRoutes } from "./mapper/route.js";
import { proxyRouter } from "../routes/proxy.js";

export const animeRoutes = new Hono();

type ScraperHealthStatus = "operational" | "degraded" | "down";

interface ScraperHealthProbe {
  path: string;
}

const SCRAPER_HEALTH_PROBES: ScraperHealthProbe[] = [
  { path: "/animekai/search/health" },
  { path: "/animepahe/search/health" },
  { path: "/toonstream/home" },
  { path: "/animeya/home" },
  { path: "/animelok/home" },
  { path: "/watchaw/home" },
  { path: "/desidubanime/home" },
  { path: "/aniworld/search/health" },
  { path: "/hindidubbed/home" },
  { path: "/techinmind/proxy?url=https%3A%2F%2Fexample.com" },
  { path: "/toonworld/search/health" },
];

const classifyScraperHealth = (statusCode: number): ScraperHealthStatus => {
  if (statusCode >= 200 && statusCode < 300) return "operational";
  if (statusCode === 429 || statusCode === 408) return "degraded";
  if (statusCode >= 500) return "down";
  return "degraded";
};

type DiscordWebhookChannel = "user_created" | "error_logs" | "comment" | "review_popup" | "status";

animeRoutes.post("/webhooks/discord", async (c) => {
  try {
    const payload = await c.req.json<any>();
    const channel = String(payload?.channel || "") as DiscordWebhookChannel;

    const channelEnvMap: Record<DiscordWebhookChannel, string[]> = {
      user_created: ["DISCORD_WEBHOOK_USER_CREATED", "DISCORD_WEBHOOK_USER_CREATED_URL", "DISCORD_WEBHOOK_DEFAULT"],
      error_logs: ["DISCORD_WEBHOOK_ERROR_LOGS", "DISCORD_WEBHOOK_ERROR_LOGS_URL", "DISCORD_WEBHOOK_DEFAULT"],
      comment: ["DISCORD_WEBHOOK_COMMENT", "DISCORD_WEBHOOK_COMMENT_URL", "DISCORD_WEBHOOK_DEFAULT"],
      review_popup: ["DISCORD_WEBHOOK_REVIEW_POPUP", "DISCORD_WEBHOOK_REVIEW_POPUP_URL", "DISCORD_WEBHOOK_DEFAULT"],
      status: ["DISCORD_WEBHOOK_STATUS", "DISCORD_WEBHOOK_STATUS_URL", "DISCORD_WEBHOOK_DEFAULT"],
    };

    const candidates = channelEnvMap[channel] || ["DISCORD_WEBHOOK_DEFAULT"];
    const webhookUrl = candidates
      .map((name) => process.env[name])
      .find((value) => typeof value === "string" && value.trim().length > 0);

    if (!webhookUrl) {
      return c.json({ status: 404, message: "Discord webhook not configured for channel" }, 404);
    }

    const forwardPayload: any = {
      content: payload?.content,
      embeds: Array.isArray(payload?.embeds) ? payload.embeds : undefined,
      username: payload?.username,
      avatar_url: payload?.avatar_url,
    };

    // Discord requires at least content, embeds, or file
    if (!forwardPayload.content && (!forwardPayload.embeds || forwardPayload.embeds.length === 0)) {
        return c.json({ 
            status: 400, 
            message: "Invalid payload: Discord requires at least 'content' or 'embeds' to be non-empty." 
        }, 400);
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardPayload),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      const responseBody = await response.text().catch(() => "");
      // Return the actual status from Discord instead of hardcoded 502
      return c.json({ 
          status: response.status, 
          message: "Discord webhook forward failed", 
          discord_error: responseBody 
      }, response.status as any);
    }

    return c.json({ ok: true });
  } catch (error: any) {
    return c.json({ status: 500, message: error?.message || "Discord webhook route failed" }, 500);
  }
});

animeRoutes.get("/health/scrapers", async (c) => {
  const checkedAt = new Date().toISOString();
  const apiBase = `${new URL(c.req.url).origin}/api/v2/anime`;

  const scrapers = await Promise.all(
    SCRAPER_HEALTH_PROBES.map(async (probe, index) => {
      const start = performance.now();
      const id = `source-${String(index + 1).padStart(2, "0")}`;
      const label = `Source ${String(index + 1).padStart(2, "0")}`;

      try {
        const response = await fetch(`${apiBase}${probe.path}`, {
          signal: AbortSignal.timeout(6000),
        });
        const latencyMs = Math.round(performance.now() - start);

        return {
          id,
          label,
          status: classifyScraperHealth(response.status),
          latencyMs,
        };
      } catch {
        return {
          id,
          label,
          status: "down" as const,
          latencyMs: 0,
        };
      }
    })
  );

  const summary = scrapers.reduce(
    (acc, scraper) => {
      acc.total += 1;
      acc[scraper.status] += 1;
      return acc;
    },
    { total: 0, operational: 0, degraded: 0, down: 0 }
  );

  return c.json({
    success: true,
    checkedAt,
    summary,
    scrapers,
  });
});

animeRoutes.route("/animepahe", animepaheRoutes);
animeRoutes.route("/animekai", animekaiRoutes);
animeRoutes.route("/toonstream", toonstreamRoutes);
animeRoutes.route("/animeya", animeyaRoutes);
animeRoutes.route("/animelok", animelokRoutes);
animeRoutes.route("/watchaw", watchawRoutes);
animeRoutes.route("/desidub", desidubanimeRoutes);
animeRoutes.route("/aniworld", aniworldRoutes);
animeRoutes.route("/hindidubbed", hindidubbedRoutes);
animeRoutes.route("/techinmind", techinmindRoutes);
animeRoutes.route("/toonworld", toonworldRoutes);
animeRoutes.route("/mapper", mapperRoutes);
animeRoutes.route("/proxy", proxyRouter);
animeRoutes.route("/hianime/proxy", proxyRouter);

animeRoutes.get("/justanime/stream", async (c) => {
  const id = String(c.req.query("id") || "").trim();
  const server = String(c.req.query("server") || "hd-1").trim() || "hd-1";
  const type = String(c.req.query("type") || "sub").trim() || "sub";

  if (!id) {
    return c.json({ success: false, message: "Missing required query: id" }, 400);
  }

  const upstreamBase = String(process.env.JUSTANIME_API_BASE || "https://core.justanime.fun/api").replace(/\/+$/, "");
  const upstreamUrl = `${upstreamBase}/stream?id=${encodeURIComponent(id)}&server=${encodeURIComponent(server)}&type=${encodeURIComponent(type)}`;

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://justanime.fun",
        Referer: "https://justanime.fun/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });

    const rawText = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get("content-type") || "application/json; charset=utf-8";

    if (!upstreamResponse.ok) {
      const responseHeaders = new Headers({
        "content-type": contentType,
        "cache-control": "no-store",
      });

      return new Response(
        rawText || JSON.stringify({ success: false, message: `Upstream error ${upstreamResponse.status}` }),
        {
          status: upstreamResponse.status,
          headers: responseHeaders,
        }
      );
    }

    const successHeaders = new Headers({
      "content-type": contentType,
      "cache-control": "no-store",
    });

    return new Response(rawText, {
      status: 200,
      headers: successHeaders,
    });
  } catch (error: any) {
    return c.json({ success: false, message: error?.message || "JustAnime proxy request failed" }, 502);
  }
});

// Explicit aliases for legacy/frontend provider IDs
animeRoutes.get("/hindiapi/*", (c) => {
  const path = c.req.url.replace("/hindiapi/", "/techinmind/");
  return c.redirect(path, 301);
});
animeRoutes.get("/anilisthindi/*", (c) => {
  const path = c.req.url.replace("/anilisthindi/", "/techinmind/");
  return c.redirect(path, 301);
});
animeRoutes.get("/desidubanime/*", (c) => {
  const path = c.req.url.replace("/desidubanime/", "/desidub/");
  return c.redirect(path, 301);
});

// Final catch-all for general anime info (HiAnime)
// This captures /api/v2/anime/:animeId and routes to HiAnime
animeRoutes.get("/:animeId", (c) => {
  const animeId = c.req.param("animeId");
  // Don't intercept known provider paths
  const knownProviders = ["animepahe", "animekai", "toonstream", "animeya", "animelok", "watchaw", "desidub", "aniworld", "hindidubbed", "techinmind", "toonworld", "mapper", "justanime"];
  if (knownProviders.includes(animeId)) {
    // This part should technically be reached if sub-routes don't match, 
    // but since we mount sub-routers with .route("/", ...), they don't have a root path here.
    return c.notFound();
  }
  return c.redirect(`/api/v2/hianime/anime/${animeId}`, 307);
});

animeRoutes.get("/:animeId/episodes", (c) => {
  const animeId = c.req.param("animeId");
  return c.redirect(`/api/v2/hianime/anime/${animeId}/episodes`, 307);
});

animeRoutes.get("/:animeId/next-episode-schedule", (c) => {
  const animeId = c.req.param("animeId");
  return c.redirect(`/api/v2/hianime/anime/${animeId}/next-episode-schedule`, 307);
});

animeRoutes.get("/", (c) => {
  return c.json({
    service: "anime",
    description: "Unified anime API — provider-isolated route architecture",
    providers: ["animepahe", "animekai", "toonstream", "animeya", "animelok", "watchaw", "desidub", "aniworld", "hindidubbed", "techinmind", "toonworld"],
  });
});
