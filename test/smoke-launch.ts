/**
 * Smoke test: launch a real pi subagent in a background herdr tab, wait for
 * settlement, then clean up. Run with: npx tsx test/smoke-launch.ts
 *
 * The launch mirrors a real spawn's argv, so the system prompt and the task
 * ride in files: this script stages them under the same directory a spawn
 * uses, `<tmpdir>/pi-cowboy/<agentId>/`.
 */
import { spawnSync } from "node:child_process";
import {
  getCurrentWorkspaceId,
  createAgentTab,
  startPiAgent,
  getAgentInfo,
  closePane,
} from "../src/infrastructure/herdr-client.js";
import {
  subagentResultDirFor,
  subagentSystemFileFor,
  subagentTaskFileFor,
  subagentTokenFor,
} from "../src/paths.js";
import {
  ensureResultDir,
  writeResultFile,
} from "../src/agents/result-file-permissions.js";

/** Stands in for a spawn id: the staging paths and the pane's agent name key on it. */
const AGENT_ID = "smoke-test";

const SYSTEM_PROMPT = [
  "You are a smoke-test subagent launched by the pi-cowboy extension.",
  "Do the task and state the result plainly.",
].join("\n");

const TASK = "Reply with the single word: OK";

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
  // The argv below names these files, so they exist before pi boots: the
  // spawn's own staging step, reproduced.
  ensureResultDir(subagentResultDirFor(AGENT_ID));
  writeResultFile(subagentSystemFileFor(AGENT_ID), SYSTEM_PROMPT);
  writeResultFile(subagentTaskFileFor(AGENT_ID), TASK);

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
    subagentSystemFileFor(AGENT_ID),
    "--append-system-prompt",
    subagentTokenFor(AGENT_ID),
    "--name",
    AGENT_ID,
    "--no-session",
    `@${subagentTaskFileFor(AGENT_ID)}`,
  ];
  await startPiAgent(pi as never, { name: AGENT_ID, paneId, piArgs });
  console.log("pi started in pane");

  const deadline = Date.now() + 90_000;
  let settled = false;
  while (Date.now() < deadline) {
    const info = await getAgentInfo(pi as never, AGENT_ID);
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
