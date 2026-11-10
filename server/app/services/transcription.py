import asyncio
import io
import json
import logging
import threading
import urllib.error
import urllib.request
import uuid
import wave
from dataclasses import dataclass
from typing import Optional

from app.config import Settings
from app.models import TranscriptionResponse


logger = logging.getLogger(__name__)
GROQ_TRANSCRIPTIONS_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
# A recording waits at most this long for a free transcription slot before the phone is told to retry.
TRANSCRIBE_QUEUE_WAIT_SECONDS = 30.0
SILENT_MESSAGE = "recording is silent — try speaking closer to the glasses microphone"


class TranscriptionServiceError(RuntimeError):
    pass


class TranscriptionBusyError(TranscriptionServiceError):
    """Too many recordings are already waiting; the phone should retry shortly (503)."""


@dataclass
class WhisperTranscriptionService:
    settings: Settings

    def __post_init__(self) -> None:
        self._model = None
        self._lock: Optional[asyncio.Lock] = None
        self._slots: Optional[asyncio.Semaphore] = None
        # The preload task and the first request both load from worker threads; only one may build the model.
        self._model_lock = threading.Lock()

    def _load_model(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is None:
                try:
                    from faster_whisper import WhisperModel
                except ImportError as exc:
                    raise TranscriptionServiceError(
                        "faster-whisper is not installed. Install server requirements."
                    ) from exc

                self._model = WhisperModel(
                    self.settings.whisper_model,
                    device=self.settings.whisper_device,
                    compute_type=self.settings.whisper_compute_type,
                    **({"revision": self.settings.whisper_model_revision} if self.settings.whisper_model_revision else {}),
                )
        return self._model

    async def preload(self) -> None:
        """Load the model ahead of the first recording; failures are left for the first real request."""
        try:
            await asyncio.to_thread(self._load_model)
        except Exception:
            pass

    async def transcribe_wav(self, wav_bytes: bytes, language: Optional[str] = None) -> TranscriptionResponse:
        if not wav_bytes:
            raise TranscriptionServiceError("audio payload is empty")
        if not _looks_like_wav(wav_bytes):
            # Never hand arbitrary bytes to the FFmpeg-backed decoder, which probes formats by content.
            raise TranscriptionServiceError("audio must be a RIFF/WAVE file")
        if self._slots is None:
            self._slots = asyncio.Semaphore(max(1, self.settings.transcribe_max_concurrent))
        try:
            await asyncio.wait_for(self._slots.acquire(), timeout=TRANSCRIBE_QUEUE_WAIT_SECONDS)
        except TimeoutError as exc:
            raise TranscriptionBusyError("transcription is busy, please retry") from exc
        try:
            return await self._transcribe_in_slot(wav_bytes, language)
        finally:
            self._slots.release()

    async def _transcribe_in_slot(self, wav_bytes: bytes, language: Optional[str]) -> TranscriptionResponse:
        # Decode and measure once, off the event loop (a 2 MB recording is ~1M samples).
        wav = await asyncio.to_thread(_read_wav, wav_bytes)
        max_seconds = self.settings.transcribe_max_seconds
        if max_seconds and wav.duration_seconds > max_seconds:
            raise TranscriptionServiceError(f"recording is too long (over {max_seconds:g} s)")
        if wav.silent:
            # Glasses can produce near-silent recordings; feeding silence to faster-whisper produces NaN
            # in the mel spectrogram, and Groq bills it anyway.
            raise TranscriptionServiceError(SILENT_MESSAGE)
        if self.settings.groq_api_key:
            try:
                return await asyncio.to_thread(self._transcribe_groq, wav_bytes, language)
            except TranscriptionServiceError:
                raise
            except Exception as exc:  # network, quota, bad response: keep working with the local model
                logger.warning("Groq transcription failed (%s); using the local model", exc.__class__.__name__)
        audio = _pcm16_samples(wav)
        # One transcription at a time, off the event loop so other requests stay responsive.
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            return await asyncio.to_thread(self._transcribe_blocking, audio, language)

    def _transcribe_groq(self, wav_bytes: bytes, language: Optional[str]) -> TranscriptionResponse:
        boundary = uuid.uuid4().hex
        fields = {"model": self.settings.groq_stt_model, "response_format": "verbose_json", "temperature": "0"}
        if language:
            fields["language"] = language
        parts = []
        for name, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="reply.wav"\r\n'
            "Content-Type: audio/wav\r\n\r\n".encode()
        )
        parts.append(wav_bytes)
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        request = urllib.request.Request(
            GROQ_TRANSCRIPTIONS_URL,
            data=b"".join(parts),
            headers={
                "Authorization": f"Bearer {self.settings.groq_api_key}",
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "User-Agent": "teleglance-backend",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.settings.groq_stt_timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        text = str(payload.get("text", "")).strip()
        if not text:
            raise TranscriptionServiceError("no speech detected in recording")
        return TranscriptionResponse(
            text=text,
            language=payload.get("language"),
            duration_seconds=payload.get("duration"),
        )

    def _transcribe_blocking(self, audio, language: Optional[str]) -> TranscriptionResponse:
        """Run the local model on decoded float32 samples (see _pcm16_samples)."""
        model = self._load_model()
        # Pass decoded samples, not a file path: faster-whisper only calls PyAV (av.open) for paths,
        # and recent PyAV releases break that call. This also keeps FFmpeg out of the request path.
        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=self.settings.whisper_beam_size,
            best_of=self.settings.whisper_best_of,
            temperature=self.settings.whisper_temperature,
            condition_on_previous_text=self.settings.whisper_condition_on_previous_text,
        )
        text = " ".join(seg.text.strip() for seg in segments)
        if not text:
            raise TranscriptionServiceError("no speech detected in recording")
        return TranscriptionResponse(
            text=text,
            language=getattr(info, "language", None),
            duration_seconds=getattr(info, "duration", None),
        )


EXPECTED_SAMPLE_RATE = 16000
# RMS below this (full scale 32767) is treated as silence.
SILENCE_RMS = 50
# Under 50 ms of 16 kHz mono 16-bit audio is too short to contain speech.
MIN_PCM_BYTES = 1600


@dataclass(frozen=True)
class _WavAudio:
    channels: int
    sample_width: int
    rate: int
    frames: bytes
    duration_seconds: float
    silent: bool


def _read_wav(wav_bytes: bytes) -> _WavAudio:
    """Parse a WAV (any header layout the wave module accepts) and measure it once."""
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as reader:
            channels, width, rate = reader.getnchannels(), reader.getsampwidth(), reader.getframerate()
            frames = reader.readframes(reader.getnframes())
    except (wave.Error, EOFError) as exc:
        logger.info("unreadable WAV upload: %s", exc)
        raise TranscriptionServiceError("audio is not a readable WAV file") from exc
    frame_count = len(frames) // max(1, channels * width)
    duration = frame_count / rate if rate else 0.0
    return _WavAudio(channels, width, rate, frames, duration, _is_effectively_silent(frames, width))


def _is_effectively_silent(frames: bytes, sample_width: int = 2) -> bool:
    """True if 16-bit PCM `frames` are near-silent (RMS < SILENCE_RMS) or too short to hold speech."""
    if len(frames) < MIN_PCM_BYTES:
        return True
    if sample_width != 2:
        return False  # only 16-bit audio is measured; other formats are rejected or left to Groq
    import numpy as np

    samples = np.frombuffer(frames[: len(frames) - len(frames) % 2], dtype="<i2").astype(np.float64)
    rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
    return rms < SILENCE_RMS


def _pcm16_samples(wav: _WavAudio):
    """16 kHz mono 16-bit PCM as float32 samples in [-1, 1) for the local model."""
    import numpy as np

    if wav.channels != 1 or wav.sample_width != 2 or wav.rate != EXPECTED_SAMPLE_RATE:
        raise TranscriptionServiceError(
            f"audio must be 16 kHz mono 16-bit PCM WAV (got {wav.rate} Hz, {wav.channels} channel(s), {wav.sample_width * 8}-bit)"
        )
    return np.frombuffer(wav.frames, dtype="<i2").astype(np.float32) / 32768.0


def _decode_wav_pcm16(wav_bytes: bytes):
    """Decode a 16 kHz mono 16-bit PCM WAV into float32 samples in [-1, 1)."""
    return _pcm16_samples(_read_wav(wav_bytes))


def _looks_like_wav(data: bytes) -> bool:
    return len(data) >= 44 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE"
