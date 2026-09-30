"""Split the world into chunks and write game files.

Per chunk (cx, cz), covering x in [cx*S, (cx+1)*S] and z in [cz*S, (cz+1)*S]:
  {cx}_{cz}.glb   terrain, water, roads, drains, buildings (one mesh per material)
  {cx}_{cz}.json  road edges touching the chunk, stops, garages, POIs, spawn points
  {cx}_{cz}.bin   heightfield for physics: float32 little-endian, (n+1)x(n+1),
                  row-major, row = z index (north->south), col = x index (west->east)
Plus manifest.json for the whole area.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections import defaultdict
from pathlib import Path

import click
import geopandas as gpd
import numpy as np
import shapely
from scipy import ndimage

from .buildings import add_building_meshes, prepare_buildings, to_game_geoms
from .config import Area
from .fetch_buildings import load_buildings
from .fetch_dem import DemGrid, load_dem
from .fetch_osm import load_features, load_graph, load_osm_buildings
from .glb import MATERIALS, encode_glb
from .meshes import MeshBank
from .projection import ORIGIN_LAT, ORIGIN_LON, ORIGIN_OSM_NODE, PROJ4
from .roads import GRADE_WINDOW_M, ROAD_LIFT, RoadIndex, build_road_graph, build_road_meshes, edge_to_json, node_to_json
from .terrain import add_terrain_mesh, add_water_meshes, cover_masks, flatten_under_roads

FORMAT_VERSION = 1
SNAP_M = 80.0
TRAFFIC_SPAWN_EVERY_M = 60.0
PEDESTRIAN_SPAWN_EVERY_M = 80.0
BUDGET_STEPS = [-np.inf, 25, 50, 100, 200, 400]  # drop buildings below this footprint (m2)

ATTRIBUTION = [
    {
        "source": "OpenStreetMap",
        "text": "Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).",
        "url": "https://www.openstreetmap.org/copyright",
    },
    {
        "source": "Google Open Buildings",
        "text": "Building footprints from Google Open Buildings v3, licensed CC BY 4.0.",
        "url": "https://sites.research.google/open-buildings/",
    },
    {
        "source": "Copernicus DEM GLO-30",
        "text": "Elevation from Copernicus DEM GLO-30, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH "
        "2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.",
        "url": "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model",
    },
]

FALLBACK_NAMES = {"bus_stop": "Bus stop", "taxi": "Taxi rank", "bus_station": "Motor park", "parking": "Motor park"}
GARAGE_NAME = re.compile(r"motor\s*park|garage|taxi|cab|park\b|terminus|loading", re.IGNORECASE)
GREEN = {
    "leisure": {"park", "pitch", "golf_course", "garden", "recreation_ground", "stadium"},
    "landuse": {"grass", "forest", "meadow", "farmland", "cemetery", "recreation_ground", "village_green", "orchard"},
    "natural": {"wood", "scrub", "grassland", "wetland"},
}
WATERWAY_WIDTH = {"river": 8.0, "canal": 4.0, "stream": 3.0}
LANDMARK = {
    "amenity": {"university", "college", "hospital", "place_of_worship", "bank", "townhall", "courthouse"},
    "shop": {"mall", "supermarket", "department_store"},
    "tourism": {"attraction", "museum", "hotel", "artwork", "viewpoint"},
    "man_made": {"tower", "water_tower", "communications_tower"},
}


def _r(v, n=2):
    return round(float(v), n)


def _val(row, col):
    v = row.get(col)
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    return v


def _sample(heights: np.ndarray, dem: DemGrid, x, z) -> np.ndarray:
    fi = (np.atleast_1d(x) - dem.x0) / dem.spacing
    fj = (np.atleast_1d(z) - dem.z0) / dem.spacing
    return ndimage.map_coordinates(heights, [fj, fi], order=1, mode="nearest")


def _yaw(tx: float, tz: float) -> float:
    """Yaw about +Y so local forward (-Z) faces (tx, tz). 0 = north."""
    return math.atan2(-tx, -tz)


# --- features --------------------------------------------------------------


def _classify(features: gpd.GeoDataFrame, osm_b: gpd.GeoDataFrame):
    stops, garages, pois = [], [], []
    for _, r in features.iterrows():
        hw, am = _val(r, "highway"), _val(r, "amenity")
        name = _val(r, "name")
        base = {"osmId": r["osm_id"], "name": name, "geom": r.geometry}
        if hw == "bus_stop":
            stops.append({**base, "type": "bus_stop"})
        elif am in ("taxi", "bus_station") or (am == "parking" and name and GARAGE_NAME.search(name)):
            garages.append({**base, "type": am})
        elif am == "marketplace":
            pois.append({**base, "type": "market"})
        elif am == "fuel":
            pois.append({**base, "type": "fuel", "brand": _val(r, "operator")})
        elif am == "police":
            pois.append({**base, "type": "police"})
        else:
            for key, vals in LANDMARK.items():
                v = _val(r, key)
                if v in vals and (name or key != "amenity"):
                    pois.append({**base, "type": "landmark", "kind": f"{key}={v}"})
                    break
            else:
                if _val(r, "historic"):
                    pois.append({**base, "type": "landmark", "kind": f"historic={_val(r, 'historic')}"})
    # Tall named OSM buildings (e.g. Cocoa House) are landmarks too.
    if "name" in osm_b and "building:levels" in osm_b:
        lv = osm_b["building:levels"].map(lambda v: float(v) if v and str(v).replace(".", "", 1).isdigit() else 0.0)
        for _, r in osm_b[(lv >= 6) & osm_b["name"].notna()].iterrows():
            pois.append({"osmId": r["osm_id"], "name": r["name"], "geom": r.geometry, "type": "landmark", "kind": "building"})
    return stops, garages, pois


def _cover_geoms(features: gpd.GeoDataFrame):
    green, water = [], []
    for _, r in features.iterrows():
        g = r.geometry
        if g is None:
            continue
        poly = g.geom_type in ("Polygon", "MultiPolygon")
        if poly and any(_val(r, k) in v for k, v in GREEN.items()):
            green.append(g)
        elif poly and (_val(r, "natural") == "water" or _val(r, "water") or _val(r, "landuse") == "reservoir" or _val(r, "waterway") == "riverbank"):
            water.append(("poly", g))
        elif g.geom_type in ("LineString", "MultiLineString") and _val(r, "waterway") in WATERWAY_WIDTH:
            water.append((_val(r, "waterway"), g))
    green_g = list(to_game_geoms(green)) if green else []
    water_g = []
    if water:
        proj = to_game_geoms([g for _, g in water])
        for (kind, _), g in zip(water, proj):
            water_g.append(g if kind == "poly" else shapely.buffer(g, WATERWAY_WIDTH[kind] / 2, cap_style="round"))
    return green_g, water_g


def _place(items, dem, heights, idx: RoadIndex, edges_by_id, extent):
    """Project, snap to the nearest road and drop anything outside the chunk grid."""
    if not items:
        return []
    pts = to_game_geoms([shapely.point_on_surface(i["geom"]) for i in items])
    xs, zs = shapely.get_x(pts), shapely.get_y(pts)
    ys = _sample(heights, dem, xs, zs)
    d, k = idx.nearest(xs, zs, max_dist=SNAP_M)
    min_x, min_z, max_x, max_z = extent
    out = []
    for n, it in enumerate(items):
        x, z = float(xs[n]), float(zs[n])
        if not (min_x <= x < max_x and min_z <= z < max_z):
            continue
        rec = {kk: vv for kk, vv in it.items() if kk != "geom" and vv is not None}
        rec.update({"id": it["osmId"], "x": _r(x), "y": _r(ys[n]), "z": _r(z)})
        rec.pop("osmId")
        if np.isfinite(d[n]):
            j = k[n]
            e = edges_by_id[int(idx.edge_of[j])]
            lat = (x - idx.xz[j, 0]) * idx.nrm[j, 0] + (z - idx.xz[j, 1]) * idx.nrm[j, 1]
            rec["road"] = {"edgeId": e.id, "s": _r(idx.s[j], 1), "side": "right" if lat >= 0 else "left", "distance": _r(d[n], 1)}
        if rec["type"] in FALLBACK_NAMES:
            rec["nameFromOsm"] = "name" in rec
            if "name" not in rec:
                road = None
                if np.isfinite(d[n]):
                    e = edges_by_id[int(idx.edge_of[k[n]])]
                    road = e.name or e.ref
                label = FALLBACK_NAMES[rec["type"]]
                rec["name"] = f"{label}, {road}" if road else label
        out.append(rec)
    return out


# --- spawns ----------------------------------------------------------------


def _spawns(edges, stops, garages, pois, dem, heights):
    out = []
    for e in edges:
        if e.length < 30:
            continue
        lw = e.lane_width
        lane_off = e.half_width - lw / 2 if e.lanes > 1 else (0.0 if e.oneway else e.half_width / 2)
        dirs = [(1, lane_off)] if e.oneway else [(1, lane_off), (-1, -lane_off)]
        for s in np.arange(20.0, e.length - 10, TRAFFIC_SPAWN_EVERY_M):
            i = int(np.searchsorted(e.s, s))
            i = min(i, len(e.s) - 1)
            t = e.xz[min(i + 1, len(e.xz) - 1)] - e.xz[max(i - 1, 0)]
            t = t / max(np.linalg.norm(t), 1e-9)
            for sign, off in dirs:
                p = e.xz[i] + e.nrm[i] * off
                y = e.hc[i] + e.cs[i] * off + ROAD_LIFT
                out.append({"type": "traffic", "x": _r(p[0]), "y": _r(y), "z": _r(p[1]), "yaw": _r(_yaw(*(t * sign)), 3), "edgeId": e.id, "s": _r(e.s[i], 1), "forward": sign > 0})
        if e.highway.replace("_link", "") in ("primary", "secondary", "tertiary", "residential", "unclassified", "trunk"):
            off = e.corridor_half_width + 1.0
            for s in np.arange(15.0, e.length - 5, PEDESTRIAN_SPAWN_EVERY_M):
                i = min(int(np.searchsorted(e.s, s)), len(e.s) - 1)
                for side in (1, -1):
                    p = e.xz[i] + e.nrm[i] * off * side
                    out.append({"type": "pedestrian", "x": _r(p[0]), "z": _r(p[1]), "edgeId": e.id})
    ped = [o for o in out if o["type"] == "pedestrian"]
    if ped:
        ys = _sample(heights, dem, [o["x"] for o in ped], [o["z"] for o in ped])
        for o, y in zip(ped, ys):
            o["y"] = _r(y)
    for src, kind in ((stops, "bus_stop"), (garages, "garage"), ([p for p in pois if p["type"] == "market"], "market")):
        for p in src:
            out.append({"type": "passenger", "x": p["x"], "y": p["y"], "z": p["z"], "at": kind, "ref": p["id"]})
    return out


# --- build -----------------------------------------------------------------


def build_area(area: Area, out_root: Path) -> None:
    t0 = time.time()
    out = out_root / area.key
    out.mkdir(parents=True, exist_ok=True)
    for old in list(out.glob("*.glb")) + list(out.glob("*_*.json")) + list(out.glob("*.bin")):
        old.unlink()

    click.echo("build: loading cached data")
    dem = load_dem(area)
    G = load_graph(area)
    features = load_features(area)
    osm_b = load_osm_buildings(area)
    ob = load_buildings(area)

    click.echo("build: road graph")
    nodes, edges = build_road_graph(G, dem, area)
    edges_by_id = {e.id: e for e in edges}

    click.echo("build: terrain (flattening under roads)")
    heights = flatten_under_roads(dem, edges)
    green_g, water_g = _cover_geoms(features)
    green_mask, _ = cover_masks(dem, green_g, [])

    valid = set(area.chunks())
    bank = MeshBank(area.chunk_size, valid)
    click.echo("build: road meshes")
    build_road_meshes(nodes, edges, bank)
    add_water_meshes(area, dem, heights, water_g, bank)

    click.echo(f"build: buildings ({len(ob)} footprints)")
    buildings, bstats = prepare_buildings(area, ob, osm_b, features, edges)
    add_building_meshes(buildings, dem, heights, bank)
    placed = [b for b in buildings if bank.chunk_of(b["poly"].centroid.x, b["poly"].centroid.y) in valid]

    click.echo("build: features and spawn points")
    idx = RoadIndex(edges)
    stops_raw, garages_raw, pois_raw = _classify(features, osm_b)
    extent = area.extent
    stops = _place(stops_raw, dem, heights, idx, edges_by_id, extent)
    garages = _place(garages_raw, dem, heights, idx, edges_by_id, extent)
    pois = _place(pois_raw, dem, heights, idx, edges_by_id, extent)
    spawns = _spawns(edges, stops, garages, pois, dem, heights)

    # Which edges touch which chunks.
    size = area.chunk_size
    edge_chunks: dict[tuple, list[int]] = defaultdict(list)
    for e in edges:
        keys = set(zip(np.floor(e.xz[:, 0] / size).astype(int).tolist(), np.floor(e.xz[:, 1] / size).astype(int).tolist()))
        for k in keys:
            if k in valid:
                edge_chunks[k].append(e.id)
    edge_json = {e.id: edge_to_json(e) for e in edges}

    def chunk_key(p):
        return (math.floor(p["x"] / size), math.floor(p["z"] / size))

    by_chunk = defaultdict(lambda: defaultdict(list))
    for kind, items in (("stops", stops), ("garages", garages), ("pois", pois), ("spawns", spawns)):
        for p in items:
            by_chunk[chunk_key(p)][kind].append(p)

    click.echo(f"build: writing {len(valid)} chunks to {out}")
    chunk_meta = []
    over_budget = []
    trimmed = 0
    n = int(size / area.terrain_spacing)
    with click.progressbar(sorted(valid, key=lambda k: (k[1], k[0])), label="  chunks") as bar:
        for cx, cz in bar:
            hf = add_terrain_mesh(area, dem, heights, green_mask, cx, cz, bank)
            origin = (cx * size, 0.0, cz * size)
            name = f"{cx}_{cz}"
            extras = {"cx": cx, "cz": cz, "area": area.key}
            glb = None
            for step in BUDGET_STEPS:
                glb = encode_glb(f"chunk_{name}", origin, bank.build((cx, cz), origin, min_priority=step), extras)
                if len(glb) <= area.glb_max_bytes:
                    if step != -np.inf:
                        trimmed += 1
                    break
            else:
                over_budget.append((name, len(glb)))
            (out / f"{name}.glb").write_bytes(glb)
            bank.release((cx, cz))
            hf32 = np.ascontiguousarray(hf, dtype="<f4")
            (out / f"{name}.bin").write_bytes(hf32.tobytes())

            cj = {
                "version": FORMAT_VERSION,
                "cx": cx,
                "cz": cz,
                "bounds": {"minX": cx * size, "minZ": cz * size, "maxX": (cx + 1) * size, "maxZ": (cz + 1) * size},
                "roads": [edge_json[i] for i in sorted(edge_chunks.get((cx, cz), []))],
                "stops": by_chunk[(cx, cz)]["stops"],
                "garages": by_chunk[(cx, cz)]["garages"],
                "pois": by_chunk[(cx, cz)]["pois"],
                "spawns": by_chunk[(cx, cz)]["spawns"],
            }
            js = json.dumps(cj, separators=(",", ":"), ensure_ascii=False).encode()
            (out / f"{name}.json").write_bytes(js)
            chunk_meta.append(
                {
                    "cx": cx,
                    "cz": cz,
                    "bounds": cj["bounds"],
                    "minY": _r(hf.min()),
                    "maxY": _r(hf.max()),
                    "files": {"glb": f"{name}.glb", "json": f"{name}.json", "heightfield": f"{name}.bin"},
                    "bytes": {"glb": len(glb), "json": len(js), "heightfield": hf32.nbytes},
                }
            )

    min_x, min_z, max_x, max_z = extent
    manifest = {
        "version": FORMAT_VERSION,
        "area": {"key": area.key, "name": area.name, "bboxWgs84": list(area.bbox)},
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "projection": {
            "proj4": PROJ4,
            "origin": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "osmNodeId": ORIGIN_OSM_NODE},
            "originElevationM": _r(dem.origin_elevation),
            "axes": "x = easting, y = elevation - originElevation, z = -northing (metres)",
        },
        "chunkSize": size,
        "chunkRange": {"cx": [area.cx0, area.cx1], "cz": [area.cz0, area.cz1]},
        "extent": {"minX": min_x, "minZ": min_z, "maxX": max_x, "maxZ": max_z},
        "heightfield": {
            "samples": n + 1,
            "spacing": area.terrain_spacing,
            "format": "float32 little-endian, row-major; row = z index (north to south), col = x index (west to east); "
            "sample (i, j) is at (bounds.minX + i*spacing, bounds.minZ + j*spacing)",
        },
        "glb": {
            "nodeTranslation": "root node is translated to (bounds.minX, 0, bounds.minZ); vertices are chunk-local",
            "materials": sorted(MATERIALS),
            "uv": "terrain/roofs/water: world metres; roads: u 0..1 across, v metres along; walls: u metres along, v metres up",
            "roadLift": ROAD_LIFT,
        },
        "chunks": chunk_meta,
        "roadGraph": {
            "nodes": [node_to_json(nd) for nd in nodes.values()],
            "edges": [edge_json[e.id] for e in edges],
        },
        "stops": stops,
        "garages": garages,
        "pois": pois,
        "attribution": ATTRIBUTION,
    }
    mpath = out / "manifest.json"
    mpath.write_text(json.dumps(manifest, separators=(",", ":"), ensure_ascii=False))

    _summary(area, out, edges, extent, placed, bstats, chunk_meta, mpath, stops, garages, pois, trimmed, over_budget, time.time() - t0)


def _summary(area, out, edges, extent, placed, bstats, chunk_meta, mpath, stops, garages, pois, trimmed, over_budget, secs):
    min_x, min_z, max_x, max_z = extent
    road_m = 0.0
    for e in edges:
        mid = (e.xz[1:] + e.xz[:-1]) / 2
        inside = (mid[:, 0] >= min_x) & (mid[:, 0] < max_x) & (mid[:, 1] >= min_z) & (mid[:, 1] < max_z)
        road_m += float(np.diff(e.s)[inside].sum())
    candidates = [e for e in edges if e.length >= 40 and not e.bridge]
    steep = max(candidates, key=lambda e: e.max_grade) if candidates else None
    glb = [c["bytes"]["glb"] for c in chunk_meta]
    js = sum(c["bytes"]["json"] for c in chunk_meta)
    hf = sum(c["bytes"]["heightfield"] for c in chunk_meta)
    mb = lambda b: f"{b / 1e6:.1f} MB"
    largest = max(chunk_meta, key=lambda c: c["bytes"]["glb"])

    click.echo("")
    click.echo(f"=== {area.key}: {area.name} ===")
    click.echo(f"chunks            {len(chunk_meta)} ({area.cx1 - area.cx0 + 1} x {area.cz1 - area.cz0 + 1} at {area.chunk_size:g} m)")
    click.echo(f"road network      {road_m / 1000:.1f} km across {len(edges)} edges")
    if steep:
        label = steep.name or steep.ref or f"unnamed {steep.highway} road"
        click.echo(f"steepest grade    {steep.max_grade:.1f}% over {GRADE_WINDOW_M:g} m on {label} (OSM way {steep.way_id}, {steep.length:.0f} m, avg {abs(steep.grade):.1f}%)")
    click.echo(f"buildings         {len(placed)} ({bstats.osm_levels} with OSM levels; {bstats.removed_on_roads} dropped and {bstats.trimmed_by_roads} trimmed for roads)")
    click.echo(f"  materials       {dict(sorted(bstats.by_material.items()))}")
    click.echo(f"  roofs           {dict(sorted(bstats.by_roof.items()))}")
    click.echo(f"stops / garages   {len(stops)} / {len(garages)};  POIs {len(pois)}")
    click.echo(f"glb               total {mb(sum(glb))}, mean {sum(glb) / len(glb) / 1e3:.0f} KB, largest {largest['files']['glb']} {mb(largest['bytes']['glb'])}")
    click.echo(f"json / heightfield total {mb(js)} / {mb(hf)};  manifest {mb(mpath.stat().st_size)}")
    if trimmed:
        click.echo(f"budget            {trimmed} chunks dropped their smallest buildings to stay under {mb(area.glb_max_bytes)}")
    if over_budget:
        click.echo(click.style(f"OVER BUDGET       {len(over_budget)} chunks: {over_budget[:5]}", fg="red"))
    click.echo(f"output            {out}  ({secs:.0f} s)")
