#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { factoryHome } from "../home.js";
import { runCli } from "./run.js";

// Ctrl-C stops a long-running command (`run`, `logs --follow`) cleanly; a second one exits at once.
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stop.signal.aborted) process.exit(130);
    stop.abort();
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  home: factoryHome(),
  stdout: process.stdout,
  stderr: process.stderr,
  signal: stop.signal,
});
