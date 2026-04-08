import { cache as aniwatchCache } from "../config/cache.js";

export class Cache {
    static async set(key: string, value: any, TTL: number = 300, isJson: boolean = false) {
        const data = isJson ? JSON.stringify(value) : value;
        // @ts-ignore
        await aniwatchCache.client?.set?.(key, data, "EX", TTL);
        return true;
    }

    static async get(key: string, isJson: boolean = false) {
        // @ts-ignore
        const data = (await aniwatchCache.client?.get?.(key)) || null;
        if (data && isJson) {
            try {
                return JSON.parse(data);
            } catch {
                return data;
            }
        }
        return data;
    }

    static async del(key: string) {
        // @ts-ignore
        await aniwatchCache.client?.del?.(key);
        return true;
    }
}
