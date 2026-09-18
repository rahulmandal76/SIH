import logging
import os
import time
from typing import List, Tuple, Optional, Dict, Any
from dotenv import load_dotenv
import requests

from chunker import Chunk

load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-20b")
DEFAULT_BASE_URL = os.environ.get("GROQ_API_BASE_URL", "https://api.groq.com/openai/v1")

SYSTEM_PROMPT = """You are a longitudinal medical-history retrieval assistant working with a synthetic patient record.

All supplied context belongs to the same synthetic patient: SYN-PAT-001 (Arjun Mehta), covering annual records from 2010 through 2024.

Rules you MUST follow:
1. Answer the user's question using ONLY the factual evidence contained in the "PATIENT MEDICAL HISTORY CONTEXT" section below. Do not guess, extrapolate, or fabricate any medical events.
2. The records represent a chronological timeline from 2010 to 2024. Preserve chronology whenever relevant. When summarizing progression or disease trajectories, connect events across years and explain the timeline clearly.
3. Clearly distinguish historical status (e.g., baseline health, prediabetes, initial treatments) from the most recent documented status (e.g., 2024 active medications and lab results).
4. Always cite the specific year(s) or record filename for key findings, lab numbers, and medication changes (e.g., "In 2019 (2019 record), metformin was initiated..." or "eGFR was >90 in 2010, declined to 69 in 2022, and was 78 in 2024 (2010, 2022, 2024 records)").
5. If the requested information, symptom, test, or diagnosis is not documented in the provided patient records, explicitly state that it is not documented in the available record.
6. Present your answers clearly and professionally using Markdown, bolding, structured bullet points, and chronological headings where appropriate.
7. This dataset is completely synthetic and fictional development data created for RAG testing. It does NOT represent a real patient and must not be used for actual clinical decision-making.
"""


def format_context(retrieved: List[Tuple[Chunk, float]]) -> str:
    """Format retrieved chunks into chronologically sorted context blocks."""
    if not retrieved:
        return "No relevant patient records retrieved."

    # Sort retrieved chunks in ascending chronological order by year
    def sort_key(item: Tuple[Chunk, float]) -> int:
        c, _ = item
        return c.year if (c.year is not None) else 9999

    sorted_retrieved = sorted(retrieved, key=sort_key)

    blocks = []
    for chunk, score in sorted_retrieved:
        pat_id = chunk.patient_id or chunk.metadata.get("patient_id", "SYN-PAT-001")
        yr = chunk.year if chunk.year is not None else chunk.metadata.get("year", "Unknown")
        src = chunk.source or chunk.metadata.get("source", "Unknown")
        blocks.append(
            f"[PATIENT: {pat_id} | YEAR: {yr} | SOURCE: {src} | RELEVANCE SCORE: {score:.3f}]\n{chunk.text}"
        )
    return "\n\n---\n\n".join(blocks)


def build_user_message(query: str, context: str) -> str:
    return f"PATIENT MEDICAL HISTORY CONTEXT (CHRONOLOGICAL ORDER):\n\n{context}\n\nQUESTION: {query}"


CONTEXTUALIZE_SYSTEM_PROMPT = """Given a chat history and a follow-up user question about a patient's medical history, rewrite the follow-up question as a standalone question that contains all the necessary clinical and temporal context (e.g. resolve pronouns like "it", "that", or "these medications" into the actual clinical terms or patient years). Do NOT answer the question. If the question is already standalone, return it unchanged.
Return ONLY the rewritten question, nothing else."""


def _ensure_api_key(api_key: Optional[str]) -> Optional[str]:
    return api_key or os.getenv("GROQ_API_KEY")


def _extract_text(response_json: Dict[str, Any]) -> str:
    if response_json is None:
        return ""

    if isinstance(response_json, dict):
        if "output_text" in response_json:
            return response_json["output_text"]

        choices = response_json.get("choices")
        if isinstance(choices, list) and choices:
            first_choice = choices[0]
            if isinstance(first_choice, dict):
                message = first_choice.get("message")
                if isinstance(message, dict):
                    content = message.get("content")
                    if isinstance(content, str):
                        return content
                    if isinstance(content, list):
                        return "".join(
                            item.get("text", "")
                            if isinstance(item, dict)
                            else str(item)
                            for item in content
                        )

        output = response_json.get("output")
        if isinstance(output, list) and output:
            first = output[0]
            if isinstance(first, dict):
                if "text" in first:
                    return first["text"]
                if "content" in first:
                    content = first["content"]
                    if isinstance(content, str):
                        return content
                    if isinstance(content, list):
                        return "".join(
                            item.get("text", "")
                            if isinstance(item, dict)
                            else str(item)
                            for item in content
                        )
            return str(first)

    return str(response_json)


def _build_prompt_messages(system_prompt: str, messages: List[dict]) -> List[dict]:
    prompt = [{"role": "system", "content": system_prompt}]
    prompt.extend({"role": m["role"], "content": m["content"]} for m in messages)
    return prompt


class Generator:
    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        api_key: Optional[str] = None,
        api_base_url: Optional[str] = None,
    ):
        self.model = model
        self.api_key = _ensure_api_key(api_key)
        self.api_base_url = api_base_url or DEFAULT_BASE_URL
        self.enabled = bool(self.api_key)

    def _get_chat_completion_url(self) -> str:
        base = self.api_base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            return base
        if base.endswith("/responses"):
            return base.replace("/responses", "/chat/completions")
        return f"{base}/chat/completions"

    def _post_with_retry(self, url: str, payload: dict, headers: dict, max_retries: int = 4) -> requests.Response:
        """Send HTTP POST request with automatic retry on 429 rate limit errors."""
        last_exception = None
        for attempt in range(max_retries):
            try:
                response = requests.post(url, json=payload, headers=headers, timeout=60)
                if response.status_code == 429:
                    wait_sec = 6 * (attempt + 1)
                    retry_after = response.headers.get("Retry-After")
                    if retry_after and retry_after.isdigit():
                        wait_sec = max(wait_sec, int(retry_after) + 1)
                    logger.warning(f"Groq 429 rate limit hit. Waiting {wait_sec}s before retry (attempt {attempt + 1}/{max_retries})...")
                    time.sleep(wait_sec)
                    continue
                response.raise_for_status()
                return response
            except requests.exceptions.RequestException as e:
                last_exception = e
                if attempt < max_retries - 1:
                    time.sleep(3 * (attempt + 1))
                else:
                    raise last_exception
        if last_exception:
            raise last_exception
        raise RuntimeError("Failed to complete request after retries.")

    def _call_groq(self, messages: List[dict], max_tokens: int) -> str:
        payload = {
            "model": self.model,
            "messages": _build_prompt_messages(SYSTEM_PROMPT, messages),
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            response = self._post_with_retry(
                self._get_chat_completion_url(),
                payload=payload,
                headers=headers,
            )
            return _extract_text(response.json())
        except Exception as e:
            logger.error(f"Error calling Groq API in _call_groq: {e}")
            raise

    def contextualize_query(self, query: str, history: Optional[List[dict]]) -> str:
        """Rewrite a follow-up medical query into a standalone one using chat history."""
        if not history:
            return query

        if not self.enabled:
            return query

        messages = list(history) + [{"role": "user", "content": query}]
        prompt_messages = _build_prompt_messages(CONTEXTUALIZE_SYSTEM_PROMPT, messages)
        payload = {
            "model": self.model,
            "messages": prompt_messages,
            "temperature": 0.0,
            "max_tokens": 200,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            response = self._post_with_retry(
                self._get_chat_completion_url(),
                payload=payload,
                headers=headers,
            )
            text = _extract_text(response.json())
            return text.strip() or query
        except Exception as e:
            logger.warning(f"Error during query contextualize: {e}. Falling back to original query.")
            return query

    def generate_with_metadata(
        self,
        query: str,
        retrieved: List[Tuple[Chunk, float]],
        history: Optional[List[dict]] = None,
        max_tokens: int = 1200,
    ) -> Dict[str, Any]:
        """Execute generation and return structured answer along with token usage metadata."""
        if not self.enabled:
            return {
                "text": "Groq generation is unavailable because GROQ_API_KEY is not set.",
                "usage": None,
            }

        if not retrieved:
            return {
                "text": "I don't have enough information in the provided patient records to answer that. (No relevant documents found in index)",
                "usage": None,
            }

        context = format_context(retrieved)
        user_msg = build_user_message(query, context)

        messages = list(history) if history else []
        messages.append({"role": "user", "content": user_msg})

        payload = {
            "model": self.model,
            "messages": _build_prompt_messages(SYSTEM_PROMPT, messages),
            "temperature": 0.0,
            "max_tokens": max_tokens,
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            response = self._post_with_retry(
                self._get_chat_completion_url(),
                payload=payload,
                headers=headers,
            )
            res_json = response.json()
            text = _extract_text(res_json)
            usage = res_json.get("usage", {}) if isinstance(res_json, dict) else {}
            return {"text": text, "usage": usage}
        except requests.exceptions.RequestException as e:
            logger.error(f"Groq API network/request error in generate: {e}")
            return {
                "text": f"Error connecting to the LLM service: {str(e)}. Please check your network connection or API key.",
                "usage": None,
            }
        except Exception as e:
            logger.error(f"Unexpected error during generation: {e}")
            return {
                "text": f"An unexpected error occurred during answer generation: {str(e)}",
                "usage": None,
            }

    def generate(
        self,
        query: str,
        retrieved: List[Tuple[Chunk, float]],
        history: Optional[List[dict]] = None,
        max_tokens: int = 1200,
    ) -> str:
        """Generate answer string from user question and retrieved patient chunks."""
        res = self.generate_with_metadata(query, retrieved, history=history, max_tokens=max_tokens)
        return res["text"]
