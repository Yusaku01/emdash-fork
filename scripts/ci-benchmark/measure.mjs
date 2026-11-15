import { spawn, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { availableParallelism, totalmem, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { sumProcessTreeRssKiB } from "../benchmark-template-typecheck.mjs";

const AVAILABLE_MEMORY = /^MemAvailable:\s+(\d+)/m;
const script = process.argv[2];
if (!script || !process.env.RUNNER_TEMP) throw new Error("Expected script and RUNNER_TEMP");
const directory = join(process.env.RUNNER_TEMP, "ci-measurements");
await mkdir(directory, { recursive: true });
const step = process.env.GITHUB_ACTION ?? "local";
const log = createWriteStream(join(directory, `${step}.log`));
const started = performance.now();
const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
	stdio: ["inherit", "pipe", "pipe"],
});
const completion = new Promise((resolve) => {
	child.once("error", (error) => resolve({ code: 1, error: error.message }));
	child.once("close", (code, signal) => resolve({ code, signal }));
});
child.stdout.on("data", (data) => {
	process.stdout.write(data);
	log.write(data);
});
child.stderr.on("data", (data) => {
	process.stderr.write(data);
	log.write(data);
});
let peakRssKiB = 0;
let minAvailableKiB = Infinity;
let samples = 0;
let samplingErrors = 0;
const sample = () => {
	try {
		if (child.pid)
			peakRssKiB = Math.max(
				peakRssKiB,
				sumProcessTreeRssKiB(
					execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }),
					child.pid,
				),
			);
		samples++;
	} catch {
		samplingErrors++;
	}
};
const memory = async () => {
	try {
		const text = await readFile("/proc/meminfo", "utf8");
		minAvailableKiB = Math.min(
			minAvailableKiB,
			Number(text.match(AVAILABLE_MEMORY)?.[1] ?? Infinity),
		);
	} catch {
		/* Linux memory data is unavailable on local macOS runs. */
	}
};
const timer = setInterval(() => {
	sample();
	void memory();
}, 500);
sample();
await memory();
const result = await completion;
clearInterval(timer);
await new Promise((resolve) => log.end(resolve));
const report = {
	step,
	...result,
	seconds: (performance.now() - started) / 1000,
	peakProcessTreeRssMiB: peakRssKiB / 1024,
	minMachineAvailableMiB: Number.isFinite(minAvailableKiB) ? minAvailableKiB / 1024 : null,
	cpus: availableParallelism(),
	totalMemoryMiB: totalmem() / 1024 / 1024,
	kernel: release(),
	samples,
	samplingErrors,
};
await appendFile(join(directory, "steps.jsonl"), `${JSON.stringify(report)}\n`);
console.log("CI measurement:", JSON.stringify(report));
process.exitCode = result.code ?? 1;
