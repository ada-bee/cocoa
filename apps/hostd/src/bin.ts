#!/usr/bin/env bun
// @effect-diagnostics globalConsole:off - This standalone CLI delegates output to its command runner.

import { runHostdCli } from "./cli.ts";

process.exitCode = await runHostdCli(process.argv.slice(2));
