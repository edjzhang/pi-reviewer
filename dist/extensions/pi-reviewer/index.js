import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";
import { readVerbose, readMinSeverity, readModel, readThinking } from "../../src/core/ui/server/index.js";
import { parseArgs } from "./args.js";
import { resolveCurrentModelId } from "./model.js";
import { handleDryRun } from "./handlers/dry-run.js";
import { handleLocalReview } from "./handlers/local.js";
import { handleSSHReview } from "./handlers/ssh.js";
import { checkSimplifyRan } from "./handlers/simplify-check.js";
/**
 * String that appears at the start of every /simplify prompt.
 * If pi-simplify changes its prompt, update this to match.
 */
const SIMPLIFY_PROMPT_SIGNATURE = "Review the following recently changed files and apply simplification improvements";
const MARKER_DIR = ".pi";
const MARKER_FILE = ".simplify-ran";
export { buildSSHSource } from "./handlers/ssh.js";
function resolveCommonOpts(parsed, ctx, pi, notify, loaderState) {
    const minSeverity = parsed.minSeverity ?? readMinSeverity();
    const verbose = parsed.verbose ?? readVerbose();
    const model = parsed.model ?? readModel();
    const thinking = parsed.thinking ?? readThinking();
    const defaultModel = readModel();
    const availableModels = ctx.modelRegistry.getAvailable().map((m) => ({
        id: m.id,
        name: (m.name ?? m.id),
        provider: m.provider,
    }));
    const sessionModel = ctx.model ? { id: ctx.model.id, provider: ctx.model.provider } : undefined;
    const currentModelId = resolveCurrentModelId(model, availableModels, sessionModel);
    const defaultThinking = readThinking();
    return { pi, loaderState, notify, minSeverity, verbose, model, thinking, currentModelId, defaultModel, availableModels, defaultThinking };
}
async function enforceSimplifyRan(cwd, ctx, notify) {
    const simplifyCheck = await checkSimplifyRan(cwd);
    if (!simplifyCheck.ran) {
        const proceed = await ctx.ui.confirm("/simplify has not been run", "REVIEW.md requires /simplify to be run before /review. Run /simplify first, or proceed anyway?");
        if (!proceed) {
            notify("Review cancelled — run /simplify first, then /review again.", "warning");
            return false;
        }
        notify("Proceeding without /simplify — REVIEW.md rules will still flag this.", "warning");
    }
    else if (simplifyCheck.stale) {
        const shortRef = simplifyCheck.currentRef.slice(0, 7);
        const proceed = await ctx.ui.confirm("/simplify marker is stale", `The /simplify marker is from commit ${simplifyCheck.marker.ref.slice(0, 7)}, but the current HEAD is ${shortRef}. Run /simplify again, or proceed anyway?`);
        if (!proceed) {
            notify("Review cancelled — run /simplify first, then /review again.", "warning");
            return false;
        }
        notify("Proceeding with stale /simplify marker — REVIEW.md rules will still flag this.", "warning");
    }
    else {
        notify("/simplify marker found ✓", "info");
    }
    return true;
}
export default function (pi) {
    // Write .pi/.simplify-ran when /simplify is invoked,
    // so /review can verify it ran for the current commit.
    pi.on("before_agent_start", async (event, ctx) => {
        const prompt = event.prompt ?? "";
        if (!prompt.includes(SIMPLIFY_PROMPT_SIGNATURE))
            return;
        const dir = path.join(ctx.cwd, MARKER_DIR);
        const filePath = path.join(dir, MARKER_FILE);
        let ref = "unknown";
        try {
            ref = execSync("git rev-parse HEAD", { cwd: ctx.cwd, encoding: "utf-8" }).trim();
        }
        catch {
            // not a git repo
        }
        const stamp = JSON.stringify({ timestamp: new Date().toISOString(), ref });
        await mkdir(dir, { recursive: true });
        await writeFile(filePath, stamp, "utf-8");
    });
    pi.registerCommand("review", {
        description: "Review a PR diff with pi-reviewer (flags: --diff, --branch, --pr, --ssh, --ui, --dry-run)",
        async handler(args, ctx) {
            const notify = ctx.ui.notify.bind(ctx.ui);
            const loaderState = { stop: () => { } };
            let sshMode = false;
            try {
                const parsed = parseArgs(args);
                sshMode = parsed.ssh;
                const common = resolveCommonOpts(parsed, ctx, pi, notify, loaderState);
                // Local reviews require /simplify to have been run first (enforced by marker file)
                if (!parsed.dryRun && !parsed.ssh) {
                    if (!(await enforceSimplifyRan(ctx.cwd, ctx, notify)))
                        return;
                }
                if (parsed.dryRun)
                    return void (await handleDryRun({ parsed, cwd: ctx.cwd, ...common }));
                if (parsed.ssh)
                    return void (await handleSSHReview({ parsed, ctx, ...common }));
                return void (await handleLocalReview({ parsed, ctx, ...common }));
            }
            catch (error) {
                loaderState.stop();
                const message = error instanceof Error ? error.message : String(error);
                const hint = !sshMode && message.includes("not a git repository")
                    ? "\n\nNot in a git repository — if you're in an SSH session, try adding --ssh."
                    : "";
                notify(`Review failed: ${message}${hint}`, "error");
            }
        },
    });
}
