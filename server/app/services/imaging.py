"""Shrink photos to what the Even G2 image container can show: at most 288x144, greyscale, 16 levels."""

import io

MAX_SOURCE_BYTES = 12 * 1024 * 1024
MIN_SIDE = 20  # the glasses reject image containers smaller than 20x20


class ImagingError(RuntimeError):
    pass


def prepare_glasses_image(raw: bytes, max_width: int = 288, max_height: int = 144, levels: int = 16) -> tuple[bytes, int, int]:
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
            image = ImageOps.exif_transpose(source).convert("L")
    except Exception as exc:  # Pillow raises many unrelated types for bad input
        raise ImagingError(f"image could not be decoded: {exc}") from exc

    image.thumbnail((max_width, max_height), Image.LANCZOS)
    image = ImageOps.autocontrast(image)
    # The glasses show 4-bit grey: snap to 16 levels ourselves so the result is predictable and compresses well.
    step = 255 / (levels - 1)
    image = image.point([round(round(value / step) * step) for value in range(256)])
    if image.width < MIN_SIDE or image.height < MIN_SIDE:
        canvas = Image.new("L", (max(MIN_SIDE, image.width), max(MIN_SIDE, image.height)), 0)
        canvas.paste(image, ((canvas.width - image.width) // 2, (canvas.height - image.height) // 2))
        image = canvas
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue(), image.width, image.height
