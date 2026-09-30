"""Download Google Open Buildings v3 footprints for an area.

Open Buildings is published as gzipped CSVs, one per S2 level-4 cell. We fetch
the tile index, download every tile that touches the area into
pipeline/cache/open_buildings/ (resumable; the Ibadan tile is ~2 GB), then clip
to the area and cache the result in pipeline/cache/{area}/.

Dataset: Google Open Buildings, CC BY 4.0 (https://sites.research.google/open-buildings/).
This is the open research dataset, not Google Maps data.
"""

from __future__ import annotations

import json
from pathlib import Path

import click
import geopandas as gpd
import pandas as pd
import requests
from shapely import wkt
from shapely.geometry import box, shape

from .config import CACHE_DIR, Area

TILE_INDEX_URL = "https://openbuildings-public-dot-gweb-research.uw.r.appspot.com/public/tiles.geojson"
OB_DIR = CACHE_DIR / "open_buildings"
USECOLS = ["latitude", "longitude", "area_in_meters", "confidence", "geometry", "full_plus_code"]


def _clipped_path(area: Area) -> Path:
    return area.cache_dir / "open_buildings.csv.gz"


def _download(url: str, dest: Path) -> None:
    """Resumable download to dest via dest.part."""
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"Range": f"bytes={have}-"} if have else {}
    with requests.get(url, headers=headers, stream=True, timeout=60) as r:
        if r.status_code == 416:  # already complete
            part.rename(dest)
            return
        r.raise_for_status()
        if have and r.status_code != 206:
            have = 0  # server ignored the range; start over
        total = int(r.headers.get("Content-Length", 0)) + have
        mode = "ab" if have else "wb"
        with open(part, mode) as f, click.progressbar(length=total, label=f"  {dest.name}") as bar:
            bar.update(have)
            for block in r.iter_content(chunk_size=1 << 20):
                f.write(block)
                bar.update(len(block))
    part.rename(dest)


def _tiles_for(bbox: tuple[float, float, float, float]) -> list[dict]:
    OB_DIR.mkdir(parents=True, exist_ok=True)
    index = OB_DIR / "tiles.geojson"
    if not index.exists():
        r = requests.get(TILE_INDEX_URL, timeout=60)
        r.raise_for_status()
        index.write_bytes(r.content)
    area_box = box(*bbox)
    feats = json.loads(index.read_text())["features"]
    return [f["properties"] for f in feats if shape(f["geometry"]).intersects(area_box)]


def fetch_buildings(area: Area, force: bool = False) -> None:
    out = _clipped_path(area)
    if out.exists() and not force:
        click.echo("  open buildings: cached")
        return

    w, s, e, n = bbox = area.fetch_bbox()
    tiles = _tiles_for(bbox)
    if not tiles:
        raise click.ClickException("No Open Buildings tiles cover this area")

    parts = []
    for t in tiles:
        dest = OB_DIR / f"{t['tile_id']}_buildings.csv.gz"
        if not dest.exists():
            click.echo(f"  open buildings: downloading tile {t['tile_id']} ({t['size_mb']:.0f} MB)")
            _download(t["tile_url"], dest)
        click.echo(f"  open buildings: clipping tile {t['tile_id']}")
        for chunk in pd.read_csv(dest, usecols=USECOLS, chunksize=1_000_000):
            m = chunk["longitude"].between(w, e) & chunk["latitude"].between(s, n)
            if m.any():
                parts.append(chunk[m])

    df = pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=USECOLS)
    df = df.drop_duplicates("full_plus_code")
    df.to_csv(out, index=False, compression="gzip")
    click.echo(f"  open buildings: {len(df)} footprints in area")


def load_buildings(area: Area) -> gpd.GeoDataFrame:
    """Footprints with confidence >= the area threshold, centroid inside the fetch bbox."""
    df = pd.read_csv(_clipped_path(area))
    df = df[df["confidence"] >= area.building_min_confidence]
    geom = df["geometry"].map(wkt.loads)
    return gpd.GeoDataFrame(
        {
            "building_id": "ob:" + df["full_plus_code"].astype(str),
            "confidence": df["confidence"].to_numpy(),
            "area_m2": df["area_in_meters"].to_numpy(),
        },
        geometry=geom.to_numpy(),
        crs="EPSG:4326",
    )
