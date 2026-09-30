# Map pipeline

Python tooling that turns real Ibadan map data into streamable chunks for the game.
It is empty for now. This file describes the intended shape.

## Planned flow

1. **Fetch**: OSM extract for Ibadan (roads, buildings, landuse, POIs such as garages, markets and checkpoints) plus a DEM (e.g. Copernicus GLO-30) for elevation.
2. **Project**: convert WGS84 lon/lat to the game's local metric frame:
   transverse Mercator centred on the Dugbe junction (OSM node 168734026, 7.3903934 N, 3.8794116 E).
   ```
   +proj=tmerc +lat_0=7.3903934 +lon_0=3.8794116 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs
   ```
   Game axes: `x = easting`, `z = -northing`, `y = elevation - elevation(origin)`. All in metres.
3. **Chunk**: split into fixed-size square tiles keyed by `(cx, cz)`, each with road centrelines and widths, building footprints and heights, and a terrain heightfield.
4. **Emit**: write chunk files to `public/chunks/` for local dev. Production hosting is not decided yet.

The origin and proj string must match `src/game/world/projection.ts` and `CLAUDE.md`.

## Setup

```sh
python3 -m venv pipeline/.venv
source pipeline/.venv/bin/activate
pip install -r pipeline/requirements.txt
```

## Run

Not implemented yet. The planned entry point is:

```sh
python -m pipeline.build --out public/chunks
```
