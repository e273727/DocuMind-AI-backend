import sys
import json
import fitz  # PyMuPDF

# Ensure stdout uses UTF-8 encoding on Windows to prevent UnicodeEncodeError
sys.stdout.reconfigure(encoding='utf-8')

def extract_pdf_text(file_path):
    try:
        doc = fitz.open(file_path)
        pages_data = []
        
        for page_idx in range(len(doc)):
            page = doc[page_idx]
            text = page.get_text()
            pages_data.append({
                "page": page_idx + 1,  # 1-based index for user citations
                "text": text.strip()
            })
            
        doc.close()
        return pages_data
    except Exception as e:
        print(f"Error opening or reading PDF file: {str(e)}", file=sys.stderr)
        sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_text.py <path_to_pdf>", file=sys.stderr)
        sys.exit(1)
        
    pdf_path = sys.argv[1]
    pages_data = extract_pdf_text(pdf_path)
    
    # Print the resulting JSON structure to stdout
    print(json.dumps(pages_data, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
