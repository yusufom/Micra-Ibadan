"""Download Copernicus GLO-30 DEM tiles and resample to the game's 5 m grid.

Tiles come from the public AWS bucket (Copernicus DEM, (c) DLR e.V. 2010-2014 and
(c) Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the
European Union and ESA). They are cached in pipeline/cache/dem/.

GLO-30 is a surface model, so tall buildings and tree canopies add bumps. We
median-filter at native resolution to remove single-pixel spikes, sample onto a
5 m grid in game space with cubic interpolation, then Gaussian-smooth so roads
laid on it don't look stepped.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import click
import numpy as np
import rasterio
import requests
from rasterio.merge import merge
from scipy import ndimage

from .config import CACHE_DIR, Area
from .projection import ORIGIN_LAT, ORIGIN_LON, to_lonlat

DEM_DIR = CACHE_DIR / "dem"
BASE_URL = "https://copernicus-dem-30m.s3.amazonaws.com"
# Extra grid beyond the chunk extent so smoothing has no edge artefacts.
GRID_MARGIN_M = 100.0


@dataclass
class DemGrid:
    """Heights on a regular game-space grid. heights[j, i] is at (x0 + i*s, z0 + j*s)."""

    heights: np.ndarray
    x0: float
    z0: float
    spacing: float
    origin_elevation: float  # metres above EGM2008 at the Dugbe origin

    def sample(self, x, z):
        """Bilinear height (relative to origin) at game (x, z). Arrays in, array out."""
        fi = (np.asarray(x, dtype=np.float64) - self.x0) / self.spacing
        fj = (np.asarray(z, dtype=np.float64) - self.z0) / self.spacing
        return ndimage.map_coordinates(self.heights, [fj, fi], order=1, mode="nearest")

    def gradient(self):
        """(dh/dx, dh/dz) arrays on the grid."""
        gz, gx = np.gradient(self.heights, self.spacing)
        return gx, gz


def _tile_name(lat: int, lon: int) -> str:
    ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}_00"
    ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}_00"
    return f"Copernicus_DSM_COG_10_{ns}_{ew}_DEM"


def _tiles_for(bbox) -> list[tuple[int, int]]:
    w, s, e, n = bbox
    tiles = {
        (lat, lon)
        for lat in range(math.floor(s), math.floor(n) + 1)
        for lon in range(math.floor(w), math.floor(e) + 1)
    }
    # Always include the origin's tile so origin elevation is the same for every area.
    tiles.add((math.floor(ORIGIN_LAT), math.floor(ORIGIN_LON)))
    return sorted(tiles)


def _download_tile(lat: int, lon: int) -> Path | None:
    DEM_DIR.mkdir(parents=True, exist_ok=True)
    name = _tile_name(lat, lon)
    dest = DEM_DIR / f"{name}.tif"
    if dest.exists():
        return dest
    url = f"{BASE_URL}/{name}/{name}.tif"
    click.echo(f"  dem: downloading {name}")
    r = requests.get(url, timeout=120)
    if r.status_code in (403, 404):  # ocean tiles don't exist
        return None
    r.raise_for_status()
    tmp = dest.with_suffix(".tif.part")
    tmp.write_bytes(r.content)
    tmp.rename(dest)
    return dest


def _grid_path(area: Area) -> Path:
    return area.cache_dir / f"dem_{int(area.terrain_spacing)}m.npz"


def fetch_dem(area: Area, force: bool = False) -> None:
    out = _grid_path(area)
    if out.exists() and not force:
        click.echo("  dem: cached")
        return

    paths = [p for t in _tiles_for(area.fetch_bbox()) if (p := _download_tile(*t))]
    if not paths:
        raise click.ClickException("No Copernicus DEM tiles for this area")
    srcs = [rasterio.open(p) for p in paths]
    try:
        # Crop the mosaic to the fetch bbox plus the origin, with a margin.
        w, s, e, n = area.fetch_bbox(margin_m=400)
        w, e = min(w, ORIGIN_LON - 0.01), max(e, ORIGIN_LON + 0.01)
        s, n = min(s, ORIGIN_LAT - 0.01), max(n, ORIGIN_LAT + 0.01)
        mosaic, transform = merge(srcs, bounds=(w, s, e, n))
        nodata = srcs[0].nodata
    finally:
        for src in srcs:
            src.close()

    dem = mosaic[0].astype(np.float64)
    if nodata is not None:
        dem[dem == nodata] = np.nan
    if np.isnan(dem).any():
        dem = np.where(np.isnan(dem), np.nanmean(dem), dem)
    dem = ndimage.median_filter(dem, size=3)

    inv = ~transform

    def sample_native(lon, lat, order=3):
        col, row = inv * (np.atleast_1d(lon), np.atleast_1d(lat))
        return ndimage.map_coordinates(dem, [row - 0.5, col - 0.5], order=order, mode="nearest")

    origin_elev = float(sample_native(ORIGIN_LON, ORIGIN_LAT)[0])

    sp = area.terrain_spacing
    min_x, min_z, max_x, max_z = area.extent
    x0, z0 = min_x - GRID_MARGIN_M, min_z - GRID_MARGIN_M
    nx = int(round((max_x - min_x + 2 * GRID_MARGIN_M) / sp)) + 1
    nz = int(round((max_z - min_z + 2 * GRID_MARGIN_M) / sp)) + 1
    gx, gz = np.meshgrid(x0 + np.arange(nx) * sp, z0 + np.arange(nz) * sp)
    lon, lat = to_lonlat(gx.ravel(), gz.ravel())
    heights = sample_native(lon, lat).reshape(nz, nx)
    heights = ndimage.gaussian_filter(heights, sigma=area.dem_smoothing_m / sp, mode="nearest")
    heights -= origin_elev

    np.savez_compressed(out, heights=heights.astype(np.float32), x0=x0, z0=z0, spacing=sp, origin_elevation=origin_elev)
    click.echo(
        f"  dem: {nx}x{nz} grid at {sp:g} m, origin {origin_elev:.1f} m, "
        f"relief {heights.min():.1f}..{heights.max():.1f} m"
    )


def load_dem(area: Area) -> DemGrid:
    d = np.load(_grid_path(area))
    return DemGrid(
        heights=d["heights"].astype(np.float64),
        x0=float(d["x0"]),
        z0=float(d["z0"]),
        spacing=float(d["spacing"]),
        origin_elevation=float(d["origin_elevation"]),
    )
