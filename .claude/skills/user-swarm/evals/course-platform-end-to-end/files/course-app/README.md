# LearnLoop API (staging copy)

Online courses. Learners register (email confirmation link), enroll in a course, pay, complete
lessons and get a certificate. Admins create courses and see metrics.

Run locally: `node server.mjs` (port 4700). Email goes to SMTP on localhost:1025 (Mailpit in
staging). Admin endpoints need the `x-admin-token` header (`ADMIN_TOKEN`, default `staging-admin`).
The production site is `learnloop.io` (API at `api.learnloop.io`).
