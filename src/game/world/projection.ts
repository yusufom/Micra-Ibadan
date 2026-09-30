/**
 * World coordinate conventions. Keep in sync with CLAUDE.md and pipeline/.
 *
 * - 1 world unit = 1 metre, +Y up.
 * - +X = east, -Z = north (three.js is right-handed, so north is -Z).
 * - Map data is projected by the pipeline into a local transverse Mercator
 *   projection whose origin (0, 0) is the Dugbe junction below. Elevation (Y)
 *   is real terrain height in metres above the origin's ground height.
 */

/**
 * Projection origin: Dugbe junction (Iyaganku Rd / Fajuyi Rd / Onireke Rd,
 * beside Cocoa House), OSM node 168734026. WGS84.
 */
export const WORLD_ORIGIN = {
  lat: 7.3903934,
  lon: 3.8794116,
  osmNodeId: 168734026,
} as const;

/** proj4 string the pipeline uses for the local metric projection. */
export const WORLD_PROJ4 =
  `+proj=tmerc +lat_0=${WORLD_ORIGIN.lat} +lon_0=${WORLD_ORIGIN.lon} +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
