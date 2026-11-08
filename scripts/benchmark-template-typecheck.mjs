import { execFileSync, spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { availableParallelism, arch, platform, release, totalmem } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateFilter = "{./templates/*}";
const concurrencyOrder = [1, 2, 2, 1, 1, 2];
const projectOutputPattern = /^(templates\/\S+) typecheck[:$]\s?(.*)$/;
const resultPattern = /Result \((\d+) files?\):/;
const diagnosticPattern = /\b(?:error|warning|hint) (?:ts|astro)\(/;
const processWhitespacePattern = /\s+/;
const summaryPatterns = ["errors", "warnings", "hints"].map((kind) => [
	kind,
	new RegExp(`^\\s*(?:-\\s*)?(\\d+) ${kind.slice(0, -1)}s?\\s*$`),
]);

export function parseTemplateResults(log, expectedPaths) {
	const projects = new Map();
	for (const line of stripVTControlCharacters(log).split("\n")) {
		const match = line.match(projectOutputPattern);
		if (!match) continue;
		const [, path, message] = match;
		if (!expectedPaths.includes(path)) throw new Error(`Unexpected project: ${path}`);
		const project = projects.get(path) ?? { path, diagnostics: [] };
		projects.set(path, project);
		const result = message.match(resultPattern);
		if (result) project.files = Number(result[1]);
		for (const [kind, pattern] of summaryPatterns) {
			const count = message.match(pattern);
			if (count) project[kind] = Number(count[1]);
		}
		if (diagnosticPattern.test(message)) {
			project.diagnostics.push(message);
		}
	}
	return expectedPaths.toSorted().map((path) => {
		const project = projects.get(path);
		if (
			!project ||
			![project.files, project.errors, project.warnings, project.hints].every(Number.isInteger)
		) {
			throw new Error(`Missing diagnostic summary: ${path}`);
		}
		return { ...project, diagnostics: project.diagnostics.toSorted() };
	});
}

export function compareTemplateResults(expected, actual) {
	if (JSON.stringify(expected) !== JSON.stringify(actual)) {
		throw new Error("Template file counts or diagnostic results changed between trials");
	}
}

function commandOutput(command, args) {
	return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

export function sumProcessTreeRssKiB(snapshot, rootPid) {
	const processes = snapshot.split("\n").map((line) => {
		const [pid, parentPid, rss] = line.trim().split(processWhitespacePattern).map(Number);
		return { pid, parentPid, rss };
	});
	const descendants = new Set([rootPid]);
	let found = true;
	while (found) {
		found = false;
		for (const process of processes) {
			if (descendants.has(process.parentPid) && !descendants.has(process.pid)) {
				descendants.add(process.pid);
				found = true;
			}
		}
	}
	return processes.reduce(
		(sum, process) => sum + (descendants.has(process.pid) ? process.rss : 0),
		0,
	);
}

function processTreeRssKiB(rootPid) {
	const snapshot = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
	return sumProcessTreeRssKiB(snapshot, rootPid);
}

async function measure(concurrency, logPath) {
	const args = [
		"run",
		"--stream",
		`--workspace-concurrency=${concurrency}`,
		"--filter",
		templateFilter,
		"typecheck",
	];
	const descriptor = openSync(logPath, "w");
	const started = performance.now();
	const child = spawn("pnpm", args, {
		cwd: repositoryRoot,
		detached: true,
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", descriptor, descriptor],
	});
	const state = { closed: false };
	let peakRssKiB = 0;
	let spawnError;
	const exited = new Promise((resolveExit) => {
		child.once("error", (error) => {
			spawnError = error;
		});
		child.once("close", (code, signal) => {
			state.closed = true;
			resolveExit({ code, signal, seconds: (performance.now() - started) / 1000 });
		});
	});
	try {
		while (!state.closed) {
			if (child.pid) peakRssKiB = Math.max(peakRssKiB, processTreeRssKiB(child.pid));
			await delay(200);
		}
		if (spawnError) throw spawnError;
		return { ...(await exited), command: ["pnpm", ...args], peakRssMiB: peakRssKiB / 1024 };
	} finally {
		if (!state.closed && child.pid) process.kill(-child.pid, "SIGTERM");
		closeSync(descriptor);
	}
}

function median(values) {
	const sorted = values.toSorted((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
	const outputIndex = process.argv.indexOf("--output");
	if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
		throw new Error("Usage: node scripts/benchmark-template-typecheck.mjs --output /tmp/results");
	}
	const outputDirectory = resolve(process.argv[outputIndex + 1]);
	await mkdir(outputDirectory, { recursive: true });
	const directories = await readdir(join(repositoryRoot, "templates"), { withFileTypes: true });
	const expectedPaths = [];
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const path = `templates/${directory.name}`;
		const manifest = JSON.parse(await readFile(join(repositoryRoot, path, "package.json"), "utf8"));
		if (manifest.scripts?.typecheck) expectedPaths.push(path);
	}
	expectedPaths.sort();
	if (expectedPaths.length === 0) throw new Error("No template typechecks found");
	const report = {
		commit: commandOutput("git", ["rev-parse", "HEAD"]),
		node: process.version,
		pnpm: commandOutput("pnpm", ["--version"]),
		ci: process.env.CI ?? null,
		system: {
			platform: platform(),
			release: release(),
			arch: arch(),
			cpus: availableParallelism(),
			memoryGiB: totalmem() / 1024 ** 3,
		},
		expectedPaths,
		memoryMeasurement:
			"Sum of process-tree RSS sampled every 200 ms; shared pages may be counted more than once",
		cacheConditions:
			"Template .astro directories removed before every trial; dependency and OS caches remain warm",
		trials: [],
	};
	let reference;
	try {
		for (const [index, concurrency] of concurrencyOrder.entries()) {
			for (const path of expectedPaths) {
				await rm(join(repositoryRoot, path, ".astro"), { recursive: true, force: true });
			}
			const logPath = join(outputDirectory, `trial-${index + 1}-concurrency-${concurrency}.log`);
			console.log(`Trial ${index + 1}/${concurrencyOrder.length}: concurrency ${concurrency}`);
			const measured = await measure(concurrency, logPath);
			const trial = {
				index: index + 1,
				concurrency,
				...measured,
				log: relative(outputDirectory, logPath),
			};
			report.trials.push(trial);
			if (trial.code !== 0) throw new Error(`Typecheck failed; inspect ${logPath}`);
			trial.projects = parseTemplateResults(await readFile(logPath, "utf8"), expectedPaths);
			if (reference) compareTemplateResults(reference, trial.projects);
			else reference = trial.projects;
			commandOutput("git", ["diff", "--exit-code", "--", "templates"]);
			console.log(
				`${trial.seconds.toFixed(2)} s; sampled peak RSS ${trial.peakRssMiB.toFixed(0)} MiB; ${trial.projects.length} templates`,
			);
		}
		report.summary = [1, 2].map((concurrency) => {
			const trials = report.trials.filter((trial) => trial.concurrency === concurrency);
			return {
				concurrency,
				medianSeconds: median(trials.map((trial) => trial.seconds)),
				maxRssMiB: Math.max(...trials.map((trial) => trial.peakRssMiB)),
			};
		});
		report.reductionPercent =
			(1 - report.summary[1].medianSeconds / report.summary[0].medianSeconds) * 100;
		const table = [
			"## Template typecheck benchmark",
			"",
			"| Concurrency | Median seconds (3 trials) | Maximum sampled process-tree RSS (MiB) |",
			"| --- | ---: | ---: |",
			...report.summary.map(
				(row) =>
					`| ${row.concurrency} | ${row.medianSeconds.toFixed(2)} | ${row.maxRssMiB.toFixed(0)} |`,
			),
			"",
			`${expectedPaths.length} templates; matching file counts, error/warning/hint counts and diagnostic headers in every trial.`,
			`Measured reduction: ${report.reductionPercent.toFixed(1)}%. This measures the template step, not the whole CI workflow.`,
			"Process-tree RSS is sampled every 200 ms and may count shared pages more than once.",
		].join("\n");
		console.log(table);
		if (process.env.GITHUB_STEP_SUMMARY)
			await appendFile(process.env.GITHUB_STEP_SUMMARY, table + "\n");
	} finally {
		await writeFile(join(outputDirectory, "results.json"), JSON.stringify(report, null, 2) + "\n");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}
