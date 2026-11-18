# CI completion-time investigation

The experiment compares template workspace concurrency 1 and 2 without adopting either setting in the normal CI. It runs the jobs from upstream commit `9b131c37d49e97894937f471b5c8b2ea403576ae` (2026-11-15 investigation). The normal checkout and existing working branch are not changed.

## What is measured

Each case executes the actual job graph from `.github/workflows/ci.yml` against the same immutable source. The source's test planner receives representative changed paths from `profiles.json`. Job dependencies, shard counts, timeouts, test commands and failure aggregation are preserved. The template command receives the selected concurrency and uses streamed output so project diagnostics can be compared. Measurement tools are checked out separately and moved outside the source tree before builds and lint.

`active.json` selects the current batch. The initial batch exercises the two ends of the workload: documentation/metadata-only selection and the full plan used by shared configuration changes, unknown files, pushes to main and merge groups. It executes both concurrency settings with dependency caches disabled and enabled: eight complete CI cases. Other profiles remain unmeasured until their batches run. This initial batch is a harness validation, not a completed investigation of all cases.

`profiles.json` covers each current single-rule test-planner category, including distinct focused package sets. Equivalent planner results share one profile and retain their category names as aliases. Mixed changes can select unions of lanes, so these single-rule profiles and the full plan are not every possible combination. Before declaring the investigation complete, add observed mixed-change profiles from recent successful upstream PR runs and compare their effective plans. Design-only PRs skip Typecheck and have no template-concurrency benefit.

The scope is the `CI` workflow. Format, visual regression, query-count automation, preview/release deployment, approvals, and organization-wide contention are separate workflows or external conditions. Their timelines must be inspected before making a claim about all required repository checks or time to merge. This harness does not deploy previews or run write-back automation. Cases run under push/workflow_dispatch event semantics: pull-request-only changeset validation is not exercised. A separate PR-event comparison with a changeset-bearing diff is still required before claiming coverage of every CI condition.

## Cache and timing interpretation

Cold means the workflow's pnpm, Playwright and apt caches are disabled on fresh hosted runners. It does not mean GitHub's VM image or remote registries have cold caches. Warm means the normal cache mechanism is enabled; `context.json` records the actual hits. A warm miss is not accepted as a warm-hit observation. Warm jobs may populate caches for later cases; the first misses require replacement measurements.

One reusable case runs at a time to keep the experiment's own cases from competing for runner slots. Matrix scheduling order is not guaranteed. The initial batch has one observation per condition. Repeat accepted cases at least three times, reverse condition order between batches, and report the individual observations and medians. One sample is insufficient to attribute a small difference to the concurrency change.

The summary records case elapsed time from the first job's start through the final job's completion, summed runner occupancy, and the last job. This includes normal Actions setup, cleanup and measurement-upload overhead. It excludes time waiting before the first job starts and is not a whole-workflow duration, because the parent contains multiple sequential cases. Raw API job timestamps are retained. Queue time after a dependency becomes ready should be calculated from those timestamps separately; start-to-finish runner occupancy is not CPU time.

Each instrumented command records wall time, sampled process-tree RSS, available machine memory, CPU count, kernel, and exit status. RSS sums can double-count shared pages and exclude unrelated processes such as PostgreSQL services; machine available memory complements them. Sampling every 500 ms can miss short peaks. The tools add overhead to both conditions. These records do not provide exact peak RAM, CPU utilization, or a cgroup OOM counter.

Failures, timeouts, missing jobs, diagnostic differences, cache-mode mismatches and measurement errors invalidate a speedup claim. Keep failed observations and classify infrastructure failures separately. Do not count early failure as an improvement or relax test timeouts to make the benchmark green. Compare every template's file count and diagnostics before accepting a pair.

All cases use today's source and actual tests. They do not prove how arbitrary future template growth, larger files, different private runners, or concurrent upstream contributions will behave.

## History verified on 2026-11-15

The first public commit, `43fcb9a13132016aef63cd0d77434c62f7e7631a` (2026-04-01), already specifies `--workspace-concurrency=1` for template and demo typechecks. It also builds before typechecking. The public commit message is only “first commit”; there are no commit comments explaining this concurrency choice. The accessible history establishes when the setting appeared, not why it was chosen. No subsequent change of this setting appeared in the inspected `git log -S` history.

[PR #3442](https://github.com/emdash-cms/emdash/pull/3442), merged as `f3e33d5d28d720e79f5c4442417ad5d6973f657c`, consolidates version, lint and changeset checks into Typecheck to reuse checkout, installation and root build. It reduces runner demand and preserves existing required-check names. It does not introduce serial template checks or document a rejection of two concurrent template processes.

[PR #4329](https://github.com/emdash-cms/emdash/pull/4329), merged on 2026-11-05 as `b3280bc8bd0c754f953ce276e6c815f93838fda1`, splits Node and Cloudflare E2E onto separate jobs after the previous organization concurrency constraint was removed. Its author explicitly accepts additional runner minutes for shorter E2E completion and independent failure reporting. This is parallelism across runners; template concurrency is parallelism inside one runner.

[PR #3757](https://github.com/emdash-cms/emdash/pull/3757) is an unmerged proposal at the time of inspection. Its description reports that concurrent package Vitest pools overloaded a four-core runner and caused timeouts, and proposes running package tests sequentially while retaining parallel builds. This is evidence that nested worker pools can make parallel execution worse. It is not evidence for the original template setting's rationale.

## Criteria from primary documentation

- [GitHub runner specifications](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job): public standard Linux runners currently provide four CPUs and 16 GB RAM. Read the actual runner's CPU and memory data during each run; private repositories and other runner classes can differ.
- [pnpm recursive execution](https://pnpm.io/cli/recursive): workspace concurrency limits simultaneous workspace tasks. Each task can start its own compiler, test or bundler workers, so the effective process count can exceed that limit. Choose concurrency from measured combined workload, not the workspace count alone.
- [GitHub matrix parallelism](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations): `max-parallel` limits matrix jobs across runners. This controls runner demand, not compiler workers inside a job.
- [GitHub dependency caching](https://docs.github.com/en/actions/concepts/workflows-and-actions/dependency-caching): fresh hosted runners rebuild dependency state. Caches reduce repeated downloads but jobs must still work on a miss. Record hit/miss instead of merging both populations.
- [GitHub concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency): cancel superseded PR work when the workflow's semantics permit it. Keep required status contexts, merge-queue coverage and main-branch policy correct.

For this investigation, a good CI detects the same regressions reliably, gives useful failure output, completes required checks promptly, and uses a sustainable amount of runner time. Evaluate elapsed time and its slow tail, rerun/flaky failure rate, memory headroom, queue time and runner occupancy together. There is no universal target percentage of memory utilization or workspace-concurrency value in these sources. A fixed memory reserve would be a project policy, not a GitHub or pnpm rule.

Reducing a non-critical job can save runner occupancy without changing the time a contributor waits for all checks. Keeping all original checks and testing cache misses are acceptance requirements for this experiment. Production adoption remains a separate change after the accepted measurements support it.

## Reproduction

Generate the copied job graph from a locally available immutable commit:

```sh
node scripts/ci-benchmark/generate.mjs 9b131c37d49e97894937f471b5c8b2ea403576ae
node --test scripts/ci-benchmark/run.test.mjs scripts/benchmark-template-typecheck.test.mjs
```

Push the experiment branch to the fork to run the active batch. Artifacts retain individual logs, memory samples summarized per step, cache observations, planner inputs/outputs, raw job timestamps and a case summary for 30 days. Do not infer upstream runner-queue behavior from this fork experiment.
