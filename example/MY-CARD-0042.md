---
id: MY-CARD-0042
title: Verify the deploy pipeline works end-to-end
status: todo
owner: you
sink: probe results appended to this card's Notes
kill: time-boxed to one day; any step failing twice gets its own fix-card
depends_on: []
---
## Action
1. **Build:** the CI build completes green on the main branch.
2. **Artifact:** the built image is pushed to the registry with today's tag.
3. **Deploy:** the staging environment picks up the new tag within 10 minutes.
4. **Smoke:** the /healthz endpoint returns 200 from staging.

## Done when
Every step above has an observed pass/fail recorded in Notes, and every fail has a
corresponding fix-card.

## Notes
(probe results go here)
