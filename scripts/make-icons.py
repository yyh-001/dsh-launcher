from PIL import Image, ImageDraw
import struct
import io
import os

ROOT = r"C:\Users\yyh\Desktop\dsh\strategies\assets"
SRC = Image.open(os.path.join(ROOT, "icon.png")).convert("RGBA")
W, H = SRC.size

whale = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sp = SRC.load()
wp = whale.load()
for y in range(H):
    for x in range(W):
        r, g, b, a = sp[x, y]
        if a > 0:
            wp[x, y] = (0, 0, 0, a)


def fit(size, base):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    radius = max(3, round(size * 0.22))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=(255, 255, 255, 255))
    side = int(size * 0.78)
    logo = base.resize((side, side), Image.Resampling.LANCZOS)
    img.alpha_composite(logo, ((size - side) // 2, (size - side) // 2))
    return img


def bmp_dib(img):
    img = img.convert("RGBA")
    w, h = img.size
    xor = bytearray()
    and_row_bytes = ((w + 31) // 32) * 4
    and_mask = bytearray()
    px = img.load()
    for y in range(h - 1, -1, -1):
        and_row = bytearray(and_row_bytes)
        for x in range(w):
            r, g, b, a = px[x, y]
            xor.extend((b, g, r, a))
            if a < 32:
                and_row[x // 8] |= 0x80 >> (x % 8)
        and_mask.extend(and_row)
    header = struct.pack("<IIIHHIIIIII", 40, w, h * 2, 1, 32, 0, len(xor) + len(and_mask), 0, 0, 0, 0)
    return header + xor + and_mask


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def write_ico(path, sizes, png_size=None):
    entries = []
    for sz in sizes:
        frame = fit(sz, whale)
        blob = png_bytes(frame) if png_size and sz == png_size else bmp_dib(frame)
        entries.append((sz, sz, blob))
    count = len(entries)
    offset = 6 + 16 * count
    header = struct.pack("<HHH", 0, 1, count)
    dirents = b""
    payload = b""
    for w, h, blob in entries:
        dirents += struct.pack(
            "<BBBBHHII",
            w if w < 256 else 0,
            h if h < 256 else 0,
            0, 0, 1, 32, len(blob), offset,
        )
        payload += blob
        offset += len(blob)
    with open(path, "wb") as f:
        f.write(header + dirents + payload)


preview = fit(256, whale)
preview.save(os.path.join(ROOT, "dsh-preview.png"))
write_ico(os.path.join(ROOT, "dsh.ico"), [16, 32, 48, 64, 256], png_size=256)
write_ico(os.path.join(ROOT, "icon.ico"), [16, 32, 48, 64, 256], png_size=256)
write_ico(os.path.join(ROOT, "tray.ico"), [16, 32])
for name in ("dsh.ico", "icon.ico", "tray.ico"):
    print(name, os.path.getsize(os.path.join(ROOT, name)))
