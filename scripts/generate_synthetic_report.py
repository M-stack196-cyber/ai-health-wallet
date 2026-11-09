#!/usr/bin/env python3
"""Generates a clean SYNTHETIC lab report PDF for the local demo stack. No real patient data: every value below is made up.

Usage:  ~/.local/share/hw-local-stack/pdfgen/bin/python scripts/generate_synthetic_report.py [--output PATH]
Needs the fpdf2 package (the local-stack folder has a small venv for it: python3 -m venv ~/.local/share/hw-local-stack/pdfgen
        && ~/.local/share/hw-local-stack/pdfgen/bin/pip install fpdf2).
Default output: ~/.local/share/hw-local-stack/run/synthetic-test-report.pdf (owner-only file, outside the repository).
Each result is on its own line in the form "Name: value unit", which is the shape the local fact reader understands
(it reads Glucose and Hemoglobin lines; Cholesterol is kept in the text but is not a recognised fact).
"""
import argparse
import os
import sys

try:
    from fpdf import FPDF
except ImportError:
    sys.exit("fpdf2 is not installed. Run: python3 -m venv ~/.local/share/hw-local-stack/pdfgen && "
             "~/.local/share/hw-local-stack/pdfgen/bin/pip install fpdf2, then use that venv's python.")

DEFAULT_OUTPUT = os.path.expanduser("~/.local/share/hw-local-stack/run/synthetic-test-report.pdf")
LINES = [
    "Patient Name: Synthetic John Doe",
    "DOB: 1990-01-01",
    "Date: 2026-03-10",
    "Glucose: 95 mg/dL",
    "Hemoglobin: 14.2 g/dL",
    "Cholesterol: 185 mg/dL",
]


def build(path: str) -> None:
    pdf = FPDF(format="A4")
    pdf.set_title("Synthetic lab report")
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 16)
    pdf.cell(0, 10, "SYNTHETIC LAB REPORT", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 12)
    pdf.cell(0, 8, "Synthetic Hospital (made-up data, not a real patient)", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    for line in LINES:
        pdf.cell(0, 8, line, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 10)
    pdf.cell(0, 8, "SYNTHETIC TEST ONLY", new_x="LMARGIN", new_y="NEXT")
    data = bytes(pdf.output())
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(data)
    os.chmod(path, 0o600)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate a synthetic lab report PDF.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    target = os.path.abspath(os.path.expanduser(arguments.output))
    build(target)
    print("Wrote synthetic report: " + target + " (" + str(os.path.getsize(target)) + " bytes)")
