# Rollback

The public surface is a static directory (`site/`) deployed to Vercel from the
repo root, so a rollback is either the platform's own previous deployment or a
redeploy of the previous commit. The code has no other deployed surface; the
runner is a repo people clone.

## Steps

1. In the Vercel dashboard, open the project, go to Deployments, pick the last
   good deployment and choose "Promote to Production". No commands involved.
2. Or from the repo, check out the last good commit's `site/` and redeploy it:

```
git log --oneline -- site
git checkout <good-commit> -- site examples/demo-replay.html
npx <the hosting CLI> --prod
```

3. Confirm with `npm test` on that checkout first: the site test fails if
   `site/demo-replay.html` and `examples/demo-replay.html` disagree, which is
   the one way a partial rollback would be silently wrong.

## Tried

Not yet. The site has never been deployed, so nothing has been rolled back.
This section is deliberately left without a date until it has.
