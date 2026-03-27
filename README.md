# starccm-expert-skill

Local Codex skill for answering Simcenter STAR-CCM+ documentation questions with a controlled two-step workflow:

- `graph-peek` for lightweight candidate discovery from the native WebHelp search index
- `graph-read` for page-level evidence reads by `pageId`

The intended retrieval path is:

`keyword planning -> graph-peek -> pick pageIds -> graph-read -> cited answer`

This skill is designed to stay audit-friendly:

- answers should cite only pages that were actually read
- sources are keyed by `language + version + pageId`
- Markdown footnotes are preferred over inline source clutter

## Repository Layout

- [`SKILL.md`](./SKILL.md): agent instructions and workflow rules
- [`starccm-expert.json`](./starccm-expert.json): local dataset mapping
- [`scripts/starccm-cli.mjs`](./scripts/starccm-cli.mjs): local CLI for `graph-peek` and `graph-read`
- [`scripts/search-core.js`](./scripts/search-core.js): dataset resolution, search, and read logic
- [`scripts/tests/test-starccm-cli-graph-peek.mjs`](./scripts/tests/test-starccm-cli-graph-peek.mjs): regression tests

## Configuration

Dataset locations are config-driven. The CLI no longer depends on a hardcoded STAR docs root.

Example:

```json
{
  "datasets": [
    {
      "path": "/path/to/en_STARCCMP_18.04",
      "version": "18.04",
      "language": "en"
    },
    {
      "path": "/path/to/zh_STARCCMP_18.04",
      "version": "18.04",
      "language": "zh"
    },
    {
      "path": "/path/to/en_STARCCMP_20.06",
      "version": "20.06",
      "language": "en"
    },
    {
      "path": "/path/to/zh_STARCCMP_20.06",
      "version": "20.06",
      "language": "zh"
    }
  ]
}
```

By default the CLI reads `starccm-expert.json` next to the skill. `--docs-root` still exists as a manual compatibility override, but config is the normal path.

## CLI

Peek candidates:

```bash
node scripts/starccm-cli.mjs graph-peek \
  --config ./starccm-expert.json \
  --query-list-json-zh '["辐射模型","表面对表面辐射"]' \
  --query-list-json-en '["radiation model","surface to surface radiation"]' \
  --versions 18.04 \
  --languages zh,en
```

Read selected pages:

```bash
node scripts/starccm-cli.mjs graph-read \
  --config ./starccm-expert.json \
  --page-ids-json '["GUID-49BA1433-932B-4C42-862A-8E0EE9E47F2E"]' \
  --versions 18.04 \
  --languages zh
```

Single-page shorthand is also supported:

```bash
node scripts/starccm-cli.mjs graph-read \
  --config ./starccm-expert.json \
  --page-id GUID-49BA1433-932B-4C42-862A-8E0EE9E47F2E \
  --version 18.04 \
  --language zh
```

## Example Dialogue Demo

The following is a compact demonstration of the intended agent behavior.

### User

`› starccm中有哪些辐射模型 各有什么优缺点`

### Assistant Workflow

1. Recognize this as a STAR documentation retrieval task.
2. Stay on the controlled route: `graph-peek -> graph-read`.
3. Generate compact bilingual keywords instead of sending the raw question directly to the CLI.
4. Use `graph-peek` across both `18.04` and `20.06`, then use `graph-read` only on selected `pageId`s.
5. Separate documented facts from synthesis, and cite read pages with footnotes.

### Example Peek Rounds

Round 1:

```bash
node /root/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config /root/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["辐射模型","表面对表面辐射","离散坐标辐射","P1辐射","视因子"]' \
  --query-list-json-en '["radiation model","surface to surface radiation","discrete ordinates radiation","P1 radiation","view factor"]' \
  --versions 18.04 \
  --languages zh,en
```

Round 2:

```bash
node /root/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config /root/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["表面 Photon Monte Carlo","DOM","球体谐波模型","体积辐射交换","辐射模型参考"]' \
  --query-list-json-en '["surface photon monte carlo","DOM","spherical harmonics model","volumetric radiation exchange","radiation model reference"]' \
  --versions 20.06 \
  --languages zh,en
```

Round 3:

```bash
node /root/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-peek \
  --config /root/.codex/skills/starccm-expert/starccm-expert.json \
  --query-list-json-zh '["P1 辐射","球谐辐射模型","体积 Photon Monte Carlo","参与介质辐射","离散坐标法"]' \
  --query-list-json-en '["P1 radiation","spherical harmonics radiation model","volumetric photon monte carlo","participating media radiation","discrete ordinates method"]' \
  --versions 20.06 \
  --languages zh,en
```

### Example Read Stage

```bash
node /root/.codex/skills/starccm-expert/scripts/starccm-cli.mjs graph-read \
  --config /root/.codex/skills/starccm-expert/starccm-expert.json \
  --page-ids-json '[
    "GUID-59418EB9-4F39-43AE-A195-766C642E276D",
    "GUID-49BA1433-932B-4C42-862A-8E0EE9E47F2E",
    "GUID-A6793BEF-522B-4B0D-8770-6FA05CAAAD60",
    "GUID-69B84018-9C88-406F-9F15-1B2718D3CDAE",
    "GUID-615C7D05-91AB-4794-8AFF-5CCB5FC5C147",
    "GUID-7D5BBCC5-CCF7-4989-9406-590800367F40",
    "GUID-42295930-AF3E-4207-B14E-AB3878F54811",
    "GUID-34DD5230-D40A-49E8-BBC5-8F29B14BBB04"
  ]' \
  --versions 18.04,20.06 \
  --languages zh
```

### Example Answer Shape

Below is the style of answer this skill is aiming for:

> By default, answer from `18.04` first and then note the relevant `20.06` delta. In STAR-CCM+, radiation is best understood as two layers: radiation transport models and radiation spectral models.[^1]
>
> `S2S` is for surface-to-surface exchange in non-participating media. Its main strength is efficiency after view factors are computed; its main limitation is that it does not model participating media and is not suitable for 2D or axisymmetric cases.[^1][^2]
>
> `SPMC` is also a surface model for non-participating media, but it uses Monte Carlo ray tracing and can handle refraction. Its strength is higher fidelity for complex optical behavior; its tradeoff is significantly higher cost because accuracy comes from more photon bundles.[^1][^3]
>
> `DOM` is the general participating-media model. It supports absorption, emission, and scattering, and its accuracy can be tuned through the angular quadrature order. The tradeoff is cost: higher `Sn` orders increase both accuracy and runtime.[^4][^5]
>
> The spherical harmonics model in STAR is effectively the `P1` form. It is faster than DOM, but it has a narrower applicability range and lower accuracy near boundaries or in strongly directional radiation fields.[^6]
>
> On the spectral side, `Gray` is the simplest option when wavelength dependence is weak, while `Multiband` is better when spectral variation matters, at the cost of roughly linear growth in solve time with band count.[^7][^8]
>
> A notable `20.06` delta is the appearance of `VPMC`, which extends photon Monte Carlo treatment into volumetric participating-media radiation.[^9]

### Example References

```md
References

[^1]: zh + 18.04 + GUID-59418EB9-4F39-43AE-A195-766C642E276D, STAR-CCM+ page "Radiation".
[^2]: zh + 18.04 + GUID-49BA1433-932B-4C42-862A-8E0EE9E47F2E, STAR-CCM+ page "Surface-to-Surface (S2S) Radiation Model Reference".
[^3]: zh + 18.04 + GUID-A6793BEF-522B-4B0D-8770-6FA05CAAAD60, STAR-CCM+ page "Surface Photon Monte Carlo (SPMC) Radiation Model Reference".
[^4]: zh + 20.06 + GUID-6E0BD6F4-2652-4DA5-B758-9A79A859C98B, STAR-CCM+ page "Volumetric Radiation Exchange Reference".
[^5]: zh + 20.06 + GUID-69B84018-9C88-406F-9F15-1B2718D3CDAE, STAR-CCM+ page "Participating Media Radiation (DOM) Model Reference".
[^6]: zh + 20.06 + GUID-615C7D05-91AB-4794-8AFF-5CCB5FC5C147, STAR-CCM+ page "Participating Media Radiation (Spherical Harmonics) Reference".
[^7]: zh + 18.04 + GUID-7D5BBCC5-CCF7-4989-9406-590800367F40, STAR-CCM+ page "Gray Thermal Radiation Model Reference".
[^8]: zh + 18.04 + GUID-42295930-AF3E-4207-B14E-AB3878F54811, STAR-CCM+ page "Multiband Thermal Radiation Model Reference".
[^9]: zh + 20.06 + GUID-34DD5230-D40A-49E8-BBC5-8F29B14BBB04, STAR-CCM+ page "Volumetric Photon Monte Carlo (VPMC) Radiation Model Reference".
```

## Verification

Run the local regression suite:

```bash
node --test scripts/tests/test-starccm-cli-graph-peek.mjs
```
