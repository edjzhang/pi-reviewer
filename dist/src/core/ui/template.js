import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
/** Resolve `dist-ui/index.html` whether this module runs from source
 *  (`src/core/ui/template.ts` — 3 levels up to the repo root) or from the
 *  built output (`dist/src/core/ui/template.js` — 4 levels up). The old
 *  fixed `../../../dist-ui` path only worked in source mode; in the built
 *  layout it resolved to `dist/dist-ui/` (nonexistent) and threw ENOENT.
 *  Walk upward until the file is found so both layouts work. */
function findTemplateHtml() {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, "dist-ui", "index.html");
        if (existsSync(candidate))
            return candidate;
        dir = dirname(dir);
    }
    throw new Error(`dist-ui/index.html not found relative to ${__dirname}`);
}
export function buildHTML(result, diff, source, ssh, theme, viewMode, modelConfig, contextGroups) {
    const templateHtml = readFileSync(findTemplateHtml(), "utf-8");
    const escaped = JSON.stringify({ result, diff, source, ssh, theme, viewMode, ...modelConfig, contextGroups })
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");
    return templateHtml.replace("/*%%DATA%%*/null/*%%END%%*/", () => escaped);
}
