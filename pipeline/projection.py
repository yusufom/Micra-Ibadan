"""Local metric projection centred on Dugbe.

Game coordinates: x = easting, z = -northing (so +z is south, matching three.js
with +Y up and north = -Z), y = elevation - elevation(origin). All metres.

Must stay in sync with src/game/world/projection.ts and CLAUDE.md.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from pyproj import CRS, Transformer

ORIGIN_LAT = 7.3903934
ORIGIN_LON = 3.8794116
ORIGIN_OSM_NODE = 168734026

PROJ4 = (
    f"+proj=tmerc +lat_0={ORIGIN_LAT} +lon_0={ORIGIN_LON} +k=1 +x_0=0 +y_0=0 "
    "+datum=WGS84 +units=m +no_defs"
)
LOCAL_CRS = CRS.from_proj4(PROJ4)

_TS_FILE = Path(__file__).resolve().parent.parent / "src" / "game" / "world" / "projection.ts"


@lru_cache(maxsize=1)
def _fwd() -> Transformer:
    return Transformer.from_crs("EPSG:4326", LOCAL_CRS, always_xy=True)


@lru_cache(maxsize=1)
def _inv() -> Transformer:
    return Transformer.from_crs(LOCAL_CRS, "EPSG:4326", always_xy=True)


def to_game(lon, lat):
    """WGS84 lon/lat (floats or numpy arrays) -> game (x, z)."""
    e, n = _fwd().transform(lon, lat)
    return e, -n


def to_lonlat(x, z):
    """Game (x, z) -> WGS84 (lon, lat)."""
    return _inv().transform(x, -z)


def game_crs() -> CRS:
    """CRS of the game's ground plane in (easting, northing). Note z = -northing."""
    return LOCAL_CRS


def check_ts_sync() -> None:
    """Fail loudly if projection.ts has drifted from this module."""
    if not _TS_FILE.exists():
        return
    src = _TS_FILE.read_text()
    lat = re.search(r"lat:\s*([-\d.]+)", src)
    lon = re.search(r"lon:\s*([-\d.]+)", src)
    if not lat or not lon:
        raise RuntimeError(f"Could not read WORLD_ORIGIN from {_TS_FILE}")
    if float(lat.group(1)) != ORIGIN_LAT or float(lon.group(1)) != ORIGIN_LON:
        raise RuntimeError(
            f"Projection origin mismatch: {_TS_FILE} has "
            f"{lat.group(1)}, {lon.group(1)} but pipeline has {ORIGIN_LAT}, {ORIGIN_LON}"
        )
