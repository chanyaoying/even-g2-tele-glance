"""Fit photos into the Even G2 image container: exactly 288x120, letterboxed, greyscale, 16 levels."""

import io

MAX_SOURCE_BYTES = 12 * 1024 * 1024


class ImagingError(RuntimeError):
    pass


def prepare_glasses_image(raw: bytes, max_width: int = 288, max_height: int = 120, levels: int = 16) -> tuple[bytes, int, int]:
    """Return (png_bytes, width, height) fitted inside max_width x max_height."""
    if not raw:
        raise ImagingError("image is empty")
    if len(raw) > MAX_SOURCE_BYTES:
        raise ImagingError("image is too large")
    try:
        from PIL import Image, ImageOps
    except ImportError as exc:
        raise ImagingError("Pillow is not installed. Install server requirements.") from exc

    try:
        with Image.open(io.BytesIO(raw)) as source:
            oriented = ImageOps.exif_transpose(source)
            if oriented.mode in ("RGBA", "LA", "PA") or "transparency" in oriented.info:
                # Stickers are cut-outs: put them on black (the display's "off") instead of letting the
                # colour hidden under transparent pixels decide the background.
                rgba = oriented.convert("RGBA")
                backdrop = Image.new("RGBA", rgba.size, (0, 0, 0, 255))
                image = Image.alpha_composite(backdrop, rgba).convert("L")
            else:
                image = oriented.convert("L")
    except Exception as exc:  # Pillow raises many unrelated types for bad input
        raise ImagingError(f"image could not be decoded: {exc}") from exc

    image.thumbnail((max_width, max_height), Image.LANCZOS)
    image = ImageOps.autocontrast(image)
    # The glasses show 4-bit grey: snap to 16 levels ourselves so the result is predictable and compresses well.
    step = 255 / (levels - 1)
    image = image.point([round(round(value / step) * step) for value in range(256)])
    # The image container is always max_width x max_height and the host stretches a smaller bitmap to
    # fill it (zooming/cropping the picture). Letterbox onto a full-size black canvas so nothing is scaled.
    canvas = Image.new("L", (max_width, max_height), 0)
    canvas.paste(image, ((max_width - image.width) // 2, (max_height - image.height) // 2))
    image = canvas
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue(), image.width, image.height
