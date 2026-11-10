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


def test_groq_is_used_when_a_key_is_set_and_local_model_is_the_fallback():
    import asyncio

    settings = Settings(GROQ_API_KEY="test-key", TELEGLANCE_SHARED_SECRET=None)
    service = WhisperTranscriptionService(settings)
    wav = make_tiny_wav()

    with patch.object(service, "_transcribe_groq", return_value=TranscriptionResponse(text="from groq")) as groq:
        assert asyncio.run(service.transcribe_wav(wav)).text == "from groq"
        groq.assert_called_once()

    with patch.object(service, "_transcribe_groq", side_effect=OSError("offline")), \
         patch.object(service, "_transcribe_blocking", return_value=TranscriptionResponse(text="from local")):
        assert asyncio.run(service.transcribe_wav(wav)).text == "from local"


# --- audit B9-B11: decode once off the loop, single model load, bounded queue ---------------------------

import asyncio
import struct
import sys
import threading
import time as _time

import app.services.transcription as transcription_module
from app.services.transcription import TranscriptionBusyError


def wav_with_extra_chunk(pcm: bytes, extra: bytes) -> bytes:
    """A WAV whose data chunk does not start at byte 44 (a LIST chunk sits before it)."""
    fmt = struct.pack("<HHIIHH", 1, 1, 16000, 32000, 2, 16)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    chunks += b"LIST" + struct.pack("<I", len(extra)) + extra
    chunks += b"data" + struct.pack("<I", len(pcm)) + pcm
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


@pytest.mark.asyncio
async def test_silence_is_measured_on_the_samples_not_on_header_bytes():
    service = WhisperTranscriptionService(settings=Settings())
    loud_metadata = b"\xff\x7f" * 4000  # would look like a loud tone if read as PCM
    with pytest.raises(TranscriptionServiceError, match="silent"):
        await service.transcribe_wav(wav_with_extra_chunk(b"\x00\x00" * 8000, loud_metadata))


@pytest.mark.asyncio
async def test_audio_is_decoded_once_off_the_event_loop_even_when_groq_falls_back(monkeypatch):
    loop_thread = threading.get_ident()
    reads = []
    original = transcription_module._read_wav

    def recording_read(data):
        reads.append(threading.get_ident())
        return original(data)

    monkeypatch.setattr(transcription_module, "_read_wav", recording_read)
    service = WhisperTranscriptionService(Settings(GROQ_API_KEY="key", TELEGLANCE_SHARED_SECRET=None))
    with patch.object(service, "_transcribe_groq", side_effect=OSError("offline")), \
         patch.object(service, "_transcribe_blocking", return_value=TranscriptionResponse(text="local")) as local:
        assert (await service.transcribe_wav(make_tiny_wav())).text == "local"
    assert len(reads) == 1 and reads[0] != loop_thread
    assert len(local.call_args.args[0]) == 8000  # the local model gets the samples decoded above


def test_silence_check_is_fast_on_a_full_size_recording():
    frames = b"\x01\x00" * 1_000_000  # 2 MB, about a minute at 16 kHz
    started = _time.perf_counter()
    assert transcription_module._is_effectively_silent(frames) is True
    assert _time.perf_counter() - started < 0.2


def test_model_is_built_once_when_preload_and_a_request_race(monkeypatch):
    builds = []

    class SlowModel:
        def __init__(self, *args, **kwargs):
            builds.append(threading.get_ident())
            _time.sleep(0.05)

    monkeypatch.setitem(sys.modules, "faster_whisper", types.SimpleNamespace(WhisperModel=SlowModel))
    service = WhisperTranscriptionService(settings=Settings())
    threads = [threading.Thread(target=service._load_model) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(builds) == 1


@pytest.mark.asyncio
async def test_busy_transcription_queue_answers_quickly_instead_of_growing(monkeypatch):
    monkeypatch.setattr(transcription_module, "TRANSCRIBE_QUEUE_WAIT_SECONDS", 0.05)
    service = WhisperTranscriptionService(Settings(TRANSCRIBE_MAX_CONCURRENT=1))
    release = threading.Event()

    def blocking(audio, language):
        release.wait(5)
        return TranscriptionResponse(text="first")

    with patch.object(service, "_transcribe_blocking", side_effect=blocking):
        first = asyncio.create_task(service.transcribe_wav(make_tiny_wav()))
        await asyncio.sleep(0.05)
        with pytest.raises(TranscriptionBusyError):
            await service.transcribe_wav(make_tiny_wav())
        release.set()
        assert (await first).text == "first"


@pytest.mark.asyncio
async def test_overlong_recording_is_refused_before_transcription():
    service = WhisperTranscriptionService(Settings(TRANSCRIBE_MAX_SECONDS=0.25))
    with patch.object(service, "_load_model") as load_mock:
        with pytest.raises(TranscriptionServiceError, match="too long"):
            await service.transcribe_wav(make_tiny_wav(duration_ms=500))
    load_mock.assert_not_called()
