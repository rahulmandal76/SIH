import io
import json
import logging
import sys
import time
from rag_pipeline import RAGPipeline

# Ensure UTF-8 output on Windows consoles
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

QUESTIONS = [
    "When was hypertension first treated?",
    "When was type 2 diabetes first documented?",
    "Which medication was started in 2018?",
    "Which medication was added in 2022?",
    "What was the patient's HbA1c in 2015, 2019, and 2024?",
    "How did eGFR change across the available history?",
    "What medications were documented in 2024?",
    "What were the major metabolic changes between 2010 and 2024?",
    "Did the patient have documented diabetic retinopathy?",
    "Give a chronological summary of the patient's major medical events.",
]


def main():
    print("=" * 80)
    print("AuraHealth Nexus - SYN-PAT-001 Longitudinal Medical History Evaluation")
    print("=" * 80)

    pipeline = RAGPipeline()
    pipeline.index(force_rebuild=False)

    results = []

    for i, q in enumerate(QUESTIONS, 1):
        print(f"\nEvaluating Question {i}/{len(QUESTIONS)}...")
        print(f"Q{i}: {q}")

        res = pipeline.ask_with_metadata(q, use_history=False)

        result = {
            "question_number": i,
            "question": q,
            "strategy": res.get("strategy", "STANDARD_SEMANTIC"),
            "years_covered": res.get("years", []),
            "top_sources": res.get("sources", []),
            "confidence": res.get("confidence", "Low"),
            "latency_seconds": round(res.get("time_taken", 0.0), 2),
            "answer": res.get("answer", ""),
        }
        results.append(result)

        print(f"Strategy: {result['strategy']} | Years Covered: {result['years_covered']}")
        print(f"Top Sources: {result['top_sources']}")
        print(f"Answer:\n{result['answer']}")
        print("-" * 80)

        # Brief pause between queries to respect LLM rate limits if enabled
        if i < len(QUESTIONS) and pipeline.generator.enabled:
            time.sleep(6)

    output_file = "evaluation_results.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\nSuccessfully evaluated all {len(QUESTIONS)} questions.")
    print(f"Results saved to '{output_file}'.")


if __name__ == "__main__":
    main()
