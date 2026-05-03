import re
from typing import Any


EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
PHONE_RE = re.compile(r"(\+?\d[\d\-\s().]{7,}\d)")
LINKEDIN_RE = re.compile(r"(https?://[^\s]*linkedin\.com/[^\s]+|linkedin\.com/[^\s]+)", re.I)
CITY_RE = re.compile(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*,\s*[A-Z]{2})\b")
DATE_SPAN_RE = re.compile(
    r"((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)?\.?\s*\d{4}\s*[-–—]\s*(?:Present|Current|Now|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)?\.?\s*\d{4}))",
    re.I,
)
EDU_HINT_RE = re.compile(r"\b(Bachelor|Master|B\.?S\.?|M\.?S\.?|MBA|PhD|B\.?Tech|M\.?Tech|Associate)\b", re.I)
SECTION_TITLE_RE = re.compile(
    r"^(summary|professional summary|experience|work experience|employment|skills|technical skills|core skills|education|academic background|projects|certifications)\s*:?\s*$",
    re.I,
)
SCHOOL_HINT_RE = re.compile(r"\b(university|college|institute|school)\b", re.I)


def _normalize_lines(text: str) -> list[str]:
    return [line.strip() for line in str(text or "").replace("\r\n", "\n").split("\n") if line.strip()]


def _extract_header(lines: list[str]) -> dict[str, str]:
    whole = "\n".join(lines[:20])
    email = (EMAIL_RE.search(whole).group(0) if EMAIL_RE.search(whole) else "")
    phone = (PHONE_RE.search(whole).group(0) if PHONE_RE.search(whole) else "")
    linkedin = (LINKEDIN_RE.search(whole).group(0) if LINKEDIN_RE.search(whole) else "")

    name = ""
    for line in lines[:6]:
        if "@" in line or "linkedin" in line.lower():
            continue
        if re.search(r"[A-Za-z]{2,}", line):
            name = line
            break

    links = linkedin
    city = ""
    city_match = CITY_RE.search(whole)
    if city_match:
        city = city_match.group(1).strip()

    return {
        "name": name,
        "headline": "",
        "location": city,
        "email": email,
        "phone": phone,
        "contact": "",
        "links": links,
        "align": "center",
    }


def _split_sections(lines: list[str]) -> dict[str, list[str]]:
    sections: dict[str, list[str]] = {
        "summary": [],
        "experience": [],
        "skills": [],
        "education": [],
    }
    current = "summary"
    for line in lines:
        low = re.sub(r"\s+", " ", line.lower().strip()).strip(":")
        if low in {"summary", "professional summary"}:
            current = "summary"
            continue
        if low in {"experience", "professional experience", "work experience", "employment"}:
            current = "experience"
            continue
        if low in {"skills", "technical skills", "core skills"}:
            current = "skills"
            continue
        if low in {"education", "academic background"}:
            current = "education"
            continue
        sections[current].append(line)
    return sections


def _is_non_content_line(line: str) -> bool:
    low = str(line or "").strip().lower()
    if not low:
        return True
    if SECTION_TITLE_RE.match(low):
        return True
    return False


def _clean_role_or_company(value: str) -> str:
    text = str(value or "").strip(" |,-")
    text = re.sub(r"\s+", " ", text).strip()
    if _is_non_content_line(text):
        return ""
    if DATE_SPAN_RE.search(text):
        text = DATE_SPAN_RE.sub("", text).strip(" |,-")
    return text


def _extract_experience_facts(exp_lines: list[str]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for idx, line in enumerate(exp_lines):
        date_match = DATE_SPAN_RE.search(line)
        if not date_match:
            continue
        period = date_match.group(1).strip()
        candidates: list[str] = []
        for offset in (-2, -1, 0, 1, 2):
            pos = idx + offset
            if 0 <= pos < len(exp_lines):
                candidate = exp_lines[pos].strip()
                if candidate and not candidate.startswith(("-", "*", "•")):
                    candidates.append(candidate)

        role = ""
        company = ""
        for candidate in candidates:
            clean = _clean_role_or_company(candidate)
            if not clean:
                continue
            parts = [part.strip() for part in clean.split("|") if part.strip()]
            if len(parts) >= 2:
                role = role or parts[0]
                company = company or parts[1]
                break
            if not role:
                role = clean
            elif not company and clean.lower() != role.lower():
                company = clean

        if role or company:
            rows.append({"company": company, "role": role, "period": period})

    deduped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        key = (
            row.get("company", "").lower().strip(),
            row.get("role", "").lower().strip(),
            row.get("period", "").lower().strip(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped[:8]


def _extract_education_facts(edu_lines: list[str]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()

    for idx, line in enumerate(edu_lines):
        current = line.strip()
        if _is_non_content_line(current):
            continue

        degree = current if EDU_HINT_RE.search(current) else ""
        school = current if SCHOOL_HINT_RE.search(current) else ""
        period = ""

        period_match = DATE_SPAN_RE.search(current)
        if period_match:
            period = period_match.group(1).strip()

        neighbors = []
        if idx > 0:
            neighbors.append(edu_lines[idx - 1].strip())
        if idx + 1 < len(edu_lines):
            neighbors.append(edu_lines[idx + 1].strip())

        for neighbor in neighbors:
            if _is_non_content_line(neighbor):
                continue
            if not period:
                match = DATE_SPAN_RE.search(neighbor)
                if match:
                    period = match.group(1).strip()
            if not degree and EDU_HINT_RE.search(neighbor):
                degree = neighbor
            if not school and SCHOOL_HINT_RE.search(neighbor):
                school = neighbor

        degree = _clean_role_or_company(degree)
        school = _clean_role_or_company(school)
        period = str(period or "").strip()

        # Skip rows that only have a date and no academic signal.
        if not degree and not school:
            continue

        key = (degree.lower(), school.lower(), period.lower())
        if key in seen:
            continue
        seen.add(key)
        rows.append({"degree": degree, "school": school, "period": period})

    return rows[:4]


def _parse_experience(lines: list[str]) -> list[dict[str, Any]]:
    if not lines:
        return []
    bullets: list[str] = []
    for line in lines:
        if line.startswith(("-", "*", "•")):
            bullets.append(line.lstrip("-*• ").strip())
        elif re.search(r"\b(improved|built|developed|led|created|delivered|optimized)\b", line, re.I):
            bullets.append(line)
    if not bullets:
        bullets = lines[:6]
    return [{"company": "", "role": "", "period": "", "bullets": bullets}]


def _parse_simple_items(lines: list[str]) -> list[str]:
    out: list[str] = []
    for line in lines:
        cleaned = line.lstrip("-*• ").strip()
        if cleaned:
            out.append(cleaned)
    return out


def structure_ai_output(ai_output: str, original_resume_text: str = "") -> dict[str, Any]:
    source = str(ai_output or "").strip() or str(original_resume_text or "")
    lines = _normalize_lines(source)
    sections = _split_sections(lines)
    return {
        "header": _extract_header(lines),
        "sections": [
            {"type": "summary", "title": "Summary", "items": _parse_simple_items(sections["summary"])[:4]},
            {"type": "experience", "title": "Experience", "items": _parse_experience(sections["experience"])},
            {"type": "skills", "title": "Skills", "items": _parse_simple_items(sections["skills"])},
            {"type": "education", "title": "Education", "items": _parse_simple_items(sections["education"])},
        ],
    }


def extract_resume_facts(text: str) -> dict[str, Any]:
    lines = _normalize_lines(text)
    header = _extract_header(lines)
    sections = _split_sections(lines)

    exp_lines = sections.get("experience", [])
    experience_rows = _extract_experience_facts(exp_lines)

    edu_lines = sections.get("education", [])
    education_rows = _extract_education_facts(edu_lines)

    return {
        "name": header.get("name", ""),
        "contact": {
            "email": header.get("email", ""),
            "phone": header.get("phone", ""),
            "linkedin": header.get("links", ""),
            "city": header.get("location", ""),
        },
        "experience": experience_rows,
        "education": education_rows,
    }
