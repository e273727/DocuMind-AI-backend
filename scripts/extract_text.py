import sys
import json
import re
import unicodedata
import fitz  # PyMuPDF
try:
    fitz.TOOLS.mupdf_display_errors(False)
except Exception:
    pass

# Ensure stdout uses UTF-8 encoding on Windows to prevent UnicodeEncodeError
sys.stdout.reconfigure(encoding='utf-8')

# Regex for detecting common header/footer artifacts like page numbers
PAGE_NUM_PATTERN = re.compile(
    r'^(?:page\s+)?(?:\d+|[ivxlcdm]+)(?:\s*(?:of|/|-)\s*(?:\d+|[ivxlcdm]+))?$', 
    re.IGNORECASE
)

# Regex for detecting section headings
HEADING_PATTERN = re.compile(
    r'^(?:(?:\d+[\.\)]\s*)+|[A-Z0-9\.\s\-]{3,60}$|(?:CHAPTER|SECTION|ARTICLE|PART|APPENDIX|MODULE|UNIT)\s+[A-Z0-9]+)',
    re.IGNORECASE
)

LIGATURES = {
    '\ufb00': 'ff',
    '\ufb01': 'fi',
    '\ufb02': 'fl',
    '\ufb03': 'ffi',
    '\ufb04': 'ffl',
    '\ufb05': 'ft',
    '\ufb06': 'st',
    '\u2018': "'",
    '\u2019': "'",
    '\u201c': '"',
    '\u201d': '"',
    '\u2013': '-',
    '\u2014': '--',
    '\u2026': '...',
}

def clean_text(text):
    """
    Cleans raw text extracted from PDF:
    - Normalizes Unicode (NFKC)
    - Replaces ligatures and smart quotes
    - Fixes hyphenated word line breaks (e.g. 'docu-\nment' -> 'document')
    - Cleans redundant spaces and non-printable control characters
    - Normalizes bullet points
    """
    if not text:
        return ""
    
    # 1. Replace known ligatures & special punctuation
    for lig, rep in LIGATURES.items():
        text = text.replace(lig, rep)
        
    # 2. Unicode normalization
    text = unicodedata.normalize('NFKC', text)
    
    # 3. Fix hyphenated words at line breaks (word-\nword -> wordword)
    text = re.sub(r'(\b[A-Za-z]{2,})-\s*\n\s*([a-z]{2,}\b)', r'\1\2', text)
    
    # 4. Standardize newlines
    text = re.sub(r'\r\n|\r', '\n', text)
    
    # 5. Normalize bullet points
    lines = []
    for line in text.split('\n'):
        line_clean = re.sub(r'^[•●▪■◆–—]\s*', '- ', line.strip())
        # Collapse multiple spaces
        line_clean = re.sub(r'[ \t]+', ' ', line_clean)
        lines.append(line_clean)
        
    text = '\n'.join(lines)
    
    # 6. Replace 3 or more consecutive newlines with 2
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    # 7. Remove non-printable control characters (preserve \t and \n)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    
    return text.strip()

def detect_headers_and_footers(doc):
    """
    Identifies candidate header/footer text appearing repetitively across pages.
    """
    top_lines = {}
    bottom_lines = {}
    total_pages = len(doc)
    
    if total_pages < 2:
        return set()

    for page in doc:
        rect = page.rect
        height = rect.height
        blocks = page.get_text("blocks", sort=True)
        
        for b in blocks:
            text = clean_text(b[4])
            if not text:
                continue
            y0 = b[1]
            y1 = b[3]
            
            # Top 8% of page height
            if y0 < height * 0.08:
                top_lines[text] = top_lines.get(text, 0) + 1
            # Bottom 8% of page height
            elif y1 > height * 0.92:
                bottom_lines[text] = bottom_lines.get(text, 0) + 1

    artifacts = set()
    threshold = max(2, int(total_pages * 0.35))
    
    for text, count in top_lines.items():
        if count >= threshold:
            artifacts.add(text)
            
    for text, count in bottom_lines.items():
        if count >= threshold:
            artifacts.add(text)

    return artifacts

def extract_tables_from_page(page):
    """
    Detects tables on a page and returns a list of table dictionaries:
    [{'bbox': rect, 'markdown': md_string, 'rows': N}]
    """
    tables = []
    if not hasattr(page, "find_tables"):
        return tables
        
    try:
        tabs = page.find_tables()
        for tab in tabs:
            extracted = tab.extract()
            if not extracted or len(extracted) < 1:
                continue
                
            # Filter empty rows
            rows = [[cell if cell is not None else "" for cell in row] for row in extracted]
            rows = [row for row in rows if any(cell.strip() for cell in row)]
            if len(rows) < 1:
                continue
                
            # Construct Markdown table
            headers = [cell.strip().replace('\n', ' ') for cell in rows[0]]
            # If header row is empty, generate generic headers
            if not any(headers):
                headers = [f"Col {i+1}" for i in range(len(headers))]
                
            header_line = "| " + " | ".join(headers) + " |"
            separator_line = "| " + " | ".join(["---"] * len(headers)) + " |"
            
            data_lines = []
            for row in rows[1:]:
                cells = [cell.strip().replace('\n', ' ') for cell in row]
                # Pad cells if row length doesn't match headers
                while len(cells) < len(headers):
                    cells.append("")
                cells = cells[:len(headers)]
                data_lines.append("| " + " | ".join(cells) + " |")
                
            md_table = "\n".join([header_line, separator_line] + data_lines)
            
            tables.append({
                "bbox": fitz.Rect(tab.bbox),
                "markdown": md_table,
                "rows": len(rows)
            })
    except Exception as e:
        # Graceful fallback if table finder encounters issues
        pass
        
    return tables

def extract_structured_pdf_data(file_path):
    """
    Multi-pass extraction engine:
    1. Reads PDF TOC (Table of Contents) for outline hierarchy
    2. Identifies headers/footers for suppression
    3. Detects tables and replaces raw text with structured Markdown tables
    4. Analyzes font sizes and styles to identify section headers
    5. Builds semantic chunks with section breadcrumbs and metadata
    """
    try:
        doc = fitz.open(file_path)
        total_pages = len(doc)
        artifacts = detect_headers_and_footers(doc)
        
        # 1. Parse TOC if available
        toc = doc.get_toc() # [[lvl, title, pno], ...]
        toc_by_page = {}
        if toc:
            for item in toc:
                lvl, title, pno = item[0], item[1].strip(), item[2]
                if pno not in toc_by_page:
                    toc_by_page[pno] = []
                toc_by_page[pno].append((lvl, title))

        raw_elements = []
        all_font_sizes = []
        total_tables_detected = 0

        # 2. Iterate pages with layout & table awareness
        for page_idx in range(total_pages):
            page = doc[page_idx]
            page_num = page_idx + 1
            
            # Detect tables on this page
            page_tables = extract_tables_from_page(page)
            total_tables_detected += len(page_tables)
            
            # Check TOC for this page
            page_toc_headings = toc_by_page.get(page_num, [])
            for lvl, title in page_toc_headings:
                raw_elements.append({
                    "page": page_num,
                    "text": clean_text(title),
                    "font_size": 16.0,
                    "is_bold": True,
                    "is_heading": True,
                    "type": "heading"
                })

            # Extract text blocks
            page_dict = page.get_text("dict", sort=True)
            
            for block in page_dict.get("blocks", []):
                if block.get("type") != 0:  # 0 is text
                    continue
                    
                block_rect = fitz.Rect(block.get("bbox", [0, 0, 0, 0]))
                
                # Check if this block is inside any detected table
                is_in_table = False
                for tab in page_tables:
                    if block_rect.intersects(tab["bbox"]):
                        is_in_table = True
                        break
                        
                if is_in_table:
                    continue  # Table content will be injected as markdown table
                    
                block_text = ""
                max_font_size = 0.0
                is_bold = False

                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        span_text = span.get("text", "")
                        if not span_text.strip():
                            continue
                            
                        size = float(span.get("size", 10.0))
                        flags = span.get("flags", 0)
                        all_font_sizes.append(size)
                        
                        if size > max_font_size:
                            max_font_size = size
                        if flags & 2 or flags & 16 or "bold" in span.get("font", "").lower():
                            is_bold = True
                            
                        block_text += span_text + " "
                    block_text += "\n"

                cleaned_block = clean_text(block_text)
                
                # Suppress empty, page numbers, or repetitive headers/footers
                if (not cleaned_block or 
                    cleaned_block in artifacts or 
                    PAGE_NUM_PATTERN.match(cleaned_block)):
                    continue

                raw_elements.append({
                    "page": page_num,
                    "text": cleaned_block,
                    "font_size": max_font_size,
                    "is_bold": is_bold,
                    "is_heading": False,
                    "type": "text"
                })

            # Append detected Markdown tables for this page
            for tab in page_tables:
                raw_elements.append({
                    "page": page_num,
                    "text": tab["markdown"],
                    "font_size": 10.0,
                    "is_bold": False,
                    "is_heading": False,
                    "type": "table"
                })

        doc.close()

        # 3. Compute baseline typography metrics
        avg_font_size = (sum(all_font_sizes) / len(all_font_sizes)) if all_font_sizes else 10.0
        heading_threshold = max(avg_font_size * 1.15, 12.0)

        # 4. Construct hierarchical sections
        sections = []
        current_heading = "General Overview"
        section_path = ["General Overview"]
        current_buffer = []
        current_page = 1
        current_type = "text"

        for el in raw_elements:
            text = el["text"]
            
            # Check if this element represents a heading
            is_heading = el.get("is_heading", False)
            if not is_heading and el["type"] == "text" and len(text) < 140:
                if (el["font_size"] >= heading_threshold or 
                    (el["is_bold"] and len(text) < 90) or 
                    HEADING_PATTERN.match(text)):
                    is_heading = True

            if is_heading:
                # Flush previous buffer to section
                if current_buffer:
                    sections.append({
                        "heading": current_heading,
                        "section_path": " > ".join(section_path),
                        "page": current_page,
                        "content": "\n\n".join(current_buffer),
                        "type": current_type
                    })
                    current_buffer = []

                clean_heading = text.split("\n")[0].strip()
                current_heading = clean_heading
                
                # Update section path hierarchy
                if len(section_path) > 2:
                    section_path = [section_path[0], clean_heading]
                else:
                    section_path = [clean_heading]
                    
                current_page = el["page"]
                current_type = "text"
            else:
                if not current_buffer:
                    current_page = el["page"]
                    current_type = el["type"]
                current_buffer.append(text)

        # Flush final section
        if current_buffer:
            sections.append({
                "heading": current_heading,
                "section_path": " > ".join(section_path),
                "page": current_page,
                "content": "\n\n".join(current_buffer),
                "type": current_type
            })

        # 5. Semantic Chunking with Token Estimation and Context Enrichment
        chunks = []
        target_chunk_chars = 900
        overlap_chars = 150

        for sec in sections:
            sec_heading = sec["heading"]
            sec_path = sec.get("section_path", sec_heading)
            sec_page = sec["page"]
            sec_text = sec["content"].strip()
            sec_type = sec.get("type", "text")

            if not sec_text:
                continue

            # If content is a table, keep it atomic unless extremely large
            if sec_type == "table" or sec_text.startswith("| "):
                chunks.append({
                    "chunk_index": len(chunks),
                    "page": sec_page,
                    "heading": sec_heading,
                    "section_path": sec_path,
                    "content": sec_text,
                    "content_type": "table",
                    "tokens_est": int(len(sec_text) / 3.8),
                    "summary_hint": sec_text[:200] + ("..." if len(sec_text) > 200 else "")
                })
                continue

            # Small section fits in one chunk
            if len(sec_text) <= target_chunk_chars:
                chunks.append({
                    "chunk_index": len(chunks),
                    "page": sec_page,
                    "heading": sec_heading,
                    "section_path": sec_path,
                    "content": sec_text,
                    "content_type": "text",
                    "tokens_est": int(len(sec_text) / 3.8),
                    "summary_hint": sec_text[:200] + ("..." if len(sec_text) > 200 else "")
                })
            else:
                # Split along paragraphs first
                paragraphs = [p.strip() for p in sec_text.split("\n\n") if p.strip()]
                current_chunk = ""

                for para in paragraphs:
                    # If paragraph itself is larger than target, split by sentences
                    if len(para) > target_chunk_chars:
                        sentences = re.split(r'(?<=[.!?])\s+', para)
                        for sent in sentences:
                            sent = sent.strip()
                            if not sent:
                                continue
                            if len(current_chunk) + len(sent) + 1 <= target_chunk_chars:
                                current_chunk = (current_chunk + " " + sent).strip()
                            else:
                                if current_chunk:
                                    chunks.append({
                                        "chunk_index": len(chunks),
                                        "page": sec_page,
                                        "heading": sec_heading,
                                        "section_path": sec_path,
                                        "content": current_chunk,
                                        "content_type": "text",
                                        "tokens_est": int(len(current_chunk) / 3.8),
                                        "summary_hint": current_chunk[:200] + ("..." if len(current_chunk) > 200 else "")
                                    })
                                    words = current_chunk.split()
                                    overlap = " ".join(words[-20:]) if len(words) > 20 else ""
                                    current_chunk = (overlap + " " + sent).strip()
                                else:
                                    current_chunk = sent
                    else:
                        if len(current_chunk) + len(para) + 2 <= target_chunk_chars:
                            current_chunk = (current_chunk + "\n\n" + para).strip()
                        else:
                            if current_chunk:
                                chunks.append({
                                    "chunk_index": len(chunks),
                                    "page": sec_page,
                                    "heading": sec_heading,
                                    "section_path": sec_path,
                                    "content": current_chunk,
                                    "content_type": "text",
                                    "tokens_est": int(len(current_chunk) / 3.8),
                                    "summary_hint": current_chunk[:200] + ("..." if len(current_chunk) > 200 else "")
                                })
                                words = current_chunk.split()
                                overlap = " ".join(words[-25:]) if len(words) > 25 else ""
                                current_chunk = (overlap + "\n\n" + para).strip()
                            else:
                                current_chunk = para

                if current_chunk:
                    chunks.append({
                        "chunk_index": len(chunks),
                        "page": sec_page,
                        "heading": sec_heading,
                        "section_path": sec_path,
                        "content": current_chunk,
                        "content_type": "text",
                        "tokens_est": int(len(current_chunk) / 3.8),
                        "summary_hint": current_chunk[:200] + ("..." if len(current_chunk) > 200 else "")
                    })

        # High-level overview hint from leading chunks
        all_text = " ".join([c["content"] for c in chunks[:5]])
        document_summary_hint = all_text[:1400] + ("..." if len(all_text) > 1400 else "")

        return {
            "chunks": chunks,
            "document_summary_hint": document_summary_hint,
            "total_chunks": len(chunks),
            "tables_detected": total_tables_detected,
            "pages_count": total_pages
        }

    except Exception as e:
        print(f"Error extracting PDF: {str(e)}", file=sys.stderr)
        sys.exit(1)

def main():
    if len(sys.argv) < 2:
        print("Usage: python extract_text.py <path_to_pdf>", file=sys.stderr)
        sys.exit(1)
        
    pdf_path = sys.argv[1]
    extracted_data = extract_structured_pdf_data(pdf_path)
    print(json.dumps(extracted_data, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
