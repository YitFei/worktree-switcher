import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** This installation's version, from package.json (dist/src/version.js → ../../package.json). */
export const VERSION: string = (() => {
  try {
    const file = fileURLToPath(new URL("../../package.json", import.meta.url));
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();
