---
title: 'E-Field Lab: interactive browser-based simulation of transcranial electric stimulation fields'
tags:
  - transcranial electric stimulation
  - tDCS
  - electric field modelling
  - neuromodulation
  - JavaScript
  - Python
authors:
  - name: Sylar Robert Jones
    orcid: 0000-0000-0000-0000
    affiliation: 1
affiliations:
  - name: Omega Dynamics
    index: 1
date: 21 September 2026
bibliography: paper.bib
---

# Summary

`E-Field Lab` computes and displays the electric field that a transcranial electric
stimulation (tES) montage induces on the cortical surface, interactively, in a web
browser. The user places anodes and cathodes on any of the 76 positions of the 10-10
system, sets the total current, and sees the resulting field immediately, together with
the peak, the median and a focality measure. Figures can be exported as PNG with a
caption that states the head model, the reference electrode and the electrode geometry
the field was computed with.

The tool is not a new solver. It is a redistribution of an existing one: the field is
computed once with SimNIBS [@Thielscher2015] as a leadfield, and the browser recombines
those precomputed single-electrode solutions by linear superposition. Because the
governing problem is quasi-static and ohmic, that superposition is exact for the model
that was solved, not an approximation. What the approach buys is latency: a montage that
would take tens of minutes to simulate is evaluated in milliseconds.

# Statement of need

Field modelling for tES is a solved problem and mature open tools exist —
SimNIBS [@Thielscher2015; @Saturnino2019] and ROAST [@Huang2019] both produce
subject-specific or template-based solutions of good quality. The obstacle is not
accuracy but turnaround. A full simulation requires installing a scientific software
stack, preparing a head model, and waiting minutes to hours per montage. During
experimental design, when a researcher wants to know whether F3/F4 or an HD 4x1 array
better targets a region, that cost is high enough that the comparison often does not
happen, and electrode placement falls back on convention.

The leadfield idea removes that cost for the specific case of "same head, different
electrodes". Leadfield-based montage optimisation is established in the literature
[@Dmochowski2011; @Saturnino2019] and SimNIBS exposes the computation directly. What has
been missing is a route from that computation to something a researcher can open and use
without installing anything. `E-Field Lab` is that route: a pipeline that turns a SimNIBS
leadfield into a compact web format (about 9 MB for 20,000 cortical vertices and 76
electrodes, stored as half-precision floats), and a dependency-light viewer that
recombines it in real time.

The intended users are researchers and clinicians planning tES protocols, and students
learning how current spreads through the head. It is explicitly not a replacement for
subject-specific modelling; the documentation and every exported figure make the
assumptions visible, which is the second thing the tool is for. Published tES work often
reports montages without reporting the electrode geometry, even though contact area
directly determines current density — a 5 x 5 cm sponge spreads the same current over
roughly eight times the area of a 20 mm circular electrode. `E-Field Lab` records
electrode geometry at computation time, propagates it into the model metadata, displays
it in the interface, and prints it on exported figures, so that a figure produced with
this tool carries the information needed to compare it with another.

# Implementation

The pipeline has two stages. `compute_leadfield.py` drives SimNIBS to solve one
finite-element problem per electrode against a common reference, with the electrode
geometry meshed onto the scalp, and records that geometry in a sidecar file.
`export_leadfield.py` filters the cortical surface to its principal connected components,
decimates it by quadric simplification, resamples the leadfield onto the reduced mesh
with inverse-distance weighting, normalises to V/m per mA and writes three files: a JSON
metadata document and two binary blobs for geometry and field.

The viewer is plain ES modules with no build step and no external requests at runtime;
three.js is vendored. Applying a montage is a weighted sum over the electrode rows,
followed by per-vertex magnitude and projection onto the surface normal. Reported metrics
are the 99th percentile of the magnitude rather than the absolute maximum, which is
dominated by a handful of vertices and unstable across meshes; the median; and the
fraction of cortical surface above half the peak.

Correctness is checked at three levels: the exported model format and its physical
invariants, including the exactness of linear superposition; the viewer arithmetic
against an analytically constructed model; and an end-to-end browser test that loads the
published model, applies known montages and verifies that an HD 4x1 array is more focal
than a two-electrode montage.

# Limitations

Values are indicative, not subject-specific: a single head model is distributed, and
different anatomy gives different numbers. Electrode geometry is fixed when the leadfield
is computed, so a montage using pads of a different size requires a different model. The
cortical surface is decimated from roughly 309,000 to 20,000 vertices, smoothing fine
sulcal detail, and half-precision storage introduces small rounding. No values are
provided for deep structures. The software is not a medical device.

# Acknowledgements

This work relies on SimNIBS and on the `ernie` example head model distributed with it.

# References
