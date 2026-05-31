import { readFile } from "node:fs/promises";
import path from "node:path";
const SIMPLIFY_MARKER_PATH = ".pi/.simplify-ran";
/**
 * Check whether /simplify has been run for the current commit.
 * Returns null if no marker file exists, or the parsed marker if found.
 */
export async function readSimplifyMarker(cwd) {
    const filePath = path.join(cwd, SIMPLIFY_MARKER_PATH);
    try {
        const content = await readFile(filePath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
/**
 * Get the current HEAD ref for the repo at cwd.
 * Returns "unknown" if git is not available.
 */
export async function getCurrentRef(cwd) {
    try {
        const { execSync } = await import("node:child_process");
        return execSync("git rev-parse HEAD", { cwd, encoding: "utf-8" }).trim();
    }
    catch {
        return "unknown";
    }
}
/**
 * Check whether /simplify has been run for the current commit.
 * Returns a result object with status and details.
 */
export async function checkSimplifyRan(cwd) {
    const [marker, currentRef] = await Promise.all([
        readSimplifyMarker(cwd),
        getCurrentRef(cwd),
    ]);
    if (!marker) {
        return { ran: false, stale: false, marker: null, currentRef };
    }
    const stale = marker.ref !== currentRef;
    return { ran: true, stale, marker, currentRef };
}
