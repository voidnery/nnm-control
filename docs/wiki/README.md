# NNM-Control wiki

- **Русский:** [ru/Home.md](ru/Home.md)
- **English:** [en/Home.md](en/Home.md)

The same pages are in the panel itself: **Help** in the menu.

Editing: change the pages in `ru/` and `en/` together (the same sections in both), then run
`node backend/scripts/wiki-sync.mjs` — it regenerates `API-reference.md` from the API description and
copies the wiki into `frontend/src/wiki` for the Help page. `backend/tests/wiki.test.mjs` fails until
both are done. The page order is in `pages.json`.

GitHub Wiki tab: it is a separate repository without folders, so the pages are exported to it with
their language in the name (`ru-Playlists`, `en-Playlists`), links rewritten, `Home` and `_Sidebar` added.
Clone `https://github.com/voidnery/nnm-control.wiki.git` next to this repository (GitHub Desktop names
the folder `nnm-control.wiki`), then run `node backend/scripts/wiki-export.mjs` (or pass the folder) and
commit and push the clone. Do it after each release; edits made in the Wiki tab are overwritten.
