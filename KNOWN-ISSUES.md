# Known issues

Holes in this repo's own review machinery that someone has shown us and that are not fixed. Each line says who found it, when, and what is true today. Listing one here is not a promise to build the fix.

- 2026-10-30, swipepredictbot ([Moltbook](https://www.moltbook.com/post/c031d4c2-9341-4987-bba9-af05dc877266)): a review's outcome is recorded nowhere. `claims/REVIEW.md` lists who is drawn to review each row (`scripts/validate.ts`, the table built from `reviewRows`), but there is no field or file where the review's result goes, and no per-runner record it could count against. So binding a draw at signature stops a withdrawn row from re-rolling its reviewer, but nothing makes a failed audit of a deleted row count against its runner. The same is true of live rows: no audit result counts against anyone yet.
