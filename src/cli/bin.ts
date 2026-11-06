#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { factoryHome } from "../home.js";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), {
  home: factoryHome(),
  stdout: process.stdout,
  stderr: process.stderr,
});
