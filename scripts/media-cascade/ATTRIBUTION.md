# Exercise media — attribution and licences

The exercise stills and clips in `catalogue/media/` are **not** all from the same place, and they
are **not** all under the same licence. This file is the source of truth for what each batch is and
what it obliges you to publish.

Generated alongside `manifest.json` and `convert-report.json` by the media cascade.
Counts below are the **written** counts from `convert-report.json` (1,960 of 1,961 attempted).

## Summary

| Source | Licence | Exercises written | Obligation |
| --- | --- | --- | --- |
| `omercotkd/exercises-gifs` | MIT — **disputed, see below** | 1,681 | Risk accepted by the operator |
| `RepDB/exercise-dataset` | RepDB Free Tier License v1.0 (proprietary, **not** CC) | 198 | Visible credit + no dataset republication + no gen-AI derivation |
| `bryllim/workout-guide` | CC BY-SA 4.0 | 66 | Credit, indicate changes, **ShareAlike** |
| `everkinetic/data` | CC BY-SA 4.0 | 10 | Credit, indicate changes, **ShareAlike** |
| `namnq/workout-free-videos` | CC0 1.0 | 5 | None |
| **Total** | | **1,960** | |

The remaining **4,593 exercises keep the original Gym visual media** and are governed by
`catalogue/media/NOTICE.md`, not by this file.

## 1. RepDB — 198 exercises

Licence: **RepDB Free Tier License v1.0** — a bespoke free-tier licence, *not* Creative Commons.
Text: `https://huggingface.co/datasets/RepDB/exercise-dataset/raw/main/LICENSE.md`

Required, verbatim credit string:

> `Exercise data by RepDB (repdb.co)`

Placement: a visible link in the app's about/credits screen, the README, or the footer.

Additional terms you must respect:

- **No redistribution as a dataset.** In-app use only — do not republish, resell, or repackage the
  images as a dataset, dataset repository, or API.
- **No generative-AI derivation.** No image-to-image restyling, and no using the images to train
  models.

## 2. workout-guide — 66 exercises

Licence: **CC BY-SA 4.0** for the visual assets.
Text: `https://github.com/bryllim/workout-guide/blob/main/LICENSE-ASSETS`

> "Workout Guide visual assets are licensed under the Creative Commons Attribution-ShareAlike 4.0
> International license (CC BY-SA 4.0). Copyright (c) 2026 Bryl Lim…"

Required: credit **Bryl Lim**, link the licence, **indicate that changes were made**.

**ShareAlike applies to the adaptations.** Rescaling the 512×512 SVGs to 180×180 and rasterising
them to WebP is an adaptation, so **the converted stills and clips derived from this source must
themselves be published under CC BY-SA 4.0.** Using the artwork unmodified does not make the rest
of the application a derivative; it is the converted image files that carry the obligation.

Upstream provenance: the README states the original pose artwork comes from Everkinetic under the
same CC BY-SA 4.0, so the chain holds.

## 3. Everkinetic — 10 exercises

Licence: **CC BY-SA 4.0**
Text: `https://github.com/everkinetic/data/blob/main/LICENSE.md`

Required: credit **Greg Priday / Everkinetic**, link the licence, indicate changes. Same ShareAlike
obligation on the 180×180 conversions as above.

## 4. namnq/workout-free-videos — 5 exercises

Licence: **CC0 1.0 Universal** (public domain dedication).
Text: `https://github.com/namnq/workout-free-videos/blob/main/LICENSE`

> "Everything in this repo (videos, data and code) is released under CC0 1.0 Universal and
> dedicated to the public domain. Use it for anything, including commercial apps."

No conditions. No credit required (though naming the source is good practice).

## 5. omercotkd/exercises-gifs — 1,681 exercises — RISK ACCEPTED

The repository ships an MIT `LICENSE`, **and its own README says**:

> "**Disclaimer:** I do not own any of the content in this repository. All rights belong to the
> original creators and dataset owner."

Those two statements contradict each other: the owner of an MIT file cannot grant rights over
content they do not own. The host describes itself as a backup for the Kaggle dataset
*"Fitness Exercises with Animations"* (edoardoba), and the assets are named `NNNN.gif` with an
ExerciseDB-shaped CSV schema.

**This source was accepted knowingly by the operator of this fork** and it accounts for
**1,681 of the 1,960 written exercises (85.8 %)** — it is the backbone of the set, not a margin.
If that acceptance is ever withdrawn, removing this source drops coverage to 279 exercises.

No attribution can cure this: the correct fix is either a Gym visual licence or replacing the set.

## Not covered by this file

`catalogue/media/NOTICE.md` still governs the Gym visual media that remains on the **4,593**
exercises this cascade did not match. Those files are **not** covered by the project's AGPL and
third parties have no right to reuse them. Until they are replaced or licensed, the constraint in
that notice stands for them.

## Known failure

- **`0609`** — `https://raw.githubusercontent.com/omercotkd/exercises-gifs/main/assets/0609.gif`
  returns **HTTP 404**: the asset does not exist upstream. Not a pipeline error. The exercise keeps
  its original Gym visual media.
