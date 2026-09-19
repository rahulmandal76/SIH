import sys
import json
import os
import logging

# Suppress pypdf informational warnings to keep stdout pure JSON
logging.getLogger("pypdf").setLevel(logging.ERROR)

def extract_pages(pdf_path):
    if not os.path.exists(pdf_path):
        return {"success": False, "error": f"File not found: {pdf_path}"}

    try:
        import pypdf
        reader = pypdf.PdfReader(pdf_path)
        total_pages = len(reader.pages)
        pages_data = []

        for idx, page in enumerate(reader.pages):
            page_num = idx + 1
            text = page.extract_text() or ""
            # Normalize line breaks
            cleaned_text = text.replace("\r\n", "\n").replace("\r", "\n").strip()
            pages_data.append({
                "pageNumber": page_num,
                "text": cleaned_text
            })

        return {
            "success": True,
            "totalPages": total_pages,
            "pages": pages_data
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Missing pdf file path argument"}))
        sys.exit(1)

    file_path = sys.argv[1]
    result = extract_pages(file_path)
    print(json.dumps(result))
