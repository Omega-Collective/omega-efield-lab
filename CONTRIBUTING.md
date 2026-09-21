# Contributing

Contributions are welcome — bug reports, montage presets, new head models, corrections
to the method description, translations.

## Reporting a problem

Open an issue at
[github.com/Omega-Collective/omega-efield-lab/issues](https://github.com/Omega-Collective/omega-efield-lab/issues).

For a wrong or suspicious result, the useful report includes the montage (which
electrodes, which currents), the model name, what you expected and what you got. A
saved PNG helps, because its caption already states the model, reference electrode and
electrode geometry.

For a bug in the viewer, include the browser and, if you can, the console output.

## Asking a question

Questions about the method, the limits, or whether the tool fits a particular study are
fine as issues — others will have the same question. For anything you would rather not
discuss in public, write to contact@omegadym.com.

## Changing the code

1. Fork and branch from `main`.
2. Make the change.
3. Run the tests (below). All three suites should pass.
4. Open a pull request describing what changes and why.

The viewer is plain ES modules with no build step: edit `js/`, reload the page. three.js
is vendored in `vendor/` deliberately — the tool must keep working with no network access
beyond the initial page load, so please do not introduce CDN dependencies or a bundler
without discussing it first.

## Running the tests

```bash
# format and physical invariants of the exported models
pip install numpy pytest
python -m pytest tests -v

# viewfinder arithmetic, without a viewfinder
node --test tests/viewer.test.mjs

# the page loads and calculates a montage in a real browser
npm install --no-save playwright && npx playwright install chromium
node tests/smoke.mjs
```

CI runs all three on every push and pull request.

## Adding a head model

A new model means recomputing a leadfield — see the README. Two things are mandatory:

- The electrode geometry must end up recorded in `model.json`. `compute_leadfield.py`
  writes `electrode.json` and `export_leadfield.py` carries it across; do not bypass this.
  A model whose electrode geometry is unknown produces figures that cannot be compared
  with anything.
- Add the model to `models/index.json` so the picker offers it.

Model binaries are large. For anything beyond a couple of models we should move them out
of Git; open an issue before committing a third one.

## Scope

This tool answers one question — what field does this montage induce on the cortex of
this head model — and answers it fast. Things that belong elsewhere: subject-specific
pipelines (use SimNIBS directly), TMS, deep-structure dosimetry, anything requiring the
individual's MRI.

## Code of conduct

Be straightforward and civil. Disagreement about methods is the point of the exercise;
personal attacks are not. Anything else, write to contact@omegadym.com.
