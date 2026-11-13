import assert from "node:assert/strict";
import test from "node:test";

import {
	compareTemplateResults,
	parseTemplateResults,
	sumProcessTreeRssKiB,
} from "./benchmark-template-typecheck.mjs";

const paths = ["templates/blog", "templates/starter"];
const missingSummaryPattern = /Missing diagnostic summary/;
const unexpectedProjectPattern = /Unexpected project/;
const changedDiagnosticsPattern = /diagnostic results changed/;
const summary = (path, errors = 0) => `${path} typecheck: Result (5 files):
${path} typecheck: - ${errors} errors
${path} typecheck: - 0 warnings
${path} typecheck: - 0 hints`;

test("counts descendants across subprocess wrappers and excludes unrelated processes", () => {
	const snapshot = "30 20 300\n10 1 100\n40 1 400\n20 10 200\n";
	assert.equal(sumProcessTreeRssKiB(snapshot, 10), 600);
});

test("compares interleaved template results without depending on completion order", () => {
	const sequential = parseTemplateResults(paths.map((path) => summary(path)).join("\n"), paths);
	const lines = paths.map((path) => summary(path).split("\n"));
	const interleaved = lines[0].flatMap((line, index) => [lines[1][index], line]).join("\n");
	const parallel = parseTemplateResults(interleaved, paths);
	compareTemplateResults(sequential, parallel);
});

test("rejects missing and unexpected template results", () => {
	assert.throws(() => parseTemplateResults(summary(paths[0]), paths), missingSummaryPattern);
	assert.throws(
		() => parseTemplateResults(summary("templates/other"), paths),
		unexpectedProjectPattern,
	);
});

test("reads singular warning and hint summaries", () => {
	const log = summary(paths[0]).replace("0 warnings", "1 warning").replace("0 hints", "1 hint");
	const [project] = parseTemplateResults(log, [paths[0]]);
	assert.equal(project.warnings, 1);
	assert.equal(project.hints, 1);
});

test("rejects a changed error count or diagnostic even when the file count is unchanged", () => {
	const before = parseTemplateResults(summary(paths[0]), [paths[0]]);
	const after = parseTemplateResults(summary(paths[0], 1), [paths[0]]);
	assert.throws(() => compareTemplateResults(before, after), changedDiagnosticsPattern);
	const diagnostic = parseTemplateResults(
		summary(paths[0]) + `\n${paths[0]} typecheck: src/index.ts:1:1 - hint ts(6133): unused`,
		[paths[0]],
	);
	assert.throws(() => compareTemplateResults(before, diagnostic), changedDiagnosticsPattern);
});
