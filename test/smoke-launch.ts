/**
 * Smoke test: launch a real pi subagent in a background herdr tab, wait for
 * settlement, then clean up. Run with: npx tsx test/smoke-launch.ts
 */
import { spawnSync } from "node:child_process";
import {
  getCurrentWorkspaceId,
  createAgentTab,
  startPiAgent,
  getAgentInfo,
  closePane,
} from "../src/infrastructure/herdr-client.js";

const herdr = (
  args: string[],
): { code: number; stdout: string; stderr: string } => {
  const r = spawnSync("herdr", args, { encoding: "utf8" });
  // A spawn that never ran has no exit status; report that instead of inventing
  // a code and handing back empty streams as if herdr had answered.
  if (r.status === null) {
    throw new Error(
      `herdr ${args.join(" ")} could not run: ${r.error?.message ?? "no exit status"}`,
    );
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const pi = {
  exec: async (_cmd: string, args: string[]) => herdr(args),
} as never;

async function main() {
  const workspaceId = await getCurrentWorkspaceId(pi as never);
  console.log("workspace:", workspaceId);

  const { tabId, paneId } = await createAgentTab(pi as never, {
    workspaceId,
    cwd: "/tmp/wt-smoke",
    label: "smoke",
  });
  console.log("tab:", tabId, "pane:", paneId);

  const piArgs = [
    "--system-prompt",
    "/tmp/wt-smoke/system.md",
    "--append-system-prompt",
    "cowboy-subagent-smoke-test",
    "--name",
    "smoke-test",
    "--no-session",
    "@/tmp/wt-smoke/prompt.md",
  ];
  await startPiAgent(pi as never, { name: "smoke-test", paneId, piArgs });
  console.log("pi started in pane");

  const deadline = Date.now() + 90_000;
  let settled = false;
  while (Date.now() < deadline) {
    const info = await getAgentInfo(pi as never, "smoke-test");
    if (!info) {
      console.log("agent gone");
      break;
    }
    console.log("state:", info.state);
    if (info.state === "done" || info.state === "idle") {
      settled = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log(settled ? "SETTLED ✓" : "NOT SETTLED ✗");
  await closePane(pi as never, paneId);
  console.log("pane closed");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("SMOKE FAILED:", err);
    process.exit(1);
  },
);
