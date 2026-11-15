# Testing agent: the "user swarm" skill

This folder holds a Claude Code skill called **user-swarm**. It tests an app by sending hundreds
of fake users through it at the same time, on a **staging** copy (a private copy where nothing
affects real customers or real money), and then checks that everything adds up:

> "Users who didn't check out: 30 → abandoned-cart emails sent: 28 ❌"
> "Completed orders: 100 → dashboard shows 100 ✅"

## How to use it

Open Claude Code **in this folder** and describe what you want, for example:

- "Swarm test Aerrand with 200 fake users"
- "Make sure the abandoned-cart and reminder emails really go out on Growth staging"
- or type `/user-swarm`

Claude will then:
1. **Ask you first**: which app, where staging is, how many users, the behaviour mix, and what to check.
2. **Read the app's code** and show you the list of user journeys and notifications it found
   (e.g. "abandoned-cart email after 1 hour"), and wait for you to confirm it.
3. **Make staging safe to test**: confirm with you it really is staging, check payments are in
   test mode, and catch every email/SMS/push in a test inbox so nothing reaches a real person.
4. **Write the project's config** in `projects/<app>/` (only that folder is app-specific).
5. **Run 1 user, then 10, then the full number**, fast-forwarding scheduled jobs so "after 3 days"
   reminders fire straight away.
6. **Give you a report** (`projects/<app>/runs/<run>/report.html`) with expected vs actual.
7. **Clean up**: show you what it would delete, then delete every swarm-test record when you say so.

## Rules built into it

- It **refuses to run against production**. The engine checks the address against an allow-list,
  blocks your real domains, and needs your recorded "yes, this is staging" for that exact address.
- **Payments in test mode only.** It stops if it finds a live payment key.
- Every fake user has `swarm-test` in their email, so they're easy to find and delete.
- It won't change your app's code or settings without asking you first.

## Try it on the demo (5 minutes)

A tiny demo shop is included, with two bugs planted on purpose so you can see the report catch them.

```bash
S=".claude/skills/user-swarm/scripts/swarm.mjs"
node $S catcher &                                   # catches emails/SMS/push (page: http://localhost:4599)
node .claude/skills/user-swarm/assets/demo/app.mjs & # the demo shop on http://localhost:4600
node $S all projects/demo-shop --users 1            # one user end to end
node $S all projects/demo-shop --users 200          # the full swarm: two ❌ appear
open projects/demo-shop/runs/*/report.html          # the latest reports
node $S cleanup projects/demo-shop                  # preview what would be deleted
node $S cleanup projects/demo-shop --yes            # delete it
```

With 10 users everything passes. With 200, the report shows that 5 of 30 abandoned carts never
got their email, and that the dashboard revenue forgets refunds. That's why the skill always
scales up before trusting a result.

## What's where

```
.claude/skills/user-swarm/
  SKILL.md              the instructions Claude follows
  scripts/swarm.mjs     the reusable engine (Node 18+, nothing to install)
  scripts/catcher.mjs   built-in test inbox for email, SMS and push
  references/           how-to guides: safety, finding journeys, notifications, time fast-forward, config
  assets/               project template, Mailpit setup, the demo shop
  evals/                a test case used to check the skill itself works on a new app
projects/
  demo-shop/            the demo's config (each app you test gets a folder here)
```

## Using it from any folder

Right now the skill is available when Claude Code is opened in this folder. To make it available
everywhere, link it into your personal skills folder:

```bash
ln -s "$HOME/Desktop/work/testing agent/.claude/skills/user-swarm" ~/.claude/skills/user-swarm
```
