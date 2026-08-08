// The single point where local env enters the process. Both binaries import this first,
// so a `.env` in the working directory is loaded (Node's built-in loader — no dependency)
// before any process.env read. A missing `.env` is fine: values can still come from the
// shell, and auth comes from each tool's own CLI session. The contract — every var the
// tool reads — is documented in .env.example.
//
// `models.local.json` enters the same way, and for the same reason it is a separate file: it holds
// the table ids `sflock init` created in YOUR workspace, it is written by a machine rather than by
// hand, and JSON in a dotenv line is a quoting trap. Loading it here means the read side is env and
// only env (src/models.ts), so importing an agent's config.ts never touches the filesystem — which
// is what keeps the review app's bundle able to import it. The deployed app sets the variable
// directly and this file is simply absent there; an explicit variable always wins.

import { existsSync, readFileSync } from "node:fs";
import { MODELS_ENV } from "./models.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const MODELS_FILE = "models.local.json";
if (!process.env[MODELS_ENV] && existsSync(MODELS_FILE))
	process.env[MODELS_ENV] = readFileSync(MODELS_FILE, "utf8");
