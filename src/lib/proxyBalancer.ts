type ProxyHealth = {
    id: string;
    url: string;
    failures: number;
    successes: number;
    lastLatencyMs: number;
    cooldownUntil: number;
};

const DEFAULT_TIMEOUT_MS = 12000;
const COOLDOWN_MS = 20000;

export class ProxyBalancer {
    private nodes: ProxyHealth[];
    private rotationCursor = 0;

    constructor(urls: string[]) {
        this.nodes = urls
            .map((url, index) => ({
                id: `proxy-${index + 1}`,
                url: url.trim(),
                failures: 0,
                successes: 0,
                lastLatencyMs: 0,
                cooldownUntil: 0,
            }))
            .filter((node) => node.url.length > 0);
    }

    get hasNodes() {
        return this.nodes.length > 0;
    }

    getStats() {
        return this.nodes.map((n) => ({
            id: n.id,
            url: n.url,
            failures: n.failures,
            successes: n.successes,
            lastLatencyMs: n.lastLatencyMs,
            cooldownUntil: n.cooldownUntil,
        }));
    }

    private score(node: ProxyHealth): number {
        const now = Date.now();
        if (node.cooldownUntil > now) return Number.POSITIVE_INFINITY;
        const penalty = node.failures * 400;
        const latency = node.lastLatencyMs || 100;
        return latency + penalty;
    }

    private pickNode(): ProxyHealth | null {
        if (!this.nodes.length) return null;
        const now = Date.now();
        const eligible = this.nodes.filter((node) => node.cooldownUntil <= now);
        const pool = eligible.length > 0 ? eligible : this.nodes;
        const sorted = [...pool].sort((a, b) => this.score(a) - this.score(b));
        if (sorted.length <= 1) return sorted[0] || null;

        // Rotate between top candidates so traffic does not stick permanently to a single node.
        const topCandidates = sorted.slice(0, Math.min(2, sorted.length));
        const selected = topCandidates[this.rotationCursor % topCandidates.length] || topCandidates[0];
        this.rotationCursor = (this.rotationCursor + 1) % topCandidates.length;
        return selected;
    }

    private reportSuccess(node: ProxyHealth, latencyMs: number) {
        node.successes += 1;
        node.failures = Math.max(0, node.failures - 1);
        node.lastLatencyMs = Math.round(latencyMs);
        node.cooldownUntil = 0;
    }

    private reportFailure(node: ProxyHealth) {
        node.failures += 1;
        if (node.failures >= 2) {
            node.cooldownUntil = Date.now() + COOLDOWN_MS;
        }
    }

    async fetch(
        url: string,
        init?: RequestInit,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        proxyParams?: Record<string, string | number | boolean | undefined>
    ): Promise<Response> {
        if (!this.nodes.length) {
            return fetch(url, init);
        }

        const attempted = new Set<string>();
        let lastError: Error | null = null;

        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.pickNode();
            if (!node || attempted.has(node.id)) continue;
            attempted.add(node.id);

            const query = new URLSearchParams({ url });
            if (proxyParams) {
                for (const [key, value] of Object.entries(proxyParams)) {
                    if (value === undefined || value === null || value === "") continue;
                    query.set(key, String(value));
                }
            }
            const proxyUrl = `${node.url}${node.url.includes("?") ? "&" : "?"}${query.toString()}`;
            const start = performance.now();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const resp = await fetch(proxyUrl, {
                    ...init,
                    headers: {
                        ...init?.headers,
                        "X-Proxy-Hop": "1"
                    },
                    signal: controller.signal,
                });
                clearTimeout(timeout);

                const parsedContentLength = Number(resp.headers.get("content-length") || "");
                const hasExplicitZeroLength = Number.isFinite(parsedContentLength) && parsedContentLength === 0;
                const hasNoUsablePayload = resp.status === 204 || resp.status === 205 || hasExplicitZeroLength;

                if (!resp.ok || hasNoUsablePayload) {
                    this.reportFailure(node);
                    lastError = new Error(`Proxy ${node.id} failed with ${resp.status}`);
                    continue;
                }

                this.reportSuccess(node, performance.now() - start);
                return resp;
            } catch (err) {
                clearTimeout(timeout);
                this.reportFailure(node);
                lastError = err as Error;
            }
        }

        throw lastError || new Error("No healthy proxy available");
    }
}
