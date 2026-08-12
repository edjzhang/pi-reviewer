import { createServer } from "node:http";
import { exec } from "node:child_process";
import { platform } from "node:os";
import { buildHTML } from "../template.js";
import { readTheme, readViewMode, readAutoCollapseViewed } from "../../config.js";
import { createRequestHandler } from "./routes.js";
export { readTheme, readViewMode, readVerbose, readUi, readMinSeverity, readModel, readThinking, readDefaultBranch } from "../../config.js";
// 5 minutes — long enough that a human reviewing a real diff isn't cut off,
// while the 30s frontend pings keep it alive while the tab is open. The
// pagehide handler covers the normal close; this is just a safety net for
// crashed/closed-without-events. (Was 45s, which auto-closed mid-review when
// a backgrounded tab throttled the ping interval — the agent then proceeded
// without the human's decision, defeating the gate.)
const HEARTBEAT_MS = 300_000;
export async function startUIServer(result, diff, source, ssh, modelConfig, contextGroups) {
    const html = buildHTML(result, diff, source, ssh, readTheme(), readViewMode(), {
        ...modelConfig,
        autoCollapseViewed: readAutoCollapseViewed(),
    }, contextGroups);
    let resolveAction;
    const actionPromise = new Promise((r) => { resolveAction = r; });
    let heartbeatTimer;
    let resolved = false;
    function resolveOnce(action) {
        if (resolved)
            return;
        resolved = true;
        clearTimeout(heartbeatTimer);
        resolveAction(action);
    }
    function resetHeartbeat() {
        if (resolved)
            return;
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => resolveOnce({ type: "closed", decisions: [] }), HEARTBEAT_MS);
    }
    const handler = createRequestHandler(html, resolveOnce, resetHeartbeat);
    const server = createServer(handler);
    const port = await listenOnRandomPort(server);
    const url = "http://localhost:" + port;
    resetHeartbeat();
    openBrowser(url);
    return {
        url,
        waitForAction: () => actionPromise,
        close: () => new Promise((resolve, reject) => {
            clearTimeout(heartbeatTimer);
            server.close((err) => (err ? reject(err) : resolve()));
        }),
    };
}
export function listenOnRandomPort(server) {
    return new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
                reject(new Error("Unexpected server address"));
                return;
            }
            resolve(addr.port);
        });
        server.on("error", reject);
    });
}
export function openBrowser(url) {
    const p = platform();
    if (p === "darwin")
        exec("open " + url);
    else if (p === "win32")
        exec('start "" "' + url + '"');
    else
        exec("xdg-open " + url);
}
