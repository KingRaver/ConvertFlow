# Converter Runtime Notes

Phase 1 is implemented with a mixed runtime:

- `sharp` handles raster and vector image conversions.
- `pdf-lib` creates image-backed PDFs.
- `pdf-parse` extracts text from PDFs and renders the first PDF page for PNG/JPG output.
- `mammoth`, `docx`, and `pdfkit` handle DOCX/TXT routes.
- `xlsx`, `csv-parse`, and `csv-stringify` handle data routes.
- `ffmpeg-static` is the default bundled media runtime, with a system `ffmpeg` fallback.

LibreOffice is not required by the current implementation. Legacy `.doc` adapters still use macOS `textutil`, but `.doc` is no longer advertised in the public route map because that runtime is not deployment-portable. If you later restore `.doc` to the product surface, replace the `textutil` dependency with a portable converter or gate the route explicitly per deployment target.
