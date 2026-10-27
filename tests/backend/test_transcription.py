import io
import types
import wave
from unittest.mock import MagicMock, patch

import pytest

from app.config import Settings
from app.models import TranscriptionResponse
from app.services.transcription import (
    TranscriptionServiceError,
    WhisperTranscriptionService,
)


def make_tiny_wav(sample_rate: int = 16000, duration_ms: int = 500) -> bytes:
    """Non-silent WAV with a 500 Hz tone at 25% amplitude (RMS ≈ 5800)."""
    import math
    import struct
    num_samples = sample_rate * duration_ms // 1000
    freq = 500
    amplitude = 8192  # 25% of 32767
    pcm = b"".join(
        struct.pack("<h", int(amplitude * math.sin(2 * math.pi * freq * i / sample_rate)))
        for i in range(num_samples)
    )
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


def fake_info(**kwargs):
    """Simple namespace so Pydantic sees None, not a MagicMock."""
    info = types.SimpleNamespace(language=None, duration=None)
    for k, v in kwargs.items():
        setattr(info, k, v)
    return info

@pytest.mark.asyncio
async def test_transcribe_wav_rejects_silent_audio():
    service = WhisperTranscriptionService(settings=Settings())
    # Create a valid WAV with all-zero PCM samples
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * 8000)  # 0.5s of silence
    silent = buf.getvalue()
    with pytest.raises(TranscriptionServiceError, match="silent"):
        await service.transcribe_wav(silent)


@pytest.mark.asyncio
async def test_transcribe_wav_rejects_empty_segments():
    service = WhisperTranscriptionService(settings=Settings())
    seg = MagicMock()
    seg.text = "   "
    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg], fake_info())
        load_mock.return_value = fake_model
        with pytest.raises(TranscriptionServiceError, match="no speech"):
            await service.transcribe_wav(make_tiny_wav())


@pytest.mark.asyncio
async def test_transcribe_wav_rejects_empty_audio():
    service = WhisperTranscriptionService(settings=Settings())
    with pytest.raises(TranscriptionServiceError, match="empty"):
        await service.transcribe_wav(b"")


@pytest.mark.asyncio
async def test_transcribe_wav_builds_response_from_segments():
    service = WhisperTranscriptionService(settings=Settings())

    seg = MagicMock()
    seg.text = "hello world"

    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg], fake_info(language="en", duration=2.5))
        load_mock.return_value = fake_model

        result = await service.transcribe_wav(make_tiny_wav(), language="en")

    assert result.text == "hello world"
    assert result.language == "en"
    assert result.duration_seconds == 2.5


@pytest.mark.asyncio
async def test_transcribe_wav_joins_multiple_segments():
    service = WhisperTranscriptionService(settings=Settings())

    seg_a = MagicMock()
    seg_a.text = "first "
    seg_b = MagicMock()
    seg_b.text = "second"

    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg_a, seg_b], fake_info())
        load_mock.return_value = fake_model

        result = await service.transcribe_wav(make_tiny_wav())

    assert result.text == "first second"


@pytest.mark.asyncio
async def test_transcribe_wav_strips_segment_whitespace():
    service = WhisperTranscriptionService(settings=Settings())

    seg = MagicMock()
    seg.text = "  padded  "

    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg], fake_info())
        load_mock.return_value = fake_model

        result = await service.transcribe_wav(make_tiny_wav())

    assert result.text == "padded"


@pytest.mark.asyncio
async def test_transcribe_wav_passes_language_override():
    service = WhisperTranscriptionService(settings=Settings())

    seg = MagicMock()
    seg.text = "hola"

    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg], fake_info())
        load_mock.return_value = fake_model

        result = await service.transcribe_wav(make_tiny_wav(), language="es")

    assert result.text == "hola"
    _, kwargs = fake_model.transcribe.call_args
    assert kwargs["language"] == "es"


@pytest.mark.asyncio
async def test_transcribe_wav_passes_decoded_samples_not_a_path():
    """A path would route through av.open, which breaks on current PyAV releases."""
    import numpy as np

    service = WhisperTranscriptionService(settings=Settings())
    seg = MagicMock()
    seg.text = "ok"

    with patch.object(service, "_load_model") as load_mock:
        fake_model = MagicMock()
        fake_model.transcribe.return_value = ([seg], fake_info())
        load_mock.return_value = fake_model

        result = await service.transcribe_wav(make_tiny_wav())

    assert result.text == "ok"
    audio = fake_model.transcribe.call_args.args[0]
    assert isinstance(audio, np.ndarray) and audio.dtype == np.float32
    assert len(audio) == 8000
    assert -1.0 <= float(audio.min()) and float(audio.max()) < 1.0


@pytest.mark.asyncio
@pytest.mark.parametrize("rate", [8000, 44100])
async def test_transcribe_wav_rejects_unexpected_sample_rate(rate):
    service = WhisperTranscriptionService(settings=Settings())
    with patch.object(service, "_load_model") as load_mock:
        with pytest.raises(TranscriptionServiceError, match="16 kHz mono"):
            await service.transcribe_wav(make_tiny_wav(sample_rate=rate))
    load_mock.assert_not_called()


@pytest.mark.asyncio
async def test_transcribe_wav_rejects_truncated_wav_header():
    service = WhisperTranscriptionService(settings=Settings())
    bogus = b"RIFF" + b"\x00" * 4 + b"WAVE" + b"\x00" * 60
    with pytest.raises(TranscriptionServiceError):
        await service.transcribe_wav(bogus)
