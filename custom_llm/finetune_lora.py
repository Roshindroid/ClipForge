#!/usr/bin/env python3
"""
4-bit QLoRA Fine-Tuning Script for ClipForge Custom Viral Clipping LLM
Tuned specifically for 4 GB VRAM GPUs (NVIDIA GeForce GTX 1650 Max-Q).

Trains on workspace/training_data.jsonl exported from ClipForge Thumbs Up / Down feedback.
"""

import os
from pathlib import Path

BASE_MODEL = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-3B-Instruct")
DATASET_PATH = Path(__file__).resolve().parent.parent / "workspace" / "training_data.jsonl"
OUTPUT_DIR = Path(__file__).resolve().parent / "adapters" / "clipforge-viral-lora"


def main():
    if not DATASET_PATH.exists():
        raise FileNotFoundError(
            f"No training dataset found at {DATASET_PATH}. Give Thumbs Up/Down feedback on moments in ClipForge first."
        )

    import torch
    from datasets import load_dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, TrainingArguments
    from trl import SFTTrainer

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
    )

    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        quantization_config=bnb_config,
        device_map="auto",
    )

    lora_config = LoraConfig(
        r=8,
        lora_alpha=16,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
    )

    dataset = load_dataset("json", data_files=str(DATASET_PATH), split="train")
    positive_only = dataset.filter(lambda row: row.get("label") == 1)
    train_ds = positive_only if len(positive_only) >= 4 else dataset

    def format_row(example):
        return tokenizer.apply_chat_template(
            example["messages"],
            tokenize=False,
            add_generation_prompt=False,
        )

    args = TrainingArguments(
        output_dir=str(OUTPUT_DIR),
        per_device_train_batch_size=1,
        gradient_accumulation_steps=8,
        learning_rate=2e-4,
        num_train_epochs=3,
        fp16=True,
        logging_steps=5,
        save_strategy="epoch",
        optim="paged_adamw_8bit",
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        train_dataset=train_ds,
        peft_config=lora_config,
        formatting_func=format_row,
        max_seq_length=512,
        tokenizer=tokenizer,
        args=args,
    )

    trainer.train()
    trainer.save_model(str(OUTPUT_DIR))
    print(f"Saved custom LoRA adapter to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
