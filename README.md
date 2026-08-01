# filler-scrape

Scrapes [animefillerlist.com](https://www.animefillerlist.com) and publishes **`filler.json`**: a map of AniList media id to the list of filler episode numbers for that show.

It exists to produce a drop-in data file for an app that asks a single binary question at playback time: *is episode N of this show filler?*

---

## Output format

`filler.json` is one JSON object.

- **Keys** are AniList media ids, **as strings**.
- **Values** are arrays of filler episode numbers: integers, ascending, deduped, ranges expanded.
- Shows with **no filler are omitted entirely** — never emitted as an empty array.

```json
{
  "20": [26, 97, 101, 102, 103, 104, 105, 106, 136, 137, 138, 139, 140, 143, "…", 219],
  "269": [33, 50, 60, "…"]
}
```

Key `"20"` is Naruto. Its quick list on the site reads `26, 97, 101-106, 136-140, 143-219`, which expands to **90** episode numbers.

Two companion files are written alongside it:

| File | Purpose |
| --- | --- |
| `filler.json` | The data the app consumes. |
| `mapping.json` | Committed cache of `slug -> anilistId` for **automatically resolved** shows only. Stops later runs re-querying AniList. It is a cache, not a control surface — see [Overrides](#overrides). |
| `unmatched.json` | Every show that was **not** emitted, with the reason and the AniList candidates that were considered — plus any pinned show that **was** emitted despite failing its check, flagged `"published": true`. |

---

## What counts as filler

The site classifies every episode as one of four types. Only one of them is treated as filler:

| Site category | Treated as filler? |
| --- | --- |
| Manga Canon | No |
| Anime Canon | No |
| **Mixed Canon/Filler** | **No** |
| Filler | **Yes** |

**Mixed Canon/Filler is deliberately treated as canon.** A mixed episode advances the real story alongside padding, so skipping it loses plot. This also matches the data the consuming app already ships — Naruto episodes 7, 9 and 14-16 are Mixed on the site and are absent from its filler array.

### Quick List vs the episode table

Every show page carries both a "Quick List" summary (`26, 97, 101-106, …`) and a full per-episode table. The scraper **prefers the Quick List**, falls back to the table when the Quick List is missing or empty, and when both are present **cross-checks them and reports any disagreement** as a warning rather than silently trusting one. Unparseable range tokens are skipped and reported, not thrown on, so one typo cannot fail a whole run.

---

## AniList mapping

This is where the quality of the output is won or lost. **A wrong mapping is worse than a missing one** — it makes the app label the wrong episodes as filler. So the matcher is biased hard towards refusing to answer.

A mapping is only emitted when the show title **exactly matches** (after normalisation) the romaji, English, or a synonym of exactly one AniList entry. Normalisation folds case, punctuation, long vowels (`ō` → `o`) and `&` → `and`, but deliberately **keeps** year suffixes so that `Fullmetal Alchemist (2009)` cannot collide with `Fullmetal Alchemist`.

Anything else goes to `unmatched.json` with its candidates:

| Reason | Meaning |
| --- | --- |
| `no-candidates` | Search returned nothing of a plausible format. |
| `no-exact-title-match` | Best candidate was only a fuzzy match. |
| `ambiguous` | Several distinct entries matched exactly and no tiebreak was decisive. |
| `synonym-only-match` | See below. |
| `episode-count-overflow` | See below. |
| `duplicate-anilist-id` | Two shows resolved to the same id; neither is merged. |
| `excluded-by-override` | Deliberately excluded in `overrides.json`. |
| `invalid-override` | The `overrides.json` value was neither a positive integer nor `null`. |
| `invalid-cached-mapping` | The `mapping.json` id was not a positive integer. Re-run with `--refresh` or set an override. |
| `fetch-failed` / `anilist-error` | Network problem for that one show. |

Three more reasons appear with `"published": true`. Those shows **were** emitted — a pin is an explicit decision and is never silently refused — but something about the pin did not check out and the run said so loudly:

| Reason (published anyway) | Meaning |
| --- | --- |
| `override-episode-count-overflow` | The pinned entry has fewer episodes than the site now lists. See [the episode-numbering trap](#the-episode-numbering-trap). |
| `override-anilist-id-not-found` | AniList has no anime with that id — a well-formed typo. |
| `override-check-failed` | The check itself could not run (one-off AniList error), so the pin is unverified this week. |

### Not all exact matches are equal

AniList's `romaji` and `english` are its own data for an entry. `synonyms` is **user-contributed**, and a recap, compilation or special entry very often carries the parent series' name in it. A match is therefore tagged with the field it landed on, and:

- **A romaji/English hit beats a synonym hit.** When any candidate matches on a real title field, the synonym-only candidates are dropped rather than competing. This alone resolves the common "special carries the series name as a synonym" collision.
- **A synonym-only hit needs corroboration.** If the *only* evidence is a synonym, the entry is accepted only when it is a series format (`TV`, `TV_SHORT`, `ONA`) **and** its episode count is known and covers the scraped numbering. Otherwise it is reported as `synonym-only-match`.

**The tradeoff:** this only bites when the correct entry is missing from the top-10 search results, so the corroboration bar is set to reject the two shapes that produce a confident wrong answer — a side entry (`SPECIAL`/`OVA`/no format at all) and an entry whose episode count cannot be checked. A genuine synonym-only match on a completed series still resolves automatically. What it does cost is a currently-airing series known to AniList only under a synonym: its null episode count corroborates nothing, so it lands in `unmatched.json` and needs one line in `overrides.json`. That is the intended direction — a missing id is a one-line fix, a wrong id silently mislabels episodes for every user of the app.

The field that decided each match is recorded as `matchedField` in `mapping.json` and in the candidate list in `unmatched.json`, so a suspicious `"matchedField": "synonym"` is greppable.

**The rule is re-applied on every run, not just on first resolve.** A cached entry is only served from the cache when its recorded `matchedField` is `romaji` or `english`; anything else — `synonym`, absent, `null`, or a value this build does not recognise — is re-resolved against AniList and re-judged by the current rule. Without that, the weekly cron — which runs without `--refresh` — would grandfather in every match made by an older, laxer build, forever. See [`mapping.json` is a cache, not a control surface](#mappingjson-is-a-cache-not-a-control-surface) for the full reuse rule and what it costs.

### The episode-numbering trap

The site numbers episodes **absolutely across an entire series**. AniList usually splits the same series into **per-season entries that each restart at 1**.

If a series' scraped list runs to episode 500 and the matched AniList entry only has 220 episodes, then the match is season one of a multi-entry series — and applying those numbers would mark completely wrong episodes as filler.

So: **if the scraped episode count exceeds the matched entry's episode count, the mapping is refused** and reported as `episode-count-overflow`. The tolerance is 0 by default, because any overflow at all indicates the numbering bases differ. A still-airing entry with a null episode count cannot be checked, so a *fresh* match is allowed through on the strength of its exact title hit — but a *cached* one is not reused, because for that entry the guard can never fire again. See [the cache reuse rule](#mappingjson-is-a-cache-not-a-control-surface).

This is conservative on purpose and will occasionally reject a show whose list includes one bonus episode (Cowboy Bebop lists 27 against AniList's 26). Fix those individually with an override.

---

## Overrides

`overrides.json` is hand-maintained and **always wins** over automatic matching:

```json
{
  "some-show-slug": 12345,
  "a-show-to-exclude": null
}
```

- `slug -> <number>` forces that AniList id.
- `slug -> null` excludes the show from `filler.json` entirely.

Correcting a bad match is a one-line edit here; it survives every future run. **Deleting that line is the whole of un-pinning it** — a pinned show is deliberately *not* written to `mapping.json`, so there is no second copy of the decision to clean up afterwards.

Anything else is a typo and is **refused loudly** into `unmatched.json` as `invalid-override` — it never falls back to automatic matching, because a silent fallback would look exactly like the override working. The check is deliberately stricter than `Number(value)`, which is a trapdoor: `Number(true)` is `1` and `Number(["20"])` is `20`, so `"some-show": true` would otherwise pin that show to a completely unrelated AniList entry. A quoted integer (`"20"`) is accepted, since that hand-edit is unambiguous.

### A pin is honoured, and checked out loud

A pin says *which* entry. It does not say the episode numbering still lines up, and nobody re-derives that by hand a year later — a show pinned while it was airing can quietly outgrow the entry it was pinned to.

So every pinned id is still looked up on AniList and run through the same [overflow comparison](#the-episode-numbering-trap) as an automatic match. If it fails, the run **publishes the pinned id anyway** — the operator said what they wanted — and then makes that impossible to miss:

- a `::warning::` annotation on the Actions run summary, plus a banner-wrapped block in the log, and a second banner repeating every such show at the very end of the run;
- an entry in `unmatched.json` with `"published": true` and the reason (`override-episode-count-overflow`, `override-anilist-id-not-found` or `override-check-failed`).

A pin that checks out is completely silent.

### `mapping.json` is a cache, not a control surface

Edit `overrides.json` to change what gets published. `mapping.json` only ever holds **automatically resolved** matches, and the scraper rewrites it every run.

- **Do not hand-edit ids into it.** An entry there is not a pin: it is a saved AniList answer, and anything that cannot be re-judged from what was recorded is re-derived rather than trusted. Ids read back from it do get the same validation as `overrides.json` — a bad one becomes `invalid-cached-mapping` rather than a junk `filler.json` key — but that is damage control, not an interface.
- **Deleting an entry** is fine and simply forces a re-query for that slug, which is also what `--refresh` does for every slug.
- **Legacy `"source": "override"` entries are dropped on read.** Older builds wrote one for every pinned show. Such an entry could never resolve a live pin (`overrides.json` is consulted first) — it could only *survive* one, which is exactly how deleting a pin used to fail to un-pin the show. If you have any, the next run removes them; there is nothing to do by hand.

#### When a cached entry is reused, and when it is re-resolved

A cache hit skips every check the fresh path runs, so an entry is only served from the cache when it can still be **judged by today's rules from what was recorded**. That is an allowlist, and it needs *both* of:

| Recorded field | Must be | Why |
| --- | --- | --- |
| `matchedField` | `romaji` or `english` | AniList's own title data. Synonyms are user-contributed; absent/`null` is what older builds wrote, i.e. provenance nobody can vouch for. |
| `anilistEpisodes` | a positive number | The [overflow guard](#the-episode-numbering-trap) can only compare a real count. |

Anything else is **re-resolved against AniList under the current rules**, and the fresh answer replaces the entry. That covers `"matchedField": "synonym"`, a missing or `null` `matchedField`, a value this build does not recognise, and an `anilistEpisodes` of `null`, `0`, `"220"` or `true`.

A re-resolve that no longer clears today's bar sends the show to `unmatched.json` for that run; it does **not** fall back to the cached id. Same bias as everywhere else here — a missing id is a one-line fix in `overrides.json`, a wrong id mislabels episodes for every user of the app.

The second half is not a hypothetical. `checkEpisodeAlignment(240, { episodes: null })` answers `unknown`, and `unknown` is `ok` — so an entry recorded while its show was still airing could **never fail the overflow guard again**. It would keep republishing absolute episode numbers against an entry AniList has since finalised and split, with no query, no warning and no line in `unmatched.json`, and the weekly cron never passes `--refresh`, so nothing would ever revisit it. Those are the long-running shows that carry the most filler.

**What it costs.** One AniList query per weak entry per run, and nothing for the rest — a fully checkable entry never reaches the network. In steady state the weak set is the still-airing shows (their episode count stays `null`, so they can never be promoted) plus any synonym match: **tens of queries, not the ~370-show index**. They interleave with the 10-second page fetches, so they add round-trips rather than minutes. A re-resolved match records both fields, so a show that has since finished is promoted back to an ordinary cache hit and stops costing anything; a show that is still airing re-resolves every week, which is the intended outcome — it is exactly the show whose absolute numbering can outgrow the entry it was matched to. The first run against a `mapping.json` written by an older build (no `matchedField` at all) re-resolves every entry once, then settles.

A reused entry is still **re-checked against the overflow guard on every run**, using its recorded `anilistEpisodes`. A show that has since grown past its matched entry (an ongoing series AniList later split into seasons) is dropped to `unmatched.json` rather than republished with misaligned numbers. Re-run with `--refresh`, or pin the right id in `overrides.json`.

---

## Running it

Requires **Node 20+**. One dependency (`cheerio`); everything else is built-in.

```bash
npm install
npm test          # node --test, no network needed
npm run scrape    # full run
```

Useful flags:

```bash
node scrape.js --only naruto,bleach     # scrape specific slugs (smoke testing)
node scrape.js --limit 20               # first 20 shows from the index
node scrape.js --refresh                # re-query AniList even for cached slugs
node scrape.js --dry-run                # do everything except write the files
node scrape.js --out ./somewhere        # output directory
node scrape.js --crawl-delay 15000      # slower than the 10s floor
node scrape.js --help
```

**An unrecognised flag is a hard error**, before anything is fetched or written. That is not pedantry: `--dryrun` instead of `--dry-run` parses perfectly well, and a flag that is merely ignored would have overwritten all three files while you watched what you believed was a dry run.

A full run is ~370 shows at 10 seconds each: roughly **65 minutes**, plus AniList lookups for anything not already in `mapping.json` and for the [cached entries that cannot be re-judged](#when-a-cached-entry-is-reused-and-when-it-is-re-resolved) — tens of queries in steady state, interleaved with the page fetches.

---

## Crawl-delay policy

`robots.txt` allows `/shows` and `/shows/*` and sets a site-wide **`Crawl-delay: 10`**. This project honours it:

- **10 seconds between requests, always.** `--crawl-delay` can raise the delay but **cannot lower it below 10s** — a smaller value is clamped and logged.
- Requests are **serialised**, never issued in parallel. `fetchWithRetry` **requires** a limiter: leaving the option out is a `TypeError`, so an unthrottled request has to be written deliberately (`limiter: null`) rather than obtained by forgetting an argument.
- A descriptive, honest **User-Agent** identifies the project and links this repo.
- Retries use **exponential backoff with jitter** on 429 and 5xx, and honour `Retry-After` exactly.
- If the site rate-limits or errors persistently, the run **aborts cleanly and writes nothing** rather than hammering the host. Partial results are never published.

AniList is throttled separately and just as carefully: serialised, ~2s between requests, `Retry-After` honoured, and an automatic pause when the remaining rate-limit budget in the response headers runs low. There is no hot-loop retry path. A 429 or 5xx that survives the client's own retry budget **aborts the run** the same way a site refusal does — walking the remaining few hundred shows would re-provoke the same refusal and then publish a `filler.json` missing almost everything.

Please don't remove these limits. The data is refreshed weekly; there is no reason to crawl harder.

---

## Automation

`.github/workflows/update.yml` runs weekly (and on demand via `workflow_dispatch`), with least-privilege `permissions: contents: write`. It runs the tests, scrapes, checks the result against a regression guard (`scripts/check-regression.js` refuses to publish if the entry count drops more than 10%, which catches a truncated crawl or a site layout change), and commits `filler.json`, `mapping.json` and `unmatched.json` **only if they actually changed**.

---

## Layout

```
scrape.js                 CLI entry point
src/parse.js              HTML parsing, range expansion, filler classification  (pure)
src/match.js              Title normalisation, match confidence, output assembly (pure)
src/anilist.js            Throttled AniList GraphQL client
src/http.js               Crawl delay, retry/backoff, User-Agent
src/scrape.js             Orchestration and file I/O  (test seams, see below)
scripts/check-regression.js  Publish guard used by CI
test/                     node:test suites over saved HTML fixtures
```

All the interesting logic lives in `src/parse.js` and `src/match.js` as pure, importable functions, so the test suite runs entirely offline against fixtures in `test/fixtures/`.

### Testing the orchestrator

`src/scrape.js` decides everything that can publish a wrong id — override handling, the pin check, cache reuse, the overflow re-check, the conflict and abort paths — so it is tested end to end, through the real file I/O, rather than only through its pure helpers. `run()` takes three optional seams:

```js
run({
  fetchPage:     async (url)   => html,
  searchAniList: async (title) => [media],
  lookupAniList: async (id)    => media,   // or null if AniList has no such entry
})
```

All three default to the real, rate-limited clients — and the two AniList seams are backed by **one** client, so they share its limiter rather than doubling the request rate. Injecting them lets the whole orchestration run offline and instantly.

**This is not a way to crawl the site faster**, by construction rather than by convention:

- The crawl-delay floor lives inside `createSiteFetcher()` and is clamped against a module constant, not against any argument. **No input to it produces a fetcher below 10s**, and the limiter is closed over and unreachable from outside.
- A seam is accepted **only as a live function value**. A CLI flag or an environment variable is a string, and a string is rejected with a `TypeError`. The only route to the seam is `import { run }`.
- `main()` — the entire shipped CLI path — forwards **no argv key** to either seam and always builds the real fetcher itself.

So swapping the polite fetcher out requires writing JavaScript against the library, which a test does and an operator with a shell does not.

---

## License

MIT — see [LICENSE](LICENSE).

Episode classification data belongs to animefillerlist.com and its contributors. This tool only reformats publicly visible information; please respect the source site.
