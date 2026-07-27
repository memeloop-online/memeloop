#!/usr/bin/env node

import { validateWorkerPublishSource } from "./lib/worker-publish-policy.mjs";

const result = validateWorkerPublishSource({
  eventName: process.env.GITHUB_EVENT_NAME,
  expectedSha: process.env.EXPECTED_SOURCE_SHA,
  actualSha: process.env.GITHUB_SHA,
  refType: process.env.GITHUB_REF_TYPE,
  refName: process.env.GITHUB_REF_NAME,
  version: process.env.MEMELOOP_WORKER_VERSION,
});

process.stdout.write(`${JSON.stringify(result)}\n`);
