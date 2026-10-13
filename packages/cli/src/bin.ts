#!/usr/bin/env node
import { text } from "node:stream/consumers";
import { machineIo } from "./machine.ts";
import { run } from "./run.ts";

process.exitCode = await run(
  process.argv.slice(2),
  await machineIo({
    platform: process.platform,
    env: process.env,
    argv: process.argv,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    stdin: () => text(process.stdin),
  }),
);
