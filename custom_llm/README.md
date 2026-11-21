# ClipForge Custom Clipping LLM

This directory contains ClipForge's **custom domain-specialized clipping model & OpenAI-compatible inference server**, sized for an **NVIDIA GTX 1650 (4 GB VRAM)** + 16 GB RAM.

## 1. Run the Custom Inference API Server (Zero Extra Installs)
```bash
python3 custom_llm/server.py
```
Then add to your `.env`:
```env
CUSTOM_LLM_URL=http://127.0.0.1:8000
CUSTOM_LLM_MODEL=clipforge-viral-custom
```
`server.py` automatically selects the best available backend:
1. **`llama-cpp-python`** (CUDA GGUF offloaded to GTX 1650 when `CUSTOM_GGUF_PATH` is set)
2. **Custom Ollama model** (`clipforge-viral:3b`) if Ollama is running
3. **Built-in Trainable Viral Classifier** trained directly from your ClipForge feedback (`workspace/training_data.jsonl`)

## 2. Build the Custom Ollama Model (`clipforge-viral:3b`)
```bash
ollama pull llama3.2:3b
ollama create clipforge-viral:3b -f custom_llm/Modelfile
```

## 3. Fine-Tune Your Own LoRA Adapter on GTX 1650 (4 GB VRAM)
1. Rate clips in ClipForge using **Thumbs Up / Thumbs Down** (examples are logged automatically to `workspace/training_data.jsonl`).
2. Install fine-tuning deps: `pip install -r custom_llm/requirements.txt`
3. Run 4-bit QLoRA training:
```bash
python3 custom_llm/finetune_lora.py
```
