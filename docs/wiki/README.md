# NNM-Control wiki

- **Русский:** [ru/Home.md](ru/Home.md)
- **English:** [en/Home.md](en/Home.md)

The same pages are in the panel itself: **Help** in the menu.

Editing: change the pages in `ru/` and `en/` together (the same sections in both), then run
`node backend/scripts/wiki-sync.mjs` — it regenerates `API-reference.md` from the API description and
copies the wiki into `frontend/src/wiki` for the Help page. `backend/tests/wiki.test.mjs` fails until
both are done. The page order is in `pages.json`.
