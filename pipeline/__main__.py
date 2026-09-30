"""CLI: python -m pipeline build --area dugbe-ui"""

from __future__ import annotations

from pathlib import Path

import click

from .config import DEFAULT_OUT, list_areas, load_area
from .projection import check_ts_sync


@click.group()
def cli() -> None:
    """Micra Ibadan map pipeline: OSM + Open Buildings + Copernicus DEM -> game chunks."""
    check_ts_sync()


@cli.command()
def areas() -> None:
    """List areas defined in pipeline/areas.yaml."""
    for key in list_areas():
        a = load_area(key)
        n = (a.cx1 - a.cx0 + 1) * (a.cz1 - a.cz0 + 1)
        click.echo(f"{key:16} {a.name}  bbox={list(a.bbox)}  chunks={n}")


def _fetch(area, refresh: bool) -> None:
    from .fetch_buildings import fetch_buildings
    from .fetch_dem import fetch_dem
    from .fetch_osm import fetch_osm

    click.echo("fetch: OpenStreetMap")
    fetch_osm(area, force=refresh)
    click.echo("fetch: Google Open Buildings")
    fetch_buildings(area, force=refresh)
    click.echo("fetch: Copernicus GLO-30 DEM")
    fetch_dem(area, force=refresh)


@cli.command()
@click.option("--area", "area_key", required=True, help="Area key from areas.yaml")
@click.option("--refresh", is_flag=True, help="Re-download source data instead of using pipeline/cache")
def fetch(area_key: str, refresh: bool) -> None:
    """Download and cache source data only."""
    _fetch(load_area(area_key), refresh)


@cli.command()
@click.option("--area", "area_key", required=True, help="Area key from areas.yaml")
@click.option("--out", "out_dir", type=click.Path(path_type=Path), default=DEFAULT_OUT, show_default=True)
@click.option("--refresh", is_flag=True, help="Re-download source data instead of using pipeline/cache")
def build(area_key: str, out_dir: Path, refresh: bool) -> None:
    """Fetch (cached) and build chunks for an area."""
    from .chunk import build_area

    area = load_area(area_key)
    _fetch(area, refresh)
    build_area(area, out_dir)


if __name__ == "__main__":
    cli()
