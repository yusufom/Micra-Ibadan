import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  RedFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  Vector2,
} from "three";
import type { Manifest } from "../chunks/types";

/** Sits this far below the real surface so its coarse triangles never poke through at chunk borders. */
const SINK_M = 0.4;

/**
 * Whole-area low-detail terrain beyond the streamed chunks: a 20 m grid with
 * roofs, roads and laterite baked into one colour map by the pipeline. One
 * draw call. Fragments over a chunk that has its own mesh are discarded via a
 * one-texel-per-chunk mask, so the two never z-fight.
 */
export class FarField {
  readonly mesh: Mesh;
  private readonly maskData: Uint8Array;
  private readonly mask: DataTexture;
  private readonly cx0: number;
  private readonly cz0: number;
  private readonly cols: number;
  private readonly rows: number;

  private constructor(mesh: Mesh, mask: DataTexture, maskData: Uint8Array, manifest: Manifest) {
    this.mesh = mesh;
    this.mask = mask;
    this.maskData = maskData;
    this.cx0 = manifest.chunkRange.cx[0];
    this.cz0 = manifest.chunkRange.cz[0];
    this.cols = manifest.chunkRange.cx[1] - this.cx0 + 1;
    this.rows = manifest.chunkRange.cz[1] - this.cz0 + 1;
  }

  /** Null if the manifest predates the far field (format version 1). */
  static async load(manifest: Manifest, baseUrl: string, stride: number, signal?: AbortSignal): Promise<FarField | null> {
    const far = manifest.farField;
    if (!far) return null;
    const [heightsBuf, texture] = await Promise.all([
      fetch(`${baseUrl}/${far.heightfield}`, { signal }).then((r) => {
        if (!r.ok) throw new Error(`far field: ${r.status}`);
        return r.arrayBuffer();
      }),
      new TextureLoader().loadAsync(`${baseUrl}/${far.colorMap}`),
    ]);
    const heights = new Float32Array(heightsBuf);
    texture.colorSpace = SRGBColorSpace;
    texture.flipY = false;
    texture.anisotropy = 8;

    const { minX, minZ, maxX, maxZ } = manifest.extent;
    const cols = Math.floor((far.cols - 1) / stride) + 1;
    const rows = Math.floor((far.rows - 1) / stride) + 1;
    const pos = new Float32Array(cols * rows * 3);
    const uv = new Float32Array(cols * rows * 2);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const si = Math.min(i * stride, far.cols - 1);
        const sj = Math.min(j * stride, far.rows - 1);
        const x = minX + si * far.spacing;
        const z = minZ + sj * far.spacing;
        const k = j * cols + i;
        pos.set([x, heights[sj * far.cols + si] - SINK_M, z], k * 3);
        uv.set([(x - minX) / (maxX - minX), (z - minZ) / (maxZ - minZ)], k * 2);
      }
    }
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let o = 0;
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols - 1; i++) {
        const a = j * cols + i;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        // Counter-clockwise from +Y with +z south.
        index.set([a, c, b, b, c, d], o);
        o += 6;
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(pos, 3));
    geometry.setAttribute("uv", new BufferAttribute(uv, 2));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    const cr = manifest.chunkRange;
    const mCols = cr.cx[1] - cr.cx[0] + 1;
    const mRows = cr.cz[1] - cr.cz[0] + 1;
    const maskData = new Uint8Array(mCols * mRows);
    const mask = new DataTexture(maskData, mCols, mRows, RedFormat, UnsignedByteType);
    mask.minFilter = mask.magFilter = NearestFilter;
    mask.generateMipmaps = false;
    mask.needsUpdate = true;

    const material = new MeshLambertMaterial({ map: texture });
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uMask = { value: mask };
      shader.uniforms.uGridMin = { value: new Vector2(minX, minZ) };
      shader.uniforms.uGridDim = { value: new Vector2(mCols, mRows) };
      shader.uniforms.uChunkSize = { value: manifest.chunkSize };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec2 vFarXZ;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvFarXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec2 vFarXZ;\nuniform sampler2D uMask;\nuniform vec2 uGridMin;\nuniform vec2 uGridDim;\nuniform float uChunkSize;",
        )
        .replace(
          "#include <clipping_planes_fragment>",
          "#include <clipping_planes_fragment>\nif (texture2D(uMask, (floor((vFarXZ - uGridMin) / uChunkSize) + 0.5) / uGridDim).r > 0.5) discard;",
        );
    };
    material.customProgramCacheKey = () => "far-field";

    const mesh = new Mesh(geometry, material);
    mesh.name = "far-field";
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return new FarField(mesh, mask, maskData, manifest);
  }

  /** Hide the far field over a chunk that is drawing its own mesh. */
  setCovered(cx: number, cz: number, covered: boolean): void {
    const i = cx - this.cx0;
    const j = cz - this.cz0;
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return;
    const v = covered ? 255 : 0;
    if (this.maskData[j * this.cols + i] === v) return;
    this.maskData[j * this.cols + i] = v;
    this.mask.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const m = this.mesh.material as MeshLambertMaterial;
    m.map?.dispose();
    m.dispose();
    this.mask.dispose();
  }
}
