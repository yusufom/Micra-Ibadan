import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { Prop, PropType } from "../chunks/types";
import { BOARD_SIZE, KIOSK_PAINT, POLE_PAINT, propGeometry, WIRE_OFFSETS, WIRE_Y } from "./propModels";

const TYPES: PropType[] = ["pole", "kiosk", "mechanic_shed", "garage_shelter", "garage_board"];
const WIRE_SEGMENTS = 6;
const UP = new Vector3(0, 1, 0);

const m4 = new Matrix4();
const q = new Quaternion();
const p3 = new Vector3();
const one = new Vector3(1, 1, 1);
const col = new Color();

/**
 * Street props around the focus as one InstancedMesh per prop type (five draw
 * calls however many chunks are near), plus one LineSegments for all the
 * sagging electric wires. Rebuilt only when the set of nearby chunks changes.
 */
export class PropLayer {
  readonly group = new Group();
  private readonly meshes = new Map<PropType, InstancedMesh>();
  private readonly wires: LineSegments;
  private readonly boards = new Map<string, Mesh>();
  private readonly material: Material;
  private readonly castShadow: boolean;

  constructor(material: Material, castShadow: boolean) {
    this.material = material;
    this.castShadow = castShadow;
    this.group.name = "props";
    this.wires = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x151515 }));
    this.wires.name = "wires";
    this.wires.frustumCulled = false;
    this.group.add(this.wires);
  }

  private meshFor(type: PropType, count: number): InstancedMesh {
    let mesh = this.meshes.get(type);
    if (!mesh || mesh.instanceMatrix.count < count) {
      if (mesh) {
        this.group.remove(mesh);
        mesh.dispose();
      }
      const capacity = Math.max(16, Math.ceil(count * 1.5));
      mesh = new InstancedMesh(propGeometry(type), this.material, capacity);
      mesh.name = `props-${type}`;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.castShadow = this.castShadow && type !== "pole";
      mesh.receiveShadow = true;
      // Props spread over several chunks; one bounding sphere per type is not worth recomputing.
      mesh.frustumCulled = false;
      this.meshes.set(type, mesh);
      this.group.add(mesh);
    }
    return mesh;
  }

  /** Replace every instance with the given props. */
  rebuild(props: Prop[]): void {
    const byType = new Map<PropType, Prop[]>(TYPES.map((t) => [t, []]));
    for (const p of props) byType.get(p.type)?.push(p);

    for (const [type, list] of byType) {
      const mesh = this.meshFor(type, list.length);
      list.forEach((p, i) => {
        q.setFromAxisAngle(UP, p.yaw);
        m4.compose(p3.set(p.x, p.y, p.z), q, one);
        mesh.setMatrixAt(i, m4);
        if (type === "kiosk") col.setRGB(...KIOSK_PAINT[(p.variant ?? 0) % KIOSK_PAINT.length]);
        else if (type === "pole") col.setRGB(...POLE_PAINT[Math.abs(Math.round(p.x * 7 + p.z * 13)) % POLE_PAINT.length]);
        else col.setRGB(1, 1, 1);
        mesh.setColorAt(i, col);
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    this.rebuildWires(byType.get("pole")!);
    this.rebuildBoards(byType.get("garage_board")!);
  }

  private rebuildWires(poles: Prop[]): void {
    const spans = poles.filter((p) => p.next);
    const pos = new Float32Array(spans.length * WIRE_OFFSETS.length * WIRE_SEGMENTS * 6);
    let o = 0;
    for (const p of spans) {
      const [nx, ny, nz] = p.next!;
      const dx = nx - p.x;
      const dz = nz - p.z;
      const span = Math.hypot(dx, dz);
      if (span < 1) continue;
      // Offsets across the span, so both ends of a wire use the same side.
      const px = -dz / span;
      const pz = dx / span;
      const sag = 0.2 + 0.025 * span;
      for (const off of WIRE_OFFSETS) {
        const ax = p.x + px * off;
        const az = p.z + pz * off;
        const ay = p.y + WIRE_Y;
        const by = ny + WIRE_Y;
        for (let s = 0; s < WIRE_SEGMENTS; s++) {
          for (const t of [s / WIRE_SEGMENTS, (s + 1) / WIRE_SEGMENTS]) {
            pos[o++] = ax + dx * t;
            pos[o++] = ay + (by - ay) * t - sag * 4 * t * (1 - t);
            pos[o++] = az + dz * t;
          }
        }
      }
    }
    const g = this.wires.geometry;
    g.setAttribute("position", new BufferAttribute(pos.subarray(0, o), 3));
    g.setDrawRange(0, o / 3);
    g.computeBoundingSphere();
  }

  private rebuildBoards(boards: Prop[]): void {
    const keep = new Set<string>();
    for (const b of boards) {
      const key = `${b.name}@${b.x},${b.z}`;
      keep.add(key);
      if (this.boards.has(key)) continue;
      const mesh = makeBoardText(b.name ?? "Motor Park");
      q.setFromAxisAngle(UP, b.yaw);
      // Face the road (-Z local), just in front of the board.
      p3.set(0, BOARD_SIZE.y, -0.03).applyQuaternion(q);
      mesh.position.set(b.x + p3.x, b.y + p3.y, b.z + p3.z);
      mesh.quaternion.copy(q).multiply(new Quaternion().setFromAxisAngle(UP, Math.PI));
      this.boards.set(key, mesh);
      this.group.add(mesh);
    }
    for (const [key, mesh] of this.boards) {
      if (keep.has(key)) continue;
      this.group.remove(mesh);
      disposeBoard(mesh);
      this.boards.delete(key);
    }
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.wires.geometry.dispose();
    (this.wires.material as Material).dispose();
    for (const mesh of this.boards.values()) disposeBoard(mesh);
    this.boards.clear();
    this.group.clear();
  }
}

/** Hand-painted garage name board: white sheet, blue lettering, red trim. */
function makeBoardText(name: string): Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = Math.round((512 * BOARD_SIZE.h) / BOARD_SIZE.w);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ece8dc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#a3241c";
  ctx.lineWidth = 10;
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.fillStyle = "#1b3f8f";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const text = name.toUpperCase();
  let size = 64;
  do {
    ctx.font = `900 ${size}px Impact, "Arial Black", sans-serif`;
    size -= 2;
  } while (ctx.measureText(text).width > canvas.width - 50 && size > 18);
  ctx.fillText(text, canvas.width / 2, canvas.height * 0.44);
  ctx.font = `700 22px "Arial Black", sans-serif`;
  ctx.fillStyle = "#a3241c";
  ctx.fillText("IBADAN · OYO STATE", canvas.width / 2, canvas.height * 0.8);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new Mesh(new PlaneGeometry(BOARD_SIZE.w - 0.1, BOARD_SIZE.h - 0.1), new MeshLambertMaterial({ map: tex }));
  mesh.name = `board-${name}`;
  return mesh;
}

function disposeBoard(mesh: Mesh): void {
  mesh.geometry.dispose();
  const m = mesh.material as MeshLambertMaterial;
  m.map?.dispose();
  m.dispose();
}
