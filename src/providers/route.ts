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

type DiscordWebhookChannel = "user_created" | "error_logs" | "comment" | "review_popup";

animeRoutes.post("/webhooks/discord", async (c) => {
  try {
    const payload = await c.req.json<any>();
    const channel = String(payload?.channel || "") as DiscordWebhookChannel;

    const channelEnvMap: Record<DiscordWebhookChannel, string[]> = {
      user_created: ["DISCORD_WEBHOOK_USER_CREATED", "DISCORD_WEBHOOK_USER_CREATED_URL", "DISCORD_WEBHOOK_DEFAULT"],
      error_logs: ["DISCORD_WEBHOOK_ERROR_LOGS", "DISCORD_WEBHOOK_ERROR_LOGS_URL", "DISCORD_WEBHOOK_DEFAULT"],
      comment: ["DISCORD_WEBHOOK_COMMENT", "DISCORD_WEBHOOK_COMMENT_URL", "DISCORD_WEBHOOK_DEFAULT"],
      review_popup: ["DISCORD_WEBHOOK_REVIEW_POPUP", "DISCORD_WEBHOOK_REVIEW_POPUP_URL", "DISCORD_WEBHOOK_DEFAULT"],
    };

    const candidates = channelEnvMap[channel] || ["DISCORD_WEBHOOK_DEFAULT"];
    const webhookUrl = candidates
      .map((name) => process.env[name])
      .find((value) => typeof value === "string" && value.trim().length > 0);

    if (!webhookUrl) {
      return c.json({ status: 404, message: "Discord webhook not configured for channel" }, 404);
    }

    const forwardPayload = {
      content: payload?.content,
      embeds: Array.isArray(payload?.embeds) ? payload.embeds : undefined,
      username: payload?.username,
      avatar_url: payload?.avatar_url,
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(forwardPayload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return c.json({ status: response.status, message: "Discord webhook forward failed", body }, 502);
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

animeRoutes.route("/", animepaheRoutes);
animeRoutes.route("/", animekaiRoutes);
animeRoutes.route("/", toonstreamRoutes);
animeRoutes.route("/", animeyaRoutes);
animeRoutes.route("/", animelokRoutes);
animeRoutes.route("/", watchawRoutes);
animeRoutes.route("/", desidubanimeRoutes);
animeRoutes.route("/", aniworldRoutes);
animeRoutes.route("/", hindidubbedRoutes);
animeRoutes.route("/", techinmindRoutes);
animeRoutes.route("/", toonworldRoutes);

animeRoutes.get("/", (c) => {
  return c.json({
    service: "anime",
    description: "Unified anime API — provider-isolated route architecture",
    providers: ["animepahe", "animekai", "toonstream", "animeya", "animelok", "watchaw", "desidub", "aniworld", "hindidubbed", "techinmind", "toonworld"],
  });
});