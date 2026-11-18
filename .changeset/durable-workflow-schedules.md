---
"eve": minor
---

Add `workflowScheduleProvider()` from `eve/experimental/schedules/workflow`, a durable provider for dynamic schedules that runs on eve's Workflow world, so dynamic schedules work under `eve start` without Vercel.

Each schedule is one durable workflow run that sleeps until its next occurrence, so schedules and their state survive restarts. An occurrence that comes due while the server is down runs once when it is back, missed cron occurrences coalesce into the latest one, and a failed occurrence retries before `occurrence.failed` fires without stopping the schedule. Changing a schedule replaces its run.
