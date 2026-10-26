#!/usr/bin/env node
/**
 * Production deploys run only from GitHub Actions on `main`, after CI has
 * passed on the pull request and on the merge. A deploy from a laptop stops
 * here. This guards against accidents; the real boundary is the protected
 * `production` environment, which only `main` can deploy to.
 */
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REF !== "refs/heads/main") {
  console.error(
    "Refusing to deploy: production deploys run only from GitHub Actions on main. Merge a pull request instead.",
  );
  process.exit(1);
}
