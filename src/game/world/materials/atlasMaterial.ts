import { Color, type Material, MeshLambertMaterial, MeshStandardMaterial, Vector4 } from "three";
import type { QualityTier } from "../quality";
import { ATLAS_SIZE, CELL, CONTENT, getAtlas, MAX_LOD, PAD, TILE, TILE_SPECS, type TileId } from "./atlas";

/**
 * The one opaque material every chunk surface uses. Geometry carries a
 * per-vertex `aMat` (tile id, see atlas.ts) so terrain, roads, drains, walls
 * and roofs of a whole chunk merge into a single mesh and a single draw call.
 *
 * "world" adds the Ibadan-specific touches that need world context: broken
 * asphalt edges and tar patches, laterite ruts, and red dust splashed up the
 * bottom of walls. "props" reads every tile from mesh uv (instanced props).
 */
export type AtlasMaterialKind = "world" | "props";

const TILE_COUNT = 16;

/** Vertex shader additions: tile lookup and tile coordinate per vertex. */
const VERT_PARS = /* glsl */ `
attribute float aMat;
uniform vec4 uTileA[${TILE_COUNT}];
uniform vec4 uTileB[${TILE_COUNT}];
flat varying int vTile;
flat varying vec4 vTileB;
varying vec2 vTileUv;
varying vec3 vWorldPos;
varying vec2 vRawUv;
`;

const VERT_MAIN = /* glsl */ `
{
  int tileId = int(aMat + 0.5);
  vec4 ta = uTileA[tileId];
  vTile = tileId;
  vTileB = uTileB[tileId];
  vec4 wp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  wp = modelMatrix * wp;
  vWorldPos = wp.xyz;
  vRawUv = uv;
  int mode = int(ta.z + 0.5);
  #ifdef ATLAS_UV_ONLY
    mode = 1;
    #ifdef USE_INSTANCING_COLOR
      // Props: vertex colour alpha says how much of the instance colour a part takes.
      vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, color.a);
    #endif
  #endif
  if (mode == 1) {
    vTileUv = uv / ta.xy;
  } else if (mode == 2) {
    // Corrugations run down the slope. Chunks are only translated, so the
    // object normal is the world normal.
    vec2 d = normal.xz;
    float l = length(d);
    vec2 down = l > 0.05 ? d / l : vec2(0.0, 1.0);
    vTileUv = vec2(dot(wp.xz, vec2(down.y, -down.x)), dot(wp.xz, down)) / ta.xy;
  } else {
    vTileUv = wp.xz / ta.xy;
  }
}
`;

const FRAG_PARS = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec4 uTileAvg[${TILE_COUNT}];
flat varying int vTile;
flat varying vec4 vTileB;
varying vec2 vTileUv;
varying vec3 vWorldPos;
varying vec2 vRawUv;

float atlasHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float atlasNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(atlasHash(i), atlasHash(i + vec2(1.0, 0.0)), u.x),
             mix(atlasHash(i + vec2(0.0, 1.0)), atlasHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

// Sample one tile with explicit gradients so fract() leaves no seam. Gradients
// are clamped to MAX_LOD so mips never bleed across cells; past that the tile
// fades to its average colour instead of shimmering.
vec4 atlasSample(int tile, vec2 tuv) {
  const float SIZE = ${ATLAS_SIZE.toFixed(1)};
  const float K = ${(CONTENT / ATLAS_SIZE).toFixed(8)};
  const float LIM = ${(Math.pow(2, MAX_LOD) / ATLAS_SIZE).toFixed(8)};
  vec2 cell = vec2(float(tile % 4), float(tile / 4));
  vec2 base = (cell * ${CELL.toFixed(1)} + ${PAD.toFixed(1)}) / SIZE;
  vec2 dx = dFdx(tuv) * K;
  vec2 dy = dFdy(tuv) * K;
  float lx = length(dx);
  float ly = length(dy);
  float lod = log2(max(max(lx, ly) * SIZE, 1e-4));
  dx *= min(1.0, LIM / max(lx, 1e-8));
  dy *= min(1.0, LIM / max(ly, 1e-8));
  vec4 t = textureGrad(uAtlas, base + fract(tuv) * K, dx, dy);
  return mix(t, uTileAvg[tile], smoothstep(${(MAX_LOD - 0.5).toFixed(1)}, ${(MAX_LOD + 1.5).toFixed(1)}, lod));
}
`;

const T = TILE;

/** Replaces map_fragment: base colour from the atlas plus world wear. */
const FRAG_MAP = /* glsl */ `
vec4 atlasTexel = atlasSample(vTile, vTileUv);
vec3 atlasCol = atlasTexel.rgb;
float tintMask = atlasTexel.a * vTileB.z;
float dustAmt = 0.0;
float roughAdjust = 0.0;
#ifdef ATLAS_WORLD
  vec3 laterite = uTileAvg[${T.laterite}].rgb;
  if (vTile == ${T.asphalt}) {
    // u runs 0..1 across the carriageway (junction patches are 0.5 throughout).
    float edge = min(vRawUv.x, 1.0 - vRawUv.x);
    float n = atlasNoise(vWorldPos.xz * 0.35) + 0.4 * atlasNoise(vWorldPos.xz * 1.9);
    float broken = 0.02 + 0.06 * n;
    vec3 soil = atlasSample(${T.laterite}, vWorldPos.xz / 6.0).rgb;
    // Broad tone drift so the tile never visibly repeats along a long road.
    atlasCol *= 0.92 + 0.14 * atlasNoise(vWorldPos.xz * 0.045);
    // Dust blown on from the shoulders.
    atlasCol = mix(atlasCol, laterite, (1.0 - smoothstep(0.0, 0.16, edge)) * 0.3);
    // Crumbling edges show laterite underneath.
    float lip = smoothstep(broken, broken + 0.008, edge);
    atlasCol = mix(soil * 0.9, atlasCol, lip);
    roughAdjust = (1.0 - lip) * 0.08;
  } else if (vTile == ${T.laterite}) {
    // Unpaved road: two compacted, darker wheel ruts and eroded gullies.
    float u = vRawUv.x;
    float rut = max(1.0 - smoothstep(0.03, 0.08, abs(u - 0.3)), 1.0 - smoothstep(0.03, 0.08, abs(u - 0.7)));
    atlasCol *= 1.0 - 0.14 * rut;
    float gully = smoothstep(0.72, 0.8, atlasNoise(vWorldPos.xz * vec2(0.4, 0.4) + u * 3.0));
    atlasCol *= 1.0 - 0.18 * gully;
  } else if (vTile == ${T.roofConcrete} || vTile == ${T.zincRusted} || vTile == ${T.zinc}) {
    // Roofs age differently, even next door: break up the tile at building scale.
    atlasCol *= 0.86 + 0.24 * atlasNoise(vWorldPos.xz * 0.11);
  } else if (vTile >= ${T.plaster} && vTile <= ${T.mudBrick}) {
    // Walls: v is metres up from 1.5 m below the lowest footprint corner, so
    // v - 1.5 is height above ground. Red laterite splash from rain and traffic.
    float h = vRawUv.y - 1.5 + 0.35 * atlasNoise(vWorldPos.xz * 0.9);
    dustAmt = (1.0 - smoothstep(0.0, 0.9, h)) * 0.6;
    // Sun-faded paint varies across long walls.
    float fade = smoothstep(0.55, 0.9, atlasNoise(vWorldPos.xz * 0.12 + vWorldPos.y * 0.2));
    atlasCol = mix(atlasCol, vec3(1.0), fade * 0.12 * atlasTexel.a);
  }
#endif
diffuseColor.rgb *= atlasCol;
`;

/** Replaces color_fragment: tint by vertex (and instance) colour where the tile allows. */
const FRAG_COLOR = /* glsl */ `
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
  diffuseColor.rgb *= mix(vec3(1.0), vColor.rgb, tintMask);
#endif
#ifdef ATLAS_WORLD
  diffuseColor.rgb = mix(diffuseColor.rgb, laterite * 0.85, dustAmt);
#endif
`;

function tileUniforms() {
  const a: Vector4[] = [];
  const b: Vector4[] = [];
  const avg: Vector4[] = [];
  const { averages } = getAtlas();
  for (let i = 0; i < TILE_COUNT; i++) {
    const s = TILE_SPECS[i as TileId];
    a.push(s ? new Vector4(s.scale[0], s.scale[1], s.mode, 0) : new Vector4(1, 1, 0, 0));
    b.push(s ? new Vector4(s.roughness, s.metalness, s.tint, 0) : new Vector4(1, 0, 1, 0));
    avg.push(new Vector4(averages[i * 4], averages[i * 4 + 1], averages[i * 4 + 2], averages[i * 4 + 3]));
  }
  return { a, b, avg };
}

const cache = new Map<string, Material>();

/**
 * Shared atlas material. "high" uses MeshStandardMaterial with per-tile
 * roughness/metalness; "low" uses the cheaper Lambert model. Never dispose the
 * result: every chunk shares it.
 */
export function getAtlasMaterial(kind: AtlasMaterialKind, tier: QualityTier): Material {
  const key = `${kind}:${tier}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const params = { vertexColors: true, color: new Color(1, 1, 1) };
  const mat = tier === "high" ? new MeshStandardMaterial({ ...params, roughness: 1, metalness: 0 }) : new MeshLambertMaterial(params);
  const { a, b, avg } = tileUniforms();
  const atlas = getAtlas();

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAtlas = { value: atlas.texture };
    shader.uniforms.uTileA = { value: a };
    shader.uniforms.uTileB = { value: b };
    shader.uniforms.uTileAvg = { value: avg };
    const defines = (kind === "world" ? "#define ATLAS_WORLD\n" : "#define ATLAS_UV_ONLY\n");
    shader.vertexShader = defines + shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_MAIN}`);
    shader.fragmentShader = defines + shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <map_fragment>", FRAG_MAP)
      .replace("#include <color_fragment>", FRAG_COLOR)
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp(vTileB.x + roughAdjust, 0.0, 1.0);")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vTileB.y;");
  };
  mat.customProgramCacheKey = () => `atlas-${key}`;
  mat.name = `atlas-${key}`;
  cache.set(key, mat);
  return mat;
}
