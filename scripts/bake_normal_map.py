"""Bake the inputs of the normal-map mode from the path tracer's scene.

The normal-map renderer has no geometry. Everything it knows about the scene
comes from the images written here, all viewed from the path tracer's default
camera (mouse centered, no WASD/scroll offset):

  normal.png       front-most surface normal (bubbles included), view space
  normal_back.png  normal of the surface seen *through* the bubbles
  albedo.png       sRGB albedo of that background surface
  mask.png         bubble coverage (anti-aliased)

Normals use the common OpenGL tangent/view convention: +X right, +Y up,
+Z toward the viewer, encoded as rgb = n * 0.5 + 0.5. A surface facing the
camera is therefore (128, 128, 255).

Soap films have air on both sides (IOR 1 -> 1), so a transmitted ray leaves a
bubble undeflected. Tracing the scene without the spheres gives exactly what is
visible through them.

Usage: python3 scripts/bake_normal_map.py [size]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
SUPERSAMPLE = 3  # per axis
OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "normalmap"

# Must match intersectScene() in src/shader/path_trace.frag.
SPHERES = [
    ((-0.95, 1.10, 0.0), 0.95),
    ((0.9, 0.85, 0.25), 0.66),
    ((0.35, 2.05, -0.65), 0.46),
]
# Albedos are chosen for a single point light, so they are brighter than the
# path tracer's (which is lit by large emissive panels plus interreflection).
# The back wall stays fairly dark so the thin-film colors read against it.
FLOOR = (0.40, 0.37, 0.33)
SIDE = (0.30, 0.30, 0.32)
BACK = (0.05, 0.05, 0.055)
CEIL = (0.20, 0.20, 0.20)
# (point, normal, boundMin, boundMax, axisU, axisV, albedo)
PLANES = [
    ((0, 0, 0), (0, 1, 0), (-4, -4), (4, 4), 0, 2, FLOOR),
    ((0, 5, 0), (0, -1, 0), (-4, -4), (4, 4), 0, 2, CEIL),
    ((-4, 0, 0), (1, 0, 0), (0, -4), (5, 4), 1, 2, SIDE),
    ((4, 0, 0), (-1, 0, 0), (0, -4), (5, 4), 1, 2, SIDE),
    ((0, 0, -4), (0, 0, 1), (-4, 0), (4, 5), 0, 1, BACK),
    ((0, 0, 4), (0, 0, -1), (-4, 0), (4, 5), 0, 1, SIDE),
]


def normalize(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def camera():
    """makeCameraRay() with u_mouse = (0.5, 0.5) and zero offsets."""
    yaw = 0.0
    pitch = 0.5 * (0.1 + 0.38)
    target = np.array([0.0, 0.85, -0.2])
    cam_pos = target + np.array([
        np.sin(yaw) * np.cos(pitch),
        np.sin(pitch) * 0.9,
        np.cos(yaw) * np.cos(pitch),
    ]) * 3.7
    f = normalize(target - cam_pos)
    r = normalize(np.cross(f, [0.0, 1.0, 0.0]))
    u = np.cross(r, f)
    return cam_pos, r, u, f


def trace(origin, dirs, include_spheres):
    n = dirs.shape[0]
    t_best = np.full(n, np.inf)
    normal = np.zeros((n, 3))
    albedo = np.zeros((n, 3))
    is_bubble = np.zeros(n, dtype=bool)

    for point, pn, bmin, bmax, au, av, alb in PLANES:
        pn = np.array(pn, float)
        denom = dirs @ pn
        with np.errstate(divide="ignore", invalid="ignore"):
            t = ((np.array(point, float) - origin) @ pn) / denom
        pos = origin + t[:, None] * dirs
        ok = (np.abs(denom) > 1e-5) & (t > 1e-3) & (t < t_best)
        ok &= (pos[:, au] >= bmin[0]) & (pos[:, au] <= bmax[0])
        ok &= (pos[:, av] >= bmin[1]) & (pos[:, av] <= bmax[1])
        t_best[ok] = t[ok]
        normal[ok] = np.where(denom[ok, None] < 0, pn, -pn)
        albedo[ok] = alb
        is_bubble[ok] = False

    if include_spheres:
        for center, radius in SPHERES:
            oc = origin - np.array(center)
            b = dirs @ oc
            h = b * b - (oc @ oc - radius * radius)
            t = -b - np.sqrt(np.maximum(h, 0.0))
            ok = (h >= 0) & (t > 1e-3) & (t < t_best)
            t_best[ok] = t[ok]
            normal[ok] = normalize(origin + t[ok, None] * dirs[ok] - center)
            albedo[ok] = 0.0
            is_bubble[ok] = True

    return normal, albedo, is_bubble


def to_view(normal_world, r, u, f):
    # Camera looks along +f; view space has +Z toward the viewer.
    return np.stack([normal_world @ r, normal_world @ u, -(normal_world @ f)], axis=-1)


def encode_normal(n):
    n = normalize(n)
    return np.clip(np.round((n * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)


def linear_to_srgb(c):
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def main():
    cam_pos, r, u, f = camera()
    s = SIZE * SUPERSAMPLE
    # Row 0 is the top of the image; sampleUv.y = 1 at the top.
    xs = (np.arange(s) + 0.5) / s * 2.0 - 1.0
    ys = 1.0 - (np.arange(s) + 0.5) / s * 2.0
    sx, sy = np.meshgrid(xs, ys)
    dirs = normalize(sx[..., None] * r + sy[..., None] * u + 1.55 * f).reshape(-1, 3)

    front_n, _, bubble = trace(cam_pos, dirs, include_spheres=True)
    back_n, back_albedo, _ = trace(cam_pos, dirs, include_spheres=False)

    def downsample(a):
        a = a.reshape(SIZE, SUPERSAMPLE, SIZE, SUPERSAMPLE, -1)
        return a.mean(axis=(1, 3))

    front_view = downsample(to_view(front_n, r, u, f))
    back_view = downsample(to_view(back_n, r, u, f))
    albedo = downsample(back_albedo)
    mask = downsample(bubble.astype(float)[:, None])[..., 0]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    Image.fromarray(encode_normal(front_view), "RGB").save(OUT_DIR / "normal.png")
    Image.fromarray(encode_normal(back_view), "RGB").save(OUT_DIR / "normal_back.png")
    albedo8 = np.round(linear_to_srgb(albedo) * 255.0).astype(np.uint8)
    Image.fromarray(albedo8, "RGB").save(OUT_DIR / "albedo.png")
    Image.fromarray(np.round(mask * 255.0).astype(np.uint8), "L").save(OUT_DIR / "mask.png")
    print(f"wrote {SIZE}x{SIZE} maps to {OUT_DIR}")


if __name__ == "__main__":
    main()
