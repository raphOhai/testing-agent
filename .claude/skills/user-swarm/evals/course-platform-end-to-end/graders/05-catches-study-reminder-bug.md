---
type: llm
focus: trace
weight: 1
---

The 40-user report flags the study-reminder check as failed because learners who already completed the course received the 'Pick up where you left off' reminder (unexpected recipients), and the final answer explains this as an app bug in src/jobs/index.mjs (the condition checks status !== 'refunded' instead of only active enrollments).
