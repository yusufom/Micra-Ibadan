"""Shared mesh helpers: per-chunk mesh accumulation, normals, swept profiles."""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from .glb import MeshData


def vertex_normals(pos: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted smooth normals."""
    fn = np.cross(pos[faces[:, 1]] - pos[faces[:, 0]], pos[faces[:, 2]] - pos[faces[:, 0]])
    vn = np.zeros_like(pos)
    for k in range(3):
        np.add.at(vn, faces[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True)
    ln[ln == 0] = 1
    vn /= ln
    vn[(vn == 0).all(axis=1)] = (0, 1, 0)
    return vn


def orient_faces(pos: np.ndarray, faces: np.ndarray, expected: np.ndarray) -> np.ndarray:
    """Flip triangles whose geometric normal points away from `expected` (per face or (3,))."""
    fn = np.cross(pos[faces[:, 1]] - pos[faces[:, 0]], pos[faces[:, 2]] - pos[faces[:, 0]])
    flip = (fn * expected).sum(axis=1) < 0
    faces = faces.copy()
    faces[flip] = faces[flip][:, [0, 2, 1]]
    return faces


def rgba(rgb, a=255) -> np.ndarray:
    c = np.clip(np.round(np.asarray(rgb, dtype=np.float64) * 255), 0, 255)
    return np.append(c, a).astype(np.uint8)


class MeshBank:
    """Collects geometry per (chunk, material) in world coordinates."""

    def __init__(self, chunk_size: float, valid: set[tuple[int, int]]):
        self.size = chunk_size
        self.valid = valid
        self.parts: dict[tuple[int, int], dict[str, list]] = defaultdict(lambda: defaultdict(list))

    def chunk_of(self, x: float, z: float) -> tuple[int, int]:
        return math.floor(x / self.size), math.floor(z / self.size)

    def add(self, material, pos, faces, normals=None, uvs=None, colors=None, key=None, priority=np.inf) -> None:
        """Add a mesh. With key=None, triangles are split into chunks by centroid.

        priority lets build() drop low-priority pieces (e.g. small buildings)
        when a chunk is over its size budget.
        """
        if len(faces) == 0:
            return
        pos = np.asarray(pos, dtype=np.float64)
        faces = np.asarray(faces, dtype=np.int64)
        if normals is None:
            normals = vertex_normals(pos, faces)
        if key is not None:
            if key in self.valid:
                self.parts[key][material].append((pos, normals, uvs, colors, faces, priority))
            return
        cent = pos[faces].mean(axis=1)
        cx = np.floor(cent[:, 0] / self.size).astype(np.int64)
        cz = np.floor(cent[:, 2] / self.size).astype(np.int64)
        pair = cx * 1_000_003 + cz
        for p in np.unique(pair):
            sel = faces[pair == p]
            k = (int(cx[pair == p][0]), int(cz[pair == p][0]))
            if k not in self.valid:
                continue
            used, inv = np.unique(sel, return_inverse=True)
            self.parts[k][material].append(
                (
                    pos[used],
                    normals[used],
                    None if uvs is None else uvs[used],
                    None if colors is None else colors[used],
                    inv.reshape(-1, 3),
                    priority,
                )
            )

    def build(self, key, origin, min_priority: float = -np.inf) -> dict[str, MeshData]:
        out = {}
        ox, oy, oz = origin
        for mat, items in sorted(self.parts.get(key, {}).items()):
            items = [i for i in items if i[5] >= min_priority]
            if not items:
                continue
            has_uv = all(i[2] is not None for i in items)
            has_col = all(i[3] is not None for i in items)
            pos, nrm, uv, col, idx = [], [], [], [], []
            base = 0
            for p, n, u, c, f, _ in items:
                pos.append(p - (ox, oy, oz))
                nrm.append(n)
                if has_uv:
                    uv.append(u)
                if has_col:
                    col.append(c)
                idx.append(f + base)
                base += len(p)
            out[mat] = MeshData(
                positions=np.concatenate(pos).astype(np.float32),
                normals=np.concatenate(nrm).astype(np.float32),
                indices=np.concatenate(idx),
                uvs=np.concatenate(uv).astype(np.float32) if has_uv else None,
                colors=np.concatenate(col).astype(np.uint8) if has_col else None,
            )
        return out

    def release(self, key) -> None:
        self.parts.pop(key, None)


def sweep(xz, s, nrm, hc, cs, profile, lift=0.0):
    """Sweep a cross-section profile along a centreline.

    xz (n,2) centreline, s (n,) distance along it, nrm (n,2) unit lateral axis
    (pointing right of travel), hc (n,) centre height, cs (n,) cross slope.
    profile is a list of (lateral offset, height above road plane) points,
    ordered left to right across the visible surface. Each profile segment gets
    its own vertices so creases stay sharp.

    Returns positions, faces, normals, uvs. uv = (lateral offset m, distance m).
    """
    n = len(xz)
    prof = np.asarray(profile, dtype=np.float64)
    positions, faces, uvs, normals = [], [], [], []
    base = 0
    for a in range(len(prof) - 1):
        (oa, da), (ob, db) = prof[a], prof[a + 1]
        seg_pos = []
        for o, d in ((oa, da), (ob, db)):
            x = xz[:, 0] + nrm[:, 0] * o
            z = xz[:, 1] + nrm[:, 1] * o
            y = hc + cs * o + d + lift
            seg_pos.append(np.stack([x, y, z], axis=1))
        p = np.concatenate(seg_pos)  # first n = edge a, next n = edge b
        i = np.arange(n - 1)
        f = np.concatenate(
            [np.stack([i, i + n, i + 1], axis=1), np.stack([i + 1, i + n, i + 1 + n], axis=1)]
        )
        # Expected face normal: rotate the profile direction +90 deg in (lateral, up) space.
        do, dd = ob - oa, db - da
        eo, ed = -dd, do
        exp = np.zeros((n, 3))
        exp[:, 0] = nrm[:, 0] * eo
        exp[:, 2] = nrm[:, 1] * eo
        exp[:, 1] = ed
        exp_f = exp[np.concatenate([i, i])]
        f = orient_faces(p, f, exp_f)
        positions.append(p)
        normals.append(vertex_normals(p, f))
        uvs.append(np.stack([np.concatenate([np.full(n, oa), np.full(n, ob)]), np.concatenate([s, s])], axis=1))
        faces.append(f + base)
        base += 2 * n
    pos = np.concatenate(positions)
    return pos, np.concatenate(faces), np.concatenate(normals), np.concatenate(uvs)
