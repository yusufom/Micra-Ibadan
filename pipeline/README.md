# Map pipeline

Python tooling that turns real Ibadan map data into streamable chunks for the game.

| Source | Used for | Licence |
| --- | --- | --- |
| OpenStreetMap (Overpass, via osmnx) | Roads, bus stops, taxi garages and motor parks, markets, fuel, police, landmarks, water, green areas, landuse, OSM `building:levels` | ODbL |
| Google Open Buildings v3 | Building footprints (confidence ≥ 0.7) | CC BY 4.0 |
| Copernicus DEM GLO-30 (AWS open data) | Elevation | Copernicus DEM licence |

Google Maps and Google 3D Tiles are **not** used anywhere. Open Buildings is Google Research's open dataset, which is a separate thing.

## Setup

Python 3.11+ (3.12 recommended; 3.14 lacks wheels for some geo packages).

```sh
python3.12 -m venv pipeline/.venv
source pipeline/.venv/bin/activate
pip install -r pipeline/requirements.txt
```

## Run

```sh
python -m pipeline areas                     # list areas in areas.yaml
python -m pipeline fetch --area dugbe-ui     # download + cache sources only
python -m pipeline build --area dugbe-ui     # fetch (cached) + build chunks
python -m pipeline build --area dugbe-ui --refresh   # re-download sources
```

Output goes to `public/chunks/{area}/`, which is gitignored. The first run downloads about 2 GB, because the Open Buildings S2 tile covering Ibadan is `103_buildings.csv.gz`. Everything is cached in `pipeline/cache/` (also gitignored), and later builds take about 2.5 minutes for `dugbe-ui`.

## Adding a district

Add an entry to `areas.yaml` with a WGS84 `bbox: [west, south, east, north]`. Optionally add `old_areas` boxes where mud brick compounds are common. Chunks sit on one global grid anchored at the Dugbe origin, so separately built areas line up.

## Stages

| Module | What it does |
| --- | --- |
| `fetch_osm.py` | Drive network via `graph_from_bbox`, simplified so each edge is exactly one OSM way. Also features and OSM buildings. |
| `fetch_buildings.py` | Picks Open Buildings tiles from the tile index, downloads them (resumable) and clips to the area by centroid. |
| `fetch_dem.py` | Copernicus tiles. A 3×3 median filter removes DSM spikes from towers and trees. Then cubic resampling to the 5 m game grid and a Gaussian smooth (`dem_smoothing_m`). |
| `projection.py` | Transverse Mercator centred on Dugbe. `x = east`, `z = -north`, `y = elev - elev(origin)`. Fails if `src/game/world/projection.ts` drifts. |
| `roads.py` | Road graph, lanes, speed and surface defaults by class, and 3D profiles. It also builds road ribbons, junction patches and open drains. |
| `terrain.py` | Flattens a strip under each road: centreline height plus a cross slope capped at 4%, extended 1.5 grid cells, then blended back over 8 m. Also terrain meshes with vertex colours and draped water. |
| `buildings.py` | Removes or trims footprints on road corridors, then works out height (OSM levels, else zone and area rules seeded by building id) and material. Hip zinc roofs go on small rectangular low-rise buildings. |
| `props.py` | Building colliders (a box for near-rectangular footprints, else a convex hull) and street props: electric poles chained along roads, kiosks at stops, markets and busy frontage, roadside mechanic sheds, garage shelters and name boards. Props are seeded by way or feature id and dropped if they touch a building or another road. |
| `farfield.py` | Whole-area LOD: a 20 m heightfield and a 4 m/px colour map with roofs (plus a short sun shadow), roads and laterite baked in. |
| `chunk.py` | Writes per-chunk files and the manifest, and prints the summary. |
| `glb.py` | Minimal glTF 2.0 writer. |

## Output format

Chunk `(cx, cz)` covers `x ∈ [cx·200, (cx+1)·200)` and `z ∈ [cz·200, (cz+1)·200)`.

- **`{cx}_{cz}.glb`**: one root node translated to `(minX, 0, minZ)`. Children are one mesh per material: `terrain`, `water`, `road_paved`, `road_unpaved`, `drain`, `plaster`, `painted`, `unfinished_block`, `mud_brick`, `glass`, `roof_zinc_rusted`, `roof_zinc`, `roof_concrete`. Every mesh has normals, UVs (in metres) and RGBA8 vertex colours carrying per-building tints. Road meshes sit 5 cm above the terrain. Each file is capped at 2 MB. An over-budget chunk would drop its smallest buildings first, but none are over budget today.
- **`{cx}_{cz}.bin`**: the physics heightfield, `41 × 41` float32 LE values at 5 m spacing. It is row-major, with row = z (north→south) and col = x (west→east). Neighbouring chunks share their edge rows. Note that Rapier's `HeightfieldCollider` expects column-major data.
- **`{cx}_{cz}.json`**: road edges touching the chunk (full attributes and 3D polyline), stops, garages, POIs, spawn points, building colliders and props:
  - `spawns`, each with a `type`:
    - `traffic`: kerb lane, `yaw` about +Y (0 = north), and `edgeId`/`s`/`forward`
    - `pedestrian`: verge
    - `passenger`: at stops, garages and markets
  - `buildings` (format 2+): one collider per building whose centroid is in the chunk, spanning `y0` (1.5 m below the lowest footprint corner, like the wall skirt) to `y1` (roof eave). Either `{"shape": "box", x, z, hx, hz, yaw}` (world centre, half extents, rotation about +Y applied to the box's local x axis) or `{"shape": "hull", "pts": [[x, z], ...]}` (convex footprint, at most about 8 points).
  - `props` (format 2+): `{type, x, y, z, yaw}` with `yaw` about +Y (0 = north) so the prop's local -Z faces its road. Types are `pole` (with `next: [x, y, z]`, the next pole on the same road for stringing wires), `kiosk` (`variant` 0–3 picks the paint), `mechanic_shed` (`variant` 0–2), `garage_shelter` and `garage_board` (`name`).
- **`manifest.json`**: area info, projection and origin elevation, chunk list with bounds, heights and file sizes. It also holds the full road graph (`nodes`, `edges`), named stops and garages (unnamed ones are labelled from the nearest road, with `nameFromOsm: false`), POIs, the `farField` entry (format 2+), and attribution text that must be shown in game.
- **`far.bin` / `far.jpg`** (format 2+): the far-field LOD for the whole extent. `far.bin` is `rows × cols` float32 LE heights at `farField.spacing` (20 m), row-major with row = z (north→south), sample (i, j) at `(extent.minX + i·spacing, extent.minZ + j·spacing)`. `far.jpg` covers the extent with row 0 at `extent.minZ`.

Road mesh UVs: ribbons run `u` 0..1 across the carriageway and `v` in metres along it. Junction patches use `u = 0.5` everywhere (no road edge), which the game uses to skip edge wear.

Format version 2 added `buildings`, `props` and the far field. Version 1 readers can ignore them.

Road edge fields: `wayId`, `name`, `ref`, `highway`, `lanes`, `oneway`, `speedLimitKph`, `surface`, `bridge`, `width`, `drains`, `length`, `grade` (average % from `u` to `v`), `maxGrade` (steepest 20 m stretch, %) and `polyline` (`[x, y, z]` points). The `*Tagged` / `surfaceTag` fields say which values came from OSM rather than class defaults. Untagged residential and unclassified roads are paved or unpaved at random, seeded by way id.

## Known limits

- GLO-30 is a 30 m surface model, so grades are approximate. Very short steep stretches (the 20 m max is around 34%) partly come from the DSM.
- Road side tilt is capped at 4% on the road plane. Sampled on the 5 m physics grid, 99% of road points away from junctions are within 4.6%. Tilt is higher where roads at different heights run side by side without a `bridge` tag, such as interchanges.
- Drains are modelled as raised concrete channels beside the kerb, not cut into the terrain, because a 5 m heightfield cannot hold a 0.5 m trench.
- OSM is sparse here: about 20 bus stops and 5 taxi garages in `dugbe-ui`. Add stops to OSM, or add a curated overlay later.
