import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { checkInternalAnchors } from "./check-internal-anchors.mjs";

const site = "https://docs.example.com";

function fixture(t, files) {
	const directory = mkdtempSync(join(tmpdir(), "docs-anchors-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	return directory;
}

void test("fails on stale same-page and cross-page links after a heading is renamed", (t) => {
	const directory = fixture(t, {
		"guide/index.html": '<a href="#old-section">Local</a><h2 id="new-section">New section</h2>',
		"index.html": '<a href="/guide/#old-section">Guide</a>',
	});
	assert.throws(
		() => checkInternalAnchors(directory, { site }),
		(error) => {
			assert.ok(error.message.includes("Found 2 broken internal anchor link"));
			assert.ok(error.message.includes("/guide/: #old-section -> missing #old-section in /guide/"));
			assert.ok(error.message.includes("/: /guide/#old-section -> missing #old-section"));
			return true;
		},
	);
	writeFileSync(
		join(directory, "guide/index.html"),
		'<a href="#new-section">Local</a><h2 id="new-section">New section</h2>',
	);
	writeFileSync(join(directory, "index.html"), '<a href="/guide/#new-section">Guide</a>');
	assert.doesNotThrow(() => checkInternalAnchors(directory, { site }));
});

void test("uses rendered IDs, named anchors and browser URL resolution", (t) => {
	const directory = fixture(t, {
		"guide/index.html": `
			<h2 id="generated-1">Duplicate heading</h2><div id="custom-id"></div>
			<a name="legacy"></a><div id="a&amp;b"></div><div id="a+b"></div>
			<div id="%61"></div><div id="100%"></div>
			<a href="#generated-1">Generated ID</a><a href="?q=1#custom-id">Query</a>
			<a href="./#legacy">Named anchor</a><a href="#a&amp;b">HTML entity</a>
			<a href="#a%2Bb">Encoded plus</a><a href="#%61">Literal percent ID</a>
			<a href="#100%">Percent sign</a><a href="#">Page top</a><a href="#ToP">Page top</a>
			<a href="#generated-1:~:text=heading">Text directive with ID</a>
			<a href="#:~:text=heading">Text directive</a>
			<a href="../日本語/#見出し">Unicode</a>
			<a href="../%E6%97%A5%E6%9C%AC%E8%AA%9E/#%E8%A6%8B%E5%87%BA%E3%81%97">Encoded Unicode</a>
		`,
		"日本語/index.html": '<h2 id="見出し">Heading</h2>',
		"index.html": `
			<a href="/guide#custom-id">Without trailing slash</a>
			<a href="/guide/index.html#custom-id">HTML file</a>
			<a href="${site}/guide/#custom-id">Absolute URL</a>
			<a href="//docs.example.com/guide/#custom-id">Protocol-relative URL</a>
			<a href="/guide/?a=1&amp;b=2#custom-id">Query and entity</a>
		`,
	});
	assert.doesNotThrow(() => checkInternalAnchors(directory, { site }));
});

void test("does not treat escaped code, scripts, comments or templates as live links", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<pre><code>&lt;a href="#missing"&gt;Example&lt;/a&gt;</code></pre>
			<script>const example = '<a href="#missing">Example</a>';</script>
			<!-- <a href="#missing">Example</a> -->
			<template><a href="#missing">Example</a></template>
		`,
	});
	assert.equal(checkInternalAnchors(directory, { site }).links, 0);
});

void test("does not accept an ID that exists only in an inert template or code example", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="#missing">Broken</a><template><h2 id="missing">Example</h2></template>
			<pre><code>&lt;h2 id="missing"&gt;Example&lt;/h2&gt;</code></pre>
		`,
	});
	assert.throws(
		() => checkInternalAnchors(directory, { site }),
		(error) => error.message.includes("missing #missing"),
	);
});

void test("checks real links inside code blocks and matches IDs case-sensitively", (t) => {
	const directory = fixture(t, {
		"index.html": '<h2 id="section"></h2><pre><a href="#Section">Link</a></pre>',
	});
	assert.throws(
		() => checkInternalAnchors(directory, { site }),
		(error) => error.message.includes("missing #Section"),
	);
});

void test("follows configured redirects, inheriting or replacing fragments", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="/old/#section">Inherited</a><a href="/replaced#old">Replaced</a>
			<a href="/cleared#old">Cleared</a><a href="/external#missing">External</a>
		`,
		"guide/index.html": '<h2 id="section">Section</h2>',
	});
	const redirects = {
		"/old": "/intermediate",
		"/intermediate": { destination: "/guide/", status: 301 },
		"/replaced": "/guide/#section",
		"/cleared": "/guide/#",
		"/external": "https://example.com/guide/",
	};
	assert.doesNotThrow(() => checkInternalAnchors(directory, { site, redirects }));
	assert.throws(
		() =>
			checkInternalAnchors(directory, {
				site,
				redirects: { ...redirects, "/old": "/guide/#missing" },
			}),
		(error) => error.message.includes("missing #missing in /guide/"),
	);
});

void test("reports missing pages and redirect loops instead of silently skipping them", (t) => {
	const directory = fixture(t, {
		"index.html":
			'<a href="/missing/#section">Missing</a><a href="/loop#section">Loop</a><a href="/empty/#">Empty fragment</a>',
	});
	assert.throws(
		() => checkInternalAnchors(directory, { site, redirects: { "/loop": "/loop" } }),
		(error) => {
			assert.ok(error.message.includes("no generated page at /missing/"));
			assert.ok(error.message.includes("no generated page at /empty/"));
			assert.ok(error.message.includes("redirect loop"));
			return true;
		},
	);
});

void test("ignores external URLs, non-HTTP schemes, non-HTML assets and links without fragments", (t) => {
	const directory = fixture(t, {
		"index.html": `
			<a href="https://example.com/#missing">External</a><a href="mailto:me@example.com#x">Mail</a>
			<a href="blob:${site}/example#missing">Blob</a><a href="/missing/">No fragment</a>
			<a href="/image.svg#icon">SVG</a><a href="/book.pdf#page=2">PDF</a>
		`,
		"image.svg": '<svg><symbol id="icon"/></svg>',
		"book.pdf": "pdf",
	});
	assert.doesNotThrow(() => checkInternalAnchors(directory, { site }));
});

void test("resolves relative links against the document base URL", (t) => {
	const directory = fixture(t, {
		"index.html": '<base href="/guide/"><a href="#section">Section</a>',
		"guide/index.html": '<h2 id="section">Section</h2>',
	});
	assert.doesNotThrow(() => checkInternalAnchors(directory, { site }));
});

void test("fails if the build output contains no HTML", (t) => {
	const directory = fixture(t, {});
	assert.throws(
		() => checkInternalAnchors(directory, { site }),
		(error) => error.message.includes("No generated HTML pages found"),
	);
});
