import asyncio
import os
import struct
import tempfile
from dataclasses import dataclass
from typing import Optional

from app.config import Settings
from app.models import TranscriptionResponse


class TranscriptionServiceError(RuntimeError):
    pass


@dataclass
class WhisperTranscriptionService:
    settings: Settings

    def __post_init__(self) -> None:
        self._model = None
        self._lock: Optional[asyncio.Lock] = None

    def _load_model(self):
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

    async def transcribe_wav(self, wav_bytes: bytes, language: Optional[str] = None) -> TranscriptionResponse:
        if not wav_bytes:
            raise TranscriptionServiceError("audio payload is empty")
        if not _looks_like_wav(wav_bytes):
            # Never hand arbitrary bytes to the FFmpeg-backed decoder, which probes formats by content.
            raise TranscriptionServiceError("audio must be a RIFF/WAVE file")
        # One transcription at a time, off the event loop so other requests stay responsive.
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            return await asyncio.to_thread(self._transcribe_blocking, wav_bytes, language)

    def _transcribe_blocking(self, wav_bytes: bytes, language: Optional[str]) -> TranscriptionResponse:
        # Validate audio is not silent before invoking Whisper.
        # Glasses can produce near-silent recordings; feeding silence to
        # faster-whisper produces NaN in the mel spectrogram.
        if _is_effectively_silent(wav_bytes):
            raise TranscriptionServiceError(
                "recording is silent — try speaking closer to the glasses microphone"
            )

        model = self._load_model()
        temp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
                handle.write(wav_bytes)
                temp_path = handle.name

            segments, info = model.transcribe(
                temp_path,
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
        finally:
            if temp_path:
                os.unlink(temp_path)


def _looks_like_wav(data: bytes) -> bool:
    return len(data) >= 44 and data[0:4] == b"RIFF" and data[8:12] == b"WAVE"


def _is_effectively_silent(wav_bytes: bytes) -> bool:
    """Return True if the WAV audio is silent or near-silent.

    Computes RMS on the PCM samples (skipping the 44-byte WAV header).
    Audio with RMS < 50 (out of 32767) is treated as silent.
    """
    if len(wav_bytes) < 48:
        return True  # too short to contain real audio
    pcm = wav_bytes[44:]  # skip WAV header
    if len(pcm) < 1600:  # less than 50 ms at 16 kHz mono 16-bit
        return True
    # Compute RMS of 16-bit samples
    total = 0.0
    count = len(pcm) // 2
    for i in range(0, len(pcm) - 1, 2):
        sample = struct.unpack_from("<h", pcm, i)[0]
        total += sample * sample
    rms = (total / max(count, 1)) ** 0.5
    # Threshold: RMS < 50 is effectively silent (full-scale = 32767)
    return rms < 50
