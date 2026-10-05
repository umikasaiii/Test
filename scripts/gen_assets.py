#!/usr/bin/env python3
"""Generates DSLink's touch overlay (RetroArch overlay .cfg + PNGs) and launcher icons. Pure standard library, so
the build needs no image tools. Output: android/assets/overlay/*, android/res/mipmap-*/ic_launcher.png"""
import os
import struct
import sys
import zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

# ---------------------------------------------------------------------------------------------------------- PNG
class Canvas:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = bytearray(w * h * 4)

    def blend(self, x, y, rgba):
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        i = (y * self.w + x) * 4
        r, g, b, a = rgba
        if a >= 255:
            self.px[i:i + 4] = bytes((r, g, b, 255))
            return
        da = self.px[i + 3]
        oa = a + da * (255 - a) // 255
        if oa == 0:
            return
        for k, c in enumerate((r, g, b)):
            self.px[i + k] = (c * a + self.px[i + k] * da * (255 - a) // 255) // oa
        self.px[i + 3] = oa

    def rrect(self, x0, y0, x1, y1, radius, rgba):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                dx = max(x0 + radius - x, 0, x - (x1 - radius - 1))
                dy = max(y0 + radius - y, 0, y - (y1 - radius - 1))
                if dx * dx + dy * dy <= radius * radius:
                    self.blend(x, y, rgba)

    def circle(self, cx, cy, r, rgba):
        self.rrect(cx - r, cy - r, cx + r, cy + r, r, rgba)

    def triangle(self, pts, rgba):
        (x0, y0), (x1, y1), (x2, y2) = pts
        minx, maxx = int(min(x0, x1, x2)), int(max(x0, x1, x2))
        miny, maxy = int(min(y0, y1, y2)), int(max(y0, y1, y2))
        d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        for y in range(miny, maxy + 1):
            for x in range(minx, maxx + 1):
                a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d
                b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d
                if a >= 0 and b >= 0 and 1 - a - b >= 0:
                    self.blend(x, y, rgba)

    def text(self, s, cx, cy, scale, rgba):
        width = len(s) * 6 * scale - scale
        x = cx - width // 2
        y = cy - 7 * scale // 2
        for ch in s:
            glyph = FONT.get(ch)
            if glyph:
                for row, bits in enumerate(glyph):
                    for col in range(5):
                        if bits & (1 << (4 - col)):
                            for sy in range(scale):
                                for sx in range(scale):
                                    self.blend(x + col * scale + sx, y + row * scale + sy, rgba)
            x += 6 * scale

    def png(self, path):
        raw = b"".join(b"\x00" + bytes(self.px[y * self.w * 4:(y + 1) * self.w * 4]) for y in range(self.h))

        def chunk(t, d):
            c = struct.pack(">I", len(d)) + t + d
            return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0)) +
                    chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# 5x7 glyphs (rows top->bottom, 5 bits each)
FONT = {
    "A": [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11], "B": [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
    "C": [0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E], "D": [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
    "E": [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F], "H": [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
    "I": [0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E], "L": [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
    "M": [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11], "N": [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
    "O": [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E], "P": [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
    "R": [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11], "S": [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
    "T": [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04], "U": [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
    "X": [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11], "Y": [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
    "Z": [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F], "K": [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
}

FILL = (30, 34, 44, 150)
EDGE = (255, 255, 255, 190)
GLYPH = (255, 255, 255, 235)


def button(name, label=None, arrow=None, size=(160, 160), pill=False):
    w, h = size
    c = Canvas(w, h)
    rad = h // 2 if pill else w // 5
    c.rrect(2, 2, w - 2, h - 2, rad, EDGE)
    c.rrect(5, 5, w - 5, h - 5, max(rad - 3, 1), FILL)
    if arrow:
        cx, cy, a = w // 2, h // 2, int(min(w, h) * 0.26)
        pts = {"up": [(cx, cy - a), (cx - a, cy + a), (cx + a, cy + a)], "down": [(cx, cy + a), (cx - a, cy - a), (cx + a, cy - a)],
               "left": [(cx - a, cy), (cx + a, cy - a), (cx + a, cy + a)], "right": [(cx + a, cy), (cx - a, cy - a), (cx - a, cy + a)]}[arrow]
        c.triangle(pts, GLYPH)
    if label:
        scale = max(2, min(w // (len(label) * 6 + 2), h // 11))
        c.text(label, w // 2, h // 2, scale, GLYPH)
    c.png(os.path.join(OUT, name + ".png"))


# ---------------------------------------------------------------------------------------------------------- overlay
OUT = os.path.join(ROOT, "android", "assets", "overlay")


def overlay_cfg():
    # (type, label/arrow, shape, cx, cy, w, h) in normalized coordinates of a 9:20 portrait / 20:9 landscape screen.
    # Heights are expressed through 'k' = screen_width / screen_height so buttons stay square on screen.
    names = {}
    lines = []
    specs = []
    for idx, (title, k, items) in enumerate([("portrait", 9 / 20, PORTRAIT), ("landscape", 20 / 9, LANDSCAPE)]):
        lines.append(f'overlay{idx}_name = "{title}"')
        lines.append(f'overlay{idx}_full_screen = true')
        lines.append(f'overlay{idx}_normalized = true')
        lines.append(f'overlay{idx}_range_mod = 1.0')
        lines.append(f'overlay{idx}_alpha_mod = 1.0')
        lines.append(f'overlay{idx}_descs = {len(items)}')
        for d, (rid, cx, cy, fw, shape_pill) in enumerate(items):
            fh = fw * k
            kind = {"mic": "l3", "layout": "r3", "quit": "exit_emulator"}.get(rid, rid)
            lines.append(f'overlay{idx}_desc{d} = "{kind},{cx:.4f},{cy:.4f},rect,{fw / 2:.4f},{fh / 2:.4f}"')
            lines.append(f'overlay{idx}_desc{d}_overlay = "{rid}_{title}.png"')
            specs.append((rid, title, fw, fh, shape_pill))
        lines.append("")
    lines.insert(0, f"overlays = 2")
    lines.insert(1, "")
    return "\n".join(lines) + "\n", specs


# id, center x, center y, width (fraction of screen width), pill
PORTRAIT = [
    ("l", 0.14, 0.700, 0.24, True), ("r", 0.86, 0.700, 0.24, True),
    ("quit", 0.50, 0.700, 0.14, True),
    ("up", 0.22, 0.800, 0.13, False), ("down", 0.22, 0.915, 0.13, False),
    ("left", 0.09, 0.8575, 0.13, False), ("right", 0.35, 0.8575, 0.13, False),
    ("x", 0.78, 0.800, 0.13, False), ("b", 0.78, 0.915, 0.13, False),
    ("y", 0.65, 0.8575, 0.13, False), ("a", 0.91, 0.8575, 0.13, False),
    ("select", 0.41, 0.945, 0.15, True), ("start", 0.59, 0.945, 0.15, True),
    ("mic", 0.50, 0.805, 0.13, True), ("layout", 0.50, 0.875, 0.16, True),
]
LANDSCAPE = [
    ("l", 0.08, 0.10, 0.09, True), ("r", 0.92, 0.10, 0.09, True),
    ("quit", 0.50, 0.06, 0.06, True),
    ("up", 0.10, 0.52, 0.055, False), ("down", 0.10, 0.88, 0.055, False),
    ("left", 0.04, 0.70, 0.055, False), ("right", 0.16, 0.70, 0.055, False),
    ("x", 0.90, 0.52, 0.055, False), ("b", 0.90, 0.88, 0.055, False),
    ("y", 0.84, 0.70, 0.055, False), ("a", 0.96, 0.70, 0.055, False),
    ("select", 0.45, 0.94, 0.07, True), ("start", 0.55, 0.94, 0.07, True),
    ("mic", 0.04, 0.10, 0.05, True), ("layout", 0.96, 0.10, 0.05, True),
]
LABELS = {"l": "L", "r": "R", "a": "A", "b": "B", "x": "X", "y": "Y", "select": "SELECT", "start": "START",
          "mic": "MIC", "layout": "DS", "quit": "EXIT"}


def gen_overlay():
    os.makedirs(OUT, exist_ok=True)
    cfg, specs = overlay_cfg()
    with open(os.path.join(OUT, "dslink.cfg"), "w") as f:
        f.write(cfg)
    for rid, title, fw, fh, pill in specs:
        px_w = 160 if not pill else 240
        px_h = 160 if not pill else 96
        arrow = rid if rid in ("up", "down", "left", "right") else None
        button(f"{rid}_{title}", label=LABELS.get(rid), arrow=arrow, size=(px_w, px_h), pill=pill)


# ---------------------------------------------------------------------------------------------------------- icon
def gen_icons():
    for dpi, size in (("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)):
        c = Canvas(size, size)
        c.rrect(0, 0, size, size, size // 5, (79, 140, 255, 255))
        s = size
        c.rrect(s * 0.18, s * 0.14, s * 0.82, s * 0.46, s // 14, (15, 17, 21, 255))
        c.rrect(s * 0.18, s * 0.54, s * 0.82, s * 0.86, s // 14, (15, 17, 21, 255))
        c.text("DS", int(s * 0.5), int(s * 0.30), max(1, s // 22), (242, 244, 248, 255))
        c.circle(int(s * 0.5), int(s * 0.70), max(2, s // 12), (79, 140, 255, 255))
        c.png(os.path.join(ROOT, "android", "res", f"mipmap-{dpi}", "ic_launcher.png"))


if __name__ == "__main__":
    gen_overlay()
    gen_icons()
    print("generated overlay + icons under", os.path.join(ROOT, "android"))
