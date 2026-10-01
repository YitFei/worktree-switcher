// Runs one service command and appends its output to a log file: `node runner.js <log> <cmd>`.
//
// wts starts this process detached so it outlives the terminal. The shell is started from here,
// *not* detached: a detached cmd.exe has no console and the output of programs it launches is
// lost. Non-detached children also sit in this process's kill-on-close job, so if the runner
// dies its whole tree goes with it.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [log, cmd] = process.argv.slice(2);
const fd = fs.openSync(log, "a");
const child = spawn(cmd, { shell: true, windowsHide: true, stdio: ["ignore", fd, fd] });
fs.closeSync(fd);

child.on("error", (e) => {
  fs.appendFileSync(log, `# wts: failed to start: ${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  fs.appendFileSync(log, `# wts: exited with ${code ?? signal}\n`);
  process.exit(code ?? 1);
});
