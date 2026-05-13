import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/*
Loads environment variables when running scripts outside Next.js
*/

function findEnvPath(): string {
	// 1) Prefer the current working directory.
	const cwdPath = path.resolve(process.cwd(), ".env.local");
	if (fs.existsSync(cwdPath)) return cwdPath;

	// 2) Fallback: the repository root (parent of this `services/` folder).
	// This makes `npx tsx trajectos/services/...` work when invoked from a
	// workspace root that is one level above the Next.js project folder.
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const projectRoot = path.resolve(moduleDir, "..");
	return path.resolve(projectRoot, ".env.local");
}

dotenv.config({ path: findEnvPath() });

export {};