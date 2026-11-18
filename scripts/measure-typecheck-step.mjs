import { spawn, execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sumProcessTreeRssKiB } from "./benchmark-template-typecheck.mjs";

const script = process.argv[2];
if (!script || !process.env.RUNNER_TEMP) {
	throw new Error("Expected a shell script path and RUNNER_TEMP");
}

const started = performance.now();
const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
	stdio: "inherit",
});
let peakRssKiB = 0;
let samples = 0;
let samplingErrors = 0;
const sample = () => {
	if (!child.pid) return;
	try {
		const snapshot = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
		peakRssKiB = Math.max(peakRssKiB, sumProcessTreeRssKiB(snapshot, child.pid));
		samples++;
	} catch {
		samplingErrors++;
	}
};
const timer = setInterval(sample, 200);
sample();
const result = await new Promise((resolve) => {
	child.once("error", (error) => resolve({ code: 1, error: error.message }));
	child.once("close", (code, signal) => resolve({ code, signal }));
});
clearInterval(timer);
const report = {
	step: process.env.GITHUB_ACTION ?? null,
	...result,
	seconds: (performance.now() - started) / 1000,
	peakProcessTreeRssMiB: peakRssKiB / 1024,
	samples,
	samplingErrors,
};
await appendFile(
	join(process.env.RUNNER_TEMP, "full-typecheck-measurements.jsonl"),
	JSON.stringify(report) + "\n",
);
console.log("Step measurement:", JSON.stringify(report));
if (process.env.GITHUB_STEP_SUMMARY) {
	await appendFile(
		process.env.GITHUB_STEP_SUMMARY,
		`- ${report.step}: ${report.seconds.toFixed(2)} s; sampled process-tree RSS ${report.peakProcessTreeRssMiB.toFixed(0)} MiB; exit ${report.code}; sampling errors ${samplingErrors}\n`,
	);
}
process.exitCode = result.code ?? 1;
