# Slices a large CJK font into small woff2 files, each with its own
# unicode-range (the way Google Fonts serves CJK), so a page downloads
# only the slices holding the characters it shows. Common characters
# (GB2312 level 1, then level 2) are grouped together, so a typical
# title needs only a few slices; the rest go by code point.
#   python3 scripts/slice-font.py <font.ttf> <family> <out-name>
# writes static/fonts/<out-name>/*.woff2 and static/fonts/<out-name>.css.
# Needs fontTools and brotli (pip install fonttools brotli).
import os
import shutil
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

SLICE = 300  # characters per slice

src, family, name = sys.argv[1:4]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir = os.path.join(root, "static", "fonts", name)
shutil.rmtree(out_dir, ignore_errors=True)
os.makedirs(out_dir)

cmap = set(TTFont(src).getBestCmap())


def gb2312_level(first, last):
    chars = []
    for hi in range(first, last + 1):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(ord(bytes([hi, lo]).decode("gb2312")))
            except UnicodeDecodeError:
                pass
    return [c for c in chars if c in cmap]


# Punctuation and symbols first (one slice), then common characters, then
# everything else. Latin is left out: titles set it in Source Serif 4.
punct = [c for c in sorted(cmap) if 0x2010 <= c < 0x2030 or 0x3000 <= c < 0x3040 or 0xFF00 <= c < 0xFF70]
level1 = gb2312_level(0xB0, 0xD7)
level2 = gb2312_level(0xD8, 0xF7)
seen = set(punct) | set(level1) | set(level2)
rest = [c for c in sorted(cmap) if c not in seen and c >= 0x2000]

groups = [punct]
for chars in (level1, level2, rest):
    groups += [chars[i:i + SLICE] for i in range(0, len(chars), SLICE)]


def ranges(chars):
    chars = sorted(chars)
    out, start = [], chars[0]
    for prev, cur in zip(chars, chars[1:] + [None]):
        if cur != prev + 1:
            out.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
            start = cur
    return ", ".join(out)


options = subset.Options()
options.flavor = "woff2"
options.hinting = False
options.desubroutinize = True
options.name_IDs = []
options.layout_features = ["*"]

css = [f"/* {family}, sliced by scripts/slice-font.py — generated, do not edit. */"]
for i, chars in enumerate(groups):
    font = TTFont(src)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=chars)
    subsetter.subset(font)
    file = f"{i:03d}.woff2"
    font.flavor = "woff2"
    font.save(os.path.join(out_dir, file))
    css.append(
        f'@font-face{{font-family:"{family}";font-display:swap;'
        f'src:url("{name}/{file}") format("woff2");unicode-range:{ranges(chars)}}}'
    )

with open(os.path.join(root, "static", "fonts", f"{name}.css"), "w") as f:
    f.write("\n".join(css) + "\n")
print(f"{len(groups)} slices in static/fonts/{name}/")
