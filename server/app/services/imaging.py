"""Fit photos into the Even G2 image container: exactly 288x120, letterboxed, greyscale, 16 levels."""

import io
import logging
import warnings

MAX_SOURCE_BYTES = 12 * 1024 * 1024
# A small file can still declare a huge canvas (decompression bomb); refuse anything above ~16 megapixels.
MAX_SOURCE_PIXELS = 16_000_000
logger = logging.getLogger(__name__)


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

    Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS
    try:
        with warnings.catch_warnings():
            # Pillow only warns between MAX_IMAGE_PIXELS and twice that; treat the warning as a refusal too.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.width * source.height > MAX_SOURCE_PIXELS:
                    raise ImagingError("image is too large")
                # JPEG can decode at 1/2..1/8 scale directly: far less memory and time for big photos.
                # The box is square because an EXIF rotation may swap width and height.
                side = max(max_width, max_height)
                source.draft("L", (side, side))
                oriented = ImageOps.exif_transpose(source)
                transparent = oriented.mode in ("RGBA", "LA", "PA") or "transparency" in oriented.info
                if transparent or oriented.mode == "P":
                    # Palette images only resize with nearest-neighbour; expand them first.
                    oriented = oriented.convert("RGBA" if transparent else "RGB")
                # Shrink before the per-pixel work below, which then touches ~35k pixels instead of millions.
                oriented.thumbnail((max_width, max_height), Image.LANCZOS)
                if transparent:
                    # Stickers are cut-outs: put them on black (the display's "off") instead of letting the
                    # colour hidden under transparent pixels decide the background.
                    backdrop = Image.new("RGBA", oriented.size, (0, 0, 0, 255))
                    image = Image.alpha_composite(backdrop, oriented).convert("L")
                else:
                    image = oriented.convert("L")
    except ImagingError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ImagingError("image is too large") from exc
    except Exception as exc:  # Pillow raises many unrelated types for bad input
        logger.info("image decode failed: %s: %s", exc.__class__.__name__, exc)
        raise ImagingError("image could not be decoded") from exc

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
