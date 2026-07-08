#!/usr/bin/env node
import { pipeResult, readStdin, runArtilens } from "./run-artilens.mjs";

const input = await readStdin();
pipeResult(runArtilens(["hook", "event-log"], input));
