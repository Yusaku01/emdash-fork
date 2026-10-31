import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "parse5";

const INDEX_HTML = /\/index\.html$/;
const TRAILING_SLASH = /\/$/;

function decode(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function readPage(html) {
	const ids = new Set();
	const links = [];
	let base;
	function visit(node) {
		const attributes = new Map(node.attrs?.map(({ name, value }) => [name, value]));
		if (attributes.has("id")) ids.add(attributes.get("id"));
		if (node.tagName === "a" && attributes.has("name")) ids.add(attributes.get("name"));
		if ((node.tagName === "a" || node.tagName === "area") && attributes.has("href")) {
			links.push(attributes.get("href"));
		}
		if (node.tagName === "base" && base === undefined) base = attributes.get("href");
		for (const child of node.childNodes ?? []) visit(child);
	}
	visit(parse(html));
	return { ids, links, base };
}

export function checkInternalAnchors(directory, { site, redirects = {} }) {
	const origin = new URL(site).origin;
	const pages = new Map();
	const files = new Set();
	const sources = [];
	function visitDirectory(path, prefix = "") {
		for (const entry of readdirSync(path, { withFileTypes: true }).toSorted((a, b) =>
			a.name.localeCompare(b.name),
		)) {
			const relative = `${prefix}${entry.name}`;
			if (entry.isDirectory()) {
				visitDirectory(join(path, entry.name), `${relative}/`);
			} else if (entry.isFile()) {
				files.add(`/${relative}`);
				if (!relative.endsWith(".html")) continue;
				const pathname = `/${relative}`.replace(INDEX_HTML, "/");
				const page = readPage(readFileSync(join(path, entry.name), "utf8"));
				pages.set(`/${relative}`, page);
				pages.set(pathname, page);
				if (pathname.endsWith("/") && pathname !== "/") {
					pages.set(pathname.slice(0, -1), page);
				}
				sources.push({ pathname, ...page });
			}
		}
	}
	visitDirectory(directory);
	if (sources.length === 0) throw new Error("No generated HTML pages found for anchor checking.");

	const redirectTargets = new Map(
		Object.entries(redirects).map(([path, destination]) => [
			path.replace(TRAILING_SLASH, ""),
			typeof destination === "string" ? destination : destination.destination,
		]),
	);
	const errors = [];
	let links = 0;
	for (const source of sources) {
		const pageUrl = new URL(origin);
		pageUrl.pathname = source.pathname;
		const base = source.base === undefined ? pageUrl : new URL(source.base, pageUrl);
		for (const href of source.links) {
			if (!URL.canParse(href, base)) continue;
			let url = new URL(href, base);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.origin !== origin ||
				!url.href.includes("#")
			)
				continue;
			links++;
			const visited = new Set();
			let redirectLoop = false;
			while (url.origin === origin) {
				const path = decode(url.pathname).replace(TRAILING_SLASH, "");
				const destination = redirectTargets.get(path);
				if (destination === undefined) break;
				if (visited.has(path)) {
					errors.push(`${source.pathname}: ${href} -> redirect loop at ${url.pathname}`);
					redirectLoop = true;
					break;
				}
				visited.add(path);
				const next = new URL(destination, url);
				if (!destination.includes("#")) next.hash = url.hash;
				url = next;
			}
			if (redirectLoop) continue;
			if (url.origin !== origin) continue;
			const path = decode(url.pathname);
			const target = pages.get(path);
			const fragment = url.hash.slice(1).split(":~:")[0];
			if (!target) {
				if (!files.has(path)) {
					errors.push(`${source.pathname}: ${href} -> no generated page at ${url.pathname}`);
				}
			} else if (
				fragment &&
				decode(fragment).toLowerCase() !== "top" &&
				!target.ids.has(fragment) &&
				!target.ids.has(decode(fragment))
			) {
				errors.push(`${source.pathname}: ${href} -> missing #${fragment} in ${url.pathname}`);
			}
		}
	}
	if (errors.length > 0) {
		throw new Error(`Found ${errors.length} broken internal anchor link(s):\n${errors.join("\n")}`);
	}
	return { pages: sources.length, links };
}

/** @returns {import("astro").AstroIntegration} */
export default function internalAnchorCheck() {
	let options;
	return {
		name: "check-internal-anchors",
		hooks: {
			"astro:config:done": ({ config }) => {
				options = { site: config.site, redirects: config.redirects };
			},
			"astro:build:done": ({ dir, logger }) => {
				const result = checkInternalAnchors(fileURLToPath(dir), options);
				logger.info(`Checked ${result.links} internal anchor links in ${result.pages} HTML pages.`);
			},
		},
	};
}
