"""Area definitions, paths and the global chunk grid."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .projection import to_game, to_lonlat

PIPELINE_DIR = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_DIR.parent
CACHE_DIR = PIPELINE_DIR / "cache"
AREAS_FILE = PIPELINE_DIR / "areas.yaml"
DEFAULT_OUT = REPO_ROOT / "public" / "chunks"

# Fetch this far beyond the chunk grid so roads and buildings at the edge are
# complete and smoothing has data to work with.
FETCH_MARGIN_M = 150.0


@dataclass
class Area:
    key: str
    name: str
    bbox: tuple[float, float, float, float]  # west, south, east, north (WGS84)
    chunk_size: float
    terrain_spacing: float
    dem_smoothing_m: float
    building_min_confidence: float
    road_max_cross_slope: float
    glb_max_bytes: int
    old_areas: list[dict] = field(default_factory=list)

    # Chunk index range, inclusive. Chunk (cx, cz) covers
    # x in [cx*size, (cx+1)*size], z in [cz*size, (cz+1)*size].
    cx0: int = 0
    cx1: int = 0
    cz0: int = 0
    cz1: int = 0

    @property
    def cache_dir(self) -> Path:
        d = CACHE_DIR / self.key
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def extent(self) -> tuple[float, float, float, float]:
        """Game-space extent of the chunk grid: min_x, min_z, max_x, max_z."""
        s = self.chunk_size
        return (self.cx0 * s, self.cz0 * s, (self.cx1 + 1) * s, (self.cz1 + 1) * s)

    def fetch_bbox(self, margin_m: float = FETCH_MARGIN_M) -> tuple[float, float, float, float]:
        """WGS84 bbox (west, south, east, north) of the chunk grid plus a margin."""
        min_x, min_z, max_x, max_z = self.extent
        xs = [min_x - margin_m, max_x + margin_m]
        zs = [min_z - margin_m, max_z + margin_m]
        lons, lats = [], []
        for x in xs:
            for z in zs:
                lon, lat = to_lonlat(x, z)
                lons.append(lon)
                lats.append(lat)
        return (min(lons), min(lats), max(lons), max(lats))

    def chunks(self):
        for cz in range(self.cz0, self.cz1 + 1):
            for cx in range(self.cx0, self.cx1 + 1):
                yield cx, cz


def load_area(key: str) -> Area:
    data = yaml.safe_load(AREAS_FILE.read_text())
    areas = data.get("areas", {})
    if key not in areas:
        raise KeyError(f"Unknown area {key!r}. Known: {', '.join(sorted(areas))}")
    cfg = {**data.get("defaults", {}), **areas[key]}
    area = Area(
        key=key,
        name=cfg.get("name", key),
        bbox=tuple(cfg["bbox"]),
        chunk_size=float(cfg["chunk_size"]),
        terrain_spacing=float(cfg["terrain_spacing"]),
        dem_smoothing_m=float(cfg["dem_smoothing_m"]),
        building_min_confidence=float(cfg["building_min_confidence"]),
        road_max_cross_slope=float(cfg["road_max_cross_slope"]),
        glb_max_bytes=int(cfg["glb_max_bytes"]),
        old_areas=list(cfg.get("old_areas") or []),
    )
    if area.chunk_size % area.terrain_spacing:
        raise ValueError("chunk_size must be a multiple of terrain_spacing")

    # Project the bbox corners and take the chunks they touch.
    w, s, e, n = area.bbox
    pts = [to_game(lon, lat) for lon in (w, e) for lat in (s, n)]
    xs = [p[0] for p in pts]
    zs = [p[1] for p in pts]
    size = area.chunk_size
    area.cx0 = math.floor(min(xs) / size)
    area.cx1 = math.floor(max(xs) / size)
    area.cz0 = math.floor(min(zs) / size)
    area.cz1 = math.floor(max(zs) / size)
    return area


def list_areas() -> list[str]:
    return sorted(yaml.safe_load(AREAS_FILE.read_text()).get("areas", {}))
