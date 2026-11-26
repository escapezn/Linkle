const RPC_TIMEOUT = 10 * 1000;
const RPC_RETRIES = 2;
const RPC_RETRY_DELAYS = [1000, 2000];

export type RpcErrorKind = "http" | "rpc" | "timeout" | "json" | "network";

export interface RpcError {
	kind: RpcErrorKind;
	status?: number;
	statusText?: string;
	code?: number;
	message?: string;
	attempts?: number;
}

export interface A2AddUriResult {
	gid?: string;
	error?: RpcError;
}

function normalize_error(err: unknown): RpcError {
	if (err == null) {
		return { kind: "network", message: "unknown error" };
	}
	if (err instanceof Error && err.name === "AbortError") {
		return { kind: "timeout", message: "request timed out" };
	}
	if (err instanceof SyntaxError) {
		return { kind: "json", message: "invalid JSON response" };
	}
	if (typeof err === "object" && "kind" in err) {
		return err as RpcError;
	}
	return {
		kind: "network",
		message: err instanceof Error ? err.message : String(err),
	};
}

function should_retry(err: RpcError): boolean {
	if (err.kind === "rpc" || err.kind === "json") {
		return false;
	}
	if (
		err.kind === "http" &&
		err.status !== undefined &&
		err.status >= 400 &&
		err.status < 500 &&
		err.status !== 408 &&
		err.status !== 429
	) {
		return false;
	}
	return true;
}

export function describe_rpc_error(err: RpcError): string {
	switch (err.kind) {
		case "http":
			return (
				"HTTP " +
				err.status +
				(err.statusText != null && err.statusText !== ""
					? " " + err.statusText
					: "")
			);
		case "rpc":
			return err.message ?? "aria2 error";
		case "timeout":
			return "request timed out";
		case "json":
			return "invalid JSON response";
		default:
			return err.message ?? "unknown error";
	}
}

async function fetch_with_error(
	url: string,
	init: RequestInit,
	timeout?: number, // in milliseconds
): Promise<{ resp?: Response; error?: RpcError }> {
	const ctrl = new AbortController();
	const effective_timeout =
		timeout === undefined || isNaN(timeout) ? 2501 : timeout;
	const timer = setTimeout(() => ctrl.abort(), effective_timeout);
	init.signal = ctrl.signal;

	let resp: Response;
	try {
		resp = await fetch(url, init);
	} catch (err) {
		clearTimeout(timer);
		const normalized = normalize_error(err);
		console.error(`fetch ${url} error:`, err);
		return { error: normalized };
	}
	clearTimeout(timer);
	if (resp.status < 200 || resp.status >= 300) {
		console.error(`fetch ${url}: ${resp.status} ${resp.statusText}`);
		return {
			error: {
				kind: "http",
				status: resp.status,
				statusText: resp.statusText,
			},
		};
	}
	return { resp };
}

// fetch with timeout and error notification
async function fetch_ex(
	url: string,
	init: RequestInit,
	timeout?: number, // in milliseconds
): Promise<Response | undefined> {
	const { resp } = await fetch_with_error(url, init, timeout);
	return resp;
}

// https://aria2.github.io/manual/en/html/aria2c.html#rpc-interface
async function a2_once(
	url: string,
	token: string | undefined,
	method: string,
	args: unknown[],
	timeout?: number,
): Promise<{ result?: unknown; error?: RpcError }> {
	// json-rpc
	const id = Math.random().toString();
	const post = JSON.stringify({
		jsonrpc: "2.0",
		id: id,
		method: `aria2.${method}`,
		params: token !== undefined ? ["token:" + token, ...args] : args,
	});
	const { resp, error } = await fetch_with_error(
		url,
		{
			method: "POST",
			body: post,
			credentials: "omit",
			cache: "no-store",
		},
		timeout,
	);
	if (error !== undefined || resp === undefined) {
		return { error: error ?? { kind: "network", message: "unknown error" } };
	}
	let json: { id?: string; error?: { code?: number; message?: string }; result?: unknown };
	try {
		json = await resp.json();
	} catch (err) {
		const normalized = normalize_error(err);
		console.error(`fetch ${url} json error:`, err);
		return { error: normalized };
	}
	console.assert(json.id === id);
	const err = json.error;
	if (err !== undefined) {
		console.error(`json-rpc error ${err.code}: ${err.message}`);
		return {
			error: {
				kind: "rpc",
				code: err.code,
				message: err.message,
			},
		};
	}
	return { result: json.result };
}

async function a2(
	url: string,
	token: string | undefined,
	method: string,
	args: unknown[],
	timeout?: number,
): Promise<object | undefined> {
	const { result } = await a2_once(url, token, method, args, timeout);
	return result as object | undefined;
}

interface A2Opts {
	[key: string]: string | string[];
}

export async function a2addUri(
	url: string,
	token: string | undefined,
	uris: string[],
	opts: A2Opts,
	timeout?: number,
): Promise<A2AddUriResult> {
	const effective_timeout =
		timeout === undefined || isNaN(timeout) ? RPC_TIMEOUT : timeout;

	for (let attempt = 0; ; attempt++) {
		const { result, error } = await a2_once(
			url,
			token,
			"addUri",
			[uris, opts],
			effective_timeout,
		);
		if (error === undefined) {
			if (typeof result !== "string") {
				console.error("expecting string, got:", result);
				return {
					error: {
						kind: "rpc",
						message: "unexpected aria2 response",
						attempts: attempt + 1,
					},
				};
			}
			return { gid: result };
		}
		if (should_retry(error) && attempt < RPC_RETRIES) {
			await new Promise((resolve) =>
				setTimeout(resolve, RPC_RETRY_DELAYS[attempt]),
			);
			continue;
		}
		error.attempts = attempt + 1;
		return { error };
	}
}

interface A2Status {
	gid: string;
	status: string;
	totalLength: string;
	completedLength: string;
	downloadSpeed: string;
	dir: string;
	files: {
		path: string;
	}[];
}
const A2_STATUS_KEYS = [
	"gid",
	"status",
	"totalLength",
	"completedLength",
	"downloadSpeed",
	"dir",
	"files",
];

export async function a2tellAll(
	url: string,
	token: string | undefined,
	timeout?: number,
): Promise<A2Status[]> {
	const active = await a2(url, token, "tellActive", [A2_STATUS_KEYS], timeout);
	const waiting = await a2(
		url,
		token,
		"tellWaiting",
		[0, 16, A2_STATUS_KEYS],
		timeout,
	);
	const stopped = await a2(
		url,
		token,
		"tellStopped",
		[0, 16, A2_STATUS_KEYS],
		timeout,
	);
	const ret = [];
	for (const resp of [active, waiting, stopped]) {
		if (typeof active !== "object") {
			console.error("expecting array, got:", active);
		} else {
			ret.push(...(resp as A2Status[]));
		}
	}
	return ret;
}

export async function a2remove(
	url: string,
	token: string | undefined,
	gid: string,
	timeout?: number,
): Promise<string> {
	const resp = await a2(url, token, "remove", [gid], timeout);
	if (typeof resp !== "string") {
		console.error("expecting string, got:", resp);
		return "";
	}
	return resp;
}

export async function a2purge(
	url: string,
	token: string | undefined,
	timeout?: number,
): Promise<boolean> {
	const resp = await a2(url, token, "purgeDownloadResult", [], timeout);
	if (typeof resp !== "string") {
		console.error("expecting string, got:", resp);
		return false;
	}
	return resp === "OK";
}

enum HttpMethod {
	Get,
	Post,
	PostMultiPart,
}

// https://github.com/qbittorrent/qBittorrent/wiki/API-Key-Authentication-(%E2%89%A5v5.2.0)
async function qbt(
	api_url: string,
	http_method: HttpMethod,
	api_method: string,
	args: [string, string][],
	key?: string,
	timeout?: number,
): Promise<Response | undefined> {
	const init: RequestInit = {
		method: http_method === HttpMethod.Get ? "GET" : "POST",
		credentials: "omit",
		cache: "no-store"
	};

	let url = `${api_url}/api/v2${api_method}`;

	switch (http_method) {
		case HttpMethod.Get:
			url += "?" + new URLSearchParams(args).toString();
			break;
		case HttpMethod.Post:
			init.body = new URLSearchParams(args);
			break;
		case HttpMethod.PostMultiPart:
			{
				const form = new FormData();
				for (const arg of args) {
					form.append(...arg);
				}
				init.body = form;
			}
			break;
	}

	if (key) {
		const headers = new Headers();
		headers.append("Authorization", `Bearer ${key}`);
		init.headers = headers;
	}
	return await fetch_ex(url, init, timeout);
}

// https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-5.0)#add-new-torrent
// /api/v2/torrents/add
export async function qbt_add(
	url: string,
	link: string,
	args: [string, string][],
	key?: string,
	timeout?: number,
): Promise<boolean | undefined> {
	args.push(["urls", link]);
	const resp = await qbt(
		url,
		HttpMethod.PostMultiPart,
		"/torrents/add",
		args,
		key,
		timeout,
	);
	console.debug("qbt add:", resp?.text());
	if (resp === undefined) {
		return undefined;
	}
	return resp.ok;
}

// /api/v2/torrents/info
export interface QbtInfo {
	hash: string;
	name: string;
	state: string;
	size: number;
	completed: number;
	progress: number;
	dlspeed: number;
	eta: number;
}

export async function qbt_info(
	url: string,
	key?: string,
	timeout?: number,
): Promise<QbtInfo[] | undefined> {
	const resp = await qbt(
		url,
		HttpMethod.Get,
		"/torrents/info",
		[
			["sort", "added_on"],
			["reverse", "true"],
		],
		key,
		timeout,
	);
	if (resp === undefined || !resp.ok) {
		return undefined;
	}
	return (await resp.json()) as QbtInfo[];
}

export async function qbt_delete(
	url: string,
	hashes: string,
	delete_files: boolean,
	key?: string,
	timeout?: number,
): Promise<boolean | undefined> {
	const resp = await qbt(
		url,
		HttpMethod.Post,
		"/torrents/delete",
		[
			["hashes", hashes],
			["deleteFiles", delete_files.toString()],
		],
		key,
		timeout,
	);
	if (resp === undefined) {
		return undefined;
	}
	return resp.ok;
}
