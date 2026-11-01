import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function readDocsBuildOutput(docsDirectory = resolve(import.meta.dirname, "../..")) {
	const deployConfigPath = resolve(docsDirectory, ".wrangler/deploy/config.json");
	const deployConfig = JSON.parse(readFileSync(deployConfigPath, "utf8"));
	const workerConfigPath = resolve(dirname(deployConfigPath), deployConfig.configPath);
	const workerConfig = JSON.parse(readFileSync(workerConfigPath, "utf8"));
	const workerDirectory = dirname(workerConfigPath);
	const assetsDirectory =
		typeof workerConfig.assets?.directory === "string"
			? resolve(workerDirectory, workerConfig.assets.directory)
			: undefined;
	return { workerConfig, workerDirectory, assetsDirectory };
}
