import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { selectProfile, summarizeCase } from "./run.mjs";

const UNKNOWN_PROFILE = /Unknown benchmark profile/;
const VISIBLE_OUTPUT = /visible-output/;
const UNREACHABLE_OUTPUT = /unreachable/;
const execute = promisify(execFile);
const job = (name, start, end, conclusion = "success") => ({
	name,
	started_at: `2026-11-15T00:00:${start}Z`,
	completed_at: `2026-11-15T00:00:${end}Z`,
	conclusion,
});

test("uses wall time for overlapping jobs and sums runner occupancy separately", () => {
	const summary = summarizeCase([
		job("plan", "00", "02"),
		job("typecheck", "02", "12"),
		job("e2e", "02", "22"),
		job("aggregate", "22", "23"),
	]);
	assert.equal(summary.elapsedSeconds, 23);
	assert.equal(summary.runnerSeconds, 33);
	assert.equal(summary.lastJob, "aggregate");
	assert.equal(summary.valid, true);
});

test("a shorter typecheck does not shorten the suite when E2E finishes later", () => {
	const baseline = [job("typecheck", "00", "15"), job("e2e", "00", "20")];
	const candidate = [job("typecheck", "00", "10"), job("e2e", "00", "20")];
	assert.equal(summarizeCase(baseline).elapsedSeconds, summarizeCase(candidate).elapsedSeconds);
});

test("failed and missing cases cannot be accepted as successful speedups", () => {
	assert.equal(summarizeCase([job("test", "00", "01", "failure")]).valid, false);
	assert.equal(summarizeCase([]).valid, false);
	assert.throws(() => selectProfile("made-up"), UNKNOWN_PROFILE);
});

test("measurement wrapper preserves output, stops after failure, and records subprocess usage", async () => {
	const directory = await mkdtemp(join(tmpdir(), "emdash-ci-measure-"));
	try {
		const script = join(directory, "step.sh");
		await writeFile(
			script,
			"echo visible-output\nnode -e 'setTimeout(() => {}, 650)'\nexit 7\necho unreachable\n",
		);
		let result;
		try {
			await execute(
				process.execPath,
				[new URL("./measure.mjs", import.meta.url).pathname, script],
				{ env: { ...process.env, RUNNER_TEMP: directory, GITHUB_ACTION: "check" } },
			);
		} catch (error) {
			result = error;
		}
		assert.equal(result.code, 7);
		assert.match(result.stdout, VISIBLE_OUTPUT);
		assert.doesNotMatch(result.stdout, UNREACHABLE_OUTPUT);
		const measurement = JSON.parse(
			(await readFile(join(directory, "ci-measurements/steps.jsonl"), "utf8")).trim(),
		);
		assert.equal(measurement.code, 7);
		assert.ok(measurement.seconds >= 0.65);
		assert.ok(measurement.peakProcessTreeRssMiB > 0);
		assert.equal(measurement.samplingErrors, 0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
