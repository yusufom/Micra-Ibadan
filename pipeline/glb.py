"""Minimal glTF 2.0 binary (.glb) writer.

Each chunk becomes one root node translated to the chunk's world origin, with
one child mesh per material. Vertex data is float32 relative to the chunk
origin; vertex colours are normalised uint8 RGBA; indices are uint16 or uint32.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass

import numpy as np

# Suggested look per material id. The game can swap these for textured
# materials by name; the names are the contract.
MATERIALS: dict[str, dict] = {
    "terrain": {"color": [1, 1, 1, 1], "roughness": 1.0},
    "water": {"color": [0.22, 0.30, 0.24, 0.9], "roughness": 0.15, "blend": True},
    "road_paved": {"color": [0.27, 0.27, 0.28, 1], "roughness": 0.9},
    "road_unpaved": {"color": [0.60, 0.36, 0.22, 1], "roughness": 1.0},
    "drain": {"color": [1, 1, 1, 1], "roughness": 0.95},
    "plaster": {"color": [1, 1, 1, 1], "roughness": 0.9},
    "painted": {"color": [1, 1, 1, 1], "roughness": 0.8},
    "unfinished_block": {"color": [1, 1, 1, 1], "roughness": 1.0},
    "mud_brick": {"color": [1, 1, 1, 1], "roughness": 1.0},
    "glass": {"color": [1, 1, 1, 1], "roughness": 0.1, "metallic": 0.6},
    "roof_zinc_rusted": {"color": [1, 1, 1, 1], "roughness": 0.8, "metallic": 0.3, "double": True},
    "roof_zinc": {"color": [1, 1, 1, 1], "roughness": 0.5, "metallic": 0.7, "double": True},
    "roof_concrete": {"color": [1, 1, 1, 1], "roughness": 0.95},
}

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963
FLOAT = 5126
UNSIGNED_BYTE = 5121
UNSIGNED_SHORT = 5123
UNSIGNED_INT = 5125


@dataclass
class MeshData:
    positions: np.ndarray  # (n, 3) float32, chunk-local
    normals: np.ndarray  # (n, 3) float32
    indices: np.ndarray  # (m, 3) int
    uvs: np.ndarray | None = None  # (n, 2) float32
    colors: np.ndarray | None = None  # (n, 4) uint8


def encode_glb(name: str, translation: tuple[float, float, float], meshes: dict[str, MeshData], extras: dict | None = None) -> bytes:
    bin_parts: list[bytes] = []
    offset = 0
    buffer_views: list[dict] = []
    accessors: list[dict] = []

    def add_view(data: bytes, target: int) -> int:
        nonlocal offset
        pad = (-len(data)) % 4
        buffer_views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(data), "target": target})
        bin_parts.append(data + b"\0" * pad)
        offset += len(data) + pad
        return len(buffer_views) - 1

    def add_accessor(arr: np.ndarray, ctype: int, atype: str, target: int, normalized=False, minmax=False) -> int:
        view = add_view(np.ascontiguousarray(arr).tobytes(), target)
        acc = {"bufferView": view, "componentType": ctype, "count": int(arr.shape[0]), "type": atype}
        if normalized:
            acc["normalized"] = True
        if minmax:
            acc["min"] = arr.min(axis=0).tolist()
            acc["max"] = arr.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    materials = []
    mat_index: dict[str, int] = {}
    gl_meshes = []
    child_nodes = []
    for mat_name, m in meshes.items():
        if len(m.indices) == 0:
            continue
        if mat_name not in mat_index:
            spec = MATERIALS.get(mat_name, {"color": [1, 1, 1, 1]})
            mat = {
                "name": mat_name,
                "pbrMetallicRoughness": {
                    "baseColorFactor": spec["color"],
                    "metallicFactor": spec.get("metallic", 0.0),
                    "roughnessFactor": spec.get("roughness", 1.0),
                },
            }
            if spec.get("blend"):
                mat["alphaMode"] = "BLEND"
            if spec.get("double"):
                mat["doubleSided"] = True
            mat_index[mat_name] = len(materials)
            materials.append(mat)

        attrs = {
            "POSITION": add_accessor(m.positions.astype(np.float32), FLOAT, "VEC3", ARRAY_BUFFER, minmax=True),
            "NORMAL": add_accessor(m.normals.astype(np.float32), FLOAT, "VEC3", ARRAY_BUFFER),
        }
        if m.uvs is not None:
            attrs["TEXCOORD_0"] = add_accessor(m.uvs.astype(np.float32), FLOAT, "VEC2", ARRAY_BUFFER)
        if m.colors is not None:
            attrs["COLOR_0"] = add_accessor(m.colors.astype(np.uint8), UNSIGNED_BYTE, "VEC4", ARRAY_BUFFER, normalized=True)
        n_verts = len(m.positions)
        if n_verts < 65536:
            idx = add_accessor(m.indices.astype(np.uint16).ravel(), UNSIGNED_SHORT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        else:
            idx = add_accessor(m.indices.astype(np.uint32).ravel(), UNSIGNED_INT, "SCALAR", ELEMENT_ARRAY_BUFFER)
        gl_meshes.append({"name": mat_name, "primitives": [{"attributes": attrs, "indices": idx, "material": mat_index[mat_name]}]})
        child_nodes.append({"name": mat_name, "mesh": len(gl_meshes) - 1})

    nodes = [{"name": name, "translation": [float(t) for t in translation], "children": list(range(1, len(child_nodes) + 1))}]
    nodes += child_nodes
    if extras:
        nodes[0]["extras"] = extras

    binary = b"".join(bin_parts)
    gltf = {
        "asset": {"version": "2.0", "generator": "micra-ibadan pipeline"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": nodes,
        "meshes": gl_meshes,
        "materials": materials,
        "accessors": accessors,
        "bufferViews": buffer_views,
        "buffers": [{"byteLength": len(binary)}],
    }
    if not gl_meshes:
        for k in ("meshes", "materials", "accessors", "bufferViews", "buffers"):
            gltf.pop(k)
        nodes[0].pop("children")
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((-len(js)) % 4)

    out = bytearray()
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    out += struct.pack("<III", 0x46546C67, 2, total)
    out += struct.pack("<II", len(js), 0x4E4F534A) + js
    if binary:
        out += struct.pack("<II", len(binary), 0x004E4942) + binary
    return bytes(out)
