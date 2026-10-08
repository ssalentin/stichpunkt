import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MEMORY_LIMIT = 300;

/** Renders diagrams through an internal Kroki container; SVG is cached by hash of type + source. */
export class KrokiClient {
	private mem = new Map<string, string>();
	private inflight = new Map<string, Promise<string>>();

	constructor(
		private baseUrl: string,
		private cacheDir: string,
		private timeoutMs = 15_000
	) {}

	static key(kroki: string, source: string): string {
		return createHash('sha256').update(`${kroki}\0${source}`).digest('hex').slice(0, 40);
	}

	async cached(key: string): Promise<string | null> {
		if (!/^[a-f0-9]{40}$/.test(key)) return null;
		const hit = this.mem.get(key);
		if (hit) return hit;
		try {
			const svg = await fs.readFile(path.join(this.cacheDir, `${key}.svg`), 'utf8');
			this.remember(key, svg);
			return svg;
		} catch {
			return null;
		}
	}

	private remember(key: string, svg: string) {
		this.mem.delete(key);
		this.mem.set(key, svg);
		if (this.mem.size > MEMORY_LIMIT) this.mem.delete(this.mem.keys().next().value!);
	}

	/** Returns the cache key of the rendered SVG; throws with Kroki's message on failure. */
	async render(kroki: string, source: string): Promise<string> {
		const key = KrokiClient.key(kroki, source);
		if (await this.cached(key)) return key;
		const running = this.inflight.get(key);
		if (running) return running;
		const job = this.fetchSvg(kroki, source, key).finally(() => this.inflight.delete(key));
		this.inflight.set(key, job);
		return job;
	}

	private async fetchSvg(kroki: string, source: string, key: string): Promise<string> {
		if (!this.baseUrl) throw new Error('Kroki is not configured (KROKI_URL is empty)');
		let res: Response;
		try {
			res = await fetch(`${this.baseUrl}/${kroki}/svg`, {
				method: 'POST',
				headers: { 'Content-Type': 'text/plain' },
				body: source,
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (e) {
			throw new Error(`Kroki is not reachable: ${(e as Error).message}`);
		}
		const text = await res.text();
		if (!res.ok) throw new Error(text.trim().slice(0, 600) || `Kroki answered HTTP ${res.status}`);
		this.remember(key, text);
		try {
			await fs.mkdir(this.cacheDir, { recursive: true });
			await fs.writeFile(path.join(this.cacheDir, `${key}.svg`), text);
		} catch {
			// disk cache is best effort
		}
		return key;
	}
}
