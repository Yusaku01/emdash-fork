import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { readDocsBuildOutput } from "./lib/build-output.mjs";

const { workerConfig, workerDirectory, assetsDirectory } = readDocsBuildOutput();

if (
	typeof workerConfig.main !== "string" ||
	!existsSync(resolve(workerDirectory, workerConfig.main))
) {
	throw new Error("The generated Cloudflare deployment does not contain a Worker entrypoint.");
}

if (workerConfig.assets?.binding !== "ASSETS" || !assetsDirectory || !existsSync(assetsDirectory)) {
	throw new Error("The generated Cloudflare Worker does not contain the static asset binding.");
}

if (!workerConfig.ai_search?.some(({ binding }) => binding === "AI_SEARCH")) {
	throw new Error("The generated Cloudflare Worker does not contain the docs search binding.");
}

console.log("Generated Cloudflare deployment contains the docs Worker and static assets.");
