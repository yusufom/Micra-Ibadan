"""Download OpenStreetMap roads and features for an area.

Raw Overpass responses are cached by osmnx in pipeline/cache/osmnx/. The
parsed road graph and feature layers are cached per area in
pipeline/cache/{area}/ so later stages don't hit the network.

Data (c) OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import click
import geopandas as gpd
import networkx as nx
import osmnx as ox
import pandas as pd

from .config import CACHE_DIR, Area

EXTRA_WAY_TAGS = ["surface", "layer", "smoothness", "lit", "sidewalk"]

# One Overpass query for everything that isn't a road or a building.
FEATURE_TAGS: dict[str, bool | list[str]] = {
    "highway": ["bus_stop"],
    "amenity": [
        "taxi", "bus_station", "marketplace", "fuel", "police", "parking",
        "university", "college", "hospital", "place_of_worship", "bank",
        "townhall", "courthouse", "school",
    ],
    "shop": ["mall", "supermarket", "department_store"],
    "tourism": ["attraction", "museum", "hotel", "artwork", "viewpoint"],
    "historic": True,
    "man_made": ["tower", "water_tower", "communications_tower"],
    "natural": ["water", "wood", "scrub", "grassland", "wetland"],
    "water": True,
    "waterway": ["river", "stream", "canal", "riverbank"],
    "landuse": True,
    "leisure": ["park", "pitch", "golf_course", "garden", "stadium", "sports_centre", "recreation_ground"],
}

# Tags kept on feature layers; everything else is dropped before caching.
FEATURE_COLUMNS = [
    "name", "highway", "amenity", "shop", "tourism", "historic", "man_made",
    "natural", "water", "waterway", "landuse", "leisure", "building",
    "building:levels", "height", "operator", "ref", "width",
]


def _configure_osmnx() -> None:
    ox.settings.cache_folder = str(CACHE_DIR / "osmnx")
    ox.settings.use_cache = True
    ox.settings.log_console = False
    ox.settings.requests_timeout = 300
    tags = list(ox.settings.useful_tags_way)
    for t in EXTRA_WAY_TAGS:
        if t not in tags:
            tags.append(t)
    ox.settings.useful_tags_way = tags


def _paths(area: Area) -> dict[str, str]:
    d = area.cache_dir
    return {
        "graph": str(d / "osm_roads.graphml"),
        "features": str(d / "osm_features.geojson"),
        "buildings": str(d / "osm_buildings.geojson"),
    }


def _flatten(gdf: gpd.GeoDataFrame, columns: list[str]) -> gpd.GeoDataFrame:
    """Keep useful tags, add osm_id, stringify list values so GeoJSON can hold them."""
    gdf = gdf.reset_index()
    gdf["osm_id"] = gdf["element"].astype(str) + "/" + gdf["id"].astype(str)
    keep = ["osm_id", "geometry"] + [c for c in columns if c in gdf.columns]
    gdf = gdf[keep].copy()
    for c in keep:
        if c in ("geometry",):
            continue
        gdf[c] = gdf[c].apply(lambda v: None if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))
    return gdf


def fetch_osm(area: Area, force: bool = False) -> None:
    _configure_osmnx()
    paths = _paths(area)
    w, s, e, n = area.fetch_bbox()
    bbox = (w, s, e, n)  # osmnx 2.x: (left, bottom, right, top)

    if force or not _exists(paths["graph"]):
        click.echo("  roads: querying Overpass (drive network)")
        G = ox.graph_from_bbox(bbox, network_type="drive", simplify=False, retain_all=True, truncate_by_edge=True)
        # Merge interstitial nodes but never across a change of way id, so every
        # edge maps to exactly one OSM way.
        G = ox.simplify_graph(G, edge_attrs_differ=["osmid"])
        ox.save_graphml(G, paths["graph"])
        click.echo(f"  roads: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")
    else:
        click.echo("  roads: cached")

    if force or not _exists(paths["features"]):
        click.echo("  features: querying Overpass")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            gdf = ox.features_from_bbox(bbox, FEATURE_TAGS)
        gdf = _flatten(gdf, FEATURE_COLUMNS)
        gdf.to_file(paths["features"], driver="GeoJSON")
        click.echo(f"  features: {len(gdf)}")
    else:
        click.echo("  features: cached")

    if force or not _exists(paths["buildings"]):
        click.echo("  osm buildings: querying Overpass")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                bgdf = ox.features_from_bbox(bbox, {"building": True})
            bgdf = _flatten(bgdf, FEATURE_COLUMNS)
            bgdf = bgdf[bgdf.geometry.geom_type.isin(["Polygon", "MultiPolygon"])]
        except ox._errors.InsufficientResponseError:
            bgdf = gpd.GeoDataFrame({"osm_id": [], "geometry": []}, crs="EPSG:4326")
        bgdf.to_file(paths["buildings"], driver="GeoJSON")
        click.echo(f"  osm buildings: {len(bgdf)}")
    else:
        click.echo("  osm buildings: cached")


def _exists(p: str) -> bool:
    return Path(p).exists()


def load_graph(area: Area) -> nx.MultiDiGraph:
    _configure_osmnx()
    return ox.load_graphml(_paths(area)["graph"])


def load_features(area: Area) -> gpd.GeoDataFrame:
    return gpd.read_file(_paths(area)["features"])


def load_osm_buildings(area: Area) -> gpd.GeoDataFrame:
    return gpd.read_file(_paths(area)["buildings"])
