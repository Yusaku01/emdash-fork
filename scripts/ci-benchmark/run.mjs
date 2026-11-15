import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const profiles = JSON.parse(await readFile(new URL("./profiles.json", import.meta.url), "utf8"));
export function selectProfile(id) {
	const profile = profiles.find((item) => item.id === id);
	if (!profile) throw new Error(`Unknown benchmark profile: ${id}`);
	return profile;
}

export function summarizeCase(jobs) {
	const executed = jobs.filter((job) => job.conclusion !== "skipped");
	const start = Math.min(...executed.map((job) => Date.parse(job.started_at)));
	const end = Math.max(...executed.map((job) => Date.parse(job.completed_at)));
	return {
		valid: executed.length > 0 && executed.every((job) => job.conclusion === "success"),
		elapsedSeconds: (end - start) / 1000,
		runnerSeconds: executed.reduce(
			(sum, job) => sum + (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000,
			0,
		),
		lastJob: executed.find((job) => Date.parse(job.completed_at) === end)?.name,
		jobs: executed.map(({ name, conclusion, started_at, completed_at }) => ({
			name,
			conclusion,
			started_at,
			completed_at,
		})),
	};
}

async function main() {
	const mode = process.argv[2];
	if (mode === "plan") {
		const profile = selectProfile(process.env.BENCHMARK_PROFILE);
		const { createTestPlan, formatGitHubOutput } = await import(
			pathToFileURL(resolve(".github/scripts/test-plan.mjs"))
		);
		const plan = createTestPlan(profile.paths);
		const directory = resolve(process.env.RUNNER_TEMP, "ci-measurements");
		await mkdir(directory, { recursive: true });
		await writeFile(resolve(directory, "plan.json"), JSON.stringify({ profile, plan }, null, 2));
		process.stdout.write(formatGitHubOutput(plan));
	} else if (mode === "context") {
		const directory = resolve(process.env.RUNNER_TEMP, "ci-measurements");
		await mkdir(directory, { recursive: true });
		const keys = [
			"CI_BENCH_SOURCE",
			"CI_BENCH_CASE",
			"CI_BENCH_CACHE",
			"CI_BENCH_WORKERS",
			"GITHUB_SHA",
			"RUNNER_OS",
			"RUNNER_ARCH",
			"DEPENDENCY_CACHE_HIT",
			"BROWSER_CACHE_HIT",
			"APT_CACHE_HIT",
		];
		await writeFile(
			resolve(directory, "context.json"),
			JSON.stringify(
				Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])),
				null,
				2,
			),
		);
	} else if (mode === "matrix") {
		const ids = JSON.parse(await readFile(new URL("./active.json", import.meta.url), "utf8"));
		const include = [];
		for (const id of ids) {
			selectProfile(id);
			for (const cache of ["cold", "warm"]) {
				for (const workers of [1, 2])
					include.push({ id: `${id}-${cache}-w${workers}`, profile: id, cache, workers });
			}
		}
		process.stdout.write(`cases=${JSON.stringify({ include })}\n`);
	} else if (mode === "collect") {
		const jobs = [];
		for (let page = 1; ; page++) {
			const response = await fetch(
				`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs?filter=latest&per_page=100&page=${page}`,
				{
					headers: {
						Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
						Accept: "application/vnd.github+json",
					},
				},
			);
			if (!response.ok) throw new Error(`Reading workflow jobs failed: ${response.status}`);
			const result = await response.json();
			jobs.push(...result.jobs);
			if (result.jobs.length < 100) break;
		}
		const ids = JSON.parse(await readFile(new URL("./active.json", import.meta.url), "utf8"));
		const cases = [];
		for (const id of ids)
			for (const cache of ["cold", "warm"])
				for (const workers of [1, 2]) {
					const caseId = `${id}-${cache}-w${workers}`;
					const selected = jobs.filter((job) => job.name.startsWith(`${caseId} / `));
					if (!selected.length) throw new Error(`Missing jobs for ${caseId}`);
					cases.push({ id: caseId, profile: id, cache, workers, ...summarizeCase(selected) });
				}
		await mkdir("ci-benchmark-results", { recursive: true });
		await writeFile("ci-benchmark-results/jobs.json", JSON.stringify(jobs, null, 2));
		await writeFile("ci-benchmark-results/summary.json", JSON.stringify(cases, null, 2));
		await appendFile(
			process.env.GITHUB_STEP_SUMMARY,
			"| Case | Valid | Elapsed seconds | Runner seconds | Last job |\n|---|---|---:|---:|---|\n" +
				cases
					.map(
						(item) =>
							`| ${item.id} | ${item.valid} | ${item.elapsedSeconds} | ${item.runnerSeconds} | ${item.lastJob} |`,
					)
					.join("\n") +
				"\n",
		);
	} else throw new Error("Expected plan, matrix, or collect");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
