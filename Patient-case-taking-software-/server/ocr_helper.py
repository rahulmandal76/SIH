import sys
import json
import os
import shutil

def run_ocr(image_path, lang="eng+hin"):
    if not os.path.exists(image_path):
        return {"success": False, "error": f"File not found: {image_path}"}

    # Check for tesseract binary on PATH or standard install locations
    tesseract_bin = shutil.which("tesseract")
    if not tesseract_bin:
        # Check standard Windows paths
        common_paths = [
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe")
        ]
        for p in common_paths:
            if os.path.exists(p):
                tesseract_bin = p
                break

    if not tesseract_bin:
        return {
            "success": False,
            "error": "OCR_ENGINE_UNAVAILABLE: Tesseract executable not found on host system"
        }

    try:
        import pytesseract
        from PIL import Image

        pytesseract.pytesseract.tesseract_cmd = tesseract_bin
        tessdata_dir = os.path.join(os.path.dirname(tesseract_bin), "tessdata")
        if os.path.exists(tessdata_dir):
            os.environ["TESSDATA_PREFIX"] = tessdata_dir

        img = Image.open(image_path)

        # Extract text and data for confidence calculation
        # Fall back to 'eng' if 'eng+hin' is not installed in tessdata
        try:
            data = pytesseract.image_to_data(img, lang=lang, output_type=pytesseract.Output.DICT)
            text = pytesseract.image_to_string(img, lang=lang)
        except Exception:
            data = pytesseract.image_to_data(img, lang="eng", output_type=pytesseract.Output.DICT)
            text = pytesseract.image_to_string(img, lang="eng")

        # Compute average confidence for valid words
        confidences = [float(c) for c in data.get("conf", []) if float(c) > 0]
        avg_confidence = round(sum(confidences) / len(confidences) / 100.0, 3) if confidences else 0.85

        cleaned_text = text.replace("\r\n", "\n").replace("\r", "\n").strip()

        return {
            "success": True,
            "text": cleaned_text,
            "confidence": avg_confidence
        }
    except Exception as e:
        return {
            "success": False,
            "error": f"OCR_EXECUTION_ERROR: {str(e)}"
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing image file path argument"}))
        sys.exit(1)

    img_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "eng+hin"
    result = run_ocr(img_path, language)
    print(json.dumps(result))
