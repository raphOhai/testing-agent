---
tags: [user-swarm]
max_turns: 120
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

I want to swarm test our course platform, LearnLoop. The code is in ./course-app — start it with `node course-app/server.mjs`, it runs on http://localhost:4700 as a local staging copy (I confirm it's staging, nothing real uses it; prod is learnloop.io). 40 fake users, default mix. Check the emails, the admin metrics and the payments. No need to wait for me to confirm the journey list, write it down and carry on. Do the 1 → 10 → 40 runs, then give me the report and show me what cleanup would delete, but don't actually delete anything.

Input files: course-app/
