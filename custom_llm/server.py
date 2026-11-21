#!/usr/bin/env python3
"""
ClipForge Custom OpenAI-Compatible Inference Server
---------------------------------------------------
Runs on 127.0.0.1:8000 with zero required third-party dependencies for the
built-in trainable viral hook classifier, and automatically upgrades to:
  1. llama-cpp-python (GPU-offloaded GGUF model on GTX 1650) if installed & CUSTOM_GGUF_PATH set
  2. Local Ollama (clipforge-viral:3b or OLLAMA_MODEL) if running
  3. Trainable Naive-Bayes + Signal Viral Scorer trained from workspace/training_data.jsonl
"""

import hmac
import json
import math
import os
import re
import urllib.error
import urllib.request
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("CUSTOM_LLM_BIND_HOST", "127.0.0.1")
PORT = int(os.environ.get("CUSTOM_LLM_PORT", "8000"))
API_KEY = os.environ.get("CUSTOM_LLM_KEY", "").strip()
BACKEND_MODE = os.environ.get("CUSTOM_LLM_BACKEND", "auto").strip().lower()
GGUF_PATH = os.environ.get("CUSTOM_GGUF_PATH", "").strip()
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("CUSTOM_OLLAMA_MODEL", "clipforge-viral:3b")

ROOT_DIR = Path(__file__).resolve().parent.parent
TRAINING_FILE = ROOT_DIR / "workspace" / "training_data.jsonl"

HOOK_WEIGHTS = {
    "clutch": 1.6,
    "no way": 1.7,
    "wait": 1.1,
    "insane": 1.5,
    "what": 1.0,
    "bro": 0.9,
    "oh my": 1.4,
    "crazy": 1.3,
    "unbelievable": 1.5,
    "secret": 1.4,
    "glitch": 1.3,
    "lets go": 1.4,
    "let's go": 1.4,
    "clip": 1.2,
}

_llama_instance = None


def maybe_load_llamacpp():
    global _llama_instance
    if _llama_instance is not None:
        return _llama_instance
    if not GGUF_PATH or not os.path.exists(GGUF_PATH):
        return None
    try:
        from llama_cpp import Llama  # type: ignore

        _llama_instance = Llama(
            model_path=GGUF_PATH,
            n_gpu_layers=-1,  # Offload layers to GTX 1650 VRAM
            n_ctx=4096,
            verbose=False,
        )
        return _llama_instance
    except Exception:
        return None


def tokenize(text: str):
    return re.findall(r"[a-z0-9']+", text.lower())


class TrainableViralClassifier:
    """Lightweight Multinomial Naive Bayes trained on ClipForge user feedback."""

    def __init__(self, jsonl_path: Path):
        self.pos_counts: Counter[str] = Counter()
        self.neg_counts: Counter[str] = Counter()
        self.pos_total = 0
        self.neg_total = 0
        self.pos_docs = 0
        self.neg_docs = 0
        self.vocab = set()
        self._load(jsonl_path)

    def _load(self, jsonl_path: Path):
        if not jsonl_path.exists():
            return
        try:
            with jsonl_path.open("r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    row = json.loads(line)
                    label = row.get("label")
                    text = str(row.get("snippet", "")) + " " + str(row.get("title", ""))
                    tokens = tokenize(text)
                    if not tokens:
                        continue
                    self.vocab.update(tokens)
                    if label == 1:
                        self.pos_docs += 1
                        self.pos_counts.update(tokens)
                        self.pos_total += len(tokens)
                    elif label == 0:
                        self.neg_docs += 1
                        self.neg_counts.update(tokens)
                        self.neg_total += len(tokens)
        except Exception:
            pass

    def score_text(self, text: str) -> float:
        lower = text.lower()
        hook_boost = 0.0
        for phrase, weight in HOOK_WEIGHTS.items():
            if phrase in lower:
                hook_boost += 0.08 * weight
        punct_boost = min(0.18, (text.count("!") + text.count("?")) * 0.05)

        if self.pos_docs == 0 and self.neg_docs == 0:
            return min(0.96, round(0.52 + hook_boost + punct_boost, 2))

        tokens = tokenize(text)
        v_size = max(1, len(self.vocab))
        log_pos = math.log((self.pos_docs + 1) / (self.pos_docs + self.neg_docs + 2))
        log_neg = math.log((self.neg_docs + 1) / (self.pos_docs + self.neg_docs + 2))

        for tok in tokens:
            log_pos += math.log((self.pos_counts[tok] + 1) / (self.pos_total + v_size))
            log_neg += math.log((self.neg_counts[tok] + 1) / (self.neg_total + v_size))

        diff = max(-12.0, min(12.0, log_pos - log_neg))
        nb_prob = 1.0 / (1.0 + math.exp(-diff))
        combined = nb_prob * 0.65 + min(1.0, 0.35 + hook_boost + punct_boost) * 0.35
        return min(0.98, max(0.15, round(combined, 2)))


def try_ollama(prompt: str) -> str | None:
    try:
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/generate",
            data=json.dumps(
                {
                    "model": OLLAMA_MODEL,
                    "prompt": prompt,
                    "stream": False,
                    "format": "json",
                }
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=12) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
            return payload.get("response")
    except Exception:
        return None


def parse_candidates_from_prompt(prompt: str):
    title_match = re.search(r'Source video title:\s*"([^"]*)"', prompt)
    source_title = title_match.group(1) if title_match else "Stream Highlight"
    cand_match = re.search(r"Candidates:\s*(\[.*\])", prompt, flags=re.DOTALL)
    if cand_match:
        try:
            return source_title, json.loads(cand_match.group(1))
        except Exception:
            pass
    return source_title, [
        {
            "startSec": 0,
            "endSec": 15,
            "audioPeakDb": -14.0,
            "audioSpikeScore": 0.78,
            "transcriptSnippet": prompt[:180],
        }
    ]


def run_builtin_classifier(prompt: str) -> str:
    source_title, candidates = parse_candidates_from_prompt(prompt)
    clf = TrainableViralClassifier(TRAINING_FILE)
    clean_src = re.sub(r"\.[^.]+$", "", source_title).strip()[:44] or "Stream"
    clips = []

    for idx, c in enumerate(candidates):
        snippet = str(c.get("transcriptSnippet", "") or "")
        spike = float(c.get("audioSpikeScore", 0.65))
        peak_db = float(c.get("audioPeakDb", -18.0))
        start_sec = float(c.get("startSec", 0))
        end_sec = float(c.get("endSec", start_sec + 15))

        text_score = clf.score_text(f"{source_title} {snippet}")
        llm_score = round(min(0.98, max(0.2, spike * 0.55 + text_score * 0.45)), 2)

        mm = int(start_sec // 60)
        ss = int(start_sec % 60)
        ts_label = f"{mm:02d}:{ss:02d}"

        if snippet:
            short_phrase = re.sub(r"[^a-zA-Z0-9 '!?,.-]", "", snippet).strip()[:52]
            title = f"{short_phrase} ({ts_label})" if short_phrase else f"Peak Moment at {ts_label}"
            hook = f"Wait for this moment in {clean_src}: {short_phrase}"
        else:
            title = f"Peak Reaction at {ts_label} — {clean_src}"
            hook = f"Unfiltered {round(end_sec - start_sec)}s spike ({peak_db:.1f} dB) in {clean_src}."

        trained_samples = clf.pos_docs + clf.neg_docs
        reason = (
            f"Custom classifier ({trained_samples} feedback samples) · audio {peak_db:.1f} dB"
            if trained_samples > 0
            else f"Custom viral hook model · audio {peak_db:.1f} dB"
        )

        clips.append(
            {
                "llmScore": llm_score,
                "title": title[:88],
                "hookTagline": hook[:110],
                "description": f"{hook}\n\nClipped from {clean_src} ({ts_label}). YouTube auto-captions enabled.",
                "hashtags": ["#shorts", "#clips", "#highlights", "#gaming"],
                "reason": reason,
            }
        )

    return json.dumps({"clips": clips})


def generate_completion(messages: list[dict]) -> tuple[str, str]:
    user_prompt = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") != "system")
    system_prompt = "\n".join(str(m.get("content", "")) for m in messages if m.get("role") == "system")

    if BACKEND_MODE in ("auto", "llamacpp"):
        llm = maybe_load_llamacpp()
        if llm is not None:
            res = llm.create_chat_completion(
                messages=[
                    {"role": "system", "content": system_prompt or "Return valid JSON only."},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.3,
                max_tokens=900,
                response_format={"type": "json_object"},
            )
            content = res["choices"][0]["message"]["content"]
            return content, f"llamacpp:{os.path.basename(GGUF_PATH)}"

    if BACKEND_MODE in ("auto", "ollama"):
        ollama_out = try_ollama(f"{system_prompt}\n{user_prompt}".strip())
        if ollama_out:
            return ollama_out, f"ollama:{OLLAMA_MODEL}"

    return run_builtin_classifier(user_prompt), "clipforge-custom-classifier-v1"


class CustomLLMHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if not API_KEY:
            return True
        auth = self.headers.get("Authorization", "")
        expected = f"Bearer {API_KEY}"
        return hmac.compare_digest(auth, expected)

    def do_GET(self):
        if self.path == "/health":
            clf = TrainableViralClassifier(TRAINING_FILE)
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "clipforge-custom-llm",
                    "backendMode": BACKEND_MODE,
                    "trainedFeedbackSamples": clf.pos_docs + clf.neg_docs,
                },
            )
            return
        if self.path == "/v1/models":
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"id": "clipforge-viral-custom", "object": "model"},
                    ],
                },
            )
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if not self._authorized():
            self._send_json(401, {"error": "Unauthorized"})
            return
        if self.path != "/v1/chat/completions":
            self._send_json(404, {"error": "Not found"})
            return

        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 2_000_000:
            self._send_json(400, {"error": "Invalid request payload size"})
            return

        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": "Invalid JSON"})
            return

        messages = body.get("messages")
        if not isinstance(messages, list):
            self._send_json(400, {"error": "messages array required"})
            return

        content, model_used = generate_completion(messages)
        self._send_json(
            200,
            {
                "id": "chatcmpl-clipforge-custom",
                "object": "chat.completion",
                "model": model_used,
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
            },
        )


if __name__ == "__main__":
    print(f"ClipForge Custom LLM API listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), CustomLLMHandler).serve_forever()
