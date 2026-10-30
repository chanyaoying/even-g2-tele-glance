import io

import pytest

from app.services.imaging import ImagingError, prepare_glasses_image

Image = pytest.importorskip("PIL.Image")


def jpeg(size, color=(120, 160, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_every_photo_is_letterboxed_onto_the_full_container_so_the_host_never_scales_it():
    for size in [(1600, 1600), (1600, 900), (900, 1600), (8, 8)]:
        png, width, height = prepare_glasses_image(jpeg(size))
        assert (width, height) == (288, 144)
        decoded = Image.open(io.BytesIO(png))
        assert decoded.size == (288, 144) and decoded.mode == "L"


def test_picture_is_whole_not_cropped_and_keeps_its_aspect_ratio():
    # A white square on black: the visible part must stay square and centred (144x144), with black bars either side.
    buffer = io.BytesIO()
    Image.new("L", (1000, 1000), 255).save(buffer, format="PNG")
    png, _, _ = prepare_glasses_image(buffer.getvalue())
    decoded = Image.open(io.BytesIO(png))
    assert decoded.getpixel((144, 72)) > 200
    assert decoded.getpixel((2, 72)) == 0 and decoded.getpixel((285, 72)) == 0


def test_greyscale_is_snapped_to_sixteen_levels():
    gradient = Image.linear_gradient("L").resize((256, 64))
    buffer = io.BytesIO()
    gradient.save(buffer, format="PNG")

    png, _, _ = prepare_glasses_image(buffer.getvalue())

    levels = {value for _, value in Image.open(io.BytesIO(png)).getcolors(maxcolors=256)}
    assert len(levels) <= 16


def test_bad_input_raises_a_clean_error():
    with pytest.raises(ImagingError):
        prepare_glasses_image(b"not an image")
    with pytest.raises(ImagingError):
        prepare_glasses_image(b"")
