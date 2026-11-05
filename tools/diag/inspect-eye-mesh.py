import json
import struct
import sys

PATH = r"D:/aa3dpet-app/CH0335.glb"

data = open(PATH, "rb").read()
magic, ver, length = struct.unpack("<III", data[:12])
off = 12
chunks = []
while off < length:
    clen, ctype = struct.unpack("<II", data[off : off + 8])
    chunks.append((ctype, data[off + 8 : off + 8 + clen]))
    off += 8 + clen
gltf = json.loads(chunks[0][1].decode("utf-8"))
bin_chunk = chunks[1][1]

accessors = gltf["accessors"]
buffer_views = gltf["bufferViews"]
meshes = gltf["meshes"]
materials = gltf["materials"]
nodes = gltf["nodes"]
skins = gltf.get("skins", [])


def acc_data(index):
    acc = accessors[index]
    bv = buffer_views[acc["bufferView"]]
    start = bv.get("byteOffset", 0) + acc.get("byteOffset", 0)
    count = acc["count"]
    comp_type = acc["componentType"]
    type_ = acc["type"]
    comp_size = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[comp_type]
    num_comp = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}[type_]
    fmt = {5120: "b", 5121: "B", 5122: "h", 5123: "H", 5125: "I", 5126: "f"}[comp_type]
    stride = bv.get("byteStride") or comp_size * num_comp
    out = []
    for i in range(count):
        base = start + i * stride
        vals = struct.unpack_from("<" + fmt * num_comp, bin_chunk, base)
        out.append(vals if num_comp > 1 else vals[0])
    return out


print("== nodes with eye in name ==")
for i, n in enumerate(nodes):
    name = n.get("name", "")
    if "eye" in name.lower():
        print(i, name, "mesh=", n.get("mesh"), "skin=", n.get("skin"), "children=", n.get("children"))

print("\n== meshes ==")
for mi, mesh in enumerate(meshes):
    for pi, prim in enumerate(mesh["primitives"]):
        mat = materials[prim["material"]]["name"] if "material" in prim else "-"
        pos = acc_data(prim["attributes"]["POSITION"])
        xs = [p[0] for p in pos]
        ys = [p[1] for p in pos]
        zs = [p[2] for p in pos]
        has_skin = "JOINTS_0" in prim["attributes"]
        print(
            f"mesh[{mi}] {mesh.get('name')} prim{pi} mat={mat} verts={len(pos)} "
            f"skin={has_skin} x[{min(xs):.5f},{max(xs):.5f}] y[{min(ys):.5f},{max(ys):.5f}] z[{min(zs):.5f},{max(zs):.5f}]"
        )
        if "JOINTS_0" in prim["attributes"]:
            joints = acc_data(prim["attributes"]["JOINTS_0"])
            uniq = sorted({j for js in joints for j in js})
            names = []
            for j in uniq[:12]:
                node = skins[0]["joints"][j]
                names.append(nodes[node].get("name", str(node)))
            print("   joints:", uniq[:12], names)
