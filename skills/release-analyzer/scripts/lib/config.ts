/** Default wording and phrase files for the analyzer, shared by its CLI and the orchestrator. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { Templates, Phrases } from "./analyze.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEMPLATES = resolve(HERE, "../../templates/next_actions.yaml");
export const DEFAULT_PHRASES = resolve(HERE, "../../rules/phrases.yaml");

export function loadTemplates(path = DEFAULT_TEMPLATES): Templates { return YAML.parse(readFileSync(path, "utf8")); }
export function loadPhrases(path = DEFAULT_PHRASES): Phrases { return YAML.parse(readFileSync(path, "utf8")); }
