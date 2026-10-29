import io

import pytest

from app.services.imaging import ImagingError, prepare_glasses_image

Image = pytest.importorskip("PIL.Image")


def jpeg(size, color=(120, 160, 200)):
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format="JPEG")
    return buffer.getvalue()


def test_large_photo_is_fitted_inside_the_glasses_limit_keeping_aspect_ratio():
    png, width, height = prepare_glasses_image(jpeg((1600, 1600)))

    assert (width, height) == (144, 144)
    assert Image.open(io.BytesIO(png)).mode == "L"


def test_greyscale_is_snapped_to_sixteen_levels():
    gradient = Image.linear_gradient("L").resize((256, 64))
    buffer = io.BytesIO()
    gradient.save(buffer, format="PNG")

    png, _, _ = prepare_glasses_image(buffer.getvalue())

    levels = {value for _, value in Image.open(io.BytesIO(png)).getcolors(maxcolors=256)}
    assert len(levels) <= 16


def test_tiny_images_are_padded_to_the_minimum_container_size():
    _, width, height = prepare_glasses_image(jpeg((8, 8)))

    assert width >= 20 and height >= 20


def test_bad_input_raises_a_clean_error():
    with pytest.raises(ImagingError):
        prepare_glasses_image(b"not an image")
    with pytest.raises(ImagingError):
        prepare_glasses_image(b"")
