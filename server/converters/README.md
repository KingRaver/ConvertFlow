# Converter Runtime Notes

Phase 1 is implemented with a mixed runtime:

- `sharp` handles raster and vector image conversions.
- `pdf-lib` creates image-backed PDFs.
- `pdf-parse` extracts text from PDFs and renders the first PDF page for PNG/JPG output.
- `mammoth`, `docx`, and `pdfkit` handle DOCX/TXT routes.
- `xlsx`, `csv-parse`, and `csv-stringify` handle data routes.
- `ffmpeg-static` is the default bundled media runtime, with a system `ffmpeg` fallback.

LibreOffice is not required by the current implementation. Legacy `.doc` routes use macOS `textutil`, so `.doc` conversion is only available where that tool exists. If you later swap `.doc` or `.docx` PDF export to LibreOffice, target LibreOffice 7.6 or newer and validate the headless binary on each deployment target before enabling it in production.
