import { createServer, type Server, type ServerResponse } from "node:http";

/** https://fetch.spec.whatwg.org/#bad-port: these ports cannot be reached by Fetch or browsers. */
const FETCH_BLOCKED_PORTS = new Set([
	1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
	111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
	540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
	6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** Bind atomically and return a listening port; automatic allocation excludes browser-blocked ports. */
export async function listenOnBrowserSafePort(
	server: Server,
	options: { host: string; port?: number },
): Promise<number> {
	for (let candidate = 0; candidate < 20; candidate++) {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? 0, options.host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("OAuth callback server did not bind to TCP");
		if ((options.port ?? 0) !== 0 || !FETCH_BLOCKED_PORTS.has(address.port)) return address.port;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
	throw new Error("Could not allocate a browser-safe TCP port");
}

export interface OAuthCallback {
	code: string;
	state: string;
	iss?: string;
}

/** Outcome shown on the browser page after the redirect. */
export type OAuthCallbackPage = { ok: true } | { ok: false; message: string; details?: string };

export interface OAuthCallbackServerOptions {
	/** Address to listen on. Default: `127.0.0.1`. */
	host?: string;
	/**
	 * Host name in `redirectUrl`, for example `localhost` for a client registered with it while
	 * listening on `127.0.0.1`. Default: `host`.
	 */
	redirectHost?: string;
	port?: number;
	path?: string;
	/** More paths that receive the callback, for example a server-specific path of a redirect URI. */
	extraPaths?: string[];
	timeoutMs?: number;
	/** Render the browser page as HTML. Default: a plain-text message. */
	renderPage?: (page: OAuthCallbackPage) => string;
}

function plainText(page: OAuthCallbackPage): string {
	if (page.ok) return "Authorization complete. You may close this window.";
	return page.details ? `${page.message}\n\n${page.details}` : page.message;
}

export class OAuthCallbackServer {
	readonly redirectUrl: string;
	private server: Server;
	private paths: string[];
	private timeoutMs: number;
	private renderPage: ((page: OAuthCallbackPage) => string) | undefined;
	private pending = new Map<
		string,
		{
			resolve: (callback: OAuthCallback) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			path: string | undefined;
		}
	>();

	private constructor(
		server: Server,
		redirectUrl: string,
		paths: string[],
		timeoutMs: number,
		renderPage: ((page: OAuthCallbackPage) => string) | undefined,
	) {
		this.server = server;
		this.redirectUrl = redirectUrl;
		this.paths = paths;
		this.timeoutMs = timeoutMs;
		this.renderPage = renderPage;
	}

	static async listen(options: OAuthCallbackServerOptions = {}): Promise<OAuthCallbackServer> {
		const host = options.host ?? "127.0.0.1";
		const redirectHost = options.redirectHost ?? host;
		const path = options.path ?? "/callback";
		let instance: OAuthCallbackServer | undefined;
		const server = createServer((request, response) => instance?.handle(request.url ?? "/", response));
		const port = await listenOnBrowserSafePort(server, { host, port: options.port });
		instance = new OAuthCallbackServer(
			server,
			`http://${redirectHost.includes(":") ? `[${redirectHost}]` : redirectHost}:${port}${path}`,
			[path, ...(options.extraPaths ?? [])],
			options.timeoutMs ?? 5 * 60_000,
			options.renderPage,
		);
		return instance;
	}

	/**
	 * Wait for the authorization response with `state`. With `path`, a response on another path fails, so
	 * a server-specific redirect URI can tell authorization servers apart (RFC 9700 section 4.4.2.2).
	 */
	waitForCallback(state: string, path?: string): Promise<OAuthCallback> {
		if (this.pending.has(state)) throw new Error("OAuth state is already pending");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(state);
				reject(new Error("OAuth callback timed out"));
			}, this.timeoutMs);
			this.pending.set(state, { resolve, reject, timer, path });
		});
	}

	async close(): Promise<void> {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("OAuth callback server closed"));
		}
		this.pending.clear();
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private reply(response: ServerResponse, status: number, page: OAuthCallbackPage): void {
		if (this.renderPage) {
			response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
			response.end(this.renderPage(page));
		} else {
			response.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(plainText(page));
		}
	}

	private handle(rawUrl: string, response: ServerResponse): void {
		const url = new URL(rawUrl, this.redirectUrl);
		if (!this.paths.includes(url.pathname)) {
			this.reply(response, 404, { ok: false, message: "Not found" });
			return;
		}
		const state = url.searchParams.get("state");
		const pending = state ? this.pending.get(state) : undefined;
		if (!state || !pending) {
			this.reply(response, 400, { ok: false, message: "Invalid or expired OAuth state" });
			return;
		}
		clearTimeout(pending.timer);
		this.pending.delete(state);
		if (pending.path !== undefined && url.pathname !== pending.path) {
			pending.reject(new Error("The authorization response arrived on another redirect URI"));
			this.reply(response, 400, { ok: false, message: "Unexpected redirect URI" });
			return;
		}
		const error = url.searchParams.get("error");
		if (error) {
			const description = url.searchParams.get("error_description") ?? error;
			pending.reject(new Error(description));
			this.reply(response, 200, {
				ok: false,
				message: "Authorization failed. You may close this window.",
				details: description,
			});
			return;
		}
		const code = url.searchParams.get("code");
		if (!code) {
			pending.reject(new Error("OAuth callback did not include an authorization code"));
			this.reply(response, 400, { ok: false, message: "Missing authorization code" });
			return;
		}
		const iss = url.searchParams.get("iss");
		pending.resolve({ code, state, ...(iss ? { iss } : {}) });
		this.reply(response, 200, { ok: true });
	}
}
