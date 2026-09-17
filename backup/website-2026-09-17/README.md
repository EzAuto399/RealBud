# RealBud website — offsite backup, 2026-09-17

`website/` is a **separate git repository with no remote configured**. When this
backup was first taken its working tree held 39 uncommitted paths — including the
entire billing portal, magic-link auth, `/start`, `/download`, `/admin` and
`middleware.ts` — and none of it existed anywhere except this one Mac.

**Refreshed later the same day** (HEAD moved `e1387f7` → `9da34f4`). The 39 paths
have since been committed in the website repo locally, and two fixes landed on
top: the `/account/support` auth guard, and refusing a checkout URL that cannot
take money. Both are in these artifacts. The website repo still has **no remote**,
so this directory remains the only offsite copy.

These two artifacts are a complete, verified snapshot. They are temporary: delete
this directory once `website/` has a real remote of its own (see below).

## What is here

| File | What it holds |
|---|---|
| `realbud-website-history.bundle` | Every ref in the website repo — complete git history, HEAD = `9da34f4` |
| `realbud-website-working-tree.tar.gz` | The working tree *as it is on disk*, including anything uncommitted |

The bundle alone would **not** have been enough at first: a bundle only carries
committed content, and the billing portal was never committed. The tar is why
nothing was lost.

`.env.local` is deliberately excluded from the tar — it holds an auth secret and a
Supabase service-role key. Recreate it from `website/.env.example`.

## Restore

```bash
# Full history
git clone backup/website-2026-09-17/realbud-website-history.bundle realbud-website

# Working tree on top (uncommitted state included)
tar -xzf backup/website-2026-09-17/realbud-website-working-tree.tar.gz
```

The bundle is self-contained — `git bundle verify` succeeds without the original
repository present.

## The real fix (pick one, then delete this backup)

**A — give `website/` its own remote.** Keeps its five-commit history and suits the
Vercel root-directory build:

```bash
cd website
gh repo create EzAuto399/RealBud-website --private --source=. --remote=origin
git add -A && git commit -m "Build the invite-only billing portal and pilot onboarding"
git push -u origin main
```

**B — fold it into the main repo.** One repo to back up; the website's own history
is flattened into a single commit:

```bash
rm -rf website/.git
git add website/ && git commit -m "Bring the website into the main repo"
```

Do **not** simply `git add website/` while `website/.git` still exists: git records
it as a gitlink to a commit that exists on no server, and the main repo stops being
clonable by anyone else.
