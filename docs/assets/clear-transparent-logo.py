#!/usr/bin/env -S uv run --script
# requires-python = ">=3.12"
# /// script
# dependencies = ["Pillow"]
# ///

# Removes purple/lavender pixels connected to ANY transparent pixel
# (including internal transparent cutouts/holes), while preserving
# purple pixels completely surrounded by opaque artwork.

import argparse
import colorsys
from collections import deque
from PIL import Image


def parse_args():
    parser = argparse.ArgumentParser(
        description="Removes purple fringes connected to any transparent regions (including internal holes)."
    )
    parser.add_argument("input", help="Path to the input image")
    parser.add_argument("output", help="Path to save the output image")
    return parser.parse_args()


def is_purple(r, g, b, a):
    if a == 0:
        return False

    hue, sat, val = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    hue_deg = hue * 360
    return 240 <= hue_deg <= 330 and sat > 0.08 and val > 0.15


def main():
    args = parse_args()

    im = Image.open(args.input).convert("RGBA")
    px = im.load()
    w, h = im.size

    q = deque()
    seen = set()

    # Seed the queue with ALL transparent pixels across the entire canvas
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                q.append((x, y))
                seen.add((x, y))

    # Flood-fill outwards from every transparent pixel into adjacent purple pixels
    while q:
        x, y = q.popleft()

        for nx, ny in (
            (x - 1, y), (x + 1, y),
            (x, y - 1), (x, y + 1),
            (x - 1, y - 1), (x + 1, y - 1),
            (x - 1, y + 1), (x + 1, y + 1),
        ):
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            if (nx, ny) in seen:
                continue

            r, g, b, a = px[nx, ny]

            if a == 0 or is_purple(r, g, b, a):
                seen.add((nx, ny))
                q.append((nx, ny))

                if a != 0:
                    px[nx, ny] = (r, g, b, 0)

    im.save(args.output)


if __name__ == "__main__":
    main()
