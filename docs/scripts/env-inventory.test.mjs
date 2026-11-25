import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	collectSourceEnvVars,
	extractDocumentedEnvVars,
	findMissingSourceEnvVars,
} from "./lib/env-inventory.mjs";

function fixture(t, files) {
	const directory = mkdtempSync(join(tmpdir(), "docs-env-inventory-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), content);
	}
	return directory;
}

void test("collects runtime EMDASH_* env vars from TS, JS, and Astro sources", (t) => {
	const root = fixture(t, {
		"core/src/env.ts": `
			export interface Env {
				EMDASH_ROOMS?: unknown;
			}
			export function read(env: Record<string, string | undefined>) {
				const a = process.env.EMDASH_URL;
				const b = env["EMDASH_SITE_URL"];
				const c = env[\`EMDASH_TOKEN\`];
				return [a, b, c];
			}
		`,
		"core/src/Component.astro": `---
const key = process.env.EMDASH_TURNSTILE_SECRET_KEY;
---
<div>{key}</div>
`,
	});

	const found = collectSourceEnvVars(root);
	assert.deepEqual([...found].toSorted(), [
		"EMDASH_ROOMS",
		"EMDASH_SITE_URL",
		"EMDASH_TOKEN",
		"EMDASH_TURNSTILE_SECRET_KEY",
		"EMDASH_URL",
	]);
});

void test("ignores comments, non-env identifiers, test files, and dist output", (t) => {
	const root = fixture(t, {
		"core/src/noise.ts": `
			// EMDASH_DATABASE_URL is not read anywhere
			const EMDASH_PREFIX_PATTERN = /^emdash_/;
			declare const __EMDASH_VERSION__: string;
			export const ok = process.env.EMDASH_SITE_URL;
		`,
		"core/src/noise.test.ts": `
			const fake = process.env.EMDASH_TEST_ONLY;
		`,
		"core/tests/env.ts": `
			const fake = process.env.EMDASH_TESTS_DIR;
		`,
		"core/dist/env.js": `
			const fake = process.env.EMDASH_DIST_ONLY;
		`,
	});

	const found = collectSourceEnvVars(root);
	assert.deepEqual([...found], ["EMDASH_SITE_URL"]);
});

void test("extracts documented EMDASH_* variables only from the Environment variables section", () => {
	const markdown = `
## Intro

Mentioning \`EMDASH_OUTSIDE_SECTION\` in prose should not be extracted.

## Environment variables

| Variable | Description |
| --- | --- |
| \`EMDASH_URL\` | Remote URL |
| \`EMDASH_DATABASE_URL\` | Phantom variable |
| \`SITE_URL\` | Non-EMDASH fallback |

## Next section

| \`EMDASH_LATER_SECTION\` | Should not be extracted |
`;

	assert.deepEqual(extractDocumentedEnvVars(markdown), ["EMDASH_URL", "EMDASH_DATABASE_URL"]);
});

void test("reports documented env vars missing from source while allowing undocumented internal env vars", () => {
	const sourceEnvVars = new Set(["EMDASH_URL", "EMDASH_QUERY_LOG", "EMDASH_PSEUDO_LOCALE"]);
	const issues = findMissingSourceEnvVars(
		{
			"docs/src/content/docs/reference/cli.mdx": ["EMDASH_URL", "EMDASH_DATABASE_URL"],
			"docs/src/content/docs/reference/configuration.mdx": ["EMDASH_URL"],
		},
		sourceEnvVars,
	);

	assert.deepEqual(issues, [
		{
			file: "docs/src/content/docs/reference/cli.mdx",
			variable: "EMDASH_DATABASE_URL",
		},
	]);
});
