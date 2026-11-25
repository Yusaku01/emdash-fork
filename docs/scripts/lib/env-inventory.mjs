import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import ts from "typescript";

const ENV_VAR_PATTERN = /^EMDASH_[A-Z0-9_]+$/;
const ENV_TABLE_ROW_PATTERN = /^\|\s*`(EMDASH_[A-Z0-9_]+)`\s*\|/gm;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "tests", "__tests__"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const ASTRO_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

function extractEnvVarsFromTsSource(filePath, text, target) {
	const kind =
		filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
			? ts.ScriptKind.TSX
			: filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")
				? ts.ScriptKind.JS
				: ts.ScriptKind.TS;
	const sourceFile = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, kind);

	function visit(node) {
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			ENV_VAR_PATTERN.test(node.text)
		) {
			target.add(node.text);
		} else if (ts.isPropertyAccessExpression(node) && ENV_VAR_PATTERN.test(node.name.text)) {
			target.add(node.name.text);
		} else if (
			ts.isPropertySignature(node) &&
			ts.isIdentifier(node.name) &&
			ENV_VAR_PATTERN.test(node.name.text)
		) {
			target.add(node.name.text);
		}
		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
}

export function collectSourceEnvVars(rootDirectory) {
	const found = new Set();

	function walk(directory) {
		if (!existsSync(directory)) return;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const fullPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
				walk(fullPath);
				continue;
			}
			if (!entry.isFile() || TEST_FILE_PATTERN.test(entry.name)) continue;

			const extension = extname(entry.name);
			if (!TS_EXTENSIONS.has(extension) && extension !== ".astro") continue;

			const text = readFileSync(fullPath, "utf8");
			if (!text.includes("EMDASH_")) continue;

			if (extension === ".astro") {
				const frontmatter = ASTRO_FRONTMATTER_PATTERN.exec(text)?.[1];
				if (frontmatter) extractEnvVarsFromTsSource(`${fullPath}.ts`, frontmatter, found);
				continue;
			}

			extractEnvVarsFromTsSource(fullPath, text, found);
		}
	}

	walk(rootDirectory);
	return found;
}

export function extractDocumentedEnvVars(markdown, heading = "## Environment variables") {
	const start = markdown.indexOf(`${heading}\n`);
	if (start === -1) throw new Error(`Could not find ${heading}`);
	const next = markdown.indexOf("\n## ", start + heading.length);
	const section = markdown.slice(start, next === -1 ? undefined : next);
	return [...new Set(Array.from(section.matchAll(ENV_TABLE_ROW_PATTERN), (match) => match[1]))];
}

export function findMissingSourceEnvVars(documentedByFile, sourceEnvVars) {
	const issues = [];
	for (const [file, variables] of Object.entries(documentedByFile)) {
		const missing = variables
			.filter((variable) => !sourceEnvVars.has(variable))
			.toSorted((a, b) => a.localeCompare(b));
		for (const variable of missing) {
			issues.push({ file, variable });
		}
	}
	return issues;
}
